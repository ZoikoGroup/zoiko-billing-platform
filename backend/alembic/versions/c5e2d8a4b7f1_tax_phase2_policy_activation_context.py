"""ZB-TAX-ARCH-001 Phase 2: policy, activation and tax context

Platform (non-tenant):
  1. tax_market_availability_versions — jurisdiction × tax type × transaction
     class -> supported mode, §13.2 gate evidence, tenant_config_permitted.
  2. tax_code_set_versions + tax_codes — versioned product tax-code taxonomy.

Tenant-private (organization_id on every row):
  3. entity_tax_registrations, entity_tax_legal_bases, entity_tax_activations
  4. product_tax_classifications + tax_classification_counters
  5. customer_tax_addresses, customer_tax_ids, customer_exemption_certificates
  6. tax_review_items (T14)
  7. quotations.seller_entity_id / tax_context_status / tax_classification_version

Backfills:
  * quotations.seller_entity_id -> each organization's default seller entity
    (same rule as the Phase 0 invoice backfill).
  * customer_tax_addresses from billing_country / shipping_country, ISO code
    only where resolve_country_code is unambiguous (confidence DERIVED); the
    rest stays absent. The free-text fields are not modified.
  * customer_tax_ids from tax_id / vat_number / gst_number / pan / tin as
    UNVERIFIED, raw value kept exactly, source_field recorded; normalization is
    whitespace removal + upper-case for matching only. One row per distinct
    normalized value per customer (first column in that order wins).

Postgres-only guards (frozen copies of the model DDL): content of submitted
platform versions is immutable, ACTIVE versions can only be superseded, codes
of a submitted set are frozen; on the tenant tables key fields of decided
records are immutable and DELETE is allowed only when the erasure purge has
set the transaction-scoped flag zoiko.tax_erasure.

Downgrade drops everything above (the backfilled evidence rows included —
the legacy source columns are untouched, so a re-upgrade rebuilds them).

Revision ID: c5e2d8a4b7f1
Revises: b3d8f2a6c1e4
Create Date: 2026-11-04
"""
import re
from datetime import datetime, timezone
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.core.db_types
from app.modules.tax.enums import (
    AddressConfidence,
    AddressRole,
    CertificateStatus,
    EvidenceSource,
    PlatformVersionStatus,
    RegistrationStatus,
    ReviewItemKind,
    ReviewItemStatus,
    SupplyCategory,
    TaxContextStatus,
    TaxOperatingMode,
    TenantApprovalStatus,
    TransactionClass,
    VerificationStatus,
)

revision: str = 'c5e2d8a4b7f1'
down_revision: Union[str, Sequence[str], None] = 'b3d8f2a6c1e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

CIE = app.core.db_types.CaseInsensitiveEnum
TS = sa.DateTime(timezone=True)

PLATFORM_TABLES = ("tax_market_availability_versions", "tax_code_set_versions", "tax_codes")
TENANT_TABLES = (
    "entity_tax_registrations", "entity_tax_legal_bases", "entity_tax_activations",
    "product_tax_classifications", "tax_classification_counters", "customer_tax_addresses",
    "customer_tax_ids", "customer_exemption_certificates", "tax_review_items",
)
QUOTE_COLUMNS = ("seller_entity_id", "tax_context_status", "tax_classification_version")


def _inspector():
    return sa.inspect(op.get_bind())


def _has_table(table: str) -> bool:
    return _inspector().has_table(table)


def _has_column(table: str, column: str) -> bool:
    return _has_table(table) and column in {c["name"] for c in _inspector().get_columns(table)}


def _has_index(table: str, index: str) -> bool:
    return _has_table(table) and index in {i["name"] for i in _inspector().get_indexes(table)}


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _pg_has(sql: str, **params) -> bool:
    return op.get_bind().execute(sa.text(sql), params).scalar() is not None


def _fk(target, ondelete="RESTRICT"):
    return sa.ForeignKey(target, ondelete=ondelete)


