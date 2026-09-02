"""modules/commercial/org_self_service_router.py
---------------------------------------------------
Plane 1 — org-facing "your Zoiko subscription" self-service endpoint.

Distinct from commercial_billing_router.py (super_admin-only, arbitrary
account_id). This endpoint is scoped ONLY to the caller's own organization —
never a client-supplied account_id — via get_current_billing_admin's
current_user.organization_id.
"""

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
        "current_period_start": subscription.current_period_start.isoformat() if subscription.current_period_start else None,
        "current_period_end": subscription.current_period_end.isoformat() if subscription.current_period_end else None,
        "trial_ends_at": subscription.trial_ends_at.isoformat() if subscription.trial_ends_at else None,
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

    account = (
        db.query(CommercialAccount)
        .filter(CommercialAccount.organization_id == current_user.organization_id)
        .first()
    )
    if account is None:
        return {
            "account": None,
            "subscription": None,
            "invoices": [],
            "payments": [],
            "quotes": [],
        }

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

    return {
        "account": {"id": account.id, "status": account.status.value, "intended_plan_code": account.intended_plan_code},
        "subscription": _serialize_subscription(subscription),
        "invoices": [_serialize_invoice(i) for i in invoices],
        "payments": [_serialize_payment(p) for p in payments],
        "quotes": [_serialize_quote(q) for q in quotes],
    }


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

    # Never trust a client-cached preview for the actual gating decision —
    # re-run it fresh, server-side, at commit time.
    preview = _run_preview(db, current_user, data.target_plan_id)
    direction = SubscriptionChangeDirection(preview["direction"])
    sub_svc = CommercialSubscriptionService(db)

    if direction == SubscriptionChangeDirection.UPGRADE:
        from_plan_id = subscription.commercial_plan_id  # captured BEFORE apply_plan_change mutates it in place
        try:
            sub_svc.apply_plan_change(
                subscription, target_plan, actor_id=current_user.id, reason=data.reason or "",
            )
        except ValueError as exc:
            raise BadRequestException(str(exc))
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
        return {"status": "applied", "direction": "upgrade", "subscription_status": subscription.status.value}

    # DOWNGRADE
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
            raise BadRequestException(str(exc))
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
        raise BadRequestException(str(exc))
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
    return {
        "status": "scheduled",
        "direction": "downgrade",
        "subscription_change_id": change.id,
        "effective_at": change.effective_at.isoformat() if change.effective_at else None,
        "blockers": preview["blockers"],
    }
