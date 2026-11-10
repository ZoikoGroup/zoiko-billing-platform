"""
app/modules/tax/source_monitor_service.py
-----------------------------------------
Source change detection and review cadence (ZB-TAX-ARCH-001 Phase 8 PR 5).
Detection only: nothing here creates a source revision, a staged rate or a
publication (an optional parser may stage OFFICIAL_FEED drafts; none is
registered). Formal evidence is still captured by a reviewer through the
Phase 1 evidence-attach flow.

Change control (answer 1): one TAX_REVIEWER, audited, may create a monitor,
raise its tier, run "check now" and record manual checks. Anything that can
weaken detection (disable, delete, lower the tier, switch to manual by hand,
change the URL) is proposed and decided by a different TAX_REVIEWER or
TAX_PUBLISHER. The automatic switch to MANUAL_CHECK on 401/403, three
consecutive 429s or a robots.txt disallow stays automatic: it raises
reminders, it doesn't reduce oversight.
"""
import difflib
import hashlib
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from urllib.robotparser import RobotFileParser

from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import PlatformAuditAction
from app.modules.tax.registry_service import MakerCheckerError, RegistryStateError
from app.modules.tax.source_fetch import (
    UA_TOKEN, FetchRefused, SafeFetcher, check_url, retry_after_seconds,
)
from app.modules.tax.source_monitor_models import (
    TIERS, TaxReviewDue, TaxSourceHost, TaxSourceMonitor, TaxSourceMonitorChange, TaxSourceObservation,
    TaxSourceReview,
)
from app.modules.tax.source_normalize import RAW_LABEL, normalize

logger = logging.getLogger("zoiko_billing.tax.source_monitor")

WEAKENING = ("DISABLE", "DELETE", "LOWER_TIER", "TO_MANUAL", "CHANGE_URL")
TIER_RANK = {"HIGH_VOLATILITY": 0, "NATIONAL_VAT_GST": 1, "RESEARCH_ONLY": 2}   # lower = more frequent
HOST_GAP = timedelta(minutes=1)
ROBOTS_TTL = timedelta(days=1)
MAX_DIFF_LINES = 2000
FLAPPING_DISMISSALS = 3


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def cadence(tier: str) -> timedelta:
    if tier == "HIGH_VOLATILITY":
        return timedelta(hours=int(getattr(settings, "TAX_SOURCE_CADENCE_HIGH_HOURS", 24)))
    if tier == "NATIONAL_VAT_GST":
        return timedelta(hours=int(getattr(settings, "TAX_SOURCE_CADENCE_NATIONAL_HOURS", 168)))
    return timedelta(days=int(getattr(settings, "TAX_SOURCE_CADENCE_RESEARCH_DAYS", 91)))


def _tier(value: str) -> str:
    value = (value or "").strip().upper()
    if value not in TIERS:
        raise BadRequestException(f"risk_tier must be one of {', '.join(TIERS)}.")
    return value


def _url(value: str) -> str:
    try:
        return check_url(value).host.lower()
    except FetchRefused as exc:
        raise BadRequestException(str(exc))


# ── views ───────────────────────────────────────────────────────────────

