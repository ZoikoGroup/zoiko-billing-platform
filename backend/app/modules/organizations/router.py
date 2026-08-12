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

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.core.exceptions import NotFoundException, ForbiddenException
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
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(org, field, value)
    db.commit()
    db.refresh(org)
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
        industry=org.industry,
        address=org.address,
        currency=org.currency,
        timezone=org.timezone,
        total_customers=total_customers,
        active_customers=active_customers,
        billing_admins=billing_admins,
        created_at=org.created_at,
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
        industry=data.industry,
        address=data.address,
        email=data.email,
        phone=data.phone,
        tax_no=data.tax_no,
        registration_number=data.registration_number,
        currency=data.currency,
        timezone=data.timezone,
        is_active=True,
        created_by_user_id=current_user.id,
    )
    db.add(org)
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
    org.is_active = is_active
    db.commit()
    db.refresh(org)
    logger.info(
        "Super Admin %s set organization %s is_active=%s",
        current_user.email, org.organization_code, is_active,
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
    Super Admin only.
    """
    from sqlalchemy import text
    from app.database import Base
    from app.modules.organizations.models import Organization

    org = db.query(Organization).filter(Organization.id == organization_id).first()
    if org is None:
        raise NotFoundException("Organization", "id")

    org_name = org.organization_name
    org_code = org.organization_code

    for table in reversed(Base.metadata.sorted_tables):
        if table.name in ("organizations", "users", "security_action_tokens"):
            continue
        if "organization_id" not in table.columns:
            continue
        db.execute(
            text(f'DELETE FROM "{table.name}" WHERE organization_id = :org_id'),
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
