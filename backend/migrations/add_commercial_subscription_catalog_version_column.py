"""
migrations/add_commercial_subscription_catalog_version_column.py
--------------------------------------------------------------------
Idempotent, additive-only migration that back-fills the
`catalog_version_id` column onto the EXISTING `commercial_subscriptions`
table (PostgreSQL or the dev SQLite fallback).

Fresh databases receive this column automatically from
Base.metadata.create_all. This script exists only because create_all does
NOT alter existing tables — see migrations/create_all/README.md
("Schema changes").

Run migrations/add_commercial_plan_version_table.py FIRST — this column is a
nullable FK to commercial_plan_versions.id.

Safe to run any number of times:
  - only adds the column if missing (inspector-driven)
  - never drops anything, never deletes data, never recreates tables
  - column is nullable: existing subscriptions predate catalog versioning
    and simply leave it NULL (they keep referencing commercial_plan_id only)

Usage:
    python -m migrations.add_commercial_subscription_catalog_version_column            # apply
    python -m migrations.add_commercial_subscription_catalog_version_column --check    # report only

NOT executed automatically and NOT run against Neon here — run it manually
(once approved) from backend/ with BILLING_DATABASE_URL set:
    set BILLING_DATABASE_URL=postgresql://...
    python -m migrations.add_commercial_subscription_catalog_version_column
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect, text  # type: ignore[import]

from app.database import engine

TABLE_NAME = "commercial_subscriptions"
NEW_COLUMNS = [
    ("catalog_version_id", "INTEGER"),
]


def _missing_columns() -> list:
    inspector = inspect(engine)
    if not inspector.has_table(TABLE_NAME):
        print(f"Table '{TABLE_NAME}' does not exist — nothing to migrate.")
        return []
    existing = {column["name"] for column in inspector.get_columns(TABLE_NAME)}
    return [(name, ddl) for name, ddl in NEW_COLUMNS if name not in existing]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add the missing commercial_subscriptions.catalog_version_id column (idempotent, additive).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Only report missing columns; do not alter the database.",
    )
    args = parser.parse_args()

    missing = _missing_columns()

    if args.check:
        if missing:
            print("Missing columns:")
            for name, ddl in missing:
                print(f"  {TABLE_NAME}.{name} {ddl}")
        else:
            print(f"No missing columns — {TABLE_NAME} schema is up to date.")
        return

    if not missing:
        print(f"No missing columns — {TABLE_NAME} schema is up to date.")
        return

    with engine.begin() as conn:
        for name, ddl in missing:
            conn.execute(text(f'ALTER TABLE {TABLE_NAME} ADD COLUMN "{name}" {ddl}'))
            print(f"Added {TABLE_NAME}.{name} {ddl}")

    print(f"Done. {len(missing)} column(s) added.")


if __name__ == "__main__":
    main()
