"""
Regression tests for ZB-COM-BILL-001 §25 (Segregation-of-Duties Doctrine):
the user who creates a Refund/WriteOff/CreditNote/Discount can never approve
it themselves, even though (before this fix) the same billing_admin role was
otherwise sufficient to do both.

Also covers the prerequisite fix this depends on: created_by must actually be
persisted on these rows (previously accepted as a service param but never
passed into repo.create(), so the self-approval check would silently never
fire).
"""
from datetime import datetime
from decimal import Decimal

import pytest

from app.core.exceptions import ForbiddenException
from app.modules.auth.models import User, UserRole
from app.modules.billing.models import CreditNoteType, DiscountType, WriteOffType
from app.modules.billing.services.credit_note_service import CreditNoteService
from app.modules.billing.services.pricing_service import DiscountService
from app.modules.billing.services.refund_service import RefundService
from app.modules.billing.services.write_off_service import WriteOffService
from tests.conftest import make_customer, make_organization, make_payment


def _make_user(db, org_id, email, role=UserRole.BILLING_ADMIN):
    user = User(
        email=email, hashed_password="x", role=role, organization_id=org_id,
        first_name="A", last_name="B", phone="", is_active=True, is_verified=True,
    )
    db.add(user)
    db.flush()
    return user


def test_refund_created_by_is_persisted_and_self_approval_blocked(db_session):
    org = make_organization(db_session)
    customer = make_customer(db_session, org.id)
    payment = make_payment(db_session, org.id, customer.id, amount="100.00")
    submitter = _make_user(db_session, org.id, "submitter@example.com")
    approver = _make_user(db_session, org.id, "approver@example.com", role=UserRole.FINANCE_APPROVER)

    svc = RefundService(db_session)
    refund = svc.create_refund(
        organization_id=org.id, created_by=submitter.id,
        customer_id=customer.id, refund_number="auto",
        refund_type="full", amount=Decimal("50.00"), payment_id=payment.id,
    )
    assert refund.created_by == submitter.id  # prerequisite fix

    svc.submit_for_approval(refund.id, org.id, submitter.id)

    with pytest.raises(ForbiddenException):
        svc.approve_refund(refund.id, org.id, submitter.id)

    approved = svc.approve_refund(refund.id, org.id, approver.id)
    assert approved.approved_by == approver.id


def test_write_off_created_by_is_persisted_and_self_approval_blocked(db_session):
    org = make_organization(db_session)
    customer = make_customer(db_session, org.id)
    submitter = _make_user(db_session, org.id, "submitter2@example.com")
    approver = _make_user(db_session, org.id, "approver2@example.com", role=UserRole.FINANCE_APPROVER)

    svc = WriteOffService(db_session)
    write_off = svc.create_write_off(
        organization_id=org.id, created_by=submitter.id,
        customer_id=customer.id, write_off_number="auto",
        write_off_type=WriteOffType.MANUAL_ADJUSTMENT.value, amount=Decimal("25.00"),
    )
    assert write_off.created_by == submitter.id

    svc.submit_for_approval(write_off.id, org.id, submitter.id)

    with pytest.raises(ForbiddenException):
        svc.approve_write_off(write_off.id, org.id, submitter.id)

    approved = svc.approve_write_off(write_off.id, org.id, approver.id)
    assert approved.approved_by == approver.id


def test_credit_note_created_by_is_persisted_and_self_approval_blocked(db_session):
    org = make_organization(db_session)
    customer = make_customer(db_session, org.id)
    submitter = _make_user(db_session, org.id, "submitter3@example.com")
    approver = _make_user(db_session, org.id, "approver3@example.com", role=UserRole.FINANCE_APPROVER)

    svc = CreditNoteService(db_session)
    cn = svc.create_credit_note(
        organization_id=org.id, created_by=submitter.id,
        customer_id=customer.id, credit_note_number="auto",
        credit_note_type=CreditNoteType.ADJUSTMENT.value, total_amount="10.00",
        issue_date=datetime.utcnow().date(),
    )
    assert cn.created_by == submitter.id

    # CreditNote has no PENDING_APPROVAL step today — DRAFT -> APPROVED
    # directly via approve_credit_note alone.
    with pytest.raises(ForbiddenException):
        svc.approve_credit_note(cn.id, org.id, submitter.id)

    approved = svc.approve_credit_note(cn.id, org.id, approver.id)
    assert approved.approved_by == approver.id


def test_discount_created_by_is_persisted_and_self_approval_blocked(db_session):
    org = make_organization(db_session)
    submitter = _make_user(db_session, org.id, "submitter4@example.com")
    approver = _make_user(db_session, org.id, "approver4@example.com", role=UserRole.FINANCE_APPROVER)

    svc = DiscountService(db_session)
    discount = svc.create(
        organization_id=org.id, created_by=submitter.id,
        name="Launch Promo", discount_type=DiscountType.PROMOTION.value,
        discount_value="10", valid_from=datetime.utcnow(),
    )
    assert discount.created_by == submitter.id
    assert discount.status.value == "draft"

    svc.submit_for_approval(discount.id, org.id, submitter.id)

    with pytest.raises(ForbiddenException):
        svc.approve_discount(discount.id, org.id, submitter.id)

    approved = svc.approve_discount(discount.id, org.id, approver.id)
    assert approved.status.value == "active"
    assert approved.approved_by == approver.id
