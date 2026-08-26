"""
commercial/tasks/recurring_invoice.py
---------------------------------------
Plane 1 — recurring PlatformInvoice generation on CommercialSubscription
renewal (§F1/§M5). No human in the loop: for every ACTIVE subscription whose
current_period_end has passed, generates the next PlatformInvoice
(invoice_type=SUBSCRIPTION_RENEWAL), finalizes and sends it, then advances
the subscription's billing period.

Entirely independent of billing/tasks/recurring_billing.py (Plane 2, tenant
subscription billing). No-ops unless
settings.ENABLE_COMMERCIAL_RECURRING_INVOICING is explicitly true.
"""

import logging
import time
from datetime import date, datetime, timedelta
from typing import Any, Dict

from app.database import SessionLocal

logger = logging.getLogger("zoiko_billing.commercial.recurring_invoice")

NET_DAYS = 15


def run_commercial_recurring_invoice_job() -> Dict[str, Any]:
    """Entry point called by APScheduler. Returns a summary dict for
    observability."""
    from app.config import settings

    start_time = time.monotonic()
    summary: Dict[str, Any] = {
        "started_at": datetime.utcnow().isoformat(),
        "generated": 0,
        "skipped_no_price": 0,
        "send_failures": 0,
        "errors": [],
    }

    if not settings.ENABLE_COMMERCIAL_RECURRING_INVOICING:
        summary["skipped"] = "ENABLE_COMMERCIAL_RECURRING_INVOICING is false"
        return summary

    logger.info("[SCHEDULER] Commercial (Plane-1) recurring invoice generation started")

    db = SessionLocal()
    try:
        from app.modules.commercial.enums import CommercialSubscriptionStatus
        from app.modules.commercial.models import CommercialSubscription
        from app.modules.commercial.platform_invoice_service import PlatformInvoiceService
        from app.modules.commercial.service import CommercialSubscriptionService

        sub_svc = CommercialSubscriptionService(db)
        inv_svc = PlatformInvoiceService(db)

        due = (
            db.query(CommercialSubscription)
            .filter(
                CommercialSubscription.status == CommercialSubscriptionStatus.ACTIVE,
                CommercialSubscription.current_period_end.isnot(None),
                CommercialSubscription.current_period_end <= datetime.utcnow(),
            )
            .all()
        )

        for subscription in due:
            try:
                priced = sub_svc.resolve_price(subscription)
                if priced is None:
                    summary["skipped_no_price"] += 1
                    logger.info(
                        "Skipping renewal for subscription %s — plan has no resolvable price.",
                        subscription.id,
                    )
                    continue
                price_amount, currency, interval = priced

                plan_name = subscription.plan.plan_name if subscription.plan else "Subscription"
                issue = date.today()
                invoice = inv_svc.create_draft(
                    account_id=subscription.commercial_account_id,
                    actor_id=None,
                    invoice_type="subscription_renewal",
                    subscription_id=subscription.id,
                    issue_date=issue,
                    due_date=issue + timedelta(days=NET_DAYS),
                    notes=f"Automatic renewal invoice for {plan_name}",
                    currency=currency or "USD",
                )
                inv_svc.add_item(
                    invoice_id=invoice.id,
                    actor_id=None,
                    line_number=1,
                    description=f"{plan_name} - subscription renewal",
                    unit_price=price_amount,
                )
                inv_svc.finalize(invoice_id=invoice.id, actor_id=None)

                try:
                    inv_svc.send(invoice_id=invoice.id, actor_id=None)
                except ValueError as send_exc:
                    # Financial record stands even if delivery fails — the
                    # send() call already recorded the failed delivery
                    # attempt (§E5) before raising.
                    summary["send_failures"] += 1
                    logger.warning(
                        "Renewal invoice %s created but send failed: %s",
                        invoice.id, send_exc,
                    )

                sub_svc.advance_billing_period(subscription, interval)
                db.commit()
                summary["generated"] += 1
            except Exception as row_exc:  # noqa: BLE001 - one subscription's failure must not block the rest
                db.rollback()
                summary["errors"].append(f"subscription {subscription.id}: {row_exc}")
                logger.error(
                    "Failed to generate renewal invoice for subscription %s: %s",
                    subscription.id, row_exc, exc_info=True,
                )
    except Exception as exc:
        db.rollback()
        logger.error("[SCHEDULER] Fatal error in commercial recurring invoice job: %s", exc, exc_info=True)
        summary["errors"].append(str(exc))
    finally:
        db.close()

    elapsed = time.monotonic() - start_time
    summary["duration_seconds"] = round(elapsed, 3)
    logger.info(
        "[SCHEDULER] Commercial recurring invoice generation completed in %.3fs — %s",
        elapsed, summary,
    )
    return summary
