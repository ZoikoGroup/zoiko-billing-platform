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

_LOCK = threading.Lock()
# (timestamp, duration_ms) tuples; bounded to keep memory flat.
_WINDOW = deque(maxlen=2000)
WINDOW_SECONDS = 3600  # consider the last hour of traffic

# §18.2 — "First meaningful content: p95 ≤ 800 ms". Applied as the per-call
# server budget; the 2.0s "complete lens render" budget spans multiple calls
# plus browser work and cannot be verified from server timings alone.
P95_BUDGET_MS = 800


def record(duration_ms: float) -> None:
    now = time.monotonic()
    with _LOCK:
        _WINDOW.append((now, duration_ms))


def snapshot(window_seconds: int = WINDOW_SECONDS) -> dict:
    """Summary over the sliding window: count + p50/p95/max in ms."""
    cutoff = time.monotonic() - window_seconds
    with _LOCK:
        samples = [d for (t, d) in _WINDOW if t >= cutoff]
    if not samples:
        return {"sample_count": 0}
    samples.sort()

    def _pct(p):
        idx = min(len(samples) - 1, max(0, round(p / 100 * (len(samples) - 1))))
        return round(samples[idx], 1)

    return {
        "sample_count": len(samples),
        "window_seconds": window_seconds,
        "p50_ms": _pct(50),
        "p95_ms": _pct(95),
        "max_ms": round(samples[-1], 1),
        "p95_budget_ms": P95_BUDGET_MS,
        "measured_since": (
            (datetime.utcnow() - timedelta(seconds=window_seconds)).isoformat() + "Z"
        ),
    }
