"""
commercial/tasks/renewal_reminder.py
---------------------------------------
Plane 1 — ZB-COM-016: renewal reminder notification + automatic Stripe charge.

Two responsibilities run as one daily job:

  1. RENEWAL REMINDER EMAIL (7 days ahead)
     For every ACTIVE CommercialSubscription whose current_period_end falls
     within the next RENEWAL_REMINDER_DAYS_AHEAD days (default 7), send the
     org admin a ZB-COM-016 renewal_reminder email that shows:
       • plan name and billing interval (Monthly / Annual)
       • exact amount and currency
       • renewal date
       • card last-4 if the org has a Stripe customer with a default payment method

  2. AUTOMATIC STRIPE CHARGE (on/after period end)
     For every ACTIVE subscription whose current_period_end <= now AND that
     already has a paid-in-full renewal invoice for the upcoming period, skip
     (the recurring_invoice job handles new invoices). When the renewal invoice
     exists and is FINALIZED (balance_due > 0) AND the account has a saved
     Stripe customer with a default payment method, create a Stripe
     PaymentIntent off-session and record the result — clearing the invoice on
     success or marking the payment FAILED on failure.

     This mirrors how Stripe Billing subscriptions work: Zoiko owns the charge
     loop rather than relying on the customer to click a checkout link every
     month.

No-ops unless settings.ENABLE_COMMERCIAL_RENEWAL_REMINDER is True.
"""

import logging
import time
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict

from app.database import SessionLocal

logger = logging.getLogger("zoiko_billing.commercial.renewal_reminder")

RENEWAL_REMINDER_DAYS_AHEAD = 7  # send reminder this many days before renewal


# ── helpers ───────────────────────────────────────────────────────────────────

def _to_cents(amount) -> int:
    value = Decimal(str(amount))
    return int((value * Decimal("100")).to_integral_value(rounding=ROUND_HALF_UP))


def _interval_label(billing_interval) -> str:
    if billing_interval is None:
        return "Monthly"
    val = billing_interval.value if hasattr(billing_interval, "value") else str(billing_interval)
    return "Annual" if val == "annual" else "Monthly"


def _get_stripe_customer_default_pm(stripe_customer_id: str):
    """Return (payment_method_id, last4) for the Stripe customer's default
    payment method, or (None, None) when unavailable."""
    from app.config import settings
    if not settings.PLATFORM_STRIPE_SECRET_KEY:
        return None, None
    try:
        import stripe
        stripe.api_key = settings.PLATFORM_STRIPE_SECRET_KEY
        customer = stripe.Customer.retrieve(
            stripe_customer_id,
            expand=["invoice_settings.default_payment_method"],
        )
        pm = (customer.get("invoice_settings") or {}).get("default_payment_method")
        if pm and isinstance(pm, dict):
            last4 = (pm.get("card") or {}).get("last4")
            return pm.get("id"), last4
        return None, None
    except Exception as exc:
        logger.debug("Could not retrieve Stripe default PM for %s: %s", stripe_customer_id, exc)
        return None, None


def _charge_stripe_off_session(
    customer_id: str,
    payment_method_id: str,
    amount_cents: int,
    currency: str,
    description: str,
    metadata: dict,
) -> dict:
    """Create an off-session PaymentIntent and confirm it immediately.
    Returns the PaymentIntent dict on success, raises on failure."""
    from app.config import settings
    import stripe
    stripe.api_key = settings.PLATFORM_STRIPE_SECRET_KEY
    pi = stripe.PaymentIntent.create(
        amount=amount_cents,
        currency=currency.lower(),
        customer=customer_id,
        payment_method=payment_method_id,
        off_session=True,
        confirm=True,
        description=description,
        metadata=metadata,
    )
    return pi


# ── main job ──────────────────────────────────────────────────────────────────

