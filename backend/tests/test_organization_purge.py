"""
Permanent organization hard-delete (``POST /api/super-admin/organizations/{id}/purge``).

Covers the destructive endpoint added for demo/test cleanup and erasure
requests:
  1. Happy path — the org graph (users, customers, invoices, payments) is
     removed and the platform audit trail records one DELETE entry whose
     organization_id is NULL (the row it referred to no longer exists).
  2. Sibling organizations and their data are untouched.
  3. A mismatched confirmation is rejected before anything is deleted.
  4. An unknown organization id is a 404.
  5. With SQLite FK enforcement ON (mirroring Postgres RESTRICT semantics), the
     child-before-parent ordering still clears the graph.

Handlers/services are invoked directly on the isolated in-memory SQLite
fixture — never BILLING_DATABASE_URL.
"""
from datetime import date

import pytest
from sqlalchemy import text

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.auth.models import User, UserRole
from app.modules.billing.models import (
    BillingCustomer,
    Invoice,
    InvoiceItem,
    InvoiceStatus,
    Payment,
    PaymentStatus,
    PaymentType,
)
from app.modules.organizations.models import Organization
from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog
from app.modules.super_admin.router import purge_super_admin_organization
from tests.conftest import make_customer, make_organization


class _PurgeSchema:
    def __init__(self, reason="Test cleanup", confirmation=""):
        self.reason = reason
        self.confirmation = confirmation


def _sa_user(db):
    user = User(
        email="sa@purge.example",
        hashed_password="x",
        role=UserRole.SUPER_ADMIN,
        organization_id=None,
        first_name="S",
        last_name="A",
        phone="",
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.flush()
    return user


def _org_user(db, org_id, email):
    user = User(
        email=email,
        hashed_password="x",
        role=UserRole.ORG_ADMIN,
        organization_id=org_id,
        first_name="A",
        last_name="B",
        phone="",
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    db.flush()
    return user


def _seed_billing(db, org_id, suffix):
    customer = make_customer(db, org_id, code=f"CUST-{suffix}", email=f"{suffix}@example.com")
    invoice = Invoice(
        organization_id=org_id,
        customer_id=customer.id,
        invoice_number=f"INV-{suffix}",
        status=InvoiceStatus.SENT,
        issue_date=date.today(),
        due_date=date.today(),
        total_amount="100.00",
        paid_amount="0.00",
        balance_due="100.00",
        currency="USD",
    )
    db.add(invoice)
    db.flush()
    item = InvoiceItem(
        organization_id=org_id,
        invoice_id=invoice.id,
        line_number=1,
        description="Line",
        quantity="1",
        unit_price="100.00",
        total="100.00",
        tax_percentage="0",
    )
    db.add(item)
    payment = Payment(
        organization_id=org_id,
        customer_id=customer.id,
        payment_number=f"PAY-{suffix}",
        payment_type=PaymentType.MANUAL,
        status=PaymentStatus.CLEARED,
        amount="100.00",
        currency="USD",
        payment_date=date.today(),
    )
    db.add(payment)
    db.flush()
    return customer, invoice, item, payment


def test_purge_removes_org_graph_and_audits(db_session):
    sa = _sa_user(db_session)
    org = make_organization(db_session, code="PURGE1", name="Purge Me")
    user = _org_user(db_session, org.id, "admin@purge1.example")
    customer, invoice, item, payment = _seed_billing(db_session, org.id, "P1")
    db_session.commit()

    ids = {
        Organization: org.id,
        User: user.id,
        BillingCustomer: customer.id,
        Invoice: invoice.id,
        InvoiceItem: item.id,
        Payment: payment.id,
    }
    org_id = org.id
    result = purge_super_admin_organization(
        organization_id=org_id,
        data=_PurgeSchema(reason="Demo tenant", confirmation="PURGE1"),
        current_user=sa,
        db=db_session,
    )
    assert "permanently deleted" in result.message

    for model, pk in ids.items():
        assert db_session.query(model).filter(model.id == pk).first() is None

    audit = (
        db_session.query(PlatformAuditLog)
        .filter(PlatformAuditLog.action == PlatformAuditAction.DELETE)
        .filter(PlatformAuditLog.entity_type == "Organization")
        .one()
    )
    assert audit.entity_id == org_id
    assert audit.organization_id is None  # reference intentionally detached
    assert audit.reason == "Demo tenant"
    assert (audit.metadata_ or {}).get("purge") is True


def test_purge_leaves_other_organizations_untouched(db_session):
    sa = _sa_user(db_session)
    doomed = make_organization(db_session, code="DOOMED", name="Doomed")
    keeper = make_organization(db_session, code="KEEPER", name="Keeper")
    keeper_user = _org_user(db_session, keeper.id, "admin@keeper.example")
    keeper_customer = make_customer(db_session, keeper.id, code="KEEP-CUST")
    _seed_billing(db_session, doomed.id, "D1")
    db_session.commit()

    purge_super_admin_organization(
        organization_id=doomed.id,
        data=_PurgeSchema(confirmation="DOOMED"),
        current_user=sa,
        db=db_session,
    )

    assert db_session.get(Organization, keeper.id) is not None
    assert db_session.get(User, keeper_user.id) is not None
    assert db_session.get(BillingCustomer, keeper_customer.id) is not None


def test_purge_rejects_wrong_confirmation(db_session):
    sa = _sa_user(db_session)
    org = make_organization(db_session, code="GUARD", name="Guarded")
    db_session.commit()

    with pytest.raises(BadRequestException):
        purge_super_admin_organization(
            organization_id=org.id,
            data=_PurgeSchema(confirmation="not-the-code"),
            current_user=sa,
            db=db_session,
        )
    assert db_session.get(Organization, org.id) is not None


def test_purge_unknown_org_is_404(db_session):
    sa = _sa_user(db_session)
    with pytest.raises(NotFoundException):
        purge_super_admin_organization(
            organization_id=987654,
            data=_PurgeSchema(confirmation="ANY"),
            current_user=sa,
            db=db_session,
        )


def test_purge_orders_children_first_with_fk_enforcement(db_session):
    """With FK checks ON the RESTRICT edges between billing tables must be
    unwound child-before-parent — the property that matters on Postgres."""
    db_session.execute(text("PRAGMA foreign_keys=ON"))
    sa = _sa_user(db_session)
    org = make_organization(db_session, code="FKDEL", name="FK Delete")
    _org_user(db_session, org.id, "admin@fkdel.example")
    _seed_billing(db_session, org.id, "FK")
    db_session.commit()
    org_id = org.id

    purge_super_admin_organization(
        organization_id=org_id,
        data=_PurgeSchema(confirmation="FKDEL"),
        current_user=sa,
        db=db_session,
    )

    assert db_session.query(Organization).filter(Organization.id == org_id).first() is None
    assert db_session.query(InvoiceItem).filter(InvoiceItem.organization_id == org_id).count() == 0
    assert db_session.query(Payment).filter(Payment.organization_id == org_id).count() == 0
