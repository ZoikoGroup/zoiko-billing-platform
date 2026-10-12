"""modules/commercial/org_self_service_router.py
---------------------------------------------------
Plane 1 — org-facing "your Zoiko subscription" self-service endpoint.

Distinct from commercial_billing_router.py (super_admin-only, arbitrary
account_id). This endpoint is scoped ONLY to the caller's own organization —
never a client-supplied account_id — via get_current_billing_admin's
current_user.organization_id.
"""

import logging
from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_billing_admin
from app.core.exceptions import BadRequestException, NotFoundException
from app.database import get_db
from app.modules.commercial.models import (
    CommercialAccount,
    CommercialPlan,
    CommercialQuote,
    PlatformInvoice,
    PlatformPayment,
)

_logger = logging.getLogger("zoiko_billing.commercial")


def _self_service_error(exc: ValueError, action: str) -> BadRequestException:
    """The commercial service's ValueErrors are written for operators (class
    names, plan codes, billing_classification values). Tenants get a plain
    message; the detail goes to the logs."""
    _logger.warning("Self-service %s rejected: %s", action, exc)
    return BadRequestException(
        f"This {action} can't be completed right now. Please contact Zoiko support if this continues."
    )


router = APIRouter(prefix="/billing/workspace", tags=["Plane 1 Self-Service"])


def _serialize_subscription(subscription) -> dict | None:
    if subscription is None:
        return None
    plan = subscription.plan
    return {
        "id": subscription.id,
        "status": subscription.status.value,
        "plan_code": plan.plan_code if plan else None,
        "plan_name": plan.plan_name if plan else None,
        "currency": plan.currency if plan else None,
        "price_amount": str(plan.price_amount) if plan and plan.price_amount is not None else None,
        "billing_interval": plan.billing_interval.value if plan and plan.billing_interval else None,
        "max_users": plan.max_users if plan else None,
        "current_period_start": subscription.current_period_start.isoformat() if subscription.current_period_start else None,
        "current_period_end": subscription.current_period_end.isoformat() if subscription.current_period_end else None,
        "trial_ends_at": subscription.trial_ends_at.isoformat() if subscription.trial_ends_at else None,
        "recovery_ends_at": subscription.recovery_ends_at.isoformat() if subscription.recovery_ends_at else None,
        "converted_at": subscription.converted_at.isoformat() if subscription.converted_at else None,
    }


def _serialize_pending_change(db: Session, subscription) -> dict | None:
    """The one in-flight plan change for a subscription, if any: a downgrade
    SCHEDULED for renewal, or an upgrade PENDING payment of its invoice."""
    if subscription is None:
        return None
    from app.modules.commercial.enums import SubscriptionChangeStatus
    from app.modules.commercial.models import SubscriptionChange
    from app.modules.commercial.plan_change_billing import invoice_for_change

    change = (
        db.query(SubscriptionChange)
        .filter(
            SubscriptionChange.commercial_subscription_id == subscription.id,
            SubscriptionChange.status.in_([SubscriptionChangeStatus.SCHEDULED, SubscriptionChangeStatus.PENDING]),
        )
        .order_by(SubscriptionChange.id.desc())
        .first()
    )
    if change is None:
        return None
    to_plan = change.to_plan
    invoice = invoice_for_change(db, change) if change.status == SubscriptionChangeStatus.PENDING else None
    return {
        "id": change.id,
        "direction": change.direction.value,
        "status": change.status.value,
        "to_plan_id": change.to_plan_id,
        "to_plan_code": to_plan.plan_code if to_plan else None,
        "to_plan_name": to_plan.plan_name if to_plan else None,
        "effective_at": change.effective_at.isoformat() if change.effective_at else None,
        "invoice_number": invoice.invoice_number if invoice else None,
        "invoice_public_token": invoice.public_token if invoice else None,
        "amount_due": str(invoice.balance_due) if invoice else None,
        "currency": invoice.currency if invoice else None,
    }


def _serialize_invoice(invoice: PlatformInvoice) -> dict:
    return {
        "id": invoice.id,
        "invoice_number": invoice.invoice_number,
        "status": invoice.status.value,
        "currency": invoice.currency,
        "total_amount": str(invoice.total_amount),
        "balance_due": str(invoice.balance_due),
        "issue_date": invoice.issue_date.isoformat() if invoice.issue_date else None,
        "due_date": invoice.due_date.isoformat() if invoice.due_date else None,
        "public_token": invoice.public_token,
    }


def _serialize_payment(payment: PlatformPayment) -> dict:
    return {
        "id": payment.id,
        "payment_number": payment.payment_number,
        "status": payment.status.value,
        "amount": str(payment.amount),
        "currency": payment.currency,
        "payment_method": payment.payment_method.value if payment.payment_method else None,
        "created_at": payment.created_at.isoformat() if payment.created_at else None,
    }