def run_commercial_renewal_reminder_job() -> Dict[str, Any]:
    """Entry point called by APScheduler. Returns a summary dict."""
    from app.config import settings

    start_time = time.monotonic()
    now = datetime.now(timezone.utc).replace(tzinfo=None)  # naive UTC, consistent with DB

    summary: Dict[str, Any] = {
        "started_at": now.isoformat(),
        "reminders_sent": 0,
        "charges_attempted": 0,
        "charges_succeeded": 0,
        "charges_failed": 0,
        "errors": [],
    }

    if not getattr(settings, "ENABLE_COMMERCIAL_RENEWAL_REMINDER", False):
        summary["skipped"] = "ENABLE_COMMERCIAL_RENEWAL_REMINDER is false"
        return summary

    logger.info("[SCHEDULER] Commercial renewal reminder + auto-charge job started")

    db = SessionLocal()
    try:
        from app.modules.auth.models import User
        from app.modules.commercial.enums import (
            CommercialSubscriptionStatus,
            PlatformInvoiceStatus,
            PlatformPaymentStatus,
        )
        from app.modules.commercial.models import (
            CommercialAccount,
            CommercialSubscription,
            PlatformInvoice,
            PlatformPayment,
        )
        from app.modules.commercial.platform_payment_service import PlatformPaymentService
        from app.modules.commercial.service import CommercialSubscriptionService
        from app.modules.organizations.models import Organization

        # ── 1. Renewal reminder emails ────────────────────────────────────
        window_start = now
        window_end = now + timedelta(days=RENEWAL_REMINDER_DAYS_AHEAD)

        upcoming = (
            db.query(CommercialSubscription)
            .filter(
                CommercialSubscription.status == CommercialSubscriptionStatus.ACTIVE,
                CommercialSubscription.current_period_end.isnot(None),
                CommercialSubscription.current_period_end > window_start,
                CommercialSubscription.current_period_end <= window_end,
            )
            .all()
        )

        for sub in upcoming:
            try:
                account = db.query(CommercialAccount).filter(
                    CommercialAccount.id == sub.commercial_account_id
                ).first()
                if account is None:
                    continue

                org = db.query(Organization).filter(
                    Organization.id == account.organization_id
                ).first()
                admin = (
                    db.query(User)
                    .filter(
                        User.organization_id == account.organization_id,
                        User.role == "org_admin",
                    )
                    .order_by(User.id.asc())
                    .first()
                )
                if admin is None:
                    continue

                priced = CommercialSubscriptionService(db).resolve_price(sub)
                if priced is None:
                    continue
                price_amount, currency, interval = priced

                # Lookup card last-4 from Stripe customer if available
                last4 = None
                if account.stripe_customer_id:
                    _, last4 = _get_stripe_customer_default_pm(account.stripe_customer_id)

                from app.config import settings as _s
                billing_url = f"{_s.FRONTEND_URL.rstrip('/')}/billing"
                renewal_date_str = sub.current_period_end.strftime("%B %d, %Y")
                days_left = max(1, (sub.current_period_end - now).days)

                from app.services.email_service import send_renewal_reminder_email
                send_renewal_reminder_email(
                    email=admin.email,
                    customer_name=admin.first_name or admin.name or "there",
                    organization_name=org.organization_name if org else "your organization",
                    plan_name=sub.plan.plan_name if sub.plan else "Subscription",
                    billing_interval=_interval_label(interval),
                    renewal_date=renewal_date_str,
                    amount=f"{price_amount:,.2f}",
                    currency=currency or "USD",
                    days_until_renewal=days_left,
                    payment_method_last4=last4,
                    billing_url=billing_url,
                    organization_id=account.organization_id,
                    db=db,
                )
                summary["reminders_sent"] += 1
                logger.info(
                    "Renewal reminder sent for subscription %s (period_end=%s, admin=%s)",
                    sub.id, sub.current_period_end, admin.email,
                )
            except Exception as row_exc:
                summary["errors"].append(f"reminder sub {sub.id}: {row_exc}")
                logger.error(
                    "Failed to send renewal reminder for subscription %s: %s",
                    sub.id, row_exc, exc_info=True,
                )

        # ── 2. Automatic Stripe charges for due renewal invoices ──────────
        # Find subscriptions whose period_end has passed and have an unpaid
        # FINALIZED renewal invoice that hasn't been cleared yet.
        overdue_subs = (
            db.query(CommercialSubscription)
            .filter(
                CommercialSubscription.status == CommercialSubscriptionStatus.ACTIVE,
                CommercialSubscription.current_period_end.isnot(None),
                CommercialSubscription.current_period_end <= now,
            )
            .all()
        )

        for sub in overdue_subs:
            try:
                account = db.query(CommercialAccount).filter(
                    CommercialAccount.id == sub.commercial_account_id
                ).first()
                if account is None or not account.stripe_customer_id:
                    continue

                # Find the open renewal invoice for this period
                renewal_invoice = (
                    db.query(PlatformInvoice)
                    .filter(
                        PlatformInvoice.commercial_account_id == sub.commercial_account_id,
                        PlatformInvoice.commercial_subscription_id == sub.id,
                        PlatformInvoice.invoice_type == "subscription_renewal",
                        PlatformInvoice.status == PlatformInvoiceStatus.SENT,
                        PlatformInvoice.balance_due > 0,
                    )
                    .order_by(PlatformInvoice.id.desc())
                    .first()
                )
                if renewal_invoice is None:
                    continue

                pm_id, last4 = _get_stripe_customer_default_pm(account.stripe_customer_id)
                if pm_id is None:
                    logger.info(
                        "No default payment method for account %s — skipping auto-charge for invoice %s",
                        account.id, renewal_invoice.id,
                    )
                    continue

                amount_cents = _to_cents(renewal_invoice.balance_due)
                currency_code = (renewal_invoice.currency or "USD").lower()
                plan_name = sub.plan.plan_name if sub.plan else "Subscription"

                summary["charges_attempted"] += 1
                try:
                    pi = _charge_stripe_off_session(
                        customer_id=account.stripe_customer_id,
                        payment_method_id=pm_id,
                        amount_cents=amount_cents,
                        currency=currency_code,
                        description=f"Renewal — {plan_name} (invoice {renewal_invoice.invoice_number})",
                        metadata={
                            "platform_invoice_id": str(renewal_invoice.id),
                            "commercial_account_id": str(account.id),
                            "subscription_id": str(sub.id),
                        },
                    )

                    if pi.get("status") == "succeeded":
                        # Record and allocate the cleared payment
                        payment = PlatformPaymentService(db).record(
                            account_id=account.id,
                            actor_id=None,
                            amount=renewal_invoice.balance_due,
                            currency=renewal_invoice.currency or "USD",
                            payment_method="card",
                            notes=f"Auto-charge for renewal invoice {renewal_invoice.invoice_number}",
                        )
                        payment.status = PlatformPaymentStatus.CLEARED
                        payment.cleared_at = datetime.utcnow()
                        payment.gateway_payment_intent_id = pi.get("id")
                        payment.transaction_id = pi.get("id")
                        db.flush()

                        PlatformPaymentService(db).allocate(
                            payment_id=payment.id,
                            invoice_id=renewal_invoice.id,
                            amount=renewal_invoice.balance_due,
                            actor_id=None,
                        )

                        # Advance the billing period for the next cycle
                        priced = CommercialSubscriptionService(db).resolve_price(sub)
                        if priced:
                            CommercialSubscriptionService(db).advance_billing_period(sub, priced[2])

                        db.commit()
                        summary["charges_succeeded"] += 1

                        # Send renewal confirmation email post-commit
                        _dispatch_renewal_confirmed_email(db, sub, renewal_invoice, account)

                        logger.info(
                            "Auto-charge succeeded for subscription %s — invoice %s cleared (PI=%s)",
                            sub.id, renewal_invoice.id, pi.get("id"),
                        )
                    else:
                        summary["charges_failed"] += 1
                        logger.warning(
                            "Auto-charge for subscription %s returned status=%s (not succeeded)",
                            sub.id, pi.get("status"),
                        )

                except Exception as stripe_exc:
                    db.rollback()
                    summary["charges_failed"] += 1
                    summary["errors"].append(f"auto-charge sub {sub.id}: {stripe_exc}")
                    logger.error(
                        "Auto-charge failed for subscription %s: %s",
                        sub.id, stripe_exc, exc_info=True,
                    )

            except Exception as row_exc:
                db.rollback()
                summary["errors"].append(f"charge-loop sub {sub.id}: {row_exc}")
                logger.error(
                    "Error in auto-charge loop for subscription %s: %s",
                    sub.id, row_exc, exc_info=True,
                )

    except Exception as exc:
        db.rollback()
        logger.error("[SCHEDULER] Fatal error in renewal reminder job: %s", exc, exc_info=True)
        summary["errors"].append(str(exc))
    finally:
        db.close()

    elapsed = time.monotonic() - start_time
    summary["duration_seconds"] = round(elapsed, 3)
    logger.info(
        "[SCHEDULER] Renewal reminder job completed in %.3fs — %s",
        elapsed, summary,
    )
    return summary


