"""Section 3 N+1 regression: tenant list endpoints for subscriptions, contracts,
credit notes, refunds, products and audit logs must issue a flat number of
queries for a 20-row page, including response-model serialization."""
from datetime import date

from app.modules.billing.models import (
    BillingAuditAction,
    BillingAuditLog,
    BillingCustomer,
    CreditNote,
    CreditNoteStatus,
    CreditNoteType,
    Product,
    Refund,
    RefundSource,
    RefundStatus,
    RefundType,
)
from app.modules.billing.schemas import (
    BillingAuditLogListResponse,
    ContractListResponse,
    CreditNoteListResponse,
    ProductListResponse,
    RefundListResponse,
    SubscriptionListResponse,
)
from app.modules.billing.services import BillingAuditService
from app.modules.billing.services.contract_service import ContractService
from app.modules.billing.services.credit_note_service import CreditNoteService
from app.modules.billing.services.product_service import ProductService
from app.modules.billing.services.refund_service import RefundService
from app.modules.billing.services.subscription_service import SubscriptionService
from tests.conftest import (
    make_contract,
    make_customer,
    make_organization,
    make_subscription,
    make_subscription_plan,
)
from tests.query_helpers import assert_max_queries

N = 20


def _setup(db):
    org = make_organization(db)
    customers = [make_customer(db, org.id, code=f"C{i}", email=f"c{i}@x.com") for i in range(N)]
    return org, customers


def test_subscriptions_list_query_count(db_session):
    org, customers = _setup(db_session)
    for i, c in enumerate(customers):
        plan = make_subscription_plan(db_session, org.id, code=f"P{i}")
        make_subscription(db_session, org.id, c.id, plan.id, subscription_number=f"S{i}")
    db_session.commit()
    db_session.expire_all()
    with assert_max_queries(6, "subscriptions") as _c:
        res = SubscriptionService(db_session).list_subscriptions(org.id, page=1, per_page=N)
        out = SubscriptionListResponse.model_validate(res)
    assert len(out.items) == N and out.items[0].plan_name and out.items[0].customer_name


def test_contracts_list_query_count(db_session):
    org, customers = _setup(db_session)
    for i, c in enumerate(customers):
        make_contract(db_session, org.id, c.id, contract_number=f"K{i}")
    db_session.commit()
    db_session.expire_all()
    with assert_max_queries(6, "contracts") as _c:
        res = ContractService(db_session).list_contracts(org.id, page=1, per_page=N)
        out = ContractListResponse.model_validate(res)
    assert len(out.items) == N


def test_credit_notes_list_query_count(db_session):
    org, customers = _setup(db_session)
    for i, c in enumerate(customers):
        db_session.add(CreditNote(
            organization_id=org.id, customer_id=c.id, credit_note_number=f"CN{i}",
            credit_note_type=CreditNoteType.PARTIAL_CREDIT, status=CreditNoteStatus.ISSUED,
            total_amount="10.00", remaining_amount="10.00", reason="r", issue_date=date.today()))
    db_session.commit()
    db_session.expire_all()
    with assert_max_queries(6, "credit notes") as _c:
        res = CreditNoteService(db_session).list_credit_notes(org.id, page=1, per_page=N)
        out = CreditNoteListResponse.model_validate(res)
    assert len(out.items) == N


def test_refunds_list_query_count(db_session):
    org, customers = _setup(db_session)
    for i, c in enumerate(customers):
        db_session.add(Refund(
            organization_id=org.id, customer_id=c.id, refund_number=f"R{i}",
            refund_type=RefundType.FULL, refund_source=RefundSource.PAYMENT,
            status=RefundStatus.DRAFT, amount="5.00", currency="USD"))
    db_session.commit()
    db_session.expire_all()
    with assert_max_queries(6, "refunds") as _c:
        res = RefundService(db_session).list_refunds(org.id, page=1, per_page=N)
        out = RefundListResponse.model_validate(res)
    assert len(out.items) == N


def test_products_list_query_count(db_session):
    org, _ = _setup(db_session)
    for i in range(N):
        db_session.add(Product(organization_id=org.id, name=f"P{i}", code=f"PC{i}", default_price="1.00"))
    db_session.commit()
    db_session.expire_all()
    with assert_max_queries(6, "products") as _c:
        res = ProductService(db_session).list_products(org.id, page=1, per_page=N, active_only=True)
        out = ProductListResponse.model_validate(res)
    assert len(out.items) == N


def test_audit_logs_list_query_count(db_session):
    org, _ = _setup(db_session)
    for i in range(N):
        db_session.add(BillingAuditLog(
            organization_id=org.id, actor_id=None, entity_type="Invoice", entity_id=i,
            action=BillingAuditAction.UPDATE, new_values={"a": i}))
    db_session.commit()
    db_session.expire_all()
    with assert_max_queries(6, "audit logs") as _c:
        res = BillingAuditService(db_session).list_logs(org.id, page=1, per_page=N)
        out = BillingAuditLogListResponse.model_validate(res)
    assert len(out.items) == N