def _serialize_quote(quote: CommercialQuote) -> dict:
    return {
        "id": quote.id,
        "quote_number": quote.quote_number,
        "status": quote.status.value,
        "total_amount": str(quote.total_amount),
        "currency": quote.currency,
        "valid_until": quote.valid_until.isoformat() if quote.valid_until else None,
        "public_token": quote.public_token,
    }


@router.get("/zoiko-subscription", summary="The caller's own organization's Zoiko Billing subscription")
def get_zoiko_subscription(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    if not current_user.organization_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This view requires an organization context.",
        )

    # Fired by the TrialBanner on every route change — cache the 5-query
    # payload. Invalidation: invalidate_subscription_caches() clears this key
    # on subscription status transitions; a short TTL bounds invoice/payment
    # staleness for a dashboard read.
    from app.config import settings as _settings
    from app.core import cache_service

    org_id = current_user.organization_id
    cache_key = "org:zoiko_sub:{org_id}".format(org_id=org_id)
    cached = cache_service.cache_get(cache_key)
    if cached is not None:
        return cached

    account = (
        db.query(CommercialAccount)
        .filter(CommercialAccount.organization_id == org_id)
        .first()
    )
    if account is None:
        result = {
            "account": None,
            "subscription": None,
            "invoices": [],
            "payments": [],
            "quotes": [],
        }
        cache_service.cache_set(cache_key, result, ttl=_settings.REDIS_DASHBOARD_TTL)
        return result

    subscription = None
    from app.modules.commercial.service import CommercialSubscriptionService

    subscription = CommercialSubscriptionService(db).get_active_subscription(account.id)

    invoices = (
        db.query(PlatformInvoice)
        .filter(PlatformInvoice.commercial_account_id == account.id)
        .order_by(PlatformInvoice.created_at.desc())
        .limit(50)
        .all()
    )
    payments = (
        db.query(PlatformPayment)
        .filter(PlatformPayment.commercial_account_id == account.id)
        .order_by(PlatformPayment.created_at.desc())
        .limit(50)
        .all()
    )
    quotes = (
        db.query(CommercialQuote)
        .filter(CommercialQuote.commercial_account_id == account.id)
        .order_by(CommercialQuote.created_at.desc())
        .limit(20)
        .all()
    )

    result = {
        "account": {"id": account.id, "status": account.status.value, "intended_plan_code": account.intended_plan_code},
        "subscription": _serialize_subscription(subscription),
        "pending_change": _serialize_pending_change(db, subscription),
        "invoices": [_serialize_invoice(i) for i in invoices],
        "payments": [_serialize_payment(p) for p in payments],
        "quotes": [_serialize_quote(q) for q in quotes],
    }
    cache_service.cache_set(cache_key, result, ttl=_settings.REDIS_DASHBOARD_TTL)
    return result


@router.get("/usage", summary="The organization's usage counters against its resolved entitlement limits")
def get_org_usage(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    """Org-scoped usage diagnostics (mirror of the Super Admin
    /super-admin/commercial-usage-counters view, scoped to the caller's own
    organization). Real UsageCounter rows only — a budget key with no row has
    simply not been exercised, never invented. The resolved limit is computed
    through the standard 7-level entitlement chain; broken resolution fails
    OPEN per §14 (an unreadable limit never breaks the usage view)."""
    from app.modules.commercial.entitlement_resolver import resolve_entitlement
    from app.modules.commercial.models import EntitlementDefinition, UsageCounter

    if not current_user.organization_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This view requires an organization context.",
        )

    account = (
        db.query(CommercialAccount)
        .filter(CommercialAccount.organization_id == current_user.organization_id)
        .first()
    )
    if account is None:
        return {
            "account": None,
            "subscription": None,
            "plan_code": None,
            "plan_name": None,
            "counters": [],
        }

    from app.modules.commercial.service import CommercialSubscriptionService

    subscription = CommercialSubscriptionService(db).get_active_subscription(account.id)

    rows = (
        db.query(UsageCounter, EntitlementDefinition)
        .join(EntitlementDefinition, EntitlementDefinition.id == UsageCounter.entitlement_definition_id)
        .filter(UsageCounter.organization_id == current_user.organization_id)
        .order_by(UsageCounter.updated_at.desc())
        .all()
    )

    counters = []
    for counter, definition in rows:
        limit = None
        enforcement_type = None
        try:
            resolved = resolve_entitlement(db, current_user.organization_id, definition.key)
            limit = resolved.value
            enforcement_type = resolved.definition.enforcement_type.value
        except Exception:  # noqa: BLE001 - fail-open read (§14)
            limit = None
            enforcement_type = None
        counters.append(
            {
                "id": counter.id,
                "entitlement_key": definition.key,
                "window_key": counter.window_key,
                "count": counter.count,
                "soft_warned_at": counter.soft_warned_at.isoformat() if counter.soft_warned_at else None,
                "updated_at": counter.updated_at.isoformat() if counter.updated_at else None,
                "limit": limit,
                "enforcement_type": enforcement_type,
            }
        )

    plan = subscription.plan if subscription is not None else None
    return {
        "account": {"id": account.id, "status": account.status.value},
        "subscription": _serialize_subscription(subscription),
        "plan_code": plan.plan_code if plan is not None else None,
        "plan_name": plan.plan_name if plan is not None else None,
        "counters": counters,
    }


