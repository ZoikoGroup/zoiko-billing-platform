"""
billing/tasks/escalation_to_collections.py
---------------------------------------------
Automatic dunning-to-collections escalation job.

BillingConfiguration.enable_escalation_to_collections and .collections_wait_days
have existed on the config model/API since before this phase, but nothing
ever consumed them — a DunningCase could sit ACTIVE indefinitely no matter
how overdue its invoice became. This job is the missing automation: once an
active dunning case's invoice has been overdue longer than the org's
configured collections_wait_days, it opens a CollectionsCase for it (via the
existing CollectionService, no new business logic duplicated) and marks the
DunningCase ESCALATED.

Runs on a configurable interval (default: daily), mirroring
tasks/dunning_process.py. Each organisation, and each case within it, is
processed independently — failures are isolated.
"""

import logging
import time
from datetime import datetime
from typing import Any, Dict

from app.database import SessionLocal
from app.modules.billing.repositories.settings import BillingConfigurationRepository
from app.modules.billing.utils.date_utils import days_overdue as compute_days_overdue

logger = logging.getLogger("zoiko")

SYSTEM_USER_ID = None


def run_escalation_to_collections_job() -> Dict[str, Any]:
    """Entry point called by APScheduler. Returns a summary dict for observability."""
    start_time = time.monotonic()
    logger.info("[SCHEDULER] Escalation-to-collections job started")

    summary = {
        "started_at": datetime.utcnow().isoformat(),
        "organisations_checked": 0,
        "cases_escalated": 0,
        "errors": [],
    }

    db = SessionLocal()
    try:
        from app.modules.billing.models import Organization

        org_ids = [row[0] for row in db.query(Organization.id).all()]
        summary["organisations_checked"] = len(org_ids)
        config_repo = BillingConfigurationRepository(db)

        for org_id in org_ids:
            try:
                config = config_repo.get_by_organization(org_id)
                if not config or not getattr(config, "enable_escalation_to_collections", False):
                    continue
                wait_days = getattr(config, "collections_wait_days", 30) or 30
                escalated = _escalate_org_cases(db, org_id, wait_days)
                summary["cases_escalated"] += escalated
            except Exception as exc:
                error_msg = f"Org {org_id}: {exc}"
                summary["errors"].append(error_msg)
                logger.error("[SCHEDULER] Escalation-to-collections failed for org %d: %s", org_id, exc, exc_info=True)
                try:
                    db.rollback()
                except Exception:
                    pass

    except Exception as exc:
        logger.error("[SCHEDULER] Fatal error in escalation-to-collections job: %s", exc, exc_info=True)
        summary["errors"].append(str(exc))
    finally:
        db.close()

    elapsed = time.monotonic() - start_time
    summary["duration_seconds"] = round(elapsed, 3)
    logger.info(
        "[SCHEDULER] Escalation-to-collections job completed in %.3fs — orgs=%d, escalated=%d, errors=%d",
        elapsed, summary["organisations_checked"], summary["cases_escalated"], len(summary["errors"]),
    )
    return summary


def _escalate_org_cases(db, organization_id: int, wait_days: int) -> int:
    from app.modules.billing.services.collection_service import CollectionService
    from app.modules.billing.services.dunning_service import DunningService

    dunning_svc = DunningService(db)
    collection_svc = CollectionService(db)

    escalated_count = 0
    for case in dunning_svc.case_repo.list_active_cases(organization_id):
        try:
            invoice = dunning_svc.invoice_repo.get_by_id(case.invoice_id, organization_id)
            if compute_days_overdue(invoice.due_date) < wait_days:
                continue

            existing = collection_svc.repo.get_by_invoice_open(organization_id, case.invoice_id)
            if existing is not None:
                # Already being worked in collections — just mark the dunning
                # case escalated so its own status reflects reality.
                dunning_svc.mark_escalated(case.id, organization_id, reason="Invoice already has an open collections case")
                continue

            case_number = f"COL-{invoice.invoice_number}"
            if collection_svc.repo.exists(organization_id, case_number=case_number):
                case_number = f"{case_number}-{case.id}"

            collections_case = collection_svc.open_case(
                organization_id=organization_id,
                customer_id=case.customer_id,
                invoice_id=case.invoice_id,
                case_number=case_number,
                created_by=SYSTEM_USER_ID,
                priority="high",
                notes=f"Auto-escalated from dunning case #{case.id} after {wait_days}+ days overdue",
            )
            try:
                collection_svc.send_past_due_notice(collections_case.id, organization_id, updated_by=SYSTEM_USER_ID)
            except Exception as exc:
                # The notice is best-effort — the escalation itself already
                # succeeded; a mail failure must not roll the case back.
                logger.error(
                    "[SCHEDULER] Failed to send past-due notice for escalated case %d (org %d): %s",
                    case.id, organization_id, exc,
                )
            dunning_svc.mark_escalated(
                case.id, organization_id,
                reason=f"Escalated to collections after exceeding {wait_days}-day wait period",
            )
            escalated_count += 1
            logger.info(
                "[SCHEDULER] Org %d: dunning case %d escalated to collections (invoice %s)",
                organization_id, case.id, invoice.invoice_number,
            )
        except Exception as exc:
            logger.error(
                "[SCHEDULER] Failed to escalate dunning case %d (org %d): %s",
                case.id, organization_id, exc, exc_info=True,
            )
            try:
                db.rollback()
            except Exception:
                pass

    return escalated_count
