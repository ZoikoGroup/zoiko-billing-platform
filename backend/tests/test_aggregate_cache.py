"""Tests for the short-TTL tenant dashboard aggregate cache
(app/core/aggregate_cache.py + the billing routers that use it).

Router handlers are called directly (a stand-in user carries only
organization_id, which is all these handlers read) so the query counts are
exactly the aggregate's own queries, not auth/middleware ones."""
import json
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.config import settings
from app.core import cache_service
from app.core.aggregate_cache import build_key, cached_aggregate, invalidate_dashboard_caches
from app.modules.billing.models import Invoice, InvoiceStatus
from app.modules.billing.routers import (
    collection_router, dashboard_router, invoice_router, payment_router,
    refund_router, subscription_router,
)
from tests.conftest import make_customer, make_invoice, make_organization
from tests.query_helpers import assert_max_queries


def _user(org):
    return SimpleNamespace(organization_id=org.id)


def _two_orgs(db):
    a = make_organization(db, code="AGA", name="Agg A")
    b = make_organization(db, code="AGB", name="Agg B")
    ca = make_customer(db, a.id, code="CA")
    cb = make_customer(db, b.id, code="CB")
    make_invoice(db, a.id, ca.id, total_amount="100.00", invoice_number="A-1")
    make_invoice(db, b.id, cb.id, total_amount="900.00", invoice_number="B-1")
    make_invoice(db, b.id, cb.id, total_amount="50.00", invoice_number="B-2", status=InvoiceStatus.PAID)
    ids = (SimpleNamespace(id=a.id), SimpleNamespace(id=b.id))
    db.commit()
    return ids


def _status_dist(db, org):
    return invoice_router.get_status_distribution(db=db, current_user=_user(org))


def _norm(value):
    return json.loads(json.dumps(value, default=cache_service._json_encoder))


ENDPOINTS = [
    ("invoice status_distribution", lambda db, o: invoice_router.get_status_distribution(db=db, current_user=_user(o))),
    ("invoice dashboard_stats", lambda db, o: invoice_router.get_dashboard_stats(period=None, db=db, current_user=_user(o))),
    ("invoice enterprise", lambda db, o: invoice_router.get_enterprise_dashboard(date_from=None, date_to=None, db=db, current_user=_user(o))),
    ("invoice revenue_trend", lambda db, o: invoice_router.get_revenue_trend(months=6, db=db, current_user=_user(o))),
    ("invoice invoice_trend", lambda db, o: invoice_router.get_invoice_trend(months=6, db=db, current_user=_user(o))),
    ("collections aging", lambda db, o: collection_router.get_aging_buckets(db=db, current_user=_user(o))),
    ("collections queue", lambda db, o: collection_router.get_collections_queue(db=db, current_user=_user(o))),
    ("payment dashboard_stats", lambda db, o: payment_router.get_dashboard_stats(db=db, current_user=_user(o))),
    ("dashboard payment_trend", lambda db, o: dashboard_router.get_payment_trend(period=None, date_from=None, date_to=None, db=db, current_user=_user(o))),
    ("dashboard monthly_revenue", lambda db, o: dashboard_router.get_monthly_revenue(months=12, period=None, date_from=None, date_to=None, db=db, current_user=_user(o))),
    ("subscription reporting", lambda db, o: subscription_router.get_subscription_reporting(db=db, current_user=_user(o))),
    ("refund dashboard_stats", lambda db, o: refund_router.get_dashboard_stats(db=db, current_user=_user(o))),
]


@pytest.mark.parametrize("label,call", ENDPOINTS, ids=[e[0] for e in ENDPOINTS])
def test_miss_then_zero_query_hit_equal_to_uncached(db_session, monkeypatch, label, call):
    a, _ = _two_orgs(db_session)
    # Some aggregates lazily create the org's default BillingConfiguration row
    # (a committed write -> invalidates the org's entries by design), so warm
    # that up uncached first; steady state is what is being asserted.
    with monkeypatch.context() as m:
        m.setattr(settings, "DASHBOARD_KPI_CACHE_TTL_SECONDS", 0)
        call(db_session, a)
    with assert_max_queries(10_000) as first_count:
        first = call(db_session, a)
    assert first_count.count > 0, "first call must hit the DB"
    with assert_max_queries(0, label):
        second = call(db_session, a)
    assert _norm(second) == _norm(first)
    with monkeypatch.context() as m:
        m.setattr(settings, "DASHBOARD_KPI_CACHE_TTL_SECONDS", 0)
        fresh = call(db_session, a)
    assert _norm(fresh) == _norm(second), "cached payload must equal the uncached result"


