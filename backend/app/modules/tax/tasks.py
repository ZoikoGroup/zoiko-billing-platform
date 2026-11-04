"""
app/modules/tax/tasks.py
------------------------
Scheduled job (daily): flag expiring/expired tax registrations, exemption
certificates and tax-ID verifications for tenant review (ZB-TAX-ARCH-001
T14). Registered in app/core/scheduler.py, so the shared runner records a
JobRunLog and raises a platform AttentionItem only if the job itself fails —
the review items it creates are tenant-private.
"""

import logging

logger = logging.getLogger("zoiko_billing.tax.review_sweep")


def run_tax_review_sweep_job() -> None:
    from app.config import settings
    from app.database import SessionLocal
    from app.modules.tax.review_service import TaxReviewService

    db = SessionLocal()
    try:
        created = TaxReviewService(db).sweep(window_days=settings.TAX_REVIEW_EXPIRY_WINDOW_DAYS)
        db.commit()
        if created:
            logger.info("Created %d tax review item(s)", created)
    except Exception:
        db.rollback()
        logger.exception("Tax review sweep failed")
        raise
    finally:
        db.close()
