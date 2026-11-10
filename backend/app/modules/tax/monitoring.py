"""
app/modules/tax/monitoring.py
-----------------------------
Tax monitoring and alerts (ZB-TAX-ARCH-001 Phase 6 PR 2).

Metrics are aggregate only: counts, ages, rates and provider/market codes.
No organization, invoice, customer or user identifier ever appears in a
metric or an alert text (T13). Alerts go to the platform's existing
alerting system, the Attention Engine (super_admin/attention_service.py):
an alert that fires opens or updates an AttentionItem under source
"tax_monitoring"; when the condition clears it auto-resolves. Each alert
has a runbook entry in backend/docs/TAX_MONITORING_RUNBOOK.md.

Alerts and their default thresholds (all configurable in settings):

  tax.outbox_oldest_unresolved   oldest unresolved provider outbox row older than
                                 TAX_ALERT_OUTBOX_OLDEST_AGE_MINUTES (30)
  tax.reconciliation_heartbeat   heartbeat older than TAX_ALERT_HEARTBEAT_STALE_MINUTES (15),
                                 never recorded, or last pass failed (while reconciliation is enabled)
  tax.circuit_open:<provider>    a provider's circuit breaker is OPEN
  tax.provider_unavailable:<cc>  share of quotes in market <cc> that were PROVIDER_UNAVAILABLE over
                                 TAX_ALERT_RATE_WINDOW_MINUTES (60) at or above
                                 TAX_ALERT_PROVIDER_UNAVAILABLE_RATE (0.2), with at least
                                 TAX_ALERT_RATE_MIN_QUOTES (10) quotes
  tax.not_determined:<cc>        same for NOT_DETERMINED, at or above TAX_ALERT_NOT_DETERMINED_RATE (0.5)
  tax.review_backlog             REVIEW_REQUIRED outbox rows at or above TAX_ALERT_REVIEW_BACKLOG (5)
  tax.secret_store_failures      quotes refused because provider credentials were unavailable over the
                                 window, at or above TAX_ALERT_SECRET_STORE_FAILURES (1)
  tax.rule_pack_integrity        (P1, Phase 8) an ACTIVE rule pack whose running code is not its approved
                                 code hash (rule_pack_integrity.py)
  tax.activation_late            (P1, Phase 8) a SCHEDULED version more than
                                 TAX_ALERT_ACTIVATION_LATE_MINUTES (10) past its activation time (activation.py)
"""
import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings

logger = logging.getLogger("zoiko_billing.tax.monitoring")

SOURCE = "tax_monitoring"
SECRET_STORE_MARKER = "credentials are unavailable"
NOT_DETERMINED_STATUSES = ("NEEDS_EVIDENCE", "UNSUPPORTED")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def thresholds() -> dict:
    s = settings
    return {
        "outbox_oldest_age_minutes": int(getattr(s, "TAX_ALERT_OUTBOX_OLDEST_AGE_MINUTES", 30)),
        "heartbeat_stale_minutes": int(getattr(s, "TAX_ALERT_HEARTBEAT_STALE_MINUTES", 15)),
        "rate_window_minutes": int(getattr(s, "TAX_ALERT_RATE_WINDOW_MINUTES", 60)),
        "rate_min_quotes": int(getattr(s, "TAX_ALERT_RATE_MIN_QUOTES", 10)),
        "provider_unavailable_rate": float(getattr(s, "TAX_ALERT_PROVIDER_UNAVAILABLE_RATE", 0.2)),
        "not_determined_rate": float(getattr(s, "TAX_ALERT_NOT_DETERMINED_RATE", 0.5)),
        "review_backlog": int(getattr(s, "TAX_ALERT_REVIEW_BACKLOG", 5)),
        "secret_store_failures": int(getattr(s, "TAX_ALERT_SECRET_STORE_FAILURES", 1)),
    }


def _market(supply_address) -> str:
    if isinstance(supply_address, dict):
        code = supply_address.get("country_code") or supply_address.get("country")
        if isinstance(code, str) and len(code.strip()) == 2:
            return code.strip().upper()
    return "UNKNOWN"


