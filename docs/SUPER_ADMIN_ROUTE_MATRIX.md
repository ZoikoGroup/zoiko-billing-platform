# Super Admin Route Matrix

Every Super Admin frontend route, generated directly from `frontend/src/App.jsx`'s `SUPER_ADMIN_ROUTES` and `SUPER_ADMIN_LEGACY_REDIRECTS` tables as of this pass — not reconstructed from memory or screenshots. "Role required" reflects the backend enforcement the page's own API calls carry (see `docs/SUPER_ADMIN_API_MATRIX.md`); the frontend route itself has no role gate beyond `ProtectedRoute` (any authenticated user reaches the route component, but a non-`super_admin` gets 401/403 from every API call the page makes).

**Note**: Several component import variables in `App.jsx` use a `Commercial` prefix (e.g. `CommercialOrganizationsPage`) while the file on disk is `OrganizationsPage.jsx`. The "Page component" column below references the actual file name.

## Canonical routes

| Route | Page component | Primary backend endpoint(s) | Role required | Expected status (super_admin) | Nav group |
|---|---|---|---|---|---|
| `/super-admin/command-center` | `CommandCenterHubPage.jsx` | *(composes triage, jobs, breakers, audit tail)* | super_admin | 200 | Command Center |
| `/super-admin/dashboard` | `PlatformDashboardPage.jsx` | `GET /api/super-admin/dashboard/stats`, `GET /api/super-admin/commercial-accounts`, `GET /api/super-admin/commercial-plans`, `GET /api/super-admin/commercial-subscriptions`, `GET /api/super-admin/approval-requests`, `GET /api/super-admin/production-acceptance`, `GET /api/super-admin/audit-logs` | super_admin | 200 | *(TopBar link)* |
| `/super-admin/organizations` | `OrganizationsPage.jsx` | `GET /api/super-admin/commercial-accounts` | super_admin | 200 | Platform |
| `/super-admin/organizations/:organizationId` | `OrganizationDetailPage.jsx` | `GET /api/super-admin/commercial-organizations/{id}`, `GET /api/organizations/{id}`, `PATCH .../status`, `DELETE /api/organizations/{id}` | super_admin | 200 | Platform |
| `/super-admin/users` | `UsersPage.jsx` | `GET /api/super-admin/users`, `PUT .../status`, `PUT .../reset-password` | super_admin | 200 | Platform |
| `/super-admin/settings` | `SettingsPage.jsx` | `GET/POST /api/super-admin/settings`, `PUT /api/super-admin/settings/{key}` | super_admin | 200 | *(TopBar link)* |
| `/super-admin/platform/lifecycle` | `LifecycleOnboardingPage.jsx` | *(org lifecycle onboarding — no dedicated backend endpoint)* | super_admin | 200 | Platform |
| `/super-admin/tenant-health` | `TenantHealthPage.jsx` | `GET /api/super-admin/telemetry/organizations` | super_admin | 200 | Platform |
| `/super-admin/tenant-health/jobs` | `TenantHealthPage.jsx` | `GET /api/super-admin/telemetry/jobs` | super_admin | 200 | Platform |
| `/super-admin/support-access` | `SupportAccessPage.jsx` | `GET /api/organizations/`, `POST/GET .../privileged-access/{request,active,mine}`, `POST .../privileged-access/{id}/{activate,exit}`, `GET .../privileged-access/{id}/tenant-summary` | super_admin | 200 | Platform |
| `/super-admin/commercial/accounts` | `OrganizationsPage.jsx` | `GET /api/super-admin/commercial-accounts` | super_admin | 200 | Platform Commercial |
| `/super-admin/commercial/plans` | `PlansPage.jsx` | `GET/POST/PATCH /api/super-admin/commercial-plans` | super_admin | 200 | Platform Commercial |
| `/super-admin/commercial/plans/:planId/versions` | `CommercialPlanVersionsPage.jsx` | `GET/POST /api/super-admin/commercial-plans/{id}/versions`, `.../commercial-plan-versions/{id}/{submit,approve,reject,archive}` | super_admin | 200 | Platform Commercial |
| `/super-admin/commercial/subscriptions` | `SubscriptionsPage.jsx` | `GET/POST /api/super-admin/commercial-subscriptions`, `PATCH .../status`, `POST .../change-plan` | super_admin | 200 | Platform Commercial |
| `/super-admin/commercial/entitlements` | `EntitlementsPage.jsx` | `GET /api/super-admin/commercial-accounts`, `GET /api/super-admin/commercial-subscriptions` | super_admin | 200 | Platform Commercial |
| `/super-admin/commercial/plan-entitlements` | `PlanEntitlementsPage.jsx` | *(plan-level entitlement configuration)* | super_admin | 200 | Platform Commercial |
| `/super-admin/commercial/overrides` | `OverridesPage.jsx` | *(customer-specific pricing overrides)* | super_admin | 200 | Platform Commercial |
| `/super-admin/commercial/usage-diagnostics` | `UsageDiagnosticsPage.jsx` | *(usage metering diagnostics)* | super_admin | 200 | Platform Commercial |
| `/super-admin/commercial/plan-changes` | `PlanChangesPage.jsx` | *(plan change queue management)* | super_admin | 200 | Platform Commercial |
| `/super-admin/commercial/evaluation-programs` | `EvaluationProgramsPage.jsx` | `POST/PATCH /api/super-admin/commercial-billing/evaluation-programs` | super_admin | 200 | Platform Commercial |
| `/super-admin/commercial/invoices` | `Plane1BillingPage.jsx` (Plane 1 — quotes, invoices, payments, reconciliation) | `POST/GET /api/super-admin/commercial-billing/quotes`, `POST/GET /api/super-admin/commercial-billing/invoices`, `POST/GET /api/super-admin/commercial-billing/payments`, `POST /api/super-admin/commercial-billing/reconciliation/run` | super_admin (capabilities: `commercial_quote.write`, `commercial_quote.approve`, `commercial_payment.write`, `commercial_financial.read/write`) | 200 | Platform Commercial |
| `/super-admin/financial/invoice-engine` | `InvoiceEnginePage.jsx` | *(invoice engine configuration & health)* | super_admin | 200 | Financial Operations |
| `/super-admin/financial/payments` | `PaymentsDisputesPage.jsx` | *(payments & disputes management)* | super_admin | 200 | Financial Operations |
| `/super-admin/financial/balances` | `BalancesAllocationsPage.jsx` | *(balances & allocations)* | super_admin | 200 | Financial Operations |
| `/super-admin/financial/reconciliation` | `ReconciliationPage.jsx` | *(tenant ledger reconciliation)* | super_admin | 200 | Financial Operations |
| `/super-admin/financial/credits` | `CreditsRefundsPage.jsx` | *(credits, adjustments & refunds)* | super_admin | 200 | Financial Operations |
| `/super-admin/financial/tax` | `TaxEInvoicingPage.jsx` | *(tax & e-invoicing)* | super_admin | 200 | Financial Operations |
| `/super-admin/financial-operations` | `FinancialOperationsPage.jsx` | *(consolidated financial operations overview)* | super_admin | 200 | Financial Operations |
| `/super-admin/billing-command-center` | `BillingCommandCenterPage.jsx` | *(billing command center hub)* | super_admin | 200 | Financial Operations |
| `/super-admin/approval-queue` | `ApprovalQueuePage.jsx` | `GET /api/super-admin/approval-requests`, domain-specific approve/reject endpoints | super_admin | 200 | Governance & Security |
| `/super-admin/audit-logs` | `AuditLogsPage.jsx` | `GET /api/super-admin/audit-logs`, `GET /api/super-admin/subscription-audit-logs` | super_admin | 200 | Governance & Security |
| `/super-admin/governance` | `GovernancePage.jsx` | `GET .../attention`, `GET .../attention/counts`, `POST .../attention/{id}/{acknowledge,assign,transition,suppress}` | super_admin | 200 | Governance & Security |
| `/super-admin/governance/privileged-sessions` | `SupportAccessPage.jsx` | `GET /api/organizations/`, `POST/GET .../privileged-access/{request,active,mine}` | super_admin | 200 | Governance & Security |
| `/super-admin/governance/security-events` | `AuditLogsPage.jsx` | `GET /api/super-admin/audit-logs`, `GET /api/super-admin/subscription-audit-logs` | super_admin | 200 | Governance & Security |
| `/super-admin/governance/data` | `GovernancePage.jsx` | `GET .../attention`, `GET .../attention/counts` | super_admin | 200 | Governance & Security |
| `/super-admin/governance/configuration` | `ConfigurationGovernancePage.jsx` | `GET/POST/PUT /api/super-admin/configuration`, `GET/PUT /api/super-admin/settings` | super_admin | 200 | Governance & Security |
| `/super-admin/reliability` | `ReliabilityPage.jsx` | `GET /health` (unauthenticated liveness), `GET /api/super-admin/telemetry/jobs` | super_admin | 200 | Reliability & Operations |
| `/super-admin/reliability/incidents` | `TriagePage.jsx` | `GET /api/super-admin/triage/summary` (capability `triage.read`), `POST .../attention/{id}/{acknowledge,assign,transition,suppress}` | super_admin | 200 | Reliability & Operations |
| `/super-admin/reliability/reprocessing` | `TriagePage.jsx` | `GET /api/super-admin/triage/summary`, `POST .../telemetry/jobs/{name}/retry` | super_admin | 200 | Reliability & Operations |
| `/super-admin/reliability/data-quality` | `ReliabilityPage.jsx` | `GET /api/super-admin/telemetry/jobs` | super_admin | 200 | Reliability & Operations |
| `/super-admin/kill-switch` | `KillSwitchPage.jsx` | `GET/PUT /api/super-admin/billing-kill-switch` | super_admin | 200 | Command Center |
| `/super-admin/production-readiness` | `ProductionAcceptancePage.jsx` | `GET /api/super-admin/production-acceptance` | super_admin | 200 | Reliability & Operations |
| `/super-admin/triage` | `TriagePage.jsx` | `GET /api/super-admin/triage/summary` (capability `triage.read`) | super_admin | 200 | Command Center |
| `/super-admin/launch-readiness` | `LaunchReadinessPage.jsx` | `GET /api/super-admin/launch-readiness` | super_admin | 200 | Command Center |

