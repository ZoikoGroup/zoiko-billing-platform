"""
tests/test_customer_over_credit_limit_bug15.py
----------------------------------------------
BUG-15 (/billing/customers/dashboard): the "Over Credit Limit" KPI card now
opens /billing/customers?over_credit_limit=1. The list filter must return
exactly the customers the KPI counts -- both use over_credit_limit_conditions()
(positive credit limit, stored outstanding balance above it), over every
non-deleted customer of the organization, including deactivated ones.
"""
from datetime import datetime
from decimal import Decimal

from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.routers.customer_router import list_customers
from tests.conftest import make_customer, make_organization


def _cust(db, org, code, limit, outstanding, **kw):
    c = make_customer(db, org.id, code=code, email=f"{code.lower()}@example.com")
    c.credit_limit = Decimal(str(limit))
    c.outstanding_balance = Decimal(str(outstanding))
    for k, v in kw.items():
        setattr(c, k, v)
    db.flush()
    return c


def _setup(db):
    org = make_organization(db, "OCL1")
    other = make_organization(db, "OCL2", name="Other Org")
    expected = {
        _cust(db, org, "OVER", 100, 150).id,
        _cust(db, org, "OVER-INACTIVE", 100, 101, is_active=False).id,
    }
    _cust(db, org, "UNDER", 100, 50)
    _cust(db, org, "EQUAL", 100, 100)                       # not *over* the limit
    _cust(db, org, "NO-LIMIT", 0, 500)                       # no credit limit set
    _cust(db, org, "DELETED-OVER", 100, 999, deleted_at=datetime.utcnow())
    _cust(db, other, "OTHER-ORG-OVER", 10, 999)              # another tenant
    db.commit()
    return org, expected


def test_filter_returns_exactly_the_customers_the_kpi_counts(db_session):
    org, expected = _setup(db_session)
    svc = CustomerService(db_session)
    kpi = svc.get_kpi_data(org.id)["customers_over_credit_limit"]
    listed = svc.list_customers(org.id, over_credit_limit=True, per_page=100)
    ids = {c.id for c in listed["items"]}
    assert ids == expected
    assert listed["total"] == kpi == 2


def test_without_the_flag_the_list_is_unchanged(db_session):
    org, _ = _setup(db_session)
    listed = CustomerService(db_session).list_customers(org.id, per_page=100)
    codes = {c.customer_code for c in listed["items"]}
    assert {"OVER", "UNDER", "EQUAL", "NO-LIMIT"} <= codes
    assert "OVER-INACTIVE" not in codes and "DELETED-OVER" not in codes   # default active-only view


def test_router_exposes_the_filter_and_stays_tenant_scoped(db_session):
    org, expected = _setup(db_session)

    class User:  # minimal current_user
        organization_id = org.id
        id = 1

    out = list_customers(db=db_session, current_user=User(), page=1, per_page=100, search_term=None, customer_type=None,
                         status=None, country=None, currency=None, industry=None, credit_limit_min=None,
                         credit_limit_max=None, payment_terms=None, date_from=None, date_to=None,
                         over_credit_limit=True, sort_by="company_name", sort_order="asc")
    assert {c.id for c in out["items"]} == expected
