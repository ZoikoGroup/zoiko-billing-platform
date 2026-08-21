"""
modules/super_admin/telemetry_service.py
------------------------------------------
Domain C (Tenant Telemetry) — cross-tenant OPERATIONAL health only.

Hard rule (ZB-SA-CMD-003 §8): this module returns counts, rates, timings and
health classifications and MUST NEVER return a monetary amount, a
per-tenant financial breakdown, or anything that could be summed into a
cross-tenant revenue/balance figure. Nothing here reads the billing
module's Invoice/Payment tables — organization lifecycle counts come from
Organization.is_active (no money), and job health comes from JobRunLog
(no tenant identifiers at all, no money).

Deliberately does NOT report "queue age" or "connector state" — this
codebase has no message queue and no payment-gateway connector abstraction
today, and inventing plausible-looking numbers for either would violate the
spec's "no fake metrics" law more than simply omitting them.
"""

from datetime import datetime, timedelta
from typing import Any, Dict, List

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.modules.organizations.models import Organization
from app.modules.super_admin.freshness import compute_freshness
from app.modules.super_admin.models import JobRunLog, JobRunStatus


class TelemetryService:
    def __init__(self, db: Session):
        self.db = db

    def get_organization_health(self) -> Dict[str, Any]:
        total = self.db.query(Organization).count()
        active = self.db.query(Organization).filter(Organization.is_active == True).count()  # noqa: E712
        suspended = total - active
        return {
            "total_organizations": total,
            "active_organizations": active,
            "suspended_organizations": suspended,
        }

    def get_job_health(self) -> List[Dict[str, Any]]:
        """One row per distinct job_name seen in JobRunLog, with its most
        recent run and a 24h failure count. An empty list is the honest
        answer when the scheduler has never run (e.g.
        ENABLE_RECURRING_BILLING_SCHEDULER=false) — never backfilled with a
        fabricated 'healthy' placeholder."""
        job_names = [row[0] for row in self.db.query(JobRunLog.job_name).distinct().all()]
        since_24h = datetime.utcnow() - timedelta(hours=24)

        results = []
        for job_name in sorted(job_names):
            latest = (
                self.db.query(JobRunLog)
                .filter(JobRunLog.job_name == job_name)
                .order_by(JobRunLog.started_at.desc())
                .first()
            )
            failure_count_24h = (
                self.db.query(func.count(JobRunLog.id))
                .filter(
                    JobRunLog.job_name == job_name,
                    JobRunLog.status == JobRunStatus.FAILED,
                    JobRunLog.started_at >= since_24h,
                )
                .scalar()
                or 0
            )
            run_count_24h = (
                self.db.query(func.count(JobRunLog.id))
                .filter(JobRunLog.job_name == job_name, JobRunLog.started_at >= since_24h)
                .scalar()
                or 0
            )

            from app.core.scheduler import get_job_interval_minutes

            interval_minutes = get_job_interval_minutes(job_name)
            interval_seconds = interval_minutes * 60 if interval_minutes else None
            freshness_state, age_seconds = compute_freshness(
                latest.started_at if latest else None, interval_seconds
            )

            results.append(
                {
                    "job_name": job_name,
                    "display_name": latest.display_name if latest else None,
                    "last_status": latest.status.value if latest else None,
                    "last_started_at": latest.started_at if latest else None,
                    "last_finished_at": latest.finished_at if latest else None,
                    "last_error": latest.error_message if latest and latest.status == JobRunStatus.FAILED else None,
                    "run_count_24h": run_count_24h,
                    "failure_count_24h": failure_count_24h,
                    "freshness": freshness_state.value,
                    "freshness_age_seconds": age_seconds,
                    "expected_interval_minutes": interval_minutes,
                }
            )
        return results