@router.get("/plan-limits", summary="Every entitlement limit/feature resolved for the caller's organization")
def get_org_plan_limits(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    """The full resolved entitlement set (all catalog keys) for the caller's
    own organization, so the subscription page can show plan limits even for
    keys that have no UsageCounter row yet. A null value means the entitlement
    is contract-governed (Enterprise). Per-key resolution fails OPEN to an
    omitted row, never a 500 (§14)."""
    from app.modules.commercial.entitlement_catalog_spec import ENTITLEMENT_CATALOG_SPEC
    from app.modules.commercial.entitlement_resolver import resolve_entitlement

    if not current_user.organization_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This view requires an organization context.",
        )

    entitlements = []
    for spec in ENTITLEMENT_CATALOG_SPEC:
        try:
            resolved = resolve_entitlement(db, current_user.organization_id, spec["key"])
        except Exception:  # noqa: BLE001 - fail-open read (§14)
            continue
        entitlements.append(
            {
                "key": spec["key"],
                "value": resolved.value,
                "value_type": spec["value_type"].value,
                "enforcement_type": spec["enforcement_type"].value,
                "description": spec["description"],
            }
        )
    return {"entitlements": entitlements}


@router.post("/start-trial", summary="Start the free Essentials trial for an org that has no subscription yet")
def start_trial(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    """Self-heal for an org whose signup couldn't provision a subscription
    (e.g. the plan was unavailable at that moment). Only valid when the account
    has no open subscription and hasn't already used its one standard trial."""
    from app.core import cache_service
    from app.modules.commercial.service import CommercialSubscriptionService

    if not current_user.organization_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This action requires an organization context.",
        )
    account = (
        db.query(CommercialAccount)
        .filter(CommercialAccount.organization_id == current_user.organization_id)
        .first()
    )
    if account is None:
        raise NotFoundException("Commercial Account", "organization_id")

    svc = CommercialSubscriptionService(db)
    if svc.get_active_subscription(account.id) is not None:
        raise BadRequestException("Your organization already has a subscription.")
    if not svc.is_trial_eligible(account.id):
        raise BadRequestException(
            "Your organization has already used its free trial. Please contact Zoiko to choose a plan."
        )

    subscription = svc.provision_default_subscription(account.id, intended_plan_code="essentials")
    if subscription is None:
        _logger.error("start-trial: Essentials is not available for account %s", account.id)
        raise BadRequestException(
            "The free trial can't be started right now. Please contact Zoiko support."
        )
    db.commit()
    cache_service.invalidate_subscription_caches(current_user.organization_id)
    return {"status": subscription.status.value, "trial_ends_at": subscription.trial_ends_at.isoformat() if subscription.trial_ends_at else None}


@router.get("/available-plans", summary="Plans the caller's organization can switch to, with prices")
def get_available_plans(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    """Self-serve plans only: ACTIVE and not quote-only (Enterprise is arranged
    with Zoiko, never switched to from here). Prices use the same
    version->plan fallback as a real subscription."""
    from app.modules.commercial.enums import CommercialPlanStatus
    from app.modules.commercial.service import CommercialSubscriptionService

    if not current_user.organization_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This view requires an organization context.",
        )
    account = (
        db.query(CommercialAccount)
        .filter(CommercialAccount.organization_id == current_user.organization_id)
        .first()
    )
    current_plan_id = None
    if account is not None:
        sub = CommercialSubscriptionService(db).get_active_subscription(account.id)
        current_plan_id = sub.commercial_plan_id if sub is not None else None

    plans = (
        db.query(CommercialPlan)
        .filter(CommercialPlan.status == CommercialPlanStatus.ACTIVE, CommercialPlan.is_quote_only.is_(False))
        .all()
    )
    out = []
    for plan in plans:
        price, currency, interval, _ = _resolve_target_plan_price(db, plan)
        if price is None:
            continue
        out.append(
            {
                "id": plan.id,
                "plan_code": plan.plan_code,
                "plan_name": plan.plan_name,
                "description": plan.description,
                "price_amount": str(price),
                "currency": currency,
                "billing_interval": interval.value if interval else None,
                "max_users": plan.max_users,
                "is_current": plan.id == current_plan_id,
            }
        )
    out.sort(key=lambda p: Decimal(p["price_amount"]))
    return {"plans": out}


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-COM-ENT-001 Part 3 (§6.1, §7, §8) — tenant-facing plan change
#
# Mounted here, not at the spec's assumed "/v1/account/*" — that prefix does
# not exist anywhere in this codebase. This is the only real precedent for a
# tenant self-service surface: bare-mounted /billing/workspace/*, org scoped
# via current_user.organization_id, never a client-supplied account id.
# ═══════════════════════════════════════════════════════════════════════════════


class PlanChangePreviewRequest(BaseModel):
    target_plan_id: int