def _approval_cols():
    return [
        sa.Column("validation_errors", sa.JSON(), nullable=True),
        sa.Column("approval_request_id", sa.Integer(), _fk("approval_requests.id"), nullable=True),
        sa.Column("created_by_user_id", sa.Integer(), _fk("users.id", "SET NULL"), nullable=True),
        sa.Column("maker_user_id", sa.Integer(), _fk("users.id", "SET NULL"), nullable=True),
        sa.Column("checker_user_id", sa.Integer(), _fk("users.id", "SET NULL"), nullable=True),
        sa.Column("publisher_user_id", sa.Integer(), _fk("users.id", "SET NULL"), nullable=True),
        sa.Column("created_at", TS, nullable=False),
        sa.Column("submitted_at", TS, nullable=True),
        sa.Column("approved_at", TS, nullable=True),
        sa.Column("published_at", TS, nullable=True),
        sa.Column("superseded_at", TS, nullable=True),
        sa.Column("rejection_reason", sa.Text(), nullable=True),
    ]


def _org():
    return sa.Column("organization_id", sa.Integer(), _fk("organizations.id"), nullable=False)


def _by(name):
    return sa.Column(name, sa.Integer(), _fk("users.id", "SET NULL"), nullable=True)


def _status(enum_cls, default):
    return sa.Column("status", CIE(enum_cls), nullable=False, server_default=default.name)


