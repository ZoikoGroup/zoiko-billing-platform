"""
modules/super_admin/router.py
-----------------------------
Super Admin endpoints: platform dashboard stats, platform-wide user
management (org admins / billing admins), admin-initiated password resets,
and PlatformSetting configuration.
"""

import logging
from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy import String, cast
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_super_admin
from app.database import get_db
from app.modules.auth.models import User
from app.modules.auth.schemas import SuccessResponse
from app.modules.commercial.enums import (
    BillingSource,
    CommercialAccountStatus,
    CommercialPlanStatus,
    CommercialSubscriptionStatus,
)
from app.modules.commercial.schemas import (
    CommercialAccountListResponse,
    CommercialAccountResponse,
    CommercialBillingConfigurationSummary,
    CommercialOrganizationDetailResponse,
    CommercialPlanCreate,
    CommercialPlanDefaultUpdate,
    CommercialPlanListResponse,
    CommercialPlanResponse,
    CommercialPlanStatusUpdate,
    CommercialPlanUpdate,
    CommercialSubscriptionCreate,
    CommercialSubscriptionListResponse,
    CommercialSubscriptionResponse,
    CommercialSubscriptionStatusUpdate,
    CommercialSubscriptionSummary,
)
from app.modules.organizations.models import Organization
from app.modules.super_admin.schemas import (
    DashboardStats,
    PlatformAuditLogListResponse,
    PlatformAuditLogResponse,
    SettingCreate,
    SettingResponse,
    SettingUpdate,
    SuperAdminUserListResponse,
    SuperAdminUserResponse,
)

logger = logging.getLogger("zoiko_billing.super_admin")

router = APIRouter(prefix="/super-admin", tags=["Super Admin"])


@router.get("/dashboard/stats", response_model=DashboardStats)
def dashboard_stats(current_user=Depends(get_current_super_admin), db: Session = Depends(get_db)):
    from app.modules.billing.models import BillingCustomer, Invoice

    total_orgs = db.query(Organization).count()
    active_orgs = db.query(Organization).filter(Organization.is_active == True).count()
    total_users = db.query(User).count()

    recent_orgs = (
        db.query(Organization)
        .order_by(Organization.created_at.desc())
        .limit(5)
        .all()
    )

    return DashboardStats(
        total_organizations=total_orgs,
        active_organizations=active_orgs,
        total_users=total_users,
        org_admins=db.query(User).filter(User.role == "org_admin").count(),
        billing_admins=db.query(User).filter(User.role == "billing_admin").count(),
        total_customers=db.query(BillingCustomer).count(),
        total_invoices=db.query(Invoice).count(),
        recent_organizations=[
            {
                "id": o.id,
                "organization_name": o.organization_name,
                "organization_code": o.organization_code,
                "is_active": o.is_active,
                "created_at": o.created_at,
            }
            for o in recent_orgs
        ],
    )