class PlanChangeCommitRequest(BaseModel):
    target_plan_id: int
    confirm_immediate: bool = False
    reason: str | None = None


def _resolve_org_active_subscription(db: Session, current_user):
    from app.modules.commercial.enums import CommercialSubscriptionStatus
    from app.modules.commercial.service import CommercialSubscriptionService

    if not current_user.organization_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This action requires an organization context.",
        )
    account = (
        db.query(CommercialAccount)
        .filter(CommercialAccount.organization_id == current_user.organization_id)
        .first()
    )
    if account is None:
        raise NotFoundException("Commercial Account", "organization_id")
    subscription = CommercialSubscriptionService(db).get_active_subscription(account.id)
    if subscription is None or subscription.status != CommercialSubscriptionStatus.ACTIVE:
        raise BadRequestException(
            "Only an ACTIVE subscription is eligible for a plan change."
        )
    return account, subscription


def _resolve_target_plan_price(db: Session, target_plan: CommercialPlan):
    """Same two-tier version->plan price fallback resolve_price() applies to
    a real subscription, inlined here for a hypothetical target plan (no
    subscription row exists for it yet)."""
    from app.modules.commercial.cache import get_latest_published_version_id
    from app.modules.commercial.models import CommercialPlanVersion

    version_id = get_latest_published_version_id(db, target_plan.id)
    if version_id is not None:
        latest_published = (
            db.query(CommercialPlanVersion)
            .filter(CommercialPlanVersion.id == version_id)
            .first()
        )
    else:
        latest_published = None
    if latest_published is not None and latest_published.price_amount is not None:
        return (latest_published.price_amount, latest_published.currency, latest_published.billing_interval, latest_published.id)
    if target_plan.price_amount is not None:
        return (target_plan.price_amount, target_plan.currency, target_plan.billing_interval, None)
    return (None, None, None, latest_published.id if latest_published is not None else None)


def _determine_direction(current_price, target_price):
    from app.modules.commercial.enums import SubscriptionChangeDirection

    if current_price is None or target_price is None:
        # Price isn't resolvable for one side — can't safely assume an
        # upgrade never loses entitlements, so default conservative: run
        # the downgrade compatibility checklist rather than skip it.
        return SubscriptionChangeDirection.DOWNGRADE
    if target_price >= current_price:
        return SubscriptionChangeDirection.UPGRADE
    return SubscriptionChangeDirection.DOWNGRADE


def _price_impact_preview(subscription, current_price_info, target_price_info):
    current_price, currency, interval, _ = current_price_info
    target_price, target_currency, target_interval, _ = target_price_info

    days_remaining = None
    if subscription.current_period_end is not None:
        days_remaining = max((subscription.current_period_end - datetime.utcnow()).days, 0)

    estimated_delta = None
    if current_price is not None and target_price is not None and days_remaining is not None:
        from app.modules.commercial.enums import CommercialBillingInterval

        period_days = 365 if interval == CommercialBillingInterval.ANNUAL else 30
        daily_old = Decimal(current_price) / period_days
        daily_new = Decimal(target_price) / period_days
        estimated_delta = str((daily_new - daily_old) * days_remaining)

    return {
        "current_price": str(current_price) if current_price is not None else None,
        "target_price": str(target_price) if target_price is not None else None,
        "currency": currency or target_currency,
        "billing_interval": interval.value if interval else (target_interval.value if target_interval else None),
        "days_remaining_in_period": days_remaining,
        "estimated_period_delta": estimated_delta,
        "note": (
            "Informational estimate only — no invoice or credit is generated by this preview; "
            "the new price takes effect at the next normal renewal invoice."
        ),
    }


def _run_preview(db: Session, current_user, target_plan_id: int):
    from app.modules.commercial.enums import SubscriptionChangeDirection
    from app.modules.commercial.plan_change_compatibility import run_compatibility_checks
    from app.modules.commercial.service import CommercialSubscriptionService

    account, subscription = _resolve_org_active_subscription(db, current_user)

    target_plan = db.query(CommercialPlan).filter(CommercialPlan.id == target_plan_id).first()
    if target_plan is None:
        raise NotFoundException("Commercial Plan", "id")
    if target_plan.id == subscription.commercial_plan_id:
        raise BadRequestException(f"Already on plan {target_plan.plan_code}.")
    _assert_self_serve_target(target_plan)

    resolved_current = CommercialSubscriptionService(db).resolve_price(subscription)
    current_price_info = (
        (*resolved_current, subscription.catalog_version_id)
        if resolved_current is not None
        else (None, None, None, subscription.catalog_version_id)
    )
    target_price_info = _resolve_target_plan_price(db, target_plan)

    direction = _determine_direction(current_price_info[0], target_price_info[0])

    if direction == SubscriptionChangeDirection.DOWNGRADE:
        checklist = run_compatibility_checks(db, current_user.organization_id, subscription, target_plan)
    else:
        checklist = []

    blockers = [c for c in checklist if c.severity == "blocker"]
    warnings = [c for c in checklist if c.severity == "warning"]
    price_impact = _price_impact_preview(subscription, current_price_info, target_price_info)

    return {
        "target_plan_id": target_plan.id,
        "target_plan_code": target_plan.plan_code,
        "direction": direction.value,
        "checklist": [c.__dict__ for c in checklist],
        "blockers": [c.__dict__ for c in blockers],
        "warnings": [c.__dict__ for c in warnings],
        "price_impact": price_impact,
        "immediate_eligible": direction == SubscriptionChangeDirection.UPGRADE or len(blockers) == 0,
    }


