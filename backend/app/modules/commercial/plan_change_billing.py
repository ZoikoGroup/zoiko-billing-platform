"""modules/commercial/plan_change_billing.py
------------------------------------------------
Pay-to-upgrade for the tenant self-service plan change.

An upgrade no longer swaps the plan the moment the org clicks the button.
Instead:
  1. a PLAN_CHANGE PlatformInvoice is raised for the prorated price difference
     for the rest of the current period (create_upgrade_invoice),
  2. a SubscriptionChange row is parked in PENDING (never "at rest" before this
     feature — see SubscriptionChangeStatus) and linked to that invoice through
     correlation_id = "inv:<invoice id>" (no schema change needed),
  3. the org pays the invoice (Stripe Checkout, or manual allocation by Super
     Admin), and
  4. the payment path calls complete_plan_change_for_invoice(), which performs
     the real plan swap and marks the change APPLIED.

The entitlements therefore never race ahead of the money (same §B4 principle
the first-payment subscription activation already follows).
"""

import logging
import secrets
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import NamedTuple, Optional

from sqlalchemy.orm import Session

from app.modules.commercial.enums import (
    CommercialSubscriptionStatus,
    PlatformInvoiceStatus,
    PlatformInvoiceType,
    SubscriptionChangeStatus,
)
from app.modules.commercial.models import (
    PlatformInvoice,
    SubscriptionChange,
)

logger = logging.getLogger("zoiko_billing.commercial.plan_change_billing")

_PAYABLE_STATUSES = (
    PlatformInvoiceStatus.ISSUED,
    PlatformInvoiceStatus.DELIVERED,
    PlatformInvoiceStatus.DUE,
    PlatformInvoiceStatus.PARTIALLY_PAID,
    PlatformInvoiceStatus.OVERDUE,
)


class PlanChangeApplied(NamedTuple):
    change_id: int
    # Set when the payment also converted a free trial to paid, so the caller
    # can send the trial-converted confirmation after it commits.
    trial_converted_subscription_id: Optional[int] = None


def correlation_for_invoice(invoice_id: int) -> str:
    return f"inv:{invoice_id}"


def get_pending_upgrade(db: Session, subscription_id: int) -> Optional[SubscriptionChange]:
    return (
        db.query(SubscriptionChange)
        .filter(
            SubscriptionChange.commercial_subscription_id == subscription_id,
            SubscriptionChange.status == SubscriptionChangeStatus.PENDING,
        )
        .order_by(SubscriptionChange.id.desc())
        .first()
    )


def invoice_for_change(db: Session, change: SubscriptionChange) -> Optional[PlatformInvoice]:
    corr = change.correlation_id or ""
    if not corr.startswith("inv:"):
        return None
    try:
        invoice_id = int(corr[4:])
    except ValueError:
        return None
    return db.query(PlatformInvoice).filter(PlatformInvoice.id == invoice_id).first()


def create_upgrade_invoice(
    db: Session,
    *,
    account,
    subscription,
    target_plan,
    amount: Decimal,
    currency: str,
    days_remaining: Optional[int],
    actor_id: int,
    description: Optional[str] = None,
) -> PlatformInvoice:
    """Raise an ISSUED PLAN_CHANGE invoice: the prorated difference for an
    upgrade, or (with `description`) the first period of a plan bought outright
    from a free trial."""
    from app.modules.commercial.platform_invoice_service import PlatformInvoiceService

    amount = Decimal(amount).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if amount <= 0:
        raise ValueError("Upgrade invoice amount must be positive.")

    svc = PlatformInvoiceService(db)
    invoice = svc.create_draft(
        account_id=account.id,
        actor_id=actor_id,
        invoice_type=PlatformInvoiceType.PLAN_CHANGE,
        subscription_id=subscription.id,
        currency=(currency or "USD"),
        notes=f"Upgrade to {target_plan.plan_name}",
    )
    svc.add_item(
        invoice_id=invoice.id,
        actor_id=actor_id,
        line_number=1,
        description=description or (
            f"Upgrade to {target_plan.plan_name} — prorated difference for the "
            f"remaining {days_remaining} day{'s' if days_remaining != 1 else ''} of the current period"
        ),
        quantity=Decimal("1"),
        unit_price=amount,
    )
    invoice = svc.finalize(invoice_id=invoice.id, actor_id=actor_id)
    if invoice.public_token is None:
        invoice.public_token = secrets.token_urlsafe(32)
    db.flush()
    return invoice


