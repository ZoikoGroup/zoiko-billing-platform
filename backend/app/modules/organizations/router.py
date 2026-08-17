"""
modules/organizations/router.py
-------------------------------
Organization endpoints.

  - Super Admin: list all orgs, create orgs, suspend/reactivate.
  - Org-scoped admins (org_admin / billing_admin): read/update their own
    organization profile.

Registration of a brand-new org happens through /auth/register (public),
which creates the Organization + first org_admin in one transaction.
"""

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.exceptions import BadRequestException, NotFoundException, ForbiddenException
from app.modules.auth.schemas import SuccessResponse
from app.core.dependencies import (
    get_current_super_admin,
    get_current_org_admin,
    get_current_billing_admin,
    get_current_user,
    get_super_admin_organization_id,
)
from app.modules.organizations.schemas import (
    OrganizationBase,
    OrganizationUpdate,
    OrganizationResponse,
    OrganizationListResponse,
    OrganizationDashboardStats,
    OrganizationDetail,
    RecentCustomer,
)
from app.modules.commercial.schemas import (
    CommercialAccountResponse,
    CommercialSubscriptionResponse,
)
from app.modules.super_admin.schemas import BillingClassificationUpdate

logger = logging.getLogger("zoiko_billing.organizations")

router = APIRouter(prefix="/organizations", tags=["Organizations"])


# ── Org-scoped (own organization only) ──────────────────────────────────────

