"""
tests/test_session8_login_currency_notification.py
----------------------------------------------------
Session 8 coverage — ZB-SA-CMD-003 v3.0 master directive, three
non-negotiables:

  1. Normal Super Admin login requires NO MFA screen: a valid password
     yields real tokens for every role; no mfa_status/mfa_token side-channel
     exists anywhere in the login contract.
  2. Privileged step-up MFA is still enforced server-side (no fallback):
     breaker toggles and approval decisions demand a fresh TOTP/recovery
     code via mfa_service.verify_step_up.
  3. Currency is ALWAYS derived from the registered country with NO silent
     USD fallback: an unmapped country without an explicit supported
     currency is an explicit error, on both creation paths (self-serve
     registration AND Super Admin organization creation).
  4. Every successful organization creation notifies all ACTIVE Super Admins
     by real email (operational metadata only — never secrets), wired into
     both creation paths, with per-recipient failure isolation.

Run: cd backend && python -m pytest tests/test_session8_login_currency_notification.py -q
"""

import bcrypt
import pyotp
import pytest
from pydantic import ValidationError

from app.core.exceptions import BadRequestException, UnauthorizedException
from app.core.mfa_crypto import encrypt_secret
from app.core.security import decode_access_token, hash_password
from app.modules.auth.models import SuperAdminMFA, User, UserRole
from app.modules.auth.schemas import RegisterRequest
from app.modules.auth.service import login_user, register_enterprise
from app.modules.auth.country_currency import resolve_currency
from app.modules.organizations.models import Organization
from app.modules.organizations.router import create_organization
from app.modules.organizations.schemas import OrganizationBase
from app.modules.super_admin.models import BillingKillSwitch
from app.modules.super_admin.kill_switch_service import TENANT_DUNNING
from app.modules.super_admin.router import (
    _apply_breaker_toggle,
    decide_approval_request,
    propose_circuit_breaker_change,
)
from app.modules.super_admin.schemas import (
    ApprovalDecisionRequest,
    CircuitBreakerChangeProposalCreate,
    CircuitBreakerToggleRequest,
)
from tests.conftest import make_organization


# ── helpers ──────────────────────────────────────────────────────────────────

def _user(db, email, role, organization_id=None, hashed=None, is_active=True):
    user = User(
        email=email, hashed_password=hashed or hash_password("pw"), role=role,
        organization_id=organization_id,
        first_name="T", last_name="U", is_active=is_active, is_verified=True,
    )
    db.add(user)
    db.flush()
    return user


def _super_admin_with_mfa(db, email):
    user = _user(db, email, UserRole.SUPER_ADMIN)
    secret = pyotp.random_base32()
    db.add(SuperAdminMFA(user_id=user.id, secret_encrypted=encrypt_secret(secret), is_enabled=True))
    db.flush()
    return user, secret


@pytest.fixture()
def quiet_emails(monkeypatch):
    """Silence + capture every email entry point used by the creation paths."""
    calls = {"org_created": [], "welcome": [], "super_admin": []}

    def _capture_into(bucket):
        def _fn(*args, **kwargs):
            bucket.append(kwargs if kwargs else args)
            return True
        return _fn

    monkeypatch.setattr(
        "app.services.email_service.send_org_created_email",
        _capture_into(calls["org_created"]),
    )
    monkeypatch.setattr(
        "app.services.email_service.send_product_welcome_email",
        _capture_into(calls["welcome"]),
    )
    monkeypatch.setattr(
        "app.services.email_service.notify_super_admins_org_created",
        _capture_into(calls["super_admin"]),
    )
    return calls


def _register(db, email, country, currency=None, org_name="Acme Corp"):
    payload = dict(
        organization=org_name,
        name="Ada Admin",
        email=email,
        password="StrongPass123!",
        country=country,
        intended_plan="essentials",
    )
    data = RegisterRequest(**payload, currency=currency) if currency is not None else RegisterRequest(**payload)
    register_enterprise(db, data)
    admin = db.query(User).filter_by(email=email).first()
    assert admin is not None
    return db.query(Organization).filter_by(id=admin.organization_id).first()


# ══ 1. Normal Super Admin login has NO MFA gate ══════════════════════════════

def test_super_admin_password_login_yields_tokens_directly(db_session):
    user = _user(db_session, "root@s8.example", UserRole.SUPER_ADMIN)

    result = login_user(db_session, user.email, "pw")

    assert result["access_token"] and result["refresh_token"]
    assert result["user"].id == user.id
    # The old side-channel contract is gone entirely.
    assert "mfa_status" not in result
    assert "mfa_token" not in result


