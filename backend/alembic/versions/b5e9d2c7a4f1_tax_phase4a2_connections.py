"""ZB-TAX-ARCH-001 Phase 4a-2: provider connections, credentials, certificate
evidence, regime changes, corrections by reference

Tenant (organization_id on every row):
  1. tax_provider_connections — a seller entity's connection to a provider;
     no URL column (endpoints are a code allowlist); credential presence,
     rotation time and masked last 4 only.
  2. tax_provider_secrets — Fernet-encrypted credentials (dedicated key);
     replaced on rotation, deleted on revocation.
  3. tax_evidence_files — content-addressed, write-once certificate evidence.
  4. tax_regime_changes — two-person regime changes in either direction.
  5. Columns: entity_tax_activations.provider_connection_id,
     customer_exemption_certificates.reason_code / evidence_file_id,
     tax_quotes.provider_connection_id, and on tax_provider_outbox
     provider_connection_id, reference_transaction_id, credit_note_id,
     request_payload, void_requested_by, void_requested_at.

Postgres guards (frozen copies): tenant record guards on the new tables; the
activation, certificate, quote and outbox guards recreated with the new
columns; certificate evidence is write-once.

Revision ID: b5e9d2c7a4f1
Revises: a8d3e6f1c9b2
Create Date: 2026-11-05
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.core.db_types
from app.modules.tax.enums import ConnectionStatus, ProviderEnvironment, TenantApprovalStatus

revision: str = 'b5e9d2c7a4f1'
down_revision: Union[str, Sequence[str], None] = 'a8d3e6f1c9b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CIE = app.core.db_types.CaseInsensitiveEnum
TS = sa.DateTime(timezone=True)


def _insp():
    return sa.inspect(op.get_bind())


def _has_table(t: str) -> bool:
    return _insp().has_table(t)


def _has_column(t: str, c: str) -> bool:
    return _has_table(t) and c in {x["name"] for x in _insp().get_columns(t)}


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _fk(target, ondelete="RESTRICT"):
    return sa.ForeignKey(target, ondelete=ondelete)


def _org():
    return sa.Column("organization_id", sa.Integer(), _fk("organizations.id"), nullable=False)


def _user(name):
    return sa.Column(name, sa.Integer(), _fk("users.id", "SET NULL"), nullable=True)


# ── frozen copies ───────────────────────────────────────────────────────

_ACTIVATION_2 = ("organization_id", "seller_entity_id", "jurisdiction_id", "tax_type_id", "transaction_class", "mode",
                 "effective_from", "effective_to", "registration_id", "legal_basis_id", "availability_version_id",
                 "tenant_rate_percent", "tenant_source_citation", "tenant_source_url", "proposed_by", "approved_by",
                 "approved_at", "predecessor_id", "created_at")
_ACTIVATION_4A2 = ("organization_id", "seller_entity_id", "jurisdiction_id", "tax_type_id", "transaction_class",
                   "mode", "effective_from", "effective_to", "registration_id", "legal_basis_id",
                   "availability_version_id", "tenant_rate_percent", "tenant_source_citation", "tenant_source_url",
                   "provider_connection_id", "proposed_by", "approved_by", "approved_at", "predecessor_id",
                   "created_at")
_ACTIVATION_FROZEN = "APPROVED,SUPERSEDED,REJECTED"
_CERT_2 = ("organization_id", "customer_id", "certificate_number", "jurisdiction_id", "tax_type_id",
           "scope_description", "valid_from", "expires_at", "evidence_ref", "created_by", "created_at")
_CERT_4A2 = _CERT_2[:-2] + ("reason_code", "created_by", "created_at")
_QUOTE_4A = (
    "organization_id", "document_type", "document_id", "seller_entity_id", "engine_kind", "engine_name",
    "engine_version", "rounding_rule", "currency", "currency_decimals", "tax_date", "pricing_mode",
    "context_fingerprint", "document_hash", "request_hash", "idempotency_key", "subtotal_unrounded",
    "discount_unrounded", "tax_unrounded", "total_unrounded", "subtotal", "discount_amount", "tax_amount",
    "total_amount", "issues", "warnings", "refusal_code", "refusal_reason", "provider_name",
    "provider_response_hash", "created_by", "created_at", "expires_at", "rounding_mode", "supply_address",
)
_QUOTE_4A2 = _QUOTE_4A + ("provider_connection_id",)
_OUTBOX_4A1 = ("organization_id", "invoice_id", "tax_quote_id", "operation", "provider_name", "idempotency_key",
               "created_by", "created_at")
_OUTBOX_4A2 = _OUTBOX_4A1 + ("provider_connection_id", "reference_transaction_id", "credit_note_id",
                             "request_payload")
_CONNECTION = ("organization_id", "seller_entity_id", "provider_name", "environment", "mode", "proposed_by",
               "created_at")
_EVIDENCE = ("organization_id", "sha256", "media_type", "size_bytes", "filename", "content", "uploaded_by",
             "created_at")
_REGIME = ("organization_id", "seller_entity_id", "from_regime", "to_regime", "reason", "eligibility",
           "proposed_by", "created_at")

_CERT_WRITE_ONCE = """
CREATE OR REPLACE FUNCTION customer_certificate_evidence_write_once() RETURNS trigger AS $$
BEGIN
  IF OLD.evidence_file_id IS NOT NULL AND NEW.evidence_file_id IS DISTINCT FROM OLD.evidence_file_id THEN
    RAISE EXCEPTION 'exemption certificate % already has its evidence document', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""


