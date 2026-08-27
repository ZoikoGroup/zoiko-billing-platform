"""
migrations/add_user_role_finance_approver_auditor.py
-------------------------------------------------------
Idempotent, additive-only migration that adds the 'finance_approver' and
'auditor' values to the users.role native enum type on EXISTING PostgreSQL
databases (§25 Segregation-of-Duties Doctrine — see auth/models.py UserRole).

Fresh databases receive both values automatically from
Base.metadata.create_all (app/database.py initialize_database), since
UserRole already includes them. This script exists only because create_all
does NOT alter an existing native enum type on Postgres — see
migrations/create_all/README.md ("Schema changes").

On the dev SQLite fallback this is a no-op: SQLAlchemy's generic Enum on
SQLite is not backed by a native enum type there, so a fresh `create_all` (or
just restarting against a dev SQLite file) already accepts the new values
with nothing to alter.

Each new value is added in its own ALTER TYPE statement/transaction —
PostgreSQL cannot add an enum value and use it within the same transaction.

Safe to run any number of times: only adds a value when it is missing, never
removes or renames anything.

Usage:
    python -m migrations.add_user_role_finance_approver_auditor            # apply
    python -m migrations.add_user_role_finance_approver_auditor --check    # report only

NOT executed automatically and NOT run against Neon here — run it manually
(once approved) from backend/ with BILLING_DATABASE_URL set:
    set BILLING_DATABASE_URL=postgresql://...
    python -m migrations.add_user_role_finance_approver_auditor

NEW_VALUES must match SQLAlchemy's storage convention for `Column(Enum(UserRole))`
with no `values_callable` override: it persists each member's *name*
(e.g. "FINANCE_APPROVER"), not its `.value` (e.g. "finance_approver") — the
same convention already used by the pre-existing SUPER_ADMIN/ORG_ADMIN/
BILLING_ADMIN labels. An earlier version of this script used the lowercase
`.value` form, which added enum labels the ORM layer never actually sends,
so every insert of a FINANCE_APPROVER/AUDITOR user still failed with
"invalid input value for enum userrole" until the correctly-cased labels
were added. Running this corrected script on a database that already has
the stray lowercase labels from that earlier version is still safe — those
extra labels are simply never used by the application (Postgres has no way
to drop a single enum label without recreating the type, so they're
harmless, permanent no-ops rather than something this script needs to clean
up).
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import text  # type: ignore[import]

from app.database import engine
from app.modules.auth.models import User

NEW_VALUES = ["FINANCE_APPROVER", "AUDITOR"]


def _enum_type_name() -> str:
    return User.__table__.c.role.type.name


def _existing_values(enum_name: str) -> set[str]:
    if engine.dialect.name != "postgresql":
        return set()
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT e.enumlabel FROM pg_enum e "
                "JOIN pg_type t ON e.enumtypid = t.oid "
                "WHERE t.typname = :enum_name"
            ),
            {"enum_name": enum_name},
        ).fetchall()
    return {row[0] for row in rows}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Add 'finance_approver'/'auditor' to the users.role enum (idempotent, additive).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Only report which values are present; do not change the database.",
    )
    args = parser.parse_args()

    if engine.dialect.name != "postgresql":
        print(
            f"Dialect is '{engine.dialect.name}', not postgresql — no native enum "
            "type to alter here. A fresh create_all already includes the new "
            "UserRole values."
        )
        return

    enum_name = _enum_type_name()
    existing = _existing_values(enum_name)

    if args.check:
        for value in NEW_VALUES:
            print(f"'{value}' is {'present' if value in existing else 'MISSING'} in enum {enum_name!r}.")
        return

    for value in NEW_VALUES:
        if value in existing:
            print(f"'{value}' already present in enum {enum_name!r}.")
            continue
        with engine.begin() as conn:
            conn.execute(text(f"ALTER TYPE {enum_name} ADD VALUE IF NOT EXISTS '{value}'"))
        print(f"Added '{value}' to enum {enum_name!r}.")


if __name__ == "__main__":
    main()
