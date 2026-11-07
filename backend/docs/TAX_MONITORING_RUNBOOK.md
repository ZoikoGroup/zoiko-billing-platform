# Tax Monitoring Runbook

## How tax alerts work

- **Where they come from.** Each alert below is an Attention item with
  source `tax_monitoring`, raised by the scheduled job "Tax Monitoring and
  Alerts" (`tax_monitoring_job`, every `TAX_MONITORING_INTERVAL_MINUTES`,
  default 5).
- **Where they appear.** In the Super Admin Attention list, with the same
  severities, SLA clocks and escalation as every other platform alert.
- **When they close.** They resolve automatically once the condition clears.
- **No tenant data.** Alert texts and metrics never name a tenant, invoice
  or customer.
- **To find who is affected:**
  - tenant admins see their own rows at `/billing/tax/governance/transactions`;
  - tax staff see aggregates at `/super-admin/tax/providers`;
  - the live metrics are at `GET /api/v1/super-admin/tax-registry/monitoring`.

Thresholds are settings (in `backend/.env`); the defaults are shown below.

---

## tax.outbox_oldest_unresolved (P1)

**Fires when:** the oldest provider outbox row in PENDING, UNCERTAIN,
REMOTE_COMMITTED or REVIEW_REQUIRED is older than
`TAX_ALERT_OUTBOX_OLDEST_AGE_MINUTES` (30).

**Means:** an invoice is stuck between the provider and us. Its draft is
locked.

**Do:**
1. Check `tax.reconciliation_heartbeat` first. If the worker is down,
   nothing moves (see below).
2. On `/super-admin/tax/providers`, check the counts per state and the
   circuit.
3. The tenant's billing admin opens **Provider transactions**, then **Check
   provider state**:
   - committed at the provider: reconciliation finishes it;
   - not found: retry, or let the grace period cancel it.
4. A row in REVIEW_REQUIRED needs the tenant's two-person decision. Never
   edit outbox rows by hand.

## tax.reconciliation_heartbeat (P1)

**Fires when:** while `TAX_PROVIDER_RECONCILIATION_ENABLED`, the
reconciliation worker:
- has never recorded a heartbeat; or
- last finished more than `TAX_ALERT_HEARTBEAT_STALE_MINUTES` (15) ago; or
- failed its last pass.

**Means:** provider issuing is blocked for everyone; it fails closed.

**Do:**
1. On the VM, check the worker: `systemctl status zoiko-billing-tax-worker`
   (staging: `zoiko-billing-staging-tax-worker`).
2. Read `journalctl -u zoiko-billing-tax-worker -n 100`.
3. Restart it: `sudo systemctl restart zoiko-billing-tax-worker`.
4. If passes keep failing, check database connectivity and the secret store
   (see `tax.secret_store_failures`).
5. Full procedure: `TAX_RECONCILIATION_WORKER.md`.

## tax.circuit_open:\<provider\> (P1)

**Fires when:** a provider's circuit breaker is OPEN after repeated
failures.

**Means:** quotes and issuing through that provider return
PROVIDER_UNAVAILABLE until the cool-down ends. Nothing is sent.

**Do:**
1. Check the provider's status page or contact the provider.
2. The circuit closes by itself after the cool-down if calls succeed.
3. If the provider is down for long, a TAX_PUBLISHER can **Suspend** it on
   `/super-admin/tax/providers` (reason and MFA), and **Resume** it after.
4. Tell support: affected tenants see "Tax provider unavailable" and their
   drafts stay drafts.

## tax.provider_unavailable:\<market\> (P2)

**Fires when:** at least `TAX_ALERT_PROVIDER_UNAVAILABLE_RATE` (20%) of the
quotes in that market were PROVIDER_UNAVAILABLE over the last
`TAX_ALERT_RATE_WINDOW_MINUTES` (60), with at least
`TAX_ALERT_RATE_MIN_QUOTES` (10) quotes. The market is the supply country.

**Means:** that market can't quote through its provider.

**Do:**
1. Check for a related `tax.circuit_open` or `tax.secret_store_failures`
   alert.
2. Check the provider's health for that market.
3. If one tenant's connection is the cause (revoked or untested
   credentials), the tenant admin sees it on **Provider connections**.
   Support can guide them; never change a tenant's credentials.

## tax.not_determined:\<market\> (P3)

**Fires when:** at least `TAX_ALERT_NOT_DETERMINED_RATE` (50%) of the
quotes in that market were NOT_DETERMINED (needs evidence, unsupported, or
a NOT_DETERMINED line) over the window, with the minimum count.

**Means:** invoices can't be issued with governed tax. This is often
expected in a new market: missing classifications, addresses or
registrations.

**Do:**
1. Check whether a rate, pack or availability was just superseded or
   withdrawn (`/super-admin/tax/overview` and the explorer).
2. If not, it is tenant data: the blocking reasons and owners are on each
   tenant's **Exceptions** page.
3. Raise it with the tax lead if a whole market is affected.

**Never:** "fix" it by setting a 0% rate.

## tax.review_backlog (P2)

**Fires when:** `TAX_ALERT_REVIEW_BACKLOG` (5) or more provider outbox rows
are in REVIEW_REQUIRED.

**Means:** people need to decide on drift, unresolved commits or refused
adjustments.

**Do:** tenant billing admins and finance approvers work through
**Provider transactions** (check state, retry, or a two-person void).
Support can remind the tenant admins. Platform staff can't decide for them
(T13).

## tax.secret_store_failures (P1)

**Fires when:** `TAX_ALERT_SECRET_STORE_FAILURES` (1) or more quotes in the
window were refused because provider credentials were unavailable.

**Means:** the secret store (GCP Secret Manager or the Fernet key) can't be
read. Provider quoting and issuing fail closed.

**Do:**
1. **gcp:**
   - check the service account's IAM (`roles/secretmanager.secretAccessor`
     on the tax secrets);
   - check the project and region settings
     (`TAX_SECRET_MANAGER_PROJECT` / `_REGION`);
   - check the Secret Manager status.
2. **fernet:** check that `TAX_PROVIDER_ENCRYPTION_KEY` (or its secret) is
   present and unchanged.
3. Look in the backend log for `SecretStoreUnavailable`. Values are never
   logged.
4. See `TAX_PHASE4D0.md`.