def _assert_self_serve_target(target_plan: CommercialPlan) -> None:
    if target_plan.is_quote_only:
        raise BadRequestException(
            "This plan is arranged directly with Zoiko. Please contact your Zoiko representative."
        )


def _commit_upgrade(db: Session, current_user, account, subscription, target_plan, preview, reason):
    """Upgrade = pay first. Raises a prorated PLAN_CHANGE invoice and (when
    platform Stripe is configured) a Checkout session for it; the plan only
    swaps once that invoice is paid (see plan_change_billing). A change with no
    positive prorated amount (e.g. renewal today) applies immediately."""
    from app.core import cache_service
    from app.modules.commercial.enums import SubscriptionChangeDirection, SubscriptionChangeStatus
    from app.modules.commercial.models import SubscriptionChange
    from app.modules.commercial.plan_change_billing import (
        _PAYABLE_STATUSES,
        abandon_pending_upgrade,
        correlation_for_invoice,
        create_upgrade_invoice,
        get_pending_upgrade,
        invoice_for_change,
    )
    from app.modules.commercial.platform_stripe_service import PlatformStripeService
    from app.modules.commercial.service import CommercialSubscriptionService

    impact = preview["price_impact"]
    raw_delta = impact.get("estimated_period_delta")
    delta = Decimal(raw_delta) if raw_delta is not None else Decimal("0")
    days_remaining = impact.get("days_remaining_in_period") or 0
    currency = impact.get("currency") or "USD"
    sub_svc = CommercialSubscriptionService(db)

    if delta <= Decimal("0.004"):
        from_plan_id = subscription.commercial_plan_id  # captured BEFORE apply_plan_change mutates it in place
        try:
            sub_svc.apply_plan_change(subscription, target_plan, actor_id=current_user.id, reason=reason or "")
        except ValueError as exc:
            raise _self_service_error(exc, "plan change")
        db.add(SubscriptionChange(
            commercial_subscription_id=subscription.id,
            from_plan_id=from_plan_id,
            to_plan_id=target_plan.id,
            direction=SubscriptionChangeDirection.UPGRADE,
            status=SubscriptionChangeStatus.APPLIED,
            applied_at=datetime.utcnow(),
            requested_by_user_id=current_user.id,
            reason=reason,
            blockers=preview["blockers"],
            price_impact=impact,
        ))
        db.commit()
        db.refresh(subscription)
        cache_service.invalidate_subscription_caches(current_user.organization_id)
        return {"status": "applied", "direction": "upgrade", "subscription_status": subscription.status.value}

    # Reuse an unpaid invoice for the same target; otherwise drop the stale one.
    invoice = None
    change = get_pending_upgrade(db, subscription.id)
    if change is not None:
        existing = invoice_for_change(db, change)
        if (
            change.to_plan_id == target_plan.id
            and existing is not None
            and existing.status in _PAYABLE_STATUSES
            and existing.public_token
        ):
            invoice = existing
        else:
            try:
                abandon_pending_upgrade(db, change, actor_id=current_user.id, reason="Superseded by a new upgrade request")
            except ValueError as exc:
                raise _self_service_error(exc, "plan change")
            change = None

    if invoice is None:
        try:
            invoice = create_upgrade_invoice(
                db,
                account=account,
                subscription=subscription,
                target_plan=target_plan,
                amount=delta,
                currency=currency,
                days_remaining=days_remaining,
                actor_id=current_user.id,
            )
        except ValueError as exc:
            raise _self_service_error(exc, "plan change")
        change = SubscriptionChange(
            commercial_subscription_id=subscription.id,
            from_plan_id=subscription.commercial_plan_id,
            to_plan_id=target_plan.id,
            to_catalog_version_id=_resolve_target_plan_price(db, target_plan)[3],
            direction=SubscriptionChangeDirection.UPGRADE,
            status=SubscriptionChangeStatus.PENDING,
            requested_by_user_id=current_user.id,
            reason=reason,
            blockers=preview["blockers"],
            price_impact=impact,
            correlation_id=correlation_for_invoice(invoice.id),
        )
        db.add(change)
    return _checkout_for_change(db, current_user, invoice, change)


