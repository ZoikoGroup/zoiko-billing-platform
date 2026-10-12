"""
core/query_counter.py
----------------------
Counts SQL statements per request (and per test block) with one global
SQLAlchemy ``before_cursor_execute`` listener on the Engine class, so it
covers every engine (Postgres in prod, in-memory SQLite in tests) without
touching database.py.

Usage:
  * request middleware (main.py): ``token = start()`` ... ``n = finish(token)``
  * tests: ``with count_queries() as c: ...; assert c.count <= 6`` or the
    ``assert_max_queries`` helper in tests/query_helpers.py.

Counting is per-context (contextvars), so concurrent requests in the thread
pool never see each other's statements. Cost per statement is one
ContextVar lookup + an int increment.
"""

import contextvars
import threading
from contextlib import contextmanager
from typing import Optional

from sqlalchemy import event
from sqlalchemy.engine import Engine

_current: contextvars.ContextVar[Optional["QueryCount"]] = contextvars.ContextVar(
    "query_counter", default=None
)
_install_lock = threading.Lock()
_installed = False


class QueryCount:
    __slots__ = ("count", "statements", "keep_statements")

    def __init__(self, keep_statements: bool = False):
        self.count = 0
        self.keep_statements = keep_statements
        self.statements: list[str] = []


def _on_execute(conn, cursor, statement, parameters, context, executemany):
    counter = _current.get()
    if counter is not None:
        counter.count += 1
        if counter.keep_statements:
            counter.statements.append(statement)


def install() -> None:
    """Idempotently register the global listener."""
    global _installed
    with _install_lock:
        if not _installed:
            event.listen(Engine, "before_cursor_execute", _on_execute)
            _installed = True


def start(keep_statements: bool = False) -> contextvars.Token:
    install()
    return _current.set(QueryCount(keep_statements))


def finish(token: contextvars.Token) -> int:
    counter = _current.get()
    _current.reset(token)
    return counter.count if counter is not None else 0


@contextmanager
def count_queries(keep_statements: bool = True):
    """``with count_queries() as c: ...`` then read ``c.count`` / ``c.statements``."""
    install()
    counter = QueryCount(keep_statements)
    token = _current.set(counter)
    try:
        yield counter
    finally:
        _current.reset(token)
