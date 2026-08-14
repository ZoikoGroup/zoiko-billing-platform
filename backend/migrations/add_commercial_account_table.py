"""
migrations/add_commercial_account_table.py
------------------------------------------
Idempotent, additive-only migration that creates the `commercial_accounts`
table on EXISTING databases (PostgreSQL or the dev SQLite fallback).

Fresh databases receive the table automatically from
Base.metadata.create_all (app/database.py initialize_database, which now
registers app.modules.commercial.models). This script exists only because
create_all does NOT alter existing databases — see
migrations/create_all/README.md ("Schema changes").

The table is created verbatim from the SQLAlchemy model
(app/modules/commercial/models.py).

Safe to run any number of times:
  - only creates the table when it is missing
  - never drops anything, never deletes data, never alters existing tables

Usage:
    python -m migrations.add_commercial_account_table            # apply
    python -m migrations.add_commercial_account_table --check    # report only
    python -m migrations.add_commercial_account_table --backfill
        # also create ACTIVE accounts for every existing org that lacks one
        # (idempotent; the app's lazy ensure() does the same thing on first
        # access, so this flag just makes it explicit and bulk)

NOT executed automatically and NOT run against Neon here — run it manually
(once approved) from backend/ with BILLING_DATABASE_URL set:
    set BILLING_DATABASE_URL=postgresql://...
    python -m migrations.add_commercial_account_table --backfill
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect  # type: ignore[import]

from app.database import Base, SessionLocal, engine
from app.modules.commercial.models import CommercialAccount  # noqa: F401  (registers table)
from app.modules.organizations.models import Organization  # noqa: F401  (FK target)

TABLE_NAME = "commercial_accounts"


def _table_exists() -> bool:
    return inspect(engine).has_table(TABLE_NAME)


def _backfill_missing_accounts() -> int:
    """Create ACTIVE CommercialAccount rows for every org that lacks one."""
    from app.modules.commercial.service import CommercialAccountService

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
        description="Add the commercial_accounts table (idempotent, additive).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Only report whether the table exists; do not change the database.",
    )
    parser.add_argument(
        "--backfill",
        action="store_true",
        help="Also create ACTIVE accounts for existing orgs that lack one.",
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

    if args.backfill:
        created = _backfill_missing_accounts()
        print(f"Backfilled {created} CommercialAccount record(s).")


if __name__ == "__main__":
    main()
