"""
modules/super_admin/router.py
-----------------------------
Super Admin endpoints: platform dashboard stats, platform-wide user
management (org admins / billing admins), admin-initiated password resets,
and PlatformSetting configuration.
"""

import logging
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Body, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import String, cast
from sqlalchemy.orm import Session

from app.core.capabilities import require_capability
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
    CommercialSubscriptionPlanChange,
    CommercialSubscriptionResponse,
    CommercialSubscriptionStatusUpdate,
    CommercialSubscriptionSummary,
)
from app.modules.organizations.models import Organization, TenantLifecycleState
from app.modules.super_admin.attention_service import AttentionService
from app.modules.super_admin.lifecycle_service import TenantLifecycleService
from app.modules.super_admin.organization_service import OrganizationDirectoryService
from app.modules.super_admin.privileged_access_service import PrivilegedAccessService
from app.modules.super_admin.saas_reporting_service import SaasReportingService
from app.modules.super_admin.schemas import SaasReportingResponse
from app.modules.super_admin.telemetry_service import TelemetryService
from app.modules.super_admin.user_admin_service import UserAdminService
from app.modules.super_admin import metric_dictionary
from app.modules.super_admin.search_service import GlobalSearchService
from app.modules.super_admin.launch_readiness_service import LaunchReadinessService
from app.modules.super_admin.financial_consistency_service import FinancialConsistencyService
from app.modules.super_admin.schemas import (
    ApprovalDecisionRequest,
    ApprovalRequestListResponse,
    ApprovalRequestResponse,
    AttentionAssignRequest,
    AttentionEscalateRequest,
    AttentionCountsResponse,
    AttentionItemListResponse,
    AttentionItemResponse,
    AttentionSuppressRequest,
    AttentionTransitionRequest,
    BillingKillSwitchResponse,
    BillingKillSwitchUpdate,
    CircuitBreakerCatalogEntry,
    CircuitBreakerCatalogResponse,
    CircuitBreakerChangeProposalCreate,
    CircuitBreakerToggleRequest,
    CommercialPlanVersionCreate,
    CommercialPlanVersionListResponse,
    CommercialPlanVersionResponse,
    ConfigurationInventoryResponse,
    DashboardStats,
    JobHealthListResponse,
    MetricDictionaryResponse,
    OrganizationHealthResponse,
    PlatformAuditLogListResponse,
    PlatformAuditLogResponse,
    PrivilegedAccessGrantListResponse,
    PrivilegedAccessGrantResponse,
    PrivilegedAccessRequestCreate,
    PrivilegedAccessStepUp,
    ProductionAcceptanceItem,
    ProductionAcceptanceReport,
    RejectApprovalRequest,
    SettingCreate,
    SettingResponse,
    SettingUpdate,
    SubmitForApprovalRequest,
    FinancialConsistencyResponse,
    FinancialOperationsSummaryResponse,
    InvoiceStatusDistributionResponse,
    InvoiceDeliveryDiagnosticsResponse,
    FailedPaymentListResponse,
    DunningCaseListResponse,
    AllocationExceptionListResponse,
    CreditApplicationListResponse,
    CreditNoteListResponse,
    RefundListResponse,
    WriteOffListResponse,
    TaxSummaryResponse,
    ReconciliationRunResponse,
    ReconciliationRunListResponse,
    ReconciliationRunDetailResponse,
    ReconciliationExceptionActionResponse,
    LaunchReadinessResponse,
    LifecycleTransitionRequest,
    LifecycleTransitionResponse,
    OrganizationDirectoryResponse,
    OrganizationOverviewResponse,
    PlatformLifecycleResponse,
    SearchResponse,
    SubscriptionAuditLogListResponse,
    SubscriptionAuditLogResponse,
    TriageCriticalEvent,
    TriageIncidentsSection,
    TriageSafetyControl,
    TriageSummaryResponse,
    SuperAdminUserInviteRequest,
    SuperAdminUserListResponse,
    SuperAdminUserResponse,
    TenantAccessSummaryResponse,
    TenantHealthOverviewResponse,
    UserMembershipChangeRequest,
    UserRoleChangeRequest,
    UserStatusChangeRequest,
    BillingCommandKpis,
    BillingSparklines,
    BillingAgingBucket,
    BillingActionCenter,
    BillingNextSevenDays,
    BillingOverviewResponse,
    BillingTrendPoint,
    BillingTrendResponse,
    OverdueInvoiceRow,
    OverdueInvoiceListResponse,
    CollectionsRiskRow,
    CollectionsRiskListResponse,
    BillingActivityItem,
    BillingActivityListResponse,
)


logger = logging.getLogger("zoiko_billing.super_admin")

router = APIRouter(prefix="/super-admin", tags=["Super Admin"])


@router.get("/dashboard/stats", response_model=DashboardStats)
def dashboard_stats(current_user=Depends(get_current_super_admin), db: Session = Depends(get_db)):
    total_orgs = db.query(Organization).count()
    active_orgs = db.query(Organization).filter(Organization.is_active == True).count()
    total_users = db.query(User).count()

    recent_orgs = (
        db.query(Organization)
        .order_by(Organization.created_at.desc())
        .limit(5)
        .all()
    )

    # Billing tables may not exist yet on a fresh database.  Return zeros
    # instead of crashing the whole dashboard.
    try:
        from app.modules.billing.models import BillingCustomer, Invoice
        total_customers = db.query(BillingCustomer).count()
        total_invoices = db.query(Invoice).count()
    except Exception:
        logger.debug("Billing tables not available yet; returning zero counts.")
        total_customers = 0
        total_invoices = 0

    return DashboardStats(
        total_organizations=total_orgs,
        active_organizations=active_orgs,
        total_users=total_users,
        org_admins=db.query(User).filter(User.role == "org_admin").count(),
        billing_admins=db.query(User).filter(User.role == "billing_admin").count(),
        total_customers=total_customers,
        total_invoices=total_invoices,
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

    # ZB-SA-P3 (Phase 3B): evidence-based derived status for every row.
    user_admin = UserAdminService(db)

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
            platform_role=(u.platform_role.value if u.platform_role else "platform_administrator") if u.role == UserRole.SUPER_ADMIN else None,
            derived_status=user_admin.derived_status(u),
            last_login_at=u.last_login_at,
        )
        for u, o in rows
    ]
    return SuperAdminUserListResponse(users=users, total=total)


