"""
backend/app/modules/billing/tasks/invoice_reminder.py
-------------------------------------------------------
Scheduled job for ZB-INV-011: Pre-due invoice reminder.

Queries open invoices whose due date is exactly N days away
(where N = settings.INVOICE_REMINDER_LEAD_DAYS) and dispatches
a pre-due reminder email.
"""

import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Dict

from app.config import settings
from app.database import SessionLocal
from app.modules.billing.models import Invoice, InvoiceStatus
from app.services.email_service import send_invoice_reminder_email

logger = logging.getLogger("zoiko_billing")


def run_invoice_reminder_job() -> Dict[str, Any]:
    """Entry point called by APScheduler for ZB-INV-011 pre-due reminders.

    Queries invoices due in settings.INVOICE_REMINDER_LEAD_DAYS days.
    """
    start_time = time.monotonic()
    logger.info("[SCHEDULER] Invoice pre-due reminder job started")

    summary = {
        "started_at": datetime.utcnow().isoformat(),
        "invoices_checked": 0,
        "reminders_sent": 0,
        "errors": [],
    }

    if not settings.ENABLE_INVOICE_PRE_DUE_REMINDER:
        logger.info("[SCHEDULER] Invoice pre-due reminders are disabled in settings")
        summary["duration_seconds"] = round(time.monotonic() - start_time, 3)
        return summary

    db = SessionLocal()
    try:
        lead_days = settings.INVOICE_REMINDER_LEAD_DAYS
        target_due_date = datetime.utcnow().date() + timedelta(days=lead_days)

        invoices = (
            db.query(Invoice)
            .filter(
                Invoice.due_date == target_due_date,
                Invoice.status.in_([InvoiceStatus.SENT, InvoiceStatus.PARTIALLY_PAID]),
                Invoice.is_active == True,
                Invoice.deleted_at == None,
                Invoice.balance_due > 0,
            )
            .all()
        )

        summary["invoices_checked"] = len(invoices)

        for inv in invoices:
            try:
                recipient_email = None
                customer_name = "Valued Customer"
                if inv.customer:
                    recipient_email = getattr(inv.customer, "email", None)
                    customer_name = (
                        getattr(inv.customer, "display_name", None)
                        or getattr(inv.customer, "company_name", None)
                        or customer_name
                    )

                if not recipient_email:
                    logger.warning(
                        f"[SCHEDULER] Invoice #{inv.invoice_number} has no customer email; skipping reminder"
                    )
                    continue

                sent = send_invoice_reminder_email(
                    email=recipient_email,
                    customer_name=customer_name,
                    invoice_number=inv.invoice_number,
                    due_date=inv.due_date.isoformat() if inv.due_date else "",
                    days_until_due=lead_days,
                    balance_due=f"{inv.balance_due:.2f}",
                    currency=inv.currency or "USD",
                    organization_id=inv.organization_id,
                    db=db,
                )
                if sent:
                    inv.reminded_at = datetime.utcnow()
                    db.commit()
                    summary["reminders_sent"] += 1
            except Exception as exc:
                db.rollback()
                err_msg = f"Failed to send reminder for invoice #{inv.invoice_number}: {exc}"
                logger.exception(err_msg)
                summary["errors"].append(err_msg)

    except Exception as exc:
        err_msg = f"Error in run_invoice_reminder_job: {exc}"
        logger.exception(err_msg)
        summary["errors"].append(err_msg)
    finally:
        db.close()

    summary["duration_seconds"] = round(time.monotonic() - start_time, 3)
    logger.info(
        f"[SCHEDULER] Invoice pre-due reminder job finished. Sent {summary['reminders_sent']} reminders."
    )
    return summary
