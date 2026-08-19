"""
billing/tasks/overdue_invoices.py
----------------------------------
Automatic overdue-invoice detection job.

InvoiceService.mark_overdue() has existed since the invoice lifecycle was
built (SENT/PARTIALLY_PAID -> OVERDUE is an already-validated transition in
InvoiceService._validate_status_transition), but nothing ever called it —
invoices could never reach OVERDUE, which meant the dunning/collections
engines could never find anything to act on. This job is the missing caller;
it does not add any new dunning/collections behaviour.

Runs on a configurable interval (default: every hour), mirroring
tasks/recurring_billing.py.
Processes ALL organisations in a single pass.
Each invoice is processed independently — failures are isolated.
"""

import logging
import time
from datetime import date, datetime
from typing import Any, Dict, List

from app.database import SessionLocal
from app.modules.billing.models import Invoice, InvoiceStatus

logger = logging.getLogger("zoiko_billing")

SYSTEM_USER_ID = None

# Invoices in these statuses are the only ones InvoiceService allows
# transitioning to OVERDUE (see InvoiceService._validate_status_transition).
_OVERDUE_ELIGIBLE_STATUSES = [InvoiceStatus.SENT, InvoiceStatus.PARTIALLY_PAID]


def run_overdue_invoice_job() -> Dict[str, Any]:
    """
    Entry point called by APScheduler.

    Marks OVERDUE any SENT/PARTIALLY_PAID invoice whose due_date has passed,
    across ALL organisations. Returns a summary dict for observability.
    """
    start_time = time.monotonic()
    logger.info("[SCHEDULER] Overdue invoice job started")

    summary = {
        "started_at": datetime.utcnow().isoformat(),
        "organisations_processed": 0,
        "total_invoices_found": 0,
        "total_marked_overdue": 0,
        "total_failed": 0,
        "errors": [],
    }

    db = SessionLocal()
    try:
        due_invoices_by_org = _find_all_invoices_due_for_overdue(db)
        summary["organisations_processed"] = len(due_invoices_by_org)
        summary["total_invoices_found"] = sum(
            len(invoices) for invoices in due_invoices_by_org.values()
        )

        for org_id, invoices in due_invoices_by_org.items():
            org_result = _process_org_invoices(db, org_id, invoices)
            summary["total_marked_overdue"] += org_result["marked_overdue"]
            summary["total_failed"] += org_result["failed"]
            summary["errors"].extend(org_result["errors"])

    except Exception as exc:
        logger.error("[SCHEDULER] Fatal error in overdue invoice job: %s", exc, exc_info=True)
        summary["errors"].append(str(exc))
    finally:
        db.close()

    elapsed = time.monotonic() - start_time
    summary["duration_seconds"] = round(elapsed, 3)

    logger.info(
        "[SCHEDULER] Overdue invoice job completed in %.3fs — "
        "orgs=%d, found=%d, marked_overdue=%d, failed=%d",
        elapsed,
        summary["organisations_processed"],
        summary["total_invoices_found"],
        summary["total_marked_overdue"],
        summary["total_failed"],
    )
    return summary


def _find_all_invoices_due_for_overdue(db) -> Dict[int, List[Invoice]]:
    """
    Find all invoices across ALL organisations that should transition to OVERDUE.

    Query criteria:
      - is_active = True
      - status IN (SENT, PARTIALLY_PAID)
      - due_date IS NOT NULL
      - due_date < today (UTC) — an invoice due today is not yet overdue.

    Returns dict keyed by organization_id.
    """
    today = date.today()
    rows = (
        db.query(Invoice)
        .filter(
            Invoice.is_active == True,
            Invoice.status.in_(_OVERDUE_ELIGIBLE_STATUSES),
            Invoice.due_date.isnot(None),
            Invoice.due_date < today,
        )
        .all()
    )

    by_org: Dict[int, List[Invoice]] = {}
    for inv in rows:
        by_org.setdefault(inv.organization_id, []).append(inv)
    return by_org


def _process_org_invoices(db, organization_id: int, invoices: List[Invoice]) -> Dict[str, Any]:
    """
    Mark overdue all due invoices for one organisation.

    Each invoice is processed independently. Failures are caught and logged —
    they do NOT stop other invoices in the same batch.
    """
    from app.modules.billing.services.invoice_service import InvoiceService

    result = {"marked_overdue": 0, "failed": 0, "errors": []}

    for inv in invoices:
        try:
            svc = InvoiceService(db)
            svc.mark_overdue(
                invoice_id=inv.id,
                organization_id=organization_id,
                updated_by=SYSTEM_USER_ID,
            )
            result["marked_overdue"] += 1
            logger.info(
                "[SCHEDULER] Marked invoice %s (org %d) OVERDUE (due_date=%s)",
                inv.invoice_number, organization_id, inv.due_date,
            )
        except Exception as exc:
            result["failed"] += 1
            error_msg = f"Invoice {inv.id} (org {organization_id}): {exc}"
            result["errors"].append(error_msg)
            logger.error(
                "[SCHEDULER] Failed to mark invoice %d (org %d) overdue: %s",
                inv.id, organization_id, exc,
                exc_info=True,
            )
            try:
                db.rollback()
            except Exception:
                pass

    return result
