# Super Admin — Standalone Deployment Readiness

Generated: 2026-08-21 (session 6; session-7 addendum at bottom). Verifies that the Billing Super Admin
platform has no undocumented dependency on the Zoiko One monorepo it was
extracted from, and can discover/operate against every organization
registered in THIS platform's own database.

## Audit method

Searched the actual source (not documentation claims) for:
1. Cross-repo imports or references to a `zoiko-one`/`ZoikoOne` codebase.
2. Hardcoded external URLs pointing at a Zoiko One service.
3. Undocumented environment variables required to boot.
4. Organization-specific hardcoding that would prevent operating against
   an arbitrary number of tenants.

## Findings

| Area | Status | Evidence |
|---|---|---|
| Cross-repo runtime imports | **CLEAN** | `grep -rln "zoiko-one\|zoikoone\|ZoikoOne\|zoiko_one"` across `backend/app`+`frontend/src` returns only: (a) comments explicitly documenting independence (`config.py`: "Fully independent of the main ZoikoOne platform"; `main.py`: "Nothing from the old ZoikoOne codebase is imported at runtime"), and (b) legitimate Domain A enum VALUES (`BillingSource.REGISTERED_VIA_ZOIKO_ONE`, `BillingClassification.COMMERCIAL_ZOIKO_ONE`) that describe how a tenant was *onboarded*, not a runtime dependency on another codebase. No actual import, API call, or shared-database reference exists. |
| Hardcoded external URLs | **CLEAN** | No `http(s)://*zoiko*` string found outside `localhost`. |
| Environment variable completeness | **FIXED (1 gap found and closed this session)** | `COMMERCIAL_DUNNING_INTERVAL_MINUTES` (used by `core/scheduler.py`'s job registration, has a safe `config.py` default of 1440) was missing from `backend/.env.example` — added. All other scheduler/MFA/Stripe/SMTP/CORS variables were already documented. |
| Organization-specific hardcoding | **CLEAN** | `GET /api/organizations/` (list_organizations) has no per-org filtering beyond the caller's own `search`/`include_inactive` params; `TelemetryService.get_organization_health()` counts ALL organizations with no limit; the privileged-access grant flow accepts any `organization_id` that exists in the database. Nothing assumes a specific org, a maximum tenant count, or a "primary" organization. |
| Database | **CLEAN** | Own database (`BILLING_DATABASE_URL`, SQLite fallback for dev), own `Base.metadata` — no foreign schema/shared-table assumption. Confirmed via `README.md`'s own extraction notes and this session's independent re-verification. |
| Authentication | **CLEAN** | Own JWT issuer (`JWT_ISSUER=zoiko-billing-platform`), own `BILLING_SECRET_KEY`, own `SuperAdminMFA`/TOTP — no external identity provider or shared-session dependency. |

## What this document does NOT claim

This audit covers **code-level** standalone-readiness (no hidden coupling
in the source). It does not re-verify infrastructure-level deployment
concerns already covered elsewhere: Docker Compose build-verification
status (`README.md`'s own caveat: "Dockerfiles ... have not been
build-verified in this environment"), Neon/Postgres connectivity from a
specific network (`SUPER_ADMIN_CURRENT_STATE.md`'s DNS note), or a live
production secret-rotation process.

## Conceptual architecture (confirmed as implemented, not aspirational)

```
Zoiko Billing (standalone repository, own DB, own auth)
├── Tenant Billing              (billing module — Domain B, authoritative)
├── Tenant Administration       (organization-admin module)
└── Billing Super Admin         (super_admin module — Domain B/C oversight + Domain A, untouched)
    ├── Tenant Operations       (Organizations, Users pages — pre-existing)
    ├── Support Access          (Domain B JIT privileged access — session 4-6)
    ├── Tenant Health           (Domain C telemetry — session 4)
    ├── Reliability             (session 4, extended session 5)
    ├── Governance              (session 4, Attention Engine UI)
    ├── Attention               (Attention Engine — session 4-6)
    ├── Audit                   (pre-existing PlatformAuditLog, reused throughout)
    └── Launch Readiness        (session 5)
```

Every leaf under "Billing Super Admin" operates against the full set of
organizations in this platform's own database — none are scoped to a
single tenant or dependent on Zoiko One's organization model.

## Session-7 addendum

- **Tooling note**: the accessibility auditor (`frontend/scripts/a11y-audit.mjs`) uses `axe-core`, installed with `npm install --no-save axe-core` (NOT in `package.json` � deliberate, it is a dev-only audit tool; re-install ad hoc or move it into devDependencies if the audit should be repeatable from a fresh clone). Playwright's Chromium is used from the local `%LOCALAPPDATA%\ms-playwright` cache.
- **Transient DB unavailability hardening (ISS-012)**: `get_db()` now retries once on connection failure and raises `ServiceUnavailableException` (503, retryable) instead of letting a Neon DNS blip surface as an opaque 500 on endpoints like `/api/auth/login`. Verified by `test_get_db_returns_503_service_unavailable_when_db_unreachable`; full suite still 246/246. A live probe of the login path against the real database returned a clean 401 (wrong-password) — the code path is healthy; earlier observed login 500s were the environmental DNS failure, not a code regression.

## Session-8 addendum

- **Authentication remains fully standalone** (re-verified after the login-MFA removal): login is own-JWT (`login_user()` issues tokens directly for every role), MFA is the platform's own `SuperAdminMFA`/TOTP used purely as a privileged step-up factor, and no external identity provider or shared-session dependency was introduced. The removed pending-token flow eliminates one JWT variant rather than adding one.
- **New session-8 env surface**: none added. The org-created notification reuses the existing SMTP settings (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`/`SMTP_FROM` etc.) already documented in `.env.example`; delivery is fire-and-forget, so an unconfigured SMTP never blocks organization creation.
- **Full suite after session 8: 273/273 passed**; frontend build clean; axe-core still 0 violations / 9 routes; Domain A untouched (`git diff --name-only | grep -i commercial` empty).