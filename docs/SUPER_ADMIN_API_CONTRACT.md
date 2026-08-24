# Super Admin Command Center — API Contract (new endpoints, session 4)

Generated: 2026-08-21 (updated session 8). Lists endpoints added/changed across sessions; later-session additions are marked. For
the full pre-existing Domain A surface, see `SUPER_ADMIN_API_MATRIX.md`.
All endpoints below are mounted at `/api/super-admin/*` and gated by
`get_current_super_admin` (see `SUPER_ADMIN_RBAC_MATRIX.md` for the
granularity caveat).

## Auth surface changes (session 8 — ZB-SA-CMD-003 v3.0 directive)

These live under `/api/auth/*`, not `/api/super-admin/*`, and changed this session:

| Method | Path | Change | Notes |
|---|---|---|---|
| POST | `/auth/login` | CHANGED | Valid credentials now return `TokenResponse` (access + refresh) DIRECTLY for every role, including super_admin. The `LoginResponse` `mfa_status`/`mfa_token` side-channel was REMOVED — there is no login-time MFA screen. |
| POST | `/auth/mfa/enroll/start`, `/auth/mfa/enroll/verify`, `/auth/mfa/challenge` | REMOVED | 404. Enrollment moved to authenticated self-service below; step-up verification happens inline on the privileged endpoints that require it. |
| POST | `/auth/mfa/setup/start` | NEW | `get_current_user` (super_admin). Returns `{secret, otpauth_uri}` for authenticator enrollment. |
| POST | `/auth/mfa/setup/verify` | NEW | `get_current_user`. Body `{code}`. Confirms enrollment, returns one-time recovery codes. NEVER mints tokens. |
| GET | `/auth/mfa/status` | NEW | `get_current_user`. `{mfa_enabled}`. |
| POST | `/auth/mfa/disable` | UNCHANGED | `get_current_user` + password confirm. |
| GET | `/api/auth/country-defaults` | CHANGED | No longer exposes a `fallback_currency` field. Currency resolution is strict: explicit supported code > country-derived default > explicit 400 naming the country (no silent USD). |

## Domain B — Privileged Tenant Access

| Method | Path | Request | Response | Notes |
|---|---|---|---|---|
| POST | `/privileged-access/request` | `{organization_id, reason, ticket_reference, requested_minutes<=30}` | `PrivilegedAccessGrantResponse` (status=pending_step_up) | Rejects if actor already has a live grant. |
| POST | `/privileged-access/{grant_id}/activate` | `{code}` or `{recovery_code}` | `PrivilegedAccessGrantResponse` (status=active, expires_at set) | Requires ownership + step-up within 5 minutes of request. |
| GET | `/privileged-access/active` | — | `PrivilegedAccessGrantResponse \| null` | Actor's own pending/active grant only; lazily expires stale ACTIVE grants. |
| POST | `/privileged-access/{grant_id}/exit` | — | `PrivilegedAccessGrantResponse` (status=exited) | Idempotent if already expired/exited. |
| GET | `/privileged-access/mine` | `?limit=` | `PrivilegedAccessGrantListResponse` | Actor's own grant history. |
| GET | `/privileged-access/{grant_id}/tenant-summary` | — | `TenantAccessSummaryResponse` | Requires an ACTIVE, owned, unexpired grant matching the URL's grant_id; org is derived from the grant, never a query param. |

## Domain C — Telemetry

| Method | Path | Response | Notes |
|---|---|---|---|
| GET | `/telemetry/organizations` | `OrganizationHealthResponse` | Counts only, `is_active`-derived. |
| GET | `/telemetry/jobs` | `JobHealthListResponse` | Per-job status/timing/freshness from `JobRunLog`. |

## Governance — Attention Engine

