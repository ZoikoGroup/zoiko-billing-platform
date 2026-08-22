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

    # ── Phase 3D: per-tenant operational health overview ─────────────────────

    def get_tenant_health_overview(self) -> Dict[str, Any]:
        """Fleet-wide Domain C read model: one OPERATIONAL row per organization.

        Purity guarantees (ZB-SA-CMD-003 §8): every value is an identity, a
        count, a state or a timestamp. No monetary amounts, no commercial
        account/subscription fields, no derived "health score" — evidence
        counts are reported as-is.
        """
        from app.modules.super_admin.models import AttentionItem, AttentionSeverity, AttentionStatus
        from app.modules.organizations.models import TenantLifecycleState
        from app.modules.super_admin.lifecycle_service import TenantLifecycleService
        from app.modules.super_admin.organization_service import OrganizationDirectoryService

        open_statuses = [
            AttentionStatus.OPEN,
            AttentionStatus.ACKNOWLEDGED,
            AttentionStatus.ASSIGNED,
            AttentionStatus.MITIGATING,
            AttentionStatus.MONITORING,
        ]

        lifecycle = TenantLifecycleService(self.db)
        directory = OrganizationDirectoryService(self.db)

        orgs = (
            self.db.query(Organization).order_by(Organization.created_at.desc()).all()
        )
        org_ids = [org.id for org in orgs]

        user_counts = directory._user_counts(org_ids)
        incident_counts = directory._open_incident_counts(org_ids)
        activity_map = directory._last_activity_map(org_ids)

        # Open-severity evidence per org: worst open severity + latest open
        # incident timestamp, straight from AttentionItem rows.
        severity_rank = {sev: idx for idx, sev in enumerate(AttentionSeverity)}
        open_rows = (
            self.db.query(
                AttentionItem.organization_id,
                AttentionItem.severity,
                func.max(AttentionItem.last_seen_at),
                func.count(AttentionItem.id),
            )
            .filter(
                AttentionItem.organization_id.in_(org_ids),
                AttentionItem.status.in_(open_statuses),
            )
            .group_by(AttentionItem.organization_id, AttentionItem.severity)
            .all()
            if org_ids
            else []
        )
        worst_severity: Dict[int, str] = {}
        last_incident_at: Dict[int, Any] = {}
        for org_id, severity, latest_seen, _count in open_rows:
            if org_id is None:
                continue
            current = worst_severity.get(org_id)
            if current is None or severity_rank.get(severity, 99) < severity_rank.get(
                AttentionSeverity(current), 99
            ):
                worst_severity[org_id] = severity.value if hasattr(severity, "value") else str(severity)
            existing = last_incident_at.get(org_id)
            if existing is None or (latest_seen is not None and latest_seen > existing):
                last_incident_at[org_id] = latest_seen

        counts_by_lifecycle_state = {state.value: 0 for state in TenantLifecycleState}
        rows = []
        for org in orgs:
            state = lifecycle.effective_state(org)
            counts_by_lifecycle_state[state.value] = counts_by_lifecycle_state.get(state.value, 0) + 1
            counts = user_counts.get(org.id, {})
            rows.append(
                {
                    "id": org.id,
                    "organization_code": org.organization_code,
                    "organization_name": org.organization_name,
                    "lifecycle_state": state.value,
                    "total_users": counts.get("total", 0),
                    "active_users": counts.get("active", 0),
                    "suspended_users": counts.get("suspended", 0),
                    "unverified_users": counts.get("unverified", 0),
                    "org_admins": counts.get("org_admins", 0),
                    "open_incident_count": incident_counts.get(org.id, 0),
                    "worst_open_severity": worst_severity.get(org.id),
                    "last_incident_at": last_incident_at.get(org.id),
                    "last_activity_at": activity_map.get(org.id),
                    "plane": "TENANT",
                }
            )

        jobs = self.get_job_health()
        return {
            "summary": {
                "total_organizations": len(orgs),
                "counts_by_lifecycle_state": counts_by_lifecycle_state,
                "open_incident_total": sum(incident_counts.values()),
                "jobs_tracked": len(jobs),
                "jobs_with_failures_24h": sum(1 for j in jobs if j["failure_count_24h"] > 0),
                "jobs_not_fresh": sum(1 for j in jobs if j["freshness"] != "fresh"),
            },
            "organizations": rows,
            "generated_at": datetime.utcnow(),
            "plane": "PLATFORM",
        }
