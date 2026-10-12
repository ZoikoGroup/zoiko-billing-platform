"""
core/auth_cache.py
------------------
Short-lived cache of the *minimal* authenticated-user fields that
``core.dependencies.get_current_user`` needs on every request
(id, role, organization_id, is_active), so a repeat request within the TTL
does not run a ``users`` query.

Correctness model
~~~~~~~~~~~~~~~~~
* Only active users are cached; an inactive/missing user always hits the DB.
* The JWT role/org claims are still compared on every request against the
  cached values.
* EXPLICIT invalidation: a session-level listener (below) watches every ORM
  flush for writes to ``User`` / ``SuperAdminMFA`` / ``Organization`` /
  ``EntitlementSnapshot`` / ``CommercialOverride`` and drops the derived cache
  entries (a) immediately after the flush and (b) again after COMMIT, which
  closes the window where a concurrent request could re-cache pre-commit
  state. This covers every write path (role change, org change, activation /
  deactivation, password change/reset, MFA reset/disable, deletion, org
  suspension) without each call site having to remember to invalidate.
  ``invalidate_user_cache`` / ``invalidate_org_users`` are also exposed for
  bulk ``Query.update()`` paths that bypass the ORM (none exist today).
* Cross-worker: with Redis (REDIS_URL) invalidation is shared by all workers
  and the TTL is AUTH_USER_CACHE_TTL (default 15 s, hard upper bound for any
  missed invalidation). WITHOUT Redis the cache is process-local, so another
  worker cannot see an invalidation: when WEB_CONCURRENCY>1 the TTL is
  clamped to 5 s. Set AUTH_USER_CACHE_TTL=0 to disable the cache entirely.
"""

from __future__ import annotations

import logging
import os

from sqlalchemy import event, inspect as sa_inspect
from sqlalchemy.orm import Session, make_transient_to_detached

from app.core import cache_service

logger = logging.getLogger("zoiko_billing")

USER_KEY = "auth:user:{user_id}"
_NO_REDIS_MULTI_WORKER_TTL = 5


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def user_cache_ttl() -> int:
    ttl = _int_env("AUTH_USER_CACHE_TTL", 15)
    if ttl <= 0:
        return 0
    if _int_env("WEB_CONCURRENCY", 1) > 1 and not cache_service.cache_ping():
        ttl = min(ttl, _NO_REDIS_MULTI_WORKER_TTL)
    return ttl


# ── Read / write ──────────────────────────────────────────────────────────────


def get_cached_user(db: Session, user_id: int):
    """Return a lightweight ``User`` attached to *db* built from the cache, or
    None on a miss. Only id/role/organization_id/is_active are populated;
    touching any other column lazily loads the row (one query), exactly as
    before for handlers that need more than the auth fields."""
    entry = cache_service.cache_get(USER_KEY.format(user_id=user_id))
    if not isinstance(entry, dict) or entry.get("id") != user_id:
        return None

    from app.modules.auth.models import User, UserRole

    # If this session already holds the row, let the normal query path run.
    key = sa_inspect(User).identity_key_from_primary_key((user_id,))
    if key in db.identity_map:
        return None
    try:
        user = User()
        user.id = entry["id"]
        user.role = UserRole(entry["role"])
        user.organization_id = entry["organization_id"]
        user.is_active = bool(entry["is_active"])
        make_transient_to_detached(user)
        db.add(user)
    except Exception:  # noqa: BLE001 - never let the cache break auth
        logger.debug("auth cache rebuild failed for user %s", user_id, exc_info=True)
        return None
    return user


def store_user(user) -> None:
    ttl = user_cache_ttl()
    if ttl <= 0 or not user.is_active:
        return
    role = getattr(user.role, "value", user.role)
    cache_service.cache_set(
        USER_KEY.format(user_id=user.id),
        {
            "id": user.id,
            "role": str(role),
            "organization_id": user.organization_id,
            "is_active": True,
        },
        ttl=ttl,
    )


# ── Invalidation helpers ─────────────────────────────────────────────────────


def invalidate_user_cache(user_id) -> None:
    if user_id is not None:
        cache_service.cache_delete(USER_KEY.format(user_id=user_id))


def invalidate_org_users(db: Session, organization_id) -> None:
    """Drop cached auth state for every user of an organization."""
    if organization_id is None:
        return
    from app.modules.auth.models import User

    ids = [r[0] for r in db.query(User.id).filter(User.organization_id == organization_id).all()]
    if ids:
        cache_service.cache_delete(*[USER_KEY.format(user_id=i) for i in ids])


# ── Session listener: invalidate on every relevant ORM write ─────────────────

_PENDING = "_auth_cache_pending"


def _collect(session: Session) -> dict:
    pending = session.info.setdefault(_PENDING, {"users": set(), "orgs": set(), "ent": set()})
    for obj in list(session.new) + list(session.dirty) + list(session.deleted):
        name = type(obj).__name__
        if name == "User":
            if obj.id is not None:
                pending["users"].add(obj.id)
        elif name == "SuperAdminMFA":
            if getattr(obj, "user_id", None) is not None:
                pending["users"].add(obj.user_id)
        elif name == "Organization":
            if obj.id is not None:
                pending["orgs"].add(obj.id)
        elif name in ("EntitlementSnapshot", "CommercialOverride"):
            if getattr(obj, "organization_id", None) is not None:
                pending["ent"].add(obj.organization_id)
    return pending


def _apply(pending: dict, *, clear: bool) -> None:
    from app.core.dependencies import invalidate_org_gate

    for uid in tuple(pending["users"]):
        invalidate_user_cache(uid)
    for oid in tuple(pending["orgs"]):
        invalidate_org_gate(oid)
    for oid in tuple(pending["ent"]):
        cache_service.invalidate_entitlement_caches(oid)
    if clear:
        for v in pending.values():
            v.clear()


@event.listens_for(Session, "after_flush")
def _after_flush(session, flush_context):
    try:
        pending = _collect(session)
        # keep the ids for the post-commit pass
        _apply(pending, clear=False)
    except Exception:  # noqa: BLE001
        logger.debug("auth cache after_flush invalidation failed", exc_info=True)


@event.listens_for(Session, "after_commit")
def _after_commit(session):
    try:
        pending = session.info.get(_PENDING)
        if pending:
            _apply(pending, clear=True)
    except Exception:  # noqa: BLE001
        logger.debug("auth cache after_commit invalidation failed", exc_info=True)


@event.listens_for(Session, "after_rollback")
def _after_rollback(session):
    pending = session.info.get(_PENDING)
    if pending:
        # State may have been observed (and cached) between flush and rollback.
        try:
            _apply(pending, clear=True)
        except Exception:  # noqa: BLE001
            pass
