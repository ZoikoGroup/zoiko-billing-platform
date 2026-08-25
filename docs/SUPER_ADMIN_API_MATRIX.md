# Super Admin API Matrix

Every backend endpoint reachable only by (or primarily used by) the Super Admin domain, cross-referenced against `frontend/src/service/commercialService.js` and direct `apiFetch` calls in `modules/super-admin/*.jsx` / `pages/{UsersPage,SettingsPage}.jsx`. Built by reading `backend/app/modules/super_admin/router.py`, `backend/app/modules/organizations/router.py`, and every Super Admin frontend file — not reconstructed from memory.

## `/api/super-admin/*`

| Method | Endpoint | Frontend caller | Role | DB dependency | Expected response | Error behavior | Test status |
|---|---|---|---|---|---|---|---|
| GET | `/dashboard/stats` | `PlatformDashboardPage.jsx` (`apiFetch`) | super_admin | `organizations`, `users`, `billing_customers`, `invoices` | `DashboardStats` | 401/403 via `get_current_super_admin`; 500 on DB failure surfaces as a dashboard-section "Unavailable" card | Covered (dashboard/org/user test files) |
| GET | `/users` | `UsersPage.jsx`, `listSuperAdminUsers` (actor-filter dropdowns) | super_admin | `users` | `SuperAdminUserListResponse` | 401/403 | Covered |
| PUT | `/users/{id}/status` | `UsersPage.jsx` | super_admin | `users` | `SuccessResponse` | 400 self-deactivation; 404 unknown user; 401/403 | Covered — `test_super_admin_users_http_authorization.py` (24 tests) |
| PUT | `/users/{id}/reset-password` | `UsersPage.jsx` | super_admin | `users` | `SuccessResponse` | 401/403/404 | Covered |
| GET | `/commercial-accounts` | `listCommercialAccounts` (Dashboard, OrganizationsPage, EntitlementsPage) | super_admin | `commercial_accounts`, `organizations` | `CommercialAccountListResponse` | 401/403 | Covered |
| GET | `/commercial-accounts/{organizationId}` | `getCommercialAccount` (declared, no current call site found) | super_admin | `commercial_accounts` | `CommercialAccountResponse` | 401/403/404 | Covered indirectly (service function untested by any UI flow — see Dead/Unused below) |
| GET | `/commercial-organizations/{organizationId}` | `getCommercialOrganizationDetail` (`OrganizationDetailPage.jsx`) | super_admin | `commercial_accounts`, `commercial_subscriptions`, `organizations` | `CommercialOrganizationDetailResponse` | 401/403/404 | Covered |
| GET | `/commercial-plans` | `listCommercialPlans` (Dashboard, PlansPage) | super_admin | `commercial_plans` | `CommercialPlanListResponse` | 401/403 | Covered |
| GET | `/commercial-plans/{id}` | `getCommercialPlan` (PlansPage detail) | super_admin | `commercial_plans` | `CommercialPlanResponse` | 401/403/404 | Covered |
| POST | `/commercial-plans` | `createCommercialPlan` (PlansPage) | super_admin | `commercial_plans` | `CommercialPlanResponse` | 400 validation, 401/403 | Covered |
| PATCH | `/commercial-plans/{id}` | `updateCommercialPlan` (PlansPage) | super_admin | `commercial_plans` | `CommercialPlanResponse` | 400/401/403/404 | Covered |
| PATCH | `/commercial-plans/{id}/status` | `setCommercialPlanStatus` (PlansPage) | super_admin | `commercial_plans` | `CommercialPlanResponse` | 400 illegal transition, 401/403/404 | Covered |
| PUT | `/commercial-plans/{id}/default` | `setCommercialPlanDefault` (PlansPage) | super_admin | `commercial_plans` | `CommercialPlanResponse` | 401/403/404 | Covered |
| GET | `/commercial-plans/{id}/versions` | `listCommercialPlanVersions` (`CommercialPlanVersionsPage.jsx`) | super_admin | `commercial_plan_versions` | `CommercialPlanVersionListResponse` | 401/403/404 | Covered |
| POST | `/commercial-plans/{id}/versions` | `createCommercialPlanVersion` | super_admin | `commercial_plan_versions` | `CommercialPlanVersionResponse` | 400/401/403/404 | Covered |
| GET | `/commercial-plan-versions/{id}` | `getCommercialPlanVersion` | super_admin | `commercial_plan_versions` | `CommercialPlanVersionResponse` | 401/403/404 | Covered |
| POST | `/commercial-plan-versions/{id}/submit` | `submitCommercialPlanVersion` | super_admin | `commercial_plan_versions`, `approval_requests` | `CommercialPlanVersionResponse` | 400 illegal state, 401/403/404 | Covered |
| POST | `/commercial-plan-versions/{id}/approve` | `approveCommercialPlanVersion` | super_admin | `commercial_plan_versions`, `approval_requests` | `CommercialPlanVersionResponse` | 400 self-approval rejected (`SelfApprovalError`), 401/403/404 | Covered — `test_catalog_version_self_approval_is_rejected` |
| POST | `/commercial-plan-versions/{id}/reject` | `rejectCommercialPlanVersion` | super_admin | `commercial_plan_versions`, `approval_requests` | `CommercialPlanVersionResponse` | 400/401/403/404 | Covered |
| POST | `/commercial-plan-versions/{id}/archive` | `archiveCommercialPlanVersion` | super_admin | `commercial_plan_versions` | `CommercialPlanVersionResponse` | 400/401/403/404 | Covered |
| GET | `/commercial-subscriptions` | `listCommercialSubscriptions` (Dashboard, SubscriptionsPage, EntitlementsPage) | super_admin | `commercial_subscriptions` | `CommercialSubscriptionListResponse` | 401/403 | Covered |
| GET | `/commercial-subscriptions/{organizationId}` | `getCommercialSubscription` | super_admin | `commercial_subscriptions` | `CommercialSubscriptionResponse` | 401/403/404 | Covered |
| POST | `/commercial-subscriptions` | `createCommercialSubscription` (SubscriptionsPage) | super_admin | `commercial_subscriptions` | `CommercialSubscriptionResponse` | 400 double-charge prevention / illegal state, 401/403 | Covered — `test_double_charge_prevention` |
| PATCH | `/commercial-subscriptions/{id}/status` | `setCommercialSubscriptionStatus` (SubscriptionsPage) | super_admin | `commercial_subscriptions`, `billing_kill_switches` | `CommercialSubscriptionResponse` | 400 illegal transition / kill switch disabled, 401/403/404 | Covered |
| POST | `/commercial-subscriptions/{id}/change-plan` | `changeCommercialSubscriptionPlan` (SubscriptionsPage "Plan" action, Phase 3F F5) | super_admin | `commercial_subscriptions`, `platform_audit_logs`, `billing_audit_logs` | `CommercialSubscriptionResponse` (the replacement) | 400 no-op/archived/terminal/missing reason/double-charge guard, 401/403/404 | Covered — `test_phase3f_saas_plane1.py` |
| GET | `/commercial-reporting` | `getSaasCommercialReporting` (`Plane1BillingPage.jsx`, `CommercialLens.jsx`, Phase 3F F10) | super_admin | read-only over `commercial_accounts`/`commercial_subscriptions`/`commercial_plan_versions` | `SaasReportingResponse` | 401/403 | Covered — `test_phase3f_saas_plane1.py`; MRR UNKNOWN when zero priced catalogue |
| GET | `/commercial-billing/quotes` | `listCommercialQuotes` (`Plane1BillingPage.jsx` via `commandCenterService.js`) | `commercial_financial.read` | `commercial_quotes` | `list[CommercialQuote]` | 401/403 | Covered |
| POST | `/commercial-billing/quotes` | `createCommercialQuote` (`commandCenterService.js`) | `commercial_quote.write` | `commercial_quotes` | `CommercialQuote` | 400/401/403 | Covered |
| POST | `/commercial-billing/quotes/{id}/send` | `sendCommercialQuote` (`commandCenterService.js`) | `commercial_quote.write` | `commercial_quotes` | `CommercialQuote` | 400 wrong status, 401/403/404 | Covered |
| POST | `/commercial-billing/quotes/{id}/approve` | `approveCommercialQuote` (`commandCenterService.js`) | `commercial_quote.approve` | `commercial_quotes` | `CommercialQuote` | 400 self-approval, 401/403/404 | Covered |
| POST | `/commercial-billing/quotes/{id}/reject` | `rejectCommercialQuote` (`commandCenterService.js`) | `commercial_quote.approve` | `commercial_quotes` | `CommercialQuote` | 400 wrong status, 401/403/404 | Covered |
| POST | `/commercial-billing/quotes/{id}/convert` | `convertCommercialQuote` (`commandCenterService.js`) | `commercial_quote.write` | `commercial_quotes`, `platform_invoices` | `PlatformInvoice` | 400 wrong status, 401/403/404 | Covered |
| GET | `/commercial-billing/invoices` | `listPlatformInvoices` (`Plane1BillingPage.jsx` via `commandCenterService.js`) | `commercial_financial.read` | `platform_invoices` | `list[PlatformInvoice]` | 401/403 | Covered |
| POST | `/commercial-billing/invoices` | `createPlatformInvoice` (`commandCenterService.js`) | `commercial_financial.read` | `platform_invoices` | `PlatformInvoice` | 400/401/403 | Covered |
| POST | `/commercial-billing/invoices/{id}/finalize` | `finalizePlatformInvoice` (`commandCenterService.js`) | `commercial_financial.read` | `platform_invoices`, `platform_invoice_number_sequences` | `PlatformInvoice` | 400 empty items, 401/403/404 | Covered — atomic numbering |
| POST | `/commercial-billing/invoices/{id}/void` | `voidPlatformInvoice` (`commandCenterService.js`) | `commercial_financial.read` | `platform_invoices` | `PlatformInvoice` | 400 wrong status, 401/403/404 | Covered |
| POST | `/commercial-billing/invoices/{id}/items` | `addPlatformInvoiceItem` (`commandCenterService.js`) | `commercial_financial.read` | `platform_invoice_items` | `PlatformInvoiceItem` | 400 not-DRAFT, 401/403/404 | Covered |
| GET | `/commercial-billing/payments` | `listPlatformPayments` (`Plane1BillingPage.jsx` via `commandCenterService.js`) | `commercial_financial.read` | `platform_payments` | `list[PlatformPayment]` | 401/403 | Covered |
| POST | `/commercial-billing/payments` | `recordPlatformPayment` (`commandCenterService.js`) | `commercial_payment.write` | `platform_payments` | `PlatformPayment` | 400 amount<=0, 401/403 | Covered |
| POST | `/commercial-billing/payments/{id}/allocate` | `allocatePlatformPayment` (`commandCenterService.js`) | `commercial_payment.write` | `platform_payment_allocations` | `PlatformPaymentAllocation` | 400 over-allocation, 401/403/404 | Covered |
| POST | `/commercial-billing/payments/{id}/deallocate` | `deallocatePlatformPayment` (`commandCenterService.js`) | `commercial_payment.write` | `platform_payment_allocations` | `{"status": "deallocated"}` | 400 no allocation, 401/403/404 | Covered |
| POST | `/commercial-billing/reconciliation/run` | `triggerPlatformReconciliation` (`commandCenterService.js`) | `commercial_financial.read` | `platform_invoices`, `platform_payments` | `ReconciliationRun` | 401/403 | Covered |
| GET | `/commercial-billing/reconciliation/runs` | `listPlatformReconciliationRuns` (`commandCenterService.js`) | `commercial_financial.read` | `reconciliation_runs` | `list[ReconciliationRun]` | 401/403 | Covered |
| GET | `/approval-requests` | `listApprovalRequests` (`ApprovalQueuePage.jsx`, `PlatformDashboardPage.jsx`) | super_admin | `approval_requests` | `ApprovalRequestListResponse` | 401/403 | Covered |
| GET | `/billing-kill-switch` | `getBillingKillSwitch` (`KillSwitchPage.jsx`) | super_admin | `billing_kill_switches` | `BillingKillSwitchResponse` | 401/403 | Covered |
| PUT | `/billing-kill-switch` | `setBillingKillSwitch` (`KillSwitchPage.jsx`) | super_admin | `billing_kill_switches` | `BillingKillSwitchResponse` | 400 empty reason, 401/403 | Covered |
| GET | `/audit-logs` | `listPlatformAuditLogs` (`AuditLogsPage.jsx`, `PlatformDashboardPage.jsx`) | super_admin | `platform_audit_logs` | `PlatformAuditLogListResponse` | 401/403; previously 500 on `actor_role`/`reason`/`correlation_id` schema drift, fixed and re-verified prior session | Covered |
| GET | `/subscription-audit-logs` | `listSubscriptionAuditLogs` (`AuditLogsPage.jsx`) | super_admin | `billing_audit_logs` | `SubscriptionAuditLogListResponse` | 401/403 | Covered |
| GET | `/settings` | `SettingsPage.jsx` (`apiFetch`) | super_admin | `platform_settings` | `list[SettingResponse]` | 401/403; empty list is a genuine empty state (no seed script populates this table — Section O of the audit) | Covered |
| POST | `/settings` | *(none — see Dead endpoints)* | super_admin | `platform_settings` | `SettingResponse` | 400/401/403 | Covered at the service/route-test level |
| PUT | `/settings/{key}` | `SettingsPage.jsx` | super_admin | `platform_settings` | `SettingResponse` | 400/401/403/404 | Covered |
| GET | `/production-acceptance` | `getProductionAcceptanceReport` (`ProductionAcceptancePage.jsx`, `PlatformDashboardPage.jsx`) | super_admin | `organizations` (COM-03 query only) + architectural facts, no other live table dependency | `ProductionAcceptanceReport` (now includes `overall_status`/`summary`, added this pass) | 401/403 | Covered — including the new overall-verdict test |

