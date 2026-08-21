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
from sqlalchemy.dialects import postgresql  # type: ignore[import]
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

def _skip_existing_enum_types() -> None:
    """Prevent 'CREATE TYPE already exists' errors from checkfirst=False.

    Native Postgres ENUM columns register their CREATE TYPE DDL as a
    `before_create` event on `Base.metadata` itself (so a type shared by
    several tables is only ever created once). That means the event fires
    for *every* enum type registered anywhere in the metadata whenever
    create_all runs — not just for tables being created in this call — and
    with checkfirst=False it always re-issues CREATE TYPE unconditionally.
    If a leftover type exists from a prior partial run, that blows up with
    DuplicateObject even though the table list itself was filtered down to
    what's actually missing.

    Setting `create_type = False` directly on a plain `sqlalchemy.Enum`
    column has no effect: that DDL event is bound to the dialect-specific
    impl resolved from `column.type.dialect_impl(dialect)`, which
    SQLAlchemy resolves lazily and caches on the dialect keyed by the
    *original* type instance (`dialect._type_memos`). So instead we force
    that resolution now, across the whole metadata, and mutate the cached
    impl in place before create_all runs.
    """
    if engine.dialect.name != "postgresql":
        return
    with engine.connect() as conn:
        existing_type_names = {
            row[0] for row in conn.execute(text("SELECT typname FROM pg_type WHERE typtype = 'e'"))
        }
    for table in Base.metadata.tables.values():
        for column in table.columns:
            col_type = column.type
            if not getattr(col_type, "native_enum", False) or getattr(col_type, "name", None) not in existing_type_names:
                continue
            impl = col_type.dialect_impl(engine.dialect)
            if isinstance(impl, postgresql.ENUM):
                impl.create_type = False


def _add_missing_columns() -> None:
    """Add any columns that SQLAlchemy models define but are missing from the DB.

    After create_all creates missing tables, this introspects every table that
    ALREADY exists and compares its real columns to the model's columns. Any
    column present in the model but absent in the DB is added via
    ALTER TABLE ... ADD COLUMN.  This handles:
      - columns added to models after the initial table creation
      - partial schema drift (e.g. missing catalog_version_id, actor_role)

    Only runs on PostgreSQL (SQLite doesn't need ALTER; create_all recreates).
    All ALTER statements are ADD COLUMN with nullable columns (safe defaults),
    so they never fail on existing data.

    Performance: uses a single information_schema query to fetch ALL existing
    columns across ALL tables in one round-trip (critical for remote DBs like
    Neon where per-table introspection is prohibitively slow).
    """
    if engine.dialect.name != "postgresql":
        return
    added = 0
    with engine.connect() as conn:
        # Single query: every (table, column) pair that currently exists.
        rows = conn.execute(
            text(
                "SELECT table_name, column_name "
                "FROM information_schema.columns "
                "WHERE table_schema = 'public'"
            )
        ).fetchall()
        existing = {}
        for table_name, col_name in rows:
            existing.setdefault(table_name, set()).add(col_name)

        for table_name, sa_table in Base.metadata.tables.items():
            if table_name not in existing:
                continue  # table doesn't exist yet; create_all will handle it
            db_cols = existing[table_name]
            for column in sa_table.columns:
                if column.name in db_cols:
                    continue
                # Column is in the model but missing from the DB — add it.
                col_type = column.type.compile(dialect=engine.dialect)
                nullable = "NULL" if column.nullable else "NOT NULL"
                ddl = f"ALTER TABLE {table_name} ADD COLUMN {column.name} {col_type} {nullable}"
                if column.server_default is not None:
                    default_sql = column.server_default.arg
                    if hasattr(default_sql, "text"):
                        default_sql = default_sql.text
                    ddl += f" DEFAULT {default_sql}"
                logger.info("Adding missing column: %s", ddl)
                conn.execute(text(ddl))
                added += 1
        conn.commit()
    if added:
        logger.info("Added %d missing column(s) to existing tables.", added)


def initialize_database() -> None:
    """Create any tables that don't exist yet (create_all), then add missing columns.

    This is the intended bootstrap for the standalone platform: the DB
    starts empty and the schema is created in one shot. See
    migrations/create_all/README.md.

    `create_all`'s default `checkfirst=True` issues one existence-check
    round trip per table (~60+ on this schema), which is slow against a
    remote DB and can time out mid-check. We do a single bulk lookup via
    the inspector instead, then create only what's missing with
    `checkfirst=False` so no further per-table checks happen.

    After create_all, ``_add_missing_columns`` adds any columns that
    SQLAlchemy models define but are absent from the live DB. This handles
    schema drift (e.g. columns added to models after the original table
    creation) without requiring a full migration framework.
    """
    try:
        existing_tables = set(inspect(engine).get_table_names())
        missing_tables = [
            table for table in Base.metadata.tables.values()
            if table.name not in existing_tables
        ]
        if missing_tables:
            _skip_existing_enum_types()
            Base.metadata.create_all(bind=engine, tables=missing_tables, checkfirst=False)
            logger.info("Database tables initialized successfully (%d created).", len(missing_tables))
        else:
            logger.info("Database schema already up to date; skipped create_all.")
        _add_missing_columns()
    except exc.SQLAlchemyError as exc_info:
        logger.error("Database initialization failed: %s", exc_info)
        raise


def get_db():
    """Yield a database session per request.

    Hardened against transient connectivity failures (the documented
    intermittent Neon DNS resolution issue, ISS-012): one short retry rides
    out a blip, and a persistent failure raises ServiceUnavailableException
    (503, retryable) instead of an opaque 500 that looks like a code bug."""
    import time as _time

    from app.core.exceptions import ServiceUnavailableException

    db = None
    for attempt in range(2):
        try:
            db = SessionLocal()
            # Fail fast if the connection itself is down (e.g. DNS), so the
            # retry/503 path triggers here rather than mid-query in a router.
            db.execute(text("SELECT 1"))
            break
        except exc.OperationalError:
            if db is not None:
                db.close()
                db = None
            if attempt == 0:
                _time.sleep(0.5)
                continue
            raise ServiceUnavailableException(
                "Database temporarily unreachable. Please try again shortly."
            )
    try:
        yield db
    finally:
        if db is not None:
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
import app.modules.commercial.models  # noqa: F401,E402
import app.modules.billing.models  # noqa: F401,E402
