import logging
from datetime import date, datetime
from typing import Any, Dict, Optional, Set

from sqlalchemy.orm import Session

from app.modules.billing.models import NumberFormat, SequenceReset

logger = logging.getLogger("zoiko_billing")


def safe_commit(db: Session) -> None:
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise


def safe_commit_and_refresh(db: Session, *objs: Any) -> None:
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    for obj in objs:
        db.refresh(obj)


def filter_allowed(data: Dict[str, Any], allowed: Set[str], drop_none: bool = True) -> Dict[str, Any]:
    return {
        k: v
        for k, v in data.items()
        if k in allowed and (not drop_none or v is not None)
    }


# ── Document numbering ──────────────────────────────────────────────────────
# Shared by invoice/credit-note/refund numbering (previously duplicated
# near-verbatim in each service's own _generate_*_number()). Each caller keeps
# resolving its own prefix/format/reset config fields and its own count query
# (those differ slightly between document types, e.g. invoices additionally
# filter by is_active) — only the date-window arithmetic and the
# prefix+date+sequence template rendering, which were byte-identical across
# all three, are centralized here.

def sequence_window_start(now: datetime, sequence_reset) -> Optional[date]:
    """Start-of-window date for a document numbering sequence-reset policy.

    Returns a plain `date` (not `datetime`) because it is compared directly
    against, and assigned to, DocumentSequence.window_start — a Date column.
    A `date` and a `datetime` representing the same calendar day are never
    considered equal in Python, so returning a `datetime` here previously
    made every `row.window_start != window_start` comparison evaluate True
    unconditionally as soon as `row` had been reloaded from the database
    (whose Date column always yields a plain `date`) — silently resetting
    last_number back to 0 on every call after the first and producing a
    duplicate sequence number for the very next document of that type.
    """
    if sequence_reset == SequenceReset.MONTHLY:
        return now.date().replace(day=1)
    if sequence_reset == SequenceReset.QUARTERLY:
        quarter = (now.month - 1) // 3 + 1
        return now.date().replace(month=(quarter - 1) * 3 + 1, day=1)
    if sequence_reset == SequenceReset.ANNUALLY:
        return now.date().replace(month=1, day=1)
    return None  # NEVER


def render_document_number(
    prefix: str,
    number_format,
    sequence_number: int,
    now: datetime,
    also_replace_year_month: bool = False,
) -> str:
    """Render a prefix+date+zero-padded-sequence document number.

    also_replace_year_month preserves invoice numbering's historical extra
    {YYYY}/{MM} token substitution (a no-op unless a custom prefix literally
    contains those tokens) — credit notes and refunds never performed this
    substitution, so they must keep calling this with the default False.
    """
    year = now.strftime("%Y")
    month = now.strftime("%m")
    seq = str(sequence_number).zfill(5)

    fmt_map = {
        NumberFormat.PREFIX_SEQ: f"{prefix}{{SEQ}}",
        NumberFormat.PREFIX_YYYY_SEQ: f"{prefix}{year}-{{SEQ}}",
        NumberFormat.PREFIX_YYYYMM_SEQ: f"{prefix}{year}{month}-{{SEQ}}",
        NumberFormat.PREFIX_YYYY_MM_SEQ: f"{prefix}{year}-{month}-{{SEQ}}",
        NumberFormat.PREFIX_MM_YYYY_SEQ: f"{prefix}{month}-{year}-{{SEQ}}",
    }
    template = fmt_map.get(number_format, f"{prefix}{year}-{{SEQ}}")
    result = template.replace("{SEQ}", seq)
    if also_replace_year_month:
        result = result.replace("{YYYY}", year).replace("{MM}", month)
    return result
