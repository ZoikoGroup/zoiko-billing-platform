"""
Section 4 (per-request overhead): the short-TTL authenticated-user cache
(core/auth_cache.py) used by core.dependencies.get_current_user, and its
IMMEDIATE invalidation on every relevant write.

Each simulated "request" uses a fresh Session (like get_db does), because a
session that already holds the User row in its identity map deliberately
skips the cache. In-memory SQLite only.
"""
import pytest
from sqlalchemy.orm import Session

from app.core import auth_cache, cache_service
from app.core.dependencies import get_current_user
from app.core.exceptions import UnauthorizedException
from app.core.security import create_access_token, hash_password
from app.modules.auth.models import SuperAdminMFA, User, UserRole
from tests.conftest import make_organization
from tests.query_helpers import assert_max_queries


@pytest.fixture()
def org(db_session):
    return make_organization(db_session, code="UCORG1", name="User Cache Org 1")


def _user(db, org, role=UserRole.ORG_ADMIN, email="cache@example.com", active=True):
    u = User(
        email=email, hashed_password=hash_password("CorrectPass123!"), role=role,
        organization_id=org.id if org else None, first_name="C", last_name="U",
        phone="", is_active=active, is_verified=True,
    )
    db.add(u)
    db.commit()
    return u


def _token(u):
    return create_access_token(data={
        "sub": u.email, "role": u.role.value, "user_id": u.id, "organization_id": u.organization_id,
    })


def _call(db_session, token):
    s = Session(bind=db_session.get_bind())
    try:
        u = get_current_user(token=token, db=s)
        return (u.id, u.role, u.organization_id, u.is_active)
    finally:
        s.close()


# (a) second call within the TTL makes zero user queries --------------------

def test_second_call_within_ttl_makes_no_queries(db_session, org):
    user = _user(db_session, org)
    token = _token(user)
    uid = user.id
    assert _call(db_session, token)[0] == uid  # warms the cache
    with assert_max_queries(0, "cached get_current_user"):
        assert _call(db_session, token)[0] == uid


def test_cached_user_lazy_loads_other_columns(db_session, org):
    user = _user(db_session, org)
    token = _token(user)
    _call(db_session, token)
    s = Session(bind=db_session.get_bind())
    cached = get_current_user(token=token, db=s)
    with assert_max_queries(1, "lazy column load"):
        assert cached.email == "cache@example.com"
    s.close()


def test_cache_disabled_via_env(db_session, org, monkeypatch):
    monkeypatch.setenv("AUTH_USER_CACHE_TTL", "0")
    user = _user(db_session, org)
    token = _token(user)
    _call(db_session, token)
    with assert_max_queries(10) as c:
        _call(db_session, token)
    assert c.count >= 1


def test_multiworker_without_redis_clamps_ttl(monkeypatch):
    monkeypatch.setenv("WEB_CONCURRENCY", "4")
    monkeypatch.setattr(cache_service, "cache_ping", lambda: False)
    assert auth_cache.user_cache_ttl() <= 5
    monkeypatch.setattr(cache_service, "cache_ping", lambda: True)
    assert auth_cache.user_cache_ttl() == 15


# (b) invalidation is immediate ---------------------------------------------

def test_deactivation_rejects_on_next_call(db_session, org):
    user = _user(db_session, org)
    token = _token(user)
    _call(db_session, token)
    assert cache_service.cache_get(auth_cache.USER_KEY.format(user_id=user.id)) is not None
    user.is_active = False
    db_session.commit()
    with pytest.raises(UnauthorizedException):
        _call(db_session, token)


def test_reactivation_accepted_on_next_call(db_session, org):
    user = _user(db_session, org, active=False)
    token = _token(user)
    with pytest.raises(UnauthorizedException):
        _call(db_session, token)
    user.is_active = True
    db_session.commit()
    assert _call(db_session, token)[0] == user.id


def test_role_change_seen_immediately(db_session, org):
    user = _user(db_session, org, role=UserRole.BILLING_ADMIN)
    token = _token(user)
    assert _call(db_session, token)[1] == UserRole.BILLING_ADMIN
    user.role = UserRole.AUDITOR
    db_session.commit()
    # stale JWT role no longer matches -> rejected, not served from cache
    with pytest.raises(UnauthorizedException):
        _call(db_session, token)
    assert _call(db_session, _token(user))[1] == UserRole.AUDITOR


