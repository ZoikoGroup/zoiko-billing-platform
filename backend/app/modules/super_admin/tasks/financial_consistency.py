"""
modules/super_admin/tasks/financial_consistency.py
----------------------------------------------------
Domain C scheduled job (ZB-SA-CMD-003 §8/§15): run the internal financial
consistency check on a cadence and feed failures into the Attention Engine
at the P0 severity floor. Registered in core/scheduler.py's job definitions;
executed through _tracked_job_runner so every run is itself recorded in
JobRunLog (a failing check therefore surfaces twice: as the job's own
telemetry AND as the P0 financial-integrity attention item).
"""

import logging

logger = logging.getLogger("zoiko_billing.super_admin.financial_consistency")


def run_financial_consistency_job() -> None:
    from app.database import SessionLocal
    from app.modules.super_admin.financial_consistency_service import FinancialConsistencyService

    db = SessionLocal()
    try:
        result = FinancialConsistencyService(db).run_scheduled_check()
        db.commit()
        logger.info(
            "Financial consistency check complete: state=%s over_allocated=%d",
            result["state"], result["over_allocated_count"],
        )
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()
