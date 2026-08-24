# Super Admin Route Matrix

Every Super Admin frontend route, generated directly from `frontend/src/App.jsx`'s `SUPER_ADMIN_ROUTES` and `SUPER_ADMIN_LEGACY_REDIRECTS` tables as of this pass — not reconstructed from memory or screenshots. "Role required" reflects the backend enforcement the page's own API calls carry (see `docs/SUPER_ADMIN_API_MATRIX.md`); the frontend route itself has no role gate beyond `ProtectedRoute` (any authenticated user reaches the route component, but a non-`super_admin` gets 401/403 from every API call the page makes).

## Canonical routes

| Route | Page component | Primary backend endpoint(s) | Role required | Expected status (super_admin) | Nav group |
|---|---|---|---|---|---|
| `/super-admin/dashboard` | `PlatformDashboardPage.jsx` | `GET /api/super-admin/dashboard/stats`, `GET /api/super-admin/commercial-accounts`, `GET /api/super-admin/commercial-plans`, `GET /api/super-admin/commercial-subscriptions`, `GET /api/super-admin/approval-requests`, `GET /api/super-admin/production-acceptance`, `GET /api/super-admin/audit-logs` | super_admin | 200 | Overview |
| `/super-admin/organizations` | `OrganizationsPage.jsx` | `GET /api/super-admin/commercial-accounts` | super_admin | 200 | Platform |
| `/super-admin/organizations/:organizationId` | `OrganizationDetailPage.jsx` | `GET /api/super-admin/commercial-organizations/{id}`, `GET /api/organizations/{id}`, `PATCH .../status`, `DELETE /api/organizations/{id}` | super_admin | 200 | Platform |
| `/super-admin/users` | `UsersPage.jsx` | `GET /api/super-admin/users`, `PUT .../status`, `PUT .../reset-password` | super_admin | 200 | Platform |
| `/super-admin/settings` | `SettingsPage.jsx` | `GET/POST /api/super-admin/settings`, `PUT /api/super-admin/settings/{key}` | super_admin | 200 | Platform |
| `/super-admin/commercial/plans` | `PlansPage.jsx` | `GET/POST/PATCH /api/super-admin/commercial-plans` | super_admin | 200 | Commercial |
| `/super-admin/commercial/plans/:planId/versions` | `CommercialPlanVersionsPage.jsx` | `GET/POST /api/super-admin/commercial-plans/{id}/versions`, `.../commercial-plan-versions/{id}/{submit,approve,reject,archive}` | super_admin | 200 | Commercial |
| `/super-admin/commercial/subscriptions` | `SubscriptionsPage.jsx` | `GET/POST /api/super-admin/commercial-subscriptions`, `PATCH .../status`, `POST .../change-plan` (Phase 3F) | super_admin | 200 | Commercial |
| `/super-admin/commercial/entitlements` | `EntitlementsPage.jsx` | `GET /api/super-admin/commercial-accounts`, `GET /api/super-admin/commercial-subscriptions` | super_admin | 200 | Commercial |
| `/super-admin/commercial/invoices` | `Plane1BillingPage.jsx` (Phase 3F — was a PlatformDashboardPage placeholder) | `GET /api/super-admin/commercial-reporting`; Invoices/Payments/Collections panels are honest NOT IMPLEMENTED (no Plane 1 processor exists) | super_admin | 200 | Commercial |
| `/super-admin/audit-logs` | `AuditLogsPage.jsx` | `GET /api/super-admin/audit-logs`, `GET /api/super-admin/subscription-audit-logs` | super_admin | 200 | Governance |
| `/super-admin/approval-queue` | `ApprovalQueuePage.jsx` | `GET /api/super-admin/approval-requests`, domain-specific approve/reject endpoints | super_admin | 200 | Governance |
| `/super-admin/production-readiness` | `ProductionAcceptancePage.jsx` | `GET /api/super-admin/production-acceptance` | super_admin | 200 | Governance |
| `/super-admin/kill-switch` | `KillSwitchPage.jsx` | `GET/PUT /api/super-admin/billing-kill-switch` | super_admin | 200 | Operations |
| `/super-admin/support-access` | `SupportAccessPage.jsx` (added 2026-08-21, Domain B) | `GET /api/organizations/`, `POST/GET .../privileged-access/{request,active,mine}`, `POST .../privileged-access/{id}/{activate,exit}`, `GET .../privileged-access/{id}/tenant-summary` | super_admin | 200 | Platform |
| `/super-admin/tenant-health` | `TenantHealthPage.jsx` (added 2026-08-21, Domain C) | `GET /api/super-admin/telemetry/organizations`, `GET /api/super-admin/telemetry/jobs` | super_admin | 200 | Platform |
| `/super-admin/governance` | `GovernancePage.jsx` (added 2026-08-21 session 4) | `GET .../attention`, `GET .../attention/counts`, `POST .../attention/{id}/{acknowledge,assign,transition,suppress}` | super_admin | 200 | Governance |
| `/super-admin/reliability` | `ReliabilityPage.jsx` (added 2026-08-21 session 4) | `GET /health` (unauthenticated liveness), `GET /api/super-admin/telemetry/jobs` | super_admin | 200 | Reliability |
| `/super-admin/launch-readiness` | `LaunchReadinessPage.jsx` (added session 5) | `GET /api/super-admin/launch-readiness` | super_admin | 200 | Governance |
| `/super-admin/triage` | `TriagePage.jsx` (added session 7) | `GET /api/super-admin/triage/summary` (capability `triage.read`) | super_admin | 200 | Reliability |
| `/organization-admin/privileged-access-log` | `PrivilegedAccessLogPage.jsx` (added session 5) | `GET /api/organizations/me/privileged-access-log` | any org-scoped role | 200 | Domain B (tenant-facing) |

