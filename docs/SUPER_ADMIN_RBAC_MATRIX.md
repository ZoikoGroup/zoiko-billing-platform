# Super Admin Command Center — RBAC / ABAC Matrix

Generated: 2026-08-21, updated session 6. **Session 6 replaced session 5's
scaffolding with real, ENFORCED per-role differentiation.** A `super_admin`
account now carries a second, orthogonal `PlatformRole` (NULL = full
access, backward compatible with every account that existed before this
column was added), and `require_capability()` genuinely checks it —
calling an endpoint the caller's role doesn't include now returns a real
403, verified adversarially.

## Two-dimensional model

```
UserRole.SUPER_ADMIN          <- unchanged floor every endpoint still requires
        │
        ▼
PlatformRole (NULL = full access = PLATFORM_ADMINISTRATOR)
    ├── PLATFORM_ADMINISTRATOR   full access to every capability below
    ├── SUPPORT_OPERATOR         tenant_support.* + read-only triage/reliability/governance/search
    ├── SECURITY_OPERATOR        governance/incident/circuit_breaker + audit.read
    ├── RELIABILITY_OPERATOR     reliability/incident + governance.read
    ├── AUDITOR                  read-only across governance/reliability/financial/launch-readiness — no ACT capabilities
    └── FINANCE_READONLY         financial_consistency.read + metric_dictionary.read only
```

Source: `backend/app/modules/auth/models.py:PlatformRole`,
`backend/app/core/capabilities.py:_CAPABILITY_ROLE_MAP`.

## Capability matrix (actual enforcement, session 6)

| Capability | Meaning | Roles that hold it (+ PLATFORM_ADMINISTRATOR always) | Endpoint(s) |
|---|---|---|---|
| `triage.read` | View triage-relevant state | SUPPORT_OPERATOR, SECURITY_OPERATOR, RELIABILITY_OPERATOR, AUDITOR | `GET /triage/summary` (session 7 — standalone endpoint composing attention + jobs + breakers + audit tail) |
| `reliability.read` | View Reliability lens | RELIABILITY_OPERATOR, SECURITY_OPERATOR, AUDITOR, SUPPORT_OPERATOR | `GET /telemetry/organizations`, `GET /telemetry/jobs` |
| `governance.read` | View Governance lens | SECURITY_OPERATOR, RELIABILITY_OPERATOR, AUDITOR, SUPPORT_OPERATOR | `GET /attention`, `GET /attention/counts` |
| `tenant_support.request` | Request a Domain B grant | SUPPORT_OPERATOR only | `POST /privileged-access/request`, `GET .../active`, `GET .../mine`, `GET .../{id}/tenant-summary` |
| `tenant_support.activate` | Complete MFA step-up on a grant | SUPPORT_OPERATOR only | `POST /privileged-access/{id}/activate` |
| `tenant_support.exit` | Explicitly end a grant | SUPPORT_OPERATOR only | `POST /privileged-access/{id}/exit` |
| `incident.acknowledge` | Acknowledge an Attention item | SECURITY_OPERATOR, RELIABILITY_OPERATOR | `POST /attention/{id}/acknowledge` |
| `incident.assign` | Assign an Attention item | SECURITY_OPERATOR, RELIABILITY_OPERATOR | `POST /attention/{id}/assign` |
| `incident.transition` | Move an Attention item through its lifecycle | SECURITY_OPERATOR, RELIABILITY_OPERATOR | `POST /attention/{id}/transition` |
| `incident.suppress` | Suppress an Attention item | SECURITY_OPERATOR, RELIABILITY_OPERATOR | `POST /attention/{id}/suppress` |
| `audit.read` | View audit logs | SECURITY_OPERATOR, AUDITOR | Pre-existing endpoint (not migrated to `require_capability` — see below) |
| `launch_readiness.read` | View Launch Readiness | SECURITY_OPERATOR, RELIABILITY_OPERATOR, AUDITOR | `GET /launch-readiness` |
| `financial_consistency.read` | View the internal financial consistency check | AUDITOR, FINANCE_READONLY | `GET /financial-consistency` |
| `metric_dictionary.read` | View the Metric Dictionary | SECURITY_OPERATOR, RELIABILITY_OPERATOR, AUDITOR, FINANCE_READONLY | `GET /metric-dictionary` |
| `global_search.read` | Use global search | SUPPORT_OPERATOR, SECURITY_OPERATOR, RELIABILITY_OPERATOR, AUDITOR | `GET /search` |
| `circuit_breaker.read` | View circuit breaker state | SECURITY_OPERATOR, RELIABILITY_OPERATOR, AUDITOR | `GET /circuit-breakers`, `GET /circuit-breakers/{scope}` (session 7 catalog; legacy single-scope GET retained) |
| `circuit_breaker.manage` | Toggle a circuit breaker (directly = break-glass), propose a change, or decide a pending change as the checker | SECURITY_OPERATOR only | `PUT /circuit-breakers/{scope}`, `POST /circuit-breakers/{scope}/approval-request`, `POST /approval-requests/{id}/decision` (all also require fresh MFA step-up; engage additionally requires `incident_reference` + bounded `auto_expire_minutes`; self-approval structurally blocked) |
| `platform_role.manage` | Assign another super_admin's PlatformRole | **PLATFORM_ADMINISTRATOR only** — no operator role holds it | `PUT /users/{id}/platform-role` |
| `commercial_quote.write` | Create, send, and convert commercial quotes | SUPPORT_OPERATOR | `POST /commercial-billing/quotes`, `POST .../send`, `POST .../convert` |
| `commercial_quote.approve` | Approve/reject commercial quotes (enforces approver != creator) | AUDITOR | `POST /commercial-billing/quotes/{id}/approve`, `POST .../reject` |
| `commercial_payment.write` | Record platform payments, allocate/deallocate | SECURITY_OPERATOR | `POST /commercial-billing/payments`, `POST .../allocate`, `POST .../deallocate` |
| `commercial_financial.read` | Read platform invoices, payments, reconciliation, quote lists | AUDITOR, FINANCE_READONLY | `GET /commercial-billing/quotes`, `GET .../invoices`, `GET .../payments`, `POST .../reconciliation/run` |
| `commercial_financial.write` | Create, finalize, and void platform invoices; add invoice items | SECURITY_OPERATOR | `POST /commercial-billing/invoices`, `POST .../invoices/{id}/finalize`, `POST .../invoices/{id}/void`, `POST .../invoices/{id}/items` |
| `commercial_evaluation_program.write` | Activate or manage evaluation/trial programs | **PLATFORM_ADMINISTRATOR only** — no operator role holds it | `POST /commercial-billing/evaluation-programs`, `PATCH .../evaluation-programs/{id}/status` |
| `job.retry` | Retry a failed telemetry job | RELIABILITY_OPERATOR | `POST /telemetry/jobs/{job_name}/retry` |
| `platform_config.read` | View the platform configuration inventory | SUPPORT_OPERATOR, SECURITY_OPERATOR, RELIABILITY_OPERATOR, AUDITOR | `GET /configuration`, `GET /settings` |
| `platform_config.manage` | Mutate platform settings (audited) | SECURITY_OPERATOR | `POST /settings`, `PUT /settings/{key}` |