## Standalone routes (outside `SUPER_ADMIN_ROUTES`)

| Route | Page component | Primary backend endpoint(s) | Role required | Expected status | Notes |
|---|---|---|---|---|---|
| `/organization-admin/privileged-access-log` | `PrivilegedAccessLogPage.jsx` (`OrgAdminPrivilegedAccessLogPage` in App.jsx) | `GET /api/organizations/me/privileged-access-log` | any org-scoped role | 200 | Domain B (tenant-facing), rendered outside the SUPER_ADMIN_ROUTES array |

## Public, unauthenticated routes

| Route | Page component | Primary backend endpoint(s) | Role required | Expected status |
|---|---|---|---|---|
| `/platform-quote/:token` | `PublicPlatformQuotePage.jsx` | `GET /billing/commercial-quotes/public/{token}`, `POST .../accept`, `POST .../reject` | none (public token) | 200 |
| `/platform-invoice/:token` | `PublicPlatformInvoicePage.jsx` | `GET /billing/commercial-platform-invoices/public/{token}` | none (public token) | 200 |
| `/platform-invoice/:token/success` | `PaymentSuccessPage.jsx` | *(payment success confirmation)* | none | 200 |
| `/platform-invoice/:token/checkout` | `PlatformCheckoutPage.jsx` | *(checkout flow)* | none | 200 |

