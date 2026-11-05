"""
app/modules/tax/secret_store.py
-------------------------------
Provider credentials and tax keys (ZB-TAX-ARCH-001 Phase 4a-2, 4d-0).
Write-only from the API.

SecretStore is the seam, chosen by TAX_PROVIDER_SECRET_STORE:

  * ``gcp`` — GcpSecretManagerStore (4d-0). One Secret Manager secret per
    provider connection, ``tax-provider-{env}-org{org}-conn{connection}``,
    labelled with the org and connection ids. The database keeps only the
    secret's resource name and version numbers, never the value. Reads check
    the secret's org label against the caller. Rotation adds a version and
    disables the previous one only after test_connection succeeds on the new
    one; revocation destroys every version. Authentication is Application
    Default Credentials from the VM's attached service account (no JSON key
    files). Unreachable or denied = SecretStoreUnavailable: the connection is
    PROVIDER_UNAVAILABLE. Never a fallback to Fernet.
  * ``fernet`` — FernetSecretStore, the interim store: a Fernet envelope
    under TAX_PROVIDER_ENCRYPTION_KEY (dedicated, never the MFA key).
    Refused in production once a PRODUCTION connection exists, and never
    allowed to hold production credentials.

Credentials live in exactly one store, recorded on the connection
(credential_store). A connection whose credentials are in another store
than the configured one is unusable until they are re-entered.

Tax keys (TAX_PROVIDER_PSEUDONYM_KEY, and TAX_PROVIDER_ENCRYPTION_KEY outside
production) may be loaded from Secret Manager by resource name
(``…_SECRET`` settings), cached in memory for TAX_SECRET_CACHE_TTL_SECONDS.

Nothing here logs, raises or returns a secret value.
"""
import logging
import os
import threading
import time
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException

logger = logging.getLogger("zoiko_billing")

KEY_VERSION = "fernet-v1"
STORES = ("gcp", "fernet")
SECRET_NAME_PREFIX = "tax-provider-"


class SecretStoreUnavailable(BadRequestException):
    """No usable store or key: credentials cannot be stored or read (fail closed)."""


# ── environment ─────────────────────────────────────────────────────────

def is_production() -> bool:
    """Production unless the deployment says otherwise (fail closed)."""
    env = (os.getenv("ENVIRONMENT") or os.getenv("APP_ENV") or "").strip().lower()
    if env in ("development", "dev", "test", "ci", "staging", "local"):
        return False
    if env == "production":
        return True
    return str(getattr(settings, "DEBUG", False)).strip().lower() not in {"1", "true", "yes", "on"}


def configured_store_name() -> str:
    name = (getattr(settings, "TAX_PROVIDER_SECRET_STORE", "") or "fernet").strip().lower()
    if name not in STORES:
        raise SecretStoreUnavailable(f"TAX_PROVIDER_SECRET_STORE must be one of {', '.join(STORES)}.")
    return name


def production_credentials_allowed() -> bool:
    """Production credentials need the managed store (4d gate)."""
    return bool(settings.TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED) and configured_store_name() == "gcp"


# ── Secret Manager client (ADC only) ────────────────────────────────────

_client = None
_client_lock = threading.Lock()


def gcp_client():
    """The Secret Manager client, authenticated by Application Default
    Credentials (the VM's attached service account). JSON key files are
    refused."""
    global _client
    with _client_lock:
        if _client is None:
            if os.getenv("GOOGLE_APPLICATION_CREDENTIALS"):
                raise SecretStoreUnavailable("GOOGLE_APPLICATION_CREDENTIALS is set: service-account key files are "
                                             "not allowed; use the VM's attached service account.")
            try:
                from google.cloud import secretmanager

                _client = secretmanager.SecretManagerServiceClient()
            except Exception as exc:
                raise SecretStoreUnavailable(f"Secret Manager is unavailable ({type(exc).__name__}).") from None
        return _client


