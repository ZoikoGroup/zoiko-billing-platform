"""
app/modules/tax/activation.py
-----------------------------
Scheduled activation (ZB-TAX-ARCH-001 Phase 8 PR 2, handoff §10.1 step 07).

A rule-pack or market-availability version can be published now or
scheduled: it is SCHEDULED until ``activate_at`` (UTC), which the publisher
enters as jurisdiction-local legal time. An idempotent job activates due
versions; a version more than TAX_ALERT_ACTIVATION_LATE_MINUTES past its time
raises the P1 alert ``tax.activation_late``.

Decision (approved with the plan): rule packs are effective-dated, so the
quote's tax date picks the pack version in force (like rates: T03/T17);
activate_at is only when a version becomes usable. Market availability
switches at activate_at regardless of tax date (it says whether a market is
calculated now).
"""
import logging
import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Callable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException

logger = logging.getLogger("zoiko_billing.tax.activation")

ALERT_KEY = "tax.activation_late"
_OFFSET = re.compile(r"^([+-])(\d{2}):?(\d{2})$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise BadRequestException(f"{name!r} is not a known IANA time zone (for example Europe/London).")


def _offset(text: str) -> timedelta:
    match = _OFFSET.match((text or "").strip())
    if not match:
        raise BadRequestException("The UTC offset must look like +01:00 or -05:00.")
    sign, hours, minutes = match.groups()
    delta = timedelta(hours=int(hours), minutes=int(minutes))
    return -delta if sign == "-" else delta


def local_to_utc(local_text: str, tz_name: str, utc_offset: Optional[str] = None) -> datetime:
    """Convert jurisdiction-local legal time to UTC (T17). A local time that
    doesn't exist (the spring-forward gap) is refused; an ambiguous one (the
    autumn overlap) needs the UTC offset that was meant."""
    try:
        naive = datetime.fromisoformat((local_text or "").strip())
    except ValueError:
        raise BadRequestException("Enter the activation time as local date and time, for example 2027-01-01T00:00.")
    if naive.tzinfo is not None:
        raise BadRequestException("Enter the local time without an offset; give the UTC offset separately if needed.")
    tz = zone(tz_name)
    first, second = naive.replace(tzinfo=tz, fold=0), naive.replace(tzinfo=tz, fold=1)
    if first.astimezone(timezone.utc).astimezone(tz).replace(tzinfo=None) != naive:
        raise BadRequestException(f"{naive.isoformat(timespec='minutes')} does not exist in {tz_name} "
                                  "(the clocks go forward then); choose another time.")
    if first.utcoffset() != second.utcoffset():
        if not utc_offset:
            options = " or ".join(_fmt(d.utcoffset()) for d in (first, second))
            raise BadRequestException(f"{naive.isoformat(timespec='minutes')} happens twice in {tz_name} (the clocks go "
                                      f"back then); give the UTC offset you mean: {options}.")
        wanted = _offset(utc_offset)
        chosen = next((d for d in (first, second) if d.utcoffset() == wanted), None)
        if chosen is None:
            raise BadRequestException(f"{utc_offset} is not an offset {tz_name} uses at that time.")
        return chosen.astimezone(timezone.utc)
    if utc_offset and _offset(utc_offset) != first.utcoffset():
        raise BadRequestException(f"{utc_offset} is not the offset {tz_name} uses at that time ({_fmt(first.utcoffset())}).")
    return first.astimezone(timezone.utc)


def _fmt(delta: timedelta) -> str:
    minutes = int(delta.total_seconds() // 60)
    sign = "-" if minutes < 0 else "+"
    minutes = abs(minutes)
    return f"{sign}{minutes // 60:02d}:{minutes % 60:02d}"


def local_midnight_utc(day: date, tz_name: str) -> datetime:
    """The UTC instant the legal day starts in that zone."""
    return datetime.combine(day, time.min).replace(tzinfo=zone(tz_name)).astimezone(timezone.utc)


# ── the job ─────────────────────────────────────────────────────────────

def activate_due(db: Session, now: Callable = _now) -> dict:
    """Activate every SCHEDULED version whose time has come. Idempotent: each
    row is locked and re-checked, and a second run (or worker) does nothing."""
    from app.modules.tax.enums import PlatformVersionStatus
    from app.modules.tax.policy_service import MarketAvailabilityService, RulePackService

    current = now()
    activated, failed = [], []
    for svc_cls in (MarketAvailabilityService, RulePackService):
        model = svc_cls.model
        ids = [i for (i,) in db.query(model.id).filter(model.status == PlatformVersionStatus.SCHEDULED,
                                                        model.activate_at <= current).order_by(model.activate_at)]
        for version_id in ids:
            row = svc_cls(db).activate_due(version_id, current)
            db.commit()
            (activated if row is not None else failed).append(f"{svc_cls.entity_type}:{version_id}")
    return {"activated": activated, "not_activated": failed}


def run_tax_activation_job() -> dict:
    """Scheduler entry point (tracked; see core/scheduler.py)."""
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        result = activate_due(db)
        if result["activated"] or result["not_activated"]:
            logger.info("[SCHEDULER] Tax activation: %s", result)
        return result
    finally:
        db.close()


# ── the late alert (aggregate: no tenant data) ──────────────────────────

def late_scheduled(db: Session, current: datetime) -> list:
    from app.modules.tax.enums import PlatformVersionStatus
    from app.modules.tax.policy_models import TaxMarketAvailabilityVersion, TaxRulePackVersion

    limit = int(getattr(settings, "TAX_ALERT_ACTIVATION_LATE_MINUTES", 10))
    cutoff = current - timedelta(minutes=limit)
    out = []
    for model, kind in ((TaxRulePackVersion, "rule pack"), (TaxMarketAvailabilityVersion, "market availability")):
        for row in db.query(model).filter(model.status == PlatformVersionStatus.SCHEDULED, model.activate_at <= cutoff):
            if kind == "rule pack":
                subject = f"{row.code} v{row.version}"
            else:
                subject = (f"{row.jurisdiction.code if row.jurisdiction else row.jurisdiction_id} "
                           f"{row.tax_type.code if row.tax_type else row.tax_type_id} {row.transaction_class.name}")
            out.append({"kind": kind, "subject": subject,
                        "minutes_late": int((current - aware(row.activate_at)).total_seconds() // 60),
                        "failed_check": bool(row.activation_error)})
    return out


def alert_for(late: list) -> dict:
    from app.modules.super_admin.models import AttentionSeverity

    listed = "; ".join(f"{i['kind']} {i['subject']} {i['minutes_late']} min late"
                       + (" (activation check failed)" if i["failed_check"] else "") for i in late)
    return {"key": ALERT_KEY, "firing": bool(late), "severity": AttentionSeverity.P1,
            "title": "Tax: a scheduled activation is late",
            "description": (f"Scheduled tax changes have not activated: {listed}. Check the activation job and the "
                            "version's activation error. See TAX_MONITORING_RUNBOOK.md." if late else
                            "Every scheduled tax activation ran on time.")}
