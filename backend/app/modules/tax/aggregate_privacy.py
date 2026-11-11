"""
app/modules/tax/aggregate_privacy.py
------------------------------------
One rule for platform aggregates (ZB-TAX-ARCH-001 Phase 8 PR 4 fix B, shared
by the Phase 8 findings burn-down): when fewer than SMALL_POPULATION (3)
organizations are affected, platform views and alerts show amounts as
magnitude bands instead of exact figures; counts stay exact. Tenant reports
are unaffected. Every platform surface that shows money uses this module so
the rule can't drift.
"""
from decimal import Decimal, InvalidOperation
from typing import Iterable

SMALL_POPULATION = 3
BANDS = ((Decimal("1000"), "< 1k"), (Decimal("10000"), "1k–10k"), (Decimal("100000"), "10k–100k"))


def _dec(value) -> Decimal:
    try:
        return Decimal(str(value)) if value is not None else Decimal("0")
    except (InvalidOperation, ValueError):
        return Decimal("0")


def band(amount) -> str:
    value = abs(_dec(amount))
    for limit, label in BANDS:
        if value < limit:
            return label
    return "> 100k"


def small(organizations_affected: int) -> bool:
    return (organizations_affected or 0) < SMALL_POPULATION


def amounts_note(organizations_affected: int) -> str:
    return f"banded (fewer than {SMALL_POPULATION} organizations)" if small(organizations_affected) else "exact"


def band_rows(organizations_affected: int, rows: Iterable[dict], amount_keys: Iterable[str]) -> list:
    """Rows with their amount keys banded when the population is small."""
    rows = [dict(r) for r in rows]
    if not small(organizations_affected):
        return rows
    for row in rows:
        for key in amount_keys:
            if key in row:
                row[key] = band(row[key])
    return rows


def band_net(value) -> str:
    net = _dec(value)
    return f"{band(net)} ({'over' if net > 0 else 'under' if net < 0 else 'none'})"