def test_normal_login_does_not_invoke_mfa_even_without_enrollment(db_session):
    """No SuperAdminMFA row exists at all — login still completes."""
    user = _user(db_session, "plain@s8.example", UserRole.SUPER_ADMIN)
    assert db_session.query(SuperAdminMFA).filter_by(user_id=user.id).first() is None

    result = login_user(db_session, user.email, "pw")

    assert result["access_token"]
    claims = decode_access_token(result["access_token"])
    assert claims["role"] == "super_admin" and claims["user_id"] == user.id


def test_invalid_credentials_rejected_for_every_role(db_session):
    _user(db_session, "bad@s8.example", UserRole.SUPER_ADMIN)
    with pytest.raises(UnauthorizedException):
        login_user(db_session, "bad@s8.example", "wrong-password")
    with pytest.raises(UnauthorizedException):
        login_user(db_session, "ghost@s8.example", "whatever")


def test_tenant_user_cannot_obtain_super_admin_access(db_session):
    org = make_organization(db_session)
    tenant = _user(db_session, "tenant@s8.example", UserRole.ORG_ADMIN, organization_id=org.id)

    result = login_user(db_session, tenant.email, "pw")

    claims = decode_access_token(result["access_token"])
    assert claims["role"] == "org_admin"
    assert claims["organization_id"] == org.id


def test_existing_org_login_with_legacy_2a_bcrypt_hash_still_works(db_session):
    """REGRESSION for the live 'Invalid email or password' symptom on existing
    organizations: production users carry plain `$2a$` bcrypt hashes (passlib's
    bcrypt backend emits $2b$, Node/py-bcrypt frequently emit $2a$). A persisted
    org + user whose stored hash is a genuine $2a$ string MUST still log in and
    mint valid tokens — passlib 1.7.4 is pinned to verify that exact dialect."""
    org = make_organization(db_session, code="LEGCY", name="Legacy INR Org")
    org.country = "India"
    org.currency = "INR"

    raw = bcrypt.hashpw(b"existing-pass-2024", bcrypt.gensalt(rounds=10, prefix=b"2a"))
    legacy = raw.decode("utf-8")
    assert legacy.startswith("$2a$")

    existing = User(
        email="legacy@s8.example",
        hashed_password=legacy,
        role=UserRole.ORG_ADMIN,
        organization_id=org.id,
        first_name="Existing",
        last_name="Owner",
        is_active=True,
        is_verified=True,
    )
    db_session.add(existing)
    db_session.flush()

    # Correct password for an existing org user -> valid tokens, org scoping.
    result = login_user(db_session, existing.email, "existing-pass-2024")
    assert result["access_token"] and result["refresh_token"]
    claims = decode_access_token(result["access_token"])
    assert claims["role"] == "org_admin"
    assert claims["organization_id"] == org.id
    assert claims["user_id"] == existing.id

    # Wrong password for that same existing user is still rejected.
    with pytest.raises(UnauthorizedException):
        login_user(db_session, existing.email, "wrong-password")


# ══ 2. Privileged step-up MFA still enforced (no fallback) ═══════════════════

def test_breaker_toggle_without_mfa_rejected(db_session):
    """A syntactically valid code from an admin with NO MFA enrollment is
    refused at the step-up gate — there is no fallback that skips MFA."""
    admin = _user(db_session, "nomfa2@s8.example", UserRole.SUPER_ADMIN)
    with pytest.raises(BadRequestException):
        _apply_breaker_toggle(
            TENANT_DUNNING,
            CircuitBreakerToggleRequest(enabled=False, reason="incident", incident_reference="INC-S8", code="000000"),
            admin, db_session,
        )


def test_breaker_toggle_with_wrong_mfa_code_rejected(db_session):
    admin, _secret = _super_admin_with_mfa(db_session, "wrongcode@s8.example")
    with pytest.raises(UnauthorizedException):
        _apply_breaker_toggle(
            TENANT_DUNNING,
            CircuitBreakerToggleRequest(enabled=False, reason="incident", incident_reference="INC-S8", code="000000"),
            admin, db_session,
        )
    switch = db_session.query(BillingKillSwitch).filter_by(scope=TENANT_DUNNING).first()
    assert switch is None or switch.enabled is True


def test_breaker_toggle_with_valid_fresh_mfa_permitted(db_session):
    admin, secret = _super_admin_with_mfa(db_session, "fresh@s8.example")
    resp = _apply_breaker_toggle(
        TENANT_DUNNING,
        CircuitBreakerToggleRequest(enabled=False, reason="incident", incident_reference="INC-S8", code=pyotp.TOTP(secret).now()),
        admin, db_session,
    )
    assert resp.enabled is False