def _guard(table: str, fields: tuple, frozen: str = "*") -> None:
    op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_guard ON {table}")
    op.execute(f"CREATE TRIGGER trg_{table}_guard BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW "
               f"EXECUTE FUNCTION tax_tenant_record_guard('{','.join(fields)}', '{frozen}')")


def upgrade() -> None:
    if not _has_table("tax_provider_connections"):
        op.create_table(
            "tax_provider_connections",
            sa.Column("id", sa.Integer(), primary_key=True), _org(),
            sa.Column("seller_entity_id", sa.Integer(), _fk("seller_legal_entities.id"), nullable=False),
            sa.Column("provider_name", sa.String(100), nullable=False),
            sa.Column("environment", CIE(ProviderEnvironment), nullable=False),
            sa.Column("mode", sa.String(20), nullable=False),
            sa.Column("status", CIE(ConnectionStatus), nullable=False),
            _user("proposed_by"), _user("approved_by"),
            sa.Column("approved_at", TS, nullable=True),
            sa.Column("decision_reason", sa.Text(), nullable=True),
            sa.Column("suspended_reason", sa.Text(), nullable=True),
            _user("resume_requested_by"),
            sa.Column("credential_ref", sa.Integer(), nullable=True),
            sa.Column("credential_last4", sa.String(4), nullable=True),
            sa.Column("credential_rotated_at", TS, nullable=True),
            _user("credential_set_by"),
            sa.Column("health_ok", sa.Boolean(), nullable=True),
            sa.Column("health_checked_at", TS, nullable=True),
            sa.Column("health_detail", sa.Text(), nullable=True),
            sa.Column("created_at", TS, nullable=False),
            sa.Column("updated_at", TS, nullable=True),
        )
        for col in ("id", "organization_id", "seller_entity_id", "status"):
            op.create_index(f"ix_tax_provider_connections_{col}", "tax_provider_connections", [col])
    if not _has_table("tax_provider_secrets"):
        op.create_table(
            "tax_provider_secrets",
            sa.Column("id", sa.Integer(), primary_key=True), _org(),
            sa.Column("ciphertext", sa.Text(), nullable=False),
            sa.Column("key_version", sa.String(20), nullable=False),
            sa.Column("created_at", TS, nullable=False),
        )
        op.create_index("ix_tax_provider_secrets_id", "tax_provider_secrets", ["id"])
        op.create_index("ix_tax_provider_secrets_organization_id", "tax_provider_secrets", ["organization_id"])
    if not _has_table("tax_evidence_files"):
        op.create_table(
            "tax_evidence_files",
            sa.Column("id", sa.Integer(), primary_key=True), _org(),
            sa.Column("sha256", sa.String(64), nullable=False),
            sa.Column("media_type", sa.String(100), nullable=False),
            sa.Column("size_bytes", sa.Integer(), nullable=False),
            sa.Column("filename", sa.String(255), nullable=True),
            sa.Column("content", sa.LargeBinary(), nullable=False),
            _user("uploaded_by"),
            sa.Column("created_at", TS, nullable=False),
            sa.UniqueConstraint("organization_id", "sha256", name="uq_tax_evidence_files_org_sha256"),
        )
        op.create_index("ix_tax_evidence_files_id", "tax_evidence_files", ["id"])
        op.create_index("ix_tax_evidence_files_organization_id", "tax_evidence_files", ["organization_id"])
    if not _has_table("tax_regime_changes"):
        op.create_table(
            "tax_regime_changes",
            sa.Column("id", sa.Integer(), primary_key=True), _org(),
            sa.Column("seller_entity_id", sa.Integer(), _fk("seller_legal_entities.id"), nullable=False),
            sa.Column("from_regime", sa.String(30), nullable=False),
            sa.Column("to_regime", sa.String(30), nullable=False),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("eligibility", sa.JSON(), nullable=True),
            sa.Column("status", CIE(TenantApprovalStatus), nullable=False,
                      server_default=TenantApprovalStatus.PROPOSED.name),
            _user("proposed_by"), _user("approved_by"),
            sa.Column("approved_at", TS, nullable=True),
            sa.Column("decision_reason", sa.Text(), nullable=True),
            sa.Column("created_at", TS, nullable=False),
        )
        for col in ("id", "organization_id", "seller_entity_id", "status"):
            op.create_index(f"ix_tax_regime_changes_{col}", "tax_regime_changes", [col])
        op.create_index("uq_tax_regime_changes_one_open", "tax_regime_changes", ["seller_entity_id"], unique=True,
                        sqlite_where=sa.text("status = 'PROPOSED'"), postgresql_where=sa.text("status = 'PROPOSED'"))

    columns = [
        ("entity_tax_activations", sa.Column("provider_connection_id", sa.Integer(),
                                             _fk("tax_provider_connections.id"), nullable=True)),
        ("customer_exemption_certificates", sa.Column("reason_code", sa.String(50), nullable=True)),
        ("customer_exemption_certificates", sa.Column("evidence_file_id", sa.Integer(),
                                                      _fk("tax_evidence_files.id"), nullable=True)),
        ("tax_quotes", sa.Column("provider_connection_id", sa.Integer(), _fk("tax_provider_connections.id"),
                                 nullable=True)),
        ("tax_provider_outbox", sa.Column("provider_connection_id", sa.Integer(), _fk("tax_provider_connections.id"),
                                          nullable=True)),
        ("tax_provider_outbox", sa.Column("reference_transaction_id", sa.String(255), nullable=True)),
        ("tax_provider_outbox", sa.Column("credit_note_id", sa.Integer(), _fk("credit_notes.id"), nullable=True)),
        ("tax_provider_outbox", sa.Column("request_payload", sa.JSON(), nullable=True)),
        ("tax_provider_outbox", sa.Column("void_requested_by", sa.Integer(), _fk("users.id", "SET NULL"),
                                          nullable=True)),
        ("tax_provider_outbox", sa.Column("void_requested_at", TS, nullable=True)),
    ]
    for table, column in columns:
        if not _has_column(table, column.name):
            if _is_postgres() or not column.foreign_keys:
                op.add_column(table, column)
            else:                                       # SQLite cannot ALTER in a foreign key
                op.add_column(table, sa.Column(column.name, column.type, nullable=True))

    if _is_postgres():
        _guard("tax_provider_connections", _CONNECTION)
        _guard("tax_evidence_files", _EVIDENCE)
        _guard("tax_regime_changes", _REGIME)
        _guard("entity_tax_activations", _ACTIVATION_4A2, _ACTIVATION_FROZEN)
        _guard("customer_exemption_certificates", _CERT_4A2)
        _guard("tax_quotes", _QUOTE_4A2)
        _guard("tax_provider_outbox", _OUTBOX_4A2)
        op.execute(_CERT_WRITE_ONCE)
        op.execute("DROP TRIGGER IF EXISTS trg_customer_certificate_evidence_write_once "
                   "ON customer_exemption_certificates")
        op.execute("CREATE TRIGGER trg_customer_certificate_evidence_write_once BEFORE UPDATE "
                   "ON customer_exemption_certificates FOR EACH ROW "
                   "EXECUTE FUNCTION customer_certificate_evidence_write_once()")


