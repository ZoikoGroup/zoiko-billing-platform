"""
migrations/add_platform_audit_log_columns.py
------------------------------------------------
Idempotent, additive-only migration that back-fills the `actor_role`,
`reason`, and `correlation_id` columns onto the EXISTING `platform_audit_logs`
table (PostgreSQL or the dev SQLite fallback).

Fresh databases receive these columns automatically from
Base.metadata.create_all. This script exists only because create_all does
NOT alter existing tables -- see migrations/create_all/README.md
("Schema changes").

Safe to run any number of times:
  - only adds columns that are missing (inspector-driven)
  - never drops anything, never deletes data, never recreates tables
  - all three columns are nullable: existing audit rows predate them and
    remain valid with them unset

Backfill (actor_role only): every row in platform_audit_logs is written by an
endpoint gated by get_current_super_admin (see super_admin/router.py,
organizations/router.py) -- there is no code path anywhere in this codebase
that ever demotes a user away from the super_admin role (the only mutation
of User.role is auth/router.py's update_user, which is itself scoped to
get_current_org_admin and only reassigns between org_admin/billing_admin
within one organization -- it can never touch a super_admin row). So for
existing rows whose actor's CURRENT role is confirmed super_admin,
backfilling actor_role = 'SUPER_ADMIN' records a real, verifiable
architectural invariant, not a guess. Rows whose actor_id is NULL, or whose
actor's current role is (in some future scenario) no longer super_admin, are
left NULL -- an honest "not confidently known" rather than a fabricated
value. `reason` and `correlation_id` are NOT backfilled: no historical data
exists to derive them from, so they correctly stay NULL for pre-migration
rows.

Usage:
    python -m migrations.add_platform_audit_log_columns            # apply (adds columns + backfills actor_role)
    python -m migrations.add_platform_audit_log_columns --check    # report only, no changes

NOT executed automatically and NOT run against Neon here -- run it manually
(once approved) from backend/ with BILLING_DATABASE_URL set:
    set BILLING_DATABASE_URL=postgresql://...
    python -m migrations.add_platform_audit_log_columns
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import inspect, text  # type: ignore[import]

from app.database import engine

TABLE_NAME = "platform_audit_logs"
NEW_COLUMNS = [
    ("actor_role", "VARCHAR(50)"),
    ("reason", "TEXT"),
    ("correlation_id", "VARCHAR(100)"),
]


def _missing_columns() -> list:
    inspector = inspect(engine)
    if not inspector.has_table(TABLE_NAME):
        print(f"Table '{TABLE_NAME}' does not exist -- nothing to migrate.")
        return []
    existing = {column["name"] for column in inspector.get_columns(TABLE_NAME)}
    return [(name, ddl) for name, ddl in NEW_COLUMNS if name not in existing]


def _backfill_actor_role(conn) -> int:
    """Only fires for rows where actor_role is still NULL and the actor's
    CURRENT role is confirmed 'super_admin' -- see module docstring for why
    this is safe (not a fabrication) rather than a blanket assumption."""
    result = conn.execute(
        text(
            """
            UPDATE platform_audit_logs
            SET actor_role = users.role
            FROM users
            WHERE platform_audit_logs.actor_id = users.id
              AND platform_audit_logs.actor_role IS NULL
              AND users.role = 'SUPER_ADMIN'
            """
        )
    )
    return result.rowcount if result.rowcount is not None else 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add missing platform_audit_logs columns (idempotent, additive) and backfill actor_role.",
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
            print(f"No missing columns -- {TABLE_NAME} schema is up to date.")
        return

    if missing:
        with engine.begin() as conn:
            for name, ddl in missing:
                conn.execute(text(f'ALTER TABLE {TABLE_NAME} ADD COLUMN "{name}" {ddl}'))
                print(f"Added {TABLE_NAME}.{name} {ddl}")
    else:
        print(f"No missing columns -- {TABLE_NAME} schema is up to date.")

    # Backfill runs every time (idempotent: only touches actor_role IS NULL
    # rows), independent of whether the columns were just added or already
    # existed -- so re-running this script after a partial prior run still
    # catches up any rows a previous invocation missed.
    with engine.begin() as conn:
        updated = _backfill_actor_role(conn)
        print(f"Backfilled actor_role on {updated} existing row(s) confirmed super_admin.")


if __name__ == "__main__":
    main()
