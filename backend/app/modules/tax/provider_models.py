"""
app/modules/tax/provider_models.py
----------------------------------
ZB-TAX-ARCH-001 Phase 4a-1: the provider issuance outbox (tenant) and two
platform tables that make provider issuing fail closed (circuit breakers and
job heartbeats). See TAX_PHASE4_PLAN.md.

tax_provider_outbox (tenant, retained like the other tax records): one row
per provider operation (COMMIT, VOID, LINK) with a fixed idempotency key. The
key, invoice, quote, operation and provider are frozen from insert; a row in
a terminal state (DONE, FAILED, VOIDED) never changes again; deletes happen
only inside the tenant erasure purge. At most one active COMMIT per invoice.

tax_provider_circuits / tax_job_heartbeats (platform, no tenant data): the
circuit state per provider and the reconciliation heartbeat. Ops see these
only as aggregates.
"""
from sqlalchemy import DDL, JSON, Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, event, text
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session

from app.core.db_types import CaseInsensitiveEnum
from app.database import Base
from app.modules.tax.enums import (
    TERMINAL_OUTBOX_STATES,
    CircuitState,
    ConnectionStatus,
    OutboxOperation,
    OutboxState,
    ProviderEnvironment,
)
from app.modules.tax.models import register_tenant_record_guard

_ACTIVE_SQL = "operation = 'COMMIT' AND state IN ('PENDING', 'UNCERTAIN', 'REMOTE_COMMITTED')"


class TaxProviderOutbox(Base):
    __tablename__ = "tax_provider_outbox"

    id                      = Column(Integer, primary_key=True, index=True)
    organization_id         = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    invoice_id              = Column(Integer, ForeignKey("invoices.id", ondelete="RESTRICT"), nullable=False, index=True)
    tax_quote_id            = Column(Integer, ForeignKey("tax_quotes.id", ondelete="RESTRICT"), nullable=False, index=True)
    operation               = Column(CaseInsensitiveEnum(OutboxOperation), nullable=False)
    provider_name           = Column(String(100), nullable=False)
    idempotency_key         = Column(String(255), nullable=False, unique=True)
    document_reference      = Column(String(255), nullable=True)   # what the provider sees as our document
    state                   = Column(CaseInsensitiveEnum(OutboxState), nullable=False, index=True)
    attempts                = Column(Integer, nullable=False, default=0, server_default="0")
    next_attempt_at         = Column(DateTime(timezone=True), nullable=True)
    grace_deadline          = Column(DateTime(timezone=True), nullable=True)
    last_error              = Column(Text, nullable=True)
    provider_transaction_id = Column(String(255), nullable=True)
    remote_snapshot         = Column(JSON, nullable=True)            # transaction_state at commit / last check
    verified_at             = Column(DateTime(timezone=True), nullable=True)   # snapshot confirmed by a state lookup
    review_kind             = Column(String(40), nullable=True)      # OutboxReviewKind name
    review_reason           = Column(Text, nullable=True)
    send_intent             = Column(JSON, nullable=True)            # {"channel": "email", ...} once SENT
    # Phase 4a-2
    provider_connection_id  = Column(Integer, ForeignKey("tax_provider_connections.id", ondelete="RESTRICT"),
                                     nullable=True)
    reference_transaction_id = Column(String(255), nullable=True)    # ADJUST / VOID: the original provider transaction
    credit_note_id          = Column(Integer, ForeignKey("credit_notes.id", ondelete="RESTRICT"), nullable=True)
    request_payload         = Column(JSON, nullable=True)            # ADJUST: the minimized adjustment payload
    void_requested_by       = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    void_requested_at       = Column(DateTime(timezone=True), nullable=True)
    created_by              = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at              = Column(DateTime(timezone=True), nullable=False)
    updated_at              = Column(DateTime(timezone=True), nullable=True)
    completed_at            = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("uq_tax_provider_outbox_one_active_commit", "invoice_id", unique=True,
              sqlite_where=text(_ACTIVE_SQL), postgresql_where=text(_ACTIVE_SQL)),
    )


OUTBOX_FROZEN_FIELDS = ("organization_id", "invoice_id", "tax_quote_id", "operation", "provider_name",
                        "idempotency_key", "created_by", "created_at", "provider_connection_id",
                        "reference_transaction_id", "credit_note_id", "request_payload")
register_tenant_record_guard(TaxProviderOutbox.__table__, OUTBOX_FROZEN_FIELDS)

#: The only columns a terminal row may still change: a committed snapshot is
#: verified by a later state lookup (fix 6) without reopening the row.
TERMINAL_MUTABLE_FIELDS = ("verified_at", "remote_snapshot", "updated_at")

PG_OUTBOX_TERMINAL_GUARD = [
    """
    CREATE OR REPLACE FUNCTION tax_provider_outbox_terminal_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.state IN ('DONE', 'FAILED', 'VOIDED', 'CANCELLED')
         AND (to_jsonb(NEW) - 'verified_at' - 'remote_snapshot' - 'updated_at')
             IS DISTINCT FROM (to_jsonb(OLD) - 'verified_at' - 'remote_snapshot' - 'updated_at') THEN
        RAISE EXCEPTION 'tax_provider_outbox % is % and final', OLD.id, OLD.state
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
    """,
    """
    CREATE TRIGGER trg_tax_provider_outbox_terminal_guard
      BEFORE UPDATE ON tax_provider_outbox
      FOR EACH ROW EXECUTE FUNCTION tax_provider_outbox_terminal_guard()
    """,
]
for _stmt in PG_OUTBOX_TERMINAL_GUARD:
    event.listen(TaxProviderOutbox.__table__, "after_create", DDL(_stmt).execute_if(dialect="postgresql"))


