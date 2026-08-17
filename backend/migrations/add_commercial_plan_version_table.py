"""
migrations/add_commercial_plan_version_table.py
------------------------------------------------
Idempotent, additive-only migration that creates the
`commercial_plan_versions` table on EXISTING databases (PostgreSQL or the dev
SQLite fallback).

Fresh databases receive the table automatically from
Base.metadata.create_all (app/database.py initialize_database, which already
registers app.modules.commercial.models — CommercialPlanVersion). This script
exists only because create_all does NOT alter existing databases — see
migrations/create_all/README.md ("Schema changes").

Run migrations/add_approval_request_table.py FIRST — commercial_plan_versions
has a nullable FK to approval_requests.id.

Safe to run any number of times:
  - only creates the table when it is missing
  - never drops anything, never deletes data, never alters existing tables

Usage:
    python -m migrations.add_commercial_plan_version_table            # apply
    python -m migrations.add_commercial_plan_version_table --check    # report only

NOT executed automatically and NOT run against Neon here — run it manually
(once approved) from backend/ with BILLING_DATABASE_URL set:
    set BILLING_DATABASE_URL=postgresql://...
    python -m migrations.add_commercial_plan_version_table
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect  # type: ignore[import]

from app.database import Base, engine
from app.modules.commercial.models import CommercialPlanVersion  # noqa: F401  (registers table)

TABLE_NAME = "commercial_plan_versions"


def _table_exists() -> bool:
    return inspect(engine).has_table(TABLE_NAME)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add the commercial_plan_versions table (idempotent, additive).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Only report whether the table exists; do not change the database.",
    )
    args = parser.parse_args()

    if args.check:
        print(
            f"Table '{TABLE_NAME}' is {'present' if _table_exists() else 'MISSING'}."
        )
        return

    if not _table_exists():
        Base.metadata.tables[TABLE_NAME].create(bind=engine, checkfirst=True)
        print(f"Created table {TABLE_NAME}.")
    else:
        print(f"Table {TABLE_NAME} already exists.")


if __name__ == "__main__":
    main()
