"""
core/api_metrics.py
--------------------
ZB-SA-CMD-003 §18.2 — real latency measurement for the Command Center
surface. A thread-safe, in-memory sliding window of recent request durations
for /api/super-admin/* endpoints, recorded by main.py's request middleware.

HONEST SCOPE: this is single-process, in-memory telemetry (the deployment
model this codebase actually runs — BackgroundScheduler, no Redis/Celery).
It measures SERVER-side handling time, which is the part of the §18.2
budgets this codebase can observe; browser-side render time is not measured
and launch readiness says so rather than implying otherwise. Data resets on
process restart — with no samples the readiness check reports UNKNOWN,
never a fabricated PASS.
"""

import threading
import time
from collections import deque
from datetime import datetime, timedelta
from typing import Optional

_LOCK = threading.Lock()
# (timestamp, duration_ms, status_code-or-None) tuples; bounded to keep memory
# flat. status_code is None when a caller predates Phase 4 error tracking.
_WINDOW = deque(maxlen=2000)
WINDOW_SECONDS = 3600  # consider the last hour of traffic

# §18.2 — "First meaningful content: p95 ≤ 800 ms". Applied as the per-call
# server budget; the 2.0s "complete lens render" budget spans multiple calls
# plus browser work and cannot be verified from server timings alone.
P95_BUDGET_MS = 800


def record(duration_ms: float, status_code: Optional[int] = None) -> None:
    """Record one request's server handling time and (Phase 4, G-05) its HTTP
    status so error rates are observable alongside latency. status_code may be
    omitted by legacy callers; such samples contribute to latency percentiles
    but are excluded from rate denominators rather than guessed."""
    now = time.monotonic()
    with _LOCK:
        _WINDOW.append((now, duration_ms, status_code))


def snapshot(window_seconds: int = WINDOW_SECONDS) -> dict:
    """Summary over the sliding window: count + p50/p95/max in ms, plus
    server-error/client-error counts and rates (G-05).

    Honesty rules: ``error_rate``/``client_error_rate`` are None unless at
    least one sample carries a known HTTP status, and an empty window returns
    zeroed counts with None rates — never a fabricated healthy 0%."""
    cutoff = time.monotonic() - window_seconds
    with _LOCK:
        samples = [(duration, status) for (t, duration, status) in _WINDOW if t >= cutoff]

    empty_summary = {
        "sample_count": 0,
        "window_seconds": window_seconds,
        "error_count": 0,
        "client_error_count": 0,
        "status_unknown_count": 0,
        "error_rate": None,
        "client_error_rate": None,
        "measured_since": (
            (datetime.utcnow() - timedelta(seconds=window_seconds)).isoformat() + "Z"
        ),
    }
    if not samples:
        return empty_summary

    durations = sorted(duration for duration, _ in samples)
    errors = sum(1 for _, status in samples if status is not None and status >= 500)
    client_errors = sum(
        1 for _, status in samples if status is not None and 400 <= status < 500
    )
    status_known = sum(1 for _, status in samples if status is not None)

    def _pct(p):
        idx = min(len(durations) - 1, max(0, round(p / 100 * (len(durations) - 1))))
        return round(durations[idx], 1)

    return {
        "sample_count": len(samples),
        "window_seconds": window_seconds,
        "p50_ms": _pct(50),
        "p95_ms": _pct(95),
        "max_ms": round(durations[-1], 1),
        "p95_budget_ms": P95_BUDGET_MS,
        # G-05 — error observability over the same window.
        "error_count": errors,
        "client_error_count": client_errors,
        "status_unknown_count": len(samples) - status_known,
        "error_rate": (round(errors / status_known, 4) if status_known else None),
        "client_error_rate": (
            round(client_errors / status_known, 4) if status_known else None
        ),
        "measured_since": (
            (datetime.utcnow() - timedelta(seconds=window_seconds)).isoformat() + "Z"
        ),
    }
