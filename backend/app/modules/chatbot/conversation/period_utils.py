"""Shared temporal / date-range resolution for the Billing Assistant.

Single source of truth for turning a natural-language time reference into a
(calendared) period window, so chatbot handlers no longer hand-roll relative
dates independently.

Calendar rules mirror the dashboard's `get_period_dates`
(``app.modules.billing.utils.date_utils``) for the CURRENT periods it supports
(today / this week / this month / this quarter / this year) and extend that
with the PAST/relative and explicit references the assistant needs:

  today, yesterday,
  this week / last week, this month / last month,
  this quarter / last quarter, this year / last year,
  a named month ("in March"), an explicit year ("in 2026"),
  and an explicit YYYY-MM-DD date or date range.

Semantics
---------
Returns a :class:`PeriodRange` with:

  start        - aware ``datetime`` at the start of the window (>= filter)
  end          - aware ``datetime``, EXCLUSIVE upper bound (< filter) — the
                 dashboard's revenue aggregates (``paid_revenue_totals``) are
                 ``[start, end)``, so an exclusive end keeps boundaries
                 consistent across every caller.
  label        - human label ("this month", "last month", "March 2026", ...)
  mode         - "now" for a current-dashboard-backed window ("this month",
                 "this year", "this week", "this quarter", "today") or
                 "window" for any computed/mirror window. Callers that must
                 return the dashboard's own "this month" figure read that -
                 this flag tells them whether to prefer the dashboard value.

"this month" is deliberately un-pinned to an exact end: the dashboard's
Monthly Revenue card is month-to-date (issue_date >= 1st AND <= today), so a
caller that needs the dashboard-SOT figure should read it directly and only
use the resolver for windows the dashboard does not expose.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

MONTH_NAMES = (
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
)


@dataclass(frozen=True)
class PeriodRange:
    start: datetime
    end: datetime  # exclusive upper bound
    label: str
    mode: str  # "now" | "window"


def _utc_midnight(d: datetime) -> datetime:
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)


def _month_start(anchor: datetime) -> datetime:
    return datetime(anchor.year, anchor.month, 1, tzinfo=timezone.utc)


def _add_months(anchor: datetime, delta: int) -> datetime:
    month_idx = anchor.year * 12 + (anchor.month - 1) + delta
    year, month0 = divmod(month_idx, 12)
    return datetime(year, month0 + 1, 1, tzinfo=timezone.utc)


def _quarter_start(anchor: datetime) -> datetime:
    qm = ((anchor.month - 1) // 3) * 3 + 1
    return datetime(anchor.year, qm, 1, tzinfo=timezone.utc)


def resolve_period(text: str) -> Optional[PeriodRange]:
    """Resolve a natural-language period string to a :class:`PeriodRange`,
    or ``None`` when the text carries no recognizable time reference.

    Not called with a period reference at all should be handled by the caller
    (e.g. defaulting to "this month" dashboard value).
    """
    normalized: str = (text or "").lower().strip()
    now = datetime.now(timezone.utc)
    today = now.date()

    # Explicit single date: "revenue on 2026-03-05"
    m = re.search(r"\b20\d{2}-\d{1,2}-\d{1,2}\b", normalized)
    if m:
        try:
            d = datetime.fromisoformat(m.group(0)).date()
        except ValueError:
            d = None
        if d is not None:
            start = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
            return PeriodRange(start, start + timedelta(days=1), d.isoformat(), "window")

    # "today"
    if re.search(r"\btoday\b", normalized):
        start = _utc_midnight(now)
        return PeriodRange(start, start + timedelta(days=1), "today", "now")

    # "yesterday"
    if re.search(r"\byesterday\b", normalized):
        yesterday = today - timedelta(days=1)
        start = datetime(yesterday.year, yesterday.month, yesterday.day, tzinfo=timezone.utc)
        return PeriodRange(start, start + timedelta(days=1), "yesterday", "window")

    # "last week" (Monday of last week -> this Monday, exclusive)
    if re.search(r"\blast\s+week\b", normalized):
        this_monday = today - timedelta(days=today.weekday())
        start_date = this_monday - timedelta(days=7)
        start = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
        end = datetime(this_monday.year, this_monday.month, this_monday.day, tzinfo=timezone.utc)
        return PeriodRange(start, end, "last week", "window")

    # "this week" (or "current week"/"this week's") — the whole calendar week
    # from Monday through Sunday, exclusive end = Monday of next week, so the
    # entire current week (including today) is inside the window.
    if re.search(r"\bthis\s+week\b|\bcurrent\s+week\b|\bweek'?s\b", normalized):
        start_date = today - timedelta(days=today.weekday())
        start = datetime(start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc)
        return PeriodRange(start, start + timedelta(days=7), "this week", "now")

    # "this quarter"
    if re.search(r"\bthis\s+quarter\b|\bcurrent\s+quarter\b", normalized):
        start = _quarter_start(now)
        return PeriodRange(start, _add_months(start, 3), "this quarter", "now")

    # "last quarter"
    if re.search(r"\blast\s+quarter\b", normalized):
        prev_q_start = _add_months(_quarter_start(now), -3)
        return PeriodRange(prev_q_start, _add_months(prev_q_start, 3), "last quarter", "window")

    # "last month"
    if re.search(r"\blast\s+month\b", normalized):
        prev_start = _add_months(now, -1)
        return PeriodRange(prev_start, _month_start(now), "last month", "window")

    # "this month" / "this month's"
    if re.search(r"\bthis\s+month\b|\bcurrent\s+month\b|\bmonth'?s\b", normalized) or re.search(r"\bin\s+the\s+current\s+month\b", normalized):
        return PeriodRange(_month_start(now), _add_months(now, 1), "this month", "now")

    # "last year"
    if re.search(r"\blast\s+year\b", normalized):
        return PeriodRange(
            datetime(now.year - 1, 1, 1, tzinfo=timezone.utc),
            datetime(now.year, 1, 1, tzinfo=timezone.utc),
            str(now.year - 1),
            "window",
        )

    # "this year" / "this year's"
    if re.search(r"\bthis\s+year\b|\bcurrent\s+year\b|\byear'?s\b", normalized):
        return PeriodRange(
            datetime(now.year, 1, 1, tzinfo=timezone.utc),
            datetime(now.year + 1, 1, 1, tzinfo=timezone.utc),
            str(now.year),
            "now",
        )

    # Named month: "in March", "for March 2025"
    month_m = re.search(
        r"\b(" + "|".join(MONTH_NAMES) + r")\b(?:\s+(20\d{2}))?", normalized, re.IGNORECASE,
    )
    if month_m:
        month_num = MONTH_NAMES.index(month_m.group(1).lower()) + 1
        year = int(month_m.group(2)) if month_m.group(2) else now.year
        start = datetime(year, month_num, 1, tzinfo=timezone.utc)
        return PeriodRange(start, _add_months(start, 1), f"{month_m.group(1).capitalize()} {year}", "window")

    # Explicit year: "in 2026"
    year_m = re.search(r"\b(20\d{2})\b", normalized)
    if year_m:
        year = int(year_m.group(1))
        return PeriodRange(
            datetime(year, 1, 1, tzinfo=timezone.utc),
            datetime(year + 1, 1, 1, tzinfo=timezone.utc),
            str(year),
            "window",
        )

    return None
