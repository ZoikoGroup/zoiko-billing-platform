"""ZB-TAX-ARCH-001 Phase 6 PR 3: PyJWT replaces python-jose for the HS256
tokens. Tokens issued before the change (by python-jose) must still
validate; issue, verify, expiry and tampering behave as before."""
import base64
import json
from datetime import timedelta
from pathlib import Path

import jwt
import pytest

from app.config import settings
from app.core.security import create_access_token, create_refresh_token, decode_access_token, decode_refresh_token

BACKEND = Path(__file__).resolve().parent.parent

# Issued by python-jose 3.4.0 (HS256) with LEGACY_KEY before the switch.
LEGACY_KEY = "legacy-jose-compat-test-secret-0123456789"
LEGACY_ACCESS = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJsZWdhY3lAY29tcGF0LmV4YW1wbGUiLCJ1c2VyX2lkIjo0Miwicm9sZSI6"
                 "Im9yZ19hZG1pbiIsIm9yZ2FuaXphdGlvbl9pZCI6NywiaXNzIjoiem9pa28tYmlsbGluZy1wbGF0Zm9ybSIsInR5cGUiOiJhY2Nlc3Mi"
                 "LCJleHAiOjQxMDI0NDQ4MDB9.ADYvbA6E22qofLZMXEx7XMKL-N-w2S_flpNPkwtIkJs")
LEGACY_EXPIRED = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJsZWdhY3lAY29tcGF0LmV4YW1wbGUiLCJ1c2VyX2lkIjo0Miwicm9sZSI6"
                  "Im9yZ19hZG1pbiIsIm9yZ2FuaXphdGlvbl9pZCI6NywiaXNzIjoiem9pa28tYmlsbGluZy1wbGF0Zm9ybSIsInR5cGUiOiJhY2Nlc3Mi"
                  "LCJleHAiOjE3MDAwMDAwMDB9.9cXw9hS-WahIrCYu-MdTgi6sOKyi2Dq3M0biOSBQY4k")
LEGACY_REFRESH = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJsZWdhY3lAY29tcGF0LmV4YW1wbGUiLCJ1c2VyX2lkIjo0Miwicm9sZSI6"
                  "Im9yZ19hZG1pbiIsIm9yZ2FuaXphdGlvbl9pZCI6NywiaXNzIjoiem9pa28tYmlsbGluZy1wbGF0Zm9ybSIsInR5cGUiOiJyZWZyZXNo"
                  "IiwiZXhwIjo0MTAyNDQ0ODAwfQ.RN3MjDOiEkxMnx0lBfaxaxshfqnYV6taQBAV_XV_Gaw")


@pytest.fixture()
def legacy_key(monkeypatch):
    monkeypatch.setattr(settings, "BILLING_SECRET_KEY", LEGACY_KEY)
    monkeypatch.setattr(settings, "JWT_ISSUER", "zoiko-billing-platform")
    monkeypatch.setattr(settings, "ALGORITHM", "HS256")


def _b64(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj, separators=(",", ":")).encode()).rstrip(b"=").decode()


# ── tokens issued before the change ─────────────────────────────────────

def test_a_python_jose_access_token_still_validates(legacy_key):
    payload = decode_access_token(LEGACY_ACCESS)
    assert payload is not None
    assert payload["sub"] == "legacy@compat.example" and payload["user_id"] == 42
    assert payload["role"] == "org_admin" and payload["organization_id"] == 7 and payload["type"] == "access"


def test_a_python_jose_refresh_token_still_validates_only_as_refresh(legacy_key):
    assert decode_refresh_token(LEGACY_REFRESH)["sub"] == "legacy@compat.example"
    assert decode_access_token(LEGACY_REFRESH) is None
    assert decode_refresh_token(LEGACY_ACCESS) is None


def test_an_expired_python_jose_token_is_still_rejected(legacy_key):
    assert decode_access_token(LEGACY_EXPIRED) is None