def _dispatch_renewal_confirmed_email(db, subscription, invoice, account) -> None:
    """Post-commit: send ZB-SUB-005 subscription_renewed confirmation."""
    try:
        from app.modules.auth.models import User
        from app.modules.organizations.models import Organization
        from app.services.email_service import send_subscription_renewed_email

        org = db.query(Organization).filter(
            Organization.id == account.organization_id
        ).first()
        admin = (
            db.query(User)
            .filter(
                User.organization_id == account.organization_id,
                User.role == "org_admin",
            )
            .order_by(User.id.asc())
            .first()
        )
        if admin is None:
            return

        plan_name = subscription.plan.plan_name if subscription.plan else "Subscription"
        currency = invoice.currency or "USD"
        amount_str = f"{invoice.total_amount:,.2f}" if invoice.total_amount else "0.00"
        period_start = subscription.current_period_start
        period_end = subscription.current_period_end
        fmt = "%B %d, %Y"

        send_subscription_renewed_email(
            email=admin.email,
            customer_name=admin.first_name or admin.name or "there",
            subscription_number=str(subscription.id),
            plan_name=plan_name,
            term_start=period_start.strftime(fmt) if period_start else "—",
            term_end=period_end.strftime(fmt) if period_end else "—",
            amount=amount_str,
            currency=currency,
            organization_id=account.organization_id,
            db=db,
        )
    except Exception:
        logger.exception("Failed to dispatch renewal confirmation email for subscription %s", subscription.id)
