"""
core/worker_safety.py
---------------------
Multi-worker safety helpers (see docs/PERFORMANCE_DEPLOYMENT.md).

* Scheduler leader election: with N gunicorn/uvicorn workers every process runs
  the app lifespan, so an in-process APScheduler would run each job N times.
  Only the worker that wins a Postgres session-level advisory lock starts it.
  The lock lives on a dedicated connection held for the process lifetime and
  is released by Postgres automatically if the process dies.
* Startup warning when running several workers without Redis (in-process cache
  and slowapi rate limits would be per-worker).
"""

import logging
from typing import Optional

from sqlalchemy import text  # type: ignore[import]

logger = logging.getLogger("zoiko_billing")

# Arbitrary stable 64-bit key ("zoikosch").
SCHEDULER_ADVISORY_LOCK_KEY = 0x7A6F696B6F736368

_leader_conn = None


def try_acquire_scheduler_leadership(engine, lock_enabled: bool = True) -> bool:
    """True if this process may run the scheduler.

    SQLite / lock disabled -> True (single-process behaviour preserved; with the
    lock disabled the operator must enable the scheduler on one instance only).
    Postgres -> True only for the process that gets the advisory lock. Any
    failure to talk to the DB fails closed (False): a skipped scheduler is
    safer than a duplicated one.
    """
    global _leader_conn
    if not lock_enabled or engine.dialect.name != "postgresql":
        return True
    if _leader_conn is not None:
        return True  # this process already leads
    conn = None
    try:
        conn = engine.connect()
        got = bool(conn.execute(
            text("SELECT pg_try_advisory_lock(:k)"), {"k": SCHEDULER_ADVISORY_LOCK_KEY}
        ).scalar())
        conn.commit()  # end the txn; session-level lock persists on the connection
    except Exception as exc:  # noqa: BLE001
        logger.warning("Scheduler leader election failed (%s); not starting scheduler here.", exc)
        if conn is not None:
            conn.close()
        return False
    if not got:
        conn.close()
        return False
    _leader_conn = conn
    return True


def release_scheduler_leadership() -> None:
    global _leader_conn
    conn, _leader_conn = _leader_conn, None
    if conn is None:
        return
    try:
        conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": SCHEDULER_ADVISORY_LOCK_KEY})
        conn.commit()
    except Exception:  # noqa: BLE001
        pass
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def multiworker_without_redis(web_concurrency: int, redis_url: Optional[str], debug: bool) -> bool:
    return (not debug) and int(web_concurrency or 1) > 1 and not (redis_url or "").strip()


def warn_if_multiworker_without_redis(settings) -> None:
    if multiworker_without_redis(settings.WEB_CONCURRENCY, settings.REDIS_URL, settings.DEBUG):
        logger.warning(
            "WEB_CONCURRENCY=%s but REDIS_URL is unset: the response cache and rate limits "
            "are per-worker (in-memory), so limits are effectively multiplied and caches "
            "diverge. Set REDIS_URL in production.", settings.WEB_CONCURRENCY,
        )
