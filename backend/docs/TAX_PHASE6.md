# Global Tax — Phase 6: Operational Readiness

Phase 6 makes the tax module operable before the UK/AU pilot. It has
three PRs, each merged only on fully green CI:

- **PR 1:** a staging environment and a seed for the pilot rehearsal.
- **PR 2:** tax monitoring and alerts.
- **PR 3:** replace python-jose with PyJWT for the HS256 tokens.

## PR 1: staging environment

### The workflow: `.github/workflows/deploy-staging.yml`

| | |
|---|---|
| **Triggers** | A push to the `staging` branch, or **Run workflow** (manual), with an optional `ref` (branch, tag or commit) and an optional `seed_rehearsal` flag |
| **Secrets** | The GitHub **environment** `staging` only, plus `GITHUB_TOKEN` for the fetch. No production secret is read, apart from the production host name, which is used only to refuse it. |
| **Concurrency** | `staging-deploy`, one at a time and independent of production's `production-deploy` |
| **Target** | Its own VM. Everything lives under `/var/www/zoiko-billing-staging/`, run by its own systemd units, `zoiko-billing-staging-backend` and `zoiko-billing-staging-tax-worker`. |

**Guards (each one stops the deploy):**
- `STAGING_SSH_HOST` is the same as production's `GCP_SSH_HOST`.
- The target VM has the production checkout (`/var/www/zoiko-billing-backend`)
  or the production unit `zoiko-billing-backend`.
- A required staging secret is missing.
- `STAGING_STRIPE_SECRET_KEY` is a live key (`sk_live_…`).

**What it does:**
1. Fetches the ref with the run's read-only token.
2. Writes `backend/.env`; values are never echoed. The tax settings follow
   `TAX_PHASE4D0.md` ("How each key reaches each environment").

| Setting | Staging value |
|---|---|
| `ENVIRONMENT` | `staging` (so the app never treats it as production) |
| `DEBUG` | `false` |
| `BILLING_DATABASE_URL`, `BILLING_SECRET_KEY`, `MFA_ENCRYPTION_KEY` | Staging secrets: its **own** database, JWT key and MFA key |
| `TAX_PROVIDER_SECRET_STORE` | Variable `STAGING_TAX_PROVIDER_SECRET_STORE`; default `fernet` |
| `TAX_PROVIDER_ENCRYPTION_KEY`, `TAX_PROVIDER_PSEUDONYM_KEY` | Staging secrets |
| `TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED` | `false`, always |
| `TAX_PROVIDER_RECONCILIATION_MODE` | `worker` |
| `TAX_REGISTRY_STEP_UP_REQUIRED`, `TAX_TENANT_STEP_UP_REQUIRED` | `true` |
| `MFA_STEP_UP_BYPASS` | `false` |
| `SECURITY_CONTACT_EMAIL` | Variable `STAGING_SECURITY_CONTACT_EMAIL` (optional) |
| Stripe | Test-mode keys only |

3. Installs the requirements and runs `alembic upgrade head` against the
   **staging** database.
4. Runs the idempotent seeds: commercial plans, entitlements, and the tax
   registry reference data.
5. If `seed_rehearsal` is set, runs `scripts/seed_tax_pilot_rehearsal.py`.
6. Restarts both units and fails if either isn't active.
7. Builds the frontend with `VITE_API_BASE_URL` = `STAGING_API_BASE_URL`,
   and swaps it into `/var/www/zoiko-billing-staging/html`.

### Seed: `scripts/seed_tax_pilot_rehearsal.py`

For the pilot rehearsal (`TAX_PILOT_RUNBOOK_UK_AU.md`). It is
**idempotent**, and **refuses production**, using the same check as the
tax secret store: `ENVIRONMENT=production`, or unset with DEBUG off.

**What it creates:**
- **Tenant:** "Pilot Rehearsal Ltd (TEST)", with seller entities PRIMARY
  (GB, Europe/London) and AU (Australia/Sydney). Both start on **Legacy
  manual**; going governed is part of the rehearsal.
