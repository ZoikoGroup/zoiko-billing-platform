"""
app/modules/tax/quote_models.py
-------------------------------
Governed tax quotes and immutable snapshots (ZB-TAX-ARCH-001 Phase 3a, §07
TaxQuote/TaxSnapshot, §08.1 steps 5-8, §09).

A quote is computed for a draft invoice or quote; at issuance the invoice
domain revalidates it (context fingerprint + document hash) and commits it in
the same transaction that issues the invoice. A COMMITTED quote *is* the
invoice's tax snapshot: its content never changes, and it can only move to
VOIDED. Credit notes for governed invoices reverse amounts from the snapshot
components (credit_note_tax_lines), never from today's rates.

Precision: every amount is stored twice — unrounded at NUMERIC(18,6) for
audit/reconciliation, and rounded to the currency's minor unit at
NUMERIC(14,2), matching the invoice money columns.

Tenant-private: organization_id on every row; retained like the Phase 2
records (key fields frozen, deletes only inside the erasure purge).
"""
from sqlalchemy import (
    DDL,
    JSON,
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    event,
    text,
)
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session, relationship

from app.core.db_types import CaseInsensitiveEnum
from app.database import Base
from app.modules.tax.enums import (
    EngineKind,
    RemoteCommitState,
    RoundingMode,
    RoundingRule,
    SupplyCategory,
    TaxOutcome,
    TaxQuoteStatus,
    TransactionClass,
)
from app.modules.tax.models import register_tenant_record_guard

PRECISE = Numeric(18, 6)
MONEY = Numeric(14, 2)
RATE = Numeric(9, 6)


def _org():
    return Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)


def _user():
    return Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class TaxQuote(Base):
    __tablename__ = "tax_quotes"

    id                      = Column(Integer, primary_key=True, index=True)
    organization_id         = _org()
    # Polymorphic document reference (no FK): draft invoices/quotes can be
    # deleted, while their quote stays as the record of what was computed.
    # The committed link is invoices.tax_quote_id (FK, RESTRICT).
    document_type           = Column(String(20), nullable=False)          # "invoice" | "quote"
    document_id             = Column(Integer, nullable=False)
    seller_entity_id        = Column(Integer, ForeignKey("seller_legal_entities.id", ondelete="RESTRICT"), nullable=True)
    status                  = Column(CaseInsensitiveEnum(TaxQuoteStatus), nullable=False, index=True)
    engine_kind             = Column(CaseInsensitiveEnum(EngineKind), nullable=True)
    engine_name             = Column(String(100), nullable=True)
    engine_version          = Column(String(100), nullable=True)
    rounding_rule           = Column(CaseInsensitiveEnum(RoundingRule), nullable=True)
    rounding_mode           = Column(CaseInsensitiveEnum(RoundingMode), nullable=True)
    currency                = Column(String(3), nullable=True)
    currency_decimals       = Column(Integer, nullable=True)
    tax_date                = Column(Date, nullable=True)
    pricing_mode            = Column(String(20), nullable=True)
    # The place-of-supply address the quote was determined with, and its role
    # (PlaceOfSupplyRole). Sent to a provider exactly as stored (Phase 4a-1 fix 4).
    supply_address          = Column(JSON, nullable=True)
    # Phase 4c: the exemption certificates claimed on this quote (valid on the
    # tax date, evidence on file), sent to the provider by pseudonymous ref.
    exemption_claims        = Column(JSON, nullable=True)
    # Provider quotes: the tenant connection that computed them (Phase 4a-2).
    provider_connection_id  = Column(Integer, ForeignKey("tax_provider_connections.id", ondelete="RESTRICT"),
                                     nullable=True)
    context_fingerprint     = Column(String(64), nullable=False)
    document_hash           = Column(String(64), nullable=False)
    request_hash            = Column(String(64), nullable=False)
    idempotency_key         = Column(String(255), nullable=True)

    subtotal_unrounded      = Column(PRECISE, nullable=True)
    discount_unrounded      = Column(PRECISE, nullable=True)
    tax_unrounded           = Column(PRECISE, nullable=True)
    total_unrounded         = Column(PRECISE, nullable=True)
    subtotal                = Column(MONEY, nullable=True)
    discount_amount         = Column(MONEY, nullable=True)
    tax_amount              = Column(MONEY, nullable=True)
    total_amount            = Column(MONEY, nullable=True)

    issues                  = Column(JSON, nullable=True)      # blocking (required facts / refusals)
    warnings                = Column(JSON, nullable=True)      # non-required context issues
    refusal_code            = Column(String(60), nullable=True)
    refusal_reason          = Column(Text, nullable=True)

    # Phase 8 PR 1: which approved native pack version (and code) produced
    # the quote. Null for tenant-config and provider quotes.
    rule_pack_version_id    = Column(Integer, ForeignKey("tax_rule_pack_versions.id", ondelete="RESTRICT"),
                                     nullable=True, index=True)
    rule_pack_code_hash     = Column(String(64), nullable=True)

    provider_name           = Column(String(100), nullable=True)
    provider_response_hash  = Column(String(64), nullable=True)
    provider_correlation_id = Column(String(255), nullable=True)
    remote_commit_state     = Column(CaseInsensitiveEnum(RemoteCommitState), nullable=False,
                                     default=RemoteCommitState.NOT_APPLICABLE,
                                     server_default=RemoteCommitState.NOT_APPLICABLE.name)

    created_by              = _user()
    created_at              = Column(DateTime(timezone=True), nullable=False)
    expires_at              = Column(DateTime(timezone=True), nullable=True)
    validated_at            = Column(DateTime(timezone=True), nullable=True)
    stale_reason            = Column(Text, nullable=True)
    committed_at            = Column(DateTime(timezone=True), nullable=True)
    committed_by            = _user()
    voided_at               = Column(DateTime(timezone=True), nullable=True)
    voided_by               = _user()
    void_reason             = Column(Text, nullable=True)

    lines                   = relationship("TaxQuoteLine", back_populates="quote", order_by="TaxQuoteLine.line_number")

    __table_args__ = (
        Index("ix_tax_quotes_document", "organization_id", "document_type", "document_id"),
        Index("uq_tax_quotes_idempotency_key", "organization_id", "idempotency_key", unique=True,
              sqlite_where=text("idempotency_key IS NOT NULL"), postgresql_where=text("idempotency_key IS NOT NULL")),
    )