| Method | Path | Request | Response | Notes |
|---|---|---|---|---|
| GET | `/attention` | `?limit=` | `AttentionItemListResponse` | Open-like items, severity-then-age sorted. |
| GET | `/attention/counts` | — | `AttentionCountsResponse` | p0-p3 counts, total_open, sla_breaches. |
| POST | `/attention/{item_id}/acknowledge` | — | `AttentionItemResponse` | Only from OPEN. |
| POST | `/attention/{item_id}/assign` | `{owner_user_id}` | `AttentionItemResponse` | Validates `owner_user_id` exists (404 if not) — fixed during this session's documentation pass; see `test_attention_assign_rejects_nonexistent_owner`. |
| POST | `/attention/{item_id}/transition` | `{to_status, resolution_code?}` | `AttentionItemResponse` | Server-validated forward-transition graph; `resolved` requires `resolution_code`. |
| POST | `/attention/{item_id}/suppress` | `{reason, minutes<=10080}` | `AttentionItemResponse` | Time-bound only; auto-lifts on next `list_open()` call after expiry. |

## Metric Dictionary / Search

| Method | Path | Request | Response | Notes |
|---|---|---|---|---|
| GET | `/metric-dictionary` | `?domain=B\|C\|governance` | `MetricDictionaryResponse` | Static, code-versioned. |
| GET | `/search` | `?q=` | `SearchResponse` | Organizations (identity only), AttentionItems, AuditLog entity matches, exact correlation-ID lookups. |

## Launch Readiness / Financial Consistency (session 5)

| Method | Path | Response | Notes |
|---|---|---|---|
| GET | `/launch-readiness` | `LaunchReadinessResponse` | 11 real checks (DB, secrets, MFA encryption, MFA enrollment, audit log, scheduler, CORS, open P0 attention, financial consistency, accessibility[UNKNOWN], performance[UNKNOWN]). `overall_status` = FAIL if any item FAILs, else WARNING if any WARNING/UNKNOWN, else PASS. |
| GET | `/financial-consistency` | `FinancialConsistencyResponse` | Internal `PaymentAllocation` vs `Invoice.total_amount` consistency only — NOT reconciliation against a processor/bank (see `coverage_note` in every response). `state`: VERIFIED / FAILED / UNKNOWN (zero invoices). |

## Tenant-visible privileged-access log (session 5, closes ISS-021)

| Method | Path | Auth | Response | Notes |
|---|---|---|---|---|
| GET | `/api/organizations/me/privileged-access-log` | `get_current_user` (any org-scoped role) + `get_organization_id` | `PrivilegedAccessLogResponse` | One row per support-access session for the CALLER'S org only (never another org's). Reads `PrivilegedTenantAccessGrant` directly — reason/ticket/timestamps, no Super Admin operator identity exposed. |

## Capability declarations (REAL enforcement as of session 6)

Every endpoint above (except the tenant-visible access log, which uses the
pre-existing `get_current_user`/`get_organization_id` pattern) is gated by
`Depends(require_capability("<name>"))` from `app/core/capabilities.py`.
As of session 6 this is genuinely differentiated by the caller's
`PlatformRole` — see `SUPER_ADMIN_RBAC_MATRIX.md` for the full
capability-to-role mapping and the earlier "Capability enforcement" note
above.

## Circuit breakers (session 6)

| Method | Path | Auth | Request | Response | Notes |
|---|---|---|---|---|---|
| GET | `/circuit-breakers/tenant-invoice-finalization` | `circuit_breaker.read` | — | `BillingKillSwitchResponse` | Real state — `InvoiceService.finalize_invoice()` itself checks this. |
| PUT | `/circuit-breakers/tenant-invoice-finalization` | `circuit_breaker.manage` (SECURITY_OPERATOR only) + fresh MFA step-up | `CircuitBreakerToggleRequest` (`enabled`, `reason`, `code`/`recovery_code`) | `BillingKillSwitchResponse` | Toggling ACTUALLY blocks/unblocks tenant invoice finalization platform-wide; opens/auto-resolves a real Attention item. |


## Circuit breakers � generalized catalog + maker-checker (session 7)

