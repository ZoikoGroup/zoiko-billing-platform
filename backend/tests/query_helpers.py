"""Shared query-count helpers for N+1 / constant-query regression tests."""
from contextlib import contextmanager

from app.core.query_counter import count_queries


@contextmanager
def assert_max_queries(n: int, label: str = ""):
    """Fail if the block issues more than ``n`` SQL statements. The failure
    message lists the statements so an N+1 is obvious at a glance."""
    with count_queries(keep_statements=True) as counter:
        yield counter
    if counter.count > n:
        shown = "\n".join(f"  {i + 1}. {s.strip()[:160]}" for i, s in enumerate(counter.statements[:40]))
        raise AssertionError(
            f"{label or 'block'} issued {counter.count} queries (max {n}):\n{shown}"
        )