class TaxQuoteLine(Base):
    __tablename__ = "tax_quote_lines"

    id                          = Column(Integer, primary_key=True, index=True)
    organization_id             = _org()
    tax_quote_id                = Column(Integer, ForeignKey("tax_quotes.id", ondelete="RESTRICT"), nullable=False, index=True)
    document_line_id            = Column(Integer, nullable=False)          # invoice_items.id / quotation_items.id
    line_number                 = Column(Integer, nullable=False)
    product_id                  = Column(Integer, nullable=True)
    tax_code                    = Column(String(50), nullable=True)
    supply_category             = Column(CaseInsensitiveEnum(SupplyCategory), nullable=True)
    transaction_class           = Column(CaseInsensitiveEnum(TransactionClass), nullable=True)
    outcome                     = Column(CaseInsensitiveEnum(TaxOutcome), nullable=False)
    explanation_code            = Column(String(60), nullable=False)
    legal_reason                = Column(Text, nullable=True)
    is_tax_inclusive            = Column(Boolean, nullable=False)
    quantity                    = Column(PRECISE, nullable=False)
    gross_unrounded             = Column(PRECISE, nullable=False)       # qty x price (tax-inclusive for inclusive lines)
    line_discount_unrounded     = Column(PRECISE, nullable=False)
    document_discount_unrounded = Column(PRECISE, nullable=False)       # pro-rata share of the document discount (T09)
    taxable_base_unrounded      = Column(PRECISE, nullable=False)
    tax_unrounded               = Column(PRECISE, nullable=False)
    effective_rate              = Column(RATE, nullable=False)
    taxable_base                = Column(MONEY, nullable=False)
    tax_amount                  = Column(MONEY, nullable=False)
    line_total                  = Column(MONEY, nullable=False)          # taxable_base + tax_amount

    quote                       = relationship("TaxQuote", back_populates="lines")
    components                  = relationship("TaxQuoteComponent", back_populates="line", order_by="TaxQuoteComponent.id")


class TaxQuoteComponent(Base):
    __tablename__ = "tax_quote_components"

    id                 = Column(Integer, primary_key=True, index=True)
    organization_id    = _org()
    tax_quote_id       = Column(Integer, ForeignKey("tax_quotes.id", ondelete="RESTRICT"), nullable=False, index=True)
    tax_quote_line_id  = Column(Integer, ForeignKey("tax_quote_lines.id", ondelete="RESTRICT"), nullable=False, index=True)
    component_code     = Column(String(80), nullable=False)
    label              = Column(String(255), nullable=True)
    jurisdiction_id    = Column(Integer, ForeignKey("tax_jurisdictions.id", ondelete="RESTRICT"), nullable=True)
    tax_type_id        = Column(Integer, ForeignKey("tax_type_definitions.id", ondelete="RESTRICT"), nullable=True)
    rate_source        = Column(String(20), nullable=False)                 # REGISTRY | TENANT_CONFIG | PROVIDER
    rate_version_id    = Column(Integer, ForeignKey("tax_rate_versions.id", ondelete="RESTRICT"), nullable=True)
    activation_id      = Column(Integer, ForeignKey("entity_tax_activations.id", ondelete="RESTRICT"), nullable=True)
    rate_percent       = Column(RATE, nullable=False)
    taxable_unrounded  = Column(PRECISE, nullable=False)
    tax_unrounded      = Column(PRECISE, nullable=False)
    tax_amount         = Column(MONEY, nullable=False)
    reporting_code     = Column(String(50), nullable=True)
    is_reverse_charge  = Column(Boolean, nullable=False, default=False, server_default=text("false"))

    line               = relationship("TaxQuoteLine", back_populates="components")