## Legacy redirects (still resolve, never render a second copy of a page)

| Legacy route | Redirects to | Notes |
|---|---|---|
| `/dashboard` | `/super-admin/dashboard` | Pre-consolidation Platform Dashboard path |
| `/users` | `/super-admin/users` | |
| `/settings` | `/super-admin/settings` | Also linked from `TopBar.jsx`'s non-super_admin "Profile Settings" item — see note below |
| `/organizations` | `/super-admin/organizations` | |
| `/super-admin/commercial/dashboard` | `/super-admin/dashboard` | Pre-consolidation Commercial Control Center path |
| `/super-admin/commercial/organizations` | `/super-admin/organizations` | |
| `/super-admin/commercial/organizations/:organizationId` | `/super-admin/organizations/:organizationId` | Param substituted, query string preserved |
| `/super-admin/commercial/audit-logs` | `/super-admin/audit-logs` | |
| `/super-admin/commercial/approvals` | `/super-admin/approval-queue` | Reconciles the naming mismatch noted in the audit (Section T) |
| `/super-admin/commercial/kill-switch` | `/super-admin/kill-switch` | |
| `/super-admin/commercial/production-acceptance` | `/super-admin/production-readiness` | |

**Note on `/settings`**: `TopBar.jsx` links non-`super_admin` roles to `/settings` labeled "Profile Settings," but `ProtectedRoute.jsx` already blocks any non-`super_admin` from reaching any path other than `/portal`, `/billing*`, or `/organization-admin/*` — so that link already redirected such a user to `/portal` before this pass, and does so identically after it. This is a pre-existing org_admin/billing_admin-facing frontend issue, out of scope for this Super-Admin-only pass (see the master task's explicit boundary).

## Session 6 additions (no new routes — extended existing pages)

- `/super-admin/governance` (`GovernancePage.jsx`) gained a "Circuit Breakers" card (pause/resume invoice finalization, MFA step-up modal) — same route, no new page.
- `/super-admin/users` (`pages/UsersPage.jsx`) gained a "Platform Role" column with an inline editor, visible only to a PLATFORM_ADMINISTRATOR viewer — same route, no new page.

## Session 8 changes (no new routes — auth flow + settings page)

- `/login` (`LoginPage.jsx`) no longer renders any MFA gate for super_admin: `POST /api/auth/login` returns tokens directly for every role. The `SuperAdminMFAGate` component was deleted; there is no MFA step between login and the dashboard.
- `/super-admin/settings` (`SettingsPage.jsx`) gained a "Security — MFA step-up" card: enrollment (`POST /api/auth/mfa/setup/start` → `/verify`, shows secret/otpauth URI then one-time recovery codes), status (`GET /api/auth/mfa/status`), and disable with password confirm (`POST /api/auth/mfa/disable`). Same route, no new page.

## Verification performed

- `cd frontend && npm run build` — clean build, no import errors, main chunk ~493KB (unchanged from baseline), `PlatformDashboardPage` and every other Super Admin page independently lazy-chunked.
- Every internal `navigate()`/`href`/`Link to=` inside `modules/super-admin/*.jsx` was grepped and confirmed to point at a canonical path (not a legacy one) after this pass's edits.
- Route click-through in a live browser was **not** performed this pass (no browser session available in this environment) — this is a code-level verification (import graph, route table, internal link audit), not a manual QA pass. Flagged explicitly per the master task's instruction not to overstate what was verified.
