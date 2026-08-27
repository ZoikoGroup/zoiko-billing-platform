"""
migrations/add_entitlement_enforcement_tables.py
--------------------------------------------------
Idempotent, additive-only migration that creates the four new tables
introduced by ZB-COM-ENT-001 Part 2:

  - entitlement_snapshots     (§11.1/§13 materialized resolved-entitlement cache)
  - commercial_overrides      (§16.1 per-org override with maker-checker approval)
  - usage_increment_events    (§14 idempotency ledger for usage increments)
  - usage_counters            (§14 aggregate usage read model)

Fresh databases receive these tables automatically from
Base.metadata.create_all. This script exists only because create_all does
NOT alter existing databases — see migrations/create_all/README.md.

Safe to run any number of times:
  - only creates tables that are missing (inspector-driven)
  - never drops anything, never deletes data

Usage:
    python -m migrations.add_entitlement_enforcement_tables            # apply
    python -m migrations.add_entitlement_enforcement_tables --check    # report only

NOT executed automatically and NOT run against Neon here — run it manually
(once approved) from backend/ with BILLING_DATABASE_URL set:
    set BILLING_DATABASE_URL=postgresql://...
    python -m migrations.add_entitlement_enforcement_tables
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect, text  # type: ignore[import]

from app.database import Base, engine

# Tables to create, in dependency order (none of the four FK each other, but
# all FK entitlement_definitions/organizations/commercial_subscriptions,
# which must already exist from Part 1 / earlier phases).
TABLES_TO_CREATE = [
    "entitlement_snapshots",
    "commercial_overrides",
    "usage_increment_events",
    "usage_counters",
]


def _tables_to_create() -> list[str]:
    inspector = inspect(engine)
    existing = set(inspector.get_table_names())
    return [t for t in TABLES_TO_CREATE if t not in existing]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create entitlement enforcement tables (idempotent, additive).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Only report which tables need creating; do not alter the database.",
    )
    args = parser.parse_args()

    missing = _tables_to_create()

    if args.check:
        if missing:
            print("Tables to create:")
            for t in missing:
                print(f"  {t}")
        else:
            print("All entitlement enforcement tables exist — schema is up to date.")
        return

    if not missing:
        print("All entitlement enforcement tables exist — schema is up to date.")
        return

    # create_all with checkfirst=False for the specific tables.
    from app.database import _skip_existing_enum_types

    _skip_existing_enum_types()
    tables = [Base.metadata.tables[t] for t in missing if t in Base.metadata.tables]
    if tables:
        Base.metadata.create_all(bind=engine, tables=tables, checkfirst=False)
        for t in missing:
            print(f"Created table {t}.")
    print(f"Done. {len(missing)} table(s) created.")


if __name__ == "__main__":
    main()