def abandon_pending_upgrade(db: Session, change: SubscriptionChange, *, actor_id: Optional[int], reason: str) -> None:
    """Cancel an unpaid upgrade: void its invoice (if still unpaid) and mark the
    change REVERSED. Never touches a change whose invoice already has money on
    it — those must be completed or refunded deliberately."""
    from app.modules.commercial.platform_invoice_service import PlatformInvoiceService

    if change.status != SubscriptionChangeStatus.PENDING:
        raise ValueError(f"SubscriptionChange {change.id} is {change.status.name}, not PENDING.")

    invoice = invoice_for_change(db, change)
    if invoice is not None:
        if invoice.paid_amount and invoice.paid_amount > 0:
            raise ValueError("This upgrade invoice already has a payment against it and cannot be cancelled.")
        if invoice.status in _PAYABLE_STATUSES:
            PlatformInvoiceService(db).void(invoice_id=invoice.id, actor_id=actor_id or 0, reason=reason)

    change.status = SubscriptionChangeStatus.REVERSED
    change.reversed_at = datetime.utcnow()
    change.reversed_by_user_id = actor_id
    db.flush()


def complete_plan_change_for_invoice(
    db: Session, invoice: PlatformInvoice, *, actor_id: Optional[int] = None,
) -> Optional[PlanChangeApplied]:
    """If `invoice` is a fully-paid PLAN_CHANGE invoice with a PENDING change
    behind it, perform the plan swap in the caller's transaction. A trialing
    subscription is converted to paid first, then moved to the purchased plan.
    Returns a PlanChangeApplied, else None. Idempotent: a change that is no
    longer PENDING is skipped, so a replayed webhook never double-applies."""
    if invoice is None or invoice.invoice_type != PlatformInvoiceType.PLAN_CHANGE:
        return None
    if invoice.balance_due is not None and invoice.balance_due > 0:
        return None

    change = (
        db.query(SubscriptionChange)
        .filter(
            SubscriptionChange.correlation_id == correlation_for_invoice(invoice.id),
            SubscriptionChange.status == SubscriptionChangeStatus.PENDING,
        )
        .first()
    )
    if change is None:
        return None

    from app.modules.commercial.service import CommercialSubscriptionService

    subscription = change.subscription
    target_plan = change.to_plan
    actor = actor_id or change.requested_by_user_id
    converted_from_trial = None

    if subscription is not None and subscription.status in (
        CommercialSubscriptionStatus.TRIALING,
        CommercialSubscriptionStatus.TRIAL_RECOVERY,
    ):
        from app.modules.commercial.trial_conversion_service import TrialConversionService

        TrialConversionService(db).complete_trial_conversion(subscription=subscription, actor_id=actor)
        converted_from_trial = subscription.id

    if subscription is None or subscription.status != CommercialSubscriptionStatus.ACTIVE:
        _flag_unapplied(db, change, "the subscription is no longer ACTIVE")
        return None

    if subscription.commercial_plan_id != target_plan.id:
        try:
            CommercialSubscriptionService(db).apply_plan_change(
                subscription, target_plan,
                actor_id=actor,
                reason=change.reason or "Plan purchased",
            )
        except ValueError as exc:
            # Money is in but the swap was refused (e.g. target plan retired in
            # the meantime). Never raise out of a webhook for this — Stripe would
            # retry forever — surface it for a human instead.
            _flag_unapplied(db, change, str(exc))
            return None

    change.status = SubscriptionChangeStatus.APPLIED
    change.applied_at = datetime.utcnow()
    db.flush()
    return PlanChangeApplied(change.id, converted_from_trial)


def _flag_unapplied(db: Session, change: SubscriptionChange, why: str) -> None:
    logger.error(
        "Paid upgrade could not be applied: SubscriptionChange %s (invoice %s): %s",
        change.id, change.correlation_id, why,
    )
    try:
        from app.modules.super_admin.attention_service import AttentionService
        from app.modules.super_admin.models import AttentionSeverity

        AttentionService(db).report_or_update(
            source="plan_change",
            source_key=f"plan_change:{change.id}:paid_not_applied",
            title="Paid plan upgrade was not applied",
            description=(
                f"SubscriptionChange {change.id} was paid ({change.correlation_id}) but could not be "
                f"applied: {why}. Apply it manually or refund the invoice."
            ),
            organization_id=change.subscription.account.organization_id if change.subscription and change.subscription.account else None,
            base_severity=AttentionSeverity.P1,
        )
    except Exception:  # noqa: BLE001 - never let alerting break the payment path
        logger.warning("Could not raise attention item for SubscriptionChange %s", change.id, exc_info=True)