Supersedes the single-scope session-6 rows below (those paths remain as thin
delegates for backward compatibility). All breaker scopes now live under one
registry (`DOMAIN_B_BREAKER_CATALOG` in `kill_switch_service.py`): `commercial_subscription_charging`, `tenant_invoice_finalization`, `tenant_payment_attempts`, `tenant_dunning`, `tenant_billing_communications`.

| Method | Path | Capability | Request | Response | Notes |
|---|---|---|---|---|---|
| GET | `/circuit-breakers` | `circuit_breaker.read` | � | `CircuitBreakerCatalogResponse` | Full catalog: display name, domain, effect, gated code paths, current state, `expires_at`. |
| GET | `/circuit-breakers/{scope}` | `circuit_breaker.read` | � | `CircuitBreakerStateResponse` | One scope's state; unknown scope ? 404. |
| PUT | `/circuit-breakers/{scope}` | `circuit_breaker.manage` + fresh MFA step-up | `CircuitBreakerToggleRequest` (`enabled`, `reason?`, `incident_reference` REQUIRED to engage, `auto_expire_minutes` REQUIRED to engage, clamped [5, 20160], default 480, `code`/`recovery_code`) | `CircuitBreakerStateResponse` | Break-glass direct engage/release. Engaged pauses auto-expire (lazy lift on read, audited, attention auto-resolved). Opens/auto-resolves a P1 attention item. |
| POST | `/circuit-breakers/{scope}/approval-request` | `circuit_breaker.manage` | `CircuitBreakerChangeProposalCreate` (`proposed_enabled`, `reason`, `incident_reference`, `auto_expire_minutes`) | `ApprovalRequestResponse` | Maker-checker path: creates a pending `ApprovalRequest` (`request_type="circuit_breaker_change"`). No state change until a second operator decides. |
| POST | `/approval-requests/{request_id}/decision` | `circuit_breaker.manage` + fresh MFA step-up | `ApprovalDecisionRequest` (`decision` accept/reject, `note?`, `code`/`recovery_code`) | `ApprovalRequestResponse` | Dispatches ONLY `circuit_breaker_change` requests. Self-approval structurally blocked (403). Accept applies the toggle atomically; reject records a no-op decision. |

## Triage lens (session 7)

| Method | Path | Capability | Response | Notes |
|---|---|---|---|---|
| GET | `/triage/summary` | `triage.read` | `TriageSummaryResponse` | Server-composed: attention counts + top items, job/pipeline health, safety-control (breaker) states, last 10 redacted audit events, `generated_at`. Refresh cadence 30�60s per �18.2. |
## Platform role management (session 6)

| Method | Path | Auth | Notes |
|---|---|---|---|
| PUT | `/users/{user_id}/platform-role?platform_role=<value>` | `platform_role.manage` (PLATFORM_ADMINISTRATOR only) | Rejects non-super_admin targets and invalid role names; audited (old/new values). |

## Capability enforcement (real, session 6 — supersedes session 5's scaffolding note below)

Every endpoint's `Depends(require_capability("..."))` now genuinely checks
the caller's `PlatformRole` — see `SUPER_ADMIN_RBAC_MATRIX.md` for the full
capability-to-role map. A caller whose role doesn't include the required
capability receives a real `403 ForbiddenException`.

## Response schema locations

All Pydantic schemas: `backend/app/modules/super_admin/schemas.py` (new
classes appended after the pre-existing `ProductionAcceptanceReport`).

## Error contract (unchanged from platform convention)

- `400 BadRequestException` — validation/state errors (e.g. missing
  resolution_code, duplicate live grant, wrong MFA code).
- `403 ForbiddenException` — authorization failures (e.g. inactive grant
  accessed, role mismatch).
- `404 NotFoundException` — used deliberately for cross-actor IDOR attempts
  (never a 403) so existence of another actor's grant is never disclosed.
- `401 UnauthorizedException` — MFA verification failures.