def _checkout_for_change(db: Session, current_user, invoice, change):
    """Commit, then start Stripe Checkout for the change's invoice. Falls back
    to the invoice page ("invoice_due") when Stripe isn't configured/available."""
    from app.core import cache_service
    from app.modules.commercial.platform_stripe_service import PlatformStripeService

    db.commit()
    db.refresh(invoice)
    db.refresh(change)
    cache_service.invalidate_subscription_caches(current_user.organization_id)

    base = {
        "status": "payment_required",
        "direction": "upgrade",
        "subscription_change_id": change.id,
        "invoice_number": invoice.invoice_number,
        "public_token": invoice.public_token,
        "amount": str(invoice.balance_due),
        "currency": invoice.currency,
    }
    try:
        checkout = PlatformStripeService(db).create_checkout_session_for_invoice(invoice)
    except BadRequestException:
        # Platform Stripe not configured / invoice not payable online: the
        # invoice stays open for the public pay link or a manual payment.
        return {**base, "mode": "invoice_due"}
    except Exception as exc:  # noqa: BLE001
        if type(exc).__module__.split(".")[0] != "stripe":
            raise
        _logger.warning("Stripe checkout failed for upgrade invoice %s: %s", invoice.id, exc)
        return {
            **base,
            "mode": "invoice_due",
            "checkout_error": "The payment provider could not start checkout. You can retry from the invoice link.",
        }
    return {**base, "mode": "checkout", "checkout_url": checkout.get("checkout_url")}


@router.post("/plan-change/{change_id}/cancel", summary="Cancel a scheduled downgrade or an unpaid upgrade")
def cancel_plan_change(
    change_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    from app.core import cache_service
    from app.modules.commercial.enums import SubscriptionChangeStatus
    from app.modules.commercial.models import CommercialSubscription, SubscriptionChange
    from app.modules.commercial.plan_change_billing import abandon_pending_upgrade
    from app.modules.commercial.service import CommercialSubscriptionService

    if not current_user.organization_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This action requires an organization context.",
        )
    # Org scoping: the change must belong to a subscription of the caller's own account.
    change = (
        db.query(SubscriptionChange)
        .join(CommercialSubscription, CommercialSubscription.id == SubscriptionChange.commercial_subscription_id)
        .join(CommercialAccount, CommercialAccount.id == CommercialSubscription.commercial_account_id)
        .filter(SubscriptionChange.id == change_id, CommercialAccount.organization_id == current_user.organization_id)
        .first()
    )
    if change is None:
        raise NotFoundException("Plan change", "id")

    try:
        if change.status == SubscriptionChangeStatus.SCHEDULED:
            CommercialSubscriptionService(db).reverse_scheduled_change(
                change, actor_id=current_user.id, reason="Cancelled by organization",
            )
        elif change.status == SubscriptionChangeStatus.PENDING:
            abandon_pending_upgrade(db, change, actor_id=current_user.id, reason="Cancelled by organization")
        else:
            raise BadRequestException("Only a scheduled downgrade or an unpaid upgrade can be cancelled.")
    except ValueError as exc:
        raise _self_service_error(exc, "plan change cancellation")
    db.commit()
    cache_service.invalidate_subscription_caches(current_user.organization_id)
    return {"status": "cancelled", "subscription_change_id": change.id}


