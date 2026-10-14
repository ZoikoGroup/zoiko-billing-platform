# Dashboard Summary Fail-Closed — Root Cause & Fix Report

Date: 2026-10-13
Scope: backend only (no frontend changes). Public widget + admin copilot both
ride the same engine, so this fix covers both surfaces.

## Symptom
Asking **"Dashboard summary"** returned the P-06 fail-closed escalation bubble:

> "I couldn't retrieve the authoritative Billing records for that right now,
> and I'd rather not guess. Would you like me to connect you to a team member?
> In the meantime, I can help with invoices, payments, customers,
> subscriptions, or your billing dashboard."

…instead of the live billing dashboard KPIs.

## Root cause (verified live, not inferred)
- `ConversationEngine._invoke_handler` (`conversation/engine.py:5216`) wraps every
  Ground handler in a P-06 fail-closed: if the handler **raises**, the turn closes
  as an Inspect abstention (`M5_ESCALATE`/`R0`) with the message above.
- `_handle_dashboard` (`engine.py:7073`) composes the summary and calls
  `_base_currency(org_id)` (`engine.py:8040`) and `_currency_rates(org_id)`
  (`engine.py:8074`).
- Both resolve currency through `BillingDashboardService._get_base_currency` /
  `_build_currency_rates`, which loaded the **whole `BillingConfiguration` ORM
  entity** (`repositories/settings.py:get_by_organization` and
  `ExchangeRateService.is_rate_stale`).
- The live `billing_configurations` table is **missing 8 columns** the model
  declares, so the full-entity SELECT raised:
  `psycopg.errors.UndefinedColumn: column billing_configurations.quote_terms_and_conditions does not exist`
  → handler raised → P-06 fail-closed.
- `get_kpis()` itself was healthy (returned the real KPI figures), so the
  failure was **purely the currency lookups' coupling to the whole schema**.

Verified measurements against the live Neon DB:
- `billing_configurations`: **196** live columns vs **204** in the ORM model.
- Missing 8: `auto_send_invoices`, `default_billing_frequency`,
  `default_pricing_strategy`, `default_trial_days`, `payment_extra_settings`,
  `pricing_extra_settings`, `quote_terms_and_conditions`,
  `subscription_extra_settings`.

This is the same drift already tracked in
`DB_SCHEMA_DRIFT_REMEDIATION_PLAN.md`; it was previously marked blocked pending
DBA approval.

## Fix applied (code hardening — no live DB change)
Currency/FX resolution now reads **only the columns it uses**, so an unrelated
drifted column can never abort the transaction or take down a currency-labelled
answer.

- `repositories/settings.py`: added `BillingConfigurationRepository.get_currency_view(organization_id)`
  — a column-projected query (`base_currency`, `default_currency`,
  `exchange_rates`, `exchange_rate_last_refreshed`,
  `exchange_rate_base_currency`, legacy `exchange_rate_{usd,inr,gbp,eur,aed}`)
  returning a lightweight `SimpleNamespace` (or `None`).
- `services/exchange_rate_service.py`: `is_rate_stale` default lookup now uses
  `get_currency_view` (read-only path).
- `services/dashboard_service.py`: `_build_currency_rates` uses
  `get_currency_view`.
- `services/settings_service.py`: `get_default_currency` uses
  `get_currency_view`, falling back to the full `get_configuration` only when no
  row exists (lazy-seed path preserved).
- `conversation/engine.py`: `_exchange_rate_staleness` uses
  `get_currency_view`.

Writes / full-entity paths (`get_rate`, `refresh_rates`, settings API) are
unchanged — they still load the full entity.

## Verification
- Live end-to-end probe (real org 49, live Neon DB), before fix:
  `_base_currency RAISED` (UndefinedColumn). After fix:
  - `_base_currency` → `INR`; `_currency_rates` → `{}`;
    `_exchange_rate_staleness` → `{'is_stale': True, 'age_hours': 1088.1}`.
  - Full turn `_process_message("Dashboard summary")` →
    **mode `M1_INSPECT`, risk `R1`** with live KPIs (Total Revenue
    ₹221006.56, Paid ₹47501.43, Outstanding ₹173505.13, Collection Rate 21.5%,
    10 invoices) — no fail-closed message, no internal codes.
- New regression test
  `tests/test_billing_configuration_seed.py::test_currency_resolution_survives_missing_config_column`
  simulates the drift (patches `get_by_organization` to raise `ProgrammingError`)
  and asserts `get_default_currency` and `_build_currency_rates` still succeed.
- Test runs (all green):
  - `tests/test_billing_configuration_seed.py` — 9 passed.
  - `tests/test_live_data_routing_intercepts.py` + `test_retest_fixes.py` +
    `test_billing_configuration_seed.py` + `test_exchange_rate_background_refresh.py` — 82 passed.
  - billing/dashboard/currency + intent suites — 1059 passed.
  - full `tests/ai_assistant` — **2985 passed, 1 skipped**.

## Remaining: live schema completeness (needs approval)
The code fix removes the chatbot dependency, but the table is still 8 columns
short — the Billing Settings pages (Quotations/Pricing/Subscriptions/Payments
persistence) remain affected. The ready-to-run, idempotent, additive script is:

- `DB_FIX_BILLING_CONFIGURATIONS_8_COLUMNS.sql`

It mirrors migrations `e5a1c3f7b9d2`, `f2b8d4a6c1e3`, `a1c9d3e7f5b2`
(add-with-default then drop-default), is safe to re-run, and includes
verification queries. **Not executed** — awaiting owner/DBA approval. Once
applied, `billing_configurations` should reach 204 columns.

## Notes / non-goals
- No frontend, security-control, or fail-closed-governance changes were made —
  the P-06 policy is intact; the handler simply no longer crashes.
- The deeper Alembic issue (6 unmerged heads, DB `stamp`ed) is unchanged and
  still requires DBA reconciliation; see `DB_SCHEMA_DRIFT_REMEDIATION_PLAN.md`.
