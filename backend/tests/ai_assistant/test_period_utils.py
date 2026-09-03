"""Unit tests for the shared period/date-range resolver used by the Billing
Assistant (Phase 3: a single temporal source of truth so every handler agrees
on the same calendar rules).

Covers: current and relative periods, named months, explicit years and dates,
exclusive-end semantics, and "no time reference -> None" fallback.
"""

from datetime import datetime, timedelta, timezone

from app.modules.chatbot.conversation.period_utils import resolve_period


def _day(dt: datetime):
    return dt.date()


def test_this_month_calendar_window():
    r = resolve_period("this month")
    assert r is not None and r.mode == "now" and r.label == "this month"
    assert r.start.day == 1
    assert r.end == _add_months(r.start, 1)


def test_last_month_is_previous_calendar_month():
    r = resolve_period("last month")
    assert r is not None and r.mode == "window"
    # last month starts at the 1st of the previous month, ends at this month's 1st
    this_start = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    assert r.end == this_start
    assert r.start == _add_months(this_start, -1)


def test_this_week_covers_full_calendar_week():
    r = resolve_period("this week")
    assert r is not None and r.mode == "now"
    assert (r.end - r.start) == timedelta(days=7)
    # starts on a Monday
    assert r.start.weekday() == 0
    # current date falls inside the week
    now = datetime.now(timezone.utc)
    assert r.start <= now < r.end


def test_last_week_is_previous_seven_day_week():
    r = resolve_period("last week")
    this_monday = (datetime.now(timezone.utc) - timedelta(days=datetime.now(timezone.utc).weekday()))
    assert r.end == this_monday.replace(hour=0, minute=0, second=0, microsecond=0)
    assert r.start.weekday() == 0


def test_this_and_last_year():
    yr = datetime.now(timezone.utc).year
    this = resolve_period("this year")
    assert this is not None and this.mode == "now"
    assert this.start == datetime(yr, 1, 1, tzinfo=timezone.utc)
    assert this.end == datetime(yr + 1, 1, 1, tzinfo=timezone.utc)
    last = resolve_period("last year")
    assert last is not None and last.mode == "window"
    assert last.start == datetime(yr - 1, 1, 1, tzinfo=timezone.utc)
    assert last.end == datetime(yr, 1, 1, tzinfo=timezone.utc)


def test_this_and_last_quarter():
    now = datetime.now(timezone.utc)
    q = ((now.month - 1) // 3) * 3 + 1
    this = resolve_period("this quarter")
    assert this is not None
    assert this.start == datetime(now.year, q, 1, tzinfo=timezone.utc)
    assert (this.end - this.start).days in (91, 92, 90)

    last = resolve_period("last quarter")
    prev_start = _add_months(datetime(now.year, q, 1, tzinfo=timezone.utc), -3)
    assert last is not None and last.start == prev_start


def test_today_and_yesterday():
    today = resolve_period("today")
    assert today is not None and today.mode == "now"
    assert _day(today.start) == _day(datetime.now(timezone.utc))
    assert (today.end - today.start) == timedelta(days=1)

    yesterday = resolve_period("yesterday")
    assert yesterday is not None and yesterday.mode == "window"
    assert _day(yesterday.end) == _day(today.start)
    assert (yesterday.end - yesterday.start) == timedelta(days=1)


def test_named_month():
    r = resolve_period("in March")
    assert r is not None and r.mode == "window"
    assert r.start.month == 3 and r.start.day == 1
    assert r.end == _add_months(r.start, 1)


def test_named_month_with_year():
    r = resolve_period("in March 2025")
    assert r is not None
    assert r.start == datetime(2025, 3, 1, tzinfo=timezone.utc)
    assert r.end == datetime(2025, 4, 1, tzinfo=timezone.utc)


def test_explicit_year():
    r = resolve_period("in 2026")
    assert r is not None and r.mode == "window"
    assert r.start == datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert r.end == datetime(2027, 1, 1, tzinfo=timezone.utc)


def test_explicit_iso_date():
    r = resolve_period("revenue on 2026-03-05")
    assert r is not None and r.mode == "window"
    assert r.start == datetime(2026, 3, 5, tzinfo=timezone.utc)
    assert (r.end - r.start) == timedelta(days=1)


def test_no_time_reference_returns_none():
    assert resolve_period("total revenue") is None
    assert resolve_period("show overdue invoices") is None
    assert resolve_period("") is None


def _add_months(anchor: datetime, delta: int) -> datetime:
    month_idx = anchor.year * 12 + (anchor.month - 1) + delta
    year, month0 = divmod(month_idx, 12)
    return datetime(year, month0 + 1, 1, tzinfo=timezone.utc)
