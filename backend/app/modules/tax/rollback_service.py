"""
app/modules/tax/rollback_service.py
-----------------------------------
Emergency rollback (ZB-TAX-ARCH-001 Phase 8 PR 3, handoff §10.3), for
effective-dated packs (PR 2: the tax date picks the pack version) and
clock-switched market availability.

Rule packs. V is the bad ACTIVE version, P an earlier published version to
restore:
  * open-ended V -> a new version R that runs P's code (code_version, P's
    hash, P's content) from today's local legal date (or V's start, if later).
    V's valid_to is set to R's start (set-once) and V becomes ROLLED_BACK;
  * V already followed by a successor W -> quarantine only (no P, no R):
    V becomes ROLLED_BACK and W is untouched.
Either way V's [valid_from, valid_to) range fails closed
(RULE_PACK_ROLLED_BACK): rollback never creates a calculating version for a
past date, and it is the only path that affects past dates. Committed quotes
and issued invoices are never changed (T04); the request records the range
and V for retroactive analysis (PR 4).

Market availability: R copies P's content and is ACTIVE at once; V becomes
ROLLED_BACK.

Two people: a TAX_PUBLISHER proposes with a reason and a severity; a
different TAX_PUBLISHER approves with MFA (at the route) and it applies at
once. P's code (present, matching its hash) and validation are checked at
proposal and again at approval; a pending schedule for the same key is
cancelled inside the approval, only with explicit acknowledgement. Approval
locks V and any scheduled version (FOR UPDATE on Postgres) so the
activation job can't interleave.

Platform output is aggregate (P1 tax.rollback_applied:<id>); each affected
organization gets its own review item and an email to its admins, without
amounts.
"""
import logging
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import PlatformAuditAction
from app.modules.tax.enums import PlatformVersionStatus as S
from app.modules.tax.policy_models import (
    TaxMarketAvailabilityVersion, TaxRollbackRequest, TaxRulePackVersion, code_version_of,
)
from app.modules.tax.registry_service import MakerCheckerError, RegistryStateError, legal_date_at, utcnow

logger = logging.getLogger("zoiko_billing.tax.rollback")

KINDS = {"rule_pack": TaxRulePackVersion, "market_availability": TaxMarketAvailabilityVersion}
ALERT_PREFIX = "tax.rollback_applied"

#: What severity changes (documented in TAX_PHASE8.md). The platform alert is
#: always P1: every rollback needs eyes. Severity sets how soon affected
#: tenants' review items are due and how urgent their email reads.
SEVERITIES = {
    "SEV1": {"review_due_days": 0, "urgent": True, "meaning": "Wrong tax is being charged now"},
    "SEV2": {"review_due_days": 3, "urgent": False, "meaning": "Wrong tax in limited cases"},
    "SEV3": {"review_due_days": 14, "urgent": False, "meaning": "Precautionary"},
}
PUBLISHED = (S.ACTIVE, S.SUPERSEDED)
OPEN_QUOTE = ("QUOTED", "VALIDATED")


def _iso(d) -> Optional[str]:
    return d.isoformat() if d is not None else None


def _in_range(start: Optional[date], end: Optional[date], day: Optional[date]) -> bool:
    if day is None:
        return False
    return (start is None or start <= day) and (end is None or day < end)


def view_rollback(r: TaxRollbackRequest) -> dict:
    return {"id": r.id, "kind": r.kind, "version_id": r.version_id, "restore_to_id": r.restore_to_id,
            "quarantine_only": r.restore_to_id is None, "reason": r.reason, "severity": r.severity,
            "severity_meaning": SEVERITIES.get(r.severity, {}).get("meaning"), "cancel_schedule": r.cancel_schedule,
            "timezone": r.timezone, "regression": r.regression, "status": r.status, "proposed_by": r.proposed_by,
            "decided_by": r.decided_by, "decided_at": r.decided_at, "decision_reason": r.decision_reason,
            "result": r.result, "created_at": r.created_at}