def test_breaker_toggle_accepts_recovery_code_as_step_up_factor(db_session):
    from app.modules.auth.mfa_service import _hash_code
    from app.modules.auth.models import SuperAdminMFARecoveryCode

    admin, _secret = _super_admin_with_mfa(db_session, "recovery@s8.example")
    row = db_session.query(SuperAdminMFA).filter_by(user_id=admin.id).first()
    raw_code = "s8recovery1"
    db_session.add(SuperAdminMFARecoveryCode(mfa_id=row.id, code_hash=_hash_code(raw_code)))
    db_session.commit()

    resp = _apply_breaker_toggle(
        TENANT_DUNNING,
        CircuitBreakerToggleRequest(enabled=False, reason="incident", incident_reference="INC-S8", recovery_code=raw_code),
        admin, db_session,
    )
    assert resp.enabled is False
    # Single-use: the same recovery code cannot authorize a second toggle.
    with pytest.raises(UnauthorizedException):
        _apply_breaker_toggle(
            TENANT_DUNNING,
            CircuitBreakerToggleRequest(enabled=True, reason="lift", code=None, recovery_code=raw_code),
            admin, db_session,
        )


def test_maker_checker_decision_still_demands_fresh_mfa(db_session):
    maker, maker_secret = _super_admin_with_mfa(db_session, "maker@s8.example")
    checker, checker_secret = _super_admin_with_mfa(db_session, "checker@s8.example")

    request = propose_circuit_breaker_change(
        scope=TENANT_DUNNING,
        data=CircuitBreakerChangeProposalCreate(enabled=False, reason="suspect", incident_reference="INC-S81"),
        current_user=maker, db=db_session,
    )
    # Checker's MFA is mandatory for the decision — no factor at all is
    # rejected outright…
    with pytest.raises(UnauthorizedException):
        decide_approval_request(
            request.id,
            ApprovalDecisionRequest(decision="approve", reason="ok", code=None),
            current_user=checker, db=db_session,
        )
    # …and a stale/reused code does not satisfy it either.
    reused = pyotp.TOTP(checker_secret).now()
    decide_approval_request(
        request.id,
        ApprovalDecisionRequest(decision="reject", reason="not confirmed", code=reused),
        current_user=checker, db=db_session,
    )
    with pytest.raises(UnauthorizedException):
        decide_approval_request(
            request.id,
            ApprovalDecisionRequest(decision="approve", reason="second try", code=reused),
            current_user=checker, db=db_session,
        )


# ══ 3. Currency always derived from country — NO silent USD ══════════════════

@pytest.mark.parametrize("country,expected", [
    ("India", "INR"),
    ("United Kingdom", "GBP"),
    ("United States", "USD"),
    ("Australia", "AUD"),
    ("Germany", "EUR"),
])
def test_registration_derives_currency_from_country(db_session, quiet_emails, country, expected):
    org = _register(db_session, f"{country.lower().replace(' ', '')}@s8.example", country)
    assert org.currency == expected


def test_unsupported_country_without_explicit_currency_is_explicit_error(db_session, quiet_emails):
    with pytest.raises(BadRequestException) as excinfo:
        _register(db_session, "accra@s8.example", "Ghana")
    assert "currency" in str(excinfo.value.detail).lower()


def test_no_implicit_usd_fallback_in_resolver():
    with pytest.raises(BadRequestException):
        resolve_currency(None, None)
    with pytest.raises(BadRequestException):
        resolve_currency(None, "")
    with pytest.raises(BadRequestException):
        resolve_currency(None, "Kenya")


def test_explicit_unsupported_currency_is_rejected_not_swapped(db_session):
    with pytest.raises(BadRequestException):
        resolve_currency("XYZ", "India")
    with pytest.raises(ValidationError):
        _register(db_session, "ghsx@s8.example", "Ghana", currency="GHS")


def test_explicit_supported_currency_wins_over_country_default(db_session, quiet_emails):
    org = _register(db_session, "choice@s8.example", "Germany", currency="USD")
    assert org.currency == "USD"


def test_country_defaults_payload_has_no_fallback_currency():
    from app.modules.auth.country_currency import country_defaults

    payload = country_defaults()
    assert "fallback_currency" not in payload
    by_name = {c["name"]: c["currency"] for c in payload["countries"]}
    assert by_name["India"] == "INR"
    assert "Ghana" not in by_name  # unsupported countries are absent, not USD-mapped


# ══ 4. Organization creation notifies active Super Admins ════════════════════

def test_registration_triggers_super_admin_notification(db_session, quiet_emails):
    _register(db_session, "notifyme@s8.example", "India")
    assert len(quiet_emails["super_admin"]) == 1
    kwargs = quiet_emails["super_admin"][0]
    assert kwargs["organization"].currency == "INR"
    assert kwargs["actor_email"] == "notifyme@s8.example"


