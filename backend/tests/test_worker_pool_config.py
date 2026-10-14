from types import SimpleNamespace
from unittest.mock import MagicMock

from app.core import worker_safety as ws
from app.database import TimedQueuePool, build_pool_kwargs


def _cfg(**kw):
    base = dict(DB_POOL_SIZE=5, DB_MAX_OVERFLOW=5, DB_POOL_TIMEOUT=10.0,
                DB_POOL_RECYCLE=1800, DB_POOL_PRE_PING=True)
    base.update(kw)
    return SimpleNamespace(**base)


def test_pool_kwargs_sqlite_empty():
    assert build_pool_kwargs("sqlite", _cfg()) == {}


def test_pool_kwargs_postgres():
    kw = build_pool_kwargs("postgresql", _cfg(DB_POOL_SIZE=0, DB_MAX_OVERFLOW=-2))
    assert kw["poolclass"] is TimedQueuePool
    assert kw["pool_size"] == 1 and kw["max_overflow"] == 0
    assert kw["pool_timeout"] == 10.0 and kw["pool_pre_ping"] is True


def _engine(dialect, got=True):
    eng = MagicMock()
    eng.dialect.name = dialect
    eng.connect.return_value.execute.return_value.scalar.return_value = got
    return eng


def test_leader_sqlite_or_disabled_is_leader():
    assert ws.try_acquire_scheduler_leadership(_engine("sqlite")) is True
    assert ws.try_acquire_scheduler_leadership(_engine("postgresql"), lock_enabled=False) is True


def test_leader_postgres_winner_and_loser():
    ws.release_scheduler_leadership()
    loser = _engine("postgresql", got=False)
    assert ws.try_acquire_scheduler_leadership(loser) is False
    loser.connect.return_value.close.assert_called()
    winner = _engine("postgresql", got=True)
    assert ws.try_acquire_scheduler_leadership(winner) is True
    ws.release_scheduler_leadership()
    assert ws._leader_conn is None


def test_leader_db_error_fails_closed():
    eng = _engine("postgresql")
    eng.connect.side_effect = RuntimeError("down")
    assert ws.try_acquire_scheduler_leadership(eng) is False


def test_multiworker_without_redis_rule():
    f = ws.multiworker_without_redis
    assert f(2, "", False) is True
    assert f(1, "", False) is False
    assert f(4, "redis://x", False) is False
    assert f(4, "", True) is False