## `/api/super-admin/commercial-billing/*` (Plane 1 — new)

| Method | Endpoint | Frontend caller | Capability | DB dependency | Expected response | Error behavior | Test status |
|---|---|---|---|---|---|---|---|
| POST | `/commercial-billing/quotes` | `createCommercialQuote` (`commandCenterService.js`) | `commercial_quote.write` | `commercial_quotes`, `commercial_accounts` | `CommercialQuote` | 400 validation, 401/403 | Covered — `test_commercial_billing.py` |
| GET | `/commercial-billing/quotes` | `listCommercialQuotes` (`commandCenterService.js`) | `commercial_financial.read` | `commercial_quotes` | `list[CommercialQuote]` | 401/403 | Covered |
| GET | `/commercial-billing/quotes/{id}` | `getCommercialQuote` (`commandCenterService.js`) | `commercial_financial.read` | `commercial_quotes` | `CommercialQuote` | 401/403/404 | Covered |
| POST | `/commercial-billing/quotes/{id}/send` | `sendCommercialQuote` (`commandCenterService.js`) | `commercial_quote.write` | `commercial_quotes` | `CommercialQuote` | 400 wrong status, 401/403/404 | Covered |
| POST | `/commercial-billing/quotes/{id}/approve` | `approveCommercialQuote` (`commandCenterService.js`) | `commercial_quote.approve` | `commercial_quotes` | `CommercialQuote` | 400 self-approval, 401/403/404 | Covered — `SelfApprovalError` enforced |
| POST | `/commercial-billing/quotes/{id}/reject` | `rejectCommercialQuote` (`commandCenterService.js`) | `commercial_quote.approve` | `commercial_quotes` | `CommercialQuote` | 400 wrong status, 401/403/404 | Covered |
| POST | `/commercial-billing/quotes/{id}/convert` | `convertCommercialQuote` (`commandCenterService.js`) | `commercial_quote.write` | `commercial_quotes`, `platform_invoices`, `platform_invoice_items` | `PlatformInvoice` | 400 wrong status, 401/403/404 | Covered |
| POST | `/commercial-billing/invoices` | `createPlatformInvoice` (`commandCenterService.js`) | `commercial_financial.read` | `platform_invoices`, `commercial_accounts` | `PlatformInvoice` | 400 validation, 401/403 | Covered |
| GET | `/commercial-billing/invoices` | `listPlatformInvoices` (`commandCenterService.js`) | `commercial_financial.read` | `platform_invoices` | `list[PlatformInvoice]` | 401/403 | Covered |
| GET | `/commercial-billing/invoices/{id}` | `getPlatformInvoice` (`commandCenterService.js`) | `commercial_financial.read` | `platform_invoices` | `PlatformInvoice` | 401/403/404 | Covered |
| POST | `/commercial-billing/invoices/{id}/finalize` | `finalizePlatformInvoice` (`commandCenterService.js`) | `commercial_financial.read` | `platform_invoices`, `platform_invoice_items`, `platform_invoice_number_sequences` | `PlatformInvoice` | 400 empty items, circuit breaker blocked, 401/403/404 | Covered — atomic numbering via SELECT FOR UPDATE |
| POST | `/commercial-billing/invoices/{id}/void` | `voidPlatformInvoice` (`commandCenterService.js`) | `commercial_financial.read` | `platform_invoices` | `PlatformInvoice` | 400 wrong status, 401/403/404 | Covered |
| POST | `/commercial-billing/invoices/{id}/items` | `addPlatformInvoiceItem` (`commandCenterService.js`) | `commercial_financial.read` | `platform_invoice_items` | `PlatformInvoiceItem` | 400 not-DRAFT, 401/403/404 | Covered |
| POST | `/commercial-billing/payments` | `recordPlatformPayment` (`commandCenterService.js`) | `commercial_payment.write` | `platform_payments`, `commercial_accounts` | `PlatformPayment` | 400 amount<=0, 401/403 | Covered — processor identity asserted |
| GET | `/commercial-billing/payments` | `listPlatformPayments` (`commandCenterService.js`) | `commercial_financial.read` | `platform_payments` | `list[PlatformPayment]` | 401/403 | Covered |
| POST | `/commercial-billing/payments/{id}/allocate` | `allocatePlatformPayment` (`commandCenterService.js`) | `commercial_payment.write` | `platform_payment_allocations`, `platform_payments`, `platform_invoices` | `PlatformPaymentAllocation` | 400 over-allocation / account mismatch, 401/403/404 | Covered — SELECT FOR UPDATE |
| POST | `/commercial-billing/payments/{id}/deallocate` | `deallocatePlatformPayment` (`commandCenterService.js`) | `commercial_payment.write` | `platform_payment_allocations` | `{"status": "deallocated"}` | 400 no allocation, 401/403/404 | Covered |
| POST | `/commercial-billing/reconciliation/run` | `triggerPlatformReconciliation` (`commandCenterService.js`) | `commercial_financial.read` | `platform_invoices`, `platform_payments`, `platform_payment_allocations` | `ReconciliationRun` | 401/403 | Covered |
| GET | `/commercial-billing/reconciliation/runs` | `listPlatformReconciliationRuns` (`commandCenterService.js`) | `commercial_financial.read` | `reconciliation_runs` | `list[ReconciliationRun]` | 401/403 | Covered |