def test_a_legacy_token_under_a_different_key_is_rejected(monkeypatch):
    monkeypatch.setattr(settings, "BILLING_SECRET_KEY", "some-other-key-0123456789abcdef")
    assert decode_access_token(LEGACY_ACCESS) is None


# ── issue, verify, expiry, tampering ────────────────────────────────────

def test_issue_and_verify_round_trip():
    token = create_access_token({"sub": "a@b.example", "user_id": 1, "role": "org_admin", "organization_id": 3})
    header = json.loads(base64.urlsafe_b64decode(token.split(".")[0] + "=="))
    assert header["alg"] == settings.ALGORITHM == "HS256"
    payload = decode_access_token(token)
    assert payload["sub"] == "a@b.example" and payload["iss"] == settings.JWT_ISSUER and payload["type"] == "access"
    assert isinstance(payload["exp"], int)
    assert decode_refresh_token(create_refresh_token({"sub": "a@b.example"}))["type"] == "refresh"


def test_expiry_is_enforced():
    assert decode_access_token(create_access_token({"sub": "a@b.example"}, expires_delta=timedelta(seconds=-5))) is None


def test_tampered_payload_signature_and_algorithm_are_rejected():
    token = create_access_token({"sub": "a@b.example", "role": "auditor"})
    header, body, sig = token.split(".")
    claims = json.loads(base64.urlsafe_b64decode(body + "=="))
    escalated = f"{header}.{_b64({**claims, 'role': 'org_admin'})}.{sig}"
    assert decode_access_token(escalated) is None                                  # payload changed
    assert decode_access_token(f"{header}.{body}.{sig[:-2]}xx") is None             # signature changed
    unsigned = f"{_b64({'alg': 'none', 'typ': 'JWT'})}.{body}."
    assert decode_access_token(unsigned) is None                                    # alg=none
    other_alg = jwt.encode(claims, settings.BILLING_SECRET_KEY, algorithm="HS512")
    assert decode_access_token(other_alg) is None                                   # only HS256 accepted
    wrong_key = jwt.encode(claims, "not-the-real-secret-0123456789abcd", algorithm="HS256")
    assert decode_access_token(wrong_key) is None
    assert decode_access_token("not.a.jwt") is None and decode_access_token("") is None


def test_missing_or_wrong_issuer_is_rejected():
    claims = {"sub": "a@b.example", "type": "access", "exp": 4102444800}
    assert decode_access_token(jwt.encode(claims, settings.BILLING_SECRET_KEY, algorithm="HS256")) is None
    wrong = jwt.encode({**claims, "iss": "someone-else"}, settings.BILLING_SECRET_KEY, algorithm="HS256")
    assert decode_access_token(wrong) is None


def test_google_state_and_signup_ticket_round_trip_and_tampering():
    from app.modules.auth import google_oauth

    state = google_oauth._make_state()
    assert google_oauth._state_valid(state) is True
    assert google_oauth._state_valid(state[:-3] + "abc") is False
    ticket = google_oauth._make_signup_ticket("new@b.example", "New User")
    assert google_oauth.read_signup_ticket(ticket) == {"email": "new@b.example", "name": "New User"}
    assert google_oauth.read_signup_ticket(state) is None                          # wrong type
    assert google_oauth._state_valid(ticket) is False


# ── python-jose is gone ─────────────────────────────────────────────────

def test_no_code_imports_python_jose_and_the_pins_are_gone():
    offenders = [str(p) for p in (BACKEND / "app").rglob("*.py")
                 if "from jose" in p.read_text(encoding="utf-8") or "import jose" in p.read_text(encoding="utf-8")]
    assert offenders == []
    requirements = (BACKEND / "requirements.txt").read_text(encoding="utf-8")
    lines = [l.strip() for l in requirements.splitlines() if l.strip() and not l.strip().startswith("#")]
    assert "PyJWT==2.10.1" in lines
    assert not any(l.startswith("python-jose") or l.startswith("pyasn1") or l.startswith("ecdsa") for l in lines)
