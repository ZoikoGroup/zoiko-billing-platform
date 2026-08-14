"""
migrations/add_organization_columns.py
--------------------------------------
Idempotent, additive-only migration that back-fills the PHASE 1 Organization
columns onto EXISTING databases (PostgreSQL or the dev SQLite fallback).

Fresh databases receive these columns automatically from
Base.metadata.create_all (app/database.py initialize_database). This script
exists only because create_all does NOT alter existing tables — see
migrations/create_all/README.md ("Schema changes").

The columns below are copied verbatim from
app/modules/organizations/models.py. CaseInsensitiveEnum stores the enum NAME,
so billing_classification / billing_source use the NAME as their default.

Safe to run any number of times:
  - only columns that are missing are added (inspector-driven)
  - never drops anything, never deletes data, never recreates tables
  - existing rows are back-filled with each column's DEFAULT

Usage:
    python -m migrations.add_organization_columns            # apply missing columns
    python -m migrations.add_organization_columns --check    # report only, no changes

NOT executed automatically and NOT run against Neon here — run it manually
(once approved) from backend/ with BILLING_DATABASE_URL set:
    set BILLING_DATABASE_URL=postgresql://...
    python -m migrations.add_organization_columns
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect, text  # type: ignore[import]

from app.database import engine

NEW_COLUMNS = [
    ("city", "VARCHAR(100)"),
    ("state", "VARCHAR(100)"),
    ("country", "VARCHAR(100)"),
    ("postal_code", "VARCHAR(20)"),
    ("website", "VARCHAR(500)"),
    ("legal_name", "VARCHAR(255)"),
    ("fiscal_year_start", "VARCHAR(5) NOT NULL DEFAULT '01-01'"),
    ("fiscal_year_end", "VARCHAR(5) NOT NULL DEFAULT '12-31'"),
    ("billing_classification", "VARCHAR NOT NULL DEFAULT 'COMMERCIAL_STANDALONE'"),
    ("billing_source", "VARCHAR NOT NULL DEFAULT 'REGISTERED_VIA_STANDALONE'"),
]


def _missing_columns() -> list:
    inspector = inspect(engine)
    if not inspector.has_table("organizations"):
        print("Table 'organizations' does not exist — nothing to migrate.")
        return []
    existing = {column["name"] for column in inspector.get_columns("organizations")}
    return [(name, ddl) for name, ddl in NEW_COLUMNS if name not in existing]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add missing PHASE 1 organizations columns (idempotent, additive).",
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
                print(f"  organizations.{name} {ddl}")
        else:
            print("No missing columns — organizations schema is up to date.")
        return

    if not missing:
        print("No missing columns — organizations schema is up to date.")
        return

    with engine.begin() as conn:
        for name, ddl in missing:
            conn.execute(text(f'ALTER TABLE organizations ADD COLUMN "{name}" {ddl}'))
            print(f"Added organizations.{name} {ddl}")

    print(f"Done. {len(missing)} column(s) added.")


if __name__ == "__main__":
    main()
