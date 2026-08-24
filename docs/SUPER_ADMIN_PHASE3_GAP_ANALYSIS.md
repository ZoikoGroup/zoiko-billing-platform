# Super Admin Phase 3 — Gap Analysis

**Document ID:** ZB-SA-P3-GAP-001
**Authoritative Baselines:** ZB-SA-CMD-003 v3.0 / ZB-COM-BILL-001
**Prepared:** August 22, 2026
**Scope:** Platform Operations + Tenant Lifecycle control plane (Phase 3A–3G), covering both Plane 1 (Zoiko → Tenant SaaS administration) and Plane 2 (Tenant → Tenant's Customers revenue operations) with strict domain separation.
**Status:** Audit complete. This analysis precedes implementation.

---

## 0. Method

Every row below was verified against the actual repository state on 2026-08-22:

- Documentation: `SUPER_ADMIN_CURRENT_STATE_AUDIT.md`, `SUPER_ADMIN_ARCHITECTURE.md`, `SUPER_ADMIN_IA.md`, `SUPER_ADMIN_PHASE1_IMPLEMENTATION.md` (+ acceptance), `SUPER_ADMIN_PHASE2_IMPLEMENTATION.md` (+ acceptance).
- Backend: `backend/app/modules/super_admin/` (router.py 2,516 lines, schemas.py, models.py, services), `backend/app/modules/{auth,organizations,commercial,billing}/`, `backend/app/core/`, `backend/migrations/`, `backend/tests/`.
- Frontend: `frontend/src/modules/super-admin/` (21 pages/lenses), `frontend/src/components/BillingShell.jsx`, `frontend/src/service/*`, `frontend/src/context/CommandCenterContext.jsx`, `frontend/src/App.jsx`.

Phase 1 and Phase 2 are **accepted and preserved**; this phase adds to them, never replaces them.

---

## 1. Current State Summary (verified)

### 1.1 What already exists and is reused as-is (NOT rebuilt)

| Capability | Files | Notes |
|---|---|---|
| Command Center (5 lenses) | `PlatformDashboardPage.jsx`, `lenses/*.jsx`, `CommandCenterContext.jsx` | Preserved untouched. |
| Attention Engine | `attention_service.py`, `AttentionItem`, Triage UI | Real signals only (job failures, breakers). |
| Circuit Breakers | `kill_switch_service.py`, `BillingKillSwitch` | MFA step-up + maker-checker paths live. |
| Privileged Access (JIT Domain B) | `privileged_access_service.py`, `PrivilegedTenantAccessGrant`, `SupportAccessPage.jsx`, `PrivilegedSessionBanner.jsx` | Request → step-up → active ≤30 min → exit/expiry, fully audited. |
| Approval Center (maker-checker) | `approval_service.py`, `ApprovalRequest`, `ApprovalQueuePage.jsx` | Self-approval blocked server-side. |
| Audit & Evidence | `audit_service.py`, `PlatformAuditLog`, `AuditLogsPage.jsx` | Append-only, transactional (`log_no_commit`). |
| Release Control | `launch_readiness_service.py`, `ProductionAcceptancePage.jsx` | Live checks, honest UNKNOWN. |
| Financial Operations (Plane 2 aggregates) | `financial_consistency_service.py`, `FinancialOperationsPage.jsx` | Privileged via `financial_consistency.read`. |
| Reliability & Telemetry | `telemetry_service.py`, `JobRunLog`, `ReliabilityPage.jsx` | Counts/rates only; zero monetary figures in Domain C. |
| MFA / step-up | `mfa_service.py`, `SuperAdminMFA` | TOTP + recovery codes, replay protection. |
| Capabilities | `core/capabilities.py` | PlatformRole → capability map enforced server-side. |
| Plane 1 foundation | `commercial/models.py` (CommercialAccount, CommercialPlan, CommercialPlanVersion, CommercialSubscription), `commercial/service.py` | Accounts/plans/price-book/subscriptions/entitlements exist. |
| Global search | `search_service.py` | Identity-first; Organization results require access flag. |

### 1.2 Verified architectural facts that constrain Phase 3

1. **No Plane 1 invoicing exists.** There is no SaaS invoice/payment/collection model or processor for Zoiko→Tenant charges (confirmed by production-acceptance items PAY-01/PAY-02/REC-01 and by absence of any such model). Any "SaaS invoice" page must honestly report NOT IMPLEMENTED — never fabricate.
2. **No trials/offers model exists** (COM-02: "no evaluation/trial program is configured anywhere in the schema"). Trials must be reported as NOT CONFIGURED.
3. **Organization has no lifecycle column today** — only `is_active` boolean + server-stamped `billing_classification`/`billing_source`. Registration activates tenants immediately (`register_enterprise`) and provisions a CommercialAccount but deliberately no subscription.
4. **User has no invitation/lock/last-login columns.** Invitation state is derivable from evidence (`is_verified == False` + outstanding INVITE `SecurityActionToken`). Lock state exists only for super_admins (`SuperAdminMFA.locked_until`). No `last_login_at` anywhere.
5. **Existing `/super-admin/users` mutations do not write platform audit events** (status toggle, password reset). Phase 3 closes this.
6. **Domain C purity:** telemetry endpoints return counts/rates only — health may count overdue invoices/failed payments but must never return monetary amounts outside privileged financial surfaces.
7. **Migrations:** no Alembic; `initialize_database()` = `create_all` + self-healing `_add_missing_columns()` (Postgres ALTER for added columns; SQLite recreated fresh). New nullable/defaulted columns are safe.
8. **Frontend kit:** `billing-ui.jsx` (DataTable, Modal, PageHeader, Field…), `billing-shared.jsx` (StatusBadge, DashboardStatCard, ErrorState, useConfirmationDialog…), `constants.jsx` badge maps, `service/api.js` fetch client. No drawer primitive — modals are the overlay pattern.
9. **Route placeholders exist:** `/super-admin/platform/lifecycle` currently renders TenantHealthPage; `/super-admin/commercial/invoices` renders PlatformDashboardPage. Both are genuine gaps to fill with real pages.

---

## 2. Feature-by-Feature Gap Matrix

Legend — Priority: P0 = required for Phase 3 acceptance, P1 = strongly recommended, P2 = deferred/honest-declared.

### 3A — Organizations

| # | Feature | Existing | Existing files / APIs | DB support | Missing | Risk if unfixed | Priority |
|---|---|---|---|---|---|---|---|
| A1 | Organization directory list | Basic list via commercial accounts join | `GET /super-admin/commercial-accounts`; `OrganizationsPage.jsx` | organizations, users, commercial_accounts/subscriptions | Dedicated read-model endpoint with per-org user counts, subscription summary, lifecycle ref, attention ref; identifier (code-exact) search; pagination parity | Slow N+1 composition in frontend; no backend read model | **P0** |
| A2 | Filtering | Search text only | same | columns exist | Filters: status, country, currency, classification, source, subscription status, lifecycle state, created-date range | Cannot operate at scale; spec-mandated | **P0** |
| A3 | Organization overview (controlled operational profile) | `GET /super-admin/commercial-organizations/{id}` (identity+billing config+subscription+entitlements); detail page sections | `router.py:532`; `OrganizationDetailPage.jsx` | yes | Composed overview incl. administrators/users summary, lifecycle & onboarding state, recent audit history, privileged-grant metadata; single read model | Fragmented calls; no audit visibility per org | **P0** |
| A4 | Administrators & Users per org | `GET /super-admin/users?organization_id=` exists | `router.py:155` | users.organization_id | Frontend section/tab surfacing it on org profile | Spec item invisible today | **P0** |
| A5 | Audit history per org | `GET /super-admin/audit-logs?organization_id=` exists | `router.py:1542` | platform_audit_logs.organization_id | Surface on org profile | Spec item invisible today | **P0** |
| A6 | Financial isolation of list | List shows no monetary data (correct) | — | — | Keep zero monetary columns in directory; privileged money stays behind Financial Ops / JIT grant | IDOR/leak risk if violated | **P0** (invariant) |

### 3B — Administrators & Users

| # | Feature | Existing | Existing files / APIs | DB support | Missing | Risk | Priority |
|---|---|---|---|---|---|---|---|
| B1 | Directory + filters | search/role/org/is_active | `GET /super-admin/users` | users | Derived account status (ACTIVE/SUSPENDED/INVITED/LOCKED), MFA status surfaced for all super admins (exists) + locked flag, last login | Spec statuses not visible | **P0** |
| B2 | Last login evidence | none | login path `auth/service.py` | — | Additive `users.last_login_at` stamped on successful login (real telemetry only; absent ⇒ UNKNOWN) | Fabricated timestamps prohibited; column is real evidence | **P0** |
| B3 | Invite administrator/user (Super Admin, cross-org) | Org-admin-only invite `POST /auth/admin/users` (actor bound to own org) | `auth/service.py:423` | SecurityActionToken(INVITE) | Super-admin invite endpoint targeting arbitrary org; audited | None today for platform ops | **P0** |
| B4 | Suspend / reactivate / revoke | `PUT /super-admin/users/{id}/status` toggles is_active — **not audited**, no reason | `router.py:215` | users.is_active | Reason capture + platform audit event + self-protection preserved | Silent privilege mutation violates rule 9 | **P0** |
| B5 | Role change where authorized | Only platform_role for super_admins | `router.py:251` | users.role | Tenant role change (org_admin↔billing_admin↔finance_approver/auditor) with `can_create_role` guard + audit; forbid self role-change | Privilege escalation if unguarded | **P0** |
| B6 | Membership management | none | — | users.organization_id | Move user between orgs (never onto/off super_admin accounts); audited | Cross-tenant manipulation risk if naive | **P0** |
| B7 | Credential hygiene | Password/MFA secrets never exposed (correct) | mfa reset endpoint | — | Maintain; response schemas carry no credential fields | — | **P0** (invariant) |

### 3C — Lifecycle & Onboarding

| # | Feature | Existing | Existing files / APIs | DB support | Missing | Risk | Priority |
|---|---|---|---|---|---|---|---|
| C1 | Lifecycle state machine | Only `is_active` boolean; suspension via PATCH status | `organizations/router.py:609` | organizations.is_active | New `organizations.lifecycle_state` enum column (PROVISIONING/ONBOARDING/ACTIVE/SUSPENDED/DEACTIVATING/DEACTIVATED) kept in sync with `is_active` so existing auth checks keep working; transition service validates current state, records actor/timestamp/reason/correlation, audits; invalid transitions fail | Divergent truth sources if not synced | **P0** |
| C2 | Onboarding readiness | none | — | derivable | Evidence-based readiness: administrator ready (≥1 active org_admin), configuration seeded (BillingConfiguration row), billing/commercial ready (CommercialAccount + open subscription), integration ready ⇒ honest UNKNOWN (no integration registry exists) | Fake progress bars prohibited | **P0** |
| C3 | Activation / suspension / reactivation / controlled deactivation endpoints | partial (is_active toggle) | `PATCH /organizations/{id}/status` | — | `POST /super-admin/organizations/{id}/lifecycle-transition` (reason mandatory) wired through C1 machine; legacy toggle retained for compat | Two competing suspend paths | **P0** |
| C4 | Lifecycle workspace page | Route placeholder renders TenantHealthPage | App.jsx route table | — | New `LifecycleOnboardingPage.jsx` at canonical route | Placeholder ships wrong content | **P0** |

### 3D — Tenant Health

| # | Feature | Existing | Existing files / APIs | DB support | Missing | Risk | Priority |
|---|---|---|---|---|---|---|---|
| D1 | Per-org health rollup | Global counts only (`TelemetryService.get_organization_health`) | `telemetry_service.py` | attention_items(org-scoped), invoices/payments counts, subscriptions | New `tenant_health_service.py`: categories (platform, billing, subscription, payment, integration, processing, data quality, security/access, onboarding) each contributing signal + state HEALTHY/DEGRADED/CRITICAL/UNKNOWN/ONBOARDING; freshness via `freshness.compute_freshness` | False-green prohibited: zero-evidence categories report UNKNOWN, never HEALTHY | **P0** |
| D2 | Health workspace UI | TenantHealthPage shows org counts + job health only | `TenantHealthPage.jsx` | — | Rework into workspace: fleet table (overall state + signal chips + last updated) and per-org detail modal with category sections, incidents, failed jobs, blockers; non-color icons maintained | Spec surface missing | **P0** |
| D3 | Domain C purity | Enforced | — | — | Health uses counts/states only; zero monetary values | Monetary leak into telemetry | **P0** (invariant) |

### 3E — Support Access Integration

| # | Feature | Existing | Missing | Risk | Priority |
|---|---|---|---|---|---|
| E1 | Reuse JIT system end-to-end | Complete (request/step-up/activate/exit/expire/audit) | Nothing rebuilt — integration only | — | **P0** |
| E2 | Deep-link entry points | none | Organization profile & Tenant Health incident views link to `/super-admin/support-access?organization={code}` prefilling tenant picker | Friction only | **P0** |
| E3 | Exit control on Support page | Service fn exists; page lacks button (audit finding) | Wire Exit button w/ confirmation | Session left running | **P0** |
| E4 | Active-grant context on org/health views | Banner exists globally | Show grant-state chip when viewing a org under an active grant (read-only indicator, no auto-unlock) | — | **P1** |

### 3F — Plane 1 SaaS Administration

| # | Feature | Existing | Missing / decision | Risk | Priority |
|---|---|---|---|---|---|
| F1 | SaaS Accounts | `GET /super-admin/commercial-accounts` + UI | Enhance labels with explicit PLANE 1 markers | Ambiguity with Plane 2 | **P0** |
| F2 | SaaS Plans | CRUD + default/status | done; relabel "Products & Price Book" plane context | — | **P0** |
| F3 | Price Book (versions, maker-checker) | Draft→submit→approve/reject/archive | done | — | **P0** |
| F4 | Offers & Trials | **No model exists** (COM-02) | Honest NOT CONFIGURED section on Plans/Offers page; no fabrication | Fake trial data | **P0** |
| F5 | SaaS Subscriptions | Create + status transitions via state machine | Add plan change (upgrade/downgrade) = new subscription replacing prior (history preserved), audited; reuse existing transitions | History loss if ad-hoc | **P0** |
| F6 | SaaS Entitlements | Read-only view | done | — | **P0** |
| F7 | SaaS Invoices | **None** (no Plane-1 processor/invoice model) | Honest "Not implemented" panel on dedicated Plane 1 billing page; REC/PAY acceptance items already declare this | Fabrication | **P0** (honesty requirement) |
| F8 | SaaS Payments / Collections | **None** | Same honest treatment | Fabrication | **P0** (honesty requirement) |
| F9 | Subscription lifecycle mgmt | Transition endpoint exists | Surface in subscriptions page (exists) | — | **P0** |
| F10 | SaaS Commercial Reporting | C-lens cards (accounts/subscriptions) exist | Honest read model: subscription counts by status/plan; MRR computed ONLY from published catalog versions with non-null price_amount; coverage reported; zero priced catalogue ⇒ UNKNOWN (mirrors COM-01) | Fabricated ARR/MRR | **P0** |
| F11 | Suspension/reactivation | Transitions SUSPEND/REACTIVATE exist in machine | covered by F5/F9 | — | **P0** |

### 3G — Cross-Plane Governance

| # | Feature | Existing | Missing | Risk | Priority |
|---|---|---|---|---|---|
| G1 | Plane indicators on APIs | Implicit only | `plane` field on new/ambiguous read models (directory rows: plane="TENANT"; commercial reads: plane=1; financial ops: plane=2) | Misreading planes | **P0** |
| G2 | Plane badges in UI | none | Shared `PlaneBadge` component used across Platform Commercial + Financial Ops + directory pages | Operators confusing Zoiko charges with tenant charges | **P0** |
| G3 | Audited privileged-op context | actor/role/reason/correlation exist | Ensure every NEW mutation logs actor, organization, action, reason, correlation_id (plane recorded in metadata) | Unauditable mutations violate rules 8–10 | **P0** |

---

## 3. Security Review of Planned Changes

1. **IDOR:** All new org-scoped reads are super_admin-only via `get_current_super_admin` floor + capability gates where sensitive. User mutations verify target exists; membership moves restricted to tenant roles; self-deactivation/self-role-change blocked; last-active-super-admin invariant preserved (existing check untouched).
2. **Privilege escalation:** Role changes gated by existing `can_create_role` hierarchy; super_admin role can never be granted via the new endpoint (only UserRole tenant roles); platform_role management remains behind `platform_role.manage`.
3. **Maker-checker:** Plan change and breaker-class mutations continue through ApprovalService where the domain requires dual control; lifecycle transitions and user admin mutations are single-actor but reason-mandated + audited (consistent with existing org status toggle precedent), with maker-checker reserved to domains that already define it (catalog publish, breaker change). Documented explicitly.
4. **Cross-plane leakage:** Directory/health endpoints return counts only; no monetary aggregation outside `financial_consistency.read`-gated endpoints; Plane 1 has no monetary data at all until a priced catalogue exists (then still server-computed only).
5. **Support access:** No new access path; deep-links only prefill the request form. Grants remain ≤30 min, owner-bound, lazily expired, audited.
6. **Secret hygiene:** Invite/reset flows reuse tokenized email links; responses never include hashes/tokens/secrets; derived statuses expose booleans only.

## 4. Implementation Order (agreed)

1. Backend foundation: enums/columns (`lifecycle_state`, `last_login_at`) + migration-free self-healing path; audit-action additions.
2. 3A organization directory/overview services + router + tests.
3. 3B user admin service + router + tests (+ login stamping).
4. 3C lifecycle service + transition endpoint + registration stamping ONBOARDING + tests.
5. 3D tenant health service + endpoints + tests.
6. 3E frontend support-access integration (links, exit button) — no backend rebuild.
7. 3F Plane 1: plan-change service method + honest SaaS billing/reporting read model + page updates.
8. Frontend: directory/detail/lifecycle/health/users pages + PlaneBadge + navigation wiring.
9. Full pytest, npm build, accessibility pass, security/IDOR audit, docs (PLAN/IMPLEMENTATION/ACCEPTANCE + ARCHITECTURE/IA updates).

## 5. Explicit Non-Goals (honest declarations)

- No bank/processor reconciliation (ISS-017 stands; REC-01 remains FAIL).
- No fabricated MRR/ARR when catalogue prices are absent → UNKNOWN with coverage note.
- No trial/offer engine invented in Phase 3 → NOT CONFIGURED declared.
- No Plane 1 payment processing → SaaS Invoices/Payments/Collections surfaces render explicit NOT IMPLEMENTED states.
- No new top-level navigation group — Plane 1 administration lives under **Platform Commercial** per IA.