def set_gcp_client_for_tests(client) -> None:
    global _client
    with _client_lock:
        _client = client
    _cache.clear()


def _gcp_call(what: str, fn, **request):
    """Every client call: any failure is SecretStoreUnavailable, with the
    exception type only (never the request, which may carry a value)."""
    try:
        return fn(request=request)
    except SecretStoreUnavailable:
        raise
    except Exception as exc:
        logger.warning("[TAX] Secret Manager %s failed: %s", what, type(exc).__name__)
        raise SecretStoreUnavailable(f"Secret Manager {what} failed ({type(exc).__name__}).") from None


# ── tax keys loaded by resource name ────────────────────────────────────

_cache: dict = {}
_cache_lock = threading.Lock()


def _setting(name: str) -> str:
    """A setting's value; an unfilled ``<PLACEHOLDER>`` from .env.example
    counts as unset, so it can never be used as a key."""
    value = (getattr(settings, name, "") or "").strip()
    return "" if value.startswith("<") and value.endswith(">") else value


def config_secret(name: str) -> str:
    """A tax key: from Secret Manager when ``{name}_SECRET`` names a secret
    version (cached briefly), else the plain setting. Never logged."""
    resource = _setting(f"{name}_SECRET")
    if not resource:
        return _setting(name)
    if name == "TAX_PROVIDER_ENCRYPTION_KEY" and is_production():
        raise SecretStoreUnavailable("The Fernet store is not used in production; no encryption key is loaded.")
    ttl = max(0, int(getattr(settings, "TAX_SECRET_CACHE_TTL_SECONDS", 300)))
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(resource)
        if hit is not None and now - hit[1] < ttl:
            return hit[0]
    client = gcp_client()
    response = _gcp_call("key access", client.access_secret_version, name=resource)
    value = response.payload.data.decode("utf-8").strip()
    with _cache_lock:
        _cache[resource] = (value, now)
    return value


# ── the store interface ─────────────────────────────────────────────────

class SecretStore(ABC):
    name: str

    @abstractmethod
    def put(self, connection, secret: str) -> None:
        """Store a new credential for the connection and point it there. A
        replaced one is kept (credential_previous_version) or removed,
        per the store."""

    @abstractmethod
    def get(self, connection) -> Optional[str]:
        """The connection's current credential, or None."""

    @abstractmethod
    def retire_previous(self, connection) -> None:
        """The new credential tested OK: retire the replaced one."""

    @abstractmethod
    def destroy(self, connection) -> None:
        """Revocation: remove every stored version and clear the references."""


def has_credentials(connection) -> bool:
    return connection.credential_ref is not None or connection.credential_version is not None


def store_for(db: Session) -> SecretStore:
    return GcpSecretManagerStore(db) if configured_store_name() == "gcp" else FernetSecretStore(db)


# ── Fernet (interim, non-production) ────────────────────────────────────

def _fernet():
    from cryptography.fernet import Fernet

    key = config_secret("TAX_PROVIDER_ENCRYPTION_KEY")
    if not key:
        raise SecretStoreUnavailable("Provider credentials cannot be stored: TAX_PROVIDER_ENCRYPTION_KEY is not set.")
    if key == (getattr(settings, "MFA_ENCRYPTION_KEY", "") or "").strip():
        raise SecretStoreUnavailable("TAX_PROVIDER_ENCRYPTION_KEY must be a dedicated key, not the MFA key.")
    try:
        return Fernet(key.encode())
    except Exception:
        raise SecretStoreUnavailable("TAX_PROVIDER_ENCRYPTION_KEY is not a valid Fernet key.") from None


