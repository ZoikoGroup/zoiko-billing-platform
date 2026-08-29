"""
migrations/create_all/create_all.py
-----------------------------------
Creates the full database schema from the SQLAlchemy models.

SUPERSEDED FOR POSTGRESQL: real database schema lifecycle is now owned by
Alembic (backend/alembic/, docs/DATABASE_MIGRATION_GUIDE.md). Running this
against a shared/production Postgres database is unsupported and will not
be recognized by Alembic (no alembic_version row) — `initialize_database()`
no longer create_alls Postgres at all. This script remains the bootstrap
for the SQLite dev fallback only.

Usage:
    # Dev / SQLite fallback (auto-downloads nothing, uses BILLING_DATABASE_URL
    # or the development sqlite file under app/data):
    python -m migrations.create_all.create_all

    # With --drop: drop all tables first, then recreate (destructive —
    # wipes every row. Only for a scratch/dev database).
    python -m migrations.create_all.create_all --drop

After the schema exists, seed accounts with:
    python -m scripts.seed_super_admin     # requires SETUP_KEY
    python -m scripts.seed_org             # demo org + org_admin
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from sqlalchemy import text  # type: ignore[import]

from app.database import Base, engine, initialize_database  # noqa: F401


def main() -> None:
    parser = argparse.ArgumentParser(description="Create the Billing Platform schema.")
    parser.add_argument(
        "--drop",
        action="store_true",
        help="DROP all tables first, then recreate (destructive).",
    )
    args = parser.parse_args()

    # Force all models to register their __tablename__ on Base.metadata.
    import app.modules.auth.models  # noqa: F401,F811
    import app.modules.organizations.models  # noqa: F401,F811
    import app.modules.super_admin.models  # noqa: F401,F811
    import app.modules.billing.models  # noqa: F401,F811

    if args.drop:
        print("Dropping all existing tables...")
        Base.metadata.drop_all(bind=engine)
        print("Dropped.")

    initialize_database()

    is_sqlite = engine.url.drivername.startswith("sqlite")
    with engine.connect() as conn:
        if is_sqlite:
            rows = conn.execute(text(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )).fetchall()
        else:
            rows = conn.execute(text(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
            )).fetchall()
    print(f"Schema ready: {len(rows)} tables created.")


if __name__ == "__main__":
    main()
