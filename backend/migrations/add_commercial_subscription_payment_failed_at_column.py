"""
migrations/add_commercial_subscription_payment_failed_at_column.py
----------------------------------------------------------------------
Idempotent, additive-only migration that adds the
`commercial_subscriptions.payment_failed_at` column on EXISTING databases
(PostgreSQL or the dev SQLite fallback). Drives the N1 Plane-1 failed-payment
sweep (see commercial/dunning_service.py::CommercialDunningService).

Fresh databases receive the column automatically from
Base.metadata.create_all (app/database.py initialize_database). This script
exists only because create_all does NOT alter existing databases — see
migrations/create_all/README.md ("Schema changes").

Safe to run any number of times:
  - only adds the column when it is missing
  - never drops anything, never deletes data, never alters existing columns

Usage:
    python -m migrations.add_commercial_subscription_payment_failed_at_column            # apply
    python -m migrations.add_commercial_subscription_payment_failed_at_column --check    # report only

NOT executed automatically and NOT run against Neon here — run it manually
(once approved) from backend/ with BILLING_DATABASE_URL set:
    set BILLING_DATABASE_URL=postgresql://...
    python -m migrations.add_commercial_subscription_payment_failed_at_column
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect, text  # type: ignore[import]

from app.database import engine

TABLE_NAME = "commercial_subscriptions"
COLUMN_NAME = "payment_failed_at"


def _column_exists() -> bool:
    inspector = inspect(engine)
    if not inspector.has_table(TABLE_NAME):
        return False
    return any(col["name"] == COLUMN_NAME for col in inspector.get_columns(TABLE_NAME))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add commercial_subscriptions.payment_failed_at (idempotent, additive).",
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
        conn.execute(text(f"ALTER TABLE {TABLE_NAME} ADD COLUMN {COLUMN_NAME} TIMESTAMP"))
    print(f"Added column {TABLE_NAME}.{COLUMN_NAME}.")


if __name__ == "__main__":
    main()