@router.post("/plan-change/preview", summary="Preview an upgrade/downgrade before committing")
def preview_plan_change(
    data: PlanChangePreviewRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    """Read-only — runs the §8 compatibility checklist (downgrades only) and
    a price-impact estimate. Commits nothing; no SubscriptionChange row is
    persisted for a preview call."""
    return _run_preview(db, current_user, data.target_plan_id)


@router.post("/plan-change", summary="Commit an upgrade, or schedule/apply a downgrade")
def commit_plan_change(
    data: PlanChangeCommitRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    from app.modules.commercial.enums import SubscriptionChangeDirection, SubscriptionChangeStatus
    from app.modules.commercial.models import SubscriptionChange
    from app.modules.commercial.service import CommercialSubscriptionService
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    account, subscription = _resolve_org_active_subscription(db, current_user)
    target_plan = db.query(CommercialPlan).filter(CommercialPlan.id == data.target_plan_id).first()
    if target_plan is None:
        raise NotFoundException("Commercial Plan", "id")
    _assert_self_serve_target(target_plan)

    # Never trust a client-cached preview for the actual gating decision —
    # re-run it fresh, server-side, at commit time.
    preview = _run_preview(db, current_user, data.target_plan_id)
    direction = SubscriptionChangeDirection(preview["direction"])
    sub_svc = CommercialSubscriptionService(db)

    if direction == SubscriptionChangeDirection.UPGRADE:
        return _commit_upgrade(db, current_user, account, subscription, target_plan, preview, data.reason)

    # DOWNGRADE
    # An unpaid upgrade and a downgrade can't both be in flight: if the upgrade
    # invoice were paid after the subscription moved to SCHEDULED_CHANGE it
    # could no longer be applied. The newer request wins.
    from app.modules.commercial.plan_change_billing import abandon_pending_upgrade, get_pending_upgrade

    stale_upgrade = get_pending_upgrade(db, subscription.id)
    if stale_upgrade is not None:
        try:
            abandon_pending_upgrade(db, stale_upgrade, actor_id=current_user.id, reason="Superseded by a downgrade request")
        except ValueError as exc:
            raise _self_service_error(exc, "plan change")

    if data.confirm_immediate:
        if preview["blockers"]:
            change = SubscriptionChange(
                commercial_subscription_id=subscription.id,
                from_plan_id=subscription.commercial_plan_id,
                to_plan_id=target_plan.id,
                direction=direction,
                status=SubscriptionChangeStatus.BLOCKED,
                requested_by_user_id=current_user.id,
                reason=data.reason,
                blockers=preview["blockers"],
                price_impact=preview["price_impact"],
            )
            db.add(change)
            PlatformAuditService(db).log_no_commit(
                actor_id=current_user.id, actor_role="org_admin",
                action=PlatformAuditAction.SUBSCRIPTION_PLAN_CHANGE_BLOCKED,
                entity_type="SubscriptionChange", entity_id=None,
                organization_id=current_user.organization_id,
                metadata={"blockers": preview["blockers"]},
            )
            db.commit()
            db.refresh(change)
            raise HTTPException(
                status_code=422,
                detail={
                    "message": "Immediate downgrade blocked by the compatibility checklist.",
                    "subscription_change_id": change.id,
                    "blockers": preview["blockers"],
                },
            )
        from_plan_id = subscription.commercial_plan_id
        try:
            sub_svc.apply_plan_change(
                subscription, target_plan, actor_id=current_user.id, reason=data.reason or "",
            )
        except ValueError as exc:
            raise _self_service_error(exc, "plan change")
        change = SubscriptionChange(
            commercial_subscription_id=subscription.id,
            from_plan_id=from_plan_id,
            to_plan_id=target_plan.id,
            direction=direction,
            status=SubscriptionChangeStatus.APPLIED,
            applied_at=datetime.utcnow(),
            requested_by_user_id=current_user.id,
            reason=data.reason,
            blockers=preview["blockers"],
            price_impact=preview["price_impact"],
        )
        db.add(change)
        db.commit()
        db.refresh(subscription)
        from app.core import cache_service
        cache_service.invalidate_subscription_caches(current_user.organization_id)
        return {"status": "applied", "direction": "downgrade", "subscription_status": subscription.status.value}

    # Default downgrade path: schedule for the subscription's next renewal.
    change = SubscriptionChange(
        commercial_subscription_id=subscription.id,
        from_plan_id=subscription.commercial_plan_id,
        to_plan_id=target_plan.id,
        to_catalog_version_id=_resolve_target_plan_price(db, target_plan)[3],
        direction=direction,
        status=SubscriptionChangeStatus.SCHEDULED,
        effective_at=subscription.current_period_end,
        requested_by_user_id=current_user.id,
        reason=data.reason,
        blockers=preview["blockers"],
        price_impact=preview["price_impact"],
    )
    db.add(change)
    db.flush()
    from app.modules.commercial.enums import CommercialSubscriptionStatus

    try:
        sub_svc.transition(subscription, CommercialSubscriptionStatus.SCHEDULED_CHANGE)
    except ValueError as exc:
        raise _self_service_error(exc, "plan change")
    PlatformAuditService(db).log_no_commit(
        actor_id=current_user.id, actor_role="org_admin",
        action=PlatformAuditAction.SUBSCRIPTION_PLAN_CHANGE_SCHEDULED,
        entity_type="SubscriptionChange", entity_id=change.id,
        organization_id=current_user.organization_id,
        new_values={"to_plan_id": target_plan.id, "effective_at": change.effective_at.isoformat() if change.effective_at else None},
        reason=data.reason,
    )
    db.commit()
    db.refresh(change)
    from app.core import cache_service
    cache_service.invalidate_subscription_caches(current_user.organization_id)
    return {
        "status": "scheduled",
        "direction": "downgrade",
        "subscription_change_id": change.id,
        "effective_at": change.effective_at.isoformat() if change.effective_at else None,
        "blockers": preview["blockers"],
    }


# ═══════════════════════════════════════════════════════════════════════════════
# ZB-COM §5.2 — self-serve trial -> paid conversion
#
# Callable only from TRIALING / TRIAL_RECOVERY; enterprise / quote-only /
# unresolvable-price plans route to an assisted quote instead of a self-serve
# charge. The payment is completed out-of-band (Stripe webhook first cleared
# payment, or a manually allocated payment), which drives the subscription
# through the genuine CONVERTED marker into ACTIVE.
# ═══════════════════════════════════════════════════════════════════════════════


class TrialConvertRequest(BaseModel):
    payment_method: str | None = "card"
    # Buy a specific self-serve plan outright (e.g. Professional/Business) instead
    # of the plan the trial is on. Omitted / same plan = the standard conversion.
    plan_id: int | None = None


def _commit_trial_purchase(db: Session, current_user, account, subscription, target_plan):
    """Pay-first purchase of `target_plan` from a free trial. The trial keeps its
    current entitlements until the payment clears; the webhook (or a manual
    allocation) then converts the trial and moves it to the purchased plan."""
    from app.modules.commercial.enums import (
        CommercialPlanStatus,
        PlatformInvoiceStatus,
        SubscriptionChangeDirection,
        SubscriptionChangeStatus,
    )
    from app.modules.commercial.models import PlatformInvoice, SubscriptionChange
    from app.modules.commercial.plan_change_billing import (
        abandon_pending_upgrade,
        correlation_for_invoice,
        create_upgrade_invoice,
        get_pending_upgrade,
    )
    from app.modules.commercial.platform_invoice_service import PlatformInvoiceService

    _assert_self_serve_target(target_plan)
    if target_plan.status != CommercialPlanStatus.ACTIVE:
        raise BadRequestException("This plan isn't available right now.")
    price, currency, interval, version_id = _resolve_target_plan_price(db, target_plan)
    if price is None:
        raise BadRequestException(
            "This plan is arranged directly with Zoiko. Please contact your Zoiko representative."
        )

    # Drop anything stale so the org is never asked to pay two different first bills.
    pending = get_pending_upgrade(db, subscription.id)
    if pending is not None:
        try:
            abandon_pending_upgrade(db, pending, actor_id=current_user.id, reason="Superseded by a new plan purchase")
        except ValueError as exc:
            raise _self_service_error(exc, "plan purchase")
    open_invoices = (
        db.query(PlatformInvoice)
        .filter(
            PlatformInvoice.commercial_subscription_id == subscription.id,
            PlatformInvoice.status.in_([PlatformInvoiceStatus.ISSUED, PlatformInvoiceStatus.DELIVERED]),
            PlatformInvoice.paid_amount <= 0,
        )
        .all()
    )
    invoice_svc = PlatformInvoiceService(db)
    for stale in open_invoices:
        invoice_svc.void(invoice_id=stale.id, actor_id=current_user.id, reason="Superseded by a new plan purchase")

    interval_label = getattr(interval, "value", None) or "monthly"
    invoice = create_upgrade_invoice(
        db,
        account=account,
        subscription=subscription,
        target_plan=target_plan,
        amount=price,
        currency=currency or "USD",
        days_remaining=None,
        actor_id=current_user.id,
        description=f"{target_plan.plan_name} ({interval_label}) — first period",
    )
    change = SubscriptionChange(
        commercial_subscription_id=subscription.id,
        from_plan_id=subscription.commercial_plan_id,
        to_plan_id=target_plan.id,
        to_catalog_version_id=version_id,
        direction=SubscriptionChangeDirection.UPGRADE,
        status=SubscriptionChangeStatus.PENDING,
        requested_by_user_id=current_user.id,
        reason="Plan purchased from free trial",
        price_impact={"target_price": str(price), "currency": currency, "billing_interval": interval_label},
        correlation_id=correlation_for_invoice(invoice.id),
    )
    db.add(change)
    return _checkout_for_change(db, current_user, invoice, change)


@router.post(
    "/trial/convert",
    summary="Convert the org's free trial to a paid plan",
)
def convert_trial_to_paid(
    data: TrialConvertRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_billing_admin),
):
    from app.modules.commercial.enums import CommercialSubscriptionStatus
    from app.modules.commercial.plan_change_compatibility import run_compatibility_checks
    from app.modules.commercial.trial_conversion_service import TrialConversionService

    if not current_user.organization_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This action requires an organization context.",
        )

    account, subscription = TrialConversionService(db).resolve_org_subscription(
        organization_id=current_user.organization_id,
    )
    if account is None:
        raise NotFoundException("Commercial Account", "organization_id")
    if subscription is None:
        raise BadRequestException(
            "Only a TRIALING or TRIAL_RECOVERY subscription can be converted to a paid plan."
        )

    if data.plan_id is not None and data.plan_id != subscription.commercial_plan_id:
        target_plan = db.query(CommercialPlan).filter(CommercialPlan.id == data.plan_id).first()
        if target_plan is None:
            raise NotFoundException("Commercial Plan", "id")
        try:
            return _commit_trial_purchase(db, current_user, account, subscription, target_plan)
        except ValueError as exc:
            raise _self_service_error(exc, "plan purchase")

    # Steps 1-2 — compatibility checklist runs in full and is surfaced to the
    # caller (informational; a self-serve conversion does not force a downgrade
    # so no check can veto it — the price is never invented).
    checklist = run_compatibility_checks(
        db, current_user.organization_id, subscription, subscription.plan,
    ) if subscription.plan is not None else []
    blockers = [c.__dict__ for c in checklist if c.severity == "blocker"]
    warnings = [c.__dict__ for c in checklist if c.severity == "warning"]

    try:
        route = TrialConversionService(db).prepare_trial_conversion(
            account=account,
            subscription=subscription,
            actor_id=current_user.id,
        )
    except ValueError as exc:
        raise _self_service_error(exc, "trial conversion")
    db.commit()

    return {
        **route,
        "compatibility": {
            "checklist": [c.__dict__ for c in checklist],
            "blockers": blockers,
            "warnings": warnings,
        },
    }
