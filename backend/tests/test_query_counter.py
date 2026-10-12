from sqlalchemy import text

from app.core import api_metrics
from tests.query_helpers import assert_max_queries


def test_counter_counts_statements_in_block(db_session):
    with assert_max_queries(3) as c:
        db_session.execute(text("select 1"))
        db_session.execute(text("select 2"))
    assert c.count == 2


def test_assert_max_queries_fails_with_statement_list(db_session):
    try:
        with assert_max_queries(1):
            db_session.execute(text("select 1"))
            db_session.execute(text("select 2"))
    except AssertionError as exc:
        assert "issued 2 queries" in str(exc) and "select 2" in str(exc)
    else:
        raise AssertionError("expected failure")


def test_route_snapshot_percentiles_and_queries():
    api_metrics.reset_routes()
    for i in range(1, 101):
        api_metrics.record_route("GET", "/api/x/{id}", float(i), 200, 3)
    api_metrics.record_route("GET", "/api/x/{id}", 500.0, 500, 9)
    row = api_metrics.route_snapshot()[0]
    assert row["route"] == "/api/x/{id}" and row["count"] == 101
    assert row["p50_ms"] <= 51 and row["p95_ms"] >= 95
    assert row["max_queries"] == 9 and row["server_errors"] == 1