class FernetSecretStore(SecretStore):
    name = "fernet"

    def __init__(self, db: Session):
        self.db = db

    def put(self, connection, secret: str) -> None:
        from app.modules.tax.provider_models import TaxProviderSecret

        row = TaxProviderSecret(organization_id=connection.organization_id, key_version=KEY_VERSION,
                                ciphertext=_fernet().encrypt(secret.encode()).decode(),
                                created_at=datetime.now(timezone.utc))
        self.db.add(row)
        self.db.flush()
        old = connection.credential_ref
        connection.credential_store, connection.credential_ref = self.name, row.id
        if old is not None:                                     # interim store: replaced at once
            self._delete(connection.organization_id, old)

    def get(self, connection) -> Optional[str]:
        from app.modules.tax.provider_models import TaxProviderSecret

        row = self.db.get(TaxProviderSecret, connection.credential_ref) if connection.credential_ref else None
        if row is None or row.organization_id != connection.organization_id:
            return None
        try:
            return _fernet().decrypt(row.ciphertext.encode()).decode()
        except SecretStoreUnavailable:
            raise
        except Exception:
            raise SecretStoreUnavailable("Stored provider credentials could not be decrypted with the current key.") \
                from None

    def retire_previous(self, connection) -> None:
        connection.credential_previous_version = None

    def destroy(self, connection) -> None:
        if connection.credential_ref is not None:
            self._delete(connection.organization_id, connection.credential_ref)
        connection.credential_ref = None

    def _delete(self, organization_id: int, ref: int) -> None:
        from app.modules.tax.provider_models import TaxProviderSecret

        row = self.db.get(TaxProviderSecret, ref)
        if row is not None and row.organization_id == organization_id:
            self.db.delete(row)
            self.db.flush()


# ── GCP Secret Manager ──────────────────────────────────────────────────

def secret_id(connection) -> str:
    env = connection.environment.name.lower()
    return f"{SECRET_NAME_PREFIX}{env}-org{connection.organization_id}-conn{connection.id}"


class GcpSecretManagerStore(SecretStore):
    name = "gcp"

    def __init__(self, db: Session, client=None, project: Optional[str] = None):
        self.db = db
        self._client = client
        self.project = (project or _setting("TAX_SECRET_MANAGER_PROJECT")).strip()

    @property
    def client(self):
        return self._client or gcp_client()

    def _labels(self, connection) -> dict:
        return {"purpose": "tax-provider", "org_id": str(connection.organization_id),
                "connection_id": str(connection.id), "environment": connection.environment.name.lower()}

    def _ensure_secret(self, connection) -> str:
        if not self.project:
            raise SecretStoreUnavailable("TAX_SECRET_MANAGER_PROJECT is not set.")
        name = f"projects/{self.project}/secrets/{secret_id(connection)}"
        if connection.credential_secret_name == name:
            return name
        region = _setting("TAX_SECRET_MANAGER_REGION")
        replication = {"user_managed": {"replicas": [{"location": region}]}} if region else {"automatic": {}}
        try:
            self.client.create_secret(request={"parent": f"projects/{self.project}", "secret_id": secret_id(connection),
                                               "secret": {"replication": replication,
                                                          "labels": self._labels(connection)}})
        except Exception as exc:
            if type(exc).__name__ != "AlreadyExists":
                logger.warning("[TAX] Secret Manager create failed: %s", type(exc).__name__)
                raise SecretStoreUnavailable(f"Secret Manager create failed ({type(exc).__name__}).") from None
            self._check_labels(connection, name)                # an existing secret must be this connection's
        return name

    def _check_labels(self, connection, name: str) -> None:
        secret = _gcp_call("lookup", self.client.get_secret, name=name)
        labels = dict(getattr(secret, "labels", {}) or {})
        if labels.get("org_id") != str(connection.organization_id) or \
                labels.get("connection_id") != str(connection.id):
            logger.warning("[TAX] Secret Manager label mismatch for connection %s (org %s)",
                           connection.id, connection.organization_id)
            raise SecretStoreUnavailable("The stored credential does not belong to this organization's connection.")

    @staticmethod
    def _version_of(version_name: str) -> str:
        return version_name.rsplit("/", 1)[-1]

    def put(self, connection, secret: str) -> None:
        name = self._ensure_secret(connection)
        added = _gcp_call("add version", self.client.add_secret_version, parent=name,
                          payload={"data": secret.encode("utf-8")})
        new_version = self._version_of(added.name)
        current, previous = connection.credential_version, connection.credential_previous_version
        if current is not None and previous is not None:
            # The current version was never confirmed by a test: disable it now
            # and keep the last confirmed one as the fallback to retire later.
            _gcp_call("disable version", self.client.disable_secret_version, name=f"{name}/versions/{current}")
        elif current is not None:
            previous = current
        connection.credential_store, connection.credential_secret_name = self.name, name
        connection.credential_version, connection.credential_previous_version = new_version, previous

    def get(self, connection) -> Optional[str]:
        if not connection.credential_secret_name or connection.credential_version is None:
            return None
        self._check_labels(connection, connection.credential_secret_name)
        response = _gcp_call("access", self.client.access_secret_version,
                             name=f"{connection.credential_secret_name}/versions/{connection.credential_version}")
        return response.payload.data.decode("utf-8")

    def retire_previous(self, connection) -> None:
        previous = connection.credential_previous_version
        if previous is None or not connection.credential_secret_name:
            return
        _gcp_call("disable version", self.client.disable_secret_version,
                  name=f"{connection.credential_secret_name}/versions/{previous}")
        connection.credential_previous_version = None

    def destroy(self, connection) -> None:
        name = connection.credential_secret_name
        if name:
            self._check_labels(connection, name)
            versions = _gcp_call("list versions", self.client.list_secret_versions, parent=name)
            for v in versions:
                if str(getattr(v.state, "name", v.state)).upper() != "DESTROYED":
                    _gcp_call("destroy version", self.client.destroy_secret_version, name=v.name)
        connection.credential_version, connection.credential_previous_version = None, None


