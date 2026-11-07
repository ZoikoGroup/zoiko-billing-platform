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
