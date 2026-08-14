"""
migrations/add_commercial_subscription_tables.py
------------------------------------------------
Idempotent, additive-only migration that creates the `commercial_plans` and
`commercial_subscriptions` tables on EXISTING databases (PostgreSQL or the dev
SQLite fallback).

Fresh databases receive the tables automatically from
Base.metadata.create_all (app/database.py initialize_database, which registers
app.modules.commercial.models). This script exists only because create_all does
NOT alter existing databases — see migrations/create_all/README.md.

The tables are created verbatim from the SQLAlchemy models
(app/modules/commercial/models.py).

Safe to run any number of times:
  - only creates tables when they are missing
  - never drops anything, never deletes data, never alters existing tables

Usage:
    python -m migrations.add_commercial_subscription_tables            # apply
    python -m migrations.add_commercial_subscription_tables --check    # report only
    python -m migrations.add_commercial_subscription_tables --backfill
        # also create ACTIVE commercial accounts for every org that lacks one
        # (idempotent). NO subscriptions are backfilled: Phase 7 seeds no
        # approved default plan, and inventing one to fill the table would
        # violate the no-invented-pricing rule.

NOT executed automatically and NOT run against Neon here — run it manually
(once approved) from backend/ with BILLING_DATABASE_URL set:
    set BILLING_DATABASE_URL=postgresql://...
    python -m migrations.add_commercial_subscription_tables --backfill
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect  # type: ignore[import]

from app.database import Base, SessionLocal, engine
from app.modules.commercial.models import (  # noqa: F401  (registers tables)
    CommercialAccount,
    CommercialPlan,
    CommercialSubscription,
)
from app.modules.organizations.models import Organization  # noqa: F401  (FK target)

TABLE_NAMES = ["commercial_plans", "commercial_subscriptions"]


def _missing_tables() -> list[str]:
    return [t for t in TABLE_NAMES if not inspect(engine).has_table(t)]


def _backfill_missing_accounts() -> int:
    """Create ACTIVE CommercialAccount rows for every org that lacks one."""
    from app.modules.commercial.service import CommercialAccountService

    if not inspect(engine).has_table(CommercialAccount.__tablename__):
        print(
            "Skipping account backfill: table "
            f"'{CommercialAccount.__tablename__}' does not exist yet. "
            "Run migrations.add_commercial_account_table first "
            "(it creates the table and backfills accounts)."
        )
        return 0

    db = SessionLocal()
    try:
        existing = {
            org_id
            for (org_id,) in db.query(CommercialAccount.organization_id).all()
        }
        query = db.query(Organization)
        if existing:
            query = query.filter(Organization.id.notin_(existing))
        missing_orgs = query.all()
        svc = CommercialAccountService(db)
        for org in missing_orgs:
            svc.ensure_commercial_account(org.id)
        db.commit()
        return len(missing_orgs)
    finally:
        db.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add the commercial_plans / commercial_subscriptions tables (idempotent, additive).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Only report which tables are missing; do not change the database.",
    )
    parser.add_argument(
        "--backfill",
        action="store_true",
        help="Also create ACTIVE accounts for existing orgs that lack one.",
    )
    args = parser.parse_args()

    missing = _missing_tables()

    if args.check:
        if missing:
            print(f"Missing tables: {', '.join(missing)}.")
        else:
            print(f"All tables present: {', '.join(TABLE_NAMES)}.")
        return

    for name in TABLE_NAMES:
        if name in missing:
            Base.metadata.tables[name].create(bind=engine, checkfirst=True)
            print(f"Created table {name}.")
        else:
            print(f"Table {name} already exists.")

    if args.backfill:
        created = _backfill_missing_accounts()
        print(f"Backfilled {created} CommercialAccount record(s).")
        print(
            "No CommercialSubscription records backfilled: Phase 7 defines no "
            "approved default plan (nothing invented)."
        )


if __name__ == "__main__":
    main()
