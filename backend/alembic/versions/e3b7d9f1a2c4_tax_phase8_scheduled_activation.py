"""ZB-TAX-ARCH-001 Phase 8 PR 2: scheduled activation

  1. tax_rule_pack_versions.valid_from / valid_to: effective-dated packs
     (the quote's tax date picks the version, like rates). valid_from is
     frozen content; valid_to is set once, on the predecessor, when its
     successor activates. The one-ACTIVE-per-code index is replaced by a
     no-overlap exclusion over (code, daterange) for ACTIVE rows.
  2. Both tax_rule_pack_versions and tax_market_availability_versions get
     activate_at (UTC), activate_at_local, activate_tz, activation_error and
     scheduled_by_user_id; status SCHEDULED is a text value (no enum change).
  3. tax_activation_cancellations: two-person cancellation requests, frozen
     once decided.

Postgres-only DDL (frozen copies): the rule-pack version guard is recreated
(valid_from content; valid_to settable once on ACTIVE), the exclusion
constraint and the cancellation guard.

Revision ID: e3b7d9f1a2c4
Revises: d2a6c8e4f1b7
Create Date: 2026-11-10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'e3b7d9f1a2c4'
down_revision: Union[str, Sequence[str], None] = 'd2a6c8e4f1b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TS = sa.DateTime(timezone=True)
SCHEDULED_TABLES = ("tax_rule_pack_versions", "tax_market_availability_versions")

_PACK_FIELDS_8_1 = ("code", "version", "markets", "rounding_rule", "rounding_mode", "required_facts", "coverage",
                    "source_dependencies", "golden_test_report", "notes", "created_by_user_id", "created_at",
                    "code_hash")
_PACK_FIELDS_8_2 = _PACK_FIELDS_8_1 + ("valid_from",)
_EDITABLE = "('PENDING_REVIEW', 'VALIDATION_FAILED', 'VALIDATED')"


def _rule_pack_guard_fn(fields: tuple, set_once: tuple = ()) -> str:
    new = ", ".join(f"'{f}', NEW.{f}" for f in fields)
    old = ", ".join(f"'{f}', OLD.{f}" for f in fields)
    minus = "".join(f" - '{f}'" for f in ("status", "superseded_at") + set_once)
    once = "".join(f"\n       OR (OLD.{f} IS NOT NULL AND NEW.{f} IS DISTINCT FROM OLD.{f})" for f in set_once)
    return f"""
CREATE OR REPLACE FUNCTION tax_rule_pack_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status NOT IN {_EDITABLE} THEN
      RAISE EXCEPTION 'tax_rule_pack_versions % is %: only unsubmitted drafts can be deleted', OLD.id, OLD.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status NOT IN {_EDITABLE}
     AND jsonb_build_object({new}) IS DISTINCT FROM jsonb_build_object({old}) THEN
    RAISE EXCEPTION 'tax_rule_pack_versions % content is frozen once submitted; create a new version', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'SUPERSEDED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'tax_rule_pack_versions % is superseded and immutable', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'ACTIVE' AND (
       (to_jsonb(NEW){minus}) IS DISTINCT FROM (to_jsonb(OLD){minus}){once}
       OR NEW.status NOT IN ('ACTIVE', 'SUPERSEDED')
       OR (NEW.status = 'SUPERSEDED' AND NEW.superseded_at IS NULL)) THEN
    RAISE EXCEPTION 'tax_rule_pack_versions % is active: it can only be superseded', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""