class RollbackService:
    def __init__(self, db: Session):
        self.db = db
        self.audit = PlatformAuditService(db)

    # ── helpers ──
    def _workflow(self, kind: str):
        from app.modules.tax.policy_service import MarketAvailabilityService, RulePackService

        return {"rule_pack": RulePackService, "market_availability": MarketAvailabilityService}[kind](self.db)

    def _model(self, kind: str):
        model = KINDS.get(kind)
        if model is None:
            raise BadRequestException("kind must be rule_pack or market_availability.")
        return model

    def _locked(self, model, row_id: int):
        query = self.db.query(model).filter(model.id == row_id).populate_existing()
        if self.db.get_bind().dialect.name == "postgresql":
            query = query.with_for_update()
        return query.first()

    def _log(self, actor_id, request: TaxRollbackRequest, **meta):
        self.audit.log_no_commit(actor_id=actor_id, actor_role="super_admin", action=PlatformAuditAction.UPDATE,
                                 entity_type="TaxRollbackRequest", entity_id=request.id,
                                 metadata={"rollback": meta.pop("step"), "kind": request.kind,
                                           "version_id": request.version_id, **meta})

    def get(self, request_id: int) -> TaxRollbackRequest:
        row = self.db.get(TaxRollbackRequest, request_id)
        if row is None:
            raise NotFoundException("Rollback request", request_id)
        return row

    def _scheduled(self, kind: str, v):
        model, workflow = self._model(kind), self._workflow(kind)
        return self.db.query(model).filter(workflow._key_filter(v), model.status == S.SCHEDULED).first()

    def _timezone(self, kind: str, v, given: Optional[str]) -> Optional[str]:
        return (given or "").strip() or self._workflow(kind)._timezone(v)

    # ── checks run at proposal and again at approval ──
    def _check(self, kind: str, v, p, cancel_schedule: bool, tz: Optional[str]) -> Optional[dict]:
        """Raise on anything that blocks; return the regression report (packs)."""
        if v is None or v.status != S.ACTIVE:
            raise RegistryStateError("Only an ACTIVE version can be rolled back.")
        if kind == "rule_pack":
            if p is None and v.valid_to is None:
                raise RegistryStateError(
                    f"{v.code} v{v.version} is the current version: choose an earlier version to restore. "
                    "Quarantine without a restore is only for a version a later one already follows.")
            if p is not None and v.valid_to is not None:
                follower = self.db.query(TaxRulePackVersion).filter(
                    TaxRulePackVersion.code == v.code, TaxRulePackVersion.status == S.ACTIVE,
                    TaxRulePackVersion.valid_from == v.valid_to).first()
                raise RegistryStateError(
                    f"{v.code} v{v.version} is already followed by v{follower.version if follower else '?'}: quarantine "
                    "it (no restore), or roll back the later version first if that one is bad.")
            if p is not None and not tz:
                raise BadRequestException("This pack's jurisdiction spans several time zones: choose the time zone "
                                          "whose local date the rollback starts on.")
        elif p is None:
            raise BadRequestException("A market availability rollback needs a version to restore.")
        schedule = self._scheduled(kind, v)
        if schedule is not None and not cancel_schedule:
            raise RegistryStateError(
                f"Version {schedule.id} is scheduled to activate for this key. Confirm cancel_schedule to cancel it "
                "as part of this rollback (it returns to Approved).")
        if p is None:
            return None
        if p.id == v.id or p.status not in PUBLISHED or p.published_at is None:
            raise RegistryStateError("The version to restore must be an earlier published version.")
        workflow = self._workflow(kind)
        if kind == "rule_pack":
            if p.code != v.code or p.id > v.id:
                raise RegistryStateError("The version to restore must be an earlier version of the same pack.")
            missing = [m for m in (v.markets or []) if m not in (p.markets or [])]
            if missing:
                raise RegistryStateError("The version to restore doesn't cover every market of the version being "
                                         "rolled back.")
        elif workflow._key_filter(v) is not None and not self.db.query(TaxMarketAvailabilityVersion).filter(
                workflow._key_filter(v), TaxMarketAvailabilityVersion.id == p.id).first():
            raise RegistryStateError("The version to restore must be for the same market.")
        errors = workflow.errors(p)                      # includes P's code hash and approved sources (packs)
        if kind == "rule_pack":
            from app.modules.tax.rule_pack_integrity import integrity_of
            from app.modules.tax.rule_pack_retention import publish_problem

            state = integrity_of(p)["integrity"]
            if state != "MATCH":
                errors.append(f"v{p.version}'s code is {state.lower().replace('_', ' ')}: it can't be restored.")
            problem = publish_problem(p.code, code_version_of(p), p.code_hash)
            if problem:
                errors.append(problem)
        if errors:
            raise RegistryStateError("The version to restore isn't fit to use today: " + "; ".join(errors))
        if kind != "rule_pack":
            return None
        from app.modules.tax.engines import rule_pack_class
        from app.modules.tax.regression.runner import compare_packs

        report = compare_packs(self.db, v.code, rule_pack_class(v.code, code_version_of(v)),
                               rule_pack_class(p.code, code_version_of(p)))
        if report["errors"]:
            raise RegistryStateError("The regression run of the version to restore has errors: "
                                     + ", ".join(report["errors"]) + ".")
        return report

    # ── propose / decide / withdraw ──
    def candidates(self, kind: str, version_id: int) -> list:
        model = self._model(kind)
        v = self.db.get(model, version_id)
        if v is None:
            raise NotFoundException("Version", version_id)
        workflow = self._workflow(kind)
        rows = self.db.query(model).filter(workflow._key_filter(v), model.id != v.id, model.id < v.id,
                                           model.status.in_(PUBLISHED)).order_by(model.id.desc()).all()
        out = []
        for p in rows:
            item = {"id": p.id, "status": p.status.name, "published_at": p.published_at}
            if kind == "rule_pack":
                from app.modules.tax.rule_pack_integrity import integrity_of

                item.update({"version": p.version, "valid_from": p.valid_from, "valid_to": p.valid_to,
                             "integrity": integrity_of(p)["integrity"]})
            else:
                item.update({"mode": p.mode.name})
            out.append(item)
        return out

    def propose(self, *, actor_id: int, kind: str, version_id: int, restore_to_id: Optional[int], reason: str,
                severity: str, cancel_schedule: bool = False, timezone: Optional[str] = None) -> TaxRollbackRequest:
        if not (reason or "").strip():
            raise BadRequestException("A reason is required.")
        if severity not in SEVERITIES:
            raise BadRequestException("severity must be SEV1, SEV2 or SEV3.")
        model = self._model(kind)
        v = self.db.get(model, version_id)
        if v is None:
            raise NotFoundException("Version", version_id)
        p = self.db.get(model, restore_to_id) if restore_to_id is not None else None
        if restore_to_id is not None and p is None:
            raise NotFoundException("Version to restore", restore_to_id)
        if self.db.query(TaxRollbackRequest).filter(TaxRollbackRequest.kind == kind,
                                                    TaxRollbackRequest.version_id == v.id,
                                                    TaxRollbackRequest.status == "PROPOSED").first():
            raise RegistryStateError("A rollback of this version is already waiting for a decision.")
        tz = self._timezone(kind, v, timezone) if kind == "rule_pack" else None
        report = self._check(kind, v, p, cancel_schedule, tz)
        request = TaxRollbackRequest(kind=kind, version_id=v.id, restore_to_id=restore_to_id, reason=reason.strip(),
                                     severity=severity, cancel_schedule=bool(cancel_schedule), timezone=tz,
                                     regression=report, status="PROPOSED", proposed_by=actor_id, created_at=utcnow())
        self.db.add(request)
        self.db.flush()
        self._log(actor_id, request, step="proposed", restore_to_id=restore_to_id, severity=severity,
                  cancel_schedule=bool(cancel_schedule))
        return request

    def withdraw(self, *, actor_id: int, request_id: int) -> TaxRollbackRequest:
        request = self.get(request_id)
        if request.status != "PROPOSED":
            raise RegistryStateError(f"Rollback request {request.id} is already {request.status}.")
        if actor_id != request.proposed_by:
            raise MakerCheckerError("Only the person who proposed a rollback can withdraw it.")
        request.status, request.decided_by, request.decided_at = "WITHDRAWN", actor_id, utcnow()
        self.db.flush()
        self._log(actor_id, request, step="withdrawn")
        return request

    def decide(self, *, actor_id: int, request_id: int, approve: bool,
               reason: Optional[str] = None) -> TaxRollbackRequest:
        request = self.get(request_id)
        if request.status != "PROPOSED":
            raise RegistryStateError(f"Rollback request {request.id} is already {request.status}.")
        if actor_id == request.proposed_by:
            raise MakerCheckerError("You proposed this rollback; a different TAX_PUBLISHER must decide it.")
        reason = (reason or "").strip() or None
        if not approve:
            if not reason:
                raise BadRequestException("A reason is required to reject a rollback.")
            request.status, request.decided_by, request.decided_at, request.decision_reason = (
                "REJECTED", actor_id, utcnow(), reason)
            self.db.flush()
            self._log(actor_id, request, step="rejected")
            return request
        model = self._model(request.kind)
        v = self.db.get(model, request.version_id)
        schedule = self._scheduled(request.kind, v) if v is not None else None
        # Lock order: the scheduled version first (the activation job locks it
        # with SKIP LOCKED), then V. Re-read both under the lock.
        if schedule is not None:
            schedule = self._locked(model, schedule.id)
        v = self._locked(model, request.version_id)
        p = self.db.get(model, request.restore_to_id) if request.restore_to_id is not None else None
        report = self._check(request.kind, v, p, request.cancel_schedule, request.timezone)
        if report is not None:
            request.regression = report
        apply = self._apply_pack if request.kind == "rule_pack" else self._apply_availability
        result = apply(request, v, p, actor_id)
        if schedule is not None and schedule.status == S.SCHEDULED:
            self._cancel_schedule(request, schedule, actor_id)
            result["cancelled_schedule_id"] = schedule.id
        request.status, request.decided_by, request.decided_at, request.decision_reason = (
            "APPROVED", actor_id, utcnow(), reason)
        request.result = result
        self.db.flush()
        self._log(actor_id, request, step="applied", **{k: v_ for k, v_ in result.items()
                                                         if k != "per_organization"})
        self._alert(request, v, result)
        self._tell_tenants(request, v, result)
        if request.kind == "rule_pack":                    # Phase 8 PR 4: retroactive analysis of V's documents
            from app.modules.tax import retro_service

            retro_service.enqueue(self.db, retro_service.rollback_trigger(self.db, request), actor_id)
        return request

    # ── apply ──
    def _apply_pack(self, request, v: TaxRulePackVersion, p: Optional[TaxRulePackVersion], actor_id: int) -> dict:
        now = utcnow()
        workflow = self._workflow("rule_pack")
        result = {"applied_at": now.isoformat(), "pack_code": v.code, "rolled_back_version_id": v.id,
                  "rolled_back_version": v.version, "restored_version_id": p.id if p else None,
                  "quarantine_only": p is None}
        if p is not None:
            today = legal_date_at(now, request.timezone)
            start = max(today, v.valid_from) if v.valid_from else today
            v.valid_to = start                                        # set once (guards)
            v.status, v.superseded_at = S.ROLLED_BACK, now
            self.db.flush()
            r = TaxRulePackVersion(
                code=v.code, version=f"{code_version_of(p)}-rb{request.id}", code_version=code_version_of(p),
                markets=p.markets, rounding_rule=p.rounding_rule, rounding_mode=p.rounding_mode,
                required_facts=p.required_facts, coverage=p.coverage, source_dependencies=p.source_dependencies,
                golden_test_report=p.golden_test_report, code_hash=p.code_hash, valid_from=start,
                notes=f"Emergency rollback of v{v.version} to v{p.version} (rollback request {request.id}).",
                restores_id=p.id, rollback_of_id=v.id, predecessor_id=v.id, status=S.ACTIVE,
                created_by_user_id=request.proposed_by, maker_user_id=request.proposed_by, checker_user_id=actor_id,
                publisher_user_id=actor_id, created_at=now, submitted_at=request.created_at, approved_at=now,
                published_at=now)
            self.db.add(r)
            self.db.flush()
            workflow._log(actor_id, PlatformAuditAction.CREATE, r, new_values=workflow.describe(r),
                          metadata={"rollback_request_id": request.id, "restores_id": p.id, "rollback_of_id": v.id})
            result.update({"rollback_version_id": r.id, "rollback_version": r.version})
        else:
            v.status, v.superseded_at = S.ROLLED_BACK, now
            self.db.flush()
        workflow._log(actor_id, PlatformAuditAction.UPDATE, v,
                      metadata={"rolled_back": True, "rollback_request_id": request.id})
        result.update({"range_from": _iso(v.valid_from), "range_to": _iso(v.valid_to)})
        result.update(self._mark_quotes(v))
        return result

    def _mark_quotes(self, v: TaxRulePackVersion) -> dict:
        """Open quotes made with V go STALE; committed ones are left for PR 4."""
        from app.modules.tax.enums import TaxQuoteStatus
        from app.modules.tax.quote_models import TaxQuote

        stale, not_determined, per_org = 0, 0, {}
        quotes = self.db.query(TaxQuote).filter(TaxQuote.rule_pack_version_id == v.id).all()
        for q in quotes:
            counts = per_org.setdefault(q.organization_id, {"stale": 0, "not_determined": 0, "committed": 0})
            if q.status == TaxQuoteStatus.COMMITTED:
                counts["committed"] += 1
                continue
            if q.status.name not in OPEN_QUOTE:
                continue
            if _in_range(v.valid_from, v.valid_to, q.tax_date):
                q.status, q.stale_reason = TaxQuoteStatus.STALE, ("The tax rules for this tax date were rolled back; "
                                                                  "it can't be calculated until they are reviewed.")
                not_determined += 1
                counts["not_determined"] += 1
            else:
                q.status, q.stale_reason = TaxQuoteStatus.STALE, "The tax rules were rolled back; re-quote."
                stale += 1
                counts["stale"] += 1
        self.db.flush()
        return {"open_quotes_stale": stale, "open_quotes_not_determined": not_determined,
                "committed_quotes_for_analysis": sum(c["committed"] for c in per_org.values()),
                "organizations_affected": len(per_org),
                "per_organization": {str(k): c for k, c in per_org.items()}}

    def _apply_availability(self, request, v: TaxMarketAvailabilityVersion, p: TaxMarketAvailabilityVersion,
                            actor_id: int) -> dict:
        from app.modules.tax.models import EntityTaxActivation
        from app.modules.tax.enums import TenantApprovalStatus

        now = utcnow()
        workflow = self._workflow("market_availability")
        v.status, v.superseded_at = S.ROLLED_BACK, now
        self.db.flush()                                   # the one-ACTIVE index is immediate
        r = TaxMarketAvailabilityVersion(
            jurisdiction_id=p.jurisdiction_id, tax_type_id=p.tax_type_id, transaction_class=p.transaction_class,
            mode=p.mode, tenant_config_permitted=p.tenant_config_permitted, gates=p.gates,
            notes=f"Emergency rollback of version {v.id} to version {p.id} (rollback request {request.id}).",
            restores_id=p.id, rollback_of_id=v.id, predecessor_id=v.id, status=S.ACTIVE,
            created_by_user_id=request.proposed_by, maker_user_id=request.proposed_by, checker_user_id=actor_id,
            publisher_user_id=actor_id, created_at=now, submitted_at=request.created_at, approved_at=now,
            published_at=now)
        self.db.add(r)
        self.db.flush()
        workflow._log(actor_id, PlatformAuditAction.CREATE, r, new_values=workflow.describe(r),
                      metadata={"rollback_request_id": request.id, "restores_id": p.id, "rollback_of_id": v.id})
        workflow._log(actor_id, PlatformAuditAction.UPDATE, v,
                      metadata={"rolled_back": True, "rollback_request_id": request.id})
        orgs = {a.organization_id for a in self.db.query(EntityTaxActivation).filter(
            EntityTaxActivation.jurisdiction_id == v.jurisdiction_id, EntityTaxActivation.tax_type_id == v.tax_type_id,
            EntityTaxActivation.transaction_class == v.transaction_class,
            EntityTaxActivation.status == TenantApprovalStatus.APPROVED)}
        return {"applied_at": now.isoformat(), "rolled_back_version_id": v.id, "rollback_version_id": r.id,
                "restored_version_id": p.id, "restored_mode": p.mode.name, "range_from": None, "range_to": None,
                "open_quotes_stale": None, "open_quotes_not_determined": None,
                "committed_quotes_for_analysis": None, "organizations_affected": len(orgs),
                "per_organization": {str(o): {} for o in sorted(orgs)}}

    def _cancel_schedule(self, request, schedule, actor_id: int) -> None:
        workflow = self._workflow(request.kind)
        schedule.status = S.APPROVED
        schedule.activate_at = schedule.activate_at_local = schedule.activate_tz = None
        schedule.scheduled_by_user_id = None
        schedule.activation_error = None
        self.db.flush()
        workflow._log(actor_id, PlatformAuditAction.UPDATE, schedule,
                      metadata={"activation_cancel": "cancelled_by_rollback", "rollback_request_id": request.id})

    # ── outputs ──
    def _subject(self, request, v) -> str:
        if request.kind == "rule_pack":
            return f"rule pack {v.code} v{v.version}"
        jurisdiction = v.jurisdiction.code if v.jurisdiction else v.jurisdiction_id
        tax_type = v.tax_type.code if v.tax_type else v.tax_type_id
        return f"market {jurisdiction} {tax_type} {v.transaction_class.name}"

    def _alert(self, request, v, result: dict) -> None:
        """P1, aggregate only: no tenant identifiers. Acknowledged by staff,
        never auto-resolved."""
        from app.modules.super_admin.attention_service import AttentionService
        from app.modules.super_admin.models import AttentionSeverity
        from app.modules.tax.monitoring import SOURCE

        span = (f"tax dates {result['range_from'] or 'from the start'} to {result['range_to'] or 'open'} now fail "
                "closed; " if request.kind == "rule_pack" else "")
        counts = ("" if result["open_quotes_stale"] is None else
                  f"{result['open_quotes_stale']} open quotes made STALE, {result['open_quotes_not_determined']} made "
                  f"NOT_DETERMINED, {result['committed_quotes_for_analysis']} committed quotes for retroactive "
                  "analysis; ")
        description = (f"{request.severity} rollback of {self._subject(request, v)}"
                       + (" (quarantine only)" if result.get("quarantine_only") else "") + ": "
                       + span + counts + f"{result['organizations_affected']} organizations affected. "
                       "See TAX_MONITORING_RUNBOOK.md (rollback).")
        try:
            with self.db.begin_nested():
                AttentionService(self.db).report_or_update(
                    source=SOURCE, source_key=f"tax:{ALERT_PREFIX}:{request.id}", title="Tax: emergency rollback applied",
                    description=description, base_severity=AttentionSeverity.P1)
        except Exception as exc:                                        # noqa: BLE001
            logger.warning("Rollback alert could not be raised: %s", exc)

    def _tell_tenants(self, request, v, result: dict) -> None:
        """Each affected organization: a review item (its own counts) and an
        email to its admins, without amounts."""
        from app.modules.auth.models import User, UserRole
        from app.modules.tax.enums import ReviewItemKind
        from app.modules.tax.models import TaxReviewItem

        severity = SEVERITIES.get(request.severity, SEVERITIES["SEV2"])
        now = utcnow()
        market = self._market_label(request, v)
        span = (f" for tax dates {result['range_from'] or 'from the start'} to {result['range_to'] or 'open'}"
                if request.kind == "rule_pack" else "")
        for org_key, counts in (result.get("per_organization") or {}).items():
            org_id = int(org_key)
            parts = []
            if counts.get("stale"):
                parts.append(f"{counts['stale']} draft quote(s) need re-quoting")
            if counts.get("not_determined"):
                parts.append(f"{counts['not_determined']} draft quote(s) can't be calculated for now")
            if counts.get("committed"):
                parts.append(f"{counts['committed']} issued invoice(s) will be reviewed; they are not changed")
            detail = (f"Tax rules for {market} were rolled back{span}. " + ("; ".join(parts) + "." if parts else
                      "Re-quote drafts in this market before issuing."))
            self.db.add(TaxReviewItem(organization_id=org_id, kind=ReviewItemKind.TAX_ROLLBACK_APPLIED,
                                      subject_type="TaxRollbackRequest", subject_id=request.id,
                                      due_date=(now + timedelta(days=severity["review_due_days"])).date(),
                                      detail=detail, owner_role="org_admin", created_at=now))
            admins = self.db.query(User).filter(User.organization_id == org_id, User.role == UserRole.ORG_ADMIN,
                                                User.is_active.is_(True)).all()
            for admin in admins:
                self._email(request, admin, market, span, severity)
        self.db.flush()

    def _market_label(self, request, v) -> str:
        if request.kind == "rule_pack":
            return ", ".join(f"{m.get('jurisdiction_code')} {m.get('tax_type')}" for m in v.markets or [])
        jurisdiction = v.jurisdiction.code if v.jurisdiction else v.jurisdiction_id
        tax_type = v.tax_type.code if v.tax_type else v.tax_type_id
        return f"{jurisdiction} {tax_type}"

    def _email(self, request, admin, market: str, span: str, severity: dict) -> None:
        from app.modules.notifications.service import dispatch_email

        try:
            dispatch_email(
                template_id="ZB-TAX-001", recipient_email=admin.email,
                context={"recipient_first_name": admin.first_name or "there", "market_label": market,
                         "date_range": span.strip() or "from now on",
                         "urgency": "Action needed today." if severity["urgent"] else "Please review soon."},
                event_name="tax.rollback_applied", entity_type="TaxRollbackRequest", entity_id=request.id,
                organization_id=admin.organization_id, db=self.db,
                idempotency_key=f"tax.rollback_applied:{request.id}:{admin.email}",
            )
        except Exception:                                           # a notice never undoes the rollback
            logger.exception("Rollback notice to an org admin failed (request %s)", request.id)
