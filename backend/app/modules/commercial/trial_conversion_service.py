"""
modules/commercial/trial_conversion_service.py
--------------------------------------------------
ZB-COM §5.2 — self-serve trial->paid conversion orchestration.

Covers the mandated 9-step sequence end-to-end:

  prepare_trial_conversion() — builds the commercial artifacts and picks a
  payment route:
    1. resolve the caller's TRIALING / TRIAL_RECOVERY subscription
    2. compatibility checklist (informational — surfaced to the caller)
    3. quote + first-billing-cycle line item (never invents pricing: uses
       CommercialSubscriptionService.resolve_price; when no real price
       resolves, falls back to the assisted path)
    4. optimize to Stripe Checkout when the platform Stripe is configured,
       otherwise 5. withhold a manual-invoice path (the invoice link is
       returned; a Super Admin records/allocs the payment later)
    enterprise / quote-only / unresolvable pricing -> assisted_quote: a SENT
    quote for the org admin replaces self-serve charging.

  complete_trial_conversion() — the atomic commit side (steps 6-9):
    - transitions the subscription via the genuine CONVERTED marker then
      ACTIVE (one transaction; CONVERTED is never observable outside it),
    - stamps converted_at (real usage counters are never reset),
    - recomputes the entitlement snapshot inside the caller's transaction,
    - audits SUBSCRIPTION_TRIAL_CONVERTED.

  Invoked from platform_stripe_service._handle_checkout_completed (first
  cleared payment) and commercial_billing_router.allocate_payment (manual
  invoicing path). ZB-COM-015 (send_trial_converted_email) is dispatched by
  the CALLER after committing, so no confirmation email can precede a
  durable conversion. Payment failure leaves the subscription untouched.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException
from app.modules.commercial.enums import CommercialPlanStatus, CommercialSubscriptionStatus

logger = logging.getLogger("zoiko_billing.commercial.trial_conversion")


class TrialConversionService:
    """Orchestrates the trial->paid conversion sequence (ZB-COM §5.2).

    Never commits on its own — every mutation is flushed into the caller's
    transaction; the caller decides when to commit, same convention as every
    other service in this module.
    """

    def __init__(self, db: Session):
        self.db = db

    # ── Resolution ──────────────────────────────────────────────────────────

    def resolve_org_subscription(self, *, organization_id: int):
        """The caller's own account + currently open subscription, when that
        subscription is still in a convertible trial state."""
        from app.modules.commercial.models import CommercialAccount
        from app.modules.commercial.service import CommercialSubscriptionService

        account = (
            self.db.query(CommercialAccount)
            .filter(CommercialAccount.organization_id == organization_id)
            .first()
        )
        if account is None:
            return None, None

        subscription = CommercialSubscriptionService(self.db).get_active_subscription(account.id)
        if subscription is None or subscription.status not in (
            CommercialSubscriptionStatus.TRIALING,
            CommercialSubscriptionStatus.TRIAL_RECOVERY,
        ):
            return account, None
        return account, subscription

    # ── Step 1-5: prepare (quote -> invoice -> payment route) ───────────────

    def prepare_trial_conversion(
        self, *, account, subscription, actor_id: int,
    ) -> dict:
        """Resolve the payment route and build the conversion artifacts.

        Returns a route descriptor (never commits):
          {"mode": "checkout", ...}      — Stripe Checkout session ready
          {"mode": "invoice_due", ...}   — platform Stripe not configured;
                                           org pays the invoice manually
          {"mode": "assisted_quote", ...}— enterprise / quote-only / no
                                           resolvable price: quote sent to
                                           the org admin instead
        """
        from app.modules.commercial.service import CommercialSubscriptionService

        svc = CommercialSubscriptionService(self.db)
        plan = subscription.plan
        price = svc.resolve_price(subscription)

        assisted_needed = (
            plan is None
            or plan.status != CommercialPlanStatus.ACTIVE
            or plan.is_quote_only
            or price is None
        )
        if assisted_needed:
            return self._prepare_assisted(
                account=account, subscription=subscription, plan=plan, actor_id=actor_id,
            )
        return self._prepare_paid(
            account=account,
            subscription=subscription,
            plan=plan,
            price=price,
            actor_id=actor_id,
        )

    def _prepare_paid(self, *, account, subscription, plan, price, actor_id: int) -> dict:
        from decimal import Decimal

        from app.modules.commercial.platform_invoice_service import PlatformInvoiceService
        from app.modules.commercial.platform_stripe_service import PlatformStripeService
        from app.modules.commercial.quote_service import CommercialQuoteService

        price_amount, currency, interval = price
        plan_name = plan.plan_name or plan.plan_code
        interval_label = getattr(interval, "value", None) or str(interval)

        quote_svc = CommercialQuoteService(self.db)
        quote = quote_svc.create_quote(
            account_id=account.id,
            actor_id=actor_id,
            subscription_id=subscription.id,
            subject=f"Trial conversion — {plan_name}",
            currency=(currency or "USD"),
        )
        quote_svc.add_item(
            quote_id=quote.id,
            actor_id=actor_id,
            line_number=1,
            description=f"{plan_name} ({interval_label}) — trial conversion",
            quantity=Decimal("1"),
            unit_price=price_amount,
        )

        invoice_svc = PlatformInvoiceService(self.db)
        invoice = quote_svc.convert_to_invoice(
            quote_id=quote.id, actor_id=actor_id, allow_draft=True,
        )
        invoice = invoice_svc.finalize(invoice_id=invoice.id, actor_id=actor_id)
        if invoice.public_token is None:
            invoice.public_token = secrets.token_urlsafe(32)
        self.db.flush()

        base = {
            "subscription_id": subscription.id,
            "plan_name": plan_name,
            "price_amount": str(price_amount),
            "currency": currency or "USD",
            "billing_interval": interval_label,
            "invoice_number": invoice.invoice_number,
        }
        try:
            checkout = PlatformStripeService(self.db).create_checkout_session_for_invoice(invoice)
        except BadRequestException:
            # Platform Stripe not configured / not payable — the invoice is
            # due for manual payment (Super Admin records/allocs it).
            return {
                "mode": "invoice_due",
                **base,
                "invoice_url": self._invoice_link(invoice),
                "public_token": invoice.public_token,
            }
        return {
            "mode": "checkout",
            **base,
            "checkout_url": checkout.get("checkout_url"),
            "session_id": checkout.get("session_id"),
        }

    def _prepare_assisted(self, *, account, subscription, plan, actor_id: int) -> dict:
        from app.config import settings as _settings
        from app.modules.commercial.quote_service import CommercialQuoteService

        plan_name = plan.plan_name if plan else "a paid plan"
        quote_svc = CommercialQuoteService(self.db)
        quote = quote_svc.create_quote(
            account_id=account.id,
            actor_id=actor_id,
            subscription_id=subscription.id,
            subject=f"Paid plan pricing — {plan_name}",
            currency=(plan.currency if plan else "USD"),
        )
        quote = quote_svc.send_quote(quote_id=quote.id, actor_id=actor_id)
        return {
            "mode": "assisted_quote",
            "subscription_id": subscription.id,
            "plan_name": plan_name,
            "quote_number": quote.quote_number,
            "quote_url": f"{_settings.FRONTEND_URL.rstrip('/')}/platform-quote/{quote.public_token}",
        }

    @staticmethod
    def _invoice_link(invoice) -> str:
        from app.config import settings as _settings
        return f"{_settings.FRONTEND_URL.rstrip('/')}/platform-invoice/{invoice.public_token}"

    # ── Steps 6-9: complete the conversion (state + snapshot + audit) ───────

    def complete_trial_conversion(
        self, *, subscription, actor_id: Optional[int] = None,
    ):
        """Move a trial subscription to ACTIVE via the genuine CONVERTED
        marker, stamp converted_at, recompute the snapshot, and audit.

        Idempotent for an already-converted ACTIVE subscription. Raises for
        any state that is not part of a trial conversion (payment failures
        leave the subscription untouched — the caller never reaches this
        when a payment is not cleared). Caller owns the commit.
        """
        from app.modules.commercial.service import CommercialSubscriptionService
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        previous = subscription.status
        svc = CommercialSubscriptionService(self.db)

        if previous in (
            CommercialSubscriptionStatus.TRIALING,
            CommercialSubscriptionStatus.TRIAL_RECOVERY,
        ):
            svc.transition(subscription, CommercialSubscriptionStatus.CONVERTED)
            svc.transition(subscription, CommercialSubscriptionStatus.ACTIVE)
            subscription.converted_at = datetime.utcnow()
            reason = "trial_converted"
        elif previous == CommercialSubscriptionStatus.CONVERTED:
            # Interrupted commit recovery: re-drive the second half only.
            svc.transition(subscription, CommercialSubscriptionStatus.ACTIVE)
            subscription.converted_at = datetime.utcnow()
            reason = "trial_converted_redriven"
        elif previous == CommercialSubscriptionStatus.ACTIVE and subscription.converted_at is not None:
            return subscription
        else:
            raise ValueError(
                f"Cannot convert a {previous.value} subscription to a paid plan"
            )

        organization_id = subscription.account.organization_id if subscription.account else None
        PlatformAuditService(self.db).log_no_commit(
            actor_id=actor_id,
            action=PlatformAuditAction.SUBSCRIPTION_TRIAL_CONVERTED,
            entity_type="commercial_subscription",
            entity_id=subscription.id,
            organization_id=organization_id,
            new_values={
                "status": CommercialSubscriptionStatus.ACTIVE.value,
                "converted_at": subscription.converted_at.isoformat(),
                "period_start": (
                    subscription.current_period_start.isoformat()
                    if subscription.current_period_start else None
                ),
                "period_end": (
                    subscription.current_period_end.isoformat()
                    if subscription.current_period_end else None
                ),
            },
            reason=reason,
        )
        self.db.flush()
        return subscription


def notify_trial_converted_after_commit(db: Session, subscription) -> None:
    """ZB-COM-015 — confirmation email for a just-committed conversion.

    Call AFTER the caller's commit. Resolves the org admin + plan once more
    (the subscription entity may be freshly attached) and dispatches the
    email; a failure to email never disturbs the already-durable conversion.
    """
    try:
        from app.modules.auth.models import User
        from app.services.email_service import send_trial_converted_email

        account = subscription.account
        if account is None:
            return
        org = None
        from app.modules.organizations.models import Organization
        org = db.query(Organization).filter(Organization.id == account.organization_id).first()
        plan = subscription.plan
        admin = (
            db.query(User)
            .filter(
                User.organization_id == account.organization_id,
                User.role == "org_admin",
            )
            .order_by(User.id.asc())
            .first()
        )
        send_trial_converted_email(
            email=(admin.email if admin else None),
            recipient_first_name=(admin.first_name if admin else None),
            organization_name=(org.organization_name if org else "your organization"),
            plan_name=(plan.plan_name if plan else None),
            organization_id=account.organization_id,
            db=db,
        )
    except Exception:  # noqa: BLE001 — email must not break a committed conversion
        logger.exception("Failed to dispatch ZB-COM-015 trial-converted email")