def test_org_change_reflected_immediately(db_session, org):
    other = make_organization(db_session, code="UCORG2", name="User Cache Org 2")
    user = _user(db_session, org)
    token = _token(user)
    assert _call(db_session, token)[2] == org.id
    user.organization_id = other.id
    db_session.commit()
    with pytest.raises(UnauthorizedException):
        _call(db_session, token)
    assert _call(db_session, _token(user))[2] == other.id


def test_org_suspension_drops_org_gate_cache(db_session, org):
    from app.core.dependencies import _get_org_gate

    assert _get_org_gate(db_session, org.id)["org_active"] is True
    org.is_active = False
    db_session.commit()
    assert _get_org_gate(db_session, org.id)["org_active"] is False


def test_password_change_drops_cached_auth_state(db_session, org):
    from app.modules.auth import service as auth_service

    user = _user(db_session, org)
    _call(db_session, _token(user))
    key = auth_cache.USER_KEY.format(user_id=user.id)
    assert cache_service.cache_get(key) is not None
    auth_service.change_password(db_session, user.id, "CorrectPass123!", "NewPassw0rd!234")
    assert cache_service.cache_get(key) is None


def test_mfa_reset_drops_cached_auth_state(db_session, org):
    sa = _user(db_session, None, role=UserRole.SUPER_ADMIN, email="sa@example.com")
    _call(db_session, _token(sa))
    key = auth_cache.USER_KEY.format(user_id=sa.id)
    assert cache_service.cache_get(key) is not None
    row = SuperAdminMFA(user_id=sa.id, secret_encrypted="x", is_enabled=True)
    db_session.add(row)
    db_session.commit()
    assert cache_service.cache_get(key) is None  # enrollment write dropped it
    _call(db_session, _token(sa))
    assert cache_service.cache_get(key) is not None
    row.is_enabled = False  # disable / reset
    row.secret_encrypted = ""
    db_session.commit()
    assert cache_service.cache_get(key) is None


def test_user_deletion_rejects_on_next_call(db_session, org):
    user = _user(db_session, org)
    token = _token(user)
    _call(db_session, token)
    db_session.delete(user)
    db_session.commit()
    with pytest.raises(UnauthorizedException):
        _call(db_session, token)


def test_rollback_does_not_leave_stale_entry_semantics(db_session, org):
    user = _user(db_session, org)
    token = _token(user)
    _call(db_session, token)
    user.is_active = False
    db_session.flush()
    db_session.rollback()
    assert _call(db_session, token)[3] is True


def test_invalidate_helpers(db_session, org):
    user = _user(db_session, org)
    _call(db_session, _token(user))
    key = auth_cache.USER_KEY.format(user_id=user.id)
    auth_cache.invalidate_org_users(db_session, org.id)
    assert cache_service.cache_get(key) is None
    _call(db_session, _token(user))
    auth_cache.invalidate_user_cache(user.id)
    assert cache_service.cache_get(key) is None


# entitlement reads reflect recompute / plan change on the very next call ----

def test_entitlement_read_reflects_recompute_immediately(db_session):
    from app.modules.commercial.entitlement_resolver import resolve_entitlement
    from app.modules.commercial.entitlement_snapshot_service import EntitlementSnapshotService
    from app.modules.commercial.models import PlanEntitlement
    from tests.test_commercial_entitlements import _org_with_active_subscription, _plan_with_entitlement

    plan, definition = _plan_with_entitlement(db_session, "UCPKG", "uc.key", True)
    org, account, sub = _org_with_active_subscription(db_session, "UCENT", plan)
    db_session.commit()
    assert resolve_entitlement(db_session, org.id, "uc.key").value is True
    with assert_max_queries(1, "cached entitlement read (definition lookup only)"):
        assert resolve_entitlement(db_session, org.id, "uc.key").value is True

    row = db_session.query(PlanEntitlement).filter(
        PlanEntitlement.entitlement_definition_id == definition.id).first()
    row.value = False
    EntitlementSnapshotService(db_session).recompute_snapshot(org.id, reason="test")
    db_session.commit()
    assert resolve_entitlement(db_session, org.id, "uc.key").value is False
