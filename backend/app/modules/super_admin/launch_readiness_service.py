"""
modules/super_admin/launch_readiness_service.py
----------------------------------------------------
ZB-SA-CMD-003 §23 / this session's Phase 14 — Launch Readiness.

Every item here runs a REAL check against real config/DB/service state.
None are hardcoded PASS. Where a check cannot be performed honestly in
this environment (accessibility, performance), the item reports UNKNOWN
with an explanation — never a fabricated PASS.

This is deliberately NOT the pre-existing `/production-acceptance`
endpoint (ProductionAcceptancePage / production_acceptance() in
router.py) — that endpoint evaluates the ZB-COM-BILL-001 commercial
acceptance checklist (mixes Plane 1/2 criteria: pricing catalog, trial
policy, PCI scope). This module evaluates whether the Command Center
ITSELF (the operational control plane — DB, auth, MFA, audit, scheduler,
security config) is in a launchable state. The two overlap in spirit but
answer different questions; see SUPER_ADMIN_ARCHITECTURE.md.
"""

from typing import Any, Dict, List

from sqlalchemy.orm import Session


class ReadinessStatus:
    PASS = "PASS"
    FAIL = "FAIL"
    WARNING = "WARNING"
    UNKNOWN = "UNKNOWN"


class LaunchReadinessService:
    def __init__(self, db: Session):
        self.db = db

    def evaluate(self) -> Dict[str, Any]:
        items: List[Dict[str, Any]] = [
            self._check_database(),
            self._check_secrets(),
            self._check_mfa_encryption(),
            self._check_super_admin_mfa_enrollment(),
            self._check_audit_logging(),
            self._check_scheduler(),
            self._check_cors(),
            self._check_attention_queue(),
            self._check_financial_consistency(),
            self._check_accessibility(),
            self._check_performance(),
        ]
        statuses = {item["status"] for item in items}
        if ReadinessStatus.FAIL in statuses:
            overall = ReadinessStatus.FAIL
        elif ReadinessStatus.WARNING in statuses or ReadinessStatus.UNKNOWN in statuses:
            overall = ReadinessStatus.WARNING
        else:
            overall = ReadinessStatus.PASS
        return {"overall_status": overall, "items": items}

    def _item(self, id_, criterion, status, evidence):
        return {"id": id_, "criterion": criterion, "status": status, "evidence": evidence}

    def _check_database(self) -> Dict[str, Any]:
        from app.database import check_connection

        ok = check_connection()
        return self._item(
            "DB-01", "Database connectivity",
            ReadinessStatus.PASS if ok else ReadinessStatus.FAIL,
            "check_connection() succeeded." if ok else "check_connection() failed — database unreachable.",
        )

    def _check_secrets(self) -> Dict[str, Any]:
        from app.config import settings

        insecure_default = "change-me-billing-platform-secret"
        if settings.BILLING_SECRET_KEY == insecure_default:
            return self._item(
                "SEC-CFG-01", "JWT signing secret is not the insecure default",
                ReadinessStatus.FAIL,
                "BILLING_SECRET_KEY is still the shipped placeholder value — every issued token is forgeable by anyone reading the source.",
            )
        if settings.DEBUG:
            return self._item(
                "SEC-CFG-01", "JWT signing secret is not the insecure default",
                ReadinessStatus.WARNING,
                "BILLING_SECRET_KEY has been changed from the default, but DEBUG=true (development mode).",
            )
        return self._item(
            "SEC-CFG-01", "JWT signing secret is not the insecure default",
            ReadinessStatus.PASS, "BILLING_SECRET_KEY has been changed from the default; DEBUG=false.",
        )

    def _check_mfa_encryption(self) -> Dict[str, Any]:
        from app.config import settings

        if settings.MFA_ENCRYPTION_KEY:
            return self._item(
                "SEC-CFG-02", "MFA secret encryption key configured",
                ReadinessStatus.PASS, "MFA_ENCRYPTION_KEY is set.",
            )
        if settings.DEBUG:
            return self._item(
                "SEC-CFG-02", "MFA secret encryption key configured",
                ReadinessStatus.WARNING,
                "MFA_ENCRYPTION_KEY is unset; a non-production-safe key derived from BILLING_SECRET_KEY is in use (DEBUG mode only — see core/mfa_crypto.py).",
            )
        return self._item(
            "SEC-CFG-02", "MFA secret encryption key configured",
            ReadinessStatus.FAIL,
            "MFA_ENCRYPTION_KEY is unset and DEBUG=false — the app would refuse to encrypt/decrypt any MFA secret (core/mfa_crypto.py fails closed).",
        )

    def _check_super_admin_mfa_enrollment(self) -> Dict[str, Any]:
        from app.modules.auth.models import SuperAdminMFA, User, UserRole

        total_super_admins = self.db.query(User).filter(User.role == UserRole.SUPER_ADMIN, User.is_active == True).count()  # noqa: E712
        enrolled = (
            self.db.query(SuperAdminMFA)
            .join(User, User.id == SuperAdminMFA.user_id)
            .filter(User.role == UserRole.SUPER_ADMIN, User.is_active == True, SuperAdminMFA.is_enabled == True)  # noqa: E712
            .count()
        )
        if total_super_admins == 0:
            return self._item(
                "SEC-MFA-01", "All active Super Admins have MFA enabled for step-up",
                ReadinessStatus.UNKNOWN, "No active Super Admin accounts exist yet.",
            )
        if enrolled == total_super_admins:
            return self._item(
                "SEC-MFA-01", "All active Super Admins have MFA enabled for step-up",
                ReadinessStatus.PASS, f"{enrolled}/{total_super_admins} active Super Admins have MFA enabled for step-up.",
            )
        return self._item(
            "SEC-MFA-01", "All active Super Admins have MFA enabled for step-up",
            ReadinessStatus.WARNING, f"Only {enrolled}/{total_super_admins} active Super Admins have MFA enabled for step-up.",
        )

    def _check_audit_logging(self) -> Dict[str, Any]:
        from app.modules.super_admin.models import PlatformAuditLog

        try:
            self.db.query(PlatformAuditLog.id).limit(1).all()
            return self._item(
                "GOV-AUDIT-01", "Platform audit log is reachable",
                ReadinessStatus.PASS, "PlatformAuditLog table query succeeded.",
            )
        except Exception as exc:
            return self._item(
                "GOV-AUDIT-01", "Platform audit log is reachable",
                ReadinessStatus.FAIL, f"Query failed: {exc}",
            )

    def _check_scheduler(self) -> Dict[str, Any]:
        from app.config import settings
        from app.modules.super_admin.telemetry_service import TelemetryService

        if not settings.ENABLE_RECURRING_BILLING_SCHEDULER:
            return self._item(
                "REL-SCHED-01", "Recurring billing scheduler",
                ReadinessStatus.WARNING,
                "ENABLE_RECURRING_BILLING_SCHEDULER=false — no dunning/recurring-billing/overdue-invoice jobs run automatically. May be intentional for early-stage/manual operation.",
            )
        jobs = TelemetryService(self.db).get_job_health()
        unhealthy = [j for j in jobs if j["last_status"] == "failed" or j["freshness"] == "unknown"]
        if not jobs:
            return self._item(
                "REL-SCHED-01", "Recurring billing scheduler",
                ReadinessStatus.UNKNOWN, "Scheduler enabled but no job runs recorded yet.",
            )
        if unhealthy:
            return self._item(
                "REL-SCHED-01", "Recurring billing scheduler",
                ReadinessStatus.WARNING, f"{len(unhealthy)}/{len(jobs)} jobs failed or stale/unknown: {[j['job_name'] for j in unhealthy]}.",
            )
        return self._item(
            "REL-SCHED-01", "Recurring billing scheduler",
            ReadinessStatus.PASS, f"All {len(jobs)} tracked jobs healthy and fresh.",
        )

    def _check_cors(self) -> Dict[str, Any]:
        from app.config import settings

        origins = settings.BILLING_CORS_ORIGINS
        if "*" in origins and not settings.DEBUG:
            return self._item(
                "SEC-CFG-03", "CORS is not wildcard in production",
                ReadinessStatus.FAIL, f"BILLING_CORS_ORIGINS includes '*' while DEBUG=false: {origins!r}",
            )
        return self._item(
            "SEC-CFG-03", "CORS is not wildcard in production",
            ReadinessStatus.PASS, f"BILLING_CORS_ORIGINS={origins!r}, DEBUG={settings.DEBUG}.",
        )

    def _check_attention_queue(self) -> Dict[str, Any]:
        from app.modules.super_admin.attention_service import AttentionService

        counts = AttentionService(self.db).get_counts()
        if counts["p0"] > 0:
            return self._item(
                "TRIAGE-01", "No open P0 attention items",
                ReadinessStatus.FAIL, f"{counts['p0']} open P0 item(s).",
            )
        if counts["p1"] > 0 or counts["sla_breaches"] > 0:
            return self._item(
                "TRIAGE-01", "No open P0 attention items",
                ReadinessStatus.WARNING, f"{counts['p1']} open P1 item(s), {counts['sla_breaches']} SLA breach(es).",
            )
        return self._item(
            "TRIAGE-01", "No open P0 attention items",
            ReadinessStatus.PASS, f"{counts['total_open']} open items, none P0/P1, no SLA breaches.",
        )

    def _check_financial_consistency(self) -> Dict[str, Any]:
        from app.modules.super_admin.financial_consistency_service import FinancialConsistencyService

        result = FinancialConsistencyService(self.db).check_allocation_consistency()
        state = result["state"]
        status_map = {"VERIFIED": ReadinessStatus.PASS, "FAILED": ReadinessStatus.FAIL, "UNKNOWN": ReadinessStatus.UNKNOWN}
        return self._item(
            "FIN-01", "Internal invoice/payment allocation consistency",
            status_map[state],
            f"{result['over_allocated_count']} over-allocated invoice(s) out of {result['total_invoices_checked']} checked. "
            f"NOTE: this is an internal consistency check, not reconciliation against a processor/bank (see ISS-017).",
        )

    def _check_accessibility(self) -> Dict[str, Any]:
        return self._item(
            "A11Y-01", "WCAG 2.2 AA compliance",
            ReadinessStatus.UNKNOWN,
            "Not automatically verifiable in this environment — no axe-core or screen-reader audit tooling is wired into this repo's frontend build.",
        )

    def _check_performance(self) -> Dict[str, Any]:
        """PERF-01 now reads REAL measured server-side latency for
        /api/super-admin/* from the middleware's sliding window
        (core/api_metrics.py). Honest boundaries: browser-side render time is
        not observable here, and with no traffic since process start there is
        nothing to measure — that stays UNKNOWN, never a fabricated PASS."""
        import app.core.api_metrics as api_metrics

        stats = api_metrics.snapshot()
        if stats["sample_count"] < 10:
            return self._item(
                "PERF-01", "p95 latency budgets (ZB-SA-CMD-003 §18.2)",
                ReadinessStatus.UNKNOWN,
                "Fewer than 10 Command Center requests recorded since process start — "
                "insufficient samples to evaluate the p95 budget. Server-side timing "
                "instrumentation IS active (core/api_metrics.py); this resolves to a real "
                "verdict once the surface has live traffic.",
            )
        p95 = stats["p95_ms"]
        budget = stats["p95_budget_ms"]
        within = p95 <= budget
        # G-05 — error-rate observability rides the same window; rates are
        # None when no sample carried a known HTTP status.
        error_bits = ""
        if stats.get("error_rate") is not None:
            server_errors = stats.get("error_count", 0)
            client_errors = stats.get("client_error_count", 0)
            error_bits = (
                f" Server errors: {server_errors} ({stats['error_rate'] * 100:.2f}%); "
                f"client errors: {client_errors} "
                f"({(stats.get('client_error_rate') or 0) * 100:.2f}%)."
            )
        elif stats.get("status_unknown_count"):
            error_bits = (
                f" Error rates unavailable: {stats['status_unknown_count']} sample(s) "
                "lack a recorded HTTP status."
            )
        else:
            error_bits = " No errors recorded in the window."
        evidence = (
            f"Measured server-side handling time over the last {stats['window_seconds']}s: "
            f"p50={stats['p50_ms']}ms, p95={p95}ms, max={stats['max_ms']}ms across "
            f"{stats['sample_count']} /api/super-admin/* requests (budget {budget}ms)."
            f"{error_bits} "
            "Browser-side render time is not measured by this check."
        )
        return self._item(
            "PERF-01", "p95 latency budgets (ZB-SA-CMD-003 §18.2)",
            ReadinessStatus.PASS if within else ReadinessStatus.WARNING,
            evidence,
        )
