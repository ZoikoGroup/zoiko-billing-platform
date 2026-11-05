"""
app/modules/tax/connection_service.py
-------------------------------------
Tenant provider connections (ZB-TAX-ARCH-001 Phase 4a-2, §16: independent of
the payment processor).

  propose()      billing admin: entity, provider, environment, mode. No URL:
                 the endpoint is the code-defined allowlist entry for
                 (provider, environment); a tenant can never point a call
                 elsewhere (no SSRF).
  decide()       a different finance approver approves or rejects.
  set_credentials() / revoke_credentials()
                 write-only; audited. Revocation deletes the secret and
                 freezes the connection (SUSPENDED, T16): quotes and issuing
                 through it fail closed (PROVIDER_UNAVAILABLE).
  request_resume() / decide_resume()
                 a suspended connection comes back only with new
                 credentials and two people again.
  test_connection()
                 calls the allowlisted endpoint only; records health.

A connection is usable only when APPROVED, with credentials present, a
registered provider and an allowlisted endpoint (and, for PRODUCTION, only
once production credentials are allowed at the 4d gate).
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.modules.billing.models import BillingAuditAction
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.tax.enums import ConnectionStatus, ProviderEnvironment
from app.modules.tax.models import SellerLegalEntity
from app.modules.tax.provider_contract import ProviderError, ProviderMode, provider_definition
from app.modules.tax.provider_models import TaxProviderConnection
from app.modules.tax.secret_store import (
    FernetSecretStore,
    GcpSecretManagerStore,
    SecretStore,
    SecretStoreUnavailable,
    configured_store_name,
    has_credentials,
    masked_last4,
    production_credentials_allowed,
    store_for,
)


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ProviderConnectionService:
    def __init__(self, db: Session, secrets: Optional[SecretStore] = None):
        self.db = db
        self.secrets = secrets or store_for(db)
        self.audit = BillingAuditService(db)

    # ── helpers ──
    def get(self, organization_id: int, connection_id: int) -> TaxProviderConnection:
        row = self.db.query(TaxProviderConnection).filter(TaxProviderConnection.id == connection_id,
                                                          TaxProviderConnection.organization_id == organization_id).first()
        if row is None:
            raise NotFoundException("Provider connection", connection_id)
        return row

    def list(self, organization_id: int, seller_entity_id: Optional[int] = None) -> list:
        q = self.db.query(TaxProviderConnection).filter(TaxProviderConnection.organization_id == organization_id)
        if seller_entity_id is not None:
            q = q.filter(TaxProviderConnection.seller_entity_id == seller_entity_id)
        return q.order_by(TaxProviderConnection.id).all()

    def _log(self, row, actor_id, action, **values):
        self.audit.log_no_commit(row.organization_id, actor_id, action, "TaxProviderConnection", row.id,
                                 new_values=values or None)

    def _store_of(self, row) -> SecretStore:
        """The store that holds this connection's credential (for reading,
        retiring and destroying it). Using it still requires it to be the
        configured store (usable_problem): there is no fallback."""
        held = row.credential_store or ("fernet" if row.credential_ref is not None else self.secrets.name)
        if held == self.secrets.name:
            return self.secrets
        return GcpSecretManagerStore(self.db) if held == "gcp" else FernetSecretStore(self.db)

    @staticmethod
    def _checker(proposer: Optional[int], actor_id: int, what: str) -> None:
        if proposer is not None and proposer == actor_id:
            raise ForbiddenException(f"You {what}; a different user must approve or reject it.")

    # ── lifecycle ──
    def propose(self, organization_id: int, actor_id: int, *, seller_entity_id: int, provider_name: str,
                environment: ProviderEnvironment, mode: ProviderMode) -> TaxProviderConnection:
        entity = self.db.query(SellerLegalEntity).filter(SellerLegalEntity.id == seller_entity_id,
                                                         SellerLegalEntity.organization_id == organization_id).first()
        if entity is None:
            raise NotFoundException("Seller legal entity", seller_entity_id)
        definition = provider_definition(provider_name)
        if definition is None:
            raise BadRequestException(f"Tax provider {provider_name!r} is not available.")
        try:
            definition.endpoint(environment.name)
        except ProviderError as exc:
            raise BadRequestException(str(exc))
        now = _now()
        row = TaxProviderConnection(
            organization_id=organization_id, seller_entity_id=seller_entity_id, provider_name=provider_name,
            environment=environment, mode=mode.name, status=ConnectionStatus.PROPOSED, proposed_by=actor_id,
            created_at=now, updated_at=now)
        self.db.add(row)
        self.db.flush()
        self._log(row, actor_id, BillingAuditAction.CREATE, provider=provider_name, environment=environment.name,
                  mode=mode.name)
        self.db.commit()
        return row

    def decide(self, organization_id: int, actor_id: int, connection_id: int, *, approve: bool,
               reason: Optional[str] = None) -> TaxProviderConnection:
        row = self.get(organization_id, connection_id)
        if row.status != ConnectionStatus.PROPOSED:
            raise BadRequestException(f"Provider connection {row.id} is {row.status.name}, not PROPOSED.")
        self._checker(row.proposed_by, actor_id, "proposed this connection")
        row.status = ConnectionStatus.APPROVED if approve else ConnectionStatus.REJECTED
        row.approved_by, row.approved_at, row.decision_reason, row.updated_at = actor_id, _now(), reason, _now()
        self._log(row, actor_id, BillingAuditAction.APPROVE if approve else BillingAuditAction.REJECT, reason=reason)
        self.db.commit()
        return row

    def withdraw(self, organization_id: int, actor_id: int, connection_id: int) -> TaxProviderConnection:
        row = self.get(organization_id, connection_id)
        if row.status != ConnectionStatus.PROPOSED:
            raise BadRequestException(f"Provider connection {row.id} is {row.status.name}, not PROPOSED.")
        row.status, row.updated_at = ConnectionStatus.WITHDRAWN, _now()
        self._log(row, actor_id, BillingAuditAction.UPDATE, withdrawn=True)
        self.db.commit()
        return row

    # ── credentials (write-only) ──
    def set_credentials(self, organization_id: int, actor_id: int, connection_id: int, secret: str) -> TaxProviderConnection:
        row = self.get(organization_id, connection_id)
        if row.status in (ConnectionStatus.REJECTED, ConnectionStatus.WITHDRAWN):
            raise BadRequestException(f"Provider connection {row.id} is {row.status.name}.")
        secret = (secret or "").strip()
        if len(secret) < 8:
            raise BadRequestException("The credential is too short.")
        if row.environment == ProviderEnvironment.PRODUCTION and not production_credentials_allowed():
            raise BadRequestException("Production provider credentials cannot be stored until the managed secret "
                                      "store is in place (4d gate).")
        rotated = has_credentials(row)
        if rotated and (row.credential_store or "fernet") != self.secrets.name:
            # Moving stores: remove the old store's copy; never keep two.
            self._store_of(row).destroy(row)
        self.secrets.put(row, secret)
        row.credential_last4, row.credential_rotated_at = masked_last4(secret), _now()
        row.credential_set_by, row.updated_at = actor_id, _now()
        self._log(row, actor_id, BillingAuditAction.UPDATE, credentials="rotated" if rotated else "set",
                  last4=row.credential_last4, store=row.credential_store, version=row.credential_version,
                  previous_version_pending=row.credential_previous_version)
        self.db.commit()
        return row

    def revoke_credentials(self, organization_id: int, actor_id: int, connection_id: int,
                           reason: str) -> TaxProviderConnection:
        row = self.get(organization_id, connection_id)
        if not (reason or "").strip():
            raise BadRequestException("A reason is required.")
        failure = None
        through = row.credential_version
        try:
            self._store_of(row).destroy(row)                     # every stored version
        except SecretStoreUnavailable as exc:
            failure = exc.message
            # Reconciliation retries until destroyed; a person sees it meanwhile.
            row.credential_destroy_through = through or row.credential_destroy_through
            from app.modules.tax.review_service import TaxReviewService

            TaxReviewService(self.db)._raise(
                _now(), row.organization_id, "TaxProviderConnection", row.id, None, True,
                f"Credential versions not destroyed for provider connection {row.id} (revoked: {reason.strip()}); "
                "reconciliation retries until Secret Manager confirms.", owner_role="BILLING_ADMIN")
        # Frozen either way: a failed destroy never leaves the connection usable.
        row.credential_ref, row.credential_version, row.credential_previous_version = None, None, None
        row.credential_last4 = None
        if row.status == ConnectionStatus.APPROVED:
            row.status = ConnectionStatus.SUSPENDED            # frozen (T16) until resumed by two people
        row.suspended_reason, row.resume_requested_by, row.updated_at = reason.strip(), None, _now()
        self._log(row, actor_id, BillingAuditAction.VOID, credentials="revoked", reason=reason.strip(),
                  versions_destroyed=failure is None)
        self.db.commit()
        if failure is not None:
            raise SecretStoreUnavailable("The connection is suspended, but its stored credential versions could not "
                                         f"be destroyed ({failure}). Revoke again once the store is reachable.")
        return row

    def request_resume(self, organization_id: int, actor_id: int, connection_id: int) -> TaxProviderConnection:
        row = self.get(organization_id, connection_id)
        if row.status != ConnectionStatus.SUSPENDED:
            raise BadRequestException(f"Provider connection {row.id} is {row.status.name}, not SUSPENDED.")
        if not has_credentials(row):
            raise BadRequestException("Set new credentials before asking to resume the connection.")
        row.resume_requested_by, row.updated_at = actor_id, _now()
        self._log(row, actor_id, BillingAuditAction.UPDATE, resume_requested=True)
        self.db.commit()
        return row

    def decide_resume(self, organization_id: int, actor_id: int, connection_id: int, *, approve: bool,
                      reason: Optional[str] = None) -> TaxProviderConnection:
        row = self.get(organization_id, connection_id)
        if row.status != ConnectionStatus.SUSPENDED or row.resume_requested_by is None:
            raise BadRequestException(f"Provider connection {row.id} has no pending resume request.")
        self._checker(row.resume_requested_by, actor_id, "asked to resume this connection")
        if approve:
            row.status, row.suspended_reason = ConnectionStatus.APPROVED, None
            row.approved_by, row.approved_at = actor_id, _now()
        row.resume_requested_by, row.decision_reason, row.updated_at = None, reason, _now()
        self._log(row, actor_id, BillingAuditAction.APPROVE if approve else BillingAuditAction.REJECT,
                  resumed=approve, reason=reason)
        self.db.commit()
        return row

    # ── use ──
    def usable_problem(self, row: Optional[TaxProviderConnection]) -> Optional[str]:
        if row is None:
            return "no provider connection"
        if row.status != ConnectionStatus.APPROVED:
            return f"the provider connection is {row.status.name}"
        if not has_credentials(row):
            return "the provider connection has no credentials"
        if (row.credential_store or "fernet") != configured_store_name():
            return (f"the credentials are in the {row.credential_store or 'fernet'} store, not the configured "
                    f"{configured_store_name()} store; re-enter them")
        definition = provider_definition(row.provider_name)
        if definition is None:
            return f"tax provider {row.provider_name} is not available"
        if row.environment == ProviderEnvironment.PRODUCTION and not production_credentials_allowed():
            return "production provider connections are not enabled yet (4d gate)"
        return None

    def adapter_for(self, row: Optional[TaxProviderConnection]):
        """A configured adapter for a usable connection, or None (fail closed).
        Raises SecretStoreUnavailable when the store can't be reached or
        refuses access: callers treat that as PROVIDER_UNAVAILABLE."""
        if self.usable_problem(row) is not None:
            return None
        definition = provider_definition(row.provider_name)
        endpoint = definition.endpoint(row.environment.name)       # the allowlist, never tenant input
        secret = self.secrets.get(row)
        if secret is None:
            return None
        adapter = definition.factory(endpoint=endpoint, credentials=secret, mode=ProviderMode[row.mode])
        adapter.connection_id = row.id
        return adapter

    def adapter_for_id(self, connection_id: Optional[int]):
        if connection_id is None:
            return None
        return self.adapter_for(self.db.get(TaxProviderConnection, connection_id))

    def test_connection(self, organization_id: int, actor_id: int, connection_id: int) -> TaxProviderConnection:
        row = self.get(organization_id, connection_id)
        if not has_credentials(row):
            raise BadRequestException("Set credentials before testing the connection.")
        definition = provider_definition(row.provider_name)
        if definition is None:
            raise BadRequestException(f"Tax provider {row.provider_name!r} is not available.")
        try:
            secret = self._store_of(row).get(row)
            if secret is None:
                raise SecretStoreUnavailable("no stored credential")
            adapter = definition.factory(endpoint=definition.endpoint(row.environment.name), credentials=secret,
                                         mode=ProviderMode[row.mode])
            result = adapter.test_connection() or {}
            ok, detail = bool(result.get("ok")), str(result.get("detail") or "")
        except Exception as exc:                                  # never echo the credential
            ok, detail = False, type(exc).__name__
        row.health_ok, row.health_checked_at, row.health_detail = ok, _now(), detail[:500]
        retired = None
        if ok and row.credential_previous_version is not None:
            # Rotation completes only now: the new version works, so the old
            # one is disabled. A failed test keeps it for a rollback rotation.
            retired = row.credential_previous_version
            try:
                self._store_of(row).retire_previous(row)
            except SecretStoreUnavailable:
                retired = None
        self._log(row, actor_id, BillingAuditAction.UPDATE, test_connection="ok" if ok else "failed",
                  previous_version_disabled=retired)
        self.db.commit()
        return row


def sweep_secret_versions(db: Session, now: Optional[datetime] = None) -> dict:
    """Run by reconciliation (Phase 4d-0): retry destroying the versions of
    revocations that failed (resolving their review items), and destroy
    disabled versions past TAX_SECRET_DISABLED_VERSION_RETENTION_DAYS. Each
    connection is isolated; failures wait for the next run."""
    from datetime import timedelta

    from app.modules.tax.enums import ReviewItemKind, ReviewItemStatus
    from app.modules.tax.models import TaxReviewItem

    now = now or _now()
    stats = {"destroy_retried": 0, "disabled_destroyed": 0, "secret_failures": 0}
    audit = BillingAuditService(db)
    cutoff = now - timedelta(days=settings.TAX_SECRET_DISABLED_VERSION_RETENTION_DAYS)
    rows = db.query(TaxProviderConnection).filter(
        TaxProviderConnection.credential_store == "gcp",
        (TaxProviderConnection.credential_destroy_through.isnot(None)) |
        (TaxProviderConnection.credential_disabled_versions.isnot(None))).order_by(TaxProviderConnection.id).all()
    for row in rows:
        store = GcpSecretManagerStore(db)
        try:
            if row.credential_destroy_through is not None:
                through = row.credential_destroy_through
                store.destroy(row, through=through)
                row.credential_destroy_through = None
                for item in db.query(TaxReviewItem).filter(
                        TaxReviewItem.organization_id == row.organization_id,
                        TaxReviewItem.kind == ReviewItemKind.CREDENTIAL_VERSIONS_NOT_DESTROYED,
                        TaxReviewItem.subject_id == row.id, TaxReviewItem.status == ReviewItemStatus.OPEN):
                    item.status, item.resolved_at = ReviewItemStatus.RESOLVED, now
                audit.log_no_commit(row.organization_id, None, BillingAuditAction.VOID, "TaxProviderConnection",
                                    row.id, new_values={"credentials": "revoked versions destroyed (retry)",
                                                        "through_version": through})
                stats["destroy_retried"] += 1
            destroyed = store.destroy_expired_disabled(row, cutoff)
            if destroyed:
                audit.log_no_commit(row.organization_id, None, BillingAuditAction.VOID, "TaxProviderConnection",
                                    row.id, new_values={"credentials": "disabled versions destroyed",
                                                        "versions": destroyed})
                stats["disabled_destroyed"] += len(destroyed)
            db.commit()
        except SecretStoreUnavailable:
            db.rollback()
            stats["secret_failures"] += 1
    return stats


def view_connection(row: TaxProviderConnection) -> dict:
    return {
        "id": row.id, "seller_entity_id": row.seller_entity_id, "provider_name": row.provider_name,
        "environment": row.environment.name, "mode": row.mode, "status": row.status.name,
        "proposed_by": row.proposed_by, "approved_by": row.approved_by, "approved_at": row.approved_at,
        "decision_reason": row.decision_reason, "suspended_reason": row.suspended_reason,
        "resume_requested_by": row.resume_requested_by,
        "credentials": {"present": has_credentials(row), "last_rotated_at": row.credential_rotated_at,
                        "last4": row.credential_last4, "store": row.credential_store,
                        "rotation_pending_test": row.credential_previous_version is not None},
        "health": {"ok": row.health_ok, "checked_at": row.health_checked_at, "detail": row.health_detail},
        "created_at": row.created_at, "updated_at": row.updated_at,
    }
