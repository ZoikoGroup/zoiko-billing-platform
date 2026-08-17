"""
core/mfa_crypto.py
-------------------
Symmetric encryption for Super Admin TOTP secrets at rest.

Deliberately a SEPARATE key from BILLING_SECRET_KEY (the JWT signing key):
a leaked JWT secret must not also expose every Super Admin's MFA seed. Set
MFA_ENCRYPTION_KEY (a urlsafe-base64 32-byte Fernet key, e.g. generated via
`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`)
in production. In development/test, an unset key derives a stable
(non-production-safe) local key from BILLING_SECRET_KEY so the app still
boots — this fallback is refused outside DEBUG mode, matching the same
fail-closed pattern app/database.py uses for BILLING_DATABASE_URL.
"""

import base64
import hashlib

from cryptography.fernet import Fernet

from app.config import settings

_fernet: Fernet | None = None


def _derive_dev_key(seed: str) -> bytes:
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def get_fernet() -> Fernet:
    global _fernet
    if _fernet is not None:
        return _fernet

    raw_key = (settings.MFA_ENCRYPTION_KEY or "").strip()
    if raw_key:
        _fernet = Fernet(raw_key.encode("utf-8"))
        return _fernet

    if not settings.DEBUG:
        raise RuntimeError(
            "MFA_ENCRYPTION_KEY is not configured. Refusing to derive a fallback "
            "key in a non-DEBUG environment — Super Admin TOTP secrets must never "
            "be encrypted with a guessable key in production. Set MFA_ENCRYPTION_KEY."
        )
    _fernet = Fernet(_derive_dev_key(settings.BILLING_SECRET_KEY + "::mfa-dev-fallback"))
    return _fernet


def encrypt_secret(raw_secret: str) -> str:
    return get_fernet().encrypt(raw_secret.encode("utf-8")).decode("utf-8")


def decrypt_secret(encrypted_secret: str) -> str:
    return get_fernet().decrypt(encrypted_secret.encode("utf-8")).decode("utf-8")