- **Tenant users,** one per runbook role:
  - two org admins (the two-person MFA reset needs two);
  - a billing admin;
  - two finance approvers;
  - an auditor.
- **Platform staff** (`--with-platform-staff`): a TAX_REVIEWER and a
  TAX_PUBLISHER.
- **Test records:** two customers (GB and AU) and two service products.

**No real data:**
- Every name is marked TEST.
- Emails use a reserved, non-deliverable domain (default
  `rehearsal.zoiko.test`); any other domain is refused.
- Nothing is copied from production.
- Passwords are generated per run and printed once. Store them in the
  team's password manager.

Run it from the workflow (`seed_rehearsal: true`) or on the VM:

```
cd /var/www/zoiko-billing-staging/backend-app/backend && source venv/bin/activate
ENVIRONMENT=staging python -m scripts.seed_tax_pilot_rehearsal --with-platform-staff
```

### What our admin must provision

1. **A staging VM, separate from production.**
   - Python 3.11, Node 20, nginx and git.
   - A deploy user with passwordless `sudo` for exactly these: `systemctl`
     for the two staging units, `install` into `/etc/systemd/system/`,
     `daemon-reload`, and `cp`, `mv`, `rm`, `mkdir` and `chown` under
     `/var/www/zoiko-billing-staging/`.
2. **A staging Postgres database,** with its own credentials and no network
   path to the production database. Never restore production data into it.
3. **The systemd unit `zoiko-billing-staging-backend`.**
   - Same shape as production's `zoiko-billing-backend`.
   - `WorkingDirectory=/var/www/zoiko-billing-staging/backend-app/backend`.
   - It runs uvicorn on its own port.
   - The worker unit is rendered by the deploy.
4. **nginx:** a staging hostname (e.g. `staging.zoikobilling.com`) serving
   `/var/www/zoiko-billing-staging/html`, and proxying `/api` to the staging
   backend port. Use HTTPS, and preferably restrict access (VPN, IP
   allowlist or basic auth): it is a rehearsal environment.
5. **The GitHub environment `staging`** (Settings → Environments), with
   required reviewers if wanted.

   **Secrets:**

   | Secret | What |
   |---|---|
   | `STAGING_SSH_HOST`, `STAGING_SSH_USER`, `STAGING_SSH_KEY` | The staging VM's SSH access |
   | `STAGING_BILLING_DATABASE_URL` | The staging database |
   | `STAGING_BILLING_SECRET_KEY` | A **new** JWT key, never production's |
   | `STAGING_MFA_ENCRYPTION_KEY` | A **new** Fernet key |
   | `STAGING_TAX_PROVIDER_ENCRYPTION_KEY` | A **new** Fernet key |
   | `STAGING_TAX_PROVIDER_PSEUDONYM_KEY` | A **new** key |
   | `STAGING_STRIPE_SECRET_KEY`, `STAGING_STRIPE_PUBLISHABLE_KEY` | Stripe **test-mode** keys (optional) |

   **Variables:**

   | Variable | What |
   |---|---|
   | `STAGING_FRONTEND_URL` | The staging site address |
   | `STAGING_API_BASE_URL` | The staging API address |
   | `STAGING_TAX_PROVIDER_SECRET_STORE` | `fernet` (default), or `gcp` with a staging GCP project |
   | `STAGING_SECURITY_CONTACT_EMAIL` | Optional |

6. **A `staging` branch** (optional): pushes to it deploy automatically.
   Otherwise use **Run workflow** with a ref.
7. **If `STAGING_TAX_PROVIDER_SECRET_STORE=gcp`:** a separate staging GCP
   project and service account, set up as `TAX_PHASE4D0.md` describes for
   production, but never production's project. Set
   `TAX_SECRET_MANAGER_PROJECT` and `_REGION` in the staging VM's `.env`.

### Tests