def collect(db: Session, now: Callable = _now) -> dict:
    """Aggregate tax metrics. Nothing here identifies a tenant."""
    from app.modules.tax.enums import ACTIVE_OUTBOX_STATES, CircuitState, OutboxState, TaxOutcome
    from app.modules.tax.provider_issuance import RECONCILIATION_JOB
    from app.modules.tax.provider_models import TaxJobHeartbeat, TaxProviderCircuit, TaxProviderOutbox
    from app.modules.tax.quote_models import TaxQuote, TaxQuoteLine
    from app.modules.tax.activation import late_scheduled
    from app.modules.tax.rule_pack_integrity import check_active

    current = now()
    t = thresholds()
    unresolved = tuple(ACTIVE_OUTBOX_STATES) + (OutboxState.REVIEW_REQUIRED,)
    oldest = db.query(func.min(TaxProviderOutbox.created_at)).filter(TaxProviderOutbox.state.in_(unresolved)).scalar()
    review_backlog = db.query(func.count(TaxProviderOutbox.id)).filter(
        TaxProviderOutbox.state == OutboxState.REVIEW_REQUIRED).scalar() or 0
    unresolved_count = db.query(func.count(TaxProviderOutbox.id)).filter(
        TaxProviderOutbox.state.in_(unresolved)).scalar() or 0

    hb = db.get(TaxJobHeartbeat, RECONCILIATION_JOB)
    hb_age = None
    if hb is not None and hb.last_finished_at is not None:
        hb_age = int((current - _aware(hb.last_finished_at)).total_seconds())

    circuits = {c.provider_name: c.state.name for c in db.query(TaxProviderCircuit)}
    open_circuits = sorted(name for name, state in circuits.items() if state == CircuitState.OPEN.name)

    since = current - timedelta(minutes=t["rate_window_minutes"])
    quotes = db.query(TaxQuote.id, TaxQuote.status, TaxQuote.supply_address, TaxQuote.refusal_reason).filter(
        TaxQuote.created_at >= since).all()
    nd_lines = {qid for (qid,) in db.query(TaxQuoteLine.tax_quote_id).filter(
        TaxQuoteLine.tax_quote_id.in_([q.id for q in quotes] or [-1]),
        TaxQuoteLine.outcome == TaxOutcome.NOT_DETERMINED).distinct()}
    markets = defaultdict(lambda: {"quotes": 0, "provider_unavailable": 0, "not_determined": 0})
    secret_failures = 0
    for q in quotes:
        m = markets[_market(q.supply_address)]
        m["quotes"] += 1
        status = getattr(q.status, "name", str(q.status))
        if status == "PROVIDER_UNAVAILABLE":
            m["provider_unavailable"] += 1
        if status in NOT_DETERMINED_STATUSES or q.id in nd_lines:
            m["not_determined"] += 1
        if SECRET_STORE_MARKER in (q.refusal_reason or "").lower():
            secret_failures += 1
    by_market = {}
    for code, m in sorted(markets.items()):
        n = m["quotes"]
        by_market[code] = {**m, "provider_unavailable_rate": round(m["provider_unavailable"] / n, 4) if n else 0.0,
                           "not_determined_rate": round(m["not_determined"] / n, 4) if n else 0.0}

    return {
        "generated_at": current.isoformat(),
        "outbox": {"unresolved": int(unresolved_count),
                   "oldest_unresolved_age_seconds": int((current - _aware(oldest)).total_seconds()) if oldest else None,
                   "review_required": int(review_backlog)},
        "reconciliation": {"enabled": bool(getattr(settings, "TAX_PROVIDER_RECONCILIATION_ENABLED", True)),
                           "last_finished_age_seconds": hb_age, "last_ok": bool(hb and hb.last_ok)},
        "circuits": circuits,
        "open_circuits": open_circuits,
        "quotes_window_minutes": t["rate_window_minutes"],
        "by_market": by_market,
        "secret_store_failures": secret_failures,
        "rule_pack_integrity": check_active(db),
        "activation_late": late_scheduled(db, current),
        "thresholds": t,
    }


