"""Stale-while-revalidate cache for the System Health SMTP reachability probe.

The probe opens a live connection to the mail server (~1.5 s in production,
up to the 5 s socket timeout) and used to run on the Billing Dashboard's
/billing/settings/health call whenever the 30 s health-report cache expired.

Policy (Batch 7 BUG-02):
  * A successful probe is fresh for SUCCESS_TTL_SECONDS (5 min); a failed or
    timed-out probe for FAILURE_TTL_SECONDS (60 s) so outages surface quickly.
  * After expiry the LAST result is returned immediately (marked stale) and
    one background refresh is started; callers never wait on the network.
  * Only one refresh runs per key at a time. A refresh that raises keeps the
    last known result and always clears the in-flight flag.
  * The newest completed probe replaces the previous result, whether it
    succeeded or failed (an outage must not be hidden behind an old success).
  * ``force=True`` (explicit Settings "Refresh") probes synchronously.
  * The very first request for a key (empty cache, e.g. after a restart)
    probes synchronously; concurrent first requests share that one probe.

The key is the mail server host:port -- SMTP settings are platform-level
(environment + PlatformSetting), never per organization, so no tenant data is
cached here. The cache is per process (the API runs one uvicorn process; with
several workers each would keep its own copy and probe independently).
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, Tuple

logger = logging.getLogger("zoiko_billing")

SUCCESS_TTL_SECONDS = 300
FAILURE_TTL_SECONDS = 60


@dataclass
class _Entry:
    result: Dict[str, Any]          # {"connectable": bool, "response_time_ms": float | None}
    checked_at: str                 # ISO-8601 UTC of the probe that produced it
    fresh_until: float              # monotonic deadline


_lock = threading.Lock()
_entries: Dict[str, _Entry] = {}
_refreshing: set = set()
_first_fill_locks: Dict[str, threading.Lock] = {}


def reset() -> None:
    """Drop every cached result (tests and process restarts)."""
    with _lock:
        _entries.clear()
        _refreshing.clear()
        _first_fill_locks.clear()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _store(key: str, result: Dict[str, Any], clock: Callable[[], float]) -> _Entry:
    ttl = SUCCESS_TTL_SECONDS if result.get("connectable") else FAILURE_TTL_SECONDS
    entry = _Entry(result=result, checked_at=_now_iso(), fresh_until=clock() + ttl)
    with _lock:
        _entries[key] = entry
    return entry


def _safe_probe(probe: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
    """The probe itself reports unreachable servers as connectable=False; this
    only guards against unexpected programming errors."""
    try:
        return probe()
    except Exception:
        logger.exception("SMTP reachability probe raised unexpectedly")
        return {"connectable": False, "response_time_ms": None}


def _background_refresh(key: str, probe: Callable[[], Dict[str, Any]], clock: Callable[[], float]) -> None:
    try:
        result = probe()
        _store(key, result, clock)
    except Exception:
        # Keep the last known result; the next stale read retries.
        logger.exception("Background SMTP reachability refresh failed for %s", key)
    finally:
        with _lock:
            _refreshing.discard(key)


def _spawn(target: Callable[..., None], *args: Any) -> None:
    threading.Thread(target=target, args=args, name="smtp-reachability-refresh", daemon=True).start()


def get_reachability(
    key: str,
    probe: Callable[[], Dict[str, Any]],
    *,
    force: bool = False,
    clock: Callable[[], float] = time.monotonic,
    spawn: Optional[Callable[..., None]] = None,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Return (result, meta). meta = {checked_at, stale, cached}."""
    if force:
        entry = _store(key, _safe_probe(probe), clock)
        return entry.result, {"checked_at": entry.checked_at, "stale": False, "cached": False}

    with _lock:
        entry: Optional[_Entry] = _entries.get(key)
        if entry is None:
            fill_lock = _first_fill_locks.setdefault(key, threading.Lock())
    if entry is None:
        # Empty cache: probe synchronously, once, even under concurrent requests.
        with fill_lock:
            with _lock:
                entry = _entries.get(key)
            if entry is None:
                entry = _store(key, _safe_probe(probe), clock)
                return entry.result, {"checked_at": entry.checked_at, "stale": False, "cached": False}

    if clock() < entry.fresh_until:
        return entry.result, {"checked_at": entry.checked_at, "stale": False, "cached": True}

    with _lock:
        start_refresh = key not in _refreshing
        if start_refresh:
            _refreshing.add(key)
    if start_refresh:
        try:
            (spawn or _spawn)(_background_refresh, key, probe, clock)
        except Exception:
            logger.exception("Could not start SMTP reachability refresh for %s", key)
            with _lock:
                _refreshing.discard(key)
    return entry.result, {"checked_at": entry.checked_at, "stale": True, "cached": True}
