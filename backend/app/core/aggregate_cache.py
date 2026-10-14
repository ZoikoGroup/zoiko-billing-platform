"""
core/aggregate_cache.py
-----------------------
Short-TTL cache for read-heavy, slowly-changing tenant dashboard aggregates
(status distributions, trends, aging buckets, KPI-style stats, ...). Same
building blocks as the headline-KPI cache in
``billing/services/dashboard_service.py`` (``cache_service`` +
``settings.DASHBOARD_KPI_CACHE_TTL_SECONDS``; 0 disables).

Key layout (org scoping is part of the key, never inferred)::

    agg:{org_id}:{name}:{org_version}.{global_version}:{YYYY-MM-DD}:{params-json}

* ``org_id``    - tenant; one org can never read another org's entry.
* ``name``      - the aggregate (e.g. ``invoice.status_distribution``).
* ``params``    - EVERY argument that changes the result (period, date range,
                  months, currency, filters, ...), JSON with sorted keys.
* date          - relative periods ("month", "within_days") roll over at
                  midnight instead of living on for the TTL.
* versions      - invalidation tokens (below).

Invalidation is O(1): ``invalidate_dashboard_caches(org_id)`` stores a fresh
per-org version token, so all of that org's ``agg:`` entries become
unreachable at once (no Redis SCAN on the write path). It is called
automatically from a Session ``after_commit`` hook for any committed write to
a billing model that carries an ``organization_id`` (so repository-level
commits are covered too) and after ORM bulk UPDATE/DELETE on billing models
(global bump, since the org is not known from the statement).

Residual window: a read that started before a commit but stores its result
after the version bump is stored under the OLD version key, so it is never
served again - the stale-store race is closed. Staleness is otherwise bounded
by the TTL (writes that bypass the ORM, other processes without Redis).
"""

from __future__ import annotations

import copy
import json
import logging
import time
from datetime import date
from typing import Any, Callable, Optional

from sqlalchemy import event
from sqlalchemy.orm import Session

from app.config import settings
from app.core import cache_service

logger = logging.getLogger("zoiko_billing")

_ORG_VER_KEY = "aggver:{org}"
_GLOBAL_VER_KEY = "aggver:*"
# cache_service's in-process fallback clamps every ttl to 300 s; version
# tokens must outlive the longest entry TTL (MAX_TTL) so an expired token can
# never resurrect an entry from before a bump.
_VER_TTL = 300
MAX_TTL = 120


def _ttl() -> int:
    return min(int(settings.DASHBOARD_KPI_CACHE_TTL_SECONDS), MAX_TTL)


def _version(organization_id: int) -> str:
    org_v = cache_service.cache_get(_ORG_VER_KEY.format(org=organization_id)) or 0
    glob_v = cache_service.cache_get(_GLOBAL_VER_KEY) or 0
    return f"{org_v}.{glob_v}"


def build_key(name: str, organization_id: int, params: Optional[dict] = None) -> str:
    p = json.dumps(params or {}, sort_keys=True, default=str, separators=(",", ":"))
    return f"agg:{organization_id}:{name}:{_version(organization_id)}:{date.today().isoformat()}:{p}"


def cached_aggregate(
    name: str,
    organization_id: int,
    params: Optional[dict],
    factory: Callable[[], Any],
) -> Any:
    """Return the cached aggregate or compute it with ``factory()``.

    ``factory`` must return the final JSON-serializable payload (dict/list of
    plain values; Decimal/date are tolerated and normalised for the cache).
    """
    ttl = _ttl()
    if ttl <= 0:
        return factory()
    key = build_key(name, organization_id, params)
    hit = cache_service.cache_get(key)
    if hit is not None:
        # Fallback cache hands out the stored object; copy so a caller can
        # never mutate what other requests will read.
        return copy.deepcopy(hit)
    value = factory()
    if value is not None:
        try:
            normalised = json.loads(json.dumps(value, default=cache_service._json_encoder))
        except (TypeError, ValueError):
            logger.debug("aggregate %s not JSON-serializable; not cached", name)
            return value
        cache_service.cache_set(key, normalised, ttl=ttl)
    return value


def invalidate_dashboard_caches(organization_id: Optional[int] = None) -> None:
    """Drop every cached dashboard aggregate for ``organization_id`` (or for
    all orgs when None). Call AFTER the write has committed."""
    key = _GLOBAL_VER_KEY if organization_id is None else _ORG_VER_KEY.format(org=organization_id)
    cache_service.cache_set(key, time.time_ns(), ttl=_VER_TTL)


# ── Automatic invalidation on committed billing writes ───────────────────────

_INFO_KEY = "_agg_orgs"
_INFO_ALL = "_agg_all"


def _is_billing_model(obj_or_cls) -> bool:
    cls = obj_or_cls if isinstance(obj_or_cls, type) else type(obj_or_cls)
    return cls.__module__.startswith("app.modules.billing")


@event.listens_for(Session, "before_flush")
def _collect_orgs(session: Session, flush_context, instances) -> None:
    orgs = session.info.setdefault(_INFO_KEY, set())
    for coll in (session.new, session.dirty, session.deleted):
        for obj in coll:
            if _is_billing_model(obj):
                org = getattr(obj, "organization_id", None)
                if org is not None:
                    orgs.add(org)


@event.listens_for(Session, "do_orm_execute")
def _collect_bulk(state) -> None:
    if (state.is_update or state.is_delete) and state.bind_mapper is not None:
        if _is_billing_model(state.bind_mapper.class_):
            state.session.info[_INFO_ALL] = True


@event.listens_for(Session, "after_commit")
def _invalidate_on_commit(session: Session) -> None:
    orgs = session.info.pop(_INFO_KEY, None)
    bulk = session.info.pop(_INFO_ALL, False)
    try:
        if bulk:
            invalidate_dashboard_caches(None)
        for org in orgs or ():
            invalidate_dashboard_caches(org)
    except Exception:  # never fail a committed write over cache housekeeping
        logger.debug("dashboard cache invalidation failed", exc_info=True)


@event.listens_for(Session, "after_rollback")
def _discard_on_rollback(session: Session) -> None:
    session.info.pop(_INFO_KEY, None)
    session.info.pop(_INFO_ALL, None)
