from datetime import date, timedelta
from typing import Optional, Tuple

MONTH_NAMES = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]


def _parse_iso_date(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def get_period_dates(
    period: Optional[str],
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> Tuple[date, date]:
    """Convert a period string (or an explicit custom range) to (start_date, end_date).

    date_from/date_to (ISO "YYYY-MM-DD") take precedence over `period` whenever
    either is supplied — this is what backs the dashboard's "Custom Date Range"
    filter. Malformed or missing values on either side fall back to the
    all-time bound (1970-01-01 / today) rather than raising, since this feeds
    read-only reporting queries.

    TODAY   = today only
    WEEK    = current calendar week (Monday → today)
    MONTH   = current calendar month (1st → today)
    QUARTER = current calendar quarter (Q1/Q2/Q3/Q4 start → today)
    YEAR    = current calendar year (Jan 1 → today)
    None    = all-time (1970-01-01 → today) — no filtering
    """
    today = date.today()

    if date_from or date_to:
        start = _parse_iso_date(date_from) or date(1970, 1, 1)
        end = _parse_iso_date(date_to) or today
        if start > end:
            start, end = end, start
        return start, end

    if period == "today":
        start = today
    elif period == "week":
        start = today - timedelta(days=today.weekday())
    elif period == "month":
        start = today.replace(day=1)
    elif period == "quarter":
        quarter_month = ((today.month - 1) // 3) * 3 + 1
        start = today.replace(month=quarter_month, day=1)
    elif period == "year":
        start = today.replace(month=1, day=1)
    else:
        start = date(1970, 1, 1)
    return start, today


def period_to_months(period: Optional[str]) -> int:
    """Return the number of months for revenue bulk queries based on period."""
    mapping = {"today": 1, "week": 1, "month": 1, "quarter": 3, "year": 12}
    return mapping.get(period, 12)


def is_daily_granularity(start: date, end: date) -> bool:
    """Whether a (start, end) range is narrow enough to chart day-by-day
    rather than month-by-month — used for both period-based and custom-range
    revenue/payment trends so the two code paths stay consistent."""
    return (end - start).days <= 31


def days_overdue(due_date: Optional[date], as_of: Optional[date] = None) -> int:
    """Days between a due date and today (or an explicit as_of date), floored
    at 0 (an invoice due today or in the future is not overdue). Centralizes
    what was previously the same `(date.today() - due_date).days` expression
    duplicated across DunningService, CollectionService, and the overdue-
    invoice/dunning-process scheduler tasks."""
    if not due_date:
        return 0
    reference = as_of or date.today()
    return max((reference - due_date).days, 0)
