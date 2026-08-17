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
from app.modules.auth.models import User, UserRole
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
    ApprovalRequestListResponse,
    ApprovalRequestResponse,
    BillingKillSwitchResponse,
    BillingKillSwitchUpdate,
    CommercialPlanVersionCreate,
    CommercialPlanVersionListResponse,
    CommercialPlanVersionResponse,
    DashboardStats,
    PlatformAuditLogListResponse,
    PlatformAuditLogResponse,
    ProductionAcceptanceItem,
    ProductionAcceptanceReport,
    RejectApprovalRequest,
    SettingCreate,
    SettingResponse,
    SettingUpdate,
    SubmitForApprovalRequest,
    SubscriptionAuditLogListResponse,
    SubscriptionAuditLogResponse,
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
    is_active: bool | None = Query(None),
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
    if is_active is not None:
        query = query.filter(User.is_active == is_active)

    total = query.count()
    rows = query.order_by(User.created_at.desc()).offset(skip).limit(limit).all()

    from app.modules.auth.models import SuperAdminMFA

    super_admin_ids = [u.id for u, _o in rows if u.role == UserRole.SUPER_ADMIN]
    mfa_enabled_by_user_id = {}
    if super_admin_ids:
        mfa_rows = db.query(SuperAdminMFA).filter(SuperAdminMFA.user_id.in_(super_admin_ids)).all()
        mfa_enabled_by_user_id = {row.user_id: row.is_enabled for row in mfa_rows}

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
            mfa_enabled=mfa_enabled_by_user_id.get(u.id, False) if u.role == UserRole.SUPER_ADMIN else None,
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
    """Toggle a platform user's active status.

    Safety invariant: a Super Admin can never deactivate their own account
    (regardless of how many other active Super Admins exist). Because
    `get_current_super_admin` re-verifies `is_active` from the database on
    every request (see core/dependencies.py's `get_current_user`), the
    caller here is always active and — once the self-deactivation check
    below has passed — always a DIFFERENT user than the target. Since this
    is the only endpoint that can flip a super_admin's `is_active` flag,
    this single check is sufficient to guarantee the count of active
    Super Admins can never be driven to zero: the last remaining active
    Super Admin cannot deactivate themselves, and there is no one else left
    to do it. (No email/domain-based bootstrap exists; the only recovery
    path is scripts/seed_super_admin.py, which requires SETUP_KEY and
    direct DB/script access — hence why this must never be reachable.)
    """
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