# ── startup ─────────────────────────────────────────────────────────────

def verify_secret_store_at_startup(db_factory=None) -> None:
    """Refuse to start when the store choice is unsafe (raises SystemExit):
    an unknown store; production credentials allowed without the gcp store;
    the gcp store without a project or with a key file; in production, the
    fernet store while any PRODUCTION connection exists."""
    try:
        store = configured_store_name()
    except SecretStoreUnavailable as exc:
        raise SystemExit(str(exc))
    if settings.TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED and store != "gcp":
        raise SystemExit("TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED requires TAX_PROVIDER_SECRET_STORE=gcp.")
    if store == "gcp":
        if not _setting("TAX_SECRET_MANAGER_PROJECT"):
            raise SystemExit("TAX_PROVIDER_SECRET_STORE=gcp needs TAX_SECRET_MANAGER_PROJECT.")
        if os.getenv("GOOGLE_APPLICATION_CREDENTIALS"):
            raise SystemExit("GOOGLE_APPLICATION_CREDENTIALS is set: use the VM's attached service account, "
                             "not a key file.")
        return
    if not is_production():
        return
    from app.modules.tax.enums import ProviderEnvironment
    from app.modules.tax.provider_models import TaxProviderConnection

    if db_factory is None:
        from app.database import SessionLocal as db_factory
    db = db_factory()
    try:
        production = db.query(TaxProviderConnection.id).filter(
            TaxProviderConnection.environment == ProviderEnvironment.PRODUCTION).first()
    except Exception as exc:                                   # unreachable DB is handled elsewhere
        logger.warning("[TAX] Secret store startup check skipped: %s", type(exc).__name__)
        return
    finally:
        db.close()
    if production is not None:
        raise SystemExit("TAX_PROVIDER_SECRET_STORE=fernet is refused in production while a PRODUCTION provider "
                         "connection exists; use gcp.")


def masked_last4(secret: str) -> str:
    return secret[-4:] if len(secret) >= 8 else "****"