## `/billing/commercial-quotes/public/*` (Plane 1 — public, unauthenticated)

| Method | Endpoint | Frontend caller | Capability | DB dependency | Expected response | Error behavior | Test status |
|---|---|---|---|---|---|---|---|
| GET | `/billing/commercial-quotes/public/{token}` | *(org-facing page)* | none (public) | `commercial_quotes` | `CommercialQuote` | 404 not found / expired | Covered |
| POST | `/billing/commercial-quotes/public/{token}/accept` | *(org-facing page)* | none (public) | `commercial_quotes` | `CommercialQuote` | 400 wrong status, 404 | Covered |
| POST | `/billing/commercial-quotes/public/{token}/reject` | *(org-facing page)* | none (public) | `commercial_quotes` | `CommercialQuote` | 400 wrong status, 404 | Covered |

## `/api/organizations/*` (Super-Admin-scoped subset)

| Method | Endpoint | Frontend caller | Role | DB dependency | Expected response | Error behavior | Test status |
|---|---|---|---|---|---|---|---|
| GET | `/{id}` | `getOrganizationProfile` (`OrganizationDetailPage.jsx`) | super_admin (also self-service for org_admin/billing_admin via a different check, out of scope here) | `organizations` | `OrganizationResponse` | 401/403/404 | Covered |
| POST | `/` | `createOrganization` (`OrganizationsPage.jsx`) | super_admin | `organizations`, `commercial_accounts`, `platform_audit_logs` | `OrganizationResponse` | 400/401/403; audited (`PlatformAuditAction.CREATE`) | Covered |
| PATCH | `/{id}/status` | `setOrganizationStatus` (`OrganizationDetailPage.jsx`) | super_admin | `organizations`, `platform_audit_logs` | `OrganizationResponse` | 401/403/404; audited (ACTIVATE/DEACTIVATE) | Covered |
| PATCH | `/{id}/billing-classification` | `updateBillingClassification` (`OrganizationDetailPage.jsx`) | super_admin | `organizations` | `OrganizationResponse` | 400/401/403/404 | Covered |
| DELETE | `/{id}` | `deleteOrganization` (`OrganizationDetailPage.jsx`, typed-confirmation gated) | super_admin | `organizations` and cascaded rows; audited before the sweep with `organization_id=None` to respect the `RESTRICT` FK | `SuccessResponse` | 401/403/404; audit row survives deletion | Covered — `test_super_admin_delete_organization_is_audited_and_survives_the_sweep` |

