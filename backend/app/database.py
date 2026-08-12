"""
database.py
-----------
SQLAlchemy engine/session bootstrap for the standalone Billing Platform.

Uses BILLING_DATABASE_URL (PostgreSQL in production; SQLite fallback in
development when the URL is empty). The schema is created fresh via
migrations/create_all on an empty database — there is no migration from,
or sync with, the main platform's database.
"""

import logging
import os
from pathlib import Path
from urllib.parse import urlparse

from sqlalchemy import create_engine, exc, inspect, text  # type: ignore[import]
from sqlalchemy.orm import declarative_base, sessionmaker  # type: ignore[import]

from app.config import settings

logger = logging.getLogger("zoiko_billing")


def _is_development_environment() -> bool:
    env_name = (os.getenv("ENVIRONMENT") or os.getenv("APP_ENV") or "").strip().lower()
    debug_flag = str(getattr(settings, "DEBUG", False)).strip().lower()
    return env_name == "development" or debug_flag in {"1", "true", "yes", "on"}


def resolve_database_url(raw_url: str | None = None) -> str:
    candidate_url = (raw_url or settings.BILLING_DATABASE_URL or "").strip()
    if not candidate_url:
        if _is_development_environment():
            logger.warning("BILLING_DATABASE_URL is empty. Using development SQLite fallback.")
            fallback_path = Path(__file__).resolve().parent / "data" / "billing_dev.sqlite3"
            fallback_path.parent.mkdir(parents=True, exist_ok=True)
            return f"sqlite:///{fallback_path.resolve()}"
        raise RuntimeError(
            "BILLING_DATABASE_URL is not configured. SQLite fallback is disabled in production. "
            "Please set BILLING_DATABASE_URL in your .env file."
        )

    parsed = urlparse(candidate_url)
    scheme = parsed.scheme.split("+")[0]
    if scheme in {"postgresql", "postgres"}:
        # Requirements.txt installs psycopg[binary] (psycopg 3). Pin the
        # explicit +psycopg dialect so we don't fall back to psycopg2.
        if "+" in parsed.scheme:
            return candidate_url
        return candidate_url.replace(f"{parsed.scheme}://", f"{parsed.scheme}+psycopg://", 1)
    if candidate_url.startswith("sqlite"):
        return candidate_url
    if _is_development_environment():
        logger.warning("BILLING_DATABASE_URL has unrecognized scheme '%s'. Using development SQLite fallback.", scheme)
        fallback_path = Path(__file__).resolve().parent / "data" / "billing_dev.sqlite3"
        fallback_path.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{fallback_path.resolve()}"
    raise RuntimeError(
        f"BILLING_DATABASE_URL has unrecognized scheme '{parsed.scheme}'. "
        "Please verify your BILLING_DATABASE_URL configuration."
    )


resolved_database_url = resolve_database_url()

if resolved_database_url.startswith("sqlite"):
    engine = create_engine(
        resolved_database_url,
        connect_args={"check_same_thread": False},
    )
else:
    engine = create_engine(
        resolved_database_url,
        connect_args={"sslmode": "require"},
        pool_pre_ping=True,
        pool_size=5,
        max_overflow=10,
        pool_recycle=1800,
    )


SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)


Base = declarative_base()

def initialize_database() -> None:
    """Create any tables that don't exist yet (create_all).

    This is the intended bootstrap for the standalone platform: the DB
    starts empty and the schema is created in one shot. See
    migrations/create_all/README.md.

    `create_all`'s default `checkfirst=True` issues one existence-check
    round trip per table (~60+ on this schema), which is slow against a
    remote DB and can time out mid-check. We do a single bulk lookup via
    the inspector instead, then create only what's missing with
    `checkfirst=False` so no further per-table checks happen.
    """
    try:
        existing_tables = set(inspect(engine).get_table_names())
        missing_tables = [
            table for table in Base.metadata.tables.values()
            if table.name not in existing_tables
        ]
        if missing_tables:
            Base.metadata.create_all(bind=engine, tables=missing_tables, checkfirst=False)
            logger.info("Database tables initialized successfully (%d created).", len(missing_tables))
        else:
            logger.info("Database schema already up to date; skipped create_all.")
    except exc.SQLAlchemyError as exc_info:
        logger.error("Database initialization failed: %s", exc_info)
        raise


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def check_connection() -> bool:
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True
    except Exception:
        return False


# ── Model registration ─────────────────────────────────────────────────────
# Imported LAST (after every helper is defined) so that the billing
# sub-package __init__ files — which eagerly import their routers, which in
# turn import get_db/SessionLocal from app.database — never see this module
# in a partially-initialized state. The standalone platform owns exactly
# these modules; nothing from the old platform (hr / employee / comply /
# insights / time / payroll) is imported at runtime.
import app.modules.auth.models  # noqa: F401,E402
import app.modules.organizations.models  # noqa: F401,E402
import app.modules.super_admin.models  # noqa: F401,E402
import app.modules.billing.models  # noqa: F401,E402
