"""
billing/tasks/quote_expiry_reminder.py
--------------------------------------
Quotation expiry reminders (Quotation Settings -> Expiry Reminder Days).

For every organisation that set Expiry Reminder Days = N, each SENT quote whose
valid_until falls within the next N days (today included) gets ONE reminder
email to its customer. ``expiry_reminder_sent_at`` records the send, so a quote
is never reminded twice and a missed day is caught up on the next run.
Organisations without the setting are untouched. Failures are isolated per quote.
"""

import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Dict

from app.database import SessionLocal
from app.modules.billing.models import BillingConfiguration, Quotation, QuoteStatus

logger = logging.getLogger("zoiko_billing")


def run_quote_expiry_reminder_job() -> Dict[str, Any]:
    start = time.monotonic()
    summary = {"organisations": 0, "found": 0, "sent": 0, "failed": 0, "errors": []}
    db = SessionLocal()
    try:
        for config in db.query(BillingConfiguration).all():
            days = (config.quotation_extra_settings or {}).get("expiry_reminder_days")
            if not isinstance(days, int) or days < 1:
                continue
            summary["organisations"] += 1
            _remind_org(db, config.organization_id, days, summary)
    except Exception as exc:  # noqa: BLE001 - scheduler wrapper reports failures
        logger.error("[SCHEDULER] Quote expiry reminder job failed: %s", exc, exc_info=True)
        summary["errors"].append(str(exc))
    finally:
        db.close()
    summary["duration_seconds"] = round(time.monotonic() - start, 3)
    logger.info("[SCHEDULER] Quote expiry reminders: %s", summary)
    return summary


def _remind_org(db, organization_id: int, days: int, summary: Dict[str, Any]) -> None:
    today = date.today()
    quotes = (
        db.query(Quotation)
        .filter(
            Quotation.organization_id == organization_id,
            Quotation.is_active == True,  # noqa: E712
            Quotation.status == QuoteStatus.SENT,
            Quotation.expiry_reminder_sent_at.is_(None),
            Quotation.valid_until.isnot(None),
            Quotation.valid_until >= today,
            Quotation.valid_until <= today + timedelta(days=days),
        )
        .all()
    )
    summary["found"] += len(quotes)
    for quote in quotes:
        try:
            if _send_reminder(db, quote, (quote.valid_until - today).days):
                quote.expiry_reminder_sent_at = datetime.utcnow()
                db.commit()
                summary["sent"] += 1
            else:
                db.rollback()
                summary["failed"] += 1
        except Exception as exc:  # noqa: BLE001 - isolate per-quote failures
            db.rollback()
            summary["failed"] += 1
            summary["errors"].append(f"quote {quote.id}: {exc}")
            logger.warning("Expiry reminder failed for quote %s: %s", quote.id, exc)


def _send_reminder(db, quote: Quotation, days_left: int) -> bool:
    from app.config import settings
    from app.modules.billing.services.customer_service import CustomerService
    from app.modules.billing.services.quote_service import QuoteService
    from app.services.email_service import send_quote_email

    svc = QuoteService(db)
    customer = CustomerService(db).get_customer(quote.customer_id, quote.organization_id)
    email = (customer.email or "").strip() if customer else ""
    if not email or "@" not in email:
        return False
    currency = quote.currency or "USD"
    when = "today" if days_left == 0 else ("tomorrow" if days_left == 1 else f"in {days_left} days")
    fmt = lambda d: d.strftime("%d %b %Y").lstrip("0") if d else "N/A"  # noqa: E731
    money = lambda v: f"{(v or 0):,.2f}"  # noqa: E731
    return bool(send_quote_email(
        email=email,
        customer_name=customer.display_name or customer.company_name,
        recipient_first_name=customer.first_name or "",
        quote_number=quote.quote_number,
        issue_date=fmt(quote.created_at.date()) if quote.created_at else "N/A",
        valid_until=fmt(quote.valid_until),
        total_amount=money(quote.total_amount),
        currency=currency,
        status=f"Expires {when}",
        notes=quote.notes or "",
        review_url=f"{settings.FRONTEND_URL.rstrip('/')}/estimate/{svc._public_quote_token(quote.id)}",
        organization_id=quote.organization_id,
        db=db,
        subject_prefix="Reminder: ",
    ))
