"""ZB-TAX-ARCH-001 Phase 5b: evidence documents for registrations and legal
bases

entity_tax_registrations.evidence_file_id and
entity_tax_legal_bases.evidence_file_id reference tax_evidence_files (the
content-addressed, write-once tenant evidence store). Each is attached once:
an ORM guard plus a Postgres trigger refuse changing or clearing it.

Revision ID: c9f1e3a5b7d2
Revises: b8e2d4f6a0c3
Create Date: 2026-11-06
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'c9f1e3a5b7d2'
down_revision: Union[str, Sequence[str], None] = 'b8e2d4f6a0c3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("entity_tax_registrations", "entity_tax_legal_bases")

_WRITE_ONCE = """
CREATE OR REPLACE FUNCTION tax_obligation_evidence_write_once() RETURNS trigger AS $$
BEGIN
  IF OLD.evidence_file_id IS NOT NULL AND NEW.evidence_file_id IS DISTINCT FROM OLD.evidence_file_id THEN
    RAISE EXCEPTION '% % already has its evidence document', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""


def _is_postgres() -> bool:
    return op.get_bind().dialect.name == "postgresql"


def _has_column(t: str, c: str) -> bool:
    insp = sa.inspect(op.get_bind())
    return insp.has_table(t) and c in {x["name"] for x in insp.get_columns(t)}


def upgrade() -> None:
    for table in TABLES:
        if not _has_column(table, "evidence_file_id"):
            if _is_postgres():
                op.add_column(table, sa.Column("evidence_file_id", sa.Integer(),
                                               sa.ForeignKey("tax_evidence_files.id", ondelete="RESTRICT"),
                                               nullable=True))
            else:                                   # SQLite cannot ALTER in a foreign key
                op.add_column(table, sa.Column("evidence_file_id", sa.Integer(), nullable=True))
    if _is_postgres():
        op.execute(_WRITE_ONCE)
        for table in TABLES:
            op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_evidence_write_once ON {table}")
            op.execute(f"CREATE TRIGGER trg_{table}_evidence_write_once BEFORE UPDATE ON {table} FOR EACH ROW "
                       "EXECUTE FUNCTION tax_obligation_evidence_write_once()")


def downgrade() -> None:
    if _is_postgres():
        for table in TABLES:
            op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_evidence_write_once ON {table}")
        op.execute("DROP FUNCTION IF EXISTS tax_obligation_evidence_write_once()")
    for table in TABLES:
        if _has_column(table, "evidence_file_id"):
            op.drop_column(table, "evidence_file_id")