@router.get("/users", response_model=SuperAdminUserListResponse)
def list_platform_users(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    search: str = Query(""),
    role: str = Query(""),
    organization_id: int = Query(None),
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    query = db.query(User, Organization).outerjoin(
        Organization, Organization.id == User.organization_id
    )
    if search:
        like = f"%{search}%"
        query = query.filter(
            (User.email.ilike(like))
            | (User.first_name.ilike(like))
            | (User.last_name.ilike(like))
            | (Organization.organization_name.ilike(like))
        )
    if role:
        query = query.filter(User.role == role)
    if organization_id:
        query = query.filter(User.organization_id == organization_id)

    total = query.count()
    rows = query.order_by(User.created_at.desc()).offset(skip).limit(limit).all()

    users = [
        SuperAdminUserResponse(
            id=u.id,
            email=u.email,
            role=u.role,
            organization_id=u.organization_id,
            organization_name=o.organization_name if o else None,
            organization_code=o.organization_code if o else None,
            first_name=u.first_name,
            last_name=u.last_name,
            is_active=u.is_active,
            created_at=u.created_at,
        )
        for u, o in rows
    ]
    return SuperAdminUserListResponse(users=users, total=total)


@router.put("/users/{user_id}/status", response_model=SuccessResponse)
def set_user_status(
    user_id: int,
    is_active: bool,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException, NotFoundException

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise NotFoundException("User", "id")
    if user.id == current_user.id and not is_active:
        raise BadRequestException("You cannot deactivate your own account.")
    user.is_active = is_active
    db.commit()
    return {"message": "User status updated."}


@router.put("/users/{user_id}/reset-password", response_model=SuccessResponse)
def admin_reset_password(
    user_id: int,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Force a password reset: email the user a single-use reset link."""
    from app.core.exceptions import NotFoundException
    from app.modules.auth import service as auth_service
    from app.modules.auth.models import SecurityActionPurpose

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise NotFoundException("User", "id")

    raw_token, _ = auth_service._issue_action_token(
        db, user.email, user.organization_id, SecurityActionPurpose.RESET
    )
    link = auth_service._action_link(SecurityActionPurpose.RESET, raw_token)
    auth_service._send_reset_email(db, user, link)
    db.commit()
    logger.info("Super Admin %s reset password for %s", current_user.email, user.email)
    return {"message": "Password reset link sent to the user."}


# ── Commercial accounts ────────────────────────────────────────────────────
# Read-only foundation for the future Super Admin commercial UI (PHASE 6).
# Only super_admin may list/read these; tenants read their OWN account via
# GET /organizations/me/commercial-account (auth-scoped). There are no
# mutation endpoints in this phase: tenants must never change
# billing_source / billing_classification, and account-status changes are
# deferred to the commercial-subscription phase.

def _commercial_account_payload(account, org, db: Session):
    from app.modules.commercial.service import (
        CommercialAccountService,
        CommercialSubscriptionService,
    )

    can_charge = CommercialAccountService(db).can_charge(org)
    current = CommercialSubscriptionService(db).get_active_subscription(account.id)
    current_subscription = None
    if current is not None:
        current_subscription = CommercialSubscriptionSummary(
            id=current.id,
            status=current.status,
            plan_code=current.plan.plan_code if current.plan else "",
            plan_name=current.plan.plan_name if current.plan else "",
            start_at=current.start_at,
            end_at=current.end_at,
        )
    return CommercialAccountResponse(
        id=account.id,
        organization_id=org.id,
        organization_code=org.organization_code,
        organization_name=org.organization_name,
        status=account.status,
        billing_source=org.billing_source,
        billing_classification=org.billing_classification,
        is_active=org.is_active,
        can_charge=can_charge,
        current_subscription=current_subscription,
        created_at=account.created_at,
        updated_at=account.updated_at,
    )


@router.get("/commercial-accounts", response_model=CommercialAccountListResponse)
def list_commercial_accounts(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    search: str = "",
    status: CommercialAccountStatus | None = None,
    billing_source: BillingSource | None = None,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.modules.commercial.models import CommercialAccount
    from app.modules.commercial.service import CommercialAccountService

    # Lazy backfill (idempotent): organizations provisioned before Phase 6
    # have no account row yet; creating one here keeps the platform list
    # complete without a production data migration. Mirrors the reference
    # Zoiko One startup backfill behavior.
    existing_ids = {
        org_id
        for (org_id,) in db.query(CommercialAccount.organization_id).all()
    }
    missing_orgs = (
        db.query(Organization)
        .filter(Organization.id.notin_(existing_ids))
        .all()
    ) if existing_ids else db.query(Organization).all()
    if missing_orgs:
        service = CommercialAccountService(db)
        for org in missing_orgs:
            service.ensure_commercial_account(org.id)
        db.commit()

    query = (
        db.query(CommercialAccount, Organization)
        .join(Organization, Organization.id == CommercialAccount.organization_id)
    )
    if search:
        like = f"%{search}%"
        query = query.filter(
            (Organization.organization_name.ilike(like))
            | (Organization.organization_code.ilike(like))
        )
    if status is not None:
        query = query.filter(CommercialAccount.status == status)
    if billing_source is not None:
        query = query.filter(Organization.billing_source == billing_source)
    total = query.count()
    rows = (
        query.order_by(CommercialAccount.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    return CommercialAccountListResponse(
        accounts=[_commercial_account_payload(acc, org, db) for acc, org in rows],
        total=total,
    )


@router.get("/commercial-accounts/{organization_id}", response_model=CommercialAccountResponse)
def get_commercial_account(
    organization_id: int,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import NotFoundException
    from app.modules.commercial.models import CommercialAccount
    from app.modules.commercial.service import CommercialAccountService

    # Lazily ensure so legacy tenants are readable without a migration.
    CommercialAccountService(db).ensure_commercial_account(organization_id)
    db.commit()

    row = (
        db.query(CommercialAccount, Organization)
        .join(Organization, Organization.id == CommercialAccount.organization_id)
        .filter(CommercialAccount.organization_id == organization_id)
        .first()
    )
    if row is None:
        raise NotFoundException("Commercial Account", "organization_id")
    account, org = row
    return _commercial_account_payload(account, org, db)


def _subscription_payload(subscription, org, plan):
    return CommercialSubscriptionResponse(
        id=subscription.id,
        commercial_account_id=subscription.commercial_account_id,
        organization_id=org.id,
        organization_code=org.organization_code,
        organization_name=org.organization_name,
        commercial_plan_id=subscription.commercial_plan_id,
        plan_code=plan.plan_code if plan else "",
        plan_name=plan.plan_name if plan else "",
        status=subscription.status,
        start_at=subscription.start_at,
        end_at=subscription.end_at,
        current_period_start=subscription.current_period_start,
        current_period_end=subscription.current_period_end,
        created_at=subscription.created_at,
        updated_at=subscription.updated_at,
    )


# ── Consolidated commercial organization view (PHASE 9, read-only) ────────────
# One composed, read-only control-center view per organization: org identity +
# server-stamped billing source/classification + commercial account (incl.
# charging readiness + current subscription) + operational BillingConfiguration
# + current subscription/plan + full subscription history + entitlement view.
# Everything is composed from existing services/models — no new source fields.
# Tenants are rejected by get_current_super_admin before the body runs.

@router.get("/commercial-organizations/{organization_id}", response_model=CommercialOrganizationDetailResponse)
def get_commercial_organization_detail(
    organization_id: int,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import NotFoundException
    from app.modules.billing.services.settings_service import BillingConfigurationService
    from app.modules.commercial.models import CommercialPlan, CommercialSubscription
    from app.modules.commercial.service import (
        CommercialAccountService,
        CommercialEntitlementService,
        CommercialSubscriptionService,
    )

    org = db.query(Organization).filter(Organization.id == organization_id).first()
    if org is None:
        raise NotFoundException("Organization", "id")

    # Lazy backfill so legacy tenants (pre-Phase 6) remain readable.
    account = CommercialAccountService(db).ensure_commercial_account(org.id)
    db.commit()
    db.refresh(account)

    sub_service = CommercialSubscriptionService(db)
    current = sub_service.get_active_subscription(account.id)
    plan = current.plan if current is not None else None

    history_subs = (
        db.query(CommercialSubscription)
        .filter(CommercialSubscription.commercial_account_id == account.id)
        .order_by(CommercialSubscription.id.desc())
        .all()
    )

    # Compose the payloads BEFORE get_configuration() (which may seed + commit
    # internally), so no lazily-loaded attribute can be tripped by a commit.
    account_payload = _commercial_account_payload(account, org, db)
    current_payload = (
        _subscription_payload(current, org, plan) if current is not None else None
    )
    history_payloads = [_subscription_payload(s, org, s.plan) for s in history_subs]

    plan_payload = None
    if plan is not None:
        plan_payload = CommercialPlanResponse(
            id=plan.id,
            plan_code=plan.plan_code,
            plan_name=plan.plan_name,
            description=plan.description,
            status=plan.status,
            is_default=plan.is_default,
            billing_interval=plan.billing_interval,
            currency=plan.currency,
            price_amount=plan.price_amount,
            effective_from=plan.effective_from,
            effective_to=plan.effective_to,
            max_users=plan.max_users,
            max_storage_gb=plan.max_storage_gb,
            features=plan.features,
            created_at=plan.created_at,
            updated_at=plan.updated_at,
        )

    config = BillingConfigurationService(db).get_configuration(org.id)
    billing_configuration = CommercialBillingConfigurationSummary(
        id=config.id,
        company_name=config.company_name,
        default_currency=(
            config.default_currency.value
            if hasattr(config.default_currency, "value")
            else config.default_currency
        ),
        timezone=config.timezone,
        language=config.language,
        invoice_prefix=config.invoice_prefix,
        tax_number=config.tax_number,
    )

    entitlements = CommercialEntitlementService(db).get_organization_entitlements(org.id)

    return CommercialOrganizationDetailResponse(
        organization_id=org.id,
        organization_code=org.organization_code,
        organization_name=org.organization_name,
        is_active=org.is_active,
        billing_source=org.billing_source,
        billing_classification=org.billing_classification,
        can_charge=CommercialAccountService(db).can_charge(org),
        account=account_payload,
        billing_configuration=billing_configuration,
        current_subscription=current_payload,
        plan=plan_payload,
        subscription_history=history_payloads,
        entitlements=entitlements,
    )


@router.get("/commercial-plans", response_model=CommercialPlanListResponse)
def list_commercial_plans(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    search: str = "",
    status: CommercialPlanStatus | None = None,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Read-only plan catalogue (PHASE 7 foundation). Plans are reusable
    templates shared across organizations; no per-org plan rows exist.
    PHASE 11 adds safe text search (code/name/description) + status filter."""
    from app.modules.commercial.models import CommercialPlan

    query = db.query(CommercialPlan)
    if search:
        like = f"%{search}%"
        query = query.filter(
            (CommercialPlan.plan_code.ilike(like))
            | (CommercialPlan.plan_name.ilike(like))
            | (CommercialPlan.description.ilike(like))
        )
    if status is not None:
        query = query.filter(CommercialPlan.status == status)
    total = query.count()
    plans = (
        query.order_by(CommercialPlan.id)
        .offset(skip)
        .limit(limit)
        .all()
    )
    return CommercialPlanListResponse(plans=plans, total=total)


@router.get("/commercial-subscriptions", response_model=CommercialSubscriptionListResponse)
def list_commercial_subscriptions(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    search: str = "",
    status: CommercialSubscriptionStatus | None = None,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Read-only subscriptions across ALL organizations (PHASE 7 foundation).
    PHASE 11 adds a status filter to the existing search."""
    from app.modules.commercial.models import (
        CommercialAccount,
        CommercialPlan,
        CommercialSubscription,
    )

    query = (
        db.query(CommercialSubscription, Organization, CommercialPlan)
        .join(CommercialAccount, CommercialAccount.id == CommercialSubscription.commercial_account_id)
        .join(Organization, Organization.id == CommercialAccount.organization_id)
        .join(CommercialPlan, CommercialPlan.id == CommercialSubscription.commercial_plan_id)
    )
    if search:
        like = f"%{search}%"
        query = query.filter(
            (Organization.organization_name.ilike(like))
            | (Organization.organization_code.ilike(like))
            | (CommercialPlan.plan_code.ilike(like))
        )
    if status is not None:
        query = query.filter(CommercialSubscription.status == status)
    total = query.count()
    rows = (
        query.order_by(CommercialSubscription.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    return CommercialSubscriptionListResponse(
        subscriptions=[_subscription_payload(sub, org, plan) for sub, org, plan in rows],
        total=total,
    )


@router.get("/commercial-subscriptions/{organization_id}", response_model=CommercialSubscriptionResponse)
def get_commercial_subscription(
    organization_id: int,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Read-only detail of one org's subscription (current open if any,
    otherwise most recent)."""
    from app.core.exceptions import NotFoundException
    from app.modules.commercial.models import (
        CommercialAccount,
        CommercialPlan,
        CommercialSubscription,
    )

    account = (
        db.query(CommercialAccount)
        .filter(CommercialAccount.organization_id == organization_id)
        .first()
    )
    if account is None:
        raise NotFoundException("Commercial Subscription", "organization_id")

    from app.modules.commercial.service import CommercialSubscriptionService

    svc = CommercialSubscriptionService(db)
    subscription = svc.get_active_subscription(account.id)
    if subscription is None:
        subscription = svc.get_most_recent_subscription(account.id)
    if subscription is None:
        raise NotFoundException("Commercial Subscription", "organization_id")

    org = db.query(Organization).filter(Organization.id == organization_id).first()
    plan = (
        db.query(CommercialPlan)
        .filter(CommercialPlan.id == subscription.commercial_plan_id)
        .first()
    )
    return _subscription_payload(subscription, org, plan)


# ── Commercial plan management (PHASE 8, Super Admin only) ─────────────────
# Management is the approved-data entry surface: the catalogue stays EMPTY
# until an approved source supplies values (no invented pricing). Every change
# goes through CommercialPlanService so plan_code stays unique/immutable and
# "at most one ACTIVE default" is enforced transactionally. Plans are never
# hard-deleted — ARCHIVE is the retirement path.

@router.get("/commercial-plans/{plan_id}", response_model=CommercialPlanResponse)
def get_commercial_plan(
    plan_id: int,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import NotFoundException
    from app.modules.commercial.models import CommercialPlan

    plan = db.query(CommercialPlan).filter(CommercialPlan.id == plan_id).first()
    if plan is None:
        raise NotFoundException("Commercial Plan", "id")
    return plan


@router.post("/commercial-plans", response_model=CommercialPlanResponse)
def create_commercial_plan(
    data: CommercialPlanCreate,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException
    from app.modules.commercial.service import CommercialPlanService

    try:
        plan = CommercialPlanService(db).create_plan(
            actor_id=getattr(current_user, "id", None),
            **data.model_dump(),
        )
    except ValueError as exc:
        raise BadRequestException(str(exc))
    db.commit()
    db.refresh(plan)
    return plan


@router.patch("/commercial-plans/{plan_id}", response_model=CommercialPlanResponse)
def update_commercial_plan(
    plan_id: int,
    data: CommercialPlanUpdate,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException, NotFoundException
    from app.modules.commercial.models import CommercialPlan
    from app.modules.commercial.service import CommercialPlanService

    plan = db.query(CommercialPlan).filter(CommercialPlan.id == plan_id).first()
    if plan is None:
        raise NotFoundException("Commercial Plan", "id")
    plan = CommercialPlanService(db).update_plan(
        plan,
        actor_id=getattr(current_user, "id", None),
        **data.model_dump(exclude_unset=True),
    )
    db.commit()
    db.refresh(plan)
    return plan


@router.patch("/commercial-plans/{plan_id}/status", response_model=CommercialPlanResponse)
def set_commercial_plan_status(
    plan_id: int,
    data: CommercialPlanStatusUpdate,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException, NotFoundException
    from app.modules.commercial.models import CommercialPlan
    from app.modules.commercial.service import CommercialPlanService

    plan = db.query(CommercialPlan).filter(CommercialPlan.id == plan_id).first()
    if plan is None:
        raise NotFoundException("Commercial Plan", "id")
    try:
        plan = CommercialPlanService(db).set_status(
            plan, data.status, actor_id=getattr(current_user, "id", None)
        )
    except ValueError as exc:
        raise BadRequestException(str(exc))
    db.commit()
    db.refresh(plan)
    return plan


@router.put("/commercial-plans/{plan_id}/default", response_model=CommercialPlanResponse)
def set_commercial_plan_default(
    plan_id: int,
    data: CommercialPlanDefaultUpdate,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException, NotFoundException
    from app.modules.commercial.models import CommercialPlan
    from app.modules.commercial.service import CommercialPlanService

    plan = db.query(CommercialPlan).filter(CommercialPlan.id == plan_id).first()
    if plan is None:
        raise NotFoundException("Commercial Plan", "id")
    try:
        plan = CommercialPlanService(db).set_default(
            plan, data.is_default, actor_id=getattr(current_user, "id", None)
        )
    except ValueError as exc:
        raise BadRequestException(str(exc))
    db.commit()
    db.refresh(plan)
    return plan


# ── Platform audit feed (PHASE 11, Super Admin only) ────────────────────────
# Cross-organization, platform-plane audit trail (PlatformAuditLog). Entries
# are written by CommercialPlanService mutations (CREATE / UPDATE / ACTIVATE /
# DEACTIVATE / SET_DEFAULT / CLEAR_DEFAULT / ARCHIVE) inside the caller's
# transaction. Org-scoped tenant audit (billing_audit_logs) is preserved
# separately and is NOT exposed through this endpoint. Tenants are rejected by
# get_current_super_admin (403) before the body runs.

@router.get("/audit-logs", response_model=PlatformAuditLogListResponse)
def list_platform_audit_logs(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    search: str = "",
    entity_type: str = "",
    action: str = "",
    actor_id: int | None = None,
    organization_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Cross-organization platform audit feed, newest first.

    Filters (all optional): search (matches entity_type / action text),
    entity_type, action, actor_id, organization_id, and inclusive day bounds
    date_from / date_to. Non-super-admin callers receive 403.
    """
    from app.modules.super_admin.models import PlatformAuditLog

    query = (
        db.query(PlatformAuditLog, User, Organization)
        .outerjoin(User, User.id == PlatformAuditLog.actor_id)
        .outerjoin(Organization, Organization.id == PlatformAuditLog.organization_id)
    )
    if search:
        like = f"%{search}%"
        # action is a CaseInsensitiveEnum column; cast to plain string so the
        # LIKE pattern binds without enum coercion.
        query = query.filter(
            (PlatformAuditLog.entity_type.ilike(like))
            | (cast(PlatformAuditLog.action, String).ilike(like))
        )
    if entity_type:
        query = query.filter(PlatformAuditLog.entity_type == entity_type)
    if action:
        query = query.filter(PlatformAuditLog.action == action)
    if actor_id is not None:
        query = query.filter(PlatformAuditLog.actor_id == actor_id)
    if organization_id is not None:
        query = query.filter(PlatformAuditLog.organization_id == organization_id)
    if date_from is not None:
        query = query.filter(
            PlatformAuditLog.created_at
            >= datetime.combine(date_from, datetime.min.time())
        )
    if date_to is not None:
        query = query.filter(
            PlatformAuditLog.created_at
            < datetime.combine(date_to + timedelta(days=1), datetime.min.time())
        )

    total = query.count()
    rows = (
        query.order_by(PlatformAuditLog.created_at.desc(), PlatformAuditLog.id.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    return PlatformAuditLogListResponse(
        logs=[
            PlatformAuditLogResponse(
                id=log.id,
                actor_id=log.actor_id,
                actor_email=actor.email if actor else None,
                action=log.action.value if hasattr(log.action, "value") else str(log.action),
                entity_type=log.entity_type,
                entity_id=log.entity_id,
                organization_id=log.organization_id,
                organization_name=org.organization_name if org else None,
                old_values=log.old_values,
                new_values=log.new_values,
                metadata=log.metadata_,
                created_at=log.created_at,
            )
            for log, actor, org in rows
        ],
        total=total,
    )


# ── Commercial subscription management (PHASE 8, Super Admin only) ──────────
# Creation and lifecycle changes pass through CommercialSubscriptionService's
# state machine — routers never write status directly. Tenants have no
# mutation surface; the tenant endpoint is strictly read-only and org-scoped.

@router.post("/commercial-subscriptions", response_model=CommercialSubscriptionResponse)
def create_commercial_subscription(
    data: CommercialSubscriptionCreate,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException, NotFoundException
    from app.modules.commercial.models import CommercialAccount, CommercialPlan
    from app.modules.commercial.service import (
        CommercialAccountService,
        CommercialSubscriptionService,
    )

    account = (
        db.query(CommercialAccount)
        .filter(CommercialAccount.organization_id == data.organization_id)
        .first()
    )
    if account is None:
        account = CommercialAccountService(db).ensure_commercial_account(data.organization_id)
        db.flush()

    plan = db.query(CommercialPlan).filter(CommercialPlan.id == data.plan_id).first()
    if plan is None:
        raise NotFoundException("Commercial Plan", "id")

    try:
        subscription = CommercialSubscriptionService(db).create_subscription(
            account.id, plan, status=data.status
        )
    except ValueError as exc:
        raise BadRequestException(str(exc))

    # PHASE 9 audit: reuse the Billing module's org-scoped audit trail for
    # commercial subscription mutations (the subscription belongs to an org, so
    # organization_id is always available). log_no_commit keeps the entry in
    # the same transaction as the subscription — all-or-nothing.
    from app.modules.billing.models import BillingAuditAction
    from app.modules.billing.services.audit_service import BillingAuditService

    BillingAuditService(db).log_no_commit(
        organization_id=account.organization_id,
        actor_id=getattr(current_user, "id", None),
        action=BillingAuditAction.CREATE,
        entity_type="CommercialSubscription",
        entity_id=subscription.id,
        new_values={"plan_id": plan.id, "status": subscription.status},
    )
    db.commit()
    db.refresh(subscription)
    return _subscription_payload(
        subscription,
        db.query(Organization).filter(Organization.id == data.organization_id).first(),
        plan,
    )


@router.patch("/commercial-subscriptions/{subscription_id}/status", response_model=CommercialSubscriptionResponse)
def set_commercial_subscription_status(
    subscription_id: int,
    data: CommercialSubscriptionStatusUpdate,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException, NotFoundException
    from app.modules.commercial.models import (
        CommercialAccount,
        CommercialPlan,
        CommercialSubscription,
    )
    from app.modules.commercial.service import CommercialSubscriptionService

    subscription = (
        db.query(CommercialSubscription)
        .filter(CommercialSubscription.id == subscription_id)
        .first()
    )
    if subscription is None:
        raise NotFoundException("Commercial Subscription", "id")
    try:
        subscription = CommercialSubscriptionService(db).transition(subscription, data.status)
    except ValueError as exc:
        raise BadRequestException(str(exc))

    account = (
        db.query(CommercialAccount)
        .filter(CommercialAccount.id == subscription.commercial_account_id)
        .first()
    )

    # PHASE 9 audit: same org-scoped audit trail as creation. The audit entry
    # shares the subscription's transaction via log_no_commit.
    from app.modules.billing.models import BillingAuditAction
    from app.modules.billing.services.audit_service import BillingAuditService

    BillingAuditService(db).log_no_commit(
        organization_id=account.organization_id,
        actor_id=getattr(current_user, "id", None),
        action=BillingAuditAction.UPDATE,
        entity_type="CommercialSubscription",
        entity_id=subscription.id,
        new_values={"status": subscription.status},
    )
    db.commit()
    db.refresh(subscription)

    org = (
        db.query(Organization)
        .filter(Organization.id == account.organization_id)
        .first()
    )
    plan = (
        db.query(CommercialPlan)
        .filter(CommercialPlan.id == subscription.commercial_plan_id)
        .first()
    )
    return _subscription_payload(subscription, org, plan)


# ── Platform settings ───────────────────────────────────────────────────────

@router.get("/settings", response_model=list[SettingResponse])
def list_settings(current_user=Depends(get_current_super_admin), db: Session = Depends(get_db)):
    from app.modules.super_admin.models import PlatformSetting

    return db.query(PlatformSetting).order_by(PlatformSetting.key).all()


@router.post("/settings", response_model=SettingResponse)
def create_setting(
    data: SettingCreate,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import AlreadyExistsException
    from app.modules.super_admin.models import PlatformSetting

    existing = db.query(PlatformSetting).filter(PlatformSetting.key == data.key).first()
    if existing:
        raise AlreadyExistsException("Setting", "key")
    setting = PlatformSetting(**data.model_dump())
    db.add(setting)
    db.commit()
    db.refresh(setting)
    return setting


@router.put("/settings/{key}", response_model=SettingResponse)
def update_setting(
    key: str,
    data: SettingUpdate,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.modules.super_admin.models import PlatformSetting

    setting = db.query(PlatformSetting).filter(PlatformSetting.key == key).first()
    if setting is None:
        setting = PlatformSetting(key=key)
        db.add(setting)
    if data.value is not None:
        setting.value = data.value
    if data.description is not None:
        setting.description = data.description
    if data.category is not None:
        setting.category = data.category
    if data.is_public is not None:
        setting.is_public = data.is_public
    db.commit()
    db.refresh(setting)
    return setting