## Dead endpoints / no frontend consumer

- **`GET /api/organizations/` (list_organizations, super_admin only)** — no frontend caller found. `OrganizationsPage.jsx` lists organizations via `GET /api/super-admin/commercial-accounts` instead (a richer, commercial-plane view), so this plain organization list endpoint is currently orphaned. Not a bug (it still works and is tested at the service level), just unused — worth a product decision on whether to remove it or wire a "simple list" view to it.
- **`GET /api/super-admin/commercial-accounts/{organizationId}`** — `getCommercialAccount` is exported from `commercialService.js` but no page currently calls it; `OrganizationDetailPage.jsx` uses the richer `getCommercialOrganizationDetail` (`/commercial-organizations/{id}`) instead. Likely superseded by that endpoint; safe to keep for now (harmless, tested), flagged for a future cleanup decision.
- **`POST /api/super-admin/settings`** (create a new platform setting) — `SettingsPage.jsx` only ever `GET`s the list and `PUT`s existing keys by value; there is no "add a new setting" UI action anywhere in the frontend. This is consistent with Section O's finding (no seed script populates `platform_settings` either) — the create path exists in the backend but nothing in the current product surface uses it to originate new setting rows.

## Frontend calls to nonexistent endpoints

None found. Every `commercialService.js` export and every direct `apiFetch(...)` call in `UsersPage.jsx`/`SettingsPage.jsx`/`PlatformDashboardPage.jsx` was cross-referenced against a registered backend route this pass; no orphaned frontend call was found.
