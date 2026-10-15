"""
tests/privacy/test_log_redaction.py
-----------------------------------
ZB-SEC-PRIV-001 §API-07: Log redaction for PII, tokens, cardholder data, and financial identifiers.
"""

import io
import logging

import pytest

from app.core.log_redaction import SensitiveDataFilter, redact_sensitive_text
from tests.privacy.conftest import control


@control("API-07")
def test_credit_card_redacted():
    raw = "Processing charge for card 4111 1111 1111 1111 on gateway"
    redacted = redact_sensitive_text(raw)
    assert "[REDACTED_CARD]" in redacted
    assert "4111 1111 1111 1111" not in redacted


@control("API-07")
def test_email_redacted():
    raw = "User alice.smith+tag@corp.example.co.uk logged in successfully"
    redacted = redact_sensitive_text(raw)
    assert "[REDACTED_EMAIL]" in redacted
    assert "alice.smith+tag@corp.example.co.uk" not in redacted


@control("API-07")
def test_jwt_token_redacted():
    jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
    raw = f"Incoming authorization header Bearer {jwt}"
    redacted = redact_sensitive_text(raw)
    assert "[REDACTED_JWT]" in redacted or "[REDACTED_SECRET]" in redacted
    assert jwt not in redacted


@control("API-07")
def test_secrets_and_passwords_redacted():
    # Fake Stripe-style key, assembled at runtime so secret scanners don't
    # mistake this fixture for a real credential.
    fake_key = "sk_" + "live_" + "51AbCDefGhIjKlMnOpQrStUvWxYz"
    raw1 = f'API request with api_key="{fake_key}"'
    assert "[REDACTED_SECRET]" in redact_sensitive_text(raw1)
    assert fake_key not in redact_sensitive_text(raw1)

    raw2 = 'Authentication attempt: password="VerySecretPassword123!"'
    assert "[REDACTED_SECRET]" in redact_sensitive_text(raw2)
    assert "VerySecretPassword123!" not in redact_sensitive_text(raw2)


@control("API-07")
def test_ssn_and_tax_id_redacted():
    raw_ssn = "Taxpayer SSN is 123-45-6789 on file"
    redacted_ssn = redact_sensitive_text(raw_ssn)
    assert "[REDACTED_SSN]" in redacted_ssn
    assert "123-45-6789" not in redacted_ssn

    raw_ein = "Company EIN is 12-3456789 registered"
    redacted_ein = redact_sensitive_text(raw_ein)
    assert "[REDACTED_TAX_ID]" in redacted_ein
    assert "12-3456789" not in redacted_ein


@control("API-07")
def test_bank_account_redacted():
    raw = "Direct debit from routing number 123456789 account number 987654321"
    redacted = redact_sensitive_text(raw)
    assert "[REDACTED_ACCOUNT]" in redacted


@control("API-07")
def test_normal_text_and_dates_unchanged():
    normal = "Invoice INV-0042 created on 2026-10-15 with total amount 150.00 USD"
    assert redact_sensitive_text(normal) == normal


@control("API-07")
def test_logger_integration_with_filter():
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(message)s"))
    handler.addFilter(SensitiveDataFilter())

    test_logger = logging.getLogger("test_privacy_redaction")
    test_logger.setLevel(logging.INFO)
    test_logger.addHandler(handler)

    test_logger.info("Contact email is support@customer.org for payment")
    output = stream.getvalue()

    assert "[REDACTED_EMAIL]" in output
    assert "support@customer.org" not in output

