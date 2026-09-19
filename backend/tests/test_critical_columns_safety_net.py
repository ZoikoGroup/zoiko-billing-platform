"""tests/test_critical_columns_safety_net.py
------------------------------------------------
Startup safety net (Task 4): app.database.verify_critical_columns_present()
must loudly fail startup if a database is missing a column the running code
depends on, and must not false-positive against a fully-migrated database.
"""
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from app.database import Base, CRITICAL_COLUMNS, verify_critical_columns_present


def _fresh_engine():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=engine)
    return engine


def test_fully_migrated_database_starts_cleanly():
    """No false positives: a database created straight from the current
    models (i.e. every tracked column present) must pass without error."""
    engine = _fresh_engine()
    verify_critical_columns_present(bind=engine)  # must not raise


def test_missing_tracked_column_fails_loudly():
    """Simulate the scenario Task 4 targets: a manually-applied migration
    was never run, so a table exists but one column current code depends
    on is missing. Startup must fail with a message naming the column and
    the migration script to run — not a confusing downstream error."""
    engine = _fresh_engine()
    table, column, script, _reason = CRITICAL_COLUMNS[0]
    with engine.connect() as conn:
        conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))
        conn.commit()

    with pytest.raises(SystemExit) as exc_info:
        verify_critical_columns_present(bind=engine)

    message = str(exc_info.value)
    assert table in message
    assert column in message
    assert script in message


def test_missing_table_does_not_double_report():
    """If the table itself is missing (database never migrated at all),
    this check defers to _verify_postgres_schema_is_migrated()'s existing
    table-level warning rather than raising a second, more alarming error
    for the same root cause."""
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    # Deliberately do NOT create_all — no tables exist at all.
    verify_critical_columns_present(bind=engine)  # must not raise