**Deliberately not built**: `tenant_support.break_glass` (privileged access keeps its request→activate flow; there is no bypass), `commercial.read`/`financial_ops.read` (Domain A / not-built lens, out of scope). Session 7 note: the previously-missing breaker maker-checker capabilities now EXIST (`circuit_breaker.manage` covers both direct break-glass engage and proposal; the checker path is also gated by `circuit_breaker.manage` — the old "single toggle, no workflow" limitation is closed).

## What IS real authorization beyond the capability check

- **Privileged-access grant ownership**: every grant mutation independently verifies `grant.requested_by_user_id == actor.id` (`NotFoundException`, never leaking existence) — adversarially tested.
- **MFA step-up freshness**: activation requires a TOTP/recovery code within 5 minutes of the request.
- **TOTP replay protection**: a spent code cannot be reused to satisfy a step-up (all verification flows share `SuperAdminMFA.last_used_code_hash`). Since session 8 login itself is password-only (no MFA screen), so step-up is the sole consumer — and it remains mandatory with no fallback.
- **MFA self-service is authenticated-only** (session 8): `POST /auth/mfa/setup/start|verify`, `GET /auth/mfa/status`, `POST /auth/mfa/disable` all require a valid session (`get_current_user`); enrollment never mints tokens, and disable requires the account password.
- **Circuit breaker MFA step-up**: `PUT /circuit-breakers/tenant-invoice-finalization` requires a FRESH code on every toggle (pause AND resume) — verified adversarially (wrong code rejected; a stale/replayed code rejected).
- **Grant expiry**: re-checked on every read, never trusting a previously-observed status.
- **Privilege-escalation prevention**: only `PLATFORM_ADMINISTRATOR` holds `platform_role.manage` — a `SUPPORT_OPERATOR`/`SECURITY_OPERATOR`/etc. cannot grant themselves or any peer more capabilities (adversarially tested: `test_only_platform_administrator_can_manage_platform_roles`).
- **Immediate revocation**: `has_capability()` reads `user.platform_role` fresh on every call — a role downgrade takes effect on the very next request, no re-login or cache invalidation needed (`test_capability_revoked_immediately_on_role_change`).
- **Inactive-account rejection**: a deactivated Super Admin's existing, unexpired JWT stops working immediately (`get_current_user` re-checks `is_active` from the DB every call — `test_inactive_super_admin_rejected_by_get_current_user`, exercised with a real token, not a reimplementation).
- **`finance_approver`/`auditor` segregation** (pre-existing, unrelated Domain B billing-plane roles): `get_current_finance_approver` still blocks a `billing_admin` from self-approving their own refund request.

## Known remaining gap

`audit.read` (the pre-existing `/audit-logs` endpoint) and the ~30
pre-existing Domain A endpoints are still gated by the bare
`get_current_super_admin` only — not migrated to `require_capability`.
This is a deliberate scope boundary (lower risk tolerance for working
Domain A code not otherwise touched this session), not an oversight.

## Managing platform roles

`PUT /api/super-admin/users/{user_id}/platform-role?platform_role=<value>`
— PLATFORM_ADMINISTRATOR only, audited (`PlatformAuditLog`, old/new
values), rejects non-super_admin targets and invalid role names. Frontend:
`pages/UsersPage.jsx` — a "Platform Role" column with an inline `<select>`
editor, visible only to a viewer whose OWN platform_role is
PLATFORM_ADMINISTRATOR (or NULL).

## Existing platform-wide roles (unchanged)

`super_admin`, `org_admin`, `billing_admin`, `finance_approver`, `auditor`
(`UserRole`, distinct from `PlatformRole` above) — see
`backend/app/modules/auth/models.py`. None of these five were modified
this session; `PlatformRole` is a wholly new, additive, nullable column
only ever consulted when `role == super_admin`.