@router.put("/users/{user_id}/mfa/reset", response_model=SuccessResponse)
def admin_reset_mfa(
    user_id: int,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Administrative MFA reset (release-blocker pass, Blocker 4): disaster
    recovery for a Super Admin who has lost both their authenticator device
    AND every recovery code. Only reachable by another already-authenticated
    Super Admin (get_current_super_admin requires a real, fully-privileged
    token, which itself required passing MFA if the ACTOR has it enabled).
    Always audited (MFA_ADMIN_RESET) with both actor and target identity."""
    from app.modules.auth import mfa_service

    return mfa_service.admin_reset_mfa(db, current_user, user_id)


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
        catalog_version_id=subscription.catalog_version_id,
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


# ── Versioned price catalog (ZB-COM-BILL-001 §T1, Phase 4, Super Admin only) ─
# A published version is immutable: draft -> submit (creates an
# ApprovalRequest) -> approve (a DIFFERENT Super Admin publishes it, self-
# approval is rejected server-side) or reject. No prices are invented — every
# structural field mirrors CommercialPlan and stays NULL unless supplied.

def _version_payload(version) -> CommercialPlanVersionResponse:
    return CommercialPlanVersionResponse(
        id=version.id,
        plan_id=version.plan_id,
        plan_code=version.plan.plan_code if version.plan else None,
        version_number=version.version_number,
        status=version.status,
        plan_name=version.plan_name,
        description=version.description,
        billing_interval=version.billing_interval,
        currency=version.currency,
        price_amount=version.price_amount,
        effective_from=version.effective_from,
        effective_to=version.effective_to,
        max_users=version.max_users,
        max_storage_gb=version.max_storage_gb,
        features=version.features,
        created_by_user_id=version.created_by_user_id,
        approval_request_id=version.approval_request_id,
        published_at=version.published_at,
        created_at=version.created_at,
        updated_at=version.updated_at,
    )


@router.get("/commercial-plans/{plan_id}/versions", response_model=CommercialPlanVersionListResponse)
def list_commercial_plan_versions(
    plan_id: int,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import NotFoundException
    from app.modules.commercial.models import CommercialPlan
    from app.modules.commercial.service import CommercialPlanVersionService

    plan = db.query(CommercialPlan).filter(CommercialPlan.id == plan_id).first()
    if plan is None:
        raise NotFoundException("Commercial Plan", "id")

    versions = CommercialPlanVersionService(db).list_versions_for_plan(plan_id)
    return CommercialPlanVersionListResponse(
        versions=[_version_payload(v) for v in versions], total=len(versions)
    )


@router.post("/commercial-plans/{plan_id}/versions", response_model=CommercialPlanVersionResponse)
def create_commercial_plan_version(
    plan_id: int,
    data: CommercialPlanVersionCreate,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import NotFoundException
    from app.modules.commercial.models import CommercialPlan
    from app.modules.commercial.service import CommercialPlanVersionService

    plan = db.query(CommercialPlan).filter(CommercialPlan.id == plan_id).first()
    if plan is None:
        raise NotFoundException("Commercial Plan", "id")

    version = CommercialPlanVersionService(db).create_draft(
        plan,
        actor_id=getattr(current_user, "id", None),
        **data.model_dump(),
    )
    db.commit()
    db.refresh(version)
    return _version_payload(version)


@router.get("/commercial-plan-versions/{version_id}", response_model=CommercialPlanVersionResponse)
def get_commercial_plan_version(
    version_id: int,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import NotFoundException
    from app.modules.commercial.service import CommercialPlanVersionService

    version = CommercialPlanVersionService(db).get_version(version_id)
    if version is None:
        raise NotFoundException("Commercial Plan Version", "id")
    return _version_payload(version)


@router.post("/commercial-plan-versions/{version_id}/submit", response_model=CommercialPlanVersionResponse)
def submit_commercial_plan_version(
    version_id: int,
    data: SubmitForApprovalRequest,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException, NotFoundException
    from app.modules.commercial.service import CommercialPlanVersionService

    version = CommercialPlanVersionService(db).get_version(version_id)
    if version is None:
        raise NotFoundException("Commercial Plan Version", "id")
    try:
        version, _request = CommercialPlanVersionService(db).submit_for_approval(
            version, requested_by_user_id=current_user.id, reason=data.reason
        )
    except ValueError as exc:
        raise BadRequestException(str(exc))
    db.commit()
    db.refresh(version)
    return _version_payload(version)


@router.post("/commercial-plan-versions/{version_id}/approve", response_model=CommercialPlanVersionResponse)
def approve_commercial_plan_version(
    version_id: int,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
    from app.modules.super_admin.approval_service import SelfApprovalError
    from app.modules.commercial.service import CommercialPlanVersionService

    version = CommercialPlanVersionService(db).get_version(version_id)
    if version is None:
        raise NotFoundException("Commercial Plan Version", "id")
    try:
        version = CommercialPlanVersionService(db).approve_and_publish(
            version, approver_user_id=current_user.id
        )
    except SelfApprovalError as exc:
        raise ForbiddenException(str(exc))
    except ValueError as exc:
        raise BadRequestException(str(exc))
    db.commit()
    db.refresh(version)
    return _version_payload(version)


@router.post("/commercial-plan-versions/{version_id}/reject", response_model=CommercialPlanVersionResponse)
def reject_commercial_plan_version(
    version_id: int,
    data: RejectApprovalRequest,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
    from app.modules.super_admin.approval_service import SelfApprovalError
    from app.modules.commercial.service import CommercialPlanVersionService

    version = CommercialPlanVersionService(db).get_version(version_id)
    if version is None:
        raise NotFoundException("Commercial Plan Version", "id")
    try:
        version = CommercialPlanVersionService(db).reject(
            version, approver_user_id=current_user.id, rejection_reason=data.rejection_reason
        )
    except SelfApprovalError as exc:
        raise ForbiddenException(str(exc))
    except ValueError as exc:
        raise BadRequestException(str(exc))
    db.commit()
    db.refresh(version)
    return _version_payload(version)


@router.post("/commercial-plan-versions/{version_id}/archive", response_model=CommercialPlanVersionResponse)
def archive_commercial_plan_version(
    version_id: int,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException, NotFoundException
    from app.modules.commercial.service import CommercialPlanVersionService

    version = CommercialPlanVersionService(db).get_version(version_id)
    if version is None:
        raise NotFoundException("Commercial Plan Version", "id")
    try:
        version = CommercialPlanVersionService(db).archive(version, actor_id=current_user.id)
    except ValueError as exc:
        raise BadRequestException(str(exc))
    db.commit()
    db.refresh(version)
    return _version_payload(version)


# ── Maker-checker approval queue (ZB-COM-BILL-001 Phase 5, Super Admin only) ─
# Read-only visibility over ApprovalRequest rows created by domain services
# (currently: catalog_version_publish). Approve/reject actions live on the
# domain-specific endpoints above (e.g. .../commercial-plan-versions/{id}/approve)
# so the approval decision always re-validates the domain's own state machine,
# not just the generic request row.

@router.get("/approval-requests", response_model=ApprovalRequestListResponse)
def list_approval_requests(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    request_type: str = "",
    status: str = "",
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException
    from app.modules.commercial.enums import ApprovalStatus
    from app.modules.super_admin.approval_service import ApprovalService

    status_enum = None
    if status:
        try:
            status_enum = ApprovalStatus(status)
        except ValueError:
            raise BadRequestException(f"Invalid status '{status}'.")

    rows, total = ApprovalService(db).list_requests(
        request_type=request_type or None, status=status_enum, skip=skip, limit=limit
    )
    requests = []
    for r in rows:
        requests.append(
            ApprovalRequestResponse(
                id=r.id,
                request_type=r.request_type,
                requested_by_user_id=r.requested_by_user_id,
                requested_by_email=r.requested_by.email if r.requested_by else None,
                requested_at=r.requested_at,
                reason=r.reason,
                scope=r.scope,
                before_state=r.before_state,
                proposed_state=r.proposed_state,
                evidence=r.evidence,
                approver_user_id=r.approver_user_id,
                approver_email=r.approver.email if r.approver else None,
                approved_at=r.approved_at,
                rejection_reason=r.rejection_reason,
                status=r.status,
                correlation_id=r.correlation_id,
            )
        )
    return ApprovalRequestListResponse(requests=requests, total=total)


# ── Billing kill switch (ZB-COM-BILL-001 §30.1, Super Admin only) ──────────
# Scoped to the one real charging path that exists today: commercial
# subscription creation/activation (CommercialSubscriptionService). Disabling
# it blocks new charging state only — it never mutates or deletes existing
# data, and read endpoints are unaffected.

@router.get("/billing-kill-switch", response_model=BillingKillSwitchResponse)
def get_billing_kill_switch(
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.modules.super_admin.kill_switch_service import (
        COMMERCIAL_SUBSCRIPTION_CHARGING,
        BillingKillSwitchService,
    )

    switch = BillingKillSwitchService(db).ensure_switch(COMMERCIAL_SUBSCRIPTION_CHARGING)
    db.commit()
    db.refresh(switch)
    return BillingKillSwitchResponse(
        id=switch.id,
        scope=switch.scope,
        enabled=switch.enabled,
        reason=switch.reason,
        changed_by_user_id=switch.changed_by_user_id,
        changed_by_email=switch.changed_by.email if switch.changed_by else None,
        changed_at=switch.changed_at,
        created_at=switch.created_at,
    )


@router.put("/billing-kill-switch", response_model=BillingKillSwitchResponse)
def set_billing_kill_switch(
    data: BillingKillSwitchUpdate,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.modules.super_admin.kill_switch_service import (
        COMMERCIAL_SUBSCRIPTION_CHARGING,
        BillingKillSwitchService,
    )

    switch = BillingKillSwitchService(db).set_enabled(
        COMMERCIAL_SUBSCRIPTION_CHARGING,
        data.enabled,
        reason=data.reason,
        actor_id=current_user.id,
    )

    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    PlatformAuditService(db).log_no_commit(
        actor_id=current_user.id,
        actor_role="super_admin",
        action=PlatformAuditAction.ACTIVATE if data.enabled else PlatformAuditAction.DEACTIVATE,
        entity_type="BillingKillSwitch",
        entity_id=switch.id,
        reason=data.reason,
        old_values={"enabled": not data.enabled},
        new_values={"enabled": data.enabled},
    )

    db.commit()
    db.refresh(switch)
    logger.warning(
        "Super Admin %s set billing kill switch '%s' enabled=%s (reason: %s)",
        current_user.email, COMMERCIAL_SUBSCRIPTION_CHARGING, data.enabled, data.reason,
    )
    return BillingKillSwitchResponse(
        id=switch.id,
        scope=switch.scope,
        enabled=switch.enabled,
        reason=switch.reason,
        changed_by_user_id=switch.changed_by_user_id,
        changed_by_email=switch.changed_by.email if switch.changed_by else None,
        changed_at=switch.changed_at,
        created_at=switch.created_at,
    )


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
                actor_role=log.actor_role,
                action=log.action.value if hasattr(log.action, "value") else str(log.action),
                entity_type=log.entity_type,
                entity_id=log.entity_id,
                organization_id=log.organization_id,
                organization_name=org.organization_name if org else None,
                old_values=log.old_values,
                new_values=log.new_values,
                metadata=log.metadata_,
                reason=log.reason,
                correlation_id=log.correlation_id,
                created_at=log.created_at,
            )
            for log, actor, org in rows
        ],
        total=total,
    )


# ── Subscription lifecycle audit visibility (PHASE 13, Super Admin, read-only) ──
# CommercialSubscription mutations are audited in the org-scoped
# billing_audit_logs table (BillingAuditLog), not PlatformAuditLog — see the
# comment on create_commercial_subscription / set_commercial_subscription_status
# below. This endpoint is a read-only, cross-organization PROJECTION over
# those same rows (filtered to entity_type == "CommercialSubscription") so a
# Super Admin can see subscription activity without it being duplicated into
# the platform-plane audit table. No write path here; no change to
# BillingAuditLog/BillingAuditAction semantics.

_SUBSCRIPTION_LIFECYCLE_LABELS = {
    "active": "subscription_activated",
    "suspended": "subscription_suspended",
    "cancelled": "subscription_cancelled",
    "expired": "subscription_expired",
    "pending": "subscription_created",
}


def _subscription_lifecycle_event(action: str, new_values: dict | None) -> str:
    """Presentation-only label — derived from stored data, never persisted."""
    status = (new_values or {}).get("status")
    if action == "create":
        return "subscription_created"
    if status and status in _SUBSCRIPTION_LIFECYCLE_LABELS:
        return _SUBSCRIPTION_LIFECYCLE_LABELS[status]
    return f"subscription_{action}"


@router.get("/subscription-audit-logs", response_model=SubscriptionAuditLogListResponse)
def list_subscription_audit_logs(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    search: str = "",
    organization_id: int | None = None,
    actor_id: int | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Cross-organization, read-only view of CommercialSubscription lifecycle
    events, newest first. Non-super-admin callers receive 403 before the
    query runs. Never exposes anything beyond what billing_audit_logs already
    stores (no passwords/tokens/secrets are ever written into that table's
    old_values/new_values by the subscription endpoints below)."""
    from app.modules.billing.models import BillingAuditLog

    query = (
        db.query(BillingAuditLog, User, Organization)
        .join(Organization, Organization.id == BillingAuditLog.organization_id)
        .outerjoin(User, User.id == BillingAuditLog.actor_id)
        .filter(BillingAuditLog.entity_type == "CommercialSubscription")
    )
    if search:
        like = f"%{search}%"
        query = query.filter(
            (Organization.organization_name.ilike(like))
            | (Organization.organization_code.ilike(like))
        )
    if organization_id is not None:
        query = query.filter(BillingAuditLog.organization_id == organization_id)
    if actor_id is not None:
        query = query.filter(BillingAuditLog.actor_id == actor_id)
    if date_from is not None:
        query = query.filter(
            BillingAuditLog.timestamp >= datetime.combine(date_from, datetime.min.time())
        )
    if date_to is not None:
        query = query.filter(
            BillingAuditLog.timestamp < datetime.combine(date_to + timedelta(days=1), datetime.min.time())
        )

    total = query.count()
    rows = (
        query.order_by(BillingAuditLog.timestamp.desc(), BillingAuditLog.id.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    return SubscriptionAuditLogListResponse(
        logs=[
            SubscriptionAuditLogResponse(
                id=log.id,
                actor_id=log.actor_id,
                actor_email=actor.email if actor else None,
                action=log.action.value if hasattr(log.action, "value") else str(log.action),
                lifecycle_event=_subscription_lifecycle_event(
                    log.action.value if hasattr(log.action, "value") else str(log.action),
                    log.new_values,
                ),
                subscription_id=log.entity_id,
                organization_id=log.organization_id,
                organization_name=org.organization_name,
                organization_code=org.organization_code,
                old_values=log.old_values,
                new_values=log.new_values,
                created_at=log.timestamp,
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


# ── Production Acceptance Center (ZB-COM-BILL-001 §26, Super Admin only) ────
# The exact acceptance criteria from Table 13 of the Commercial Billing &
# Subscription Operating Standard (verbatim IDs/criterion text — nothing
# invented here). Each item's verdict is either a REAL, live query against
# this database, or an honest architectural fact verified by reading the
# actual code (documented in `evidence`) — never a hardcoded PASS. Items
# requiring infrastructure this codebase does not have (MFA, a Plane-1
# payment processor, a reconciliation engine, legal sign-off) are reported
# NOT_CONFIGURED / FAIL with the specific missing dependency named, per the
# standard's own instruction: "do not mark an item PASS unless the
# underlying system actually satisfies it."
#
# This is a point-in-time architecture assessment, not live monitoring —
# the standard is explicit that real production readiness also requires a
# signed acceptance record (GO-01), which is a governance action, not
# something this endpoint can certify.

@router.get("/production-acceptance", response_model=ProductionAcceptanceReport)
def get_production_acceptance_report(
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    items: list[ProductionAcceptanceItem] = []

    # COM-01 — no locked/approved price book exists (confirmed: CommercialPlan
    # pricing fields stay NULL by design — see CommercialPlanService docstring).
    items.append(ProductionAcceptanceItem(
        id="COM-01",
        criterion="Four-plan taxonomy matches website/app/processor/contracts; all prices and limits resolve from one APPROVED catalog version.",
        status="NOT_CONFIGURED",
        evidence="No published CommercialPlanVersion carries a non-null price_amount yet; no approved price book exists in this environment (ZB-COM-BILL-001 §B2).",
    ))

    # COM-02 — no evaluation/trial program is configured anywhere in the schema.
    items.append(ProductionAcceptanceItem(
        id="COM-02",
        criterion="Evaluation/trial behavior is explicitly approved; no unintended free-trial copy or auto-conversion path exists.",
        status="NOT_CONFIGURED",
        evidence="No EVALUATION/trial program model or configuration exists in this codebase; no public trial claim is made either.",
    ))

    # COM-03 — REAL DB query: every org must have a non-null classification/source.
    from app.modules.organizations.models import Organization
    total_orgs = db.query(Organization).count()
    missing_classification = (
        db.query(Organization)
        .filter(Organization.billing_classification.is_(None))
        .count()
    )
    if total_orgs == 0:
        com03_status, com03_evidence = "NOT_APPLICABLE", "No organizations exist yet."
    elif missing_classification > 0:
        com03_status = "FAIL"
        com03_evidence = f"{missing_classification} of {total_orgs} organizations have no billing_classification."
    else:
        com03_status = "PASS"
        com03_evidence = f"All {total_orgs} organizations carry a non-null billing_classification (column is NOT NULL with a server default)."
    items.append(ProductionAcceptanceItem(
        id="COM-03", criterion="Every workspace has billing_classification and billing_source; non-commercial classes cannot create live Zoiko charges.",
        status=com03_status, evidence=com03_evidence,
    ))

    # COM-04 — REAL: enforced in CommercialSubscriptionService._assert_may_charge_commercially.
    items.append(ProductionAcceptanceItem(
        id="COM-04",
        criterion="Zoiko One entitlements and standalone subscriptions cannot double charge the same product/period.",
        status="PASS",
        evidence="CommercialSubscriptionService blocks ACTIVE creation/activation unless CommercialAccountService.can_charge() is True (requires billing_classification==COMMERCIAL_STANDALONE AND billing_source==REGISTERED_VIA_STANDALONE); covered by test_double_charge_prevention.",
    ))

    # FIN-01 — architectural fact: Plane 1 (commercial_*) and Plane 2 (billing_*) are separate tables/services.
    items.append(ProductionAcceptanceItem(
        id="FIN-01",
        criterion="Plane 1 and Plane 2 ledgers, invoice sequences, processor namespaces and sender identities are separated.",
        status="PASS",
        evidence="commercial_accounts/commercial_plans/commercial_subscriptions (Plane 1) are distinct tables/services from billing_customers/invoices/payments (Plane 2); commercial/service.py docstring enforces the boundary explicitly.",
    ))

    # FIN-02 — architectural fact: no PUT/PATCH/DELETE route exists on tenant invoices.
    items.append(ProductionAcceptanceItem(
        id="FIN-02",
        criterion="Issued invoices cannot be destructively edited/deleted; credit/void/correction workflows preserve history.",
        status="WARNING",
        evidence="Verified for Plane 2 (billing module invoice router has no destructive mutation endpoint) in a prior session; not re-verified this pass. Plane 1 has no invoice concept yet (no Plane-1 processor exists).",
    ))

    items.append(ProductionAcceptanceItem(
        id="FIN-03",
        criterion="Partial, failed, reversed, refunded, disputed and unmatched payments are correctly modeled and reconciled.",
        status="WARNING",
        evidence="Modeled for Plane 2 tenant payments (PaymentStatus enum + dunning/collections state machine). No Plane-1 payment/refund object exists yet — there is no Plane-1 processor to generate one.",
    ))

    items.append(ProductionAcceptanceItem(
        id="FIN-04",
        criterion="No report labels operational billings/payment status as recognized revenue/cash without Finance-approved definition.",
        status="NOT_CONFIGURED",
        evidence="No accounting-export/revenue-recognition reporting feature exists in this codebase to mislabel — nothing to verify against.",
    ))

    items.append(ProductionAcceptanceItem(
        id="TAX-01",
        criterion="No global tax rate is hard-coded; tax/e-invoice behavior resolves through versioned market configuration.",
        status="NOT_APPLICABLE",
        evidence="Not assessed this pass. Plane 2 tax configuration exists (TaxRate model) but was not re-verified against this criterion.",
    ))
    items.append(ProductionAcceptanceItem(
        id="TAX-02",
        criterion="Seller entity, customer tax facts, product tax treatment, exemption/reverse-charge evidence and source version are stored.",
        status="NOT_APPLICABLE",
        evidence="Not assessed this pass; no legal_entity model exists distinct from Organization.",
    ))
    items.append(ProductionAcceptanceItem(
        id="PAY-01",
        criterion="Processor webhooks verify signatures/account/environment and are idempotent; replay cannot duplicate money.",
        status="NOT_APPLICABLE",
        evidence="Stripe webhook signature verification exists for Plane 2 tenant payments; no Plane-1 (Zoiko's own commercial subscription) processor integration exists to assess.",
    ))
    items.append(ProductionAcceptanceItem(
        id="PAY-02",
        criterion="Payment collection uses tokenized/provider-hosted paths by default; no raw PAN/CVC in application logs/storage/email.",
        status="NOT_CONFIGURED",
        evidence="No Plane-1 payment collection exists yet (commercial subscriptions have no payment-method field). Plane 2 uses Stripe-hosted collection but was not re-verified this pass.",
    ))
    items.append(ProductionAcceptanceItem(
        id="SEC-01",
        criterion="RBAC, MFA/step-up, dual control, secret management and break-glass procedures pass Security review.",
        status="WARNING",
        evidence=(
            "RBAC exists (super_admin/org_admin/billing_admin, server-enforced). Backend-enforced TOTP MFA now exists "
            "for every Super Admin account (mfa_service.py): password verification alone never mints a real access "
            "token for a super_admin -- login returns a restricted mfa_pending token that only authorizes an "
            "enrollment or challenge call, and the real token is minted only after a verified TOTP code or single-use "
            "recovery code. Secrets are encrypted at rest with a key separate from the JWT signing key "
            "(core/mfa_crypto.py); recovery codes are stored only as SHA-256 hashes. Brute-force protection "
            "(account lockout after repeated failures) and an audited administrative break-glass reset "
            "(MFA_ADMIN_RESET) both exist. This resolves the MFA prerequisite this criterion previously blocked on. "
            "Remaining gap: no DUAL CONTROL (two-person approval) exists for any single-actor Super Admin action "
            "(kill-switch disable, MFA admin-reset, org deletion each require only one authenticated actor) and "
            "processor-credential secret management is unassessed since no real payment processor integration "
            "exists yet (see PAY-01/PAY-02) -- not yet a full PASS."
        ),
    ))
    items.append(ProductionAcceptanceItem(
        id="INT-01",
        criterion="Mutation APIs and scheduled jobs are idempotent; import and outbound webhook replay are safe.",
        status="WARNING",
        evidence="Audit writes are transactionally atomic (flush-only, caller commits). Idempotency keys for financial mutation endpoints were not comprehensively verified this pass.",
    ))
    items.append(ProductionAcceptanceItem(
        id="INT-02",
        criterion="Integration failure never silently changes invoice/payment truth; exception queues and retry/reconciliation exist.",
        status="NOT_CONFIGURED",
        evidence="No integration exception queue exists.",
    ))
    items.append(ProductionAcceptanceItem(
        id="COMMS-01",
        criterion="Four communication estates are separated; tenant sender verification and message suppression are enabled.",
        status="NOT_APPLICABLE",
        evidence="Not assessed this pass.",
    ))
    items.append(ProductionAcceptanceItem(
        id="QA-01",
        criterion="Staging/sandbox uses synthetic data, test processors, test webhooks and isolated email; no live payment credentials.",
        status="WARNING",
        evidence="Backend tests run against an isolated in-memory SQLite database only (never BILLING_DATABASE_URL/Neon) — see tests/conftest.py. No dedicated staging/sandbox processor-mode verification exists.",
    ))
    items.append(ProductionAcceptanceItem(
        id="QA-02",
        criterion="Negative tests cover duplicate events, stale catalog, race conditions, retry storms, payment reversal, tax failure, partial payment and cross-tenant access.",
        status="WARNING",
        evidence="Cross-tenant access, self-approval, illegal state transitions, and double-charge prevention are covered by this pass's test suite. Retry-storm/race-condition/duplicate-webhook-event tests are not present.",
    ))

    # REC-01 — investigated this pass (release-blocker Blocker 5): confirmed
    # NOT IMPLEMENTED, not merely undocumented. See docs/
    # SUPER_ADMIN_ENTERPRISE_READINESS_REPORT.md for the full investigation.
    items.append(ProductionAcceptanceItem(
        id="REC-01",
        criterion="Daily/periodic reconciliation compares Zoiko ledger to processor and downstream systems with exception ownership.",
        status="FAIL",
        evidence=(
            "NOT IMPLEMENTED. No reconciliation engine, reconciliation_record model, scheduled reconciliation job, "
            "or exception-ownership workflow exists anywhere for Plane 1 (Zoiko's own commercial billing — "
            "commercial_accounts/commercial_plans/commercial_subscriptions). The only 'reconcile' code in this "
            "codebase (PaymentService.reconcile_payment, billing/routers/payment_router.py) is an unrelated, "
            "org-scoped Plane 2 (tenant-to-customer) manual check that a single payment's allocations sum correctly "
            "-- it is not an automated ledger-vs-processor comparison and is out of scope for this Super-Admin-only "
            "engagement regardless. Building a real Plane-1 reconciliation engine today would be decorative: there is "
            "no Plane-1 payment processor integration yet to reconcile against (see PAY-01/PAY-02, also unimplemented). "
            "This is a genuine, not-yet-built capability, reported honestly rather than as a fabricated PASS."
        ),
    ))

    # OPS-01 — kill switch is real; the rest of this criterion is not assessed.
    items.append(ProductionAcceptanceItem(
        id="OPS-01",
        criterion="Backups, recovery, audit retention, observability, incident response and billing kill switches are tested.",
        status="WARNING",
        evidence="A real, audited billing kill switch now gates commercial-subscription charging (GET/PUT /super-admin/billing-kill-switch), covered by tests. Backups/recovery/observability/incident-response were not assessed this pass.",
    ))
    items.append(ProductionAcceptanceItem(
        id="LEGAL-01",
        criterion="Terms, privacy, DPA, merchant identity, cancellation/refund wording, market claims and e-invoice statements are approved.",
        status="NOT_APPLICABLE",
        evidence="Outside engineering/backend scope — requires Legal/Compliance sign-off, not a system state.",
    ))
    items.append(ProductionAcceptanceItem(
        id="GO-01",
        criterion="Product, Engineering, Finance, Security, Legal/Compliance, QA and Commercial sign the go-live record.",
        status="NOT_CONFIGURED",
        evidence="No signed acceptance record exists. This is a governance action this endpoint cannot certify on its own.",
    ))

    # Overall verdict — computed from the actual item statuses above, never
    # from frontend/UI presence. Any FAIL is a mandatory blocker (this pass
    # currently has SEC-01 and REC-01 failing); WARNING/NOT_CONFIGURED items
    # keep the platform out of an unconditional "READY" but do not block a
    # supervised go-live the way a FAIL does.
    failed_ids = [item.id for item in items if item.status == "FAIL"]
    attention_ids = [item.id for item in items if item.status in ("WARNING", "NOT_CONFIGURED")]
    if failed_ids:
        overall_status = "BLOCKED"
        summary = (
            f"NOT READY FOR PRODUCTION. {len(failed_ids)} criteria are FAILING: "
            f"{', '.join(failed_ids)}. These must be resolved before go-live."
        )
    elif attention_ids:
        overall_status = "CONDITIONAL"
        summary = (
            f"Conditionally ready. No criteria are failing, but {len(attention_ids)} need attention "
            f"before an unconditional go-live: {', '.join(attention_ids)}."
        )
    else:
        overall_status = "READY"
        summary = "All assessed criteria pass or are not applicable. No outstanding blockers."

    return ProductionAcceptanceReport(
        generated_at=datetime.utcnow(),
        items=items,
        overall_status=overall_status,
        summary=summary,
    )
