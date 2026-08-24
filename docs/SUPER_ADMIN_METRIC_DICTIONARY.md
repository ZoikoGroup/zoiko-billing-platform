# Super Admin Command Center — Metric Dictionary v1

Generated: 2026-08-21. This is a human-readable mirror of the authoritative,
code-versioned registry at `backend/app/modules/super_admin/metric_dictionary.py`
(`GET /api/super-admin/metric-dictionary`). If this document and the code ever
disagree, **the code is authoritative** — regenerate this file rather than
hand-editing metric definitions here.

## Domain C — cross-tenant operational telemetry (non-financial)

| Metric ID | Display Name | Definition | Source | Refresh | Owner |
|---|---|---|---|---|---|
| `zb.telemetry.organizations_total.v1` | Total Organizations | COUNT of all Organization rows | live query | real-time | Platform Engineering |
| `zb.telemetry.organizations_active.v1` | Active Organizations | COUNT WHERE is_active=true | live query | real-time | Platform Engineering |
| `zb.telemetry.organizations_suspended.v1` | Suspended Organizations | total − active | live query | real-time | Platform Engineering |
| `zb.telemetry.job_last_status.v1` | Background Job Last-Run Status | Most recent `JobRunLog` status per job_name | job_run_logs table | on job completion | Platform Engineering |
| `zb.telemetry.job_failure_count_24h.v1` | Job Failures (24h) | COUNT WHERE status=FAILED AND started_at>=now-24h | job_run_logs table | real-time | Platform Engineering |

## Domain B — tenant financial (visible ONLY under an active, tenant-scoped privileged-access grant)

| Metric ID | Display Name | Definition | Source | Currency Basis | Owner |
|---|---|---|---|---|---|
| `zb.tenant.customers_active.v1` | Tenant Customers (Active) | COUNT of the granted tenant's active BillingCustomer rows | BillingDashboardService.get_customer_summary | n/a (count) | Billing Engineering |
| `zb.tenant.subscriptions_active.v1` | Tenant Subscriptions (Active) | COUNT of the granted tenant's active Subscription rows | BillingDashboardService.get_subscription_summary | n/a (count) | Billing Engineering |
| `zb.tenant.invoices_by_status.v1` | Tenant Invoices by Status | Per-status count/total, original currency, never converted | BillingDashboardService.get_invoice_summary | original transaction currency | Billing Engineering |

## Governance

| Metric ID | Display Name | Definition | Source | Owner |
|---|---|---|---|---|
| `zb.governance.attention_open_count.v1` | Open Attention Items | COUNT WHERE status NOT IN (resolved, suppressed), by severity | AttentionService | Platform Engineering |
| `zb.governance.privileged_sessions_active.v1` | Active Privileged Sessions | COUNT WHERE status=ACTIVE | PrivilegedAccessService | Security Engineering |

## What is NOT in this dictionary (and why)

- **Any Domain A metric** (Platform MRR/ARR, Platform Subscriptions, Platform Invoices) — out of scope per the standing Domain A exclusion decision. The pre-existing `commercial/*` module's own dashboard numbers are not registered here.
- **Financial integrity / reconciliation metrics** — no verification engine exists to define a metric against (see `SUPER_ADMIN_IMPLEMENTATION_STATUS.md` §15). Registering a metric with no real computation behind it would itself be the "fake metric" the spec prohibits.
- **Queue age, connector state, SLO/error-budget metrics** — no message queue, connector abstraction, or SLO policy engine exists in this codebase. Documented as a deliberate omission, not an oversight (see `telemetry_service.py`'s module docstring).

## Freshness thresholds

Domain C job metrics use `stale_multiplier=2.0` / `unknown_multiplier=4.0`
against each job's configured scheduler interval (`compute_freshness()` in
`freshness.py`): a job silent for more than 2x its interval is STALE; more
than 4x is UNKNOWN. Domain B tenant metrics have no threshold — they are
computed live on every grant-scoped read, so they are FRESH by construction
(there is no cache or batch lag for them to go stale against).
