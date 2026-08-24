"""
modules/super_admin/configuration_service.py
---------------------------------------------
Phase 4 (G-03) — configuration governance read model (Workstream A).

One authoritative inventory of the configuration that governs the Super
Admin control plane, composed from the three real sources that exist:

  1. DB-backed ``PlatformSetting`` rows — mutable platform settings.
     Values matching sensitive key patterns are masked exactly like
     ``SettingResponse`` masks them (same helper, no duplicated rules).
  2. Code-declared operational thresholds — imported FROM their owning
     modules so this registry can never drift from the values actually
     enforced (no duplicate source of truth). These are read-only here;
     changing one means changing the owning module in a code review.
  3. Environment-dependent capabilities — CONFIGURED / NOT_CONFIGURED
     status only, never a value (SMTP passwords, Stripe keys, encryption
     keys are never exposed through this or any other endpoint).

Honesty rules:
  - A code baseline has no runtime "updated_by"/"effective_from" evidence,
    so those fields are None and the UI renders UNKNOWN rather than
    fabricating an actor or date.
  - PlatformSetting rows predating Phase 4 have updated_by = NULL (the
    column is new) which surfaces as UNKNOWN — history before audit
    coverage existed is not invented.

Read-only: opens no transaction of its own and writes nothing.
"""

import inspect
from datetime import datetime
from typing import Any, Dict, List

from sqlalchemy.orm import Session

from app.modules.super_admin.schemas import MASKED_VALUE_PLACEHOLDER, is_sensitive_setting_key