@event.listens_for(Session, "before_flush")
def _guard_outbox_terminal(session, flush_context, instances):
    """ORM twin of the terminal-state trigger."""
    from app.modules.tax.models import TaxRecordFrozenError

    for obj in session.dirty:
        if not isinstance(obj, TaxProviderOutbox) or not session.is_modified(obj):
            continue
        state = sa_inspect(obj)
        hist = state.attrs["state"].history
        old = hist.deleted[0] if hist.deleted else obj.state
        if old not in TERMINAL_OUTBOX_STATES:
            continue
        changed = {a.key for a in state.mapper.column_attrs if state.attrs[a.key].history.has_changes()}
        if changed - set(TERMINAL_MUTABLE_FIELDS):
            raise TaxRecordFrozenError(f"Provider outbox row {obj.id} is {old.name} and final.")


class TaxProviderConnection(Base):
    """A tenant's connection to a provider for one seller entity (Phase 4a-2).

    The endpoint is never stored or supplied: it comes from the code-defined
    allowlist for (provider, environment). Credentials live in the
    SecretStore and are write-only; only presence, last rotation and the
    masked last 4 characters are kept here. Proposed by a billing admin,
    approved by a different finance approver."""
    __tablename__ = "tax_provider_connections"

    id                    = Column(Integer, primary_key=True, index=True)
    organization_id       = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    seller_entity_id      = Column(Integer, ForeignKey("seller_legal_entities.id", ondelete="RESTRICT"), nullable=False,
                                   index=True)
    provider_name         = Column(String(100), nullable=False)
    environment           = Column(CaseInsensitiveEnum(ProviderEnvironment), nullable=False)
    mode                  = Column(String(20), nullable=False)          # ProviderMode name
    status                = Column(CaseInsensitiveEnum(ConnectionStatus), nullable=False, index=True)
    proposed_by           = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approved_by           = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    approved_at           = Column(DateTime(timezone=True), nullable=True)
    decision_reason       = Column(Text, nullable=True)
    suspended_reason      = Column(Text, nullable=True)
    resume_requested_by   = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    credential_ref        = Column(Integer, nullable=True)              # Fernet store: tax_provider_secrets id
    # Phase 4d-0: which store holds the credential, and (gcp) the secret's
    # resource name plus version numbers. Never the value.
    credential_store            = Column(String(20), nullable=True)     # "fernet" | "gcp"
    credential_secret_name      = Column(String(255), nullable=True)    # projects/…/secrets/tax-provider-…
    credential_version          = Column(String(20), nullable=True)
    credential_previous_version = Column(String(20), nullable=True)     # disabled after a successful test
    # Disabled versions awaiting destruction: {"<version>": "<disabled at ISO>"}.
    credential_disabled_versions = Column(JSON, nullable=True)
    # A revocation whose destroy failed: versions up to this one are destroyed
    # by reconciliation (later ones belong to new credentials).
    credential_destroy_through  = Column(String(20), nullable=True)
    credential_last4      = Column(String(4), nullable=True)
    credential_rotated_at = Column(DateTime(timezone=True), nullable=True)
    credential_set_by     = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    health_ok             = Column(Boolean, nullable=True)
    health_checked_at     = Column(DateTime(timezone=True), nullable=True)
    health_detail         = Column(Text, nullable=True)
    created_at            = Column(DateTime(timezone=True), nullable=False)
    updated_at            = Column(DateTime(timezone=True), nullable=True)


CONNECTION_FROZEN_FIELDS = ("organization_id", "seller_entity_id", "provider_name", "environment", "mode",
                            "proposed_by", "created_at")
register_tenant_record_guard(TaxProviderConnection.__table__, CONNECTION_FROZEN_FIELDS)


class TaxProviderSecret(Base):
    """Encrypted provider credentials (interim Fernet envelope, dedicated key).
    Never logged or returned. Replaced on rotation and deleted on revocation:
    secret material is not retained evidence."""
    __tablename__ = "tax_provider_secrets"

    id              = Column(Integer, primary_key=True, index=True)
    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    ciphertext      = Column(Text, nullable=False)
    key_version     = Column(String(20), nullable=False)
    created_at      = Column(DateTime(timezone=True), nullable=False)


class TaxProviderCircuit(Base):
    """Platform: circuit breaker per provider (no tenant data)."""
    __tablename__ = "tax_provider_circuits"

    provider_name     = Column(String(100), primary_key=True)
    state             = Column(CaseInsensitiveEnum(CircuitState), nullable=False, default=CircuitState.CLOSED)
    failure_count     = Column(Integer, nullable=False, default=0)
    window_started_at = Column(DateTime(timezone=True), nullable=True)
    opened_at         = Column(DateTime(timezone=True), nullable=True)
    suspended_reason  = Column(Text, nullable=True)
    updated_at        = Column(DateTime(timezone=True), nullable=True)


class TaxJobHeartbeat(Base):
    """Platform: last run of a tax background job (reconciliation)."""
    __tablename__ = "tax_job_heartbeats"

    job_name         = Column(String(100), primary_key=True)
    last_started_at  = Column(DateTime(timezone=True), nullable=True)
    last_finished_at = Column(DateTime(timezone=True), nullable=True)
    last_ok          = Column(Boolean, nullable=False, default=False)
    stats            = Column(JSON, nullable=True)                    # aggregate counts only


#: Platform tables (never purged with a tenant).
PROVIDER_PLATFORM_TABLES = ("tax_provider_circuits", "tax_job_heartbeats")
