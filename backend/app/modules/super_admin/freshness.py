"""
modules/super_admin/freshness.py
----------------------------------
ZB-SA-CMD-003 §10.2 — freshness state machine.

Freshness is part of a metric's validity, not a cosmetic timestamp. A value
computed from data that hasn't updated recently must say so rather than
render as if it were current. This module has exactly one job: given "when
was the underlying source last updated" and "how often is it expected to
update," return FRESH / STALE / UNKNOWN — never invent a fourth, rosier
state, and never let a caller silently treat STALE/UNKNOWN as FRESH.

Two distinct freshness stories exist in this codebase today:
  - Real-time queries (organization counts, tenant summaries): computed
    directly from the live table on every request, so they are FRESH by
    construction — there is no cache or batch lag to go stale. Still
    reported through this module (with expected_interval_seconds=None) so
    every metric carries the same freshness contract rather than some
    metrics silently having none.
  - Scheduled-job telemetry (JobRunLog): genuinely can go stale if a job
    stops firing. This is the case this module is actually built for.
"""

import enum
from datetime import datetime
from typing import Optional, Tuple


class FreshnessState(str, enum.Enum):
    FRESH = "fresh"
    STALE = "stale"
    UNKNOWN = "unknown"


def compute_freshness(
    last_updated_at: Optional[datetime],
    expected_interval_seconds: Optional[int],
    stale_multiplier: float = 2.0,
    unknown_multiplier: float = 4.0,
) -> Tuple[FreshnessState, Optional[float]]:
    """Returns (state, age_seconds).

    - No known update time, or no known expected cadence at all: UNKNOWN.
      This is the honest answer for "never ran" / "no cadence configured" —
      never FRESH-by-default.
    - Real-time sources (expected_interval_seconds == 0): always FRESH: age
      is always ~0 because the value was just computed from the live table.
    - Age within stale_multiplier x the expected interval: FRESH.
    - Age within unknown_multiplier x the expected interval: STALE.
    - Beyond that: UNKNOWN (matches the spec's "2x threshold or failed
      computation -> Unknown" rule — a stopped verification must never
      render green).
    """
    if last_updated_at is None or expected_interval_seconds is None:
        return FreshnessState.UNKNOWN, None

    age_seconds = max(0.0, (datetime.utcnow() - last_updated_at).total_seconds())

    if expected_interval_seconds <= 0:
        return FreshnessState.FRESH, age_seconds

    if age_seconds <= expected_interval_seconds * stale_multiplier:
        return FreshnessState.FRESH, age_seconds
    if age_seconds <= expected_interval_seconds * unknown_multiplier:
        return FreshnessState.STALE, age_seconds
    return FreshnessState.UNKNOWN, age_seconds
