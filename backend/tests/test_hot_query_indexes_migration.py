"""Static/SQLite checks for the additive hot-query index migration."""
import importlib.util
from pathlib import Path

import sqlalchemy as sa
from alembic.config import Config
from alembic.operations import Operations
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory

BACKEND = Path(__file__).resolve().parent.parent
MIG = BACKEND / "alembic" / "versions" / "b7e2d9c4a1f8_add_hot_query_composite_indexes.py"


def _load():
    spec = importlib.util.spec_from_file_location("mig_b7e2d9c4a1f8", MIG)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_single_alembic_head_and_chain():
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    script = ScriptDirectory.from_config(cfg)
    assert script.get_heads() == ["b7e2d9c4a1f8"] or len(script.get_heads()) == 1
    assert _load().down_revision in {r.revision for r in script.walk_revisions()}


def test_upgrade_is_idempotent_and_downgrade_reverses_on_sqlite():
    mod = _load()
    engine = sa.create_engine("sqlite://")
    with engine.begin() as conn:
        for _, table, _ in mod.INDEXES:
            conn.execute(sa.text(
                f"CREATE TABLE IF NOT EXISTS {table} (id INTEGER PRIMARY KEY, organization_id INTEGER, "
                "deleted_at TIMESTAMP, created_at TIMESTAMP, status TEXT, severity TEXT)"))
        ctx = MigrationContext.configure(conn)
        with Operations.context(ctx):
            mod.upgrade()
            mod.upgrade()  # second run must not fail
            names = {r[0] for r in conn.execute(sa.text("SELECT name FROM sqlite_master WHERE type='index'"))}
            assert {n for n, _, _ in mod.INDEXES} <= names
            mod.downgrade()
            mod.downgrade()
            names = {r[0] for r in conn.execute(sa.text("SELECT name FROM sqlite_master WHERE type='index'"))}
            assert not ({n for n, _, _ in mod.INDEXES} & names)