def test_org_isolation(db_session):
    a, b = _two_orgs(db_session)
    dist_a = _status_dist(db_session, a)
    dist_b = _status_dist(db_session, b)
    assert dist_a != dist_b, "fixture orgs must differ for this test to mean anything"
    with assert_max_queries(0):
        assert _status_dist(db_session, a) == dist_a
        assert _status_dist(db_session, b) == dist_b
    assert build_key("x", a.id, {}) != build_key("x", b.id, {})
    assert build_key("x", 1, {}) != build_key("x", 11, {})


def test_filter_isolation(db_session):
    a, _ = _two_orgs(db_session)
    r3 = invoice_router.get_invoice_trend(months=3, db=db_session, current_user=_user(a))
    with assert_max_queries(10_000) as c:
        invoice_router.get_invoice_trend(months=12, db=db_session, current_user=_user(a))
    assert c.count > 0, "different filter must miss"
    with assert_max_queries(0):
        assert invoice_router.get_invoice_trend(months=3, db=db_session, current_user=_user(a)) == r3
    assert build_key("n", 1, {"months": 3}) != build_key("n", 1, {"months": 12})
    assert build_key("n", 1, {"a": None, "b": "2024-01-01"}) != build_key("n", 1, {"a": "2024-01-01", "b": None})


def test_date_range_filter_isolation(db_session):
    a, _ = _two_orgs(db_session)
    kw = dict(period=None, db=db_session, current_user=_user(a))
    dashboard_router.get_payment_trend(date_from=None, date_to=None, **kw)
    with assert_max_queries(10_000) as c:
        dashboard_router.get_payment_trend(date_from="2020-01-01", date_to="2020-03-31", **kw)
    assert c.count > 0


def test_rollback_keeps_cache_commit_invalidates(db_session):
    a, _ = _two_orgs(db_session)
    before = _status_dist(db_session, a)
    ca = make_customer(db_session, a.id, code="CA2")
    make_invoice(db_session, a.id, ca.id, total_amount="10.00", invoice_number="A-2", status=InvoiceStatus.OVERDUE)
    db_session.rollback()
    with assert_max_queries(0):
        assert _status_dist(db_session, a) == before
    ca = make_customer(db_session, a.id, code="CA3")
    make_invoice(db_session, a.id, ca.id, total_amount="10.00", invoice_number="A-3", status=InvoiceStatus.OVERDUE)
    db_session.commit()
    assert _status_dist(db_session, a) != before, "committed write must invalidate"


def test_write_in_other_org_does_not_invalidate(db_session):
    a, b = _two_orgs(db_session)
    _status_dist(db_session, a)
    cb = make_customer(db_session, b.id, code="CB2")
    make_invoice(db_session, b.id, cb.id, invoice_number="B-9")
    db_session.commit()
    with assert_max_queries(0):
        _status_dist(db_session, a)


def test_status_change_and_bulk_delete_invalidate(db_session):
    a, _ = _two_orgs(db_session)
    before = _status_dist(db_session, a)
    inv = db_session.query(Invoice).filter(Invoice.organization_id == a.id).first()
    inv.status = InvoiceStatus.PAID
    db_session.commit()
    mid = _status_dist(db_session, a)
    assert mid != before
    db_session.query(Invoice).filter(Invoice.organization_id == a.id).delete(synchronize_session="fetch")
    db_session.commit()
    assert _status_dist(db_session, a) != mid


def test_explicit_invalidate_helper(db_session):
    a, _ = _two_orgs(db_session)
    _status_dist(db_session, a)
    invalidate_dashboard_caches(a.id)
    with assert_max_queries(10_000) as c:
        _status_dist(db_session, a)
    assert c.count > 0


def test_zero_ttl_disables(db_session, monkeypatch):
    a, _ = _two_orgs(db_session)
    monkeypatch.setattr(settings, "DASHBOARD_KPI_CACHE_TTL_SECONDS", 0)
    _status_dist(db_session, a)
    with assert_max_queries(10_000) as c:
        _status_dist(db_session, a)
    assert c.count > 0


def test_json_roundtrip_of_decimal_and_date_values():
    calls = []

    def factory():
        calls.append(1)
        return {"amt": Decimal("12.50"), "d": date(2024, 1, 2), "rows": [{"n": 1}]}

    cached_aggregate("t.rt", 7, {"p": 1}, factory)
    second = cached_aggregate("t.rt", 7, {"p": 1}, factory)
    assert len(calls) == 1
    assert second == {"amt": 12.5, "d": "2024-01-02", "rows": [{"n": 1}]}
    second["rows"].append("mutated")  # callers cannot poison the cache
    assert cached_aggregate("t.rt", 7, {"p": 1}, factory)["rows"] == [{"n": 1}]
    cached_aggregate("t.rt", 8, {"p": 1}, factory)
    assert len(calls) == 2


def test_unserializable_value_is_returned_not_cached():
    calls = []

    def factory():
        calls.append(1)
        return {"x": object()}

    cached_aggregate("t.bad", 1, {}, factory)
    cached_aggregate("t.bad", 1, {}, factory)
    assert len(calls) == 2