| Test file | Covers |
|---|---|
| `backend/tests/test_tax_phase6_staging_seed.py` (5) | The seed creates every runbook role, the platform staff (no organization), GB and AU entities on Legacy manual, TEST customers on a `.test` domain, products, and unique passwords; it is idempotent; it refuses production (explicit, and unset with DEBUG off); it refuses a deliverable email domain. The workflow's guards: both triggers, the `staging` environment, `ENVIRONMENT=staging`, production credentials off, no bypass, no live Stripe key, the production-host and production-VM refusals, its own units, migrations, and its own concurrency group. |

**CI result:** _see PR_.

## PR 2: tax monitoring

### What monitoring and alerting the app already had

| What | Where | What it does |
|---|---|---|
| **Attention Engine** | `super_admin/attention_service.py`, `AttentionItem` | The platform's alerting system. Each item has a severity (P0–P3), with SLA clocks, deduplication by `source_key`, escalation on repeats, auto-resolve, and the operator lifecycle (acknowledge, assign, resolve, suppress). Sources: scheduler job failures, kill-switch changes, Stripe/integration failures, entitlement enforcement and plan-change billing. Shown in the Super Admin Command Center. |
| **Scheduler job tracking** | `core/scheduler.py` (`JobRunLog`) | Every recurring job's run, status and error. A failing job raises an Attention item, and it auto-resolves on recovery. |
| **Telemetry and the Metric Dictionary** | `telemetry_service.py`, `metric_dictionary.py` | Cross-tenant operational counts, plus a code-reviewed registry where every Command Center metric must be defined |
| **Health endpoints** | `/health`, `/ready` | Liveness and readiness; the deploy checks `/ready` |
| **Launch readiness** | `launch_readiness_service.py` | Configuration checks, such as MFA and keys |
| **Ops email** | ZB-OPS-* templates | Email that supplements the Attention Engine for some delivery incidents |
| **Tax, already** | `aggregate_health`, the heartbeat, the circuit breaker | Provider health on `/super-admin/tax/providers`. A stale heartbeat and an open circuit already block issuing, but nothing raised an **alert** for them. |

There is no Prometheus, Sentry or external pager in the codebase. The tax
alerts therefore use the **Attention Engine**, the same system everything
else alerts through. Their metrics are registered in the **Metric
Dictionary**.

### What PR 2 adds

**`app/modules/tax/monitoring.py`:**
- `collect()` computes aggregate metrics.
- `evaluate()` compares them with the thresholds.
- `publish()` opens or updates one Attention item per firing alert
  (source `tax_monitoring`, key `tax:<alert>`) and auto-resolves the ones
  that cleared.
- It runs as the tracked scheduled job `tax_monitoring_job`, every
  `TAX_MONITORING_INTERVAL_MINUTES`. A failing run itself raises the
  standard job-failure alert.

| Alert | Severity | Default threshold (setting) |
|---|---|---|
| `tax.outbox_oldest_unresolved` | P1 | 30 min (`TAX_ALERT_OUTBOX_OLDEST_AGE_MINUTES`) |
| `tax.reconciliation_heartbeat` | P1 | 15 min, never run, or last pass failed (`TAX_ALERT_HEARTBEAT_STALE_MINUTES`) |
| `tax.circuit_open:<provider>` | P1 | Circuit OPEN |
| `tax.provider_unavailable:<market>` | P2 | 20% (`TAX_ALERT_PROVIDER_UNAVAILABLE_RATE`) over 60 min (`TAX_ALERT_RATE_WINDOW_MINUTES`), at least 10 quotes (`TAX_ALERT_RATE_MIN_QUOTES`) |
| `tax.not_determined:<market>` | P3 | 50% (`TAX_ALERT_NOT_DETERMINED_RATE`), same window and minimum |
| `tax.review_backlog` | P2 | 5 rows (`TAX_ALERT_REVIEW_BACKLOG`) |
| `tax.secret_store_failures` | P1 | 1 refused quote in the window (`TAX_ALERT_SECRET_STORE_FAILURES`) |

- **How "market" is measured:** the market is the quote's supply country.
- **How secret-store failures are counted:** from quotes refused with
  "provider credentials are unavailable", which every secret-store failure
  on the quoting path records. No new table.
