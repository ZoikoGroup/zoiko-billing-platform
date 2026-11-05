# Runbook: Tax Reconciliation Worker

**Unit:** `zoiko-billing-tax-worker` (ZB-TAX-ARCH-001 Phase 4d-0).
**Owner:** ops/SRE.
**Escalation:** the tax lead, for anything in REVIEW_REQUIRED.

## What it does

`python -m app.modules.tax.reconciliation_worker` runs tax provider
reconciliation, and only that, every
`TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS` (300). Each pass:
- delivers pending provider commits, adjustments and voids;
- resolves uncertain ones by state lookup;
- finalizes, links and emails;
- checks for drift;
- retries failed credential-version destroys and destroys expired disabled
  versions;
- writes the `tax_job_heartbeats` row.

The web app runs with `TAX_PROVIDER_RECONCILIATION_MODE=worker` and
schedules none of this.

**It fails closed.** If the worker stops, the heartbeat goes stale after
`TAX_PROVIDER_HEARTBEAT_STALE_INTERVALS` (3) intervals, 15 minutes by
default. Provider-taxed invoices then cannot be issued (PROVIDER_UNAVAILABLE,
"Provider reconciliation is not running…"). Nothing else in billing is
affected. Governed native and tenant-rate taxes and legacy invoices keep
working.

**Running two at once is safe.** Rows are claimed with
`FOR UPDATE SKIP LOCKED`, so each row is processed once. A CI test runs two
live workers against Postgres to prove it. A worker and an in-app scheduler
running together are also safe, just wasteful.

## Deploy

`.github/workflows/deploy.yml` does this on every deploy, after migrations:

1. Renders `backend/deploy/systemd/zoiko-billing-tax-worker.service`, with
   the `zoiko-billing-backend` unit's `User` and the backend directory.
2. Installs it into `/etc/systemd/system` when it changed, then runs
   `daemon-reload`.
3. Runs `enable` on it.
4. Writes `TAX_PROVIDER_RECONCILIATION_MODE=worker` into `backend/.env`.
5. Restarts the backend, then the worker, and checks both are active. If
   the worker isn't active, the deploy fails and prints its last 30 journal
   lines.

**VM prerequisites (one-off, by the VM admin):**
- **sudoers.** The deploy user needs `sudo` for `install` (into
  `/etc/systemd/system`) and `systemctl daemon-reload | enable | restart |
  is-active`, as well as the existing backend `systemctl` commands.
- **Environment.** The worker reads `backend/.env` like the web app. If the
  backend unit sets anything through `Environment=` or `EnvironmentFile=`,
  add the same to the worker with a drop-in:
  `systemctl edit zoiko-billing-tax-worker`.
- **Credentials.** The worker uses the VM's attached service account
  (Secret Manager), like the web app; no extra credentials.

## Everyday checks

| Check | Command or place |
|---|---|
| Running? | `systemctl status zoiko-billing-tax-worker` |
| Recent passes | `journalctl -u zoiko-billing-tax-worker -n 100 --no-pager`. Each pass logs `Tax reconciliation run: {…non-zero stats…}`. |
| Heartbeat fresh? | Super-admin provider health (`GET /api/v1/super-admin/tax-registry/provider-health`, aggregates only), or `SELECT last_finished_at, last_ok FROM tax_job_heartbeats WHERE job_name = 'tax_provider_reconciliation';` |
| Rows needing a person | Tenant provider-transactions view (REVIEW_REQUIRED); tenant review items (`CREDENTIAL_VERSIONS_NOT_DESTROYED`, …) |

## Incidents

**Worker not running, or the heartbeat is stale.**
1. Run `systemctl status zoiko-billing-tax-worker`, then
   `journalctl -u zoiko-billing-tax-worker -n 200`.
2. **Exit at startup** (SystemExit in the journal): the same refusals as
   the web app apply. Check for:
   - an unsafe secret store setting;
   - a missing critical column (migrations not applied);
   - a bad `TAX_PROVIDER_RECONCILIATION_MODE`.

   Fix `backend/.env` or run the migration, then
   `sudo systemctl restart zoiko-billing-tax-worker`.
3. **Crash loop** (`Restart=on-failure`, every 10 s): usually the database is
   unreachable. Fix that first; the worker recovers on its own.
4. **Emergency only:** to run reconciliation in the web app again while the
   worker is broken, set `TAX_PROVIDER_RECONCILIATION_MODE=in_app` in
   `backend/.env` and restart the backend. Revert after the fix: the next
   deploy writes `worker` again.

**One pass:** `cd backend && venv/bin/python -m app.modules.tax.reconciliation_worker --once`.
It is safe while the unit runs.

**Stopping on purpose** (maintenance): `sudo systemctl stop zoiko-billing-tax-worker`.
Provider issuing blocks after the stale window; nothing is lost. Pending
rows wait in the outbox and go out on the next pass. SIGTERM lets the
current pass finish (`TimeoutStopSec=120`).

**Disabling:** with `TAX_PROVIDER_RECONCILIATION_ENABLED=false` the worker
exits 0 and stays stopped. Provider issuing stays blocked.
