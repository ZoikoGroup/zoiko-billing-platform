"""
modules/commercial/cache.py
----------------------------
Read-mostly commercial catalog caches.

The "latest PUBLISHED CommercialPlanVersion for a plan" lookup is repeated six
places (entitlement resolution L6, snapshot recompute, plan-change preview,
compatibility checks, subscription creation, plan-change scheduling — see the
refactored call sites). That scan is only invalidated by two administrative
mutations (publish / archive), so a TTL cache removes the repeated
FILTER+ORDER+FIRST while a short TTL bounds any miss.

Backend is the shared distributed cache (Redis when REDIS_URL is set, with an
in-process fallback) — see app/core/cache_service.py. Safe across multiple
API workers, unlike the former process-local cachetools only.

Design rules:
- Cache only stable identifiers (version/plan ids, never ORM instances) so
  entries are not bound to a Session and cannot go detached.
- Every mutation that changes what "latest PUBLISHED" means (CommercialPlanService
  `approve_and_publish` / `archive`) MUST call invalidate_latest_published_version()
  in the same transaction.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.core import cache_service

LATEST_PUBLISHED_VERSION_TTL_SECONDS = 60
_KEY = "commercial:latest_published_version:{plan_id}"


def get_latest_published_version_id(db: Session, plan_id: int) -> int | None:
    """Id of the newest PUBLISHED CommercialPlanVersion for a plan, or None
    when the plan has none. Scans the DB on a miss only."""
    from app.modules.commercial.enums import CommercialPlanVersionStatus
    from app.modules.commercial.models import CommercialPlanVersion

    def _load() -> int | None:
        latest = (
            db.query(CommercialPlanVersion.id)
            .filter(
                CommercialPlanVersion.plan_id == plan_id,
                CommercialPlanVersion.status == CommercialPlanVersionStatus.PUBLISHED,
            )
            .order_by(CommercialPlanVersion.version_number.desc())
            .first()
        )
        return latest.id if latest is not None else None

    return cache_service.cache_get_or_set(
        _KEY.format(plan_id=plan_id),
        _load,
        ttl=LATEST_PUBLISHED_VERSION_TTL_SECONDS,
    )


def invalidate_latest_published_version(plan_id: int) -> None:
    """Drop the cached entry for a plan. Called by publish/archive so the
    next reader recomputes within the caller's transaction (before commit is
    fine: the invalidation itself is never rolled back, only the DB write
    would be — a rolled-back publish then recomputes the same old value)."""
    cache_service.cache_delete(_KEY.format(plan_id=plan_id))