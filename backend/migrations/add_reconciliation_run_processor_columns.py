"""
migrations/add_reconciliation_run_processor_columns.py
--------------------------------------------------------
Idempotent, additive-only migration that adds the ISS-017
`reconciliation_runs.processor_environment` and
`reconciliation_runs.processor_stats` columns on EXISTING databases
(PostgreSQL or the dev SQLite fallback).

Fresh databases receive both columns automatically from
Base.metadata.create_all. This script exists only because create_all does
NOT alter existing databases — see migrations/create_all/README.md
("Schema changes"). Without it, any database created before ISS-017 (the
Stripe processor-comparison feature) landed has a `reconciliation_runs`
table missing these two columns, and EVERY reconciliation-run read/write —
not just the processor-comparison path — fails with
`UndefinedColumn: reconciliation_runs.processor_environment does not exist`,
because the ORM model always selects the full row.

Safe to run any number of times: only adds a column when it is missing,
never drops anything, never deletes data. Both new columns are nullable
with no backfill needed — NULL means "no processor comparison was
requested/possible for this run", which is the correct historical meaning
for every pre-existing row.

Usage:
    python -m migrations.add_reconciliation_run_processor_columns            # apply
    python -m migrations.add_reconciliation_run_processor_columns --check    # report only
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect, text  # type: ignore[import]

from app.database import engine

TABLE_NAME = "reconciliation_runs"
COLUMNS = {
    "processor_environment": "VARCHAR(10)",
    "processor_stats": "JSON",
}


def _existing_columns() -> set[str]:
    inspector = inspect(engine)
    if not inspector.has_table(TABLE_NAME):
        return set()
    return {col["name"] for col in inspector.get_columns(TABLE_NAME)}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add reconciliation_runs.processor_environment / processor_stats (idempotent, additive).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Only report which columns are missing; do not change the database.",
    )
    args = parser.parse_args()

    existing = _existing_columns()
    missing = [name for name in COLUMNS if name not in existing]

    if args.check:
        if not existing:
            print(f"Table '{TABLE_NAME}' does not exist yet.")
        elif not missing:
            print(f"All processor columns already present on {TABLE_NAME}.")
        else:
            print(f"Missing column(s) on {TABLE_NAME}: {missing}")
        return

    if not missing:
        print(f"All processor columns already present on {TABLE_NAME}.")
        return

    json_type = "JSONB" if engine.dialect.name == "postgresql" else "JSON"
    with engine.begin() as conn:
        for name in missing:
            col_type = json_type if COLUMNS[name] == "JSON" else COLUMNS[name]
            conn.execute(text(f"ALTER TABLE {TABLE_NAME} ADD COLUMN {name} {col_type}"))
            print(f"Added column {TABLE_NAME}.{name} ({col_type}).")


if __name__ == "__main__":
    main()
