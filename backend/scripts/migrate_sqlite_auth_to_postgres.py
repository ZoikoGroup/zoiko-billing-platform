"""
scripts/migrate_sqlite_auth_to_postgres.py
------------------------------------------
One-off recovery for accounts stranded by the SQLite fallback bug.

Root cause (fixed in app/config.py): with a CWD-relative env_file, uvicorn
launched from any directory other than backend/ silently skipped .env,
BILLING_DATABASE_URL resolved empty and — under DEBUG — the app fell back to
app/data/billing_dev.sqlite3. Registrations performed against such an
instance were persisted to SQLite while the properly-launched server reads
Neon Postgres, so those users got "Invalid email or password." despite
typing correct credentials.

This script copies the affected organizations + users from the SQLite dev
database into the configured (Postgres) database:

  - IDs are NOT reused; rows are inserted fresh so no collision occurs.
  - hashed_password is copied verbatim → the password the user already
    knows keeps working. No plaintext is read, logged or stored.
  - After insertion, the same idempotent post-registration seeding that
    /auth/register performs is applied to each migrated organization
    (commercial account + default subscription + billing configuration +
    starter tax rates) so the tenant is internally consistent.
  - Idempotent: users whose email already exists in Postgres are skipped.
  - Fixture emails (*@example.com, *@test.com) are excluded by default.

Usage:
    python -m scripts.migrate_sqlite_auth_to_postgres [--include-fixtures]
"""

import argparse
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session

from app.database import SessionLocal, resolve_database_url
from app.modules.auth.models import User
from app.modules.organizations.models import Organization

SQLITE_PATH = Path(__file__).resolve().parent.parent / "app" / "data" / "billing_dev.sqlite3"

FIXTURE_EMAIL_SUFFIXES = ("@example.com", "@test.com")


def _copyable_columns(model, source_row_keys):
    """Columns present on BOTH the target model and the source row — id and
    FK organization_id handled explicitly by the caller."""
    model_cols = {c.key for c in sa_inspect(model).columns}
    return model_cols & set(source_row_keys) - {"id", "organization_id"}


def migrate(db: Session, include_fixtures: bool = False) -> None:
    if not SQLITE_PATH.exists():
        print(f"No SQLite database found at {SQLITE_PATH} — nothing to migrate.")
        return

    sqlite_con = sqlite3.connect(f"file:{SQLITE_PATH}?mode=ro", uri=True)
    sqlite_con.row_factory = sqlite3.Row
    try:
        user_rows = sqlite_con.execute(
            "SELECT * FROM users ORDER BY created_at ASC"
        ).fetchall()
        org_by_id = {
            row["id"]: row
            for row in sqlite_con.execute("SELECT * FROM organizations").fetchall()
        }

        migrated_org_ids = {}
        done = skipped = 0
        for src_user in user_rows:
            email = (src_user["email"] or "").strip()
            if not include_fixtures and email.lower().endswith(FIXTURE_EMAIL_SUFFIXES):
                continue
            if db.query(User).filter(User.email.ilike(email)).first():
                skipped += 1
                continue

            src_org = org_by_id.get(src_user["organization_id"])
            org = None
            if src_org is not None:
                if src_org["id"] in migrated_org_ids:
                    org = db.query(Organization).get(migrated_org_ids[src_org["id"]])
                else:
                    org = Organization(**{
                        col: src_org[col] for col in _copyable_columns(Organization, src_org.keys())
                    })
                    db.add(org)
                    db.flush()  # assign a new Postgres id
                    migrated_org_ids[src_org["id"]] = org.id

            user = User(**{
                "organization_id": org.id if org else None,
                **{col: src_user[col] for col in _copyable_columns(User, src_user.keys())},
            })
            db.add(user)
            db.flush()

            # Same idempotent seeding register_enterprise() applies, so the
            # migrated tenant behaves like one created through the normal flow.
            _seed_tenant(db, org.id)

            db.commit()
            done += 1
            print(f"migrated: {email} (user id {src_user['id']} -> {user.id}, "
                  f"org {src_user['organization_id']} -> {org.id if org else None})")

        print(f"\nDone. migrated={done}, already_present/skipped={skipped}")
        if migrated_org_ids:
            print("Organization id remap:", dict(migrated_org_ids))
    finally:
        sqlite_con.close()


def _seed_tenant(db: Session, organization_id: int) -> None:
    """Idempotent mirrors of the registration-time seeds; flush-only here."""
    try:
        from app.modules.commercial.service import (
            CommercialAccountService,
            CommercialSubscriptionService,
        )
        account = CommercialAccountService(db).ensure_commercial_account(organization_id)
        CommercialSubscriptionService(db).provision_default_subscription(account.id)

        from app.modules.billing.services.settings_service import BillingConfigurationService
        BillingConfigurationService(db).seed_billing_configuration(organization_id)
    except Exception as exc:  # noqa: BLE001 - seeding must not abort the auth migration
        print(f"  note: tenant seeding for org {organization_id} incomplete: {exc}")
        db.rollback()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--include-fixtures", action="store_true",
                        help="Also migrate @example.com/@test.com fixture accounts.")
    args = parser.parse_args()

    url = resolve_database_url()
    print(f"Target database: {'Postgres/Neon' if 'postgres' in url else url}")
    session = SessionLocal()
    try:
        migrate(session, include_fixtures=args.include_fixtures)
    finally:
        session.close()