CANCELLATION_GUARD = """
CREATE OR REPLACE FUNCTION tax_activation_cancellations_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax_activation_cancellations % cannot be deleted', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'PROPOSED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'tax_activation_cancellations % is decided and final', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'decision_reason') THEN
    RAISE EXCEPTION 'tax_activation_cancellations % request content is frozen', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""


def _cols(table: str) -> set:
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(table)}


def _has(table: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(table)


def _pg() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def upgrade() -> None:
    cols = _cols("tax_rule_pack_versions")
    for name in ("valid_from", "valid_to"):
        if name not in cols:
            op.add_column("tax_rule_pack_versions", sa.Column(name, sa.Date(), nullable=True))
    for table in SCHEDULED_TABLES:
        cols = _cols(table)
        if "activate_at" not in cols:
            op.add_column(table, sa.Column("activate_at", TS, nullable=True))
            op.create_index(f"ix_{table}_activate_at", table, ["activate_at"])
        if "activate_at_local" not in cols:
            op.add_column(table, sa.Column("activate_at_local", sa.String(40), nullable=True))
        if "activate_tz" not in cols:
            op.add_column(table, sa.Column("activate_tz", sa.String(64), nullable=True))
        if "activation_error" not in cols:
            op.add_column(table, sa.Column("activation_error", sa.Text(), nullable=True))
        if "scheduled_by_user_id" not in cols:
            op.add_column(table, sa.Column(
                "scheduled_by_user_id", sa.Integer(),
                sa.ForeignKey("users.id", name=f"fk_{table}_scheduled_by", ondelete="SET NULL"), nullable=True))

    if not _has("tax_activation_cancellations"):
        op.create_table(
            "tax_activation_cancellations",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("version_kind", sa.String(30), nullable=False),
            sa.Column("version_id", sa.Integer(), nullable=False),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column("status", sa.String(20), nullable=False),
            sa.Column("proposed_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("decided_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("decided_at", TS, nullable=True),
            sa.Column("decision_reason", sa.Text(), nullable=True),
            sa.Column("created_at", TS, nullable=False),
        )
        for col in ("id", "version_id", "status"):
            op.create_index(f"ix_tax_activation_cancellations_{col}", "tax_activation_cancellations", [col])

    if _pg():
        op.execute("DROP INDEX IF EXISTS uq_tax_rule_pack_one_active")
        op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")
        op.execute("ALTER TABLE tax_rule_pack_versions DROP CONSTRAINT IF EXISTS ex_tax_rule_pack_active_ranges")
        op.execute("ALTER TABLE tax_rule_pack_versions ADD CONSTRAINT ex_tax_rule_pack_active_ranges "
                   "EXCLUDE USING gist (code WITH =, daterange(valid_from, valid_to, '[)') WITH &&) "
                   "WHERE (status = 'ACTIVE') DEFERRABLE INITIALLY DEFERRED")
        op.execute(_rule_pack_guard_fn(_PACK_FIELDS_8_2, ("valid_to",)))
        op.execute(CANCELLATION_GUARD)
        op.execute("DROP TRIGGER IF EXISTS trg_tax_activation_cancellations_guard ON tax_activation_cancellations")
        op.execute("CREATE TRIGGER trg_tax_activation_cancellations_guard BEFORE UPDATE OR DELETE ON "
                   "tax_activation_cancellations FOR EACH ROW EXECUTE FUNCTION tax_activation_cancellations_guard()")
    else:
        op.execute("DROP INDEX IF EXISTS uq_tax_rule_pack_one_active")


def downgrade() -> None:
    if _pg():
        op.execute("ALTER TABLE tax_rule_pack_versions DROP CONSTRAINT IF EXISTS ex_tax_rule_pack_active_ranges")
        op.execute(_rule_pack_guard_fn(_PACK_FIELDS_8_1))
    if _has("tax_activation_cancellations"):
        op.drop_table("tax_activation_cancellations")
    for table in SCHEDULED_TABLES:
        cols = _cols(table)
        if "activate_at" in cols:
            op.drop_index(f"ix_{table}_activate_at", table_name=table)
        for name in ("scheduled_by_user_id", "activation_error", "activate_tz", "activate_at_local", "activate_at"):
            if name in _cols(table):
                op.drop_column(table, name)
    for name in ("valid_to", "valid_from"):
        if name in _cols("tax_rule_pack_versions"):
            op.drop_column("tax_rule_pack_versions", name)
    # Restores the one-ACTIVE-per-code rule; fails if several versions of a
    # pack are ACTIVE (supersede them first).
    op.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_rule_pack_one_active ON tax_rule_pack_versions (code) "
               "WHERE status = 'ACTIVE'")
