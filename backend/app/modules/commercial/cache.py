"""
modules/commercial/cache.py
-----------------------------
Read-mostly commercial catalog caches.

The "latest PUBLISHED CommercialPlanVersion for a plan" lookup is repeated six
places (entitlement resolution L6, snapshot recompute, plan-change preview,
compatibility checks, subscription creation, plan-change scheduling — see the
refactored call sites). That scan is only invalidated by two administrative
mutations (publish / archive), so a one-process TTL cache removes the repeated
FILTER+ORDER+FIRST while a short TTL bounds any miss.

Design rules:
- Cache only stable identifiers (version/plan ids, never ORM instances) so
  entries are not bound to a Session and cannot go detached.
- Every mutation that changes what "latest PUBLISHED" means (CommercialPlanService
  `approve_and_publish` / `archive`) MUST call invalidate_latest_published_version()
  in the same transaction.
- Single-instance only: no Redis in the deployment (docker-compose runs postgres
  only). If the platform grows to multiple API workers, replace this with a
  shared store or drop the TTL cache and accept the index scan.
"""

from __future__ import annotations

from threading import RLock

from cachetools import TTLCache
from sqlalchemy.orm import Session

LATEST_PUBLISHED_VERSION_TTL_SECONDS = 60
_latest_published_cache: TTLCache[int, int | None] = TTLCache(
    maxsize=1024, ttl=LATEST_PUBLISHED_VERSION_TTL_SECONDS
)
_lock = RLock()


def get_latest_published_version_id(db: Session, plan_id: int) -> int | None:
    """Id of the newest PUBLISHED CommercialPlanVersion for a plan, or None
    when the plan has none. Scans the DB on a miss only."""
    with _lock:
        try:
            return _latest_published_cache[plan_id]
        except KeyError:
            pass

    from app.modules.commercial.enums import CommercialPlanVersionStatus
    from app.modules.commercial.models import CommercialPlanVersion

    latest = (
        db.query(CommercialPlanVersion.id)
        .filter(
            CommercialPlanVersion.plan_id == plan_id,
            CommercialPlanVersion.status == CommercialPlanVersionStatus.PUBLISHED,
        )
        .order_by(CommercialPlanVersion.version_number.desc())
        .first()
    )
    version_id = latest.id if latest is not None else None
    with _lock:
        _latest_published_cache[plan_id] = version_id
    return version_id


def invalidate_latest_published_version(plan_id: int) -> None:
    """Drop the cached entry for a plan. Called by publish/archive so the
    next reader recomputes within the caller's transaction (before commit is
    fine: the invalidation itself is never rolled back, only the DB write
    would be — a rolled-back publish then recomputes the same old value)."""
    with _lock:
        _latest_published_cache.pop(plan_id, None)