## Legacy redirects (still resolve, never render a second copy of a page)

| Legacy route | Redirects to | Notes |
|---|---|---|
| `/dashboard` | `/super-admin/dashboard` | Pre-consolidation Platform Dashboard path |
| `/users` | `/super-admin/users` | |
| `/settings` | `/super-admin/settings` | Also linked from `TopBar.jsx` |
| `/organizations` | `/super-admin/organizations` | |
| `/admin/billing` | `/super-admin/billing-command-center` | Pre-consolidation Billing Command Center path |
| `/super-admin/commercial/dashboard` | `/super-admin/dashboard` | Pre-consolidation Commercial Control Center path |
| `/super-admin/commercial/organizations` | `/super-admin/organizations` | |
| `/super-admin/commercial/organizations/:organizationId` | `/super-admin/organizations/:organizationId` | Param substituted, query string preserved |
| `/super-admin/commercial/audit-logs` | `/super-admin/audit-logs` | |
| `/super-admin/commercial/approvals` | `/super-admin/approval-queue` | Reconciles the naming mismatch noted in the audit (Section T) |
| `/super-admin/commercial/kill-switch` | `/super-admin/kill-switch` | |
| `/super-admin/commercial/production-acceptance` | `/super-admin/production-readiness` | |
| `/super-admin/command-center/triage` | `/super-admin/triage` | Command Center sub-route redirect |
| `/super-admin/command-center/commercial` | `/super-admin/commercial/accounts` | Command Center sub-route redirect |
| `/super-admin/command-center/financial` | `/super-admin/financial-operations` | Command Center sub-route redirect |
| `/super-admin/command-center/reliability` | `/super-admin/reliability` | Command Center sub-route redirect |
| `/super-admin/command-center/governance` | `/super-admin/governance` | Command Center sub-route redirect |
| `/super-admin/financial/usage` | `/super-admin/financial-operations` | Sidebar audit cleanup: label had no backend feature behind it |
| `/super-admin/integrations` | `/super-admin/reliability` | Sidebar audit cleanup: label had no backend feature behind it |
| `/super-admin/integrations/gateways` | `/super-admin/reliability` | Sidebar audit cleanup: label had no backend feature behind it |
| `/super-admin/integrations/connectors` | `/super-admin/reliability` | Sidebar audit cleanup: label had no backend feature behind it |
| `/super-admin/integrations/webhooks` | `/super-admin/reliability` | Sidebar audit cleanup: label had no backend feature behind it |
| `/super-admin/integrations/imports-exports` | `/super-admin/reliability` | Sidebar audit cleanup: label had no backend feature behind it |
| `/super-admin/integrations/jobs` | `/super-admin/tenant-health/jobs` | Redirected to surviving job-health entry |
| `/super-admin/governance/roles` | `/super-admin/users` | Sidebar audit cleanup: duplicated Administrators & Users |