def test_super_admin_creation_path_also_notifies_and_derives_currency(db_session, quiet_emails):
    actor = _user(db_session, "creator@s8.example", UserRole.SUPER_ADMIN)
    data = OrganizationBase(organization_name="Router Org", country="Australia")  # no currency sent

    create_organization(data, current_user=actor, db=db_session)

    org = db_session.query(Organization).filter_by(organization_name="Router Org").first()
    assert org.currency == "AUD"
    assert len(quiet_emails["super_admin"]) == 1
    assert quiet_emails["super_admin"][0]["actor_email"] == "creator@s8.example"


def test_notification_recipients_are_active_super_admins_only(db_session, monkeypatch):
    active_a = _user(db_session, "sa1@s8.example", UserRole.SUPER_ADMIN)
    active_b = _user(db_session, "sa2@s8.example", UserRole.SUPER_ADMIN)
    _user(db_session, "inactive@s8.example", UserRole.SUPER_ADMIN, is_active=False)
    _user(db_session, "tenant@s8.example", UserRole.ORG_ADMIN)

    sent = []
    monkeypatch.setattr(
        "app.services.email_service.send_approval_email",
        lambda email, template, context, **kw: sent.append(email) or True,
    )

    from app.services.email_service import notify_super_admins_org_created

    org = make_organization(db_session, code="S8ORG", name="Notify Org")
    dispatched = notify_super_admins_org_created(db=db_session, organization=org, actor_email="someone@s8.example")

    assert sorted(dispatched) == sorted([active_a.email, active_b.email])
    assert sorted(sent) == sorted([active_a.email, active_b.email])


def test_notification_content_is_operational_metadata_only(db_session, monkeypatch):
    _user(db_session, "watcher@s8.example", UserRole.SUPER_ADMIN)

    captured = {}
    monkeypatch.setattr(
        "app.services.email_service.send_approval_email",
        lambda email, template, context, **kw: captured.update(context, template=template, to=email) or True,
    )

    from datetime import datetime

    from app.services.email_service import notify_super_admins_org_created

    org = make_organization(db_session, code="S8META", name="Meta Org")
    org.country = "India"
    org.currency = "INR"
    db_session.commit()

    notify_super_admins_org_created(db=db_session, organization=org, actor_email="ada@s8.example")

    context = {k: v for k, v in captured.items() if k not in ("template", "to")}
    assert captured["template"] == "super_admin_org_created.html"
    assert captured["to"] == "watcher@s8.example"
    assert context["organization_name"] == "Meta Org"
    assert context["organization_code"] == "S8META"
    assert context["country"] == "India"
    assert context["currency"] == "INR"
    assert context["status"] in ("Active", "Suspended")
    assert context["created_by"] == "ada@s8.example"
    assert context["created_time"]  # timestamp present
    datetime.strptime(context["created_time"], "%Y-%m-%d %H:%M UTC")
    assert "/super-admin/organizations" in context["view_url"]
    blob = " ".join(str(v) for v in context.values()).lower()
    for forbidden in ("password", "secret", "token", "hash", "recovery"):
        assert forbidden not in blob


def test_single_recipient_failure_does_not_block_other_admins(db_session, monkeypatch):
    active_a = _user(db_session, "ok@s8.example", UserRole.SUPER_ADMIN)
    _user(db_session, "flaky@s8.example", UserRole.SUPER_ADMIN)

    def _flaky_sender(email, template, context, **kw):
        if email == "flaky@s8.example":
            raise RuntimeError("SMTP temporarily unavailable")
        return True

    monkeypatch.setattr("app.services.email_service.send_approval_email", _flaky_sender)

    from app.services.email_service import notify_super_admins_org_created

    org = make_organization(db_session, code="S8FAIL", name="Failover Org")
    dispatched = notify_super_admins_org_created(db=db_session, organization=org, actor_email="x@s8.example")
    assert dispatched == [active_a.email]


def test_false_returning_sender_is_treated_as_not_dispatched(db_session, monkeypatch):
    _user(db_session, "nope@s8.example", UserRole.SUPER_ADMIN)
    monkeypatch.setattr(
        "app.services.email_service.send_approval_email",
        lambda email, template, context, **kw: False,
    )

    from app.services.email_service import notify_super_admins_org_created

    org = make_organization(db_session, code="S8FALSE", name="False Org")
    assert notify_super_admins_org_created(db=db_session, organization=org, actor_email="x@s8.example") == []


def test_email_failure_never_fails_committed_registration(db_session, monkeypatch):
    """The notification is fire-and-forget: even a hard SMTP exception after
    commit must not fail the already-committed registration response."""
    monkeypatch.setattr(
        "app.services.email_service.notify_super_admins_org_created",
        lambda **kw: (_ for _ in ()).throw(RuntimeError("SMTP down")),
    )

    org = _register(db_session, "committed@s8.example", "India")
    assert org.currency == "INR"
    admin = db_session.query(User).filter_by(email="committed@s8.example").first()
    assert admin is not None and admin.is_active