class ConfigurationGovernanceService:
    def __init__(self, db: Session):
        self.db = db

    # ── public read model ────────────────────────────────────────────────

    def get_inventory(self) -> Dict[str, Any]:
        entries: List[Dict[str, Any]] = []
        entries.extend(self._platform_setting_entries())
        entries.extend(self._code_baseline_entries())
        entries.extend(self._environment_capability_entries())

        summary: Dict[str, int] = {}
        for entry in entries:
            summary[entry["category"]] = summary.get(entry["category"], 0) + 1

        return {
            "generated_at": datetime.utcnow(),
            "entries": entries,
            "summary": summary,
            "honesty_notes": [
                "Code-baseline thresholds are imported live from the modules "
                "that enforce them; this view cannot drift from enforcement.",
                "Sensitive setting values are masked on every read and can "
                "never be revealed back through the API.",
                "Environment capabilities report presence only — secret "
                "values are never exposed.",
                "UNKNOWN actor/date on a row means no recorded evidence "
                "exists, not that none was checked.",
            ],
        }

    # ── source 1: DB-backed platform settings ────────────────────────────

    def _platform_setting_entries(self) -> List[Dict[str, Any]]:
        from app.modules.super_admin.models import PlatformSetting

        rows = self.db.query(PlatformSetting).order_by(PlatformSetting.key).all()
        entries: List[Dict[str, Any]] = []
        for row in rows:
            sensitive = is_sensitive_setting_key(row.key)
            entries.append(
                {
                    "name": row.key,
                    "category": "platform_setting",
                    "value_kind": "masked" if sensitive else "value",
                    "value": MASKED_VALUE_PLACEHOLDER if sensitive else row.value,
                    "is_sensitive": sensitive,
                    "source": "platform_settings",
                    "scope": f"platform:{row.category}",
                    "mutable": True,
                    "effective_from": row.created_at,
                    "last_updated_at": row.updated_at,
                    "updated_by": row.updated_by.email if row.updated_by else None,
                    # Every mutation is now audited transactionally (G-02).
                    # A row whose last actor predates that coverage says so
                    # instead of claiming an audit trail it doesn't have.
                    "audit_status": (
                        "AUDITED_SINCE_PHASE_4"
                        if row.updated_by_user_id is not None
                        else "PRE_PHASE_4_LAST_CHANGE_UNAUDITED"
                    ),
                    "description": row.description,
                }
            )
        return entries

    # ── source 2: code-declared operational thresholds ───────────────────

    def _code_baseline_entries(self) -> List[Dict[str, Any]]:
        from app.core import api_metrics
        from app.config import settings as env_settings
        from app.modules.super_admin import attention_service, freshness, kill_switch_service
        from app.modules.super_admin import privileged_access_service, search_service

        def _threshold(
            name: str,
            value: Any,
            module_attr: str,
            description: str,
            scope: str = "platform",
        ) -> Dict[str, Any]:
            return {
                "name": name,
                "category": "operational_threshold",
                "value_kind": "value",
                "value": value,
                "is_sensitive": False,
                "source": f"code:app.modules.super_admin.{module_attr}"
                if module_attr.startswith("super_admin")
                else f"code:{module_attr}",
                "scope": scope,
                "mutable": False,
                "effective_from": None,
                "last_updated_at": None,
                "updated_by": None,
                "audit_status": "READ_ONLY_CODE_BASELINE",
                "description": description,
            }

        freshness_params = inspect.signature(freshness.compute_freshness).parameters

        return [
            _threshold(
                "attention.sla_ack_target_minutes",
                {sev.value: mins for sev, mins in attention_service._ACK_TARGET_MINUTES.items()},
                "attention_service._ACK_TARGET_MINUTES",
                "Acknowledgement SLA target per severity (ZB-SA-CMD-003 Table 24; P2/P3 business-hours approximated as wall-clock).",
            ),
            _threshold(
                "attention.sla_mitigate_target_minutes",
                {sev.value: mins for sev, mins in attention_service._MITIGATE_TARGET_MINUTES.items()},
                "attention_service._MITIGATE_TARGET_MINUTES",
                "Mitigation SLA target per severity (ZB-SA-CMD-003 Table 24).",
            ),
            _threshold(
                "circuit_breaker.default_auto_expire_minutes",
                kill_switch_service.DEFAULT_AUTO_EXPIRE_MINUTES,
                "kill_switch_service.DEFAULT_AUTO_EXPIRE_MINUTES",
                "Default breaker engagement window; permanent breakers are prohibited.",
            ),
            _threshold(
                "circuit_breaker.auto_expire_bounds_minutes",
                {
                    "min": kill_switch_service.MIN_AUTO_EXPIRE_MINUTES,
                    "max": kill_switch_service.MAX_AUTO_EXPIRE_MINUTES,
                },
                "kill_switch_service.MIN/MAX_AUTO_EXPIRE_MINUTES",
                "Accepted bounds for a breaker's mandatory expiry window.",
            ),
            _threshold(
                "privileged_access.max_grant_minutes",
                privileged_access_service.MAX_GRANT_MINUTES,
                "privileged_access_service.MAX_GRANT_MINUTES",
                "Hard cap on JIT tenant-access grant duration regardless of request.",
            ),
            _threshold(
                "privileged_access.step_up_window_minutes",
                privileged_access_service.STEP_UP_WINDOW_MINUTES,
                "privileged_access_service.STEP_UP_WINDOW_MINUTES",
                "Maximum age of an MFA step-up verification before grant activation is refused.",
            ),
            _threshold(
                "freshness.stale_multiplier",
                freshness_params["stale_multiplier"].default,
                "freshness.compute_freshness(stale_multiplier)",
                "Age beyond this multiple of the expected interval is STALE.",
            ),
            _threshold(
                "freshness.unknown_multiplier",
                freshness_params["unknown_multiplier"].default,
                "freshness.compute_freshness(unknown_multiplier)",
                "Age beyond this multiple of the expected interval is UNKNOWN (never green).",
            ),
            _threshold(
                "api.p95_latency_budget_ms",
                api_metrics.P95_BUDGET_MS,
                "app.core.api_metrics.P95_BUDGET_MS",
                "Server-side p95 handling budget for /api/super-admin/* calls (launch-readiness PERF-01).",
            ),
            _threshold(
                "api.metrics_window_seconds",
                api_metrics.WINDOW_SECONDS,
                "app.core.api_metrics.WINDOW_SECONDS",
                "Sliding window over which latency/error telemetry is aggregated.",
            ),
            _threshold(
                "search.max_results_per_type",
                search_service.MAX_RESULTS_PER_TYPE,
                "search_service.MAX_RESULTS_PER_TYPE",
                "Identifier-first global search result cap per entity type.",
            ),
            _threshold(
                "auth.access_token_expire_minutes",
                env_settings.ACCESS_TOKEN_EXPIRE_MINUTES,
                "app.config.settings.ACCESS_TOKEN_EXPIRE_MINUTES",
                "Super Admin JWT access-token lifetime.",
            ),
            _threshold(
                "mfa.max_failed_attempts",
                env_settings.MFA_MAX_FAILED_ATTEMPTS,
                "app.config.settings.MFA_MAX_FAILED_ATTEMPTS",
                "Failed TOTP verifications before an MFA account lockout.",
            ),
            _threshold(
                "mfa.lockout_minutes",
                env_settings.MFA_LOCKOUT_MINUTES,
                "app.config.settings.MFA_LOCKOUT_MINUTES",
                "Duration of an MFA account lockout after repeated failures.",
            ),
            _threshold(
                "scheduler.recurring_billing_interval_minutes",
                env_settings.RECURRING_BILLING_INTERVAL_MINUTES,
                "app.config.settings.RECURRING_BILLING_INTERVAL_MINUTES",
                "Cadence of the recurring-billing job (scheduler must be enabled).",
                scope="platform:scheduler",
            ),
            _threshold(
                "scheduler.financial_consistency_interval_minutes",
                env_settings.FINANCIAL_CONSISTENCY_INTERVAL_MINUTES,
                "app.config.settings.FINANCIAL_CONSISTENCY_INTERVAL_MINUTES",
                "Cadence of the internal financial-integrity check.",
                scope="platform:scheduler",
            ),
        ]

    # ── source 3: environment-dependent capabilities ─────────────────────

    def _environment_capability_entries(self) -> List[Dict[str, Any]]:
        from app.config import settings as env_settings

        def _capability(
            name: str,
            configured: bool,
            description: str,
        ) -> Dict[str, Any]:
            return {
                "name": name,
                "category": "environment_capability",
                "value_kind": "status",
                "value": "CONFIGURED" if configured else "NOT_CONFIGURED",
                "is_sensitive": False,
                "source": "environment",
                "scope": "platform:deployment",
                "mutable": False,
                "effective_from": None,
                "last_updated_at": None,
                "updated_by": None,
                "audit_status": "PRESENCE_ONLY_NEVER_VALUE",
                "description": description,
            }

        return [
            _capability(
                "database.url",
                bool((env_settings.BILLING_DATABASE_URL or "").strip()),
                "PostgreSQL/SQLite connection string present (value never shown).",
            ),
            _capability(
                "smtp.provider",
                bool((env_settings.SMTP_HOST or "").strip())
                and bool((env_settings.SMTP_USERNAME or "").strip()),
                "Outbound email delivery provider (host+username presence; credentials never shown).",
            ),
            _capability(
                "stripe.gateway",
                bool((env_settings.STRIPE_SECRET_KEY or "").strip()),
                "Payment gateway credentials for tenant payment captures (key value never shown).",
            ),
            _capability(
                "mfa.encryption_key",
                bool((env_settings.MFA_ENCRYPTION_KEY or "").strip()),
                "Dedicated Fernet key encrypting MFA secrets at rest (key value never shown).",
            ),
            _capability(
                "stripe.webhook_secret",
                bool((env_settings.STRIPE_WEBHOOK_SECRET or "").strip()),
                "Stripe webhook signature verification secret (value never shown).",
            ),
            _capability(
                "scheduler.enabled",
                bool(env_settings.ENABLE_RECURRING_BILLING_SCHEDULER),
                "Background billing/dunning/integrity scheduler enabled at boot.",
            ),
        ]