@router.put("/users/{user_id}/status", response_model=SuccessResponse)
def set_user_status(
    user_id: int,
    data: UserStatusChangeRequest,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """ZB-SA-P3 (Phase 3B): flip a platform user's active status.

    Safety invariants (unchanged from the original endpoint):
      - a Super Admin can never deactivate their own account;
      - `get_current_super_admin` re-verifies is_active from the database on
        every request, so the caller is always active and always a DIFFERENT
        user than a self-deactivation-target — active-Super-Admin count can
        never be driven to zero through this endpoint.

    New in Phase 3B: a documented reason is MANDATORY and an audited event
    (ACTIVATE/DEACTIVATE, actor + reason, transactional with the change) is
    written to the platform audit trail.
    """
    from app.core.exceptions import NotFoundException

    service = UserAdminService(db)
    user = service.set_status(
        actor=current_user,
        user_id=user_id,
        is_active=data.is_active,
        reason=data.reason,
    )
    db.commit()
    logger.info(
        "Super admin %s set user %s is_active=%s",
        current_user.email,
        user.email,
        data.is_active,
    )
    return {"message": f"User {'activated' if data.is_active else 'deactivated'}."}


@router.post("/users/invite", response_model=SuperAdminUserResponse)
def invite_super_admin_user(
    data: SuperAdminUserInviteRequest,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """ZB-SA-P3 (Phase 3B): invite a tenant administrator/user into any org.

    Segregation of duties is inherited unchanged from core/dependencies.py's
    ROLE_CREATION_RULES (§25): super admins create ORG ADMINS platform-wide;
    billing/finance/auditor users remain the tenant org admin's to invite.
    The invite email/token flow is reused verbatim from auth/service — no
    parallel invitation system exists.
    """
    from app.core.exceptions import BadRequestException

    service = UserAdminService(db)
    try:
        user = service.invite_user(
            actor=current_user,
            organization_id=data.organization_id,
            email=str(data.email),
            role=data.role,
            first_name=data.first_name,
            last_name=data.last_name,
            phone=data.phone,
            send_invite=data.send_invite,
        )
    except ValueError as exc:
        raise BadRequestException(str(exc)) from exc
    db.commit()
    db.refresh(user)
    logger.info(
        "Super admin %s invited %s (%s) into org %s",
        current_user.email,
        user.email,
        data.role.value,
        data.organization_id,
    )
    return SuperAdminUserResponse(
        id=user.id,
        email=user.email,
        role=user.role,
        organization_id=user.organization_id,
        first_name=user.first_name,
        last_name=user.last_name,
        is_active=user.is_active,
        created_at=user.created_at,
        derived_status=service.derived_status(user),
        last_login_at=user.last_login_at,
    )


@router.put("/users/{user_id}/role", response_model=SuperAdminUserResponse)
def change_super_admin_user_role(
    user_id: int,
    data: UserRoleChangeRequest,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """ZB-SA-P3 (Phase 3B): change a TENANT user's role.

    Reason mandatory; old→new recorded; self-role-change and super-admin
    targets rejected; ROLE_CREATION_RULES still gate which roles may be
    granted. Platform accounts keep using /users/{id}/platform-role."""
    from app.core.exceptions import BadRequestException

    service = UserAdminService(db)
    try:
        user = service.set_role(
            actor=current_user, user_id=user_id, new_role=data.role, reason=data.reason
        )
    except ValueError as exc:
        raise BadRequestException(str(exc)) from exc
    db.commit()
    db.refresh(user)
    logger.info(
        "Super admin %s changed role of user %s to %s",
        current_user.email,
        user.email,
        data.role.value,
    )
    return _super_admin_user_payload(user, service)


@router.put("/users/{user_id}/membership", response_model=SuperAdminUserResponse)
def change_super_admin_user_membership(
    user_id: int,
    data: UserMembershipChangeRequest,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """ZB-SA-P3 (Phase 3B): move a tenant user between organizations (or
    strip membership with null). Reason mandatory; audited; never allowed on
    super-admin platform accounts."""
    from app.core.exceptions import BadRequestException

    service = UserAdminService(db)
    try:
        user = service.set_membership(
            actor=current_user,
            user_id=user_id,
            organization_id=data.organization_id,
            reason=data.reason,
        )
    except ValueError as exc:
        raise BadRequestException(str(exc)) from exc
    db.commit()
    db.refresh(user)
    logger.info(
        "Super admin %s moved user %s membership to org %s",
        current_user.email,
        user.email,
        data.organization_id,
    )
    return _super_admin_user_payload(user, service)


def _super_admin_user_payload(user: User, service: UserAdminService) -> SuperAdminUserResponse:
    """Compose the enriched Phase 3B user payload for mutation responses."""
    org = (
        service.db.query(Organization)
        .filter(Organization.id == user.organization_id)
        .first()
        if user.organization_id
        else None
    )
    return SuperAdminUserResponse(
        id=user.id,
        email=user.email,
        role=user.role,
        organization_id=user.organization_id,
        organization_name=org.organization_name if org else None,
        organization_code=org.organization_code if org else None,
        first_name=user.first_name,
        last_name=user.last_name,
        is_active=user.is_active,
        created_at=user.created_at,
        derived_status=service.derived_status(user),
        last_login_at=user.last_login_at,
    )


@router.put("/users/{user_id}/platform-role", response_model=SuccessResponse)
def set_platform_role(
    user_id: int,
    platform_role: str,
    current_user=Depends(require_capability("platform_role.manage")),
    db: Session = Depends(get_db),
):
    """ZB-SA-CMD-003 §26 — assign a super_admin account's PlatformRole
    (least-privilege capability set). Only PLATFORM_ADMINISTRATOR holds
    the `platform_role.manage` capability (see capabilities.py's empty
    role-set for it — that's not a bug, it means "admin-only"), preventing
    a support/security/reliability operator from escalating their own or
    a peer's privileges. Self-demotion from PLATFORM_ADMINISTRATOR is
    intentionally allowed (unlike self-deactivation above) since it never
    drives active-Super-Admin count to zero and another platform
    administrator can always reverse it."""
    from app.core.exceptions import BadRequestException, NotFoundException
    from app.modules.auth.models import PlatformRole

    target = db.query(User).filter(User.id == user_id).first()
    if target is None:
        raise NotFoundException("User", "id")
    if target.role != UserRole.SUPER_ADMIN:
        raise BadRequestException("platform_role only applies to super_admin accounts.")

    try:
        new_role = PlatformRole(platform_role.lower())
    except ValueError:
        raise BadRequestException(
            f"Unknown platform_role {platform_role!r}. Valid values: {[r.value for r in PlatformRole]}"
        )

    old_role = target.platform_role.value if target.platform_role else "platform_administrator"
    target.platform_role = new_role

    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    PlatformAuditService(db).log_no_commit(
        actor_id=current_user.id,
        actor_role="super_admin",
        action=PlatformAuditAction.UPDATE,
        entity_type="User",
        entity_id=target.id,
        old_values={"platform_role": old_role},
        new_values={"platform_role": new_role.value},
    )
    db.commit()
    return {"message": f"Platform role for {target.email} set to {new_role.value}."}


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

_OPEN_SUBSCRIPTION_STATUSES = {
    CommercialSubscriptionStatus.PENDING,
    CommercialSubscriptionStatus.ACTIVE,
    CommercialSubscriptionStatus.SUSPENDED,
}


def _commercial_account_payload(account, org, db: Session, active_subs_by_account=None):
    from app.modules.commercial.service import CommercialAccountService

    can_charge = CommercialAccountService(db).can_charge(org)
    current = None
    if active_subs_by_account is not None:
        current = active_subs_by_account.get(account.id)
    else:
        from app.modules.commercial.service import CommercialSubscriptionService
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
            trial_ends_at=current.trial_ends_at,
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
    backfill: bool = Query(False),
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.modules.commercial.models import CommercialAccount, CommercialSubscription
    from app.modules.commercial.service import CommercialAccountService

    # Optional lazy backfill (idempotent): organizations provisioned before
    # Phase 6 may lack a CommercialAccount row.  The ?backfill=true flag
    # triggers the one-time sweep; the default read path skips it to stay fast.
    if backfill:
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

    # Batch-fetch active subscriptions for the page of accounts to avoid N+1.
    account_ids = [acc.id for acc, _ in rows]
    active_subs = (
        db.query(CommercialSubscription)
        .filter(
            CommercialSubscription.commercial_account_id.in_(account_ids),
            CommercialSubscription.status.in_(list(_OPEN_SUBSCRIPTION_STATUSES)),
        )
        .order_by(CommercialSubscription.id.desc())
        .all()
    ) if account_ids else []
    # Keep the first (most recent) subscription per account.
    active_subs_by_account: dict = {}
    for sub in active_subs:
        if sub.commercial_account_id not in active_subs_by_account:
            active_subs_by_account[sub.commercial_account_id] = sub

    return CommercialAccountListResponse(
        accounts=[
            _commercial_account_payload(acc, org, db, active_subs_by_account)
            for acc, org in rows
        ],
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
        trial_ends_at=subscription.trial_ends_at,
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
        expires_at=switch.expires_at,
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
        expires_at=switch.expires_at,
        changed_by_user_id=switch.changed_by_user_id,
        changed_by_email=switch.changed_by.email if switch.changed_by else None,
        changed_at=switch.changed_at,
        created_at=switch.created_at,
    )


# 
# ZB-SA-CMD-003 §9 — Domain B circuit breakers (generalized, session 7).
#
# Every scope below is REAL, server-enforced at its billing code path:
#   - tenant_invoice_finalization  → InvoiceService.finalize_invoice()/mark_sent()
#   - tenant_payment_attempts      → StripeService.create_payment_intent()/
#                                    create_checkout_session(), PaymentService.
#                                    record_attempt() (webhooks deliberately
#                                    NOT gated — in-flight processor activity)
#   - tenant_dunning               → DunningService.process_dunning()/
#                                    process_due_reminders()
#   - tenant_billing_communications→ InvoiceService.send_invoice_via_email(),
#                                    dunning reminder sends
# ("Freeze connector sync" / "Release freeze" have no live code path in this
# repository and are therefore NOT registered — see the catalog response.)
#
# Two change paths, per §9:
#   - Maker-checker (default): POST /circuit-breakers/{scope}/approval-request
#     creates an ApprovalRequest(request_type="circuit_breaker_change"); a
#     DIFFERENT Super Admin decides it via POST /approval-requests/{id}/decision
#     (self-approval rejected server-side in ApprovalService).
#   - Break-glass: PUT /circuit-breakers/{scope} applies directly but demands
#     fresh MFA step-up AND an incident_reference when engaging.
# All engaged pauses carry a mandatory bounded auto-expiry (§9.1).
# 

def _kill_switch_to_response(switch) -> BillingKillSwitchResponse:
    return BillingKillSwitchResponse(
        id=switch.id,
        scope=switch.scope,
        enabled=switch.enabled,
        reason=switch.reason,
        expires_at=switch.expires_at,
        changed_by_user_id=switch.changed_by_user_id,
        changed_by_email=switch.changed_by.email if switch.changed_by else None,
        changed_at=switch.changed_at,
        created_at=switch.created_at,
    )


def _breaker_state_response(scope: str, db: Session) -> BillingKillSwitchResponse:
    from app.modules.super_admin.kill_switch_service import BillingKillSwitchService

    switch = BillingKillSwitchService(db).effective_state(scope)
    db.commit()
    db.refresh(switch)
    return _kill_switch_to_response(switch)


def _apply_breaker_toggle(scope: str, data, current_user, db: Session) -> BillingKillSwitchResponse:
    """Shared break-glass toggle: fresh MFA step-up + audited state change."""
    from app.modules.auth.mfa_service import verify_step_up
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.kill_switch_service import BillingKillSwitchService
    from app.modules.super_admin.models import PlatformAuditAction

    verify_step_up(db, current_user, code=data.code, recovery_code=data.recovery_code)

    switch = BillingKillSwitchService(db).set_enabled(
        scope,
        data.enabled,
        reason=data.reason,
        actor_id=current_user.id,
        auto_expire_minutes=data.auto_expire_minutes,
    )

    PlatformAuditService(db).log_no_commit(
        actor_id=current_user.id,
        actor_role="super_admin",
        action=PlatformAuditAction.ACTIVATE if data.enabled else PlatformAuditAction.DEACTIVATE,
        entity_type="BillingKillSwitch",
        entity_id=switch.id,
        reason=f"{data.reason} [incident: {data.incident_reference}]"
        if data.incident_reference
        else data.reason,
        old_values={"enabled": not data.enabled},
        new_values={"enabled": data.enabled, "expires_at": switch.expires_at.isoformat() if switch.expires_at else None},
    )
    db.commit()
    db.refresh(switch)
    logger.warning(
        "Super Admin %s set circuit breaker '%s' enabled=%s (reason: %s, incident: %s, expires_at: %s)",
        current_user.email, scope, data.enabled, data.reason,
        data.incident_reference, switch.expires_at,
    )
    return _kill_switch_to_response(switch)


@router.get("/circuit-breakers", response_model=CircuitBreakerCatalogResponse)
def list_circuit_breakers(
    current_user=Depends(require_capability("circuit_breaker.read")),
    db: Session = Depends(get_db),
):
    """§9.1 catalog with blast-radius preview metadata + live state."""
    from datetime import datetime as _dt

    from app.modules.super_admin.kill_switch_service import (
        DOMAIN_B_BREAKER_CATALOG,
        BillingKillSwitchService,
    )

    svc = BillingKillSwitchService(db)
    entries = []
    for scope, meta in DOMAIN_B_BREAKER_CATALOG.items():
        switch = svc.effective_state(scope)
        entries.append(
            CircuitBreakerCatalogEntry(
                scope=scope,
                display_name=meta["display_name"],
                domain=meta["domain"],
                effect=meta["effect"],
                gated_paths=meta["gated_paths"],
                enabled=switch.enabled,
                expires_at=switch.expires_at,
                reason=switch.reason,
                changed_by_email=switch.changed_by.email if switch.changed_by else None,
                changed_at=switch.changed_at,
            )
        )
    db.commit()
    return CircuitBreakerCatalogResponse(breakers=entries, generated_at=_dt.utcnow())


@router.get("/circuit-breakers/{scope}", response_model=BillingKillSwitchResponse)
def get_circuit_breaker(
    scope: str,
    current_user=Depends(require_capability("circuit_breaker.read")),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import NotFoundException
    from app.modules.super_admin.kill_switch_service import KNOWN_BREAKER_SCOPES

    if scope not in KNOWN_BREAKER_SCOPES:
        raise NotFoundException(f"Unknown circuit breaker scope '{scope}'.")
    return _breaker_state_response(scope, db)


@router.put("/circuit-breakers/{scope}", response_model=BillingKillSwitchResponse)
def set_circuit_breaker(
    scope: str,
    data: CircuitBreakerToggleRequest,
    current_user=Depends(require_capability("circuit_breaker.manage")),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException, NotFoundException
    from app.modules.super_admin.kill_switch_service import KNOWN_BREAKER_SCOPES

    if scope not in KNOWN_BREAKER_SCOPES:
        raise NotFoundException(f"Unknown circuit breaker scope '{scope}'.")
    if scope == "commercial_subscription_charging":
        raise BadRequestException(
            "Use PUT /super-admin/billing-kill-switch for the commercial "
            "subscription charging switch."
        )
    return _apply_breaker_toggle(scope, data, current_user, db)


@router.post("/circuit-breakers/{scope}/approval-request", response_model=ApprovalRequestResponse)
def propose_circuit_breaker_change(
    scope: str,
    data: CircuitBreakerChangeProposalCreate,
    current_user=Depends(require_capability("circuit_breaker.manage")),
    db: Session = Depends(get_db),
):
    """Maker-checker path (§9 default): stage a breaker change for review by
    a different Super Admin. No state changes here — only the request row."""
    from app.core.exceptions import BadRequestException, NotFoundException
    from app.modules.commercial.enums import ApprovalStatus  # noqa: F401 (status used via service)
    from app.modules.super_admin.approval_service import ApprovalService
    from app.modules.super_admin.kill_switch_service import (
        DEFAULT_AUTO_EXPIRE_MINUTES,
        KNOWN_BREAKER_SCOPES,
        MAX_AUTO_EXPIRE_MINUTES,
        MIN_AUTO_EXPIRE_MINUTES,
    )

    if scope not in KNOWN_BREAKER_SCOPES or scope == "commercial_subscription_charging":
        raise NotFoundException(f"Unknown or non-Domain-B circuit breaker scope '{scope}'.")

    expire_minutes = data.auto_expire_minutes
    if data.enabled:
        expire_minutes = None  # releasing clears any expiry
    elif expire_minutes is None:
        expire_minutes = DEFAULT_AUTO_EXPIRE_MINUTES
    if expire_minutes is not None and not (MIN_AUTO_EXPIRE_MINUTES <= expire_minutes <= MAX_AUTO_EXPIRE_MINUTES):
        raise BadRequestException(
            f"auto_expire_minutes must be between {MIN_AUTO_EXPIRE_MINUTES} and {MAX_AUTO_EXPIRE_MINUTES}."
        )

    request = ApprovalService(db).create_request(
        request_type="circuit_breaker_change",
        requested_by_user_id=current_user.id,
        reason=data.reason,
        scope={"breaker_scope": scope},
        proposed_state={
            "enabled": data.enabled,
            "reason": data.reason,
            "incident_reference": data.incident_reference,
            "auto_expire_minutes": expire_minutes,
        },
    )

    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    PlatformAuditService(db).log_no_commit(
        actor_id=current_user.id,
        actor_role="super_admin",
        action=PlatformAuditAction.CREATE,
        entity_type="ApprovalRequest",
        entity_id=request.id,
        reason=f"Proposed circuit breaker change '{scope}': enabled={data.enabled}. {data.reason}",
        new_values={"request_type": "circuit_breaker_change", "scope": scope, "proposed_state": request.proposed_state},
    )
    db.commit()
    db.refresh(request)

    return ApprovalRequestResponse(
        id=request.id,
        request_type=request.request_type,
        requested_by_user_id=request.requested_by_user_id,
        requested_by_email=current_user.email,
        requested_at=request.requested_at,
        reason=request.reason,
        scope=request.scope,
        before_state=request.before_state,
        proposed_state=request.proposed_state,
        evidence=request.evidence,
        status=request.status,
        correlation_id=request.correlation_id,
    )


@router.post("/approval-requests/{request_id}/decision", response_model=ApprovalRequestResponse)
def decide_approval_request(
    request_id: int,
    data: ApprovalDecisionRequest,
    current_user=Depends(require_capability("circuit_breaker.manage")),
    db: Session = Depends(get_db),
):
    """Generic checker endpoint. Currently dispatches exactly one request
    type — "circuit_breaker_change" — and, on approval, APPLIES the proposed
    breaker state through the same audited service path as break-glass.
    Self-approval is rejected server-side by ApprovalService."""
    from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
    from app.modules.auth.mfa_service import verify_step_up
    from app.modules.super_admin.approval_service import ApprovalService, SelfApprovalError
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.kill_switch_service import BillingKillSwitchService
    from app.modules.super_admin.models import PlatformAuditAction

    request = ApprovalService(db).get_request(request_id)
    if request is None:
        raise NotFoundException(f"ApprovalRequest {request_id} not found.")
    if request.request_type != "circuit_breaker_change":
        raise BadRequestException(
            f"Request type '{request.request_type}' is decided on its own domain endpoint, "
            "not via the generic decision endpoint."
        )

    # The checker authenticates with the same depth as the maker.
    verify_step_up(db, current_user, code=data.code, recovery_code=data.recovery_code)

    try:
        if data.decision == "approve":
            request = ApprovalService(db).approve(request, approver_user_id=current_user.id)
            proposed = request.proposed_state or {}
            switch = BillingKillSwitchService(db).set_enabled(
                (request.scope or {}).get("breaker_scope", ""),
                bool(proposed.get("enabled")),
                reason=f"[approved request #{request.id}] {proposed.get('reason', request.reason)}",
                actor_id=current_user.id,
                auto_expire_minutes=proposed.get("auto_expire_minutes"),
            )
            audit_action = PlatformAuditAction.ACTIVATE if switch.enabled else PlatformAuditAction.DEACTIVATE
            detail = {"enabled": switch.enabled, "expires_at": switch.expires_at.isoformat() if switch.expires_at else None}
        else:
            request = ApprovalService(db).reject(request, approver_user_id=current_user.id, rejection_reason=data.reason)
            audit_action = PlatformAuditAction.UPDATE
            detail = {"rejected": True}
    except SelfApprovalError as exc:
        raise ForbiddenException(str(exc))

    PlatformAuditService(db).log_no_commit(
        actor_id=current_user.id,
        actor_role="super_admin",
        action=audit_action,
        entity_type="ApprovalRequest",
        entity_id=request.id,
        reason=data.reason,
        old_values={"status": "PENDING"},
        new_values={"status": request.status.name if hasattr(request.status, "name") else str(request.status), **detail},
    )
    db.commit()
    db.refresh(request)

    return ApprovalRequestResponse(
        id=request.id,
        request_type=request.request_type,
        requested_by_user_id=request.requested_by_user_id,
        requested_by_email=request.requested_by.email if request.requested_by else None,
        requested_at=request.requested_at,
        reason=request.reason,
        scope=request.scope,
        before_state=request.before_state,
        proposed_state=request.proposed_state,
        evidence=request.evidence,
        approver_user_id=request.approver_user_id,
        approver_email=request.approver.email if request.approver else None,
        approved_at=request.approved_at,
        rejection_reason=request.rejection_reason,
        status=request.status,
        correlation_id=request.correlation_id,
    )


# Legacy single-scope endpoints (kept for backward compatibility with the
# session-6 frontend/tests; thin delegates to the generic implementations).

@router.get("/circuit-breakers/tenant-invoice-finalization", response_model=BillingKillSwitchResponse)
def get_tenant_invoice_finalization_breaker(
    current_user=Depends(require_capability("circuit_breaker.read")),
    db: Session = Depends(get_db),
):
    from app.modules.super_admin.kill_switch_service import TENANT_INVOICE_FINALIZATION

    return _breaker_state_response(TENANT_INVOICE_FINALIZATION, db)


@router.put("/circuit-breakers/tenant-invoice-finalization", response_model=BillingKillSwitchResponse)
def set_tenant_invoice_finalization_breaker(
    data: CircuitBreakerToggleRequest,
    current_user=Depends(require_capability("circuit_breaker.manage")),
    db: Session = Depends(get_db),
):
    from app.modules.super_admin.kill_switch_service import TENANT_INVOICE_FINALIZATION

    return _apply_breaker_toggle(TENANT_INVOICE_FINALIZATION, data, current_user, db)


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


# ── Phase 3F F5: subscription plan change ────────────────────────────────────


@router.post(
    "/commercial-subscriptions/{subscription_id}/change-plan",
    response_model=CommercialSubscriptionResponse,
)
def change_commercial_subscription_plan(
    subscription_id: int,
    data: CommercialSubscriptionPlanChange,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Replace an open subscription with one on a different plan.

    The previous subscription is CANCELLED (history preserved) and a
    replacement is created; if the previous one was ACTIVE the replacement is
    activated in the same transaction, re-running every real-charging guard.
    Both the platform audit trail and the org-scoped billing trail are
    written with the mandatory reason and a shared correlation id.
    """
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

    new_plan = db.query(CommercialPlan).filter(CommercialPlan.id == data.new_plan_id).first()
    if new_plan is None:
        raise NotFoundException("Commercial Plan", "id")

    service = CommercialSubscriptionService(db)
    try:
        replacement = service.change_plan(
            subscription,
            new_plan,
            actor_id=getattr(current_user, "id", None),
            reason=data.reason,
        )
    except ValueError as exc:
        raise BadRequestException(str(exc))

    db.commit()
    db.refresh(replacement)

    account = (
        db.query(CommercialAccount)
        .filter(CommercialAccount.id == replacement.commercial_account_id)
        .first()
    )
    org = (
        db.query(Organization).filter(Organization.id == account.organization_id).first()
        if account
        else None
    )
    return _subscription_payload(replacement, org, new_plan)


# ── Phase 3F F10: honest Plane 1 SaaS reporting read model ──────────────────


@router.get("/commercial-reporting", response_model=SaasReportingResponse)
def get_saas_commercial_reporting(
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Real counts plus MRR computed only from priced published catalog
    versions. Zero-priced catalogues report MRR as UNKNOWN — never zero,
    never fabricated (mirrors COM-01 honesty rules)."""
    return SaasReportingService(db).get_reporting()


# ── Platform settings & configuration governance (Phase 4, G-02/G-03) ───────
# Reads require the platform_config.read capability; every mutation requires
# platform_config.manage, stamps the acting user onto the row, and writes a
# PlatformAudit record in the SAME transaction (log_no_commit + one commit).
# Sensitive values are never written into audit payloads — only the fact that
# a value changed.


def _setting_audit_values(setting: "PlatformSetting", *, include_value: bool) -> dict:
    """Audit-safe projection of a setting. Sensitive keys contribute only a
    change marker, never their raw value."""
    from app.modules.super_admin.schemas import is_sensitive_setting_key

    payload = {
        "key": setting.key,
        "category": setting.category,
        "is_public": setting.is_public,
        "description": setting.description,
    }
    if include_value:
        payload["value_changed"] = True if is_sensitive_setting_key(setting.key) else None
        if not is_sensitive_setting_key(setting.key):
            payload["value"] = setting.value
    return {k: v for k, v in payload.items() if v is not None or k != "description"}


@router.get("/configuration", response_model=ConfigurationInventoryResponse)
def get_configuration_inventory(
    current_user=Depends(require_capability("platform_config.read")),
    db: Session = Depends(get_db),
):
    """Authoritative inventory of the configuration that governs this control
    plane: DB-backed platform settings, code-declared operational thresholds
    imported live from their owning modules (cannot drift from enforcement),
    and environment capability status (presence only — secret values are
    never exposed)."""
    from app.modules.super_admin.configuration_service import ConfigurationGovernanceService, display_entries

    inventory = ConfigurationGovernanceService(db).get_inventory()
    inventory["entries"] = display_entries(inventory["entries"])
    return inventory


@router.get("/settings", response_model=list[SettingResponse])
def list_settings(
    current_user=Depends(require_capability("platform_config.read")),
    db: Session = Depends(get_db),
):
    from app.modules.super_admin.models import PlatformSetting

    rows = db.query(PlatformSetting).order_by(PlatformSetting.key).all()
    responses = [SettingResponse.model_validate(row) for row in rows]
    for row, response in zip(rows, responses):
        response.updated_by_email = row.updated_by.email if row.updated_by else None
    return responses


@router.post("/settings", response_model=SettingResponse)
def create_setting(
    data: SettingCreate,
    current_user=Depends(require_capability("platform_config.manage")),
    db: Session = Depends(get_db),
):
    from uuid import uuid4

    from app.core.exceptions import AlreadyExistsException
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction, PlatformSetting

    existing = db.query(PlatformSetting).filter(PlatformSetting.key == data.key).first()
    if existing:
        raise AlreadyExistsException("Setting", "key")
    setting = PlatformSetting(**data.model_dump(), updated_by_user_id=current_user.id)
    db.add(setting)
    db.flush()  # assign PK before writing the audit row
    correlation_id = f"cfg-{uuid4().hex[:12]}"
    PlatformAuditService(db).log_no_commit(
        actor_id=current_user.id,
        actor_role="super_admin",
        action=PlatformAuditAction.CREATE,
        entity_type="PlatformSetting",
        entity_id=setting.id,
        old_values=None,
        new_values=_setting_audit_values(setting, include_value=True),
        correlation_id=correlation_id,
        metadata={"capability": "platform_config.manage"},
    )
    db.commit()
    db.refresh(setting)
    response = SettingResponse.model_validate(setting)
    response.updated_by_email = current_user.email
    return response


@router.put("/settings/{key}", response_model=SettingResponse)
def update_setting(
    key: str,
    data: SettingUpdate,
    current_user=Depends(require_capability("platform_config.manage")),
    db: Session = Depends(get_db),
):
    from uuid import uuid4

    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction, PlatformSetting

    setting = db.query(PlatformSetting).filter(PlatformSetting.key == key).first()
    created = setting is None
    old_values = _setting_audit_values(setting, include_value=True) if setting else None
    if created:
        setting = PlatformSetting(key=key)
        db.add(setting)
    value_changed = False
    if data.value is not None and data.value != setting.value:
        setting.value = data.value
        value_changed = True
    description_changed = False
    if data.description is not None and data.description != setting.description:
        setting.description = data.description
        description_changed = True
    category_changed = False
    if data.category is not None and data.category != setting.category:
        setting.category = data.category
        category_changed = True
    is_public_changed = False
    if data.is_public is not None and data.is_public != setting.is_public:
        setting.is_public = data.is_public
        is_public_changed = True

    setting.updated_by_user_id = current_user.id
    db.flush()
    # Only write an audit row when something actually changed — a no-op PUT
    # is still capability-gated but produces no false audit evidence.
    if created or value_changed or description_changed or category_changed or is_public_changed:
        correlation_id = f"cfg-{uuid4().hex[:12]}"
        PlatformAuditService(db).log_no_commit(
            actor_id=current_user.id,
            actor_role="super_admin",
            action=PlatformAuditAction.CREATE if created else PlatformAuditAction.UPDATE,
            entity_type="PlatformSetting",
            entity_id=setting.id,
            old_values=old_values,
            new_values=_setting_audit_values(setting, include_value=value_changed),
            correlation_id=correlation_id,
            metadata={"capability": "platform_config.manage"},
        )
    db.commit()
    db.refresh(setting)
    response = SettingResponse.model_validate(setting)
    response.updated_by_email = current_user.email
    return response


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

    # COM-01 — REAL DB query: at least one PUBLISHED, priced CommercialPlanVersion
    # must exist, and none of the priced ones may still be flagged as
    # placeholder pricing (seed_commercial_plans.py) for this to be a true PASS.
    from app.modules.commercial.enums import CommercialPlanVersionStatus
    from app.modules.commercial.models import CommercialPlanVersion

    priced_versions = (
        db.query(CommercialPlanVersion)
        .filter(
            CommercialPlanVersion.status == CommercialPlanVersionStatus.PUBLISHED,
            CommercialPlanVersion.price_amount.isnot(None),
        )
        .all()
    )
    placeholder_codes = [
        v.plan.plan_code for v in priced_versions
        if v.is_placeholder_pricing and v.plan is not None
    ]
    if not priced_versions:
        com01_status = "NOT_CONFIGURED"
        com01_evidence = "No published CommercialPlanVersion carries a non-null price_amount yet; no price book exists in this environment (ZB-COM-BILL-001 §B2)."
    elif placeholder_codes:
        com01_status = "WARNING"
        com01_evidence = (
            f"{len(priced_versions)} published, priced CommercialPlanVersion(s) exist, but "
            f"{len(placeholder_codes)} of them ({', '.join(sorted(placeholder_codes))}) are still "
            "flagged is_placeholder_pricing — seeded for structural completeness, not yet an "
            "approved price list (ZB-COM-BILL-001 §B2)."
        )
    else:
        com01_status = "PASS"
        com01_evidence = f"{len(priced_versions)} published CommercialPlanVersion(s) carry approved (non-placeholder) pricing."
    items.append(ProductionAcceptanceItem(
        id="COM-01",
        criterion="Four-plan taxonomy matches website/app/processor/contracts; all prices and limits resolve from one APPROVED catalog version.",
        status=com01_status,
        evidence=com01_evidence,
    ))

    # COM-02 — REAL DB query against CommercialEvaluationProgram (§B3).
    from app.modules.commercial.models import CommercialEvaluationProgram

    active_programs = (
        db.query(CommercialEvaluationProgram)
        .filter(CommercialEvaluationProgram.is_active.is_(True))
        .all()
    )
    if not active_programs:
        com02_status = "PASS"
        com02_evidence = (
            "No active CommercialEvaluationProgram exists — no plan currently grants a "
            "trial. Consistent with §B3 (no free offer assumed)."
        )
    else:
        missing_governance = [p for p in active_programs if p.approved_by is None]
        if missing_governance:
            com02_status = "FAIL"
            com02_evidence = (
                f"{len(missing_governance)} active evaluation program(s) have no approved_by — "
                "a trial is live without a logged commercial approval."
            )
        else:
            com02_status = "PASS"
            com02_evidence = (
                f"{len(active_programs)} active evaluation program(s), each with duration_days, "
                "payment_requirement, conversion_policy, expiry_action, and a logged approver — "
                "matches §B3's bounded-configuration requirement."
            )
    items.append(ProductionAcceptanceItem(
        id="COM-02",
        criterion="Evaluation/trial behavior is explicitly approved; no unintended free-trial copy or auto-conversion path exists.",
        status=com02_status,
        evidence=com02_evidence,
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
            "RBAC exists (super_admin/org_admin/billing_admin, server-enforced). Backend-enforced TOTP MFA exists "
            "as a STEP-UP factor for every privileged Super Admin action (mfa_service.py): normal login issues a "
            "real token on a valid password for every role (no login-time MFA gate, per the ZB-SA-CMD-003 v3.0 "
            "master directive), but tenant-access activation, circuit-breaker toggles/proposals/decisions each "
            "demand a fresh TOTP code or single-use recovery code verified server-side at the moment of the "
            "action (verify_step_up) -- with replay protection and no bypass. Secrets are encrypted at rest with "
            "a key separate from the JWT signing key (core/mfa_crypto.py); recovery codes are stored only as "
            "SHA-256 hashes. Brute-force protection (account lockout after repeated failures) and an audited "
            "administrative break-glass reset (MFA_ADMIN_RESET) both exist. Remaining gap: DUAL CONTROL now "
            "covers circuit-breaker changes (maker-checker via ApprovalRequest) but other single-actor Super "
            "Admin actions (MFA admin-reset, org deletion) still require only one authenticated actor, and "
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

    # REC-01 — the reconciliation engine is now implemented and evaluated
    # from real artifacts (models + service + endpoints + scheduled job),
    # never asserted. Status derives from actual ReconciliationRun rows.
    from app.modules.super_admin.models import (
        ReconciliationException,
        ReconciliationExceptionStatus,
        ReconciliationRun,
    )

    latest_run = (
        db.query(ReconciliationRun)
        .filter(ReconciliationRun.plane == "plane2")
        .order_by(ReconciliationRun.started_at.desc())
        .first()
    )
    if latest_run is None:
        items.append(ProductionAcceptanceItem(
            id="REC-01",
            criterion="Daily/periodic reconciliation compares Zoiko ledger to processor and downstream systems with exception ownership.",
            status="WARNING",
            evidence=(
                "IMPLEMENTED, NOT YET EXECUTED HERE: engine exists "
                "(reconciliation_runs/reconciliation_exceptions tables, "
                "ReconciliationService with invoice-balance-arithmetic and "
                "payment-allocation-integrity checks, exception "
                "OPEN->ACKNOWLEDGED->RESOLVED ownership workflow, manual "
                "POST /super-admin/reconciliation-runs/run endpoint, daily "
                "'reconciliation_job' in core/scheduler.py) but no run has "
                "been recorded in this environment yet."
            ),
        ))
    else:
        open_exceptions = (
            db.query(ReconciliationException)
            .filter(
                ReconciliationException.run_id == latest_run.id,
                ReconciliationException.status != ReconciliationExceptionStatus.RESOLVED,
            )
            .count()
        )
        if open_exceptions > 0:
            items.append(ProductionAcceptanceItem(
                id="REC-01",
                criterion="Daily/periodic reconciliation compares Zoiko ledger to processor and downstream systems with exception ownership.",
                status="FAIL",
                evidence=(
                    f"Latest reconciliation run #{latest_run.id} is {str(latest_run.state).upper()} "
                    f"with {open_exceptions} unresolved exception(s). Engine and ownership "
                    f"workflow are live; resolve or acknowledge the exceptions, then re-run "
                    f"(POST /super-admin/reconciliation-runs/run)."
                ),
            ))
        elif (latest_run.state.value if hasattr(latest_run.state, "value") else str(latest_run.state)) == "partial":
            items.append(ProductionAcceptanceItem(
                id="REC-01",
                criterion="Daily/periodic reconciliation compares Zoiko ledger to processor and downstream systems with exception ownership.",
                status="WARNING",
                evidence=(
                    f"Latest run #{latest_run.id}: all internal ledger invariants verified "
                    f"({latest_run.checks_total} checks, 0 exceptions), but the processor leg "
                    f"is not connected yet ({latest_run.processor_note}) - ISS-017. A clean "
                    f"run without a processor/bank source honestly caps at PARTIAL rather "
                    f"than claiming full ledger-vs-processor VERIFIED."
                ),
            ))
        elif (latest_run.state.value if hasattr(latest_run.state, "value") else str(latest_run.state)) == "failed":
            # Defensive: FAILED state should always carry open exceptions.
            items.append(ProductionAcceptanceItem(
                id="REC-01",
                criterion="Daily/periodic reconciliation compares Zoiko ledger to processor and downstream systems with exception ownership.",
                status="FAIL",
                evidence=(
                    f"Latest reconciliation run #{latest_run.id} ended FAILED "
                    f"({latest_run.exceptions_found} exception(s)); see "
                    f"/super-admin/reconciliation-runs/{latest_run.id}."
                ),
            ))
        else:
            items.append(ProductionAcceptanceItem(
                id="REC-01",
                criterion="Daily/periodic reconciliation compares Zoiko ledger to processor and downstream systems with exception ownership.",
                status="PASS",
                evidence=(
                    f"Latest run #{latest_run.id} fully VERIFIED including a connected "
                    f"processor source ({latest_run.processor_source})."
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
    # from frontend/UI presence. Any FAIL is a mandatory blocker; WARNING/
    # NOT_CONFIGURED items keep the platform out of an unconditional "READY"
    # but do not block a supervised go-live the way a FAIL does.
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


# 
# ZB-SA-CMD-003 §6/§7 — Domain B: privileged tenant support access.
#
# Every endpoint below is super_admin-only, and every mutation additionally
# re-verifies the grant belongs to the calling actor (see
# PrivilegedAccessService._load_owned_grant) — there is no path for one
# Super Admin to see or act on another's privileged-access grant.
# 

def _grant_to_response(grant) -> PrivilegedAccessGrantResponse:
    data = PrivilegedAccessGrantResponse.model_validate(grant)
    data.organization_name = grant.organization.organization_name if grant.organization else None
    return data


@router.post("/privileged-access/request", response_model=PrivilegedAccessGrantResponse)
def request_privileged_access(
    payload: PrivilegedAccessRequestCreate,
    current_user=Depends(require_capability('tenant_support.request')),
    db: Session = Depends(get_db),
):
    grant = PrivilegedAccessService(db).request_access(
        actor=current_user,
        organization_id=payload.organization_id,
        reason=payload.reason,
        ticket_reference=payload.ticket_reference,
        requested_minutes=payload.requested_minutes,
    )
    return _grant_to_response(grant)


@router.post("/privileged-access/{grant_id}/activate", response_model=PrivilegedAccessGrantResponse)
def activate_privileged_access(
    grant_id: int,
    payload: PrivilegedAccessStepUp,
    current_user=Depends(require_capability('tenant_support.activate')),
    db: Session = Depends(get_db),
):
    grant = PrivilegedAccessService(db).activate(
        actor=current_user,
        grant_id=grant_id,
        code=payload.code,
        recovery_code=payload.recovery_code,
    )
    return _grant_to_response(grant)


@router.get("/privileged-access/active", response_model=Optional[PrivilegedAccessGrantResponse])
def get_active_privileged_access(
    current_user=Depends(require_capability('tenant_support.request')),
    db: Session = Depends(get_db),
):
    grant = PrivilegedAccessService(db).get_active_or_pending_grant(current_user)
    return _grant_to_response(grant) if grant else None


@router.post("/privileged-access/{grant_id}/exit", response_model=PrivilegedAccessGrantResponse)
def exit_privileged_access(
    grant_id: int,
    current_user=Depends(require_capability('tenant_support.exit')),
    db: Session = Depends(get_db),
):
    grant = PrivilegedAccessService(db).exit_grant(current_user, grant_id)
    return _grant_to_response(grant)


@router.get("/privileged-access/mine", response_model=PrivilegedAccessGrantListResponse)
def list_my_privileged_access(
    limit: int = Query(20, ge=1, le=100),
    current_user=Depends(require_capability('tenant_support.request')),
    db: Session = Depends(get_db),
):
    grants = PrivilegedAccessService(db).list_my_grants(current_user, limit=limit)
    return PrivilegedAccessGrantListResponse(grants=[_grant_to_response(g) for g in grants])


@router.get("/privileged-access/{grant_id}/tenant-summary", response_model=TenantAccessSummaryResponse)
def get_privileged_access_tenant_summary(
    grant_id: int,
    current_user=Depends(require_capability('tenant_support.request')),
    db: Session = Depends(get_db),
):
    """Read-only Domain B snapshot, built from the same authoritative
    BillingDashboardService the tenant's own dashboard uses — never
    recomputed or estimated here. No export/download action exists for
    this endpoint anywhere in the frontend."""
    summary = PrivilegedAccessService(db).get_tenant_summary(current_user, grant_id)
    return TenantAccessSummaryResponse(**summary)


# 
# ZB-SA-CMD-003 §8 — Domain C: cross-tenant operational telemetry only.
# Counts, rates and job-run history — never a monetary figure. See
# telemetry_service.py's module docstring for what is deliberately NOT
# reported (queue age / connector state have no real backing data today).
# 

@router.get("/telemetry/organizations", response_model=OrganizationHealthResponse)
def get_organization_telemetry(
    current_user=Depends(require_capability('reliability.read')),
    db: Session = Depends(get_db),
):
    return OrganizationHealthResponse(**TelemetryService(db).get_organization_health())


@router.get("/telemetry/jobs", response_model=JobHealthListResponse)
def get_job_telemetry(
    current_user=Depends(require_capability('reliability.read')),
    db: Session = Depends(get_db),
):
    from app.config import settings

    jobs = TelemetryService(db).get_job_health()
    return JobHealthListResponse(jobs=jobs, scheduler_enabled=settings.ENABLE_RECURRING_BILLING_SCHEDULER)


@router.get("/telemetry/api", response_model=dict)
def get_api_telemetry(
    current_user=Depends(require_capability('reliability.read')),
):
    """Phase 4 (G-05) — real server-side latency/error telemetry for
    /api/super-admin/* over the sliding window (core/api_metrics.py).
    Single-process, in-memory: resets on restart; an empty window reports
    zero samples with None rates, never a fabricated healthy 0%."""
    import app.core.api_metrics as api_metrics

    snapshot = dict(api_metrics.snapshot())
    # §11 Reliability lens — SLOs / error budgets are NOT CONFIGURED on this
    # platform today: there is no target registry and no burn-rate
    # computation. The single enforced objective is the §18.2 p95 server
    # latency budget reported alongside. The absence is surfaced explicitly
    # instead of implying coverage that does not exist.
    snapshot["slo"] = {
        "status": "NOT_CONFIGURED",
        "reason": (
            "No SLO targets or error-budget policy are registered for this "
            "platform. The p95 latency budget reported here is the only "
            "enforced objective (ZB-SA-CMD-003 §18.2)."
        ),
        "p95_budget_ms": api_metrics.P95_BUDGET_MS,
    }
    return snapshot


@router.get("/telemetry/tenant-health", response_model=TenantHealthOverviewResponse)
def get_tenant_health_overview(
    current_user=Depends(require_capability('reliability.read')),
    db: Session = Depends(get_db),
):
    """ZB-SA-P3 (Phase 3D): per-tenant operational health — lifecycle states,
    user counts, open incidents with worst severity and last activity evidence.
    Domain C purity: counts/states/timestamps only, never money, never a
    derived health score."""
    return TenantHealthOverviewResponse.model_validate(
        TelemetryService(db).get_tenant_health_overview()
    )


# 
# ZB-SA-CMD-003 §10.1 — Metric Dictionary v1 (read-only, code-versioned registry)
# 

@router.get("/metric-dictionary", response_model=MetricDictionaryResponse)
def get_metric_dictionary(
    domain: Optional[str] = Query(None, description="Filter by domain: B | C | governance"),
    current_user=Depends(require_capability('metric_dictionary.read')),
):
    metrics = [m.to_dict() for m in metric_dictionary.list_metrics(domain=domain)]
    return MetricDictionaryResponse(metrics=metrics)


# 
# ZB-SA-CMD-003 §13 — global identity-first search (command palette backing)
# 

@router.get("/search", response_model=SearchResponse)
def global_search(
    q: str = Query(..., min_length=1, max_length=200),
    current_user=Depends(require_capability('global_search.read')),
    db: Session = Depends(get_db),
):
    results = GlobalSearchService(db).search(q)
    return SearchResponse(query=q, results=results)


# 
# ZB-SA-CMD-003 §23 — Launch Readiness (real checks — see launch_readiness_service.py)
# 

@router.get("/launch-readiness", response_model=LaunchReadinessResponse)
def get_launch_readiness(
    current_user=Depends(require_capability('launch_readiness.read')),
    db: Session = Depends(get_db),
):
    return LaunchReadinessResponse(**LaunchReadinessService(db).evaluate())


# 
# Phase 15 — internal financial (allocation) consistency check.
# NOT reconciliation against a processor/bank — see the service module
# docstring and ISS-017 for why that remains genuinely blocked.
# 

@router.get("/financial-consistency", response_model=FinancialConsistencyResponse)
def get_financial_consistency(
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    return FinancialConsistencyResponse(**FinancialConsistencyService(db).check_allocation_consistency())


@router.get("/financial-operations", response_model=FinancialOperationsSummaryResponse)
def get_financial_operations_summary(
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    """ZB-SA-CMD-003 §15 — Phase 2C Financial Operations aggregate.

    Composes F1 Billings/Collections, F2 Payment Recovery, F3 Reconciliation &
    Integrity, and F4 Revenue Leakage into a single read-model response.
    All values are real database aggregates — no client-side math, no fabricated
    numbers.
    """
    summary = FinancialConsistencyService(db).get_financial_operations_summary()
    from app.modules.super_admin.schemas import (
        FinancialBillingsSummary, FinancialRecoverySummary, FinancialLeakageSummary,
    )
    return FinancialOperationsSummaryResponse(
        consistency=FinancialConsistencyResponse(**summary["consistency"]),
        billings=FinancialBillingsSummary(**summary["billings"]),
        recovery=FinancialRecoverySummary(**summary["recovery"]),
        leakage=FinancialLeakageSummary(**summary["leakage"]),
    )


#
# Financial Operations detail pages — cross-tenant read models backing the
# 7 Financial Operations sidebar sub-pages (Invoice Engine, Payments &
# Disputes, Balances & Allocations, Credits/Adjustments/Refunds, Tax).
# Reconciliation's endpoints live further below (REC-01, pre-existing).
# Usage & Metering and e-invoicing have no endpoints here on purpose — no
# backing data model exists anywhere in this codebase for either.
#

def _fo_detail_service(db: Session) -> "FinancialOperationsDetailService":
    from app.modules.super_admin.financial_operations_detail_service import FinancialOperationsDetailService

    return FinancialOperationsDetailService(db)


@router.get("/financial-operations/invoice-status-distribution", response_model=InvoiceStatusDistributionResponse)
def get_invoice_status_distribution(
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    return _fo_detail_service(db).invoice_status_distribution()


@router.get("/financial-operations/invoice-delivery-diagnostics", response_model=InvoiceDeliveryDiagnosticsResponse)
def get_invoice_delivery_diagnostics(
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    return _fo_detail_service(db).invoice_delivery_diagnostics()


@router.get("/financial-operations/failed-payments", response_model=FailedPaymentListResponse)
def list_failed_payments(
    limit: int = Query(50, ge=1, le=200),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    return _fo_detail_service(db).list_failed_payments(limit)


@router.get("/financial-operations/dunning-cases", response_model=DunningCaseListResponse)
def list_dunning_cases(
    limit: int = Query(50, ge=1, le=200),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    return _fo_detail_service(db).list_dunning_cases(limit)


@router.get("/financial-operations/allocation-exceptions", response_model=AllocationExceptionListResponse)
def list_allocation_exceptions(
    limit: int = Query(50, ge=1, le=200),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    return _fo_detail_service(db).list_allocation_exceptions(limit)


@router.get("/financial-operations/credit-applications", response_model=CreditApplicationListResponse)
def list_credit_applications(
    limit: int = Query(50, ge=1, le=200),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    return _fo_detail_service(db).list_credit_applications(limit)


@router.get("/financial-operations/credit-notes", response_model=CreditNoteListResponse)
def list_credit_notes(
    limit: int = Query(50, ge=1, le=200),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    return _fo_detail_service(db).list_credit_notes(limit)


@router.get("/financial-operations/refunds", response_model=RefundListResponse)
def list_refunds(
    limit: int = Query(50, ge=1, le=200),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    return _fo_detail_service(db).list_refunds(limit)


@router.get("/financial-operations/write-offs", response_model=WriteOffListResponse)
def list_write_offs(
    limit: int = Query(50, ge=1, le=200),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    return _fo_detail_service(db).list_write_offs(limit)


@router.get("/financial-operations/tax-summary", response_model=TaxSummaryResponse)
def get_tax_summary(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    return _fo_detail_service(db).get_tax_summary(date_from, date_to)


#
# ZB-SA-CMD-003 — Billing Command Center (Domain B read models). Composes the
# /super-admin/billing-command-center page from real billing tables only.
# Same currency-honesty rules as /financial-operations: per-currency buckets,
# scalar totals only when single-currency, primary-currency figures labeled.
# 


def _bcc_service(db: Session) -> "BillingCommandCenterService":
    from app.modules.super_admin.billing_command_center_service import BillingCommandCenterService

    return BillingCommandCenterService(db)


@router.get("/billing-command-center/overview", response_model=BillingOverviewResponse)
def get_billing_command_overview(
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    data = _bcc_service(db).get_overview()
    return BillingOverviewResponse(
        generated_at=data["generated_at"],
        kpis=BillingCommandKpis(**data["kpis"]),
        sparklines=BillingSparklines(**data["sparklines"]),
        aging=[BillingAgingBucket(**b) for b in data["aging"]],
        aging_basis=data["aging_basis"],
        action_center=BillingActionCenter(**data["action_center"]),
        next_seven_days=BillingNextSevenDays(**data["next_seven_days"]),
        customers_at_risk=data["customers_at_risk"],
    )


@router.get("/billing-command-center/trend", response_model=BillingTrendResponse)
def get_billing_command_trend(
    granularity: str = Query("daily", pattern="^(daily|weekly|monthly)$"),
    currency: Optional[str] = Query(None, max_length=3),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    data = _bcc_service(db).get_trend(granularity, currency)
    return BillingTrendResponse(
        granularity=data["granularity"],
        currency=data["currency"],
        currency_state=data["currency_state"],
        available_currencies=data["available_currencies"],
        points=[BillingTrendPoint(**p) for p in data["points"]],
    )


@router.get("/billing-command-center/overdue-invoices", response_model=OverdueInvoiceListResponse)
def list_billing_command_overdue_invoices(
    limit: int = Query(10, ge=1, le=100),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    data = _bcc_service(db).list_overdue_invoices(limit)
    return OverdueInvoiceListResponse(
        total=data["total"],
        invoices=[OverdueInvoiceRow(**row) for row in data["invoices"]],
    )


@router.get("/billing-command-center/collections-risk", response_model=CollectionsRiskListResponse)
def list_billing_command_collections_risk(
    limit: int = Query(10, ge=1, le=50),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    data = _bcc_service(db).list_collections_risk(limit)
    return CollectionsRiskListResponse(rows=[CollectionsRiskRow(**row) for row in data["rows"]])


@router.get("/billing-command-center/recent-activity", response_model=BillingActivityListResponse)
def list_billing_command_recent_activity(
    limit: int = Query(8, ge=1, le=50),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    data = _bcc_service(db).list_recent_activity(limit)
    return BillingActivityListResponse(items=[BillingActivityItem(**item) for item in data["items"]])


# 
# REC-01 — Ledger reconciliation engine (runs + exception ownership).
# 

@router.post("/reconciliation-runs/run", response_model=ReconciliationRunResponse)
def trigger_reconciliation_run(
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    from app.modules.super_admin.reconciliation_service import ReconciliationService

    service = ReconciliationService(db)
    run = service.run_reconciliation(trigger="manual")
    service.report_to_attention_engine(run)
    db.commit()
    return _serialize_reconciliation_run(run)


@router.get("/reconciliation-runs", response_model=ReconciliationRunListResponse)
def list_reconciliation_runs(
    limit: int = Query(10, ge=1, le=50),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    from app.modules.super_admin.models import ReconciliationRun

    runs = (
        db.query(ReconciliationRun)
        .filter(ReconciliationRun.plane == "plane2")
        .order_by(ReconciliationRun.started_at.desc())
        .limit(limit)
        .all()
    )
    return {"items": [_serialize_reconciliation_run(r) for r in runs]}


@router.get("/reconciliation-runs/{run_id}", response_model=ReconciliationRunDetailResponse)
def get_reconciliation_run(
    run_id: int,
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import NotFoundException
    from app.modules.super_admin.models import ReconciliationRun, ReconciliationException

    run = db.get(ReconciliationRun, run_id)
    if run is None or run.plane != "plane2":
        raise NotFoundException(f"Reconciliation run {run_id} not found")
    exceptions = (
        db.query(ReconciliationException)
        .filter(ReconciliationException.run_id == run_id)
        .order_by(ReconciliationException.id.asc())
        .all()
    )
    data = _serialize_reconciliation_run(run)
    data["exceptions"] = [
        {
            "id": e.id,
            "kind": e.kind,
            "organization_id": e.organization_id,
            "entity_type": e.entity_type,
            "entity_id": e.entity_id,
            "detail": e.detail,
            "status": e.status.value if hasattr(e.status, "value") else str(e.status),
            "owner_user_id": e.owner_user_id,
            "acknowledged_at": str(e.acknowledged_at) if e.acknowledged_at else None,
            "resolved_at": str(e.resolved_at) if e.resolved_at else None,
            "resolution_note": e.resolution_note,
        }
        for e in exceptions
    ]
    return data


class ReconciliationExceptionActionRequest(BaseModel):
    note: Optional[str] = Field(None, max_length=500)


@router.post("/reconciliation-exceptions/{exception_id}/acknowledge", response_model=ReconciliationExceptionActionResponse)
def acknowledge_reconciliation_exception(
    exception_id: int,
    body: ReconciliationExceptionActionRequest = Body(default=None),
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    from app.modules.super_admin.reconciliation_service import ReconciliationService

    exc = ReconciliationService(db).acknowledge_exception(
        exception_id, owner_user_id=current_user.id
    )
    db.commit()
    return {
        "id": exc.id,
        "status": exc.status.value if hasattr(exc.status, "value") else str(exc.status),
        "owner_user_id": exc.owner_user_id,
        "acknowledged_at": str(exc.acknowledged_at) if exc.acknowledged_at else None,
    }


@router.post("/reconciliation-exceptions/{exception_id}/resolve", response_model=ReconciliationExceptionActionResponse)
def resolve_reconciliation_exception(
    exception_id: int,
    body: ReconciliationExceptionActionRequest,
    current_user=Depends(require_capability('financial_consistency.read')),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException
    from app.modules.super_admin.reconciliation_service import ReconciliationService

    try:
        exc = ReconciliationService(db).resolve_exception(exception_id, note=body.note or "")
    except ValueError as err:
        raise BadRequestException(str(err))
    db.commit()
    return {
        "id": exc.id,
        "status": exc.status.value if hasattr(exc.status, "value") else str(exc.status),
        "resolved_at": str(exc.resolved_at) if exc.resolved_at else None,
        "resolution_note": exc.resolution_note,
    }


def _serialize_reconciliation_run(run) -> dict:
    return {
        "id": run.id,
        "state": run.state.value if hasattr(run.state, "value") else str(run.state),
        "started_at": str(run.started_at),
        "finished_at": str(run.finished_at) if run.finished_at else None,
        "trigger": run.trigger,
        "checks_total": run.checks_total,
        "exceptions_found": run.exceptions_found,
        "processor_source": run.processor_source,
        "processor_note": run.processor_note,
    }


# 
# ZB-SA-CMD-003 §10/§11 — Attention Engine.
#
# Read-only for now to every super_admin (triage visibility is the whole
# point of the persistent strip); lifecycle mutations require
# get_current_super_admin same as everything else in this module. There is
# NO endpoint to fabricate an attention item from the API — every item's
# `source`/`source_key` traces back to a real signal (see
# attention_service.py's module docstring).
# 

@router.get("/attention", response_model=AttentionItemListResponse)
def list_attention_items(
    limit: int = Query(50, ge=1, le=200),
    severity: Optional[str] = Query(None, description="Filter the live queue by severity: P0 | P1 | P2 | P3"),
    status: Optional[str] = Query(None, description="Exact-status history view (e.g. RESOLVED | CLOSED); omit for the live open queue"),
    current_user=Depends(require_capability('governance.read')),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException
    from app.modules.super_admin.models import AttentionSeverity, AttentionStatus

    severity_filter = None
    if severity:
        try:
            severity_filter = AttentionSeverity(severity.upper())
        except ValueError:
            raise BadRequestException(f"Unknown severity filter: {severity}")
    status_filter = None
    if status:
        try:
            status_filter = AttentionStatus(status.upper())
        except ValueError:
            raise BadRequestException(f"Unknown status filter: {status}")

    items = AttentionService(db).list_open(limit=limit, severity=severity_filter, status=status_filter)
    return AttentionItemListResponse(items=items)


@router.get("/attention/counts", response_model=AttentionCountsResponse)
def get_attention_counts(
    current_user=Depends(require_capability('governance.read')),
    db: Session = Depends(get_db),
):
    return AttentionCountsResponse(**AttentionService(db).get_counts())


@router.post("/attention/{item_id}/acknowledge", response_model=AttentionItemResponse)
def acknowledge_attention_item(
    item_id: int,
    current_user=Depends(require_capability('incident.acknowledge')),
    db: Session = Depends(get_db),
):
    item = AttentionService(db).acknowledge(current_user, item_id)
    db.commit()
    return item


@router.post("/attention/{item_id}/assign", response_model=AttentionItemResponse)
def assign_attention_item(
    item_id: int,
    payload: AttentionAssignRequest,
    current_user=Depends(require_capability('incident.assign')),
    db: Session = Depends(get_db),
):
    item = AttentionService(db).assign(current_user, item_id, payload.owner_user_id)
    db.commit()
    return item


@router.post("/attention/{item_id}/escalate", response_model=AttentionItemResponse)
def escalate_attention_item(
    item_id: int,
    payload: AttentionEscalateRequest,
    current_user=Depends(require_capability('incident.transition')),
    db: Session = Depends(get_db),
):
    """§6.4 — explicit operator escalation (severity bump + SLA re-derivation,
    audited with the operator's reason). Guarded by the same capability as
    status transitions: escalation is a lifecycle action on the incident."""
    item = AttentionService(db).escalate(current_user, item_id, payload.reason)
    db.commit()
    return item


@router.post("/attention/{item_id}/transition", response_model=AttentionItemResponse)
def transition_attention_item(
    item_id: int,
    payload: AttentionTransitionRequest,
    current_user=Depends(require_capability('incident.transition')),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException
    from app.modules.super_admin.models import AttentionStatus

    try:
        to_status = AttentionStatus(payload.to_status.lower())
    except ValueError:
        raise BadRequestException(f"Unknown target status: {payload.to_status}")

    item = AttentionService(db).transition(current_user, item_id, to_status, payload.resolution_code)
    db.commit()
    return item


@router.post("/attention/{item_id}/suppress", response_model=AttentionItemResponse)
def suppress_attention_item(
    item_id: int,
    payload: AttentionSuppressRequest,
    current_user=Depends(require_capability('incident.suppress')),
    db: Session = Depends(get_db),
):
    item = AttentionService(db).suppress(current_user, item_id, payload.reason, payload.minutes)
    db.commit()
    return item


# 
# ZB-SA-CMD-003 §11 — Triage lens (single read-only pane).
# Composes the SAME real sources as the dedicated endpoints above; a
# triage.read holder sees incident/pipeline/safety state without needing
# every underlying capability. Critical events are deliberately REDACTED to
# action/entity/actor/time — no before/after payloads leak through triage.
# 

@router.get("/triage/summary", response_model=TriageSummaryResponse)
def get_triage_summary(
    current_user=Depends(require_capability('triage.read')),
    db: Session = Depends(get_db),
):
    from datetime import datetime as _dt

    from app.config import settings
    from app.modules.super_admin.kill_switch_service import (
        COMMERCIAL_SUBSCRIPTION_CHARGING,
        DOMAIN_B_BREAKER_CATALOG,
        BillingKillSwitchService,
    )
    from app.modules.super_admin.models import PlatformAuditLog

    attention = AttentionService(db)
    counts = AttentionCountsResponse(**attention.get_counts())
    top_items = [
        AttentionItemResponse.model_validate(i) for i in attention.list_open(limit=10)
    ]

    jobs = TelemetryService(db).get_job_health()

    breaker_svc = BillingKillSwitchService(db)
    safety_controls = []
    for scope, meta in DOMAIN_B_BREAKER_CATALOG.items():
        s = breaker_svc.effective_state(scope)
        safety_controls.append(
            TriageSafetyControl(
                scope=scope, display_name=meta["display_name"],
                enabled=s.enabled, expires_at=s.expires_at, reason=s.reason,
            )
        )
    commercial = breaker_svc.effective_state(COMMERCIAL_SUBSCRIPTION_CHARGING)
    safety_controls.append(
        TriageSafetyControl(
            scope=commercial.scope, display_name="Pause commercial subscription charging",
            enabled=commercial.enabled, expires_at=commercial.expires_at, reason=commercial.reason,
        )
    )

    recent_events = (
        db.query(PlatformAuditLog)
        .order_by(PlatformAuditLog.created_at.desc())
        .limit(10)
        .all()
    )
    critical_events = []
    for e in recent_events:
        actor_email = None
        if e.actor_id:
            from app.modules.auth.models import User as _User

            actor = db.query(_User).filter(_User.id == e.actor_id).first()
            actor_email = actor.email if actor else None
        critical_events.append(
            TriageCriticalEvent(
                id=e.id,
                action=e.action.value if hasattr(e.action, "value") else str(e.action),
                entity_type=e.entity_type,
                entity_id=e.entity_id,
                actor_email=actor_email,
                reason=e.reason,
                created_at=e.created_at,
            )
        )

    return TriageSummaryResponse(
        generated_at=_dt.utcnow(),
        incidents=TriageIncidentsSection(counts=counts, top_items=top_items),
        pipeline_stages=[JobHealthItem(**j) for j in jobs],
        scheduler_enabled=settings.ENABLE_RECURRING_BILLING_SCHEDULER,
        safety_controls=safety_controls,
        critical_events=critical_events,
    )


# 
# ZB-SA-P3 — Phase 3A Organizations workspace + Phase 3C lifecycle transitions
# Directory/overview read models are identity + lifecycle + operational counts
# (no monetary values). Lifecycle transitions are governed by the state machine
# in TenantLifecycleService: mandatory reason, actor+correlation_id audited via
# PlatformAuditAction.LIFECYCLE_TRANSITION, is_active kept in lockstep.
# 

@router.get("/organizations", response_model=OrganizationDirectoryResponse)
def list_super_admin_organizations(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    search: str = "",
    status: str | None = None,
    lifecycle_state: TenantLifecycleState | None = None,
    country: str | None = None,
    currency: str | None = None,
    billing_classification: str | None = None,
    billing_source: BillingSource | None = None,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException
    from app.modules.commercial.enums import BillingClassification

    classification = None
    if billing_classification:
        try:
            classification = BillingClassification(billing_classification.lower())
        except ValueError as exc:
            raise BadRequestException(
                f"Unknown billing_classification '{billing_classification}'."
            ) from exc

    result = OrganizationDirectoryService(db).list_organizations(
        skip=skip,
        limit=limit,
        search=search or "",
        status=status,
        lifecycle_state=lifecycle_state,
        country=country,
        currency=currency,
        billing_classification=classification,
        billing_source=billing_source,
    )
    return OrganizationDirectoryResponse(
        total=result["total"],
        organizations=result["organizations"],
    )


@router.get("/organizations/{organization_id}/overview", response_model=OrganizationOverviewResponse)
def get_super_admin_organization_overview(
    organization_id: int,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    return OrganizationOverviewResponse.model_validate(
        OrganizationDirectoryService(db).get_organization_overview(organization_id)
    )


@router.post("/organizations/{organization_id}/lifecycle-transition", response_model=LifecycleTransitionResponse)
def transition_super_admin_organization_lifecycle(
    organization_id: int,
    data: LifecycleTransitionRequest,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.exceptions import BadRequestException

    try:
        target = TenantLifecycleState(data.target.strip().lower())
    except ValueError as exc:
        valid = [s.value for s in TenantLifecycleState]
        raise BadRequestException(
            f"Unknown lifecycle target '{data.target}'. Valid states: {valid}"
        ) from exc

    service = TenantLifecycleService(db)
    org = service.get_organization(organization_id)  # 404 when missing
    _, previous = service.transition(
        actor=current_user,
        organization=org,
        target=target,
        reason=data.reason,
    )
    db.commit()

    current_state = TenantLifecycleService.effective_state(org)
    logger.info(
        "Super admin %s transitioned org %s (%s): %s -> %s",
        getattr(current_user, "email", current_user.id),
        org.organization_code,
        organization_id,
        previous.value,
        current_state.value,
    )
    return LifecycleTransitionResponse(
        organization_id=org.id,
        organization_code=org.organization_code,
        previous_state=previous.value,
        current_state=current_state.value,
        is_active=bool(org.is_active),
        allowed_transitions=[
            s.value for s in TenantLifecycleService.allowed_transitions(current_state)
        ],
        # correlation id of the audit event written inside transition()
        correlation_id=_latest_lifecycle_correlation_id(db, org.id),
    )


def _latest_lifecycle_correlation_id(db: Session, organization_id: int) -> str:
    from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog

    row = (
        db.query(PlatformAuditLog.correlation_id)
        .filter(
            PlatformAuditLog.organization_id == organization_id,
            PlatformAuditLog.action == PlatformAuditAction.LIFECYCLE_TRANSITION,
        )
        .order_by(PlatformAuditLog.id.desc())
        .first()
    )
    return row[0] if row else ""


@router.get("/platform/lifecycle", response_model=PlatformLifecycleResponse)
def get_super_admin_platform_lifecycle(
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """ZB-SA-P3 (Phase 3C): fleet-wide lifecycle composition — per-state
    organization counts, the PROVISIONING/ONBOARDING pipeline with evidence-
    based readiness, access-blocked tenants with their latest recorded
    transition reason, and the most recent lifecycle transition audit events.
    A pure read model; no monetary values (Domain B stays gated)."""
    return PlatformLifecycleResponse.model_validate(TenantLifecycleService(db).platform_overview())
