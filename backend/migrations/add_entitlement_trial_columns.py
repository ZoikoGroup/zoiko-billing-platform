"""
migrations/add_entitlement_trial_columns.py
-------------------------------------------
Idempotent, additive-only migration that adds columns introduced by
ZB-COM-ENT-001 Part 1 (ZB-COM-ENT-001) on EXISTING databases:

  commercial_subscriptions:
    - recovery_ends_at            (TIMESTAMP, nullable)
    - trial_granted_entitlements  (JSON, nullable)

  commercial_evaluation_programs:
    - granted_plan_id             (INTEGER FK → commercial_plans, nullable)

Fresh databases receive these columns automatically from
Base.metadata.create_all. This script exists only because create_all does
NOT alter existing tables — see migrations/create_all/README.md.

Safe to run any number of times:
  - only adds columns that are missing (inspector-driven)
  - never drops anything, never deletes data

CommercialSubscriptionStatus enum expansion (TRIALING, SCHEDULED_CHANGE,
CANCEL_AT_PERIOD_END, ENTERPRISE_PENDING) requires NO migration: the column
is VARCHAR(30) via CaseInsensitiveEnum, so new values are application-level
constants validated in Python — the database stores any string.

Usage:
    python -m migrations.add_entitlement_trial_columns            # apply
    python -m migrations.add_entitlement_trial_columns --check    # report only

NOT executed automatically and NOT run against Neon here — run it manually
(once approved) from backend/ with BILLING_DATABASE_URL set:
    set BILLING_DATABASE_URL=postgresql://...
    python -m migrations.add_entitlement_trial_columns
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect, text  # type: ignore[import]

from app.database import engine

# Table -> [(column_name, DDL)]
COLUMN_ADDITIONS = {
    "commercial_subscriptions": [
        ("recovery_ends_at", "TIMESTAMP"),
        ("trial_granted_entitlements", "JSON"),
    ],
    "commercial_evaluation_programs": [
        ("granted_plan_id", "INTEGER"),
    ],
}


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
        description="Add entitlement/trial columns to existing tables (idempotent, additive).",
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
            for table_name, columns in missing.items():
                for name, ddl in columns:
                    print(f"  {table_name}.{name} {ddl}")
        else:
            print("All entitlement/trial columns present — schema is up to date.")
        return

    if not missing:
        print("All entitlement/trial columns present — schema is up to date.")
        return

    total = 0
    with engine.begin() as conn:
        for table_name, columns in missing.items():
            for name, ddl in columns:
                conn.execute(text(f'ALTER TABLE {table_name} ADD COLUMN "{name}" {ddl}'))
                print(f"Added {table_name}.{name} {ddl}")
                total += 1

    print(f"Done. {total} column(s) added.")


if __name__ == "__main__":
    main()
