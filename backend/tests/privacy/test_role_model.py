"""GOV-01 role model: a NULL platform_role grants nothing; EXPLICIT_ONLY
capabilities are not implicitly held by PLATFORM_ADMINISTRATOR; the
super-admin invite requires an explicit role and persists it."""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core import capabilities as caps
from app.core.dependencies import get_current_user
from app.database import Base, get_db
from app.main import app
from app.modules.auth.models import PlatformRole, User, UserRole
from tests.conftest import make_organization
from tests.privacy.conftest import control


def _super_admin(db, email, platform_role=None):
    user = User(
        email=email, hashed_password="x", role=UserRole.SUPER_ADMIN, organization_id=None,
        first_name="S", last_name="A", is_active=True, is_verified=True,
        platform_role=platform_role,
    )
    db.add(user)
    db.commit()
    return user


@pytest.fixture()
def db_session():
    """Shadows conftest's db_session with a StaticPool engine: TestClient
    serves requests from another thread, and the default :memory: pool would
    give that thread its own empty database."""
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture()
def client_for(db_session):
    def _make(user):
        app.dependency_overrides[get_db] = lambda: db_session
        app.dependency_overrides[get_current_user] = lambda: user
        return TestClient(app, raise_server_exceptions=False)

    yield _make
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)


# ── NULL grants nothing ─────────────────────────────────────────────────────

@control("IAM-01", "IAM-02")
def test_null_platform_role_has_no_capability(db_session, caplog):
    user = _super_admin(db_session, "null@role.example", None)
    with caplog.at_level("WARNING", logger="app.core.capabilities"):
        for capability in caps.CAPABILITIES:
            assert has_cap_false(user, capability), capability
    assert "no platform_role" in caplog.text


def has_cap_false(user, capability):
    return caps.has_capability(user, capability) is False


@control("IAM-01", "IAM-02")
@pytest.mark.parametrize("path", [
    "/api/super-admin/financial-consistency",
    "/api/super-admin/billing-command-center/overdue-invoices",
])
def test_null_role_super_admin_gets_403_on_capability_routes(db_session, client_for, path):
    user = _super_admin(db_session, "null403@role.example", None)
    resp = client_for(user).get(path)
    assert resp.status_code == 403, resp.text
    assert "none assigned" in resp.text


@control("IAM-01")
def test_platform_administrator_not_blocked_by_role_check(db_session, client_for):
    user = _super_admin(db_session, "pa@role.example", PlatformRole.PLATFORM_ADMINISTRATOR)
    resp = client_for(user).get("/api/super-admin/financial-consistency")
    assert resp.status_code != 403, resp.text


# ── EXPLICIT_ONLY_CAPABILITIES ──────────────────────────────────────────────

@control("IAM-04")
def test_explicit_only_set_contains_break_glass():
    assert "tenant_support.break_glass" in caps.EXPLICIT_ONLY_CAPABILITIES


@control("IAM-04")
def test_explicit_only_capability_not_implicitly_held_by_platform_admin(db_session, monkeypatch):
    capability = "financial_consistency.read"  # held explicitly by AUDITOR
    admin = _super_admin(db_session, "pa2@role.example", PlatformRole.PLATFORM_ADMINISTRATOR)
    auditor = _super_admin(db_session, "aud@role.example", PlatformRole.AUDITOR)
    support = _super_admin(db_session, "sup@role.example", PlatformRole.SUPPORT_OPERATOR)

    assert caps.has_capability(admin, capability)  # implicit grant today
    monkeypatch.setattr(caps, "EXPLICIT_ONLY_CAPABILITIES", frozenset({capability}))

    assert not caps.has_capability(admin, capability)
    assert caps.has_capability(auditor, capability)
    assert not caps.has_capability(support, capability)
    # Other capabilities remain implicitly granted.
    assert caps.has_capability(admin, "tenant_support.request")


@control("IAM-04")
def test_explicit_only_capability_can_be_held_when_admin_is_listed(db_session, monkeypatch):
    capability = "platform_role.manage"
    admin = _super_admin(db_session, "pa3@role.example", PlatformRole.PLATFORM_ADMINISTRATOR)
    monkeypatch.setattr(caps, "EXPLICIT_ONLY_CAPABILITIES", frozenset({capability}))
    monkeypatch.setitem(caps._CAPABILITY_ROLE_MAP, capability, {PlatformRole.PLATFORM_ADMINISTRATOR})
    assert caps.has_capability(admin, capability)


# ── invite requires a role and persists it ─────────────────────────────────

def _invite_payload(org_id, **extra):
    return {"organization_id": org_id, "email": "new.user@tenant.example",
            "first_name": "N", "last_name": "U", "send_invite": False, **extra}


def _org(db):
    org = make_organization(db, code="INV1", name="Invite Org")
    db.commit()
    return org


@control("IAM-01", "IAM-02")
def test_invite_without_role_is_rejected(db_session, client_for):
    admin = _super_admin(db_session, "inviter@role.example", PlatformRole.PLATFORM_ADMINISTRATOR)
    org = _org(db_session)
    resp = client_for(admin).post("/api/super-admin/users/invite", json=_invite_payload(org.id))
    assert resp.status_code == 422, resp.text
    assert db_session.query(User).filter(User.email == "new.user@tenant.example").first() is None


@control("IAM-01")
def test_invite_with_role_persists_it(db_session, client_for):
    admin = _super_admin(db_session, "inviter2@role.example", PlatformRole.PLATFORM_ADMINISTRATOR)
    org = _org(db_session)
    resp = client_for(admin).post(
        "/api/super-admin/users/invite", json=_invite_payload(org.id, role="org_admin"),
    )
    assert resp.status_code == 200, resp.text
    created = db_session.query(User).filter(User.email == "new.user@tenant.example").one()
    assert created.role == UserRole.ORG_ADMIN
    assert resp.json()["role"] == "org_admin"


@control("IAM-01", "IAM-02")
def test_invite_cannot_create_super_admin(db_session, client_for):
    admin = _super_admin(db_session, "inviter3@role.example", PlatformRole.PLATFORM_ADMINISTRATOR)
    org = _org(db_session)
    resp = client_for(admin).post(
        "/api/super-admin/users/invite", json=_invite_payload(org.id, role="super_admin"),
    )
    assert resp.status_code == 400, resp.text
