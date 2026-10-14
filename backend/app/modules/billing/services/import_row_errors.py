"""User-safe per-row error text for the CSV/XLSX import services.

Validation problems (ZoikoException, ValueError, pydantic ValidationError) are
written for users and are returned as-is. Anything else (IntegrityError,
OperationalError, ...) can embed SQL statements, parameters or file paths, so
it is logged with the row number and replaced by a generic message.
"""
import logging

from pydantic import ValidationError

from app.core.exceptions import ZoikoException

logger = logging.getLogger("zoiko_billing")

GENERIC_ROW_ERROR = "This row could not be saved. Please check its values and try again."


def _humanize(loc) -> str:
    parts = [str(p) for p in (loc or ()) if isinstance(p, str)]
    return parts[-1].replace("_", " ").capitalize() if parts else ""


def row_error_message(exc: Exception, row: int, entity: str) -> str:
    if isinstance(exc, ZoikoException):
        return exc.message
    if isinstance(exc, ValidationError):
        msgs = []
        for err in exc.errors():
            field = _humanize(err.get("loc"))
            msg = str(err.get("msg", "is invalid")).removeprefix("Value error, ")
            msgs.append(f"{field}: {msg}" if field else msg)
        return "; ".join(msgs) or GENERIC_ROW_ERROR
    if isinstance(exc, ValueError):
        return str(exc)
    logger.exception("%s import: row %s failed", entity, row)
    return GENERIC_ROW_ERROR
