"""
core/rate_limiter.py
--------------------
Shared rate limiter instance for the entire application.
Avoids circular imports by centralizing the limiter.
"""

import hashlib
import logging
from datetime import datetime, timezone
from functools import wraps
from typing import Any, Callable

from slowapi import Limiter
from sqlalchemy.orm import Session
from starlette.requests import Request
from slowapi.util import get_remote_address

from app.config import settings

# When REDIS_URL is configured the counters live in Redis, so rate limits are
# shared across all API workers. in_memory_fallback_enabled keeps the limiter
# usable (per-process MemoryStorage) if Redis is temporarily unreachable
# instead of failing every request; when REDIS_URL is empty this is a
# single-process in-memory limiter exactly as before.
_redis_url = settings.REDIS_URL or None
limiter = Limiter(
    key_func=get_remote_address,
    default_limits=["200/hour", "60/minute"],
    storage_uri=_redis_url,
    in_memory_fallback_enabled=bool(_redis_url),
    swallow_errors=True,
)


def limit_route(limit_value: str) -> Callable:
    """Apply a route limit while keeping direct function tests usable.

    FastAPI always supplies a ``Request`` to HTTP calls. A few legacy tests
    intentionally call synchronous router functions directly, so those calls
    bypass the transport-level limiter rather than failing because they have
    no request object. The production HTTP path still delegates to SlowAPI's
    normal enforcement and response headers.
    """
    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        limited = limiter.limit(limit_value)(func)

        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            request = kwargs.get("request")
            if not isinstance(request, Request):
                request = next((arg for arg in args if isinstance(arg, Request)), None)
            if request is None:
                return func(*args, **kwargs)
            return limited(*args, **kwargs)

        return wrapper

    return decorator


logger = logging.getLogger("zoiko_billing.ai.public")


class PublicRateLimiter:
    """Strict per-key rate limit enforced by the DATABASE, not process memory.

    Used by the UNAUTHENTICATED public assistant endpoint, where slowapi's
    in-process storage is trivially bypassed by connection spraying or a
    multi-worker deployment. Counters live in the shared database (Postgres in
    production, the SQLite dev DB is also fine) so the limit holds across
    every worker process:

        INSERT INTO ai_public_rate_limit_counter (rate_key, window_start, count)
        VALUES (:key, :window, 1)
        ON CONFLICT (rate_key, window_start) DO UPDATE SET count = count + 1
        RETURNING count

    A fresh count for a window always wins; window_start is the quantized
    start of the current window, so old rows are simply never matched again
    (and can be cleaned up opportunistically).
    """

    def __init__(self):
        from sqlalchemy.dialects import postgresql as _pg
        from sqlalchemy.dialects import sqlite as _lite

        self._upserts = {"postgresql": _pg.insert, "sqlite": _lite.insert}

    def _dialect_insert(self, db: Session):
        dialect = db.get_bind().dialect.name
        return self._upserts.get(dialect)

    def _window_start(self, window_seconds: int, now: datetime) -> datetime:
        ts = int(now.timestamp())
        start_ts = (ts // window_seconds) * window_seconds
        return datetime.fromtimestamp(start_ts, tz=timezone.utc)

    def check(self, *, db, rate_key: str, limit: int, window_seconds: int) -> bool:
        """Atomically increment the counter for (rate_key, window) and return
        whether the request is still WITHIN the limit.

        The increment is COMMITTED here regardless of what the caller does
        next: a request that later fails (or is refused a session) has still
        consumed one slot of its rate budget. Call with a clean transaction.
        """
        from app.modules.chatbot.models import PublicRateLimitCounter

        now = datetime.now(timezone.utc)
        window = self._window_start(window_seconds, now)

        ins_cls = self._dialect_insert(db)
        new_count: int | None = None
        if ins_cls is not None:
            stmt = (
                ins_cls(PublicRateLimitCounter)
                .values(
                    rate_key=rate_key,
                    window_start=window,
                    count=1,
                )
                .on_conflict_do_update(
                    index_elements=[
                        PublicRateLimitCounter.rate_key,
                        PublicRateLimitCounter.window_start,
                    ],
                    set_={"count": PublicRateLimitCounter.count + 1},
                )
                .returning(PublicRateLimitCounter.count)
            )
            try:
                new_count = db.execute(stmt).scalar_one()
            except Exception as exc:  # noqa: BLE001 — fall back to read+write
                db.rollback()
                logger.warning("public rate-limit upsert failed (%s); using read+write", exc)
        else:
            db.rollback()

        if new_count is None:
            row = (
                db.query(PublicRateLimitCounter)
                .filter(
                    PublicRateLimitCounter.rate_key == rate_key,
                    PublicRateLimitCounter.window_start == window,
                )
                .first()
            )
            if row is None:
                db.add(PublicRateLimitCounter(rate_key=rate_key, window_start=window, count=1))
                db.flush()
                new_count = 1
            else:
                row.count += 1
                new_count = row.count

        db.commit()
        return new_count <= limit

    def ip_key(self, client_ip: str | None) -> str:
        """Hash the client IP so raw addresses are never persisted."""
        raw = (client_ip or "unknown").strip()
        return "pub:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
