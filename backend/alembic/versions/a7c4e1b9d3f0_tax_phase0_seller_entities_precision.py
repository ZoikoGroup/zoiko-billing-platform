"""ZB-TAX-ARCH-001 Phase 0: seller legal entities, invoice tax context, rate precision

  1. seller_legal_entities: the issuing legal entity that owns tax
     registrations/obligations (§02, §07). One default per organization,
     enforced by a partial unique index.
  2. invoices.seller_entity_id + invoices.tax_date (§08.1 steps 1-2).
  3. Backfill: one default entity per existing organization from its
     profile; every existing invoice is attributed to it; every already-
     issued invoice gets tax_date = issue_date (the tax point the pre-
     framework code implicitly used).
  4. Widen every tax rate / tax percentage column from NUMERIC(5,2) to
     NUMERIC(9,6) so real rates such as 8.875% are representable (§07:
     decimal fixed-point at legal precision). Widening is lossless.

Downgrade note: narrowing back to NUMERIC(5,2) ROUNDS any rate stored with
more than two decimals. Export affected rows before downgrading in any
environment that has recorded such rates.

Revision ID: a7c4e1b9d3f0
Revises: f7c3a9e2d5b1
Create Date: 2026-11-04
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

import app.core.db_types
from app.modules.tax.enums import EntityTaxRegime

revision: str = 'a7c4e1b9d3f0'
down_revision: Union[str, Sequence[str], None] = 'f7c3a9e2d5b1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


WIDENED_COLUMNS = (
    # (table, column, nullable)
    ("products", "tax_percentage", True),
    ("tax_pricing", "rate", False),
    ("contract_items", "tax_percentage", True),
    ("quotation_items", "tax_percentage", True),
    ("subscriptions", "tax_percentage", True),
    ("invoice_items", "tax_percentage", True),
    ("tax_rates", "rate", False),
    ("taxes", "tax_percentage", False),
)


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


def _create_entities_table() -> None:
    if _has_table("seller_legal_entities"):
        return
    op.create_table(
        "seller_legal_entities",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("organization_id", sa.Integer(), sa.ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("entity_code", sa.String(50), nullable=False),
        sa.Column("legal_name", sa.String(255), nullable=False),
        sa.Column("display_name", sa.String(255), nullable=True),
        sa.Column("country_code", sa.String(2), nullable=True),
        sa.Column("subdivision_code", sa.String(6), nullable=True),
        sa.Column("address_line1", sa.String(255), nullable=True),
        sa.Column("address_line2", sa.String(255), nullable=True),
        sa.Column("city", sa.String(100), nullable=True),
        sa.Column("postal_code", sa.String(20), nullable=True),
        sa.Column("timezone", sa.String(100), nullable=True),
        sa.Column("primary_tax_id", sa.String(100), nullable=True),
        sa.Column("primary_tax_id_type", sa.String(50), nullable=True),
        sa.Column("registration_number", sa.String(100), nullable=True),
        sa.Column("is_merchant_of_record", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column(
            "tax_regime", app.core.db_types.CaseInsensitiveEnum(EntityTaxRegime),
            nullable=False, server_default=EntityTaxRegime.LEGACY_MANUAL.name,
        ),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.UniqueConstraint("organization_id", "entity_code", name="uq_seller_legal_entities_org_code"),
    )
    op.create_index("ix_seller_legal_entities_id", "seller_legal_entities", ["id"])
    op.create_index("ix_seller_legal_entities_organization_id", "seller_legal_entities", ["organization_id"])
    op.create_index("ix_seller_legal_entities_country_code", "seller_legal_entities", ["country_code"])
    op.create_index(
        "uq_seller_legal_entities_one_default", "seller_legal_entities", ["organization_id"], unique=True,
        postgresql_where=sa.text("is_default = true"), sqlite_where=sa.text("is_default = 1"),
    )


def _add_invoice_columns() -> None:
    if not _has_column("invoices", "seller_entity_id"):
        op.add_column("invoices", sa.Column("seller_entity_id", sa.Integer(), nullable=True))
        if _is_postgres():
            op.create_foreign_key(
                "fk_invoices_seller_entity_id", "invoices", "seller_legal_entities",
                ["seller_entity_id"], ["id"], ondelete="RESTRICT",
            )
    if not _has_index("invoices", "ix_invoices_seller_entity_id"):
        op.create_index("ix_invoices_seller_entity_id", "invoices", ["seller_entity_id"])
    if not _has_column("invoices", "tax_date"):
        op.add_column("invoices", sa.Column("tax_date", sa.Date(), nullable=True))
    if not _has_index("invoices", "ix_invoices_tax_date"):
        op.create_index("ix_invoices_tax_date", "invoices", ["tax_date"])


def _backfill() -> None:
    """Frozen copy of the default-entity mapping as of Phase 0, so this
    migration's behaviour never drifts with later service changes."""
    from app.modules.auth.country_currency import resolve_country_code
    from app.modules.billing.utils.country_tax_profiles import get_country_tax_profile

    bind = op.get_bind()
    orgs = bind.execute(sa.text(
        "SELECT id, organization_name, legal_name, display_name, country, address, city, "
        "postal_code, timezone, tax_no, registration_number FROM organizations"
    )).mappings().all()
    has_default = {
        r[0] for r in bind.execute(sa.text(
            "SELECT organization_id FROM seller_legal_entities WHERE is_default = :t"
        ), {"t": True})
    }
    entities = sa.table(
        "seller_legal_entities",
        *(sa.column(c) for c in (
            "organization_id", "entity_code", "legal_name", "display_name", "country_code",
            "address_line1", "city", "postal_code", "timezone", "primary_tax_id",
            "primary_tax_id_type", "registration_number", "is_merchant_of_record",
            "tax_regime", "is_default", "is_active", "version",
        )),
    )
    rows = []
    for org in orgs:
        if org["id"] in has_default:
            continue
        country_code = resolve_country_code(org["country"])
        profile = get_country_tax_profile(country_code) if country_code else None
        tax_id = (org["tax_no"] or "").strip() or None
        rows.append({
            "organization_id": org["id"],
            "entity_code": "PRIMARY",
            "legal_name": (org["legal_name"] or org["organization_name"] or "Primary entity").strip(),
            "display_name": org["display_name"] or org["organization_name"],
            "country_code": country_code,
            "address_line1": org["address"],
            "city": org["city"],
            "postal_code": org["postal_code"],
            "timezone": org["timezone"],
            "primary_tax_id": tax_id,
            "primary_tax_id_type": profile.tax_id_label if (profile and tax_id) else None,
            "registration_number": org["registration_number"],
            "is_merchant_of_record": True,
            "tax_regime": EntityTaxRegime.LEGACY_MANUAL.name,
            "is_default": True,
            "is_active": True,
            "version": 1,
        })
    if rows:
        op.bulk_insert(entities, rows)

    bind.execute(sa.text(
        "UPDATE invoices SET seller_entity_id = ("
        "  SELECT e.id FROM seller_legal_entities e"
        "  WHERE e.organization_id = invoices.organization_id AND e.is_default = :t"
        ") WHERE seller_entity_id IS NULL"
    ), {"t": True})
    # Already-issued invoices: record the tax point the legacy code assumed.
    bind.execute(sa.text(
        "UPDATE invoices SET tax_date = issue_date "
        "WHERE tax_date IS NULL AND UPPER(status) <> 'DRAFT'"
    ))