def _create_platform_tables() -> None:
    if not _has_table("tax_market_availability_versions"):
        op.create_table(
            "tax_market_availability_versions",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("jurisdiction_id", sa.Integer(), _fk("tax_jurisdictions.id"), nullable=False),
            sa.Column("tax_type_id", sa.Integer(), _fk("tax_type_definitions.id"), nullable=False),
            sa.Column("transaction_class", CIE(TransactionClass), nullable=False),
            sa.Column("mode", CIE(TaxOperatingMode), nullable=False),
            sa.Column("tenant_config_permitted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("gates", sa.JSON(), nullable=False),
            sa.Column("notes", sa.Text(), nullable=True),
            _status(PlatformVersionStatus, PlatformVersionStatus.PENDING_REVIEW),
            sa.Column("predecessor_id", sa.Integer(), _fk("tax_market_availability_versions.id"), nullable=True),
            *_approval_cols(),
        )
        op.create_index("ix_tax_market_availability_versions_id", "tax_market_availability_versions", ["id"])
        op.create_index("ix_tax_market_availability_versions_status", "tax_market_availability_versions", ["status"])
        op.create_index("ix_tax_market_availability_key", "tax_market_availability_versions",
                        ["jurisdiction_id", "tax_type_id", "transaction_class"])
        op.create_index("uq_tax_market_availability_one_active", "tax_market_availability_versions",
                        ["jurisdiction_id", "tax_type_id", "transaction_class"], unique=True,
                        postgresql_where=sa.text("status = 'ACTIVE'"), sqlite_where=sa.text("status = 'ACTIVE'"))

    if not _has_table("tax_code_set_versions"):
        op.create_table(
            "tax_code_set_versions",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("code", sa.String(30), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("notes", sa.Text(), nullable=True),
            _status(PlatformVersionStatus, PlatformVersionStatus.PENDING_REVIEW),
            sa.Column("predecessor_id", sa.Integer(), _fk("tax_code_set_versions.id"), nullable=True),
            *_approval_cols(),
            sa.UniqueConstraint("code", "version", name="uq_tax_code_set_versions_code_version"),
        )
        op.create_index("ix_tax_code_set_versions_id", "tax_code_set_versions", ["id"])
        op.create_index("ix_tax_code_set_versions_status", "tax_code_set_versions", ["status"])
        op.create_index("uq_tax_code_set_one_active", "tax_code_set_versions", ["code"], unique=True,
                        postgresql_where=sa.text("status = 'ACTIVE'"), sqlite_where=sa.text("status = 'ACTIVE'"))

    if not _has_table("tax_codes"):
        op.create_table(
            "tax_codes",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("code_set_version_id", sa.Integer(), _fk("tax_code_set_versions.id"), nullable=False),
            sa.Column("code", sa.String(50), nullable=False),
            sa.Column("name", sa.String(255), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("parent_code", sa.String(50), nullable=True),
            sa.Column("supply_category", CIE(SupplyCategory), nullable=False),
            sa.Column("registry_product_scope", sa.String(100), nullable=False, server_default="GENERAL"),
            sa.UniqueConstraint("code_set_version_id", "code", name="uq_tax_codes_set_code"),
        )
        op.create_index("ix_tax_codes_id", "tax_codes", ["id"])
        op.create_index("ix_tax_codes_code_set_version_id", "tax_codes", ["code_set_version_id"])


def _create_tenant_tables() -> None:
    def table(name, *cols, indexes=()):
        if _has_table(name):
            return
        op.create_table(name, *cols)
        for idx_name, idx_cols, kw in indexes:
            op.create_index(idx_name, name, idx_cols, **kw)

    approved_only = dict(unique=True, postgresql_where=sa.text("status = 'APPROVED'"),
                         sqlite_where=sa.text("status = 'APPROVED'"))

    table("entity_tax_registrations",
          sa.Column("id", sa.Integer(), primary_key=True), _org(),
          sa.Column("seller_entity_id", sa.Integer(), _fk("seller_legal_entities.id"), nullable=False),
          sa.Column("jurisdiction_id", sa.Integer(), _fk("tax_jurisdictions.id"), nullable=False),
          sa.Column("tax_type_id", sa.Integer(), _fk("tax_type_definitions.id"), nullable=False),
          sa.Column("registration_number", sa.String(100), nullable=False),
          sa.Column("valid_from", sa.Date(), nullable=False),
          sa.Column("valid_to", sa.Date(), nullable=True),
          _status(RegistrationStatus, RegistrationStatus.ACTIVE),
          sa.Column("verification_status", CIE(VerificationStatus), nullable=False,
                    server_default=VerificationStatus.UNVERIFIED.name),
          sa.Column("verification_method", sa.String(100), nullable=True),
          sa.Column("verification_response", sa.JSON(), nullable=True),
          sa.Column("verified_at", TS, nullable=True),
          sa.Column("verification_expires_at", TS, nullable=True),
          sa.Column("evidence_ref", sa.String(500), nullable=True),
          sa.Column("notes", sa.Text(), nullable=True),
          _by("created_by"), sa.Column("created_at", TS, nullable=False),
          _by("updated_by"), sa.Column("updated_at", TS, nullable=True),
          indexes=[("ix_entity_tax_registrations_id", ["id"], {}),
                   ("ix_entity_tax_registrations_organization_id", ["organization_id"], {}),
                   ("ix_entity_tax_registrations_seller_entity_id", ["seller_entity_id"], {})])

    table("entity_tax_legal_bases",
          sa.Column("id", sa.Integer(), primary_key=True), _org(),
          sa.Column("seller_entity_id", sa.Integer(), _fk("seller_legal_entities.id"), nullable=False),
          sa.Column("jurisdiction_id", sa.Integer(), _fk("tax_jurisdictions.id"), nullable=False),
          sa.Column("tax_type_id", sa.Integer(), _fk("tax_type_definitions.id"), nullable=False),
          sa.Column("legal_basis", sa.Text(), nullable=False),
          sa.Column("evidence_ref", sa.String(500), nullable=False),
          sa.Column("valid_from", sa.Date(), nullable=False),
          sa.Column("valid_to", sa.Date(), nullable=True),
          _status(TenantApprovalStatus, TenantApprovalStatus.PROPOSED),
          _by("recorded_by"), _by("approved_by"),
          sa.Column("approved_at", TS, nullable=True),
          sa.Column("decision_reason", sa.Text(), nullable=True),
          sa.Column("predecessor_id", sa.Integer(), _fk("entity_tax_legal_bases.id"), nullable=True),
          sa.Column("created_at", TS, nullable=False),
          sa.Column("superseded_at", TS, nullable=True),
          indexes=[("ix_entity_tax_legal_bases_id", ["id"], {}),
                   ("ix_entity_tax_legal_bases_organization_id", ["organization_id"], {}),
                   ("ix_entity_tax_legal_bases_seller_entity_id", ["seller_entity_id"], {}),
                   ("ix_entity_tax_legal_bases_status", ["status"], {})])

    table("entity_tax_activations",
          sa.Column("id", sa.Integer(), primary_key=True), _org(),
          sa.Column("seller_entity_id", sa.Integer(), _fk("seller_legal_entities.id"), nullable=False),
          sa.Column("jurisdiction_id", sa.Integer(), _fk("tax_jurisdictions.id"), nullable=False),
          sa.Column("tax_type_id", sa.Integer(), _fk("tax_type_definitions.id"), nullable=False),
          sa.Column("transaction_class", CIE(TransactionClass), nullable=False),
          sa.Column("mode", CIE(TaxOperatingMode), nullable=False),
          sa.Column("effective_from", sa.Date(), nullable=False),
          sa.Column("effective_to", sa.Date(), nullable=True),
          sa.Column("registration_id", sa.Integer(), _fk("entity_tax_registrations.id"), nullable=True),
          sa.Column("legal_basis_id", sa.Integer(), _fk("entity_tax_legal_bases.id"), nullable=True),
          sa.Column("availability_version_id", sa.Integer(), _fk("tax_market_availability_versions.id"), nullable=True),
          sa.Column("tenant_rate_percent", sa.Numeric(9, 6), nullable=True),
          sa.Column("tenant_source_citation", sa.Text(), nullable=True),
          sa.Column("tenant_source_url", sa.String(1000), nullable=True),
          _status(TenantApprovalStatus, TenantApprovalStatus.PROPOSED),
          _by("proposed_by"), _by("approved_by"),
          sa.Column("approved_at", TS, nullable=True),
          sa.Column("decision_reason", sa.Text(), nullable=True),
          sa.Column("predecessor_id", sa.Integer(), _fk("entity_tax_activations.id"), nullable=True),
          sa.Column("created_at", TS, nullable=False),
          sa.Column("superseded_at", TS, nullable=True),
          indexes=[("ix_entity_tax_activations_id", ["id"], {}),
                   ("ix_entity_tax_activations_organization_id", ["organization_id"], {}),
                   ("ix_entity_tax_activations_seller_entity_id", ["seller_entity_id"], {}),
                   ("ix_entity_tax_activations_status", ["status"], {}),
                   ("uq_entity_tax_activations_one_approved",
                    ["organization_id", "seller_entity_id", "jurisdiction_id", "tax_type_id", "transaction_class"],
                    approved_only)])

    table("product_tax_classifications",
          sa.Column("id", sa.Integer(), primary_key=True), _org(),
          sa.Column("product_id", sa.Integer(), _fk("products.id"), nullable=False),
          sa.Column("tax_code_id", sa.Integer(), _fk("tax_codes.id"), nullable=False),
          sa.Column("reason", sa.Text(), nullable=True),
          _status(TenantApprovalStatus, TenantApprovalStatus.PROPOSED),
          _by("proposed_by"), _by("approved_by"),
          sa.Column("approved_at", TS, nullable=True),
          sa.Column("decision_reason", sa.Text(), nullable=True),
          sa.Column("classification_version", sa.Integer(), nullable=True),
          sa.Column("predecessor_id", sa.Integer(), _fk("product_tax_classifications.id"), nullable=True),
          sa.Column("created_at", TS, nullable=False),
          sa.Column("superseded_at", TS, nullable=True),
          indexes=[("ix_product_tax_classifications_id", ["id"], {}),
                   ("ix_product_tax_classifications_organization_id", ["organization_id"], {}),
                   ("ix_product_tax_classifications_product_id", ["product_id"], {}),
                   ("ix_product_tax_classifications_status", ["status"], {}),
                   ("uq_product_tax_classifications_one_approved", ["organization_id", "product_id"], approved_only)])

    table("tax_classification_counters",
          sa.Column("organization_id", sa.Integer(), _fk("organizations.id"), primary_key=True),
          sa.Column("version", sa.Integer(), nullable=False, server_default="0"),
          sa.Column("updated_at", TS, nullable=True))

    table("customer_tax_addresses",
          sa.Column("id", sa.Integer(), primary_key=True), _org(),
          sa.Column("customer_id", sa.Integer(), _fk("billing_customers.id"), nullable=False),
          sa.Column("role", CIE(AddressRole), nullable=False),
          sa.Column("country_code", sa.String(2), nullable=True),
          sa.Column("subdivision_code", sa.String(6), nullable=True),
          sa.Column("postal_code", sa.String(20), nullable=True),
          sa.Column("city", sa.String(100), nullable=True),
          sa.Column("confidence", CIE(AddressConfidence), nullable=False),
          sa.Column("source", CIE(EvidenceSource), nullable=False),
          sa.Column("source_field", sa.String(50), nullable=True),
          sa.Column("validated_at", TS, nullable=True),
          _by("created_by"), sa.Column("created_at", TS, nullable=False),
          sa.Column("superseded_at", TS, nullable=True),
          indexes=[("ix_customer_tax_addresses_id", ["id"], {}),
                   ("ix_customer_tax_addresses_organization_id", ["organization_id"], {}),
                   ("ix_customer_tax_addresses_customer_id", ["customer_id"], {}),
                   ("uq_customer_tax_addresses_one_current", ["customer_id", "role"],
                    dict(unique=True, postgresql_where=sa.text("superseded_at IS NULL"),
                         sqlite_where=sa.text("superseded_at IS NULL")))])

    table("customer_tax_ids",
          sa.Column("id", sa.Integer(), primary_key=True), _org(),
          sa.Column("customer_id", sa.Integer(), _fk("billing_customers.id"), nullable=False),
          sa.Column("value_raw", sa.String(100), nullable=False),
          sa.Column("value_normalized", sa.String(100), nullable=False),
          sa.Column("id_type", sa.String(50), nullable=True),
          sa.Column("country_code", sa.String(2), nullable=True),
          sa.Column("source", CIE(EvidenceSource), nullable=False),
          sa.Column("source_field", sa.String(50), nullable=True),
          sa.Column("verification_status", CIE(VerificationStatus), nullable=False,
                    server_default=VerificationStatus.UNVERIFIED.name),
          sa.Column("verification_method", sa.String(100), nullable=True),
          sa.Column("verification_response", sa.JSON(), nullable=True),
          sa.Column("verified_at", TS, nullable=True),
          sa.Column("expires_at", TS, nullable=True),
          _by("created_by"), sa.Column("created_at", TS, nullable=False),
          sa.Column("superseded_at", TS, nullable=True),
          indexes=[("ix_customer_tax_ids_id", ["id"], {}),
                   ("ix_customer_tax_ids_organization_id", ["organization_id"], {}),
                   ("ix_customer_tax_ids_customer_id", ["customer_id"], {})])

    table("customer_exemption_certificates",
          sa.Column("id", sa.Integer(), primary_key=True), _org(),
          sa.Column("customer_id", sa.Integer(), _fk("billing_customers.id"), nullable=False),
          sa.Column("certificate_number", sa.String(100), nullable=False),
          sa.Column("jurisdiction_id", sa.Integer(), _fk("tax_jurisdictions.id"), nullable=False),
          sa.Column("tax_type_id", sa.Integer(), _fk("tax_type_definitions.id"), nullable=True),
          sa.Column("scope_description", sa.Text(), nullable=False),
          sa.Column("valid_from", sa.Date(), nullable=False),
          sa.Column("expires_at", sa.Date(), nullable=True),
          sa.Column("evidence_ref", sa.String(500), nullable=False),
          _status(CertificateStatus, CertificateStatus.ACTIVE),
          _by("created_by"), sa.Column("created_at", TS, nullable=False),
          _by("revoked_by"), sa.Column("revoked_at", TS, nullable=True),
          indexes=[("ix_customer_exemption_certificates_id", ["id"], {}),
                   ("ix_customer_exemption_certificates_organization_id", ["organization_id"], {}),
                   ("ix_customer_exemption_certificates_customer_id", ["customer_id"], {})])

    table("tax_review_items",
          sa.Column("id", sa.Integer(), primary_key=True), _org(),
          sa.Column("kind", CIE(ReviewItemKind), nullable=False),
          sa.Column("subject_type", sa.String(50), nullable=False),
          sa.Column("subject_id", sa.Integer(), nullable=False),
          sa.Column("due_date", sa.Date(), nullable=True),
          sa.Column("detail", sa.Text(), nullable=True),
          _status(ReviewItemStatus, ReviewItemStatus.OPEN),
          sa.Column("created_at", TS, nullable=False),
          sa.Column("resolved_at", TS, nullable=True),
          _by("resolved_by"),
          indexes=[("ix_tax_review_items_id", ["id"], {}),
                   ("ix_tax_review_items_organization_id", ["organization_id"], {}),
                   ("ix_tax_review_items_status", ["status"], {}),
                   ("uq_tax_review_items_one_open", ["organization_id", "kind", "subject_type", "subject_id"],
                    dict(unique=True, postgresql_where=sa.text("status = 'OPEN'"),
                         sqlite_where=sa.text("status = 'OPEN'")))])


def _add_quote_columns() -> None:
    if not _has_column("quotations", "seller_entity_id"):
        op.add_column("quotations", sa.Column("seller_entity_id", sa.Integer(), nullable=True))
        if _is_postgres():
            op.create_foreign_key("fk_quotations_seller_entity_id", "quotations", "seller_legal_entities",
                                  ["seller_entity_id"], ["id"], ondelete="RESTRICT")
    if not _has_index("quotations", "ix_quotations_seller_entity_id"):
        op.create_index("ix_quotations_seller_entity_id", "quotations", ["seller_entity_id"])
    if not _has_column("quotations", "tax_context_status"):
        op.add_column("quotations", sa.Column("tax_context_status", CIE(TaxContextStatus), nullable=True))
    if not _has_column("quotations", "tax_classification_version"):
        op.add_column("quotations", sa.Column("tax_classification_version", sa.Integer(), nullable=True))


# Frozen copy of the Phase 2 legacy -> structured evidence mapping.
_TAX_ID_COLUMNS = ("tax_id", "vat_number", "gst_number", "pan", "tin")


def _backfill() -> None:
    from app.modules.auth.country_currency import resolve_country_code

    bind = op.get_bind()
    bind.execute(sa.text(
        "UPDATE quotations SET seller_entity_id = ("
        "  SELECT e.id FROM seller_legal_entities e"
        "  WHERE e.organization_id = quotations.organization_id AND e.is_default = :t"
        ") WHERE seller_entity_id IS NULL"
    ), {"t": True})

    now = datetime.now(timezone.utc)
    customers = bind.execute(sa.text(
        "SELECT id, organization_id, billing_country, shipping_country, tax_id_type, "
        + ", ".join(_TAX_ID_COLUMNS) + " FROM billing_customers"
    )).mappings().all()
    have_address = {(r[0], r[1]) for r in bind.execute(sa.text("SELECT customer_id, role FROM customer_tax_addresses"))}
    have_ids = {(r[0], r[1]) for r in bind.execute(sa.text("SELECT customer_id, value_normalized FROM customer_tax_ids"))}

    addresses, tax_ids = [], []
    for c in customers:
        for field, role in (("billing_country", AddressRole.BILLING), ("shipping_country", AddressRole.SHIPPING)):
            code = resolve_country_code(c[field]) if (c[field] or "").strip() else None
            if code and (c["id"], role.name) not in have_address:
                addresses.append({
                    "organization_id": c["organization_id"], "customer_id": c["id"], "role": role.name,
                    "country_code": code, "confidence": AddressConfidence.DERIVED.name,
                    "source": EvidenceSource.LEGACY_BACKFILL.name, "source_field": field, "created_at": now,
                })
        seen = set()
        for field in _TAX_ID_COLUMNS:
            raw = c[field]
            if raw is None or not str(raw).strip():
                continue
            normalized = re.sub(r"\s+", "", str(raw)).upper()
            if normalized in seen or (c["id"], normalized) in have_ids:
                continue
            seen.add(normalized)
            tax_ids.append({
                "organization_id": c["organization_id"], "customer_id": c["id"], "value_raw": str(raw)[:100],
                "value_normalized": normalized[:100],
                "id_type": c["tax_id_type"] if field == "tax_id" else None,
                "source": EvidenceSource.LEGACY_BACKFILL.name, "source_field": field,
                "verification_status": VerificationStatus.UNVERIFIED.name, "created_at": now,
            })
    if addresses:
        op.bulk_insert(sa.table("customer_tax_addresses", *(sa.column(k) for k in addresses[0])), addresses)
    if tax_ids:
        op.bulk_insert(sa.table("customer_tax_ids", *(sa.column(k) for k in tax_ids[0])), tax_ids)


# ── Postgres guards (frozen copies of policy_models / models DDL) ────────

_EDITABLE = "('PENDING_REVIEW', 'VALIDATION_FAILED', 'VALIDATED')"
_VERSION_GUARDS = {
    "tax_market_availability_versions": ("jurisdiction_id", "tax_type_id", "transaction_class", "mode",
                                         "tenant_config_permitted", "gates", "notes", "created_by_user_id",
                                         "created_at"),
    "tax_code_set_versions": ("code", "version", "notes", "created_by_user_id", "created_at"),
}


def _version_guard_fn(table: str, fields: tuple) -> str:
    new = ", ".join(f"'{f}', NEW.{f}" for f in fields)
    old = ", ".join(f"'{f}', OLD.{f}" for f in fields)
    return f"""
CREATE OR REPLACE FUNCTION {table}_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN {_EDITABLE} THEN
      RAISE EXCEPTION '{table} % is %: only unsubmitted drafts can be deleted', OLD.id, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status NOT IN {_EDITABLE}
     AND jsonb_build_object({new}) IS DISTINCT FROM jsonb_build_object({old}) THEN
    RAISE EXCEPTION '{table} % content is frozen once submitted; create a new version', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'SUPERSEDED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION '{table} % is superseded and immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'ACTIVE' AND (
       (to_jsonb(NEW) - 'status' - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'superseded_at')
       OR NEW.status NOT IN ('ACTIVE', 'SUPERSEDED')
       OR (NEW.status = 'SUPERSEDED' AND NEW.superseded_at IS NULL)) THEN
    RAISE EXCEPTION '{table} % is active: it can only be superseded', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""


_TAX_CODES_GUARD_FN = f"""
CREATE OR REPLACE FUNCTION tax_codes_guard() RETURNS trigger AS $$
DECLARE
  set_status text;
BEGIN
  SELECT status INTO set_status FROM tax_code_set_versions
   WHERE id = (CASE WHEN TG_OP = 'DELETE' THEN OLD.code_set_version_id ELSE NEW.code_set_version_id END);
  IF set_status NOT IN {_EDITABLE} THEN
    RAISE EXCEPTION 'tax codes of a submitted code-set version are frozen'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.code_set_version_id IS DISTINCT FROM OLD.code_set_version_id THEN
    RAISE EXCEPTION 'a tax code cannot move between code-set versions'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql
"""

_TENANT_GUARD_FN = """
CREATE OR REPLACE FUNCTION tax_tenant_record_guard() RETURNS trigger AS $$
DECLARE
  f text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('zoiko.tax_erasure', true), '') <> 'on' THEN
      RAISE EXCEPTION '% rows are retained tax evidence: only the tenant erasure purge may delete them', TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_ARGV[1] = '*' OR (to_jsonb(OLD) ->> 'status') = ANY (string_to_array(TG_ARGV[1], ',')) THEN
    FOREACH f IN ARRAY string_to_array(TG_ARGV[0], ',') LOOP
      IF (to_jsonb(NEW) -> f) IS DISTINCT FROM (to_jsonb(OLD) -> f) THEN
        RAISE EXCEPTION '%.% is frozen on record %; record a new version instead', TG_TABLE_NAME, f, OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""

_TENANT_GUARDS = (
    ("entity_tax_registrations",
     ("organization_id", "seller_entity_id", "jurisdiction_id", "tax_type_id", "registration_number",
      "valid_from", "created_by", "created_at"), "*"),
    ("entity_tax_legal_bases",
     ("organization_id", "seller_entity_id", "jurisdiction_id", "tax_type_id", "legal_basis", "evidence_ref",
      "valid_from", "valid_to", "recorded_by", "approved_by", "approved_at", "predecessor_id", "created_at"),
     "APPROVED,SUPERSEDED,REJECTED"),
    ("entity_tax_activations",
     ("organization_id", "seller_entity_id", "jurisdiction_id", "tax_type_id", "transaction_class", "mode",
      "effective_from", "effective_to", "registration_id", "legal_basis_id", "availability_version_id",
      "tenant_rate_percent", "tenant_source_citation", "tenant_source_url", "proposed_by", "approved_by",
      "approved_at", "predecessor_id", "created_at"),
     "APPROVED,SUPERSEDED,REJECTED"),
    ("product_tax_classifications",
     ("organization_id", "product_id", "tax_code_id", "reason", "proposed_by", "approved_by", "approved_at",
      "classification_version", "predecessor_id", "created_at"),
     "APPROVED,SUPERSEDED,REJECTED"),
    ("customer_tax_addresses",
     ("organization_id", "customer_id", "role", "country_code", "subdivision_code", "postal_code", "city",
      "confidence", "source", "source_field", "validated_at", "created_by", "created_at"), "*"),
    ("customer_tax_ids",
     ("organization_id", "customer_id", "value_raw", "value_normalized", "id_type", "country_code", "source",
      "source_field", "created_by", "created_at"), "*"),
    ("customer_exemption_certificates",
     ("organization_id", "customer_id", "certificate_number", "jurisdiction_id", "tax_type_id",
      "scope_description", "valid_from", "expires_at", "evidence_ref", "created_by", "created_at"), "*"),
)


def _trigger(name: str, table: str, sql: str) -> None:
    if not _pg_has("SELECT 1 FROM pg_trigger WHERE tgname = :n", n=name):
        op.execute(sql)


def _add_postgres_guards() -> None:
    if not _is_postgres():
        return
    for table, fields in _VERSION_GUARDS.items():
        op.execute(_version_guard_fn(table, fields))
        _trigger(f"trg_{table}_guard", table,
                 f"CREATE TRIGGER trg_{table}_guard BEFORE UPDATE OR DELETE ON {table} "
                 f"FOR EACH ROW EXECUTE FUNCTION {table}_guard()")
    op.execute(_TAX_CODES_GUARD_FN)
    _trigger("trg_tax_codes_guard", "tax_codes",
             "CREATE TRIGGER trg_tax_codes_guard BEFORE INSERT OR UPDATE OR DELETE ON tax_codes "
             "FOR EACH ROW EXECUTE FUNCTION tax_codes_guard()")
    op.execute(_TENANT_GUARD_FN)
    for table, fields, frozen in _TENANT_GUARDS:
        _trigger(f"trg_{table}_guard", table,
                 f"CREATE TRIGGER trg_{table}_guard BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW "
                 f"EXECUTE FUNCTION tax_tenant_record_guard('{','.join(fields)}', '{frozen}')")


def upgrade() -> None:
    _create_platform_tables()
    _create_tenant_tables()
    _add_quote_columns()
    _add_postgres_guards()
    _backfill()


def downgrade() -> None:
    if _has_column("quotations", "seller_entity_id"):
        if _is_postgres():
            op.drop_constraint("fk_quotations_seller_entity_id", "quotations", type_="foreignkey")
        if _has_index("quotations", "ix_quotations_seller_entity_id"):
            op.drop_index("ix_quotations_seller_entity_id", table_name="quotations")
    for column in QUOTE_COLUMNS:
        if _has_column("quotations", column):
            op.drop_column("quotations", column)
    # Tenant tables reference the platform ones, so they go first.
    for table in list(reversed(TENANT_TABLES)) + list(reversed(PLATFORM_TABLES)):
        if _has_table(table):
            op.drop_table(table)
    if _is_postgres():
        for fn in ("tax_market_availability_versions_guard", "tax_code_set_versions_guard", "tax_codes_guard",
                   "tax_tenant_record_guard"):
            op.execute(f"DROP FUNCTION IF EXISTS {fn}()")
