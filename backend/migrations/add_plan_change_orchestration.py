"""
migrations/add_plan_change_orchestration.py
-----------------------------------------------
Idempotent, additive-only migration for ZB-COM-ENT-001 Part 3:

  - subscription_changes table (§7-§8 upgrade/downgrade orchestration)
  - entitlement_snapshots.snapshot_version column (AC-03)

Fresh databases receive these automatically from Base.metadata.create_all.
This script exists only because create_all does NOT alter existing
databases — see migrations/create_all/README.md.

Safe to run any number of times:
  - only creates the table / adds the column if missing (inspector-driven)
  - never drops anything, never deletes data

Usage:
    python -m migrations.add_plan_change_orchestration            # apply
    python -m migrations.add_plan_change_orchestration --check    # report only

NOT executed automatically and NOT run against Neon here — run it manually
(once approved) from backend/ with BILLING_DATABASE_URL set:
    set BILLING_DATABASE_URL=postgresql://...
    python -m migrations.add_plan_change_orchestration
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect, text  # type: ignore[import]

from app.database import Base, engine

TABLES_TO_CREATE = ["subscription_changes"]

COLUMN_ADDITIONS = {
    "entitlement_snapshots": [
        ("snapshot_version", "INTEGER NOT NULL DEFAULT 0"),
    ],
}


def _tables_to_create() -> list[str]:
    inspector = inspect(engine)
    existing = set(inspector.get_table_names())
    return [t for t in TABLES_TO_CREATE if t not in existing]


def _missing_columns() -> dict[str, list[tuple[str, str]]]:
    inspector = inspect(engine)
    result: dict[str, list[tuple[str, str]]] = {}
    for table_name, columns in COLUMN_ADDITIONS.items():
        if not inspector.has_table(table_name):
            print(f"Table '{table_name}' does not exist — will be created by create_all.")
            continue
        existing = {column["name"] for column in inspector.get_columns(table_name)}
        missing = [(name, ddl) for name, ddl in columns if name not in existing]
        if missing:
            result[table_name] = missing
    return result


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create subscription_changes + add snapshot_version (idempotent, additive).",
    )
    parser.add_argument("--check", action="store_true", help="Only report; do not alter the database.")
    args = parser.parse_args()

    missing_tables = _tables_to_create()
    missing_columns = _missing_columns()

    if args.check:
        if missing_tables:
            print("Tables to create:")
            for t in missing_tables:
                print(f"  {t}")
        if missing_columns:
            print("Missing columns:")
            for table_name, columns in missing_columns.items():
                for name, ddl in columns:
                    print(f"  {table_name}.{name} {ddl}")
        if not missing_tables and not missing_columns:
            print("Plan-change orchestration schema is up to date.")
        return

    if missing_tables:
        from app.database import _skip_existing_enum_types

        _skip_existing_enum_types()
        tables = [Base.metadata.tables[t] for t in missing_tables if t in Base.metadata.tables]
        if tables:
            Base.metadata.create_all(bind=engine, tables=tables, checkfirst=False)
            for t in missing_tables:
                print(f"Created table {t}.")

    total_columns = 0
    if missing_columns:
        with engine.begin() as conn:
            for table_name, columns in missing_columns.items():
                for name, ddl in columns:
                    conn.execute(text(f'ALTER TABLE {table_name} ADD COLUMN "{name}" {ddl}'))
                    print(f"Added {table_name}.{name} {ddl}")
                    total_columns += 1

    if not missing_tables and not total_columns:
        print("Plan-change orchestration schema is up to date.")
    else:
        print(f"Done. {len(missing_tables)} table(s) created, {total_columns} column(s) added.")


if __name__ == "__main__":
    main()