def _set_precision(precision: int, scale: int, from_precision: int, from_scale: int) -> None:
    # SQLite does not enforce NUMERIC precision, and ALTER COLUMN TYPE would
    # force a table rebuild there; the dev/test SQLite schema comes from
    # create_all with the new model types instead.
    if not _is_postgres():
        return
    for table, column, nullable in WIDENED_COLUMNS:
        if _has_column(table, column):
            op.alter_column(
                table, column,
                type_=sa.Numeric(precision, scale),
                existing_type=sa.Numeric(from_precision, from_scale),
                existing_nullable=nullable,
            )


def upgrade() -> None:
    _create_entities_table()
    _add_invoice_columns()
    _backfill()
    _set_precision(9, 6, 5, 2)


def downgrade() -> None:
    _set_precision(5, 2, 9, 6)
    if _has_index("invoices", "ix_invoices_tax_date"):
        op.drop_index("ix_invoices_tax_date", table_name="invoices")
    if _has_column("invoices", "tax_date"):
        op.drop_column("invoices", "tax_date")
    if _has_index("invoices", "ix_invoices_seller_entity_id"):
        op.drop_index("ix_invoices_seller_entity_id", table_name="invoices")
    if _has_column("invoices", "seller_entity_id"):
        if _is_postgres():
            op.drop_constraint("fk_invoices_seller_entity_id", "invoices", type_="foreignkey")
        op.drop_column("invoices", "seller_entity_id")
    if _has_table("seller_legal_entities"):
        op.drop_table("seller_legal_entities")
