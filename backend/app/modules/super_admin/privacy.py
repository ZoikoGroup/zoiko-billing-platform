"""
modules/super_admin/privacy.py
------------------------------
ZB-SEC-PRIV-001 — shared privacy helpers for the Super Admin (platform) API.

A platform operator may see, per tenant: tenant id/name, plan, counts, totals
per currency, aging buckets, status counts and failure-reason categories.
They never see customer names/ids/emails, document numbers, or any other
identifier of an individual record. Record detail is reachable only through
the privileged access grant.

Small-cell suppression
----------------------
Any count (and the amount computed over the same records) whose value is
strictly between 0 and MIN_CELL_SIZE is masked, because a tiny cell can
identify an individual customer. Zero stays zero.

How a masked value appears in a response
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
* Scalar count field ``<name>``: ``<name>`` is ``null`` and a sibling
  ``<name>_label`` holds ``"fewer than 5"`` (it is ``null`` when unmasked).
  e.g. ``{"failed_count": null, "failed_count_label": "fewer than 5"}``.
* A count cell inside a dict (``count_by_status``, ``case_count_by_stage``,
  ``exception_count_by_type``): ``{"count": null, "count_label": "fewer than 5"}``.
* A per-currency total cell (``*_total_by_currency`` / ``total_by_currency``):
  ``{"count": null, "count_label": "fewer than 5", "amount": null}``; an
  unmasked cell is ``{"count": 12, "count_label": null, "amount": "345.00"}``.
Amounts are decimal strings and are never summed across currencies.
"""

from decimal import Decimal
from typing import Any, Dict, Iterable, Optional, Tuple

from app.config import settings

MIN_CELL_SIZE: int = int(getattr(settings, "PLATFORM_MIN_CELL_SIZE", 5) or 5)


def _min_cell_size() -> int:
    # Read live so a settings override (or test monkeypatch) takes effect.
    return int(getattr(settings, "PLATFORM_MIN_CELL_SIZE", MIN_CELL_SIZE) or MIN_CELL_SIZE)


def small_cell_label() -> str:
    return f"fewer than {_min_cell_size()}"


# Field names that identify an individual end-customer or record. No
# /api/super-admin response model may declare any of these.
FORBIDDEN_FIELD_NAMES = frozenset(
    {
        "customer_name",
        "customer_id",
        "customer_email",
        "invoice_id",
        "invoice_number",
        "payment_id",
        "payment_number",
        "credit_note_number",
        "refund_number",
        "bank_account",
        "iban",
        "card_last4",
        "contract_number",
        "quote_number",
    }
)


def is_small_cell(count: Optional[int]) -> bool:
    return count is not None and 0 < int(count) < _min_cell_size()


def mask_small_cell(count: Optional[int], amount: Any = None) -> Dict[str, Any]:
    """Return ``{"count", "count_label", "amount"}`` for one aggregate cell."""
    n = int(count or 0)
    if 0 < n < _min_cell_size():
        return {"count": None, "count_label": small_cell_label(), "amount": None}
    return {
        "count": n,
        "count_label": None,
        "amount": None if amount is None else str(amount),
    }


def masked_count(name: str, count: Optional[int]) -> Dict[str, Any]:
    """``{name: n | None, name_label: str | None}`` — spread into a row dict."""
    cell = mask_small_cell(count)
    return {name: cell["count"], f"{name}_label": cell["count_label"]}


def count_cells(counts: Dict[str, int]) -> Dict[str, Dict[str, Any]]:
    """{key: count} -> {key: {"count", "count_label"}} with masking."""
    out: Dict[str, Dict[str, Any]] = {}
    for key, count in counts.items():
        cell = mask_small_cell(count)
        out[key] = {"count": cell["count"], "count_label": cell["count_label"]}
    return out


def currency_totals(rows: Iterable[Tuple[Optional[str], int, Any]]) -> Dict[str, Dict[str, Any]]:
    """(currency, record_count, amount) tuples -> per-currency masked cells.
    Rows sharing a currency are merged; currencies are never combined."""
    merged: Dict[str, list] = {}
    for currency, count, amount in rows:
        code = currency or "UNKNOWN"
        slot = merged.setdefault(code, [0, Decimal("0")])
        slot[0] += int(count or 0)
        slot[1] += Decimal(str(amount or 0))
    return {code: mask_small_cell(n, amt) for code, (n, amt) in sorted(merged.items())}
