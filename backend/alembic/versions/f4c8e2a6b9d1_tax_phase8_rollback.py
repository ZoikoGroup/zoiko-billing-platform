"""ZB-TAX-ARCH-001 Phase 8 PR 3: emergency rollback

  1. tax_rule_pack_versions: code_version (a rollback version runs the code
     of the version it restores), restores_id, rollback_of_id; frozen content.
  2. tax_market_availability_versions: restores_id, rollback_of_id; frozen.
  3. Status ROLLED_BACK (text, no enum change): only an ACTIVE version may
     become it, and it is then immutable, like SUPERSEDED.
  4. tax_rollback_requests: two-person rollback requests (one open per
     version), frozen once decided; result is the input for PR 4.

Postgres-only DDL (frozen copies): the rule-pack and availability version
guards are recreated; the rollback request guard is created.

Revision ID: f4c8e2a6b9d1
Revises: e3b7d9f1a2c4
Create Date: 2026-11-10
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'f4c8e2a6b9d1'
down_revision: Union[str, Sequence[str], None] = 'e3b7d9f1a2c4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TS = sa.DateTime(timezone=True)
PACKS, AVAIL = "tax_rule_pack_versions", "tax_market_availability_versions"

_PACK_FIELDS_8_2 = ("code", "version", "markets", "rounding_rule", "rounding_mode", "required_facts", "coverage",
                    "source_dependencies", "golden_test_report", "notes", "created_by_user_id", "created_at",
                    "code_hash", "valid_from")
_PACK_FIELDS_8_3 = _PACK_FIELDS_8_2 + ("code_version", "restores_id", "rollback_of_id")
_AVAIL_FIELDS_2 = ("jurisdiction_id", "tax_type_id", "transaction_class", "mode", "tenant_config_permitted", "gates",
                   "notes", "created_by_user_id", "created_at")
_AVAIL_FIELDS_8_3 = _AVAIL_FIELDS_2 + ("restores_id", "rollback_of_id")
_EDITABLE = "('PENDING_REVIEW', 'VALIDATION_FAILED', 'VALIDATED')"


def _guard_fn(table: str, fields: tuple, set_once: tuple = (), rolled_back: bool = True) -> str:
    new = ", ".join(f"'{f}', NEW.{f}" for f in fields)
    old = ", ".join(f"'{f}', OLD.{f}" for f in fields)
    minus = "".join(f" - '{f}'" for f in ("status", "superseded_at") + set_once)
    once = "".join(f"\n       OR (OLD.{f} IS NOT NULL AND NEW.{f} IS DISTINCT FROM OLD.{f})" for f in set_once)
    final = "('SUPERSEDED', 'ROLLED_BACK')" if rolled_back else "('SUPERSEDED')"
    targets = "('ACTIVE', 'SUPERSEDED', 'ROLLED_BACK')" if rolled_back else "('ACTIVE', 'SUPERSEDED')"
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
  IF OLD.status IN {final} AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION '{table} % is % and immutable', OLD.id, lower(OLD.status)
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'ACTIVE' AND (
       (to_jsonb(NEW){minus}) IS DISTINCT FROM (to_jsonb(OLD){minus}){once}
       OR NEW.status NOT IN {targets}
       OR (NEW.status IN {final} AND NEW.superseded_at IS NULL)) THEN
    RAISE EXCEPTION '{table} % is active: it can only be superseded or rolled back', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""


REQUEST_GUARD = """
CREATE OR REPLACE FUNCTION tax_rollback_requests_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tax_rollback_requests % cannot be deleted', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status <> 'PROPOSED' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'tax_rollback_requests % is decided and final', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'decided_by' - 'decided_at' - 'decision_reason' - 'result' - 'regression')
     IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'decided_by' - 'decided_at' - 'decision_reason' - 'result'
                       - 'regression') THEN
    RAISE EXCEPTION 'tax_rollback_requests % request content is frozen', OLD.id
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


def _self_fk(table: str, name: str):
    return sa.Column(name, sa.Integer(), sa.ForeignKey(f"{table}.id", name=f"fk_{table[:20]}_{name}",
                                                       ondelete="RESTRICT"), nullable=True)


def upgrade() -> None:
    if "code_version" not in _cols(PACKS):
        op.add_column(PACKS, sa.Column("code_version", sa.String(30), nullable=True))
    for table in (PACKS, AVAIL):
        for name in ("restores_id", "rollback_of_id"):
            if name not in _cols(table):
                op.add_column(table, _self_fk(table, name))

    if not _has("tax_rollback_requests"):
        op.create_table(
            "tax_rollback_requests",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("kind", sa.String(30), nullable=False),
            sa.Column("version_id", sa.Integer(), nullable=False),
            sa.Column("restore_to_id", sa.Integer(), nullable=True),
            sa.Column("reason", sa.Text(), nullable=False),
            sa.Column("severity", sa.String(10), nullable=False),
            sa.Column("cancel_schedule", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("timezone", sa.String(64), nullable=True),
            sa.Column("regression", sa.JSON(), nullable=True),
            sa.Column("status", sa.String(20), nullable=False),
            sa.Column("proposed_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("decided_by", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("decided_at", TS, nullable=True),
            sa.Column("decision_reason", sa.Text(), nullable=True),
            sa.Column("result", sa.JSON(), nullable=True),
            sa.Column("created_at", TS, nullable=False),
        )
        for col in ("id", "version_id", "status"):
            op.create_index(f"ix_tax_rollback_requests_{col}", "tax_rollback_requests", [col])
        op.create_index("uq_tax_rollback_one_open", "tax_rollback_requests", ["kind", "version_id"], unique=True,
                        postgresql_where=sa.text("status = 'PROPOSED'"), sqlite_where=sa.text("status = 'PROPOSED'"))

    if _pg():
        op.execute(_guard_fn(PACKS, _PACK_FIELDS_8_3, ("valid_to",)))
        op.execute(_guard_fn(AVAIL, _AVAIL_FIELDS_8_3))
        op.execute(REQUEST_GUARD)
        op.execute("DROP TRIGGER IF EXISTS trg_tax_rollback_requests_guard ON tax_rollback_requests")
        op.execute("CREATE TRIGGER trg_tax_rollback_requests_guard BEFORE UPDATE OR DELETE ON tax_rollback_requests "
                   "FOR EACH ROW EXECUTE FUNCTION tax_rollback_requests_guard()")


def downgrade() -> None:
    if _pg():
        op.execute(_guard_fn(PACKS, _PACK_FIELDS_8_2, ("valid_to",), rolled_back=False))
        op.execute(_guard_fn(AVAIL, _AVAIL_FIELDS_2, rolled_back=False))
    if _has("tax_rollback_requests"):
        op.drop_table("tax_rollback_requests")
    for table in (AVAIL, PACKS):
        for name in ("rollback_of_id", "restores_id"):
            if name in _cols(table):
                op.drop_column(table, name)
    if "code_version" in _cols(PACKS):
        op.drop_column(PACKS, "code_version")