**Note on `LegacyRedirect` component**: every legacy path's target `:param` segments are substituted with the current route's matched params, and the query string is preserved, so a bookmarked/shared legacy URL (including detail pages) lands on the exact equivalent canonical page rather than a generic top-level route.

## TopBar and Settings access

`TopBar.jsx` links a `super_admin` viewer to `/super-admin/settings` labeled "Platform Settings." For `org_admin`, it links to `/organization-admin/organization` labeled "Organization." For `billing_admin`, it links to `/billing/workspace/organization` ("Organization Profile") and `/billing/settings` ("Billing Settings"). No role is linked to the legacy `/settings` path.

`ProtectedRoute.jsx` (`ROLE_PATH_RULES`) allows:
- `super_admin`: all paths (returns `true` for any pathname).
- `org_admin`: `/organization-admin*` and `/billing*`.
- `billing_admin`, `finance_approver`, `auditor`: `/billing*`.

## Verification performed

- Every route in `SUPER_ADMIN_ROUTES` (44 entries) and every redirect in `SUPER_ADMIN_LEGACY_REDIRECTS` (25 entries) in `frontend/src/App.jsx` was cross-checked against this doc.
- Every internal `navigate()`/`href`/`Link to=` inside `modules/super-admin/*.jsx` was grepped and confirmed to point at a canonical path (not a legacy one) after this pass's edits.
- Route click-through in a live browser was **not** performed this pass (no browser session available in this environment) — this is a code-level verification (import graph, route table, internal link audit), not a manual QA pass. Flagged explicitly per the master task's instruction not to overstate what was verified.
