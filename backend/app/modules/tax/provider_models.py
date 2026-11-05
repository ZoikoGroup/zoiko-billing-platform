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
from app.modules.tax.enums import CircuitState, OutboxOperation, OutboxState, TERMINAL_OUTBOX_STATES
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
    review_reason           = Column(Text, nullable=True)
    created_by              = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at              = Column(DateTime(timezone=True), nullable=False)
    updated_at              = Column(DateTime(timezone=True), nullable=True)
    completed_at            = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("uq_tax_provider_outbox_one_active_commit", "invoice_id", unique=True,
              sqlite_where=text(_ACTIVE_SQL), postgresql_where=text(_ACTIVE_SQL)),
    )


OUTBOX_FROZEN_FIELDS = ("organization_id", "invoice_id", "tax_quote_id", "operation", "provider_name",
                        "idempotency_key", "created_by", "created_at")
register_tenant_record_guard(TaxProviderOutbox.__table__, OUTBOX_FROZEN_FIELDS)

PG_OUTBOX_TERMINAL_GUARD = [
    """
    CREATE OR REPLACE FUNCTION tax_provider_outbox_terminal_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.state IN ('DONE', 'FAILED', 'VOIDED') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
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
        hist = sa_inspect(obj).attrs["state"].history
        old = hist.deleted[0] if hist.deleted else obj.state
        if old in TERMINAL_OUTBOX_STATES:
            raise TaxRecordFrozenError(f"Provider outbox row {obj.id} is {old.name} and final.")


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
