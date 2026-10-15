"""
core/log_redaction.py
---------------------
ZB-SEC-PRIV-001 (API-07) — Sensitive data redaction logging filter.

Redacts PII, credentials, financial details, and secrets from application logs:
- Primary Account Numbers (credit/debit card numbers)
- Email addresses
- JWT tokens
- API keys, bearer tokens, secrets, passwords
- Social Security Numbers (SSN)
- Taxpayer Identification Numbers / Employer Identification Numbers (TIN/EIN)
- Bank account / routing numbers
"""

import logging
import re
from typing import Any

# Compiled regex patterns for redaction
_CARD_RE = re.compile(r"\b(?:\d[ -]*?){13,19}\b")
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_\-\.]{10,}\b")
_SECRET_RE = re.compile(
    r"(?i)(bearer\s+[A-Za-z0-9_\-\.]{16,}|(?:api[_-]?key|secret|password|auth(?:orization)?|token)[\s:=]+[\"']?[A-Za-z0-9_\-\.]{16,}[\"']?)"
)
_SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
_TAX_ID_RE = re.compile(r"\b\d{2}-\d{7}\b")
_BANK_ACCT_RE = re.compile(r"(?i)\b(?:account|acct|routing)[\s_-]*(?:number|num|no|#)?[\s:=]*\d{6,}\b")


def redact_sensitive_text(text: str) -> str:
    """Apply all redaction rules to a string."""
    if not isinstance(text, str):
        return text

    # Apply redactions in specific order
    text = _JWT_RE.sub("[REDACTED_JWT]", text)
    text = _SECRET_RE.sub("[REDACTED_SECRET]", text)
    text = _EMAIL_RE.sub("[REDACTED_EMAIL]", text)
    text = _SSN_RE.sub("[REDACTED_SSN]", text)
    text = _TAX_ID_RE.sub("[REDACTED_TAX_ID]", text)
    text = _BANK_ACCT_RE.sub("[REDACTED_ACCOUNT]", text)
    text = _CARD_RE.sub("[REDACTED_CARD]", text)

    return text


def _redact_value(val: Any) -> Any:
    if isinstance(val, str):
        return redact_sensitive_text(val)
    if isinstance(val, dict):
        return {k: _redact_value(v) for k, v in val.items()}
    if isinstance(val, (list, tuple)):
        return type(val)(_redact_value(item) for item in val)
    return val


class SensitiveDataFilter(logging.Filter):
    """Logging filter that strips sensitive tokens, PII, and financial identifiers."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_sensitive_text(record.msg)

        if record.args:
            if isinstance(record.args, dict):
                record.args = {k: _redact_value(v) for k, v in record.args.items()}
            elif isinstance(record.args, tuple):
                record.args = tuple(_redact_value(v) for v in record.args)

        return True

