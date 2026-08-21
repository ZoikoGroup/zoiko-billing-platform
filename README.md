# Zoiko Billing Platform

A standalone, multi-tenant billing platform (customers, products, quotes, contracts,
subscriptions, invoicing, payments, dunning/collections, tax, Stripe billing)
extracted from the Zoiko One monorepo. It has its own database, its own auth
(no HR/Employee dependency), and no subscription-gating on itself — billing is
the whole product here, not an add-on module inside a bigger platform.

```
backend/    FastAPI + SQLAlchemy, own Postgres/SQLite database
frontend/   React 19 + Vite + Tailwind SPA
```

## Architecture at a glance

- **Auth** (`backend/app/modules/auth`) — `User` + `Organization` models, JWT
  login/register/refresh, invite/reset-password flows. Three roles:
  `super_admin` (platform-level, no organization), `org_admin` (owns an org),
  `billing_admin` (day-to-day billing inside an org).
- **Organizations** (`backend/app/modules/organizations`) — org profile CRUD,
  the `/api/organizations/me/*` endpoints the frontend's Organization Admin
  workspace reads from.
- **Super Admin** (`backend/app/modules/super_admin`) — minimal platform
  config (`PlatformSetting` key/value rows, e.g. an SMTP override) plus
  platform-wide aggregate queries.
- **Billing** (`backend/app/modules/billing`) — ported wholesale from the
  monorepo, with its imports repointed at the models above instead of
  `hr`/`employee`/`super_admin` from the old platform. This is almost all of
  the actual product.
- **Frontend** (`frontend/src/modules/billing`) — ported wholesale from the
  monorepo's billing module, plus a new minimal auth flow, organization-admin
  workspace, and `BillingShell` sidebar (`frontend/src/components`) written
  fresh for this platform's 3-role model.

## Environment variables

Copy `backend/.env.example` to `backend/.env` and `frontend/.env.example` to
`frontend/.env`, then fill in as needed. Every value has a safe development
default; nothing is required to boot locally with SQLite.

**Backend** (`backend/.env`):

| Variable | Purpose |
|---|---|
| `BILLING_DATABASE_URL` | Postgres connection string. Empty → SQLite fallback at `backend/app/data/billing_dev.sqlite3` (dev only). |
| `BILLING_SECRET_KEY` | JWT signing secret. Change before any real deployment. |
| `ALGORITHM`, `ACCESS_TOKEN_EXPIRE_MINUTES`, `REFRESH_TOKEN_EXPIRE_DAYS`, `JWT_ISSUER` | JWT tuning. |
| `BILLING_CORS_ORIGINS` | Comma-separated allowed browser origins. |
| `FRONTEND_URL` | Used to build links in transactional emails (invite, reset password, the `login_url` CTA in billing emails). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USERNAME` / `SMTP_PASSWORD` / `SMTP_FROM_EMAIL` / `SMTP_USE_TLS` | Outbound email. Blank = emails log a warning and no-op instead of failing. Can be overridden per-deployment via `PlatformSetting` rows with `category="email"` (see `services/admin_service.py`). |
| `SETUP_KEY` | Required to run `scripts/seed_super_admin.py`. Never exposed via any HTTP endpoint. **Unlike every other variable in this table, the script reads it from a raw shell environment variable, not from `.env`** — setting it here alone does not satisfy the script; export it in your shell immediately before running the script (see "Running locally" below). Use a strong, unique value for any real deployment — never reuse the local quickstart example. |
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_CURRENCY_DEFAULT` / `STRIPE_PAYMENT_METHOD_TYPES` / `STRIPE_BILLING_ADDRESS_COLLECTION` | Stripe Checkout + webhooks (`stripe_service.py`, `stripe_router.py`, `webhook_router.py`). Inert until `STRIPE_SECRET_KEY` is set — nothing requires them to boot. `STRIPE_PAYMENT_METHOD_TYPES` is a comma-separated list (default `card`); `STRIPE_BILLING_ADDRESS_COLLECTION` is `auto` or `required`. |
| `ENABLE_RECURRING_BILLING_SCHEDULER` | Off by default. Flip to `true` to run the dunning / recurring-billing / overdue-invoice background jobs (`core/scheduler.py`). |
| `BILLING_AUTO_EXPIRY_ENABLED`, `*_INTERVAL_MINUTES` | Background-job tuning, only relevant when the scheduler is enabled. |

**Frontend** (`frontend/.env`):

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Backend base URL. Baked in at build time (Vite convention) — if you change it, rebuild. |

## Running locally (without Docker)

**Backend:**

```sh
cd backend
python -m venv .venv
.venv\Scripts\activate        # or: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env        # or: cp .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8001
```