@router.get("/me", response_model=OrganizationResponse)
def get_my_organization(
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from app.core.dependencies import get_organization_id
    org_id = get_organization_id(current_user)
    from app.modules.organizations.models import Organization
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if org is None:
        raise NotFoundException("Organization", "id")
    return org


@router.put("/me", response_model=OrganizationResponse)
def update_my_organization(
    data: OrganizationUpdate,
    current_user=Depends(get_current_org_admin),
    db: Session = Depends(get_db),
):
    from app.core.dependencies import get_organization_id
    org_id = get_organization_id(current_user)
    from app.modules.organizations.models import Organization
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if org is None:
        raise NotFoundException("Organization", "id")
    updates = data.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(org, field, value)
    db.commit()
    db.refresh(org)

    if "currency" in updates and updates["currency"]:
        new_currency = updates["currency"].strip().upper()

        # Synchronize BillingConfiguration currency fields to match the new
        # organization currency. This ensures the dashboard, billing settings,
        # and other billing operations use the intended organization currency.
        # Only currency-related fields are updated; operational settings like
        # invoice_prefix, payment terms, date format, language, etc. are preserved.
        try:
            from app.modules.billing.models import BillingConfiguration, CurrencyCode
            from app.modules.billing.services.settings_service import BillingConfigurationService

            config = db.query(BillingConfiguration).filter(
                BillingConfiguration.organization_id == org_id
            ).first()
            if config:
                try:
                    currency_enum = CurrencyCode(new_currency)
                except ValueError:
                    currency_enum = None
                    logger.warning(
                        "Organization %s currency %r is not a valid CurrencyCode; "
                        "BillingConfiguration currency fields not updated",
                        org.organization_code, new_currency,
                    )
                if currency_enum is not None:
                    config.default_currency = currency_enum
                    config.home_currency = currency_enum
                    config.base_currency = currency_enum
                    # Ensure the new currency is in supported_currencies
                    supported = list(config.supported_currencies or [])
                    if new_currency not in supported:
                        supported.append(new_currency)
                        config.supported_currencies = supported
                    db.commit()
                    logger.info(
                        "Synchronized BillingConfiguration currencies to %s for org %s",
                        new_currency, org.organization_code,
                    )
        except Exception as e:
            logger.warning(
                "Could not synchronize BillingConfiguration currencies for org %s: %s",
                org.organization_code, e,
            )
            db.rollback()

        # Best-effort starter tax catalogue seed (Phase 5.7) -- an org's
        # billing currency is only ever set here or defaults to USD at
        # registration, so this is the point where a currency with a real
        # catalogue entry (e.g. GBP) is actually likely to be selected.
        # Idempotent and never overwrites existing/custom tax rates.
        try:
            from app.modules.billing.services.tax_service import TaxService
            TaxService(db).seed_starter_tax_rates(org.id, org.currency, created_by=current_user.id)
        except Exception as e:
            logger.warning("Could not seed starter tax rates for org %s: %s", org.organization_code, e)

    return org


@router.get("/me/dashboard-stats", response_model=OrganizationDashboardStats)
def get_my_organization_dashboard_stats(
    current_user=Depends(get_current_billing_admin),
    db: Session = Depends(get_db),
):
    """Org-scoped KPIs for the Organization Admin dashboard — computed from
    the billing module's own tables."""
    from datetime import datetime, timezone

    from app.core.dependencies import get_organization_id
    from app.modules.auth.models import User, UserRole
    from app.modules.billing.models import (
        BillingCustomer, CustomerStatus, Subscription, BillingSubscriptionStatus,
        Invoice, InvoiceStatus,
    )

    org_id = get_organization_id(current_user)

    customers = db.query(BillingCustomer).filter(BillingCustomer.organization_id == org_id).all()
    total_customers = len(customers)
    active_customers = sum(1 for c in customers if c.status == CustomerStatus.ACTIVE)

    active_subscriptions = (
        db.query(Subscription)
        .filter(
            Subscription.organization_id == org_id,
            Subscription.status == BillingSubscriptionStatus.ACTIVE,
        )
        .count()
    )

    open_statuses = (InvoiceStatus.SENT, InvoiceStatus.PARTIALLY_PAID)
    open_invoices = (
        db.query(Invoice)
        .filter(Invoice.organization_id == org_id, Invoice.status.in_(open_statuses))
        .count()
    )
    overdue_invoices = (
        db.query(Invoice)
        .filter(Invoice.organization_id == org_id, Invoice.status == InvoiceStatus.OVERDUE)
        .count()
    )
    outstanding_invoices = (
        db.query(Invoice)
        .filter(
            Invoice.organization_id == org_id,
            Invoice.status.in_(open_statuses + (InvoiceStatus.OVERDUE,)),
        )
        .all()
    )
    outstanding_amount = sum(float(i.balance_due or 0) for i in outstanding_invoices)

    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    paid_this_month = (
        db.query(Invoice)
        .filter(
            Invoice.organization_id == org_id,
            Invoice.status == InvoiceStatus.PAID,
            Invoice.updated_at >= month_start,
        )
        .all()
    )
    revenue_this_month = sum(float(i.total_amount or 0) for i in paid_this_month)

    billing_admins = (
        db.query(User)
        .filter(User.organization_id == org_id, User.role == UserRole.BILLING_ADMIN)
        .count()
    )

    recent_customers = [
        RecentCustomer(
            name=c.display_name or c.company_name,
            initials="".join(w[0] for w in (c.display_name or c.company_name).split()[:2]).upper() or "U",
            status=c.status.value if hasattr(c.status, "value") else str(c.status),
            statusColor="teal" if c.status == CustomerStatus.ACTIVE else "amber" if c.status == CustomerStatus.SUSPENDED else "off",
        )
        for c in sorted(customers, key=lambda c: c.id, reverse=True)[:5]
    ]

    return OrganizationDashboardStats(
        total_customers=total_customers,
        active_customers=active_customers,
        active_subscriptions=active_subscriptions,
        open_invoices=open_invoices,
        overdue_invoices=overdue_invoices,
        outstanding_amount=outstanding_amount,
        revenue_this_month=revenue_this_month,
        billing_admins=billing_admins,
        recent_customers=recent_customers,
    )


@router.get("/me/detail", response_model=OrganizationDetail)
def get_my_organization_detail(
    current_user=Depends(get_current_billing_admin),
    db: Session = Depends(get_db),
):
    """Richer org profile for the "My Organization" page."""
    from app.core.dependencies import get_organization_id
    from app.modules.organizations.models import Organization
    from app.modules.auth.models import User, UserRole
    from app.modules.billing.models import BillingCustomer, CustomerStatus

    org_id = get_organization_id(current_user)
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if org is None:
        raise NotFoundException("Organization", "id")

    admin = (
        db.query(User)
        .filter(User.organization_id == org_id, User.role == UserRole.ORG_ADMIN)
        .order_by(User.created_at.asc())
        .first()
    )
    total_customers = db.query(BillingCustomer).filter(BillingCustomer.organization_id == org_id).count()
    active_customers = (
        db.query(BillingCustomer)
        .filter(BillingCustomer.organization_id == org_id, BillingCustomer.status == CustomerStatus.ACTIVE)
        .count()
    )
    billing_admins = (
        db.query(User)
        .filter(User.organization_id == org_id, User.role == UserRole.BILLING_ADMIN)
        .count()
    )

    return OrganizationDetail(
        id=org.id,
        name=org.organization_name,
        code=org.organization_code,
        status="active" if org.is_active else "deactivated",
        admin_name=f"{admin.first_name} {admin.last_name}".strip() if admin else None,
        admin_email=admin.email if admin else None,
        legal_name=org.legal_name,
        industry=org.industry,
        address=org.address,
        city=org.city,
        state=org.state,
        country=org.country,
        postal_code=org.postal_code,
        email=org.email,
        phone=org.phone,
        website=org.website,
        currency=org.currency,
        timezone=org.timezone,
        fiscal_year_start=org.fiscal_year_start,
        fiscal_year_end=org.fiscal_year_end,
        billing_classification=org.billing_classification,
        billing_source=org.billing_source,
        total_customers=total_customers,
        active_customers=active_customers,
        billing_admins=billing_admins,
        created_at=org.created_at,
    )



@router.get("/me/commercial-account", response_model=CommercialAccountResponse)
def get_my_commercial_account(
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Tenant-facing read of the org's own commercial account (PHASE 6).

    organization_id ALWAYS comes from the authenticated user's token
    (get_organization_id) — a client-supplied organization_id is never
    trusted, so org A cannot read org B's account here. Read-only: tenants
    cannot change status / billing_source / billing_classification.

    Lazily ensures the account exists so pre-CommercialAccount tenants get a
    record without a data migration.
    """
    from app.core.dependencies import get_organization_id
    from app.modules.commercial.schemas import CommercialSubscriptionSummary
    from app.modules.commercial.service import (
        CommercialAccountService,
        CommercialSubscriptionService,
    )
    from app.modules.organizations.models import Organization

    org_id = get_organization_id(current_user)
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if org is None:
        raise NotFoundException("Organization", "id")

    account = CommercialAccountService(db).ensure_commercial_account(org_id)
    db.commit()  # persist a lazily-created account (get_db never commits)

    # PHASE 9: the tenant's own read-only view now also reports charging
    # readiness (double-charge prevention) and its current open subscription.
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


@router.get("/me/commercial-subscription", response_model=CommercialSubscriptionResponse)
def get_my_commercial_subscription(
    current_user=Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Tenant-facing read of the org's OWN commercial subscription (PHASE 7).

    organization_id ALWAYS comes from the authenticated user's token
    (get_organization_id) — org A can never read org B's subscription here.
    Read-only: tenants cannot change subscription status or plan.

    Returns the current open subscription when one exists, otherwise the most
    recent historical one; 404 if the org has never had a subscription
    (registration does not auto-assign one because no approved default plan
    exists in Phase 7).
    """
    from app.core.dependencies import get_organization_id
    from app.modules.commercial.models import (
        CommercialAccount,
        CommercialPlan,
        CommercialSubscription,
    )
    from app.modules.commercial.service import CommercialSubscriptionService
    from app.modules.organizations.models import Organization

    org_id = get_organization_id(current_user)
    org = db.query(Organization).filter(Organization.id == org_id).first()
    if org is None:
        raise NotFoundException("Organization", "id")

    account = db.query(CommercialAccount).filter(CommercialAccount.organization_id == org_id).first()
    if account is None:
        raise NotFoundException("Commercial Subscription", "organization_id")

    svc = CommercialSubscriptionService(db)
    subscription = svc.get_active_subscription(account.id)
    if subscription is None:
        subscription = svc.get_most_recent_subscription(account.id)
    if subscription is None:
        raise NotFoundException("Commercial Subscription", "organization_id")

    plan = db.query(CommercialPlan).filter(CommercialPlan.id == subscription.commercial_plan_id).first()

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


# ── Super Admin only ────────────────────────────────────────────────────────
@router.get("/", response_model=OrganizationListResponse)
def list_organizations(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    search: str = Query("", description="Search by name or code"),
    include_inactive: bool = Query(True),
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.modules.organizations.models import Organization

    query = db.query(Organization)
    if search:
        like = f"%{search}%"
        query = query.filter(
            (Organization.organization_name.ilike(like))
            | (Organization.organization_code.ilike(like))
        )
    if not include_inactive:
        query = query.filter(Organization.is_active == True)
    total = query.count()
    orgs = (
        query.order_by(Organization.created_at.desc())
        .offset(skip)
        .limit(limit)
        .all()
    )
    return OrganizationListResponse(organizations=orgs, total=total)


@router.get("/{organization_id}", response_model=OrganizationResponse)
def get_organization(
    organization_id: int,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.modules.organizations.models import Organization
    org = db.query(Organization).filter(Organization.id == organization_id).first()
    if org is None:
        raise NotFoundException("Organization", "id")
    return org


@router.post("/", response_model=OrganizationResponse)
def create_organization(
    data: OrganizationBase,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.core.code_generation import generate_organization_code
    from app.modules.organizations.models import Organization

    code = generate_organization_code(data.organization_name, db)
    org = Organization(
        organization_name=data.organization_name,
        organization_code=code,
        display_name=data.display_name,
        legal_name=data.legal_name,
        industry=data.industry,
        address=data.address,
        city=data.city,
        state=data.state,
        country=data.country,
        postal_code=data.postal_code,
        email=data.email,
        phone=data.phone,
        website=data.website,
        tax_no=data.tax_no,
        registration_number=data.registration_number,
        currency=data.currency,
        timezone=data.timezone,
        fiscal_year_start=data.fiscal_year_start or "01-01",
        fiscal_year_end=data.fiscal_year_end or "12-31",
        is_active=True,
        created_by_user_id=current_user.id,
    )
    db.add(org)
    # Flush so org.id is assigned before it's used below — the session is
    # autoflush=False (app/database.py), so without this org.id would still
    # be None here and ensure_commercial_account(org.id) would fail.
    db.flush()
    # Provision the platform-plane commercial account in the same transaction
    # (PHASE 6) — every provisioning path creates it. billing_source /
    # billing_classification use the Organization's Phase 1 server-side
    # defaults (COMMERCIAL_STANDALONE / REGISTERED_VIA_STANDALONE); they are
    # never accepted from the client.
    from app.modules.commercial.service import (
        CommercialAccountService,
        CommercialSubscriptionService,
    )
    account = CommercialAccountService(db).ensure_commercial_account(org.id)
    # CommercialSubscription (PHASE 7): only when an approved default plan
    # exists — Phase 7 seeds none, so this is a safe no-op (flush-only).
    CommercialSubscriptionService(db).provision_default_subscription(account.id)
    db.flush()

    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    PlatformAuditService(db).log_no_commit(
        actor_id=current_user.id,
        actor_role="super_admin",
        action=PlatformAuditAction.CREATE,
        entity_type="Organization",
        entity_id=org.id,
        organization_id=org.id,
        new_values={"organization_name": org.organization_name, "organization_code": code},
    )

    db.commit()
    db.refresh(org)
    logger.info("Super Admin %s created organization %s (%s)", current_user.email, org.organization_name, code)
    return org


@router.patch("/{organization_id}/status", response_model=OrganizationResponse)
def update_organization_status(
    organization_id: int,
    is_active: bool,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    from app.modules.organizations.models import Organization
    org = db.query(Organization).filter(Organization.id == organization_id).first()
    if org is None:
        raise NotFoundException("Organization", "id")

    previous_is_active = org.is_active
    org.is_active = is_active

    if previous_is_active != is_active:
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        PlatformAuditService(db).log_no_commit(
            actor_id=current_user.id,
            actor_role="super_admin",
            action=PlatformAuditAction.ACTIVATE if is_active else PlatformAuditAction.DEACTIVATE,
            entity_type="Organization",
            entity_id=org.id,
            organization_id=org.id,
            old_values={"is_active": previous_is_active},
            new_values={"is_active": is_active},
        )

    db.commit()
    db.refresh(org)
    logger.info(
        "Super Admin %s set organization %s is_active=%s",
        current_user.email, org.organization_code, is_active,
    )
    return org


@router.patch("/{organization_id}/billing-classification", response_model=OrganizationResponse)
def update_billing_classification(
    organization_id: int,
    data: BillingClassificationUpdate,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Controlled billing_classification mutation (ZB-COM-BILL-001 Phase 2).

    Requires an explicit reason and produces an audited before/after record
    with an effective timestamp — this is authorized+audited, not a
    maker-checker workflow (unlike catalog publishing), matching the
    standard's Phase 2 requirement ("authorization, reason, audit,
    before/after state, effective timestamp") rather than Phase 5's
    material-financial-operation list (which billing_classification changes
    are not part of).

    Environment name is never a factor here by construction — this endpoint
    only ever reads/writes the classification column; nothing in the
    codebase derives charge authorization from APP_ENV/DEBUG (see
    CommercialAccountService.can_charge).
    """
    from app.modules.commercial.enums import BillingClassification
    from app.modules.organizations.models import Organization

    org = db.query(Organization).filter(Organization.id == organization_id).first()
    if org is None:
        raise NotFoundException("Organization", "id")

    try:
        new_classification = BillingClassification(data.billing_classification)
    except ValueError:
        valid = ", ".join(c.value for c in BillingClassification)
        raise BadRequestException(
            f"Invalid billing_classification '{data.billing_classification}'. Valid values: {valid}."
        )

    previous_classification = org.billing_classification
    if previous_classification == new_classification:
        return org  # no-op: no audit row for a non-change, matching the CommercialPlan convention

    org.billing_classification = new_classification

    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    effective_at = datetime.utcnow()
    PlatformAuditService(db).log_no_commit(
        actor_id=current_user.id,
        actor_role="super_admin",
        action=PlatformAuditAction.UPDATE,
        entity_type="Organization",
        entity_id=org.id,
        organization_id=org.id,
        old_values={"billing_classification": previous_classification.value},
        new_values={"billing_classification": new_classification.value},
        reason=data.reason,
        metadata={"effective_at": effective_at.isoformat(), "field": "billing_classification"},
    )

    db.commit()
    db.refresh(org)
    logger.info(
        "Super Admin %s changed organization %s billing_classification %s -> %s (reason: %s)",
        current_user.email, org.organization_code,
        previous_classification.value, new_classification.value, data.reason,
    )
    return org


@router.delete("/{organization_id}", response_model=SuccessResponse)
def delete_organization(
    organization_id: int,
    current_user=Depends(get_current_super_admin),
    db: Session = Depends(get_db),
):
    """Hard-delete an organization and ALL of its data.

    Every billing/org-scoped table is deleted inside one transaction, in the
    reverse of SQLAlchemy's FK-dependency-sorted table order (so children
    always go before parents). This is generated from Base.metadata rather
    than a hand-maintained table list — the billing schema has ~65 org-scoped
    tables and every one of them carries organization_id directly (verified
    against models.py), so there is no via-parent special case to hand-order.
    Global tables that are NOT org-scoped (platform_settings) are untouched.
    platform_audit_logs is likewise excluded from the sweep even though it
    carries an optional organization_id column: it is the platform-plane
    audit trail, not organization-owned business data, and an audit record
    must outlive the entity it describes. Super Admin only.
    """
    from sqlalchemy import text
    from app.database import Base
    from app.modules.organizations.models import Organization

    org = db.query(Organization).filter(Organization.id == organization_id).first()
    if org is None:
        raise NotFoundException("Organization", "id")

    org_name = org.organization_name
    org_code = org.organization_code

    # organization_id is intentionally left NULL here (not organization_id=
    # organization_id): platform_audit_logs.organization_id is FK(...,
    # ondelete="RESTRICT"), so a row still referencing this org would block
    # the org DELETE below within the same transaction. The org's identity is
    # preserved in metadata_ instead.
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    PlatformAuditService(db).log_no_commit(
        actor_id=current_user.id,
        actor_role="super_admin",
        action=PlatformAuditAction.DELETE,
        entity_type="Organization",
        entity_id=organization_id,
        organization_id=None,
        metadata={"organization_id": organization_id, "organization_name": org_name, "organization_code": org_code},
    )

    for table in reversed(Base.metadata.sorted_tables):
        if table.name in ("organizations", "users", "security_action_tokens", "platform_audit_logs"):
            continue
        if "organization_id" not in table.columns:
            continue
        db.execute(
            text(f'DELETE FROM "{table.name}" WHERE organization_id = :org_id'),
            {"org_id": organization_id},
        )

    # Prior audit rows that referenced this org (CREATE/ACTIVATE/DEACTIVATE)
    # must not dangle now that the org row is about to be deleted (RESTRICT
    # FK) — null out the reference rather than deleting the rows, so the
    # audit trail (actor/action/entity_id/metadata) survives intact.
    db.execute(
        text('UPDATE "platform_audit_logs" SET organization_id = NULL WHERE organization_id = :org_id'),
        {"org_id": organization_id},
    )

    # Login users + their action tokens (users has ondelete CASCADE from org).
    db.execute(
        text('DELETE FROM "security_action_tokens" WHERE organization_id = :org_id'),
        {"org_id": organization_id},
    )
    db.execute(
        text('DELETE FROM "users" WHERE organization_id = :org_id'),
        {"org_id": organization_id},
    )

    db.delete(org)
    db.commit()
    logger.info(
        "Super Admin %s hard-deleted organization %s (%s) and all its data",
        current_user.email, org_name, org_code,
    )
    return {"message": f"Organization '{org_name}' and all of its data deleted."}
