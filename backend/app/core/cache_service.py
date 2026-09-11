"""
core/cache_service.py
---------------------
Centralized application cache with Redis backend and in-process fallback.

When ``REDIS_URL`` is set and reachable, all operations use Redis. When Redis
is unreachable (startup probe fails, connection errors), every call silently
falls back to a process-local ``cachetools.TTLCache`` — the platform keeps
working and the test suite keeps passing with zero Redis infrastructure.

Design rules:
- All values are stored as JSON strings (Redis) or raw Python objects (fallback).
- Keys are namespaced with ``settings.REDIS_KEY_PREFIX`` in Redis.
- TTL is always caller-controlled; no implicit infinite caching.
- Invalidation helpers delete by exact key or scan by prefix.
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime
from decimal import Decimal
from threading import RLock
from typing import Any, Optional

from cachetools import TTLCache

from app.config import settings

logger = logging.getLogger("zoiko_billing")

# ── In-process fallback (used when Redis is unavailable) ──────────────────────

_LOCK = RLock()
_fallback: TTLCache[str, Any] = TTLCache(maxsize=4096, ttl=300)
_redis = None
_redis_ok: bool | None = None  # None = not yet probed


def _json_encoder(obj):
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, (date, datetime)):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj)} is not JSON serializable")


def _json_decoder(obj):
    return obj


def _get_redis():
    global _redis, _redis_ok
    if _redis_ok is False:
        return None
    if _redis is not None:
        return _redis
    if not settings.REDIS_URL:
        return None
    try:
        import redis as _r

        _redis = _r.Redis.from_url(
            settings.REDIS_URL,
            decode_responses=True,
            socket_connect_timeout=1,
            socket_timeout=1,
            retry_on_timeout=False,
        )
        _redis.ping()
        _redis_ok = True
        logger.info("Redis connected: %s", settings.REDIS_URL.split("@")[-1])
    except Exception as exc:
        logger.warning("Redis unavailable (%s); falling back to in-process cache", exc)
        _redis = None
        _redis_ok = False
    return _redis


def _key(name: str) -> str:
    return f"{settings.REDIS_KEY_PREFIX}:{name}"


# ── Public API ────────────────────────────────────────────────────────────────


def cache_get(name: str) -> Optional[Any]:
    """Fetch a cached value by *name* (a short namespace key without prefix)."""
    r = _get_redis()
    if r is not None:
        try:
            raw = r.get(_key(name))
            if raw is None:
                return None
            return json.loads(raw)
        except Exception:
            logger.debug("Redis GET failed for %s", name, exc_info=True)
            return None
    with _LOCK:
        return _fallback.get(name)


def cache_set(name: str, value: Any, ttl: int | None = None) -> None:
    """Store *value* under *name* for *ttl* seconds (default from settings)."""
    ttl = ttl if ttl is not None else settings.REDIS_DEFAULT_TTL
    if ttl <= 0:
        return
    r = _get_redis()
    if r is not None:
        try:
            r.setex(_key(name), ttl, json.dumps(value, default=_json_encoder))
            return
        except Exception:
            logger.debug("Redis SET failed for %s", name, exc_info=True)
    with _LOCK:
        _fallback[name] = value


def cache_delete(*names: str) -> None:
    """Delete one or more cached entries by name."""
    if not names:
        return
    r = _get_redis()
    if r is not None:
        try:
            r.delete(*[_key(n) for n in names])
            return
        except Exception:
            logger.debug("Redis DELETE failed for %s", names, exc_info=True)
    with _LOCK:
        for n in names:
            _fallback.pop(n, None)


def cache_invalidate_prefix(prefix: str) -> None:
    """Delete all keys whose name starts with *prefix*."""
    r = _get_redis()
    if r is not None:
        try:
            full_pattern = _key(f"{prefix}*")
            cursor = 0
            while True:
                cursor, keys = r.scan(cursor=cursor, match=full_pattern, count=100)
                if keys:
                    r.delete(*keys)
                if cursor == 0:
                    break
            return
        except Exception:
            logger.debug("Redis SCAN/DELETE failed for prefix %s", prefix, exc_info=True)
    with _LOCK:
        to_delete = [n for n in list(_fallback.keys()) if n.startswith(prefix)]
        for n in to_delete:
            del _fallback[n]


def cache_flush() -> None:
    """Flush the entire in-process fallback cache and close Redis.

    Called by the test-suite autouse fixture between tests to prevent
    cross-test cache contamination (auto-increment ids restart at 1 in each
    in-memory SQLite session).
    """
    global _redis, _redis_ok
    with _LOCK:
        _fallback.clear()
    if _redis is not None:
        try:
            _redis.flushdb()
        except Exception:
            pass


def cache_ping() -> bool:
    """Return True if Redis is reachable and active."""
    return _get_redis() is not None


# ── Domain invalidation helpers ────────────────────────────────────────────────

# Key namespaces coordinated with dependents across the codebase. Centralized
# so a single invalidation call drops every derived cache for one organization.

ORG_GATE_KEY = "org:gate:{org_id}"
ORG_ZOIKO_SUB_KEY = "org:zoiko_sub:{org_id}"
ENT_OPEN_SUB_KEY = "ent:open_sub:{org_id}"
ENT_ORG_VIEW_KEY = "ent:org_view:{org_id}"
BILLING_CONFIG_KEY = "billing:config:{org_id}"


def invalidate_subscription_caches(organization_id: int) -> None:
    """Called on any CommercialSubscription status change (transition(),
    start_trial_if_eligible, plan change) plus org suspend/activate writes.

    Drops the access gate, resolved entitlement cache, open-subscription
    handle, org self-service (TrialBanner) payload and entitlements view — a
    subscription transition can change all of them.
    """
    cache_delete(
        ORG_GATE_KEY.format(org_id=organization_id),
        ENT_OPEN_SUB_KEY.format(org_id=organization_id),
        ORG_ZOIKO_SUB_KEY.format(org_id=organization_id),
        ENT_ORG_VIEW_KEY.format(org_id=organization_id),
    )
    cache_invalidate_prefix(f"ent:resolved:{organization_id}")
    cache_invalidate_prefix(f"ent:snapshot:{organization_id}")


def invalidate_entitlement_caches(organization_id: int) -> None:
    """Called on entitlement-affecting writes (override approve/revoke,
    snapshot recompute, plan publish). Resolved values may change."""
    cache_invalidate_prefix(f"ent:resolved:{organization_id}")
    cache_invalidate_prefix(f"ent:snapshot:{organization_id}")
    cache_delete(ENT_ORG_VIEW_KEY.format(org_id=organization_id))


def invalidate_billing_config(organization_id: int) -> None:
    """Called on BillingConfiguration upsert/reset. Most billing services
    read config on nearly every call. Prefix-scan so all config-derived keys
    (billing:config:{org}, billing:config:{org}:currency, ...) are dropped."""
    cache_invalidate_prefix(f"billing:config:{organization_id}")


# ── Convenience helpers for common patterns ────────────────────────────────────


def cache_get_or_set(name: str, factory, ttl: int | None = None) -> Any:
    """Return cached value or compute via *factory*, cache, and return.

    ``factory`` is called with no arguments and must return a JSON-serializable
    value (or None, which is never cached).
    """
    hit = cache_get(name)
    if hit is not None:
        return hit
    value = factory()
    if value is not None:
        cache_set(name, value, ttl=ttl)
    return value