`--host 0.0.0.0` matters: uvicorn defaults to `127.0.0.1` (loopback only). If
`frontend/.env`'s `VITE_API_BASE_URL` points at a LAN IP (e.g.
`http://192.168.x.x:8001`, needed to test from another device on the network),
a loopback-only backend is unreachable at that address and every API call
fails with `net::ERR_CONNECTION_REFUSED` even though the server is running
and healthy on `127.0.0.1`. Match the bind address to whatever host
`VITE_API_BASE_URL` uses — `0.0.0.0` covers both `localhost` and the LAN IP.

There is no Alembic. The schema is created directly from the models via
`Base.metadata.create_all` — this runs automatically on startup
(`initialize_database()` in `app/database.py`), or on demand:

```sh
python -m migrations.create_all.create_all          # create schema
python -m migrations.create_all.create_all --drop   # wipe + recreate (dev only)
```

See `backend/migrations/create_all/README.md` for the table inventory. Then
seed accounts:

```sh
set SETUP_KEY=dev-setup-key
set BILLING_SUPER_ADMIN_EMAIL=admin@example.com
set BILLING_SUPER_ADMIN_PASSWORD=change-me-please
python -m scripts.seed_super_admin

python -m scripts.seed_org      # demo org + org_admin
```

Or just register your own organization through the API/UI at `/register` —
this creates an org + its first `org_admin` immediately (no approval step).

**Frontend:**

```sh
cd frontend
npm install
copy .env.example .env         # or: cp .env.example .env — point at your backend port
npm run dev
```

Visit `http://localhost:5173`, register an organization, and you're in.

## Running with Docker

```sh
docker compose up --build
```

Starts Postgres, the backend (on `localhost:8001`, matching the frontend's
baked-in `VITE_API_BASE_URL`), and the frontend (on `localhost:5173`, served
by nginx with SPA fallback routing). If you change the backend's port mapping
in `docker-compose.yml`, update `frontend/.env` and rebuild the frontend image
— Vite bakes `VITE_API_BASE_URL` in at build time, not at container startup.

*(The Dockerfiles follow standard conventions but have not been build-verified
in this environment — no running Docker daemon was available. Sanity-check a
`docker compose up --build` before relying on them for a real deployment.)*

## Verifying the extraction end to end

1. `uvicorn app.main:app --reload --port 8001` boots with no import errors.
2. `python -m migrations.create_all.create_all` runs cleanly against a fresh SQLite/Postgres DB.
3. `POST /api/auth/register` → `POST /api/auth/login` → JWT.
4. `GET /billing/customers` and `GET /billing/products` return `200` with an empty list on a fresh org.
5. Customer → Product → Invoice → line item → finalize → Payment → allocate → invoice flips to `paid`, all via `/docs`.
6. Frontend `npm run dev` → register → dashboard, customers, and invoices all render real data from the API.

All six were exercised manually while building this extraction.

## What was intentionally left out

- **Billing Admin workspace module** (`frontend/src/modules/billing-admin` in
  the source monorepo, 18 files). It turned out to be a generic org-workspace
  shell (dashboard, profile, subscription view, notifications, command
  palette) whose permission policy was derived from the *whole monorepo's*
  cross-module role matrix (HR/Payroll/Comply/Insights/Time), not billing
  logic. Its purpose is already covered by this platform's own
  `frontend/src/modules/organization-admin` + `BillingShell`, built fresh for
  the simpler 3-role model. Porting the original would have reintroduced
  exactly the platform-wide coupling this extraction removes, for no net
  functionality gain.
- **HR-specific role tiers** (`hr_admin`, `manager`, etc.) — collapsed to
  `super_admin` / `org_admin` / `billing_admin`.
- **Subscription/entitlement gating** — the monorepo wrapped the entire
  billing router behind `require_active_subscription("billing")`, since
  Billing was a paid add-on inside a bigger platform. Removed; the standalone
  equivalent (`core/dependencies.py`) only checks that the caller's
  organization exists and isn't suspended.
- **Alembic migration history** — the monorepo has 115 versioned migrations
  and a documented orphaned/duplicate-revision bug (see its `TODO.md`).
  Irrelevant here: this platform generates its schema directly from the
  current models via `create_all`, with no migration history to carry
  forward or repair.
- **OCR-based document scanning** (`pytesseract`) — never referenced by the
  billing module; not included.
- **Full HR `Employee` model** (40+ fields) — replaced by a minimal `User`
  model with only what billing's auth flow needs.

## Known issues carried forward

- **`xlsx` (SheetJS) high-severity advisory** — the npm-registry build used
  for Excel export (`frontend/src/utils/export-helpers.js`) has an unpatched
  prototype-pollution/ReDoS advisory; SheetJS ships fixes only via their own
  CDN, not npm. Left as-is pending a decision on whether to switch the install
  source — flagging rather than silently carrying a known high-severity issue.