def evaluate(metrics: dict) -> list:
    """Alerts for these metrics: [{key, firing, title, description, severity}]. Aggregate text only."""
    from app.modules.super_admin.models import AttentionSeverity

    t = metrics["thresholds"]
    out = []

    def alert(key, firing, title, description, severity=AttentionSeverity.P2):
        out.append({"key": key, "firing": bool(firing), "title": title, "description": description,
                    "severity": severity})

    age = metrics["outbox"]["oldest_unresolved_age_seconds"]
    alert("tax.outbox_oldest_unresolved", age is not None and age >= t["outbox_oldest_age_minutes"] * 60,
          "Tax: provider outbox has an old unresolved row",
          f"Oldest unresolved provider outbox row is {age // 60 if age else 0} min old "
          f"(threshold {t['outbox_oldest_age_minutes']} min); {metrics['outbox']['unresolved']} unresolved in total.",
          AttentionSeverity.P1)

    rec = metrics["reconciliation"]
    hb_age = rec["last_finished_age_seconds"]
    stale = rec["enabled"] and (hb_age is None or hb_age >= t["heartbeat_stale_minutes"] * 60 or not rec["last_ok"])
    alert("tax.reconciliation_heartbeat", stale, "Tax: reconciliation heartbeat is stale",
          ("The reconciliation worker has never recorded a heartbeat." if hb_age is None else
           f"Last reconciliation pass finished {hb_age // 60} min ago (threshold {t['heartbeat_stale_minutes']} min)"
           f"{'' if rec['last_ok'] else ' and failed'}. Provider issuing is blocked while it is stale."),
          AttentionSeverity.P1)

    for provider in sorted(metrics["circuits"]):
        alert(f"tax.circuit_open:{provider}", provider in metrics["open_circuits"],
              f"Tax: circuit breaker open for provider {provider}",
              f"Quotes and issuing through {provider} return PROVIDER_UNAVAILABLE until the cool-down ends.",
              AttentionSeverity.P1)

    for code, m in metrics["by_market"].items():
        enough = m["quotes"] >= t["rate_min_quotes"]
        alert(f"tax.provider_unavailable:{code}",
              enough and m["provider_unavailable_rate"] >= t["provider_unavailable_rate"],
              f"Tax: high PROVIDER_UNAVAILABLE rate in {code}",
              f"{m['provider_unavailable']} of {m['quotes']} quotes in {code} were PROVIDER_UNAVAILABLE over the last "
              f"{metrics['quotes_window_minutes']} min (threshold {t['provider_unavailable_rate']:.0%}).")
        alert(f"tax.not_determined:{code}",
              enough and m["not_determined_rate"] >= t["not_determined_rate"],
              f"Tax: high NOT_DETERMINED rate in {code}",
              f"{m['not_determined']} of {m['quotes']} quotes in {code} were NOT_DETERMINED over the last "
              f"{metrics['quotes_window_minutes']} min (threshold {t['not_determined_rate']:.0%}).",
              AttentionSeverity.P3)

    backlog = metrics["outbox"]["review_required"]
    alert("tax.review_backlog", backlog >= t["review_backlog"], "Tax: REVIEW_REQUIRED backlog",
          f"{backlog} provider transactions need review (threshold {t['review_backlog']}).")

    failures = metrics["secret_store_failures"]
    alert("tax.secret_store_failures", failures >= t["secret_store_failures"],
          "Tax: secret store access failing",
          f"{failures} quotes were refused because provider credentials were unavailable over the last "
          f"{metrics['quotes_window_minutes']} min (threshold {t['secret_store_failures']}).",
          AttentionSeverity.P1)

    from app.modules.tax.rule_pack_integrity import alert_for

    out.append(alert_for(metrics.get("rule_pack_integrity") or []))

    from app.modules.tax.activation import alert_for as activation_alert

    out.append(activation_alert(metrics.get("activation_late") or []))
    return out


def publish(db: Session, alerts: list) -> dict:
    """Open/update or auto-resolve one Attention item per alert key."""
    from app.modules.super_admin.attention_service import AttentionService

    attention = AttentionService(db)
    fired, cleared = [], []
    for a in alerts:
        source_key = f"tax:{a['key']}"
        if a["firing"]:
            attention.report_or_update(source=SOURCE, source_key=source_key, title=a["title"],
                                       description=a["description"], base_severity=a["severity"])
            fired.append(a["key"])
        elif attention.auto_resolve(source=SOURCE, source_key=source_key) is not None:
            cleared.append(a["key"])
    db.commit()
    return {"fired": fired, "cleared": cleared}


def run_tax_monitoring_job() -> dict:
    """Scheduler entry point (tracked; see core/scheduler.py)."""
    from app.database import SessionLocal

    if not getattr(settings, "TAX_MONITORING_ENABLED", True):
        return {"skipped": "TAX_MONITORING_ENABLED is off"}
    db = SessionLocal()
    try:
        metrics = collect(db)
        result = publish(db, evaluate(metrics))
        logger.info("[SCHEDULER] Tax monitoring: fired=%s cleared=%s", result["fired"], result["cleared"])
        return result
    finally:
        db.close()