class CreditNoteTaxLine(Base):
    """One credited quote component of a governed credit note. Amounts are
    signed (negative = reversal) so charge direction is preserved (T18)."""
    __tablename__ = "credit_note_tax_lines"

    id                     = Column(Integer, primary_key=True, index=True)
    organization_id        = _org()
    credit_note_id         = Column(Integer, ForeignKey("credit_notes.id", ondelete="RESTRICT"), nullable=False, index=True)
    invoice_id             = Column(Integer, ForeignKey("invoices.id", ondelete="RESTRICT"), nullable=False, index=True)
    tax_quote_id           = Column(Integer, ForeignKey("tax_quotes.id", ondelete="RESTRICT"), nullable=False)
    tax_quote_line_id      = Column(Integer, ForeignKey("tax_quote_lines.id", ondelete="RESTRICT"), nullable=False)
    tax_quote_component_id = Column(Integer, ForeignKey("tax_quote_components.id", ondelete="RESTRICT"), nullable=False)
    credited_base_unrounded = Column(PRECISE, nullable=False)
    credited_tax_unrounded = Column(PRECISE, nullable=False)
    credited_base          = Column(MONEY, nullable=False)
    credited_tax           = Column(MONEY, nullable=False)
    created_by             = _user()
    created_at             = Column(DateTime(timezone=True), nullable=False)


#: Lifecycle columns of tax_quotes that may still change after insert.
QUOTE_MUTABLE_FIELDS = (
    "status", "validated_at", "stale_reason", "committed_at", "committed_by", "voided_at", "voided_by",
    "void_reason", "remote_commit_state", "provider_correlation_id",
)


def _frozen(table, mutable=()):
    return tuple(c.name for c in table.columns if c.name not in mutable and c.name != "id")


register_tenant_record_guard(TaxQuote.__table__, _frozen(TaxQuote.__table__, QUOTE_MUTABLE_FIELDS))
register_tenant_record_guard(TaxQuoteLine.__table__, _frozen(TaxQuoteLine.__table__))
register_tenant_record_guard(TaxQuoteComponent.__table__, _frozen(TaxQuoteComponent.__table__))
register_tenant_record_guard(CreditNoteTaxLine.__table__, _frozen(CreditNoteTaxLine.__table__))

# A committed quote is a snapshot: it can only be voided, and a voided quote
# is final. (Content columns are already frozen by the tenant guard.)
PG_QUOTE_STATUS_GUARD = [
    """
    CREATE OR REPLACE FUNCTION tax_quotes_status_guard() RETURNS trigger AS $$
    BEGIN
      IF OLD.status = 'VOIDED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'tax quote % is voided and final', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      IF OLD.status = 'COMMITTED' AND NEW.status NOT IN ('COMMITTED', 'VOIDED') THEN
        RAISE EXCEPTION 'tax quote % is committed: it can only be voided', OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
    """,
    """
    CREATE TRIGGER trg_tax_quotes_status_guard
      BEFORE UPDATE ON tax_quotes
      FOR EACH ROW EXECUTE FUNCTION tax_quotes_status_guard()
    """,
]
for _stmt in PG_QUOTE_STATUS_GUARD:
    event.listen(TaxQuote.__table__, "after_create", DDL(_stmt).execute_if(dialect="postgresql"))


@event.listens_for(Session, "before_flush")
def _guard_quote_status(session, flush_context, instances):
    """ORM twin of tax_quotes_status_guard (clear errors for ORM writes)."""
    from app.modules.tax.models import TaxRecordFrozenError

    for obj in session.dirty:
        if not isinstance(obj, TaxQuote):
            continue
        hist = sa_inspect(obj).attrs["status"].history
        if not hist.has_changes():
            if hist.unchanged and hist.unchanged[0] == TaxQuoteStatus.VOIDED and session.is_modified(obj):
                raise TaxRecordFrozenError(f"Tax quote {obj.id} is voided and final.")
            continue
        old = hist.deleted[0] if hist.deleted else None
        if old == TaxQuoteStatus.VOIDED:
            raise TaxRecordFrozenError(f"Tax quote {obj.id} is voided and final.")
        if old == TaxQuoteStatus.COMMITTED and obj.status != TaxQuoteStatus.VOIDED:
            raise TaxRecordFrozenError(f"Tax quote {obj.id} is committed: it can only be voided.")
