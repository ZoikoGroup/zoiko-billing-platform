-- ============================================================================
-- Zoiko Billing -- billing_configurations schema-drift fix (8 columns)
-- ============================================================================
-- DO NOT RUN until the owner / DBA has approved. This is the DDL for the
-- previously-reported drift that also caused the public/admin chatbot
-- "Dashboard summary" fail-closed (P-06 escalation) response.
--
-- Observed state (verified 2026-10-13 against the live Neon DB):
--   billing_configurations: 196 columns live vs 204 declared by the ORM model.
--   Missing 8:
--     auto_send_invoices, default_billing_frequency, default_pricing_strategy,
--     default_trial_days, payment_extra_settings, pricing_extra_settings,
--     quote_terms_and_conditions, subscription_extra_settings
--
-- Root cause of the chatbot symptom: engine._base_currency / _currency_rates
-- SELECTed the full BillingConfiguration ORM entity, so a missing unrelated
-- column raised psycopg UndefinedColumn -> the handler raised -> P-06
-- fail-closed. A code-level hardening (column-projected currency read) already
-- removes that coupling, so the chatbot no longer depends on this DDL; this
-- script is the true schema-completeness fix and also restores the Billing
-- Settings pages (Quotations/Pricing/Subscriptions/Payments persistence).
--
-- Column definitions mirror the Alembic migrations exactly:
--   e5a1c3f7b9d2_add_settings_persistence_fields.py
--   f2b8d4a6c1e3_add_pricing_extra_settings.py
--   a1c9d3e7f5b2_add_auto_send_invoices_to_billing_config.py
-- Each migration added the column WITH a server default (to backfill existing
-- rows) then DROPped the default; the statements below reproduce that same
-- final state (NOT NULL, no lingering default).
--
-- Idempotent: every ADD uses IF NOT EXISTS; re-running is a no-op.
-- Non-destructive: additive columns only; no data is changed or dropped.
-- ============================================================================

BEGIN;

-- ── Step 1: add the 8 missing columns (with a default so NOT NULL backfills) ─
ALTER TABLE billing_configurations
    ADD COLUMN IF NOT EXISTS auto_send_invoices            boolean      NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS quote_terms_and_conditions     text,
    ADD COLUMN IF NOT EXISTS default_trial_days             integer      NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS default_pricing_strategy        varchar(20)  NOT NULL DEFAULT 'flat',
    ADD COLUMN IF NOT EXISTS default_billing_frequency       varchar(20)  NOT NULL DEFAULT 'monthly',
    ADD COLUMN IF NOT EXISTS subscription_extra_settings     json         NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS payment_extra_settings          json         NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS pricing_extra_settings          json         NOT NULL DEFAULT '{}';

-- ── Step 2: drop the temporary defaults (matches the migration end-state) ────
-- (quote_terms_and_conditions is nullable and never had a default.)
ALTER TABLE billing_configurations
    ALTER COLUMN auto_send_invoices         DROP DEFAULT,
    ALTER COLUMN default_trial_days          DROP DEFAULT,
    ALTER COLUMN default_pricing_strategy    DROP DEFAULT,
    ALTER COLUMN default_billing_frequency   DROP DEFAULT,
    ALTER COLUMN subscription_extra_settings DROP DEFAULT,
    ALTER COLUMN payment_extra_settings      DROP DEFAULT,
    ALTER COLUMN pricing_extra_settings      DROP DEFAULT;

COMMIT;

-- ── Verification: expect 8 rows, all with is_nullable = 'NO' except
--    quote_terms_and_conditions (which is nullable) ─────────────────────────
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'billing_configurations'
  AND column_name IN (
        'auto_send_invoices', 'default_billing_frequency',
        'default_pricing_strategy', 'default_trial_days',
        'payment_extra_settings', 'pricing_extra_settings',
        'quote_terms_and_conditions', 'subscription_extra_settings'
  )
ORDER BY column_name;

-- ── Post-check: total live columns should now equal the ORM model's 204 ─────
-- SELECT count(*) FROM information_schema.columns
-- WHERE table_name = 'billing_configurations';   -- expect 204
