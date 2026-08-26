"""
migrations/add_commercial_subscription_evaluation_columns.py
------------------------------------------------------------------
Idempotent, additive-only migration that back-fills the three
CommercialEvaluationProgram-snapshot columns onto the EXISTING
`commercial_subscriptions` table (PostgreSQL or the dev SQLite fallback):
  - evaluation_payment_requirement
  - evaluation_conversion_policy
  - evaluation_expiry_action

Fresh databases receive these columns automatically from
Base.metadata.create_all. This script exists only because create_all does
NOT alter existing tables — see migrations/create_all/README.md
("Schema changes").

Safe to run any number of times:
  - only adds columns that are missing (inspector-driven)
  - never drops anything, never deletes data, never recreates tables
  - all three are nullable: NULL means no CommercialEvaluationProgram ever
    applied to that subscription (the default/expected case for every
    subscription today — no program is seeded)

Usage:
    python -m migrations.add_commercial_subscription_evaluation_columns            # apply
    python -m migrations.add_commercial_subscription_evaluation_columns --check    # report only

NOT executed automatically and NOT run against Neon here — run it manually
(once approved) from backend/ with BILLING_DATABASE_URL set:
    set BILLING_DATABASE_URL=postgresql://...
    python -m migrations.add_commercial_subscription_evaluation_columns
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect, text  # type: ignore[import]

from app.database import engine

TABLE_NAME = "commercial_subscriptions"
NEW_COLUMNS = [
    ("evaluation_payment_requirement", "VARCHAR(30)"),
    ("evaluation_conversion_policy", "VARCHAR(30)"),
    ("evaluation_expiry_action", "VARCHAR(20)"),
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
        description="Add the missing commercial_subscriptions evaluation-program columns (idempotent, additive).",
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
