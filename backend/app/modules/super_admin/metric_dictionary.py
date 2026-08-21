"""
modules/super_admin/metric_dictionary.py
-------------------------------------------
ZB-SA-CMD-003 §10.1 — Metric Dictionary v1: a versioned runtime contract, not
a place for a React component to invent its own KPI definition.

Deliberately a static, code-reviewed registry rather than an admin-editable
database table: every metric here is backed by a real, small, already-audited
query (TelemetryService / PrivilegedAccessService), so there is no operator
workflow that needs to author a NEW metric at runtime yet. If/when that need
arises, this module's shape (MetricDefinition) is what a DB-backed version
would persist — moving it later doesn't change any caller's contract.

Every metric shipped by this Command Center (Domain B or C) MUST have an
entry here. Callers reference metrics by `metric_id`, never by inventing a
label — see telemetry_service.py and privileged_access_service.py for the
services that actually compute these values; this module only describes them.
"""

from dataclasses import dataclass, asdict
from datetime import date
from typing import Optional


@dataclass(frozen=True)
class MetricDefinition:
    metric_id: str
    display_name: str
    definition: str
    domain: str  # "B" | "C" | "governance"
    unit: str  # "count" | "rate" | "state" | "duration_seconds"
    numerator: Optional[str]
    denominator: Optional[str]
    period_basis: str
    timezone: str
    currency_basis: Optional[str]
    authoritative_source: str
    refresh_cadence_seconds: int  # 0 == computed live on every read
    stale_threshold_seconds: Optional[int]
    unknown_threshold_seconds: Optional[int]
    owner: str
    version: str
    effective_date: str
    drilldown_route: Optional[str]

    def to_dict(self) -> dict:
        d = asdict(self)
        return d


_REGISTRY: dict[str, MetricDefinition] = {}


def _register(defn: MetricDefinition) -> MetricDefinition:
    _REGISTRY[defn.metric_id] = defn
    return defn


# ── Domain C — cross-tenant operational telemetry ──────────────────────────

_register(MetricDefinition(
    metric_id="zb.telemetry.organizations_total.v1",
    display_name="Total Organizations",
    definition="Count of all Organization rows, regardless of lifecycle state.",
    domain="C", unit="count", numerator="COUNT(organizations)", denominator=None,
    period_basis="point_in_time", timezone="UTC", currency_basis=None,
    authoritative_source="organizations table (live query)",
    refresh_cadence_seconds=0, stale_threshold_seconds=None, unknown_threshold_seconds=None,
    owner="Platform Engineering", version="v1", effective_date="2026-08-21",
    drilldown_route="/super-admin/organizations",
))

_register(MetricDefinition(
    metric_id="zb.telemetry.organizations_active.v1",
    display_name="Active Organizations",
    definition="Count of Organization rows where is_active = true.",
    domain="C", unit="count", numerator="COUNT(organizations WHERE is_active)", denominator=None,
    period_basis="point_in_time", timezone="UTC", currency_basis=None,
    authoritative_source="organizations table (live query)",
    refresh_cadence_seconds=0, stale_threshold_seconds=None, unknown_threshold_seconds=None,
    owner="Platform Engineering", version="v1", effective_date="2026-08-21",
    drilldown_route="/super-admin/organizations",
))

_register(MetricDefinition(
    metric_id="zb.telemetry.organizations_suspended.v1",
    display_name="Suspended Organizations",
    definition="Total organizations minus active organizations.",
    domain="C", unit="count", numerator="organizations_total - organizations_active", denominator=None,
    period_basis="point_in_time", timezone="UTC", currency_basis=None,
    authoritative_source="organizations table (live query)",
    refresh_cadence_seconds=0, stale_threshold_seconds=None, unknown_threshold_seconds=None,
    owner="Platform Engineering", version="v1", effective_date="2026-08-21",
    drilldown_route="/super-admin/organizations",
))

_register(MetricDefinition(
    metric_id="zb.telemetry.job_last_status.v1",
    display_name="Background Job Last-Run Status",
    definition="Status (RUNNING/SUCCEEDED/FAILED) of the most recent JobRunLog row for a given job_name.",
    domain="C", unit="state", numerator=None, denominator=None,
    period_basis="latest_run", timezone="UTC", currency_basis=None,
    authoritative_source="job_run_logs table, written by core/scheduler.py:_tracked_job_runner",
    refresh_cadence_seconds=None, stale_threshold_seconds=None, unknown_threshold_seconds=None,
    owner="Platform Engineering", version="v1", effective_date="2026-08-21",
    drilldown_route="/super-admin/tenant-health",
))

