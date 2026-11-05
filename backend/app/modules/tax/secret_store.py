"""
app/modules/tax/secret_store.py
-------------------------------
Provider credentials (ZB-TAX-ARCH-001 Phase 4a-2). Write-only from the API.

SecretStore is the seam; FernetSecretStore is the interim implementation
through 4c: a Fernet envelope under TAX_PROVIDER_ENCRYPTION_KEY, a key
dedicated to provider credentials (never the MFA key). GCP Secret Manager
replaces it at the 4d gate. Until then no PRODUCTION-environment credential
may be stored (TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED stays false).

Nothing here logs or returns a secret. Rotation procedure:
docs/TAX_PHASE4A2.md ("Credential key rotation").
"""
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException

KEY_VERSION = "fernet-v1"


class SecretStoreUnavailable(BadRequestException):
    """No usable key: credentials cannot be stored or read (fail closed)."""


class SecretStore(ABC):
    @abstractmethod
    def put(self, organization_id: int, secret: str) -> int:
        """Store a secret; return its reference."""

    @abstractmethod
    def get(self, organization_id: int, ref: int) -> Optional[str]:
        """The secret for a reference in this organization, or None."""

    @abstractmethod
    def delete(self, organization_id: int, ref: int) -> None:
        ...


def _fernet():
    from cryptography.fernet import Fernet

    key = (getattr(settings, "TAX_PROVIDER_ENCRYPTION_KEY", "") or "").strip()
    if not key:
        raise SecretStoreUnavailable("Provider credentials cannot be stored: TAX_PROVIDER_ENCRYPTION_KEY is not set.")
    if key == (getattr(settings, "MFA_ENCRYPTION_KEY", "") or "").strip():
        raise SecretStoreUnavailable("TAX_PROVIDER_ENCRYPTION_KEY must be a dedicated key, not the MFA key.")
    try:
        return Fernet(key.encode())
    except Exception:
        raise SecretStoreUnavailable("TAX_PROVIDER_ENCRYPTION_KEY is not a valid Fernet key.")


class FernetSecretStore(SecretStore):
    def __init__(self, db: Session):
        self.db = db

    def put(self, organization_id: int, secret: str) -> int:
        from app.modules.tax.provider_models import TaxProviderSecret

        row = TaxProviderSecret(organization_id=organization_id, key_version=KEY_VERSION,
                                ciphertext=_fernet().encrypt(secret.encode()).decode(),
                                created_at=datetime.now(timezone.utc))
        self.db.add(row)
        self.db.flush()
        return row.id

    def get(self, organization_id: int, ref: int) -> Optional[str]:
        from app.modules.tax.provider_models import TaxProviderSecret

        row = self.db.get(TaxProviderSecret, ref)
        if row is None or row.organization_id != organization_id:
            return None
        try:
            return _fernet().decrypt(row.ciphertext.encode()).decode()
        except SecretStoreUnavailable:
            raise
        except Exception:
            raise SecretStoreUnavailable("Stored provider credentials could not be decrypted with the current key.")

    def delete(self, organization_id: int, ref: int) -> None:
        from app.modules.tax.provider_models import TaxProviderSecret

        row = self.db.get(TaxProviderSecret, ref)
        if row is not None and row.organization_id == organization_id:
            self.db.delete(row)
            self.db.flush()


def masked_last4(secret: str) -> str:
    return secret[-4:] if len(secret) >= 8 else "****"
