"""
modules/super_admin/tasks/reconciliation.py
-------------------------------------------
REC-01 scheduled job: execute the ledger reconciliation engine on a cadence
and feed failures into the Attention Engine at P1. Registered in
core/scheduler.py's job definitions; executed through _tracked_job_runner so
every run is itself recorded in JobRunLog.
"""

import logging

logger = logging.getLogger("zoiko_billing.super_admin.reconciliation")


def run_reconciliation_job() -> None:
    from app.database import SessionLocal
    from app.modules.super_admin.reconciliation_service import ReconciliationService

    db = SessionLocal()
    try:
        service = ReconciliationService(db)
        run = service.run_reconciliation(trigger="scheduled")
        service.report_to_attention_engine(run)
        db.commit()
        logger.info(
            "Ledger reconciliation complete: run=%s state=%s exceptions=%d",
            run.id, run.state.value if hasattr(run.state, "value") else run.state,
            run.exceptions_found,
        )
    except Exception:
        db.rollback()
        logger.exception("Ledger reconciliation job failed")
        raise
    finally:
        db.close()
