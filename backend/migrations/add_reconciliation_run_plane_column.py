"""
migrations/add_reconciliation_run_plane_column.py
----------------------------------------------------
Idempotent, additive-only migration that adds the
`reconciliation_runs.plane` column on EXISTING databases (PostgreSQL or the
dev SQLite fallback), and backfills it on existing rows.

Fresh databases receive the column automatically from
Base.metadata.create_all. This script exists only because create_all does
NOT alter existing databases — see migrations/create_all/README.md
("Schema changes").

Why this column exists: Plane 1 (platform/commercial) and Plane 2 (tenant
ledger) reconciliation runs share the same `reconciliation_runs` /
`reconciliation_exceptions` tables. Before this column, nothing distinguished
them, so Super Admin's Plane 2 "Reconciliation" page and the REC-01
launch-readiness check could silently pick up a Plane 1 run (and vice versa
for Plane1BillingPage's Reconciliation tab).

Backfill rule for existing rows: `processor_source = 'platform'` -> 'plane1'
(that value is only ever set by PlatformReconciliationService), everything
else -> 'plane2'.

Safe to run any number of times:
  - only adds the column when it is missing
  - backfill only touches rows where plane IS NULL
  - never drops anything, never deletes data

Usage:
    python -m migrations.add_reconciliation_run_plane_column            # apply
    python -m migrations.add_reconciliation_run_plane_column --check    # report only

NOT executed automatically and NOT run against Neon here — run it manually
(once approved) from backend/ with BILLING_DATABASE_URL set:
    set BILLING_DATABASE_URL=postgresql://...
    python -m migrations.add_reconciliation_run_plane_column
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect, text  # type: ignore[import]

from app.database import engine

TABLE_NAME = "reconciliation_runs"
COLUMN_NAME = "plane"


def _column_exists() -> bool:
    inspector = inspect(engine)
    if not inspector.has_table(TABLE_NAME):
        return False
    return any(col["name"] == COLUMN_NAME for col in inspector.get_columns(TABLE_NAME))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add reconciliation_runs.plane (idempotent, additive) and backfill it.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Only report whether the column exists; do not change the database.",
    )
    args = parser.parse_args()

    if args.check:
        print(
            f"Column '{TABLE_NAME}.{COLUMN_NAME}' is "
            f"{'present' if _column_exists() else 'MISSING'}."
        )
        return

    if _column_exists():
        print(f"Column {TABLE_NAME}.{COLUMN_NAME} already exists.")
        return

    with engine.begin() as conn:
        conn.execute(
            text(f"ALTER TABLE {TABLE_NAME} ADD COLUMN {COLUMN_NAME} VARCHAR(10)")
        )
        conn.execute(
            text(
                f"UPDATE {TABLE_NAME} SET {COLUMN_NAME} = 'plane1' "
                f"WHERE processor_source = 'platform' AND {COLUMN_NAME} IS NULL"
            )
        )
        conn.execute(
            text(
                f"UPDATE {TABLE_NAME} SET {COLUMN_NAME} = 'plane2' "
                f"WHERE {COLUMN_NAME} IS NULL"
            )
        )
        if engine.dialect.name != "sqlite":
            conn.execute(
                text(f"ALTER TABLE {TABLE_NAME} ALTER COLUMN {COLUMN_NAME} SET NOT NULL")
            )
    print(f"Added column {TABLE_NAME}.{COLUMN_NAME} and backfilled existing rows.")


if __name__ == "__main__":
    main()