_register(MetricDefinition(
    metric_id="zb.telemetry.job_failure_count_24h.v1",
    display_name="Job Failures (24h)",
    definition="COUNT of job_run_logs rows for a given job_name with status=FAILED and started_at within the last 24 hours.",
    domain="C", unit="count", numerator="COUNT(job_run_logs WHERE status=FAILED AND started_at>=now-24h)", denominator=None,
    period_basis="rolling_24h", timezone="UTC", currency_basis=None,
    authoritative_source="job_run_logs table",
    refresh_cadence_seconds=0, stale_threshold_seconds=None, unknown_threshold_seconds=None,
    owner="Platform Engineering", version="v1", effective_date="2026-08-21",
    drilldown_route="/super-admin/tenant-health",
))

# ── Domain B — tenant financial (visible ONLY under an active, tenant-scoped
# privileged-access grant; see privileged_access_service.get_tenant_summary) ─

_register(MetricDefinition(
    metric_id="zb.tenant.customers_active.v1",
    display_name="Tenant Customers (Active)",
    definition="Count of a single tenant's BillingCustomer rows with an active status, scoped to the organization_id on the caller's privileged-access grant.",
    domain="B", unit="count", numerator="COUNT(billing_customers WHERE organization_id=:grant_org AND status=active)", denominator=None,
    period_basis="point_in_time", timezone="UTC", currency_basis=None,
    authoritative_source="BillingDashboardService.get_customer_summary (billing module)",
    refresh_cadence_seconds=0, stale_threshold_seconds=None, unknown_threshold_seconds=None,
    owner="Billing Engineering", version="v1", effective_date="2026-08-21",
    drilldown_route="/super-admin/support-access",
))

_register(MetricDefinition(
    metric_id="zb.tenant.subscriptions_active.v1",
    display_name="Tenant Subscriptions (Active)",
    definition="Count of a single tenant's Subscription rows with an active status, scoped to the organization_id on the caller's privileged-access grant.",
    domain="B", unit="count", numerator="COUNT(subscriptions WHERE organization_id=:grant_org AND status=active)", denominator=None,
    period_basis="point_in_time", timezone="UTC", currency_basis=None,
    authoritative_source="BillingDashboardService.get_subscription_summary (billing module)",
    refresh_cadence_seconds=0, stale_threshold_seconds=None, unknown_threshold_seconds=None,
    owner="Billing Engineering", version="v1", effective_date="2026-08-21",
    drilldown_route="/super-admin/support-access",
))

_register(MetricDefinition(
    metric_id="zb.tenant.invoices_by_status.v1",
    display_name="Tenant Invoices by Status",
    definition="Per-status count/total of a single tenant's Invoice rows, in each invoice's original currency (never converted), scoped to the organization_id on the caller's privileged-access grant.",
    domain="B", unit="count", numerator="GROUP BY status: COUNT(invoices WHERE organization_id=:grant_org)", denominator=None,
    period_basis="point_in_time", timezone="UTC", currency_basis="original_transaction_currency",
    authoritative_source="BillingDashboardService.get_invoice_summary (billing module)",
    refresh_cadence_seconds=0, stale_threshold_seconds=None, unknown_threshold_seconds=None,
    owner="Billing Engineering", version="v1", effective_date="2026-08-21",
    drilldown_route="/super-admin/support-access",
))

# ── Governance ───────────────────────────────────────────────────────────

_register(MetricDefinition(
    metric_id="zb.governance.attention_open_count.v1",
    display_name="Open Attention Items",
    definition="COUNT of AttentionItem rows with status NOT IN (resolved, suppressed), grouped by severity.",
    domain="governance", unit="count", numerator="COUNT(attention_items WHERE status NOT IN (resolved,suppressed))", denominator=None,
    period_basis="point_in_time", timezone="UTC", currency_basis=None,
    authoritative_source="AttentionService (super_admin module)",
    refresh_cadence_seconds=0, stale_threshold_seconds=None, unknown_threshold_seconds=None,
    owner="Platform Engineering", version="v1", effective_date="2026-08-21",
    drilldown_route="/super-admin/governance",
))

_register(MetricDefinition(
    metric_id="zb.governance.privileged_sessions_active.v1",
    display_name="Active Privileged Sessions",
    definition="COUNT of PrivilegedTenantAccessGrant rows with status=ACTIVE (lazily expiry-checked on read).",
    domain="governance", unit="count", numerator="COUNT(privileged_tenant_access_grants WHERE status=ACTIVE)", denominator=None,
    period_basis="point_in_time", timezone="UTC", currency_basis=None,
    authoritative_source="PrivilegedAccessService",
    refresh_cadence_seconds=0, stale_threshold_seconds=None, unknown_threshold_seconds=None,
    owner="Security Engineering", version="v1", effective_date="2026-08-21",
    drilldown_route="/super-admin/support-access",
))


def get_metric(metric_id: str) -> Optional[MetricDefinition]:
    return _REGISTRY.get(metric_id)


def list_metrics(domain: Optional[str] = None) -> list[MetricDefinition]:
    values = list(_REGISTRY.values())
    if domain:
        values = [m for m in values if m.domain == domain]
    return sorted(values, key=lambda m: m.metric_id)