def view_monitor(m: TaxSourceMonitor, db: Optional[Session] = None) -> dict:
    reasons = []
    if db is not None and m.dismissals:
        reasons = [r.resolution for r in db.query(TaxSourceReview).filter(
            TaxSourceReview.monitor_id == m.id, TaxSourceReview.status == "DISMISSED").order_by(
            TaxSourceReview.id.desc()).limit(5)]
    pending = None
    if db is not None:
        change = db.query(TaxSourceMonitorChange).filter(TaxSourceMonitorChange.monitor_id == m.id,
                                                         TaxSourceMonitorChange.status == "PROPOSED").first()
        pending = view_change(change) if change else None
    return {"id": m.id, "handoff_ref": m.handoff_ref, "title": m.title, "monitoring_url": m.monitoring_url,
            "host": m.host, "jurisdiction_id": m.jurisdiction_id, "risk_tier": m.risk_tier,
            "cadence_hours": int(cadence(m.risk_tier).total_seconds() // 3600), "access_mode": m.access_mode,
            "manual_reason": m.manual_reason, "enabled": m.enabled, "retired_at": m.retired_at,
            "next_check_due": m.next_check_due, "last_checked_at": m.last_checked_at, "last_outcome": m.last_outcome,
            "consecutive_failures": m.consecutive_failures, "retry_after_until": m.retry_after_until,
            "dismissals": m.dismissals, "recent_dismissal_reasons": reasons,
            "flapping": m.dismissals >= FLAPPING_DISMISSALS, "pending_change": pending}


def view_change(c: TaxSourceMonitorChange) -> dict:
    return {"id": c.id, "monitor_id": c.monitor_id, "action": c.action, "value": c.value, "reason": c.reason,
            "status": c.status, "proposed_by": c.proposed_by, "decided_by": c.decided_by, "decided_at": c.decided_at,
            "created_at": c.created_at}


def view_observation(o: TaxSourceObservation) -> dict:
    return {"id": o.id, "monitor_id": o.monitor_id, "fetched_at": o.fetched_at, "url_fetched": o.url_fetched,
            "outcome": o.outcome, "http_status": o.http_status, "content_type": o.content_type,
            "normalization": o.normalization, "raw_sha256": o.raw_sha256, "normalized_sha256": o.normalized_sha256,
            "artifact_stored": o.artifact_sha256 is not None, "error": o.error}


def view_review(r: TaxSourceReview) -> dict:
    return {"id": r.id, "kind": r.kind, "monitor_id": r.monitor_id, "rate_version_id": r.rate_version_id,
            "observation_id": r.observation_id, "previous_observation_id": r.previous_observation_id,
            "diff": r.diff, "status": r.status, "resolution": r.resolution,
            "source_revision_id": r.source_revision_id, "decided_by": r.decided_by, "decided_at": r.decided_at,
            "created_at": r.created_at}


def view_due(d: TaxReviewDue, now: Optional[datetime] = None) -> dict:
    now = now or _now()
    return {"id": d.id, "subject_kind": d.subject_kind, "subject_key": d.subject_key, "label": d.label,
            "tier": d.tier, "next_review_due": d.next_review_due, "overdue": _aware(d.next_review_due) < now,
            "last_reviewed_at": d.last_reviewed_at, "last_reviewed_by": d.last_reviewed_by, "note": d.note}


# ── the service ─────────────────────────────────────────────────────────

class SourceMonitorService:
    def __init__(self, db: Session, fetcher: Optional[SafeFetcher] = None, now=None):
        self.db = db
        self.fetcher = fetcher or SafeFetcher()
        self.now = now or _now
        self.audit = PlatformAuditService(db)

    def _log(self, actor_id, entity_type: str, entity_id, **meta):
        self.audit.log_no_commit(actor_id=actor_id, actor_role="super_admin", action=PlatformAuditAction.UPDATE,
                                 entity_type=entity_type, entity_id=entity_id, metadata=meta)

    def get(self, monitor_id: int) -> TaxSourceMonitor:
        m = self.db.get(TaxSourceMonitor, monitor_id)
        if m is None or m.retired_at is not None:
            raise NotFoundException("Source monitor", monitor_id)
        return m

    # single person (audited)
    def create(self, *, actor_id: int, title: str, monitoring_url: str, risk_tier: str,
               handoff_ref: Optional[str] = None, jurisdiction_id: Optional[int] = None) -> TaxSourceMonitor:
        if not (title or "").strip():
            raise BadRequestException("A title is required.")
        now = self.now()
        m = TaxSourceMonitor(title=title.strip(), monitoring_url=monitoring_url.strip(), host=_url(monitoring_url),
                             risk_tier=_tier(risk_tier), handoff_ref=(handoff_ref or "").strip().upper() or None,
                             jurisdiction_id=jurisdiction_id, access_mode="AUTOMATED", enabled=True,
                             next_check_due=now, consecutive_failures=0, consecutive_429=0, dismissals=0,
                             created_by=actor_id, created_at=now)
        self.db.add(m)
        self.db.flush()
        self._log(actor_id, "TaxSourceMonitor", m.id, monitor="created", url=m.monitoring_url, tier=m.risk_tier)
        return m

    def raise_tier(self, *, actor_id: int, monitor_id: int, risk_tier: str) -> TaxSourceMonitor:
        m = self.get(monitor_id)
        tier = _tier(risk_tier)
        if TIER_RANK[tier] >= TIER_RANK[m.risk_tier]:
            raise RegistryStateError("Only a more frequent tier can be set alone; a less frequent tier needs a "
                                     "second person (propose a change).")
        old, m.risk_tier = m.risk_tier, tier
        m.next_check_due = min(_aware(m.next_check_due), self.now() + cadence(tier))
        m.updated_at = self.now()
        self.db.flush()
        self._log(actor_id, "TaxSourceMonitor", m.id, monitor="tier_raised", old=old, new=tier)
        return m

    # weakening changes: a second person decides
    def propose_change(self, *, actor_id: int, monitor_id: int, action: str, reason: str,
                       value: Optional[str] = None) -> TaxSourceMonitorChange:
        m = self.get(monitor_id)
        action = (action or "").strip().upper()
        if action not in WEAKENING:
            raise BadRequestException(f"action must be one of {', '.join(WEAKENING)}.")
        if not (reason or "").strip():
            raise BadRequestException("A reason is required.")
        if action == "LOWER_TIER":
            value = _tier(value)
            if TIER_RANK[value] <= TIER_RANK[m.risk_tier]:
                raise BadRequestException("LOWER_TIER needs a less frequent tier.")
        elif action == "CHANGE_URL":
            _url(value or "")
        if self.db.query(TaxSourceMonitorChange).filter(TaxSourceMonitorChange.monitor_id == m.id,
                                                        TaxSourceMonitorChange.status == "PROPOSED").first():
            raise RegistryStateError("A change to this monitor is already waiting for a decision.")
        c = TaxSourceMonitorChange(monitor_id=m.id, action=action, value=value, reason=reason.strip(),
                                   status="PROPOSED", proposed_by=actor_id, created_at=self.now())
        self.db.add(c)
        self.db.flush()
        self._log(actor_id, "TaxSourceMonitor", m.id, monitor="change_proposed", action=action, value=value,
                  change_id=c.id)
        return c

    def decide_change(self, *, actor_id: int, change_id: int, approve: bool,
                      reason: Optional[str] = None) -> TaxSourceMonitorChange:
        c = self.db.get(TaxSourceMonitorChange, change_id)
        if c is None:
            raise NotFoundException("Source monitor change", change_id)
        if c.status != "PROPOSED":
            raise RegistryStateError(f"Monitor change {c.id} is already {c.status}.")
        if actor_id == c.proposed_by:
            raise MakerCheckerError("You proposed this change; a different TAX_REVIEWER or TAX_PUBLISHER decides it.")
        m = self.get(c.monitor_id)
        now = self.now()
        if approve:
            if c.action == "DISABLE":
                m.enabled = False
            elif c.action == "DELETE":
                m.enabled, m.retired_at = False, now
            elif c.action == "LOWER_TIER":
                m.risk_tier = c.value
            elif c.action == "TO_MANUAL":
                m.access_mode, m.manual_reason = "MANUAL_CHECK", f"Switched by hand: {c.reason}"
            elif c.action == "CHANGE_URL":
                m.monitoring_url, m.host, m.next_check_due = c.value, _url(c.value), now
            m.updated_at = now
            c.status = "APPROVED"
        else:
            if not (reason or "").strip():
                raise BadRequestException("A reason is required to reject a change.")
            c.status = "REJECTED"
        c.decided_by, c.decided_at = actor_id, now
        self.db.flush()
        self._log(actor_id, "TaxSourceMonitor", m.id, monitor=f"change_{c.status.lower()}", action=c.action,
                  change_id=c.id, reason=reason)
        return c

    # ── one check ──
    def _host(self, host: str) -> TaxSourceHost:
        q = self.db.query(TaxSourceHost).filter(TaxSourceHost.host == host).populate_existing()
        if self.db.get_bind().dialect.name == "postgresql":
            q = q.with_for_update()
        row = q.first()
        if row is None:
            row = TaxSourceHost(host=host)
            self.db.add(row)
            self.db.flush()
        return row

    def _robots(self, host_row: TaxSourceHost, url: str, now: datetime) -> Optional[str]:
        """None = allowed; otherwise why not (or 'DEFER' when it was just fetched)."""
        fetched = _aware(host_row.robots_fetched_at)
        if fetched is None or now - fetched > ROBOTS_TTL:
            try:
                result = self.fetcher.get(f"https://{host_row.host}/robots.txt")
                host_row.robots_status = result.status
                host_row.robots_body = result.body.decode("utf-8", errors="replace")[:200_000] if result.status < 300 else None
            except FetchRefused as exc:
                host_row.robots_status, host_row.robots_body = 599, None
                logger.warning("robots.txt for %s refused: %s", host_row.host, exc)
            except httpx_errors() as exc:
                host_row.robots_status, host_row.robots_body = 599, None
                logger.warning("robots.txt for %s failed: %s", host_row.host, exc)
            host_row.robots_fetched_at = host_row.last_request_at = now
            return "DEFER"                                 # one request per host per minute
        status = host_row.robots_status or 0
        if 400 <= status < 500:
            return None                                    # no robots.txt: allowed
        if status >= 500:
            return "UNAVAILABLE"                           # RFC 9309: assume disallowed for now
        parser = RobotFileParser()
        parser.parse((host_row.robots_body or "").splitlines())
        return None if parser.can_fetch(UA_TOKEN, url) else "DISALLOWED"

    def check(self, m: TaxSourceMonitor) -> str:
        """Fetch once (if the host's courtesy limits allow) and record it."""
        now = self.now()
        host_row = self._host(m.host)
        last = _aware(host_row.last_request_at)
        if last is not None and now - last < HOST_GAP:
            return "DEFERRED"
        robots = self._robots(host_row, m.monitoring_url, now)
        if robots == "DEFER":
            self.db.flush()
            return "DEFERRED"
        if robots == "DISALLOWED":
            self._to_manual(m, "robots.txt disallows automated access")
            return self._observe(m, now, outcome="ROBOTS_DISALLOWED", error="robots.txt disallows this path")
        if robots == "UNAVAILABLE":
            m.consecutive_failures += 1
            m.next_check_due = now + min(cadence(m.risk_tier), timedelta(hours=6))
            return self._observe(m, now, outcome="FAILED", error="robots.txt unavailable (5xx): not fetched")
        host_row.last_request_at = now
        try:
            result = self.fetcher.get(m.monitoring_url)
        except FetchRefused as exc:
            m.consecutive_failures += 1
            m.next_check_due = now + cadence(m.risk_tier)
            return self._observe(m, now, outcome="FAILED", error=f"refused by policy: {exc}")
        except httpx_errors() as exc:
            m.consecutive_failures += 1
            m.next_check_due = now + min(cadence(m.risk_tier), timedelta(hours=6))
            return self._observe(m, now, outcome="FAILED", error=f"{type(exc).__name__}")
        if result.status in (401, 403):
            self._to_manual(m, f"the source refused automated access (HTTP {result.status})")
            return self._observe(m, now, outcome="REFUSED", status=result.status, url=result.url)
        if result.status == 429:
            m.consecutive_429 += 1
            wait = retry_after_seconds(result.retry_after, now)
            m.retry_after_until = now + timedelta(seconds=wait)
            m.next_check_due = m.retry_after_until
            if m.consecutive_429 >= 3:
                self._to_manual(m, "the source rate-limited three checks in a row (HTTP 429)")
            return self._observe(m, now, outcome="RATE_LIMITED", status=429, url=result.url)
        m.consecutive_429 = 0
        if not 200 <= result.status < 300:
            m.consecutive_failures += 1
            m.next_check_due = now + min(cadence(m.risk_tier), timedelta(hours=6))
            return self._observe(m, now, outcome="FAILED", status=result.status, url=result.url,
                                 error=f"HTTP {result.status}")
        m.consecutive_failures = 0
        m.next_check_due = now + cadence(m.risk_tier)
        return self._record_content(m, now, result)

    def _to_manual(self, m: TaxSourceMonitor, reason: str) -> None:
        if m.access_mode != "MANUAL_CHECK":
            m.access_mode, m.manual_reason = "MANUAL_CHECK", reason
            self._log(None, "TaxSourceMonitor", m.id, monitor="switched_to_manual_automatically", reason=reason)
        m.next_check_due = self.now() + cadence(m.risk_tier)

    def _observe(self, m, now, *, outcome, status=None, url=None, error=None, content_type=None, label=None,
                 raw=None, normalized=None, artifact=None) -> str:
        o = TaxSourceObservation(monitor_id=m.id, fetched_at=now, url_fetched=url or m.monitoring_url, outcome=outcome,
                                 http_status=status, content_type=content_type, normalization=label, raw_sha256=raw,
                                 normalized_sha256=normalized, artifact_sha256=artifact, error=error)
        self.db.add(o)
        self.db.flush()
        m.last_checked_at, m.last_outcome, m.last_observation_id = now, outcome, o.id
        self.db.flush()
        return outcome

    def _baseline(self, m) -> Optional[TaxSourceObservation]:
        return self.db.query(TaxSourceObservation).filter(
            TaxSourceObservation.monitor_id == m.id, TaxSourceObservation.artifact_sha256.isnot(None)).order_by(
            TaxSourceObservation.id.desc()).first()

    def _record_content(self, m, now, result) -> str:
        from app.modules.tax.registry_models import TaxSourceArtifact

        raw = hashlib.sha256(result.body).hexdigest()
        label, text, normalized = normalize(result.body, result.content_type)
        signal = normalized or raw
        baseline = self._baseline(m)
        before = (baseline.normalized_sha256 or baseline.raw_sha256) if baseline else None
        changed = baseline is not None and before != signal
        artifact = None
        if baseline is None or changed:                    # answer 4: store only the first and on change
            if self.db.get(TaxSourceArtifact, raw) is None:
                self.db.add(TaxSourceArtifact(sha256=raw, content=result.body,
                                              media_type=(result.content_type or "application/octet-stream")[:150],
                                              size_bytes=len(result.body), original_filename=None, uploaded_at=now))
                self.db.flush()
            artifact = raw
        outcome = "CHANGED" if changed else ("BASELINE" if baseline is None else "UNCHANGED")
        self._observe(m, now, outcome=outcome, status=result.status, url=result.url,
                      content_type=(result.content_type or "")[:150] or None, label=label, raw=raw,
                      normalized=normalized, artifact=artifact)
        if changed:
            self._open_change_review(m, baseline, text, label)
            self._run_parser(m, text)
        return outcome

    def _previous_text(self, baseline: TaxSourceObservation) -> Optional[str]:
        from app.modules.tax.registry_models import TaxSourceArtifact

        art = self.db.get(TaxSourceArtifact, baseline.artifact_sha256) if baseline.artifact_sha256 else None
        if art is None:
            return None
        return normalize(bytes(art.content), baseline.content_type)[1]

    def _open_change_review(self, m, baseline, text: Optional[str], label: str) -> None:
        before = self._previous_text(baseline)
        if text is not None and before is not None:
            diff = list(difflib.unified_diff(before.splitlines(), text.splitlines(), "before", "after", lineterm="", n=2))
            if len(diff) > MAX_DIFF_LINES:
                diff = diff[:MAX_DIFF_LINES] + [f"... diff truncated at {MAX_DIFF_LINES} lines"]
            body = "\n".join(diff)
        else:
            body = f"({label}: no text diff available; the raw content hash changed)"
        self.db.add(TaxSourceReview(kind="SOURCE_CHANGED", monitor_id=m.id, observation_id=m.last_observation_id,
                                    previous_observation_id=baseline.id, diff=body,
                                    cycle_key=f"changed:{m.id}:{m.last_observation_id}", status="OPEN",
                                    created_at=self.now()))
        self.db.flush()

    def _run_parser(self, m, text: Optional[str]) -> None:
        from app.modules.tax.source_parsers import stage_proposals

        if text is not None:
            stage_proposals(self.db, m, text)

    # ── reviews ──
    def close_review(self, *, actor_id: int, review_id: int, outcome: str, reason: Optional[str] = None,
                     source_revision_id: Optional[int] = None) -> TaxSourceReview:
        r = self.db.get(TaxSourceReview, review_id)
        if r is None:
            raise NotFoundException("Source review", review_id)
        if r.status != "OPEN":
            raise RegistryStateError(f"Review {r.id} is already {r.status}.")
        outcome = (outcome or "").strip().upper()
        if outcome == "EVIDENCE_CAPTURED":
            from app.modules.tax.registry_models import TaxLegalSourceRevision

            if source_revision_id is None or self.db.get(TaxLegalSourceRevision, source_revision_id) is None:
                raise BadRequestException("Link the source revision you registered with the new evidence.")
        elif outcome in ("DISMISSED", "CHECKED"):
            if not (reason or "").strip():
                raise BadRequestException("A reason (or a note of what you checked) is required.")
            if outcome == "CHECKED" and r.kind == "SOURCE_CHANGED":
                raise BadRequestException("A detected change is closed with evidence or dismissed with a reason.")
        else:
            raise BadRequestException("outcome must be EVIDENCE_CAPTURED, DISMISSED or CHECKED.")
        r.status, r.resolution, r.source_revision_id = outcome, (reason or "").strip() or None, source_revision_id
        r.decided_by, r.decided_at = actor_id, self.now()
        if outcome == "DISMISSED" and r.kind == "SOURCE_CHANGED" and r.monitor_id:
            m = self.db.get(TaxSourceMonitor, r.monitor_id)
            m.dismissals = (m.dismissals or 0) + 1
        if r.kind == "MANUAL_CHECK_DUE" and r.monitor_id:
            m = self.db.get(TaxSourceMonitor, r.monitor_id)
            m.next_check_due = self.now() + cadence(m.risk_tier)
            m.last_checked_at, m.last_outcome = self.now(), "MANUAL_CHECK"
        self.db.flush()
        self._log(actor_id, "TaxSourceReview", r.id, review=outcome.lower(), kind=r.kind, monitor_id=r.monitor_id,
                  source_revision_id=source_revision_id)
        return r

    # ── review dues ──
    def mark_reviewed(self, *, actor_id: int, due_id: int, note: str) -> TaxReviewDue:
        d = self.db.get(TaxReviewDue, due_id)
        if d is None:
            raise NotFoundException("Review due", due_id)
        if not (note or "").strip():
            raise BadRequestException("Note what you reviewed.")
        now = self.now()
        d.last_reviewed_at, d.last_reviewed_by, d.note = now, actor_id, note.strip()
        d.next_review_due = now + cadence(d.tier)
        self.db.flush()
        self._log(actor_id, "TaxReviewDue", d.id, review_due="reviewed", subject=f"{d.subject_kind}:{d.subject_key}")
        return d


def httpx_errors() -> tuple:
    import httpx

    return (httpx.HTTPError, OSError)


# ── the job ─────────────────────────────────────────────────────────────

def _manual_reminder(db: Session, m: TaxSourceMonitor, now: datetime) -> None:
    cycle = f"manual:{m.id}:{_aware(m.next_check_due).date().isoformat()}"
    if db.query(TaxSourceReview.id).filter(TaxSourceReview.cycle_key == cycle).first() is None:
        db.add(TaxSourceReview(kind="MANUAL_CHECK_DUE", monitor_id=m.id, cycle_key=cycle, status="OPEN",
                               diff=None, created_at=now))
    m.next_check_due = now + cadence(m.risk_tier)
    db.flush()


def pre_effective_reminders(db: Session, now: Optional[datetime] = None) -> int:
    """Published rates starting within TAX_RATE_REVERIFY_DAYS: one reminder each
    (raised at once when published already inside the window)."""
    from app.modules.tax.registry_models import TaxJurisdiction, TaxRateVersion
    from app.modules.tax.retro_service import legal_today

    now = now or _now()
    window = int(getattr(settings, "TAX_RATE_REVERIFY_DAYS", 14))
    created = 0
    for rate in db.query(TaxRateVersion).filter(TaxRateVersion.status == "ACTIVE"):
        jurisdiction = db.get(TaxJurisdiction, rate.jurisdiction_id)
        today = legal_today(jurisdiction.timezone if jurisdiction else None, now)
        if rate.valid_from is None or not (today < rate.valid_from <= today + timedelta(days=window)):
            continue
        cycle = f"pre:{rate.id}"
        if db.query(TaxSourceReview.id).filter(TaxSourceReview.cycle_key == cycle).first() is None:
            db.add(TaxSourceReview(kind="PRE_EFFECTIVE_CHECK", rate_version_id=rate.id, cycle_key=cycle,
                                   status="OPEN", created_at=now))
            created += 1
    db.flush()
    return created


def sync_review_dues(db: Session, now: Optional[datetime] = None) -> None:
    """A due date for every approved source and ACTIVE availability version."""
    from app.modules.tax.enums import PlatformVersionStatus
    from app.modules.tax.policy_models import TaxMarketAvailabilityVersion
    from app.modules.tax.policy_service import source_dependency_status
    from app.modules.tax.registry_models import TaxLegalSourceRevision

    now = now or _now()
    monitors = db.query(TaxSourceMonitor).filter(TaxSourceMonitor.retired_at.is_(None)).all()
    by_ref = {}
    for m in monitors:
        if m.handoff_ref:
            by_ref.setdefault(m.handoff_ref, []).append(m.risk_tier)
    by_jurisdiction = {}
    for m in monitors:
        if m.jurisdiction_id:
            by_jurisdiction.setdefault(m.jurisdiction_id, []).append(m.risk_tier)
    existing = {(d.subject_kind, d.subject_key): d for d in db.query(TaxReviewDue)}

    def ensure(kind, key, label, tier):
        if (kind, key) in existing:
            return
        d = TaxReviewDue(subject_kind=kind, subject_key=key, label=label[:300], tier=tier,
                         next_review_due=now + cadence(tier), created_at=now)
        db.add(d)
        existing[(kind, key)] = d

    refs = {r for (r,) in db.query(TaxLegalSourceRevision.handoff_ref).filter(
        TaxLegalSourceRevision.handoff_ref.isnot(None)).distinct()}
    for ref in sorted(refs):
        status = source_dependency_status(db, ref)
        if status["approved"]:
            tiers = by_ref.get(ref) or ["NATIONAL_VAT_GST"]
            ensure("source", ref, f"Source {ref}: {status['title']}", min(tiers, key=TIER_RANK.get))
    calculating = {"NATIVE_RULEPACK_APPROVED", "PROVIDER_APPROVED", "TENANT_CONFIG_APPROVED"}
    for v in db.query(TaxMarketAvailabilityVersion).filter(
            TaxMarketAvailabilityVersion.status == PlatformVersionStatus.ACTIVE):
        tiers = by_jurisdiction.get(v.jurisdiction_id)
        tier = min(tiers, key=TIER_RANK.get) if tiers else (
            "NATIONAL_VAT_GST" if v.mode.name in calculating else "RESEARCH_ONLY")
        label = (f"Market {v.jurisdiction.code if v.jurisdiction else v.jurisdiction_id} "
                 f"{v.tax_type.code if v.tax_type else v.tax_type_id} {v.transaction_class.name} ({v.mode.name})")
        ensure("availability", str(v.id), label, tier)
    db.flush()


def alerts(db: Session, now: datetime) -> list:
    """Aggregate, platform-only alerts (no tenant data)."""
    from app.modules.super_admin.models import AttentionSeverity

    out = []
    live = db.query(TaxSourceMonitor).filter(TaxSourceMonitor.retired_at.is_(None),
                                             TaxSourceMonitor.enabled.is_(True)).all()
    limit = int(getattr(settings, "TAX_SOURCE_FAIL_ALERT_AFTER", 3))
    failing = [m for m in live if (m.consecutive_failures or 0) >= limit]
    out.append({"key": "tax.source_fetch_failing", "firing": bool(failing), "severity": AttentionSeverity.P3,
                "title": "Tax: official source checks are failing",
                "description": "; ".join(f"{m.title} ({m.host}): {m.consecutive_failures} failures"
                                         for m in failing) or "All source checks are succeeding."})
    for tier in TIERS:
        stale = [m for m in live if m.risk_tier == tier and _aware(m.next_check_due) < now - cadence(tier)]
        out.append({"key": f"tax.source_stale:{tier}", "firing": bool(stale), "severity": AttentionSeverity.P2,
                    "title": f"Tax: {tier.lower().replace('_', ' ')} sources are overdue for a check",
                    "description": (f"{len(stale)} source(s) more than one cadence overdue: "
                                    + "; ".join(f"{m.title} ({m.last_outcome or 'never checked'})" for m in stale))
                    if stale else "All sources in this tier are within their cadence."})
    overdue = db.query(TaxReviewDue).filter(TaxReviewDue.next_review_due < now).all()
    out.append({"key": "tax.review_overdue", "firing": bool(overdue), "severity": AttentionSeverity.P2,
                "title": "Tax: source or market revalidation overdue",
                "description": (f"{len(overdue)} item(s) overdue: " + "; ".join(d.label for d in overdue[:20]))
                if overdue else "No revalidation is overdue."})
    return out


def run_source_monitoring(db: Session, now: Optional[datetime] = None, fetcher: Optional[SafeFetcher] = None) -> dict:
    """One pass: due monitors (one lock each), reminders, review dues, alerts."""
    from app.modules.tax.monitoring import publish

    now = now or _now()
    svc = SourceMonitorService(db, fetcher=fetcher, now=lambda: now)
    outcomes = {}
    due = [i for (i,) in db.query(TaxSourceMonitor.id).filter(
        TaxSourceMonitor.retired_at.is_(None), TaxSourceMonitor.enabled.is_(True),
        TaxSourceMonitor.next_check_due <= now).order_by(TaxSourceMonitor.next_check_due)]
    for monitor_id in due:
        q = db.query(TaxSourceMonitor).filter(TaxSourceMonitor.id == monitor_id).populate_existing()
        if db.get_bind().dialect.name == "postgresql":
            q = q.with_for_update(skip_locked=True)
        m = q.first()
        if m is None or _aware(m.next_check_due) > now:
            db.rollback()
            continue
        try:
            if m.access_mode == "MANUAL_CHECK":
                _manual_reminder(db, m, now)
                outcomes[monitor_id] = "MANUAL_REMINDER"
            elif m.retry_after_until is not None and _aware(m.retry_after_until) > now:
                outcomes[monitor_id] = "BACKING_OFF"
            else:
                outcomes[monitor_id] = svc.check(m)
            db.commit()
        except Exception:                                     # noqa: BLE001 - one source never stops the others
            db.rollback()
            logger.exception("Source monitor %s failed", monitor_id)
    # Housekeeping is idempotent and keyed uniquely; with two workers, the one
    # that loses an insert race simply leaves it to the other.
    from sqlalchemy.exc import IntegrityError

    for step in (lambda: pre_effective_reminders(db, now), lambda: sync_review_dues(db, now),
                 lambda: publish(db, alerts(db, now))):
        try:
            step()
            db.commit()
        except IntegrityError:
            db.rollback()
    return {"checked": outcomes}


def run_tax_source_monitor_job() -> dict:
    """Scheduler entry point (tracked; see core/scheduler.py)."""
    from app.database import SessionLocal

    if not getattr(settings, "TAX_SOURCE_MONITOR_ENABLED", True):
        return {"skipped": "TAX_SOURCE_MONITOR_ENABLED is off"}
    db = SessionLocal()
    try:
        return run_source_monitoring(db)
    finally:
        db.close()


def billing_clearance(db: Session) -> dict:
    """jurisdiction id -> label (answer: research-only jurisdictions)."""
    from app.modules.tax.enums import PlatformVersionStatus
    from app.modules.tax.policy_models import TaxMarketAvailabilityVersion

    calculating = {"NATIVE_RULEPACK_APPROVED", "PROVIDER_APPROVED", "TENANT_CONFIG_APPROVED"}
    cleared = {v.jurisdiction_id for v in db.query(TaxMarketAvailabilityVersion).filter(
        TaxMarketAvailabilityVersion.status == PlatformVersionStatus.ACTIVE) if v.mode.name in calculating}
    tiers = {}
    for m in db.query(TaxSourceMonitor).filter(TaxSourceMonitor.retired_at.is_(None),
                                               TaxSourceMonitor.jurisdiction_id.isnot(None)):
        tiers.setdefault(m.jurisdiction_id, set()).add(m.risk_tier)
    out = {}
    for jid, ts in tiers.items():
        if ts == {"RESEARCH_ONLY"} and jid not in cleared:
            out[jid] = "Research only: not cleared for billing"
    return {"research_only": out, "cleared": cleared}