def downgrade() -> None:
    if _is_postgres():
        op.execute("DROP TRIGGER IF EXISTS trg_customer_certificate_evidence_write_once "
                   "ON customer_exemption_certificates")
        op.execute("DROP FUNCTION IF EXISTS customer_certificate_evidence_write_once()")
        _guard("entity_tax_activations", _ACTIVATION_2, _ACTIVATION_FROZEN)
        _guard("customer_exemption_certificates", _CERT_2)
        _guard("tax_quotes", _QUOTE_4A)
        _guard("tax_provider_outbox", _OUTBOX_4A1)
    for table, column in (("tax_provider_outbox", "void_requested_at"), ("tax_provider_outbox", "void_requested_by"),
                          ("tax_provider_outbox", "request_payload"), ("tax_provider_outbox", "credit_note_id"),
                          ("tax_provider_outbox", "reference_transaction_id"),
                          ("tax_provider_outbox", "provider_connection_id"), ("tax_quotes", "provider_connection_id"),
                          ("customer_exemption_certificates", "evidence_file_id"),
                          ("customer_exemption_certificates", "reason_code"),
                          ("entity_tax_activations", "provider_connection_id")):
        if _has_column(table, column):
            op.drop_column(table, column)
    for table in ("tax_regime_changes", "tax_evidence_files", "tax_provider_secrets", "tax_provider_connections"):
        if _has_table(table):
            op.drop_table(table)