- **Settings:** `TAX_MONITORING_ENABLED` (on) and
  `TAX_MONITORING_INTERVAL_MINUTES` (5).
- **Read-only endpoint:** `GET /api/v1/super-admin/tax-registry/monitoring`
  returns the metrics, thresholds and each alert's state. It needs
  `tax_registry.read` or `reliability.read`, the same as provider health.
  Tenant users are refused.
- **Metric Dictionary:** seven `zb.tax.*.v1` metrics.
- **Runbook:** `TAX_MONITORING_RUNBOOK.md`, one entry per alert.

**Aggregate only (T13):**
- Metrics and alert texts carry counts, ages, rates, provider names and
  country codes. Never an organization, invoice, customer or user.
- Attention items carry no `organization_id`.

### PR 2 tests

| Test file | Covers |
|---|---|
| `backend/tests/privacy/test_tax_phase6_monitoring.py` (10) | Each alert fires at its threshold and clears through the Attention Engine: outbox age (fires later, clears once reconciled); heartbeat (never run, stale, failed, configurable, off when reconciliation is disabled); the circuit per provider; the rates per market (window, minimum count, configurable threshold); the review backlog; secret-store failures. **No tenant identifiers** in alerts or metrics, and no organization on the items. Endpoint: tax and reliability roles, aggregate only; tenant users 403. The job is scheduled; the metrics are in the dictionary; monitoring can be switched off. |

**CI result:** _see PR_.

## PR 3: PyJWT replaces python-jose

**Why.** python-jose forced `pyasn1<0.5.0` and `ecdsa`, which have known
advisories. It also forced `pyasn1-modules` to be held at 0.3.0 for
google-auth. These were recorded as accepted risks in `requirements.txt`
and `TAX_PHASE4D0.md`. Our tokens are HS256 only, and PyJWT needs none of
those packages for HS256.

**What changed:**
- `requirements.txt`: `python-jose[cryptography]==3.4.0` is replaced by
  `PyJWT==2.10.1`. The `pyasn1-modules==0.3.0` pin and both accepted-risk
  notes are removed; `ecdsa` is no longer installed.
- `app/core/security.py` and `app/modules/auth/google_oauth.py` use
  `import jwt` and catch `jwt.PyJWTError`. The calls are otherwise the
  same: `encode(..., algorithm=settings.ALGORITHM)` and
  `decode(..., algorithms=[settings.ALGORITHM], issuer=settings.JWT_ISSUER)`.

**Compatibility.**
- **Same token format.** Both libraries produce the same compact HS256
  JWS, with header `{"alg":"HS256","typ":"JWT"}` and `exp` as an integer.
- **No forced logout.** Access and refresh tokens issued before the deploy
  keep working until they expire.
- **Claims pass PyJWT's checks unchanged.** Our `sub` is the user's email,
  a string, which PyJWT 2.10 requires, so nothing had to be relaxed.
- **Same security rules:**
  - only HS256 is accepted, so `alg: none` and other algorithms are
    refused;
  - the issuer must match;
  - `exp` is enforced;
  - the token `type` (access, refresh, Google state, signup ticket) is
    still checked by our code.

### PR 3 tests

| Test file | Covers |
|---|---|
| `backend/tests/test_jwt_pyjwt_migration.py` (10) | **Tokens issued by python-jose 3.4.0** (fixtures generated before the switch) still validate: an access token with all claims; a refresh token, only as refresh; an expired one is still rejected; a wrong key is rejected. Issue and verify round trip (HS256 header, integer `exp`); expiry; **tampering**: a changed payload, a changed signature, `alg: none`, HS512, a wrong key, malformed input; a missing or wrong issuer; Google OAuth state and signup tickets (round trip, tamper, wrong type). No code imports `jose`, and the requirements no longer pin python-jose, pyasn1 or ecdsa. |
| `backend/tests/test_auth_token_security.py` | Unchanged; now uses PyJWT for its forged-token cases |

The auth-related suites were also run with python-jose **uninstalled**, to
prove nothing else imports it.

**CI result:** _see PR_.
