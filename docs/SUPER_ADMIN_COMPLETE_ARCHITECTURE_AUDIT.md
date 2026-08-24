# Super Admin Control Plane — Complete Architecture Audit

**Audit date:** 2026-08-24
**Repository:** `zoiko-billing-platform`, branch `nikhil`
**Last commit:** `23f54e3` — "fix(super-admin): complete phase 3 full system qa and stabilization"
**Working-tree state at audit time:** DIRTY — 20 files modified, 5 new untracked files (see §2)
**Method:** Read-only investigation. Seven parallel specialist passes over docs, frontend, backend, database, Plane 1/2, and tests/security/config, each producing file:line evidence; reconciled here. Backend test suite, frontend build, accessibility audit, and `/health` were actually re-executed (not assumed) during this audit. Playwright E2E was **not** re-executed (see §26, §28).
**Scope discipline:** This document reports findings only. No new features were implemented. No code was fixed as part of this audit except where explicitly noted as read-only verification.

---

## 1. Executive Summary

The repository's **last commit** (`23f54e3`) represents a real, well-tested Phase 1–3 Super Admin Control Plane: 680 backend tests passing at that baseline, a working production build, and a genuinely disciplined data-access layer (100% of foreign keys specify `ondelete`, tenant scoping via `organization_id` is near-universal, Plane 1/Plane 2 have zero cross-referencing foreign keys). Re-running the suite today against the **current working tree** (which includes substantial uncommitted work) gives **703 passed, 1 skipped, 0 failed**.

However, three findings dominate this audit and must be read before anything else:

1. **Phase 4 has already been substantially implemented in the uncommitted working tree**, directly contrary to this audit's own governing instruction ("DO NOT START PHASE 4") and to every prior QA document's own closing instruction ("do not start Phase 4 without new instructions"). All six gap items (G-01 through G-06) from the local, uncommitted `docs/SUPER_ADMIN_PHASE4_CURRENT_STATE_AUDIT.md` gap register are functionally complete on the backend, with tests, as of right now. This is not a hypothetical risk — it is the current, literal state of the repository, and it needs a human decision (commit it? revert it? review it first?) before any further work proceeds. See §2, §24.
2. **The documentation this audit was told to treat as authoritative is almost entirely outside version control.** Of 94 files on disk in `docs/`, git tracks 11 — and of the ~30 `SUPER_ADMIN_*` documents named in this audit's own mandate, only one (`SUPER_ADMIN_PHASE3_FULL_SYSTEM_QA_REPORT.md`) is actually committed. Everything else, including `SUPER_ADMIN_ARCHITECTURE.md` and `SUPER_ADMIN_IA.md` themselves, exists only on one machine's local disk. See §28.
3. **A genuine, currently-broken bug and a genuine, currently-failing accessibility check exist in the uncommitted tree right now.** `FinancialOperationsPage.jsx:170` references an undefined `isMulti` variable and throws on every render; a live-rerun of the accessibility audit (not merely trusted from prior reports) found 1 serious color-contrast violation on `/super-admin/commercial/invoices` — contradicting every prior "18/18, 0 violations" claim. See §3, §25.

Beyond these three, the audit found the platform's core discipline to be genuinely strong in places (FK hygiene, currency-honesty logic, append-only audit logging, Plane isolation, negative-security test coverage) and genuinely inconsistent in others (two incompatible error-handling conventions in the same router file, two parallel and incompatible frontend HTTP/session layers, a capability-based RBAC migration that is roughly half-done, and — importantly — a hardcoded, non-live "integration health" panel in `ReliabilityLens.jsx` that directly contradicts its own in-file comment about never rendering fabricated green tiles).

**Verdict: C — CONDITIONALLY READY.** See §29 for the full reasoning and prerequisite list. In short: the committed Phase 1–3 baseline is a defensible foundation, but the current working tree is not committable as-is (broken render, real a11y regression), the documentation baseline this audit was asked to trust is not durable, and Phase 4 needs an explicit human decision before this codebase moves forward in any direction.

---

## 2. Repository Structure

### 2.1 Top level

```
zoiko-billing-platform/
├── backend/            FastAPI app, tests, migrations, requirements.txt, venv/
├── frontend/            Vite + React 19 app, tests/ (Playwright only), scripts/ (a11y)
├── docs/                94 files on disk; 11 tracked in git (see §28)
├── docker-compose.yml
└── .gitignore
```

### 2.2 Working-tree diff at audit time (evidence, not assumption)

`git status --short` at audit start:

**Modified (20 files):**
`backend/app/core/api_metrics.py`, `backend/app/core/capabilities.py`, `backend/app/main.py`, `backend/app/modules/super_admin/{financial_consistency_service.py, launch_readiness_service.py, models.py, router.py, saas_reporting_service.py, schemas.py, search_service.py}`, `frontend/src/App.jsx`, `frontend/src/components/{BillingShell.jsx, CommandPalette.jsx}`, `frontend/src/config/roles.js`, `frontend/src/context/CommandCenterContext.jsx`, `frontend/src/modules/super-admin/{FinancialOperationsPage.jsx, Plane1BillingPage.jsx, lenses/ReliabilityLens.jsx}`, `frontend/src/pages/SettingsPage.jsx`, `frontend/src/service/commandCenterService.js`, `frontend/tests/super-admin-browser-login.spec.ts`

**Untracked (new, never committed):**
`backend/app/modules/super_admin/configuration_service.py`, `backend/tests/test_phase4_governance.py`, `frontend/src/modules/super-admin/ConfigurationGovernancePage.jsx`, plus build artifacts `frontend/playwright-report/` and `frontend/test-results/` (neither gitignored — a real gap, see §26).

Every one of these files, on inspection, implements one of the six Phase 4 gap items (G-01–G-06) defined in the local, uncommitted `docs/SUPER_ADMIN_PHASE4_CURRENT_STATE_AUDIT.md`. This working tree is mid-Phase-4, not a stray unrelated change. See §24 for the full G-01..G-06 completion table.

### 2.3 Directory responsibility map

| Directory | Responsibility | Domain/Plane | Notes |
|---|---|---|---|
| `backend/app/modules/auth/` | Platform-wide authentication, JWT, MFA (TOTP), currency defaults at registration | Shared | Single router file |
| `backend/app/modules/billing/` | Tenant-facing billing product: invoices, payments, customers, products, pricing, tax, dunning, collections, Stripe, contracts, quotes | Plane 2 / tenant | 26 sub-routers, 30 services, 18 repositories, 37 models |
| `backend/app/modules/commercial/` | Zoiko's own commercial layer over tenants: accounts/plans/plan-versions/subscriptions | Plane 1 / platform | Consumed by `super_admin` |
| `backend/app/modules/organizations/` | Tenant organization CRUD/schema, lifecycle | Shared | |
| `backend/app/modules/chatbot/` | AI assistant (RAG, guardrails, model gateway) | Shared / tenant feature | 28 models, own test suite |
| `backend/app/modules/super_admin/` | Entire Super Admin control plane — one 3031-line router, 14 service files | Super Admin only | No repository layer — Router → Service → ORM directly |
| `frontend/src/modules/super-admin/` | Super Admin UI: 21 pages + 5 Command Center lenses + Configuration Governance (new) | Super Admin only | |
| `frontend/src/modules/billing/` | Tenant billing product UI | Plane 2 / tenant | |
| `frontend/src/modules/billing-admin/` | Org-admin-level billing configuration surface | Tenant, admin tier | Distinct from both `billing/` and `super-admin/` |
| `frontend/src/modules/organization-admin/` | Tenant org-admin console | Shared | |
| `frontend/src/modules/ai-assistant/` | Chatbot UI | Shared | |

**Important architectural observation for §25 (standalone readiness):** the frontend production build bundle (confirmed via the actual `npm run build` output during this audit) includes `AssistantPanel`, tenant `billing`/`billing-admin`/`organization-admin` chunks, and `super-admin` chunks all in **one single Vite application** — there is no separate build/deploy artifact for "the standalone Super Admin app." Super Admin is a role-gated section of one larger app, not a physically standalone product. This is discussed further in §35.

### 2.4 Dead / duplicate / legacy / stray findings (read-only, nothing deleted)

| Finding | Evidence | Severity |
|---|---|---|
| Stray file `backend/=2.9.0`, **tracked in git** | 208-byte file containing literal `pip install` stdout ("Collecting pyotp / ... Successfully installed pyotp-2.10.0"); introduced in commit `77f413b`. Almost certainly an accidental `pip install "pyotp>=2.9.0" > file` where the shell split on `>=`. | P3 hygiene — should be `git rm`'d |
| `backend/uvicorn_stderr.log`, `uvicorn_stdout.log`, `*_run1.log` | Present on disk (up to 773KB), correctly **not tracked** (`*.log` gitignored) | Non-issue |
| `frontend/playwright-report/`, `frontend/test-results/` | Untracked build artifacts with **no gitignore rule** covering them | P3 — real gap; a future `git add -A` would commit them |
| `backend/app/modules/billing/service.py` | Self-documented `"""Legacy service module... Kept for backward compatibility"""`; zero current call sites | P3 — dead but honestly labeled |
| `backend/seed_knowledge.py` vs `backend/scripts/seed_knowledge_base.py` | Confusingly similar names, NOT duplicates — different seeding strategies (hardcoded list vs. doc ingestion) | P3 — naming hygiene only |
| `backend/tests/__pycache__/` bytecode for **34 test files that no longer exist as `.py` source** | e.g. compiled bytecode for `test_stripe_webhook_security`, `test_super_admin_mfa`, `test_cors_production_simulation`, `test_credit_note_void_applied_guard` — existed as recently as 2026-08-20, never committed, now gone from the working tree | **Worth a direct question to the team** — this is physical evidence that security-relevant test coverage (Stripe webhook security, super-admin MFA, CORS production simulation, credit-note immutability) existed locally and disappeared without ever reaching git. Not provably malicious or provably benign — genuinely UNKNOWN whether it was consolidated elsewhere or lost. |
| Documentation churn — 4+ overlapping "is this done yet" report lineages | See §28 | Process finding, not code |

No orphaned Super Admin pages, no dangling routes, no hardcoded secrets/API keys, no mass-assignment patterns, and no unsafe raw-SQL string interpolation were found (see §27 for the full security sweep).

---

## 3. Frontend Architecture

Full route/page/component/service/endpoint inventory is in the companion document `SUPER_ADMIN_ROUTE_AND_MODULE_INVENTORY.md`. Summary here.

**Route guard model:** every `/super-admin/*` route is wrapped in one `ProtectedRoute` (`components/ProtectedRoute.jsx:29-43`) that checks only for a valid token + role `super_admin`. There is **no per-route capability check in the router** — finer-grained gating (where it exists) happens inside individual page components, inconsistently (see below), and is always ultimately enforced by the backend regardless of what the frontend does.

**Confirmed defect (uncommitted, currently in the working tree):** `frontend/src/modules/super-admin/FinancialOperationsPage.jsx:170` reads `{isMulti ? (...)`, but `isMulti` is never declared in `F1BillingsCard`'s scope (only `isSingle`/`isUnknown` exist). This throws `ReferenceError: isMulti is not defined` on **every** render of the Financial Operations page — all 8 routes that map to this one component (`/financial/invoice-engine`, `/payments`, `/balances`, `/reconciliation`, `/credits`, `/usage`, `/tax`, `/financial-operations`). Confirmed independently by three of the seven research passes in this audit, and confirmed by `git diff` against HEAD: the committed version has no multi-currency branching at all; the bug was introduced by the in-progress, uncommitted currency-honesty fix (G-01). This is caught only by the top-level `ErrorBoundary` (`App.jsx:328-346`), which renders a raw stack trace, not a scoped fallback.

**Confirmed fabricated-data violation (pre-existing, unrelated to the current diff):** `ReliabilityLens.jsx:37-59` renders two hardcoded static arrays (`subsystems`, `integrations`) as if they were live monitoring signals — e.g. `{ name: "Stripe Payment Gateway", status: "Configured (Domain B)", monitored: true }` — with **no backing API call**. This directly contradicts the file's own header comment: *"Integration Health modules are NOT rendered as fabricated green tiles."* This is a live violation of the mandate's "no fake green integration states" rule and sits in the same file whose R4 (API latency) card was, in the same uncommitted diff, correctly reworked to use real data. **This is not a Phase 4 item — it predates the current diff and should be fixed independently of any Phase 4 decision.**

**Decorative, non-functional controls:** `CommandCenterContextBar.jsx` renders 6 selectors (Environment, Domain, Legal Entity, Region, **Reporting Currency**, Period) bound to `contextScope` state that is read/written only within `CommandCenterContext.jsx`/`CommandCenterContextBar.jsx` itself — never passed to any API call, never filters any list or dashboard anywhere in the app. The "Reporting Currency" selector in particular implies a currency-conversion capability that the rest of the product (`FinancialOperationsPage.jsx`, `Plane1BillingPage.jsx`) explicitly disclaims having ("never summed across currencies," no exchange-rate source exists). This is misleading UI, not a security defect.

**Two parallel, incompatible HTTP/session layers:** `frontend/src/api/client.js` and `frontend/src/service/api.js` both read/write the same three `localStorage` keys but have diverging refresh-failure semantics and incompatible `setSession` signatures. Auth pages, `UsersPage`, `SettingsPage`, `ProtectedRoute`, `AuthContext` use one; every super-admin `service/*.js` module uses the other. A future fix to session/token handling (e.g. rotation, httpOnly migration) could easily be applied to one and missed in the other.

**Duplicated permission-check logic:** `AuthContext.jsx` defines `hasRole(roles)` specifically to centralize role checks, but it has **zero call sites** anywhere in the frontend. Instead, `role === "super_admin"` is re-implemented as a literal string comparison at 7+ separate locations in `BillingShell.jsx` alone, plus `App.jsx`, `TopBar.jsx`, `CommandCenterContext.jsx`, `UsersPage.jsx`.

**Inconsistent MFA requirement across three structurally-identical breaker-toggle UIs:** `KillSwitchPage.jsx`'s toggle modal requires only a reason + typed confirmation phrase — no MFA code field exists — while the near-identical `GovernancePage.jsx` breaker modal and the `ApprovalQueuePage.jsx` breaker-decision modal both require a fresh MFA code on every state change.

**Orphaned maker-side breaker:** `commandCenterService.js` exports a generic circuit-breaker catalog API (`getCircuitBreakerCatalog`, `setCircuitBreaker`, `proposeCircuitBreakerChange`) with **zero call sites** anywhere in the frontend. The backend's `tenant_payment_attempts` breaker scope is visible read-only in the Triage "Safety Controls" list, but no page anywhere can actually toggle it — `KillSwitchPage` only manages `commercial_subscription_charging`, `GovernancePage`'s card is hardcoded to `tenant_invoice_finalization` only.

**Orphaned page:** `LaunchReadinessPage.jsx` is routed (`/super-admin/launch-readiness`) but linked from no nav section, no `CommandPalette` command, and no in-page link anywhere — reachable only by typing the URL.

**Loading/UNKNOWN/NOT CONFIGURED state discipline:** genuinely good — consistent use of shared `Spinner`/`ErrorState`/`EmptyState` components and explicit `"UNKNOWN"`/`"NOT CONFIGURED"` literals rather than fabricated zeros, e.g. `FinancialOperationsPage.jsx` ("No invoice data — totals UNKNOWN"), `ConfigurationGovernancePage.jsx` (`UnknownChip`), `Plane1BillingPage.jsx` (literal `"UNKNOWN"` MRR state).

---

## 4. Backend Architecture

**Layering:** Router → Service → ORM directly. **There is no Repository layer** in `super_admin/` (unlike `billing/`, which has 18 repository files). Exactly one router file, `backend/app/modules/super_admin/router.py` (3031 lines), owns every Super Admin concern.

**Two incompatible error-handling conventions coexist in the same module:**
- Pattern A (commercial-catalogue endpoints): services raise plain `ValueError`; the router catches and translates to `BadRequestException`/`ForbiddenException`.
- Pattern B (`user_admin_service.py`, `lifecycle_service.py`, `attention_service.py`): services import `app.core.exceptions` and raise HTTP-shaped exceptions (`ZoikoException` subclasses, which **are** `HTTPException` subclasses) directly.

Both patterns exist side by side with no comment explaining the split — a real, evidenced layering inconsistency, not a style nit.

**Transaction-boundary convention violated by one service:** the module-wide convention (documented in multiple service docstrings) is "services flush, routers/callers commit." `privileged_access_service.py` breaks this, calling `self.db.commit()` internally 7 times — the only service in the module that owns its own transaction boundary.

**Duplicated business rule:** the auto-expire-minutes bound check for circuit breakers is implemented independently in both `kill_switch_service.py:238-242` and `router.py:1546-1549` — if they drift, the maker-checker proposal path and the break-glass path could accept different ranges.

**Capability-based RBAC migration is roughly half-done.** 34 endpoints use the granular `require_capability(...)` dependency; ~40 endpoints — including commercial-plan mutation, org lifecycle transitions, and sensitive admin actions like password/MFA reset — still rely solely on the coarse `get_current_super_admin` floor. This is a real, current architectural inconsistency, not a completed migration with a few stragglers.

**Domain-A/Domain-B breaker asymmetry:** the Plane 1 billing kill switch (`commercial_subscription_charging`) is gated only by `get_current_super_admin` — no MFA step-up, no maker-checker — while the structurally parallel Plane 2 breakers require both.

**Logout is client-side only.** No server-side token revocation/blacklist exists anywhere in the codebase; a logged-out access token remains valid until natural expiry.

**What is genuinely solid:**
- `get_current_super_admin` correctly rejects both wrong-role tokens (403) and "hybrid" tokens (`role=super_admin` with a non-null `organization_id`) — checked at two layers (defense in depth).
- MFA step-up (TOTP + recovery codes) has real replay protection (120s window) and lockout, and is genuinely required before the three privileged actions that should demand it (JIT activation, break-glass breaker toggle, maker-checker decision) — and genuinely *not* required at normal login, matching the documented directive.
- JIT privileged access enforces its 30-minute cap server-side (clamped, not trusted from the request), enforces one-live-grant-per-admin, and re-checks expiry lazily on every read of tenant data — not just hidden in the UI.
- Maker-checker self-approval rejection (`requester == approver`) is enforced server-side, independent of any UI, with an identical guard in both `approve()` and `reject()`.
- `PlatformAuditLog` writes are genuinely transactional (flush-only, same transaction as the mutation) at every call site examined, with one narrow, deliberate, well-commented exception (an org-delete FK scrub that nulls only the org pointer, never the audit content).
- Domain C telemetry (`telemetry_service.py`) is confirmed to contain zero monetary/financial fields on full read of every method.

---

## 5. Database Architecture

**No Alembic.** The actual mechanism is `Base.metadata.create_all()` for missing tables plus a self-healing `_add_missing_columns()` that diffs `information_schema` against the model and issues additive, nullable-only `ALTER TABLE ... ADD COLUMN` on Postgres. 12 hand-written one-off scripts in `backend/migrations/` handle cases the auto-heal can't (new tables historically, and data backfills). There is no ordering/ledger system — each script is independently idempotent and manually invoked.

**FK discipline is excellent:** 100% of foreign keys across all six modules' models specify an explicit `ondelete` (`RESTRICT`/`CASCADE`/`SET NULL`) — no orphan-row risk from an unspecified default, verified by direct grep across every `ForeignKey(...)` call.

**Tenant isolation:** `organization_id` is present and `NOT NULL, RESTRICT` on essentially every billing table; nullable-with-documented-semantics on `User` (NULL = super_admin), `PlatformAuditLog` (NULL = org-agnostic event), and `AttentionItem` (NULL = platform-wide incident). No accidental/undocumented nullable org scoping was found.

**Plane 1 / Plane 2 model isolation confirmed at the schema level:** zero cross-referencing foreign keys between `commercial/models.py` and `billing/models.py` in either direction. The one deliberate seam is `commercial/service.py`'s `change_plan()` writing into `BillingAuditLog` (an audit trail write, not a financial-data touch) — a narrow, intentional, documented exception, not a silent merge.

**Two real concurrency gaps (application-level invariants with no DB-level backing):**
1. "One active/pending JIT grant per admin" is enforced only by a pre-check query in `privileged_access_service.py`, with no partial unique index behind it — two concurrent requests from the same admin could race past the check.
2. "One published catalog version per plan" has no `UniqueConstraint` and no row-lock in `CommercialPlanVersionService.create_draft()`/`approve_and_publish()` — concurrent draft creation could produce duplicate version numbers, and nothing prevents two simultaneously-PUBLISHED versions of one plan. (Contrast: `DocumentSequence` and `BillingKillSwitch.scope` both correctly use row-locking/uniqueness for the same class of problem, making these two omissions look like oversights rather than deliberate choices.)

**Audit-log append-only discipline holds**, with one real gap distinct from the above: `PrivilegedTenantAccessGrant` rows are **hard-deleted** by the generic organization-delete sweep in `organizations/router.py`, unlike `platform_audit_logs`, which that same sweep explicitly excludes. This means the record of "who was granted privileged access to a tenant's financial data, when, and why" is permanently destroyed on org deletion — inconsistent with the platform's own stated principle that this fact-of-access should be durable.

**Requested models not found as persisted entities** (reported honestly per the mandate's own instruction not to assume anything exists): no dedicated `Usage`/`UsageRecord` table (only enum values reference usage billing); no dedicated `Entitlement` table (entitlements live as JSON on `CommercialPlan`); no `PriceBook` model by that name (closest analog is `PriceList`/`PriceListItem`); no persisted "launch readiness" table (computed on demand, Pydantic-only response); no "API metrics" table (in-memory `deque`, resets on process restart, explicitly documented as such).

---

## 6. Authentication Architecture

Traced end to end: `LoginPage.jsx` → `apiFetch("/api/auth/login")` → `auth/router.py:115-122` (rate-limited 10/min) → `auth/service.py:143-183` (bcrypt verify, no user-enumeration signal, mints full access+refresh JWT for every role including `super_admin`) → `core/dependencies.py:63-101` (`get_current_user`, re-verifies role/org against the live DB row on every request) → `get_current_super_admin` (`core/dependencies.py:104-110`, rejects wrong-role and hybrid tokens). Password hashing is bcrypt via `passlib` (`core/security.py:21`).

**Confirmed: normal Super Admin login does not require MFA.** This is explicit by design (docstrings in `mfa_service.py`, `auth/service.py`, `auth/router.py`, and the session-8 directive quoted in the documentation-reconciliation pass) — MFA exists solely as a step-up factor for privileged actions, not a login gate. This matches the audit mandate's expected boundary exactly.

**Refresh tokens are not rotated** — `refresh_user_token` mints a new access token but returns the same refresh token value. **Logout does not revoke the token server-side** (§4). Neither is a violation of the stated mandate rules, but both are real gaps worth naming plainly.

**The specific account named in the audit mandate** (nikhil@zoikogroup.com) was not queried against a live database in this pass — no live DB user inspection was performed, and doing so was out of scope for a read-only code audit. This is recorded as **NOT VERIFIED IN THIS PASS**, not as PASS or FAIL, per the mandate's own honesty rule. The `/health` check (§28) confirms the app *can* reach the configured Neon database; a follow-up session with explicit authorization to query it should confirm this account's `role`/`organization_id`/`is_active`/`is_verified` fields directly.

---

## 7. Authorization Architecture

Two-dimensional model: `UserRole.SUPER_ADMIN` is the floor; `PlatformRole` (`PLATFORM_ADMINISTRATOR`, `SUPPORT_OPERATOR`, `SECURITY_OPERATOR`, `RELIABILITY_OPERATOR`, `AUDITOR`, `FINANCE_READONLY`) narrows which capabilities a super admin holds, enforced via `core/capabilities.py`'s `require_capability(...)` FastAPI dependency factory (validates capability names exist at import time — a typo fails at server boot, not at request time). `platform_role IS NULL` is treated as `PLATFORM_ADMINISTRATOR` (full access) by deliberate, documented backward-compat design.

As noted in §4, this system only covers roughly half the router's endpoints. The full capability matrix is in the companion gap-matrix document (§8 below summarizes it).

---

## 8. Capability Matrix

| Capability | SUPPORT_OPERATOR | SECURITY_OPERATOR | RELIABILITY_OPERATOR | AUDITOR | FINANCE_READONLY | PLATFORM_ADMINISTRATOR |
|---|---|---|---|---|---|---|
| triage.read | ✓ | ✓ | ✓ | ✓ | | ✓ (all) |
| reliability.read | | ✓ | ✓ | ✓ | | ✓ |
| governance.read | ✓ | ✓ | ✓ | ✓ | | ✓ |
| tenant_support.request/activate/exit | ✓ | | | | | ✓ |
| incident.acknowledge/assign/transition/suppress | | ✓ | ✓ | | | ✓ |
| audit.read | | ✓ | | ✓ | | ✓ |
| launch_readiness.read | | ✓ | ✓ | ✓ | | ✓ |
| global_search.read | ✓ | ✓ | ✓ | ✓ | | ✓ |
| metric_dictionary.read | | ✓ | ✓ | ✓ | ✓ | ✓ |
| financial_consistency.read | | | | ✓ | ✓ | ✓ |
| circuit_breaker.read | | ✓ | ✓ | ✓ | | ✓ |
| circuit_breaker.manage | | ✓ | | | | ✓ |
| platform_config.read | ✓ | ✓ | ✓ | ✓ | | ✓ |
| platform_config.manage | | ✓ | | | | ✓ |
| platform_role.manage | | | | | | ✓ (exclusively) |

**Endpoints NOT covered by any capability** (rely only on the coarse `get_current_super_admin` floor — any super admin regardless of `platform_role` can perform these): all commercial-plan/subscription CRUD and versioning, organization lifecycle transitions, `admin_reset_password`, `admin_reset_mfa`, `invite_super_admin_user`, dashboard stats, production-acceptance read, `billing-kill-switch` toggle (Plane 1). This is the "roughly half-done RBAC migration" finding from §4, stated here as the concrete endpoint list.

**Tenant-side roles** (`org_admin`, `billing_admin`, `finance_approver`, `auditor`) are governed by coarser role-name checks in `core/dependencies.py`, not by the `PlatformRole` capability map — the two systems are architecturally separate, which is correct (tenant roles and platform roles are different dimensions) but worth stating explicitly since the mandate asked for one unified matrix.

Unauthenticated / expired-token / revoked-JIT-session / invalid-session behavior: all confirmed DENY at the correct enforcement layer by direct code inspection and by passing backend tests (`test_capabilities.py:182` — capability revoked immediately on role change; `test_super_admin_command_center.py:158` — expired JIT grant denied on next read, not just hidden in UI; `test_super_admin_command_center.py:86` — cross-actor IDOR on JIT grants denied).

---

## 9. Route Inventory

See companion document `SUPER_ADMIN_ROUTE_AND_MODULE_INVENTORY.md` for the full per-route table (path, component, nav group, guard, service calls, backend endpoints).

**Headline counts:** ~34 distinct route *paths* under `/super-admin/*`, resolving to **21 distinct page components** (several paths intentionally or non-intentionally alias to the same component — e.g. all 8 "Financial Operations" IA sub-paths render one `FinancialOperationsPage`; all 5 "Integrations & Automation" sub-paths render `ReliabilityPage` or `TenantHealthPage`). No dangling routes (every routed component exists on disk); one orphaned-from-navigation route (`LaunchReadinessPage`).

---

## 10. Information Architecture Mapping

**The navigation *labels* match the canonical 7-group IA from `SUPER_ADMIN_IA.md` exactly, 7-for-7** (Command Center, Platform, Platform Commercial, Financial Operations, Integrations & Automation, Governance & Security, Reliability & Operations), confirmed by direct reading of `BillingShell.jsx`'s `NAV_SECTIONS`. The new Configuration Governance page was added to the correct group (Governance & Security) in this same in-progress change.

**But label parity is not content parity.** Several IA-documented "distinct" leaf pages collapse onto one shared component with no differentiation:
- All 7 documented Financial Operations sub-pages (Invoice Engine, Payments & Disputes, Balances & Allocations, Reconciliation, Credits/Adjustments & Refunds, Usage & Metering, Tax & E-Invoicing) render the identical `FinancialOperationsPage.jsx` with 4 dashboard cards (F1–F4) — not 7 navigable, differentiated workspaces.
- All 5 documented Integrations & Automation sub-pages (Payment Gateways, Connectors, API & Webhooks, Jobs & Queues, Imports & Exports) render either `ReliabilityPage.jsx` (generic health/job content) or `TenantHealthPage.jsx` — there is no page anywhere in the codebase actually about payment gateways, ERP connectors, or webhooks. The `/super-admin/integrations` bare path itself resolves to a real component (not a 404) but is linked from **no nav item, no command, no in-app link anywhere** — reachable only by typed URL.
- Platform Commercial's IA-documented "Commercial Accounts" and "Plans, Offers & Trials" sub-items exist as UI labels but "Offers" has no distinct entity or route — it does not exist as a concept in the backend at all (confirmed: no `CommercialOffer` class anywhere).

**Governance & Security** similarly has only 2 of its 6 documented leaf pages (`Approval Center`, `Audit & Evidence`) as genuinely distinct components; "Roles & Access," "Privileged Sessions," and "Data Governance" all resolve to `UsersPage`, `SupportAccessPage`, and `GovernancePage` respectively — i.e., the same components already linked elsewhere, presented under a second nav label.

**Conclusion:** the IA compliance claim in every prior acceptance report ("canonical IA preserved") is true only at the label/grouping level. At the content level, roughly half of the documented leaf pages are aliases for a smaller set of underlying components, and one entire group (Integrations & Automation) has no dedicated implementation behind any of its labels.

---

## 11. Domain A / B / C Architecture

The three-domain separation (Domain A = Plane 1 commercial, Domain B = Plane 2 tenant financial ops, Domain C = platform reliability/telemetry) is **structurally real**, not just a naming convention:
- Domain C (`telemetry_service.py`) is confirmed, on full read of every method, to contain zero monetary/financial fields.
- Domain A (`commercial/`) and Domain B (`billing/`) have zero cross-referencing foreign keys.
- The chatbot module independently re-implements the same Domain A/B distinction on `TenantContext.billing_plane` — a positive consistency signal, not a violation.

The one place all three domains legitimately intersect is governance/audit tooling: `PlatformAuditLog.entity_type` records both `CommercialPlanVersion` events (Domain A) and `Organization` events (Domain B/tenant) in the same table — this is a shared platform-plane audit trail, not a data-model boundary crossing.

---

## 12. Plane 1 (Platform Commercial) Architecture

Entities confirmed to exist with real logic: Commercial Accounts (1:1 with Organization), Commercial Plans (reusable templates, no org scoping by design), Commercial Plan Versions (versioned, immutable-once-published), Subscriptions, a real `change_plan()` state machine (supersede-with-history, not in-place mutation — full transition table verified at `commercial/service.py:705-732`), and Entitlements (explicitly self-documented as "foundation only, NOT enforced anywhere yet").

**Confirmed NOT to exist:** a distinct "Offers" entity; Commercial Invoices/Payments/Collections (the frontend explicitly renders `NotImplementedPanel`s for these with honest copy: *"there is no invoice model or processor behind this surface, so no invoice rows can be shown"*).

**MRR reporting is genuinely honest, verified by reading the actual query logic, not just the label:** per-currency buckets (never summed across currencies), a real annual÷12 monthly-equivalent rule, zero-priced catalog → `state="unknown"`/`amount=None` (never a fabricated zero), and — per the in-progress Phase 4 work — a new per-plan price-coverage breakdown (`unpriced`/`partially_priced`/`fully_priced`) that is now backend-complete and tested.

**Access-control asymmetry vs. Plane 2:** the Plane 1 commercial-reporting endpoint is gated only by the coarse `get_current_super_admin` floor, while the parallel Plane 2 financial endpoints require the specific `financial_consistency.read` capability. Not a plane-merging bug, but a real inconsistency in the privilege model between the two planes.

---

## 13. Plane 2 (Financial Operations) Architecture

Invoice Engine, Payments, Dunning/Recovery, Allocations, Reconciliation, Credits, Refunds, Tax all have real, non-stub backend implementations in `billing/`. Financial truth is confirmed to originate server-side: `FinancialOperationsPage.jsx` performs no client-side summation of raw rows (verified by grepping for `reduce`/`.sum(`/`+=` across the file — none found operating on money fields); the backend docstring at the summary endpoint states explicitly "All values are real database aggregates — no client-side math, no fabricated numbers," and this held up under inspection.

**The previously-known currency-summing bug is fixed** in the current working tree: `financial_consistency_service.get_financial_operations_summary()` now groups by `Invoice.currency`, exposing a single scalar only when exactly one currency exists; an empty database correctly yields `currency_state="unknown"` with no amount keys at all, never a fabricated `0`. **However, the frontend half of this same fix is the file that currently crashes on render** (§3) — the honest backend data currently has no way to reach the screen.

**One residual honesty gap, distinct from the currency fix:** `financial_consistency_service.py:313` hardcodes `"unbilled_usage_anomalies": 0` — a static literal, not a derived query. Not a fabricated "success" claim, but not real telemetry either; flagged for a future pass.

**Collection rate** is computed client-side as a simple percentage of two already-scalar, single-currency backend-supplied numbers (guarded against division by zero, not invoked in the multi-currency branch) — this is a display calculation on trusted inputs, not a fabrication or a cross-source aggregation.

---

## 14. Reliability Architecture

`ReliabilityPage.jsx`/`ReliabilityLens.jsx` mix genuinely-live data (R4: API latency/error-rate, now real per the in-progress Phase 4 work) with **hardcoded, non-live "R1/R2" subsystem and integration status arrays** that directly contradict the file's own anti-fabrication comment (§3). This is the audit's clearest instance of the mandate's prohibited "fake green integration states."

Job/queue health (`telemetry_service.get_job_health`) is real, DB-backed, with freshness states (FRESH/STALE/UNKNOWN) rather than a default-healthy assumption.

---

## 15. Governance Architecture

Approval Center (maker-checker) is real and server-enforced: self-approval rejection (`requester == approver`) is checked inside the service, independent of the UI, for both the catalog-publish and circuit-breaker-decision flows — the only two operation types currently routed through the generic decision endpoint.

Audit & Evidence (`PlatformAuditLog`) is genuinely append-only, transactionally written with the mutation it describes, with sensitive-value redaction honored at every call site inspected (though redaction is a caller-side convention, not something the audit service mechanically enforces itself — a future careless call site could still leak a value the redaction pattern-list doesn't recognize).

"Roles & Access," "Privileged Sessions," and "Data Governance" as distinct IA leaf pages do not exist as distinct implementations (§10) — they alias `UsersPage`, `SupportAccessPage`, and `GovernancePage`.

---

## 16. Attention / Triage Architecture

`AttentionItem` lifecycle (open → acknowledge → assign → mitigate → resolve/suppress) is fully modeled with dedup via `source_key`, occurrence-count escalation, SLA deadline columns, and a required resolution code. Financial-integrity failures (`FinancialConsistencyService` FAILED state) are floored at P0 severity regardless of occurrence count — a deliberate, documented design choice.

**Duplication, not a correctness bug:** `TriagePage.jsx` and `GovernancePage.jsx` independently poll and can mutate the same Attention Engine against the same underlying data — two separate UI surfaces for one queue, which is a UX/architecture redundancy worth simplifying, not a security or data issue.

---

## 17. Circuit Breaker Architecture

Registered scopes (`kill_switch_service.py`): `commercial_subscription_charging`, `tenant_invoice_finalization`, `tenant_payment_attempts`, `tenant_dunning`, `tenant_billing_communications`. Expiry is enforced **lazily on every read** (`effective_state()` → `_lift_expired_pause()`), not via a background sweep — confirmed no scheduled job exists for this. **A permanent (non-expiring) breaker state is not possible by construction**: `set_enabled()` always sets `expires_at` when engaging, validated against a hard 5-minute–14-day range.

**Real asymmetry confirmed:** the Plane 1 charging kill switch has no MFA step-up and no maker-checker path, unlike the Domain B breakers, which require both for a direct toggle (step-up) or for the checker's decision (maker-checker). **A breaker with no UI to manage it exists:** `tenant_payment_attempts` is visible read-only in Triage's Safety Controls list but has no page anywhere that can actually toggle it (§3).

This audit did **not** independently re-verify, in `billing/`'s own service code, that every documented breaker-gated method (`InvoiceService.finalize_invoice`, `StripeService.create_payment_intent`, `DunningService.process_dunning`, etc.) actually calls `require_enabled(scope)` at its real call site — the super-admin-side research pass confirmed the catalog/registration/enforcement-point *design*, but the billing-side call-site verification was out of that pass's assigned scope. **Recorded as NOT INDEPENDENTLY RE-VERIFIED IN THIS PASS** rather than assumed true from prior documentation.

---

## 18. JIT Support Access Architecture

`PrivilegedTenantAccessGrant` / `PrivilegedAccessService`: reason + ticket reference both mandatory (empty rejected server-side); max grant duration hard-clamped to 30 minutes server-side regardless of the requested value; one live/pending grant per actor enforced by pre-check (though not by a DB constraint — §5); MFA step-up required to activate, with a 5-minute activation window before auto-denial; expiry enforced lazily on every subsequent read, including the tenant-data read itself (`require_active_grant()` is called immediately before composing any tenant data — a stale-but-not-yet-expired DB row cannot be exploited by a request that lands after the true expiry moment); revocation is actor-initiated and owner-bound (cross-actor access returns 404, never 403, so existence is never disclosed to another admin).

**Real durability gap:** grant rows are hard-deleted on organization deletion (§5) — the audit trail of who accessed a tenant's data is not preserved past that tenant's deletion, unlike `PlatformAuditLog`.

---

## 19. Financial Integrity Architecture

`FinancialConsistencyService.check_allocation_consistency()` produces exactly three states from a comparison of `PaymentAllocation` sums against `Invoice.total_amount`: **FAILED** (over-allocation exists), **UNKNOWN** (zero invoices — explicitly checked *before* the VERIFIED branch can fire, so empty evidence can never become VERIFIED), **VERIFIED** (only the remaining case). This is a correct three-state honest machine, confirmed by reading the actual conditional order, not just trusting the state names.

FAILED routes to a P0 Attention item; VERIFIED auto-resolves any existing one; UNKNOWN is deliberately a no-op for the attention engine.

---

## 20. Commercial Reporting Architecture

Covered in §12. The one addition worth restating here: the per-plan price-coverage breakdown (Phase 4 item G-04) is now backend-complete, schema-complete, and rendered in `Plane1BillingPage.jsx` with a real "NO PUBLISHED PRICE" badge — this is a genuine, evidence-based improvement to reporting honesty, not a cosmetic addition.

---

## 21. Global Search Architecture

`search_service.py` is identifier-first; organization results route to Support Access (`requires_access=true`) rather than exposing tenant financial data directly; tenant financial entities (invoices, payments, customers) are confirmed never indexed. The in-progress Phase 4 work (G-06) adds `status`/`severity`/`plane` enrichment to search results and adds Plane 1 subscription results (identity-level only: plan code + status) — backend-complete and tested. No mechanism was found by which global search could bypass tenant isolation or the JIT-access boundary.

---

## 22. Audit Architecture

Covered in §15 and §4. Summary: `PlatformAuditLog` and `BillingAuditLog` are both genuinely append-only in the service layer; secret/token leakage was checked at every call site inspected and none was found, though this rests on caller discipline and a substring-based sensitive-key pattern list rather than a mechanically-enforced guarantee at the audit-write layer itself.

---

## 23. Telemetry Architecture

Covered in §11, §14. Domain C purity (no monetary fields) confirmed by full read of `telemetry_service.py`. The genuine gap is not in the telemetry *service* but in the *UI* layer above it — `ReliabilityLens.jsx`'s hardcoded subsystem/integration arrays present non-telemetry as if it were telemetry (§3, §14).

---

## 24. Phase 4 Readiness / In-Progress Work — Detailed Findings

This section exists because the audit's central finding required its own dedicated space: **Phase 4 has already been substantially built**, in direct tension with this audit's governing instruction.

| Gap ID | Description | Backend | Schema | Tests | Frontend | Net status |
|---|---|---|---|---|---|---|
| G-01 | Multi-currency aggregation bug in Plane 2 summary | ✅ Complete (`financial_consistency_service.py`) | ✅ | ✅ (3 tests) | ❌ **BROKEN** — `isMulti` undefined, crashes on every render | **BLOCKED — cannot ship as-is** |
| G-02 | Settings mutations unaudited + ungated | ✅ Complete | ✅ | ✅ (6 tests) | ✅ Complete | Complete |
| G-03 | No configuration governance view | ✅ Complete (`configuration_service.py`, new) | ✅ | ✅ | ✅ Complete (`ConfigurationGovernancePage.jsx`, new) | Complete |
| G-04 | Plane 1 price-book coverage not explained per plan | ✅ Complete | ✅ | ✅ (3 tests) | ✅ Complete | Complete |
| G-05 | API error-rate observability missing | ✅ Complete (`api_metrics.py`) | ✅ | ✅ (3 tests) | ✅ Complete (real `ReliabilityLens` R4 card) | Complete |
| G-06 | Search results lack status/plane enrichment | ✅ Complete | ✅ | ✅ (2 tests) | ✅ Complete (`CommandPalette.jsx` badges) | Complete |

**Five of six items are fully complete end-to-end, tested, and working.** The sixth (G-01) is complete on the backend but broken on the frontend in a way that will crash a production page. **This is not "Phase 4 hasn't started" — this is "Phase 4 is nearly finished."**

This creates a direct conflict this audit cannot resolve on its own authority: the audit's governing instruction says stop before Phase 4; the repository's actual state is mid-Phase-4 with a stabilization bug in flight. Per this audit's own rules (do not implement new features, do not start Phase 4), **no further Phase 4 work was done and the `isMulti` bug was not fixed**, even though it is a one-line fix, because fixing it would mean advancing Phase 4 work that this audit was explicitly told not to advance. This is flagged as the single most important open decision for the user: **commit and finish (fix the one bug) / hold and review / revert** are the three live options, and this document takes no position on which is correct — only that leaving the working tree as-is (broken render, one accessibility regression introduced alongside it — see §25) is not a safe default.

Also worth naming plainly: the Playwright spec `super-admin-browser-login.spec.ts` was modified, as part of this same uncommitted diff, to exclude HTTP 401/403 responses from its "console errors"/"network failures" failure counts — plausibly necessitated by the new capability gates producing legitimate 403s during the E2E run, but this also means a genuinely unexpected 401/403 elsewhere in the app would now be silently excluded from that test's failure signal. This is a test-weakening change and should be reviewed, not merely accepted, before this diff is committed.

---

## 25. Standalone Product Readiness

See §2.3 and §35 for the full discussion. Summary: authentication, data, and API boundaries between Super Admin and tenant billing are real and enforced server-side. The **build/deploy boundary is not standalone** — Super Admin ships as one role-gated section of a single larger Vite/FastAPI application that also contains the tenant billing product, org-admin console, and AI assistant. Whether this matters depends on what "standalone" was meant to guarantee (a security/data boundary, which holds, vs. a deployable/versioned-independently product, which does not exist). This distinction was not resolved by any document read in this audit and should be clarified explicitly rather than assumed.

---

## 26. Architecture Risks (rollup)

1. Phase 4 work in flight, uncommitted, contains a render-crashing bug (§24).
2. A live-rerun accessibility check found a real, current WCAG violation not present in — or not caught by — prior "0 violations" claims (§3, confirmed again in §28).
3. Nearly all governing documentation is not in version control (§28) — the next engineer to clone this repo will not have `SUPER_ADMIN_ARCHITECTURE.md` or `SUPER_ADMIN_IA.md` at all.
4. Two parallel, incompatible frontend session-handling implementations (§3) — a latent maintenance/security-drift risk.
5. A hardcoded fake-integration-status panel actively violates the mandate's own "no fake green integration states" rule, in a file whose own header comment claims the opposite (§3, §14).
6. RBAC-by-capability is half-migrated; half the router still relies on the coarse super-admin floor for sensitive mutations (§4, §8).
7. Two application-level invariants (one grant per admin, one published plan version) have no database-level backing — exploitable under concurrency, not merely a theoretical gap (§5).
8. `PrivilegedTenantAccessGrant` audit trail is destroyed on org deletion, unlike every other audit record in the system (§5, §18).
9. Un-gitignored Playwright artifact directories (§2.4) risk accidental future commits of generated test output.
10. Untracked evidence of test coverage that existed locally as recently as four days before this audit and is now absent from the working tree (§2.4) — genuinely unresolved, worth a direct question to whoever ran those tests.

---

## 27. Security Assessment

Full red-flag sweep performed across `backend/app/` and `frontend/src/`. Result: the codebase is materially clean of the classic OWASP-style issues checked for — no hardcoded secrets/API keys, no mass-assignment, no unsafe raw-SQL interpolation (the one f-string-into-SQL site uses only ORM-declared table names and a bound parameter for the actual value — assessed safe but fragile-looking, worth a defensive comment), no missing organization-scoping on any tenant-facing read path (verified the one tenant-facing commercial-subscription read derives `organization_id` from the JWT, never a client-supplied value).

**Findings that do warrant attention, ranked:**

| Severity | Finding | Location |
|---|---|---|
| **P1** | A real test-account credential (`Nikhil@zoikogroup.com` + a literal password) is hardcoded in a **git-tracked, currently-modified** Playwright spec file, preserved in git history. If this password is or was ever live on any shared/staging/prod-adjacent environment, it should be rotated and moved to an env var / CI secret. | `frontend/tests/super-admin-browser-login.spec.ts:6-7,137-138` (+ duplicate `.spec.js`) |
| **P2** | Access/refresh tokens are stored in `localStorage`, not an httpOnly cookie, across two separate client modules — a standard SPA pattern, but the frontend has **zero component-level test coverage** (0 of 187 `.jsx` files), so an XSS anywhere in that surface becomes a full session-token theft with nothing to stop it. | `frontend/src/api/client.js`, `frontend/src/service/api.js`, `frontend/src/modules/ai-assistant/api.js` |
| **P3** | `BILLING_SECRET_KEY` has a hardcoded placeholder fallback in code, but is correctly guarded by a boot-time `SystemExit` if `DEBUG=False` and the placeholder is still in use — same pattern applied to `MFA_ENCRYPTION_KEY`. Real exploit path only exists if `DEBUG=True` is mistakenly left on in production, and there is no direct unit test exercising this specific boot-guard. | `backend/app/config.py:27`, `backend/app/main.py:91-96` |
| **P3** | Verbose debug `print()` statements in the chatbot action engine print internal action/intent details (including `proposed_params`) to stdout, bypassing the logging framework's level control and the app's log-redaction filter entirely. Not currently a secret leak, but would become one if a billing action's `proposed_params` ever carried PII/payment data. | `backend/app/modules/chatbot/actions/action_engine.py`, `conversation/engine.py` |
| **P3** | Stray tracked file `backend/=2.9.0` (pip-install-output artifact) | `backend/=2.9.0` |
| **P3** | `requirements.txt` mixes exact-pinned and unconstrained (`slowapi`, `cachetools`, `openpyxl` have no version bound at all) dependencies in a crypto/auth-relevant stack with no lockfile | `backend/requirements.txt` |

No P0 was found. The one candidate P0/P1-shaped issue that *is* present — the `FinancialOperationsPage.jsx` crash — is a correctness/availability defect, not a security defect, and is tracked separately in §24 and the gap matrix.

---

## 28. Documentation Compliance & Governance Findings

**The single largest process finding of this audit:** of the ~30 `SUPER_ADMIN_*` documents this audit was told to treat as authoritative, **only one is tracked in git** (`SUPER_ADMIN_PHASE3_FULL_SYSTEM_QA_REPORT.md`, alongside `SUPER_ADMIN_FULL_AUTHENTICATED_QA_REPORT.md`). The root `.gitignore` contains a blanket `docs/*` rule with only these two exceptions. `SUPER_ADMIN_ARCHITECTURE.md`, `SUPER_ADMIN_IA.md`, and every phase implementation/acceptance report exist only on local disk. **`ZB-SA-CMD-003 v3.0` and `ZB-COM-BILL-001`**, cited throughout as the "authoritative baseline," are not files in this repository at all — they are external mandate references, operationalized in-repo only through `SUPER_ADMIN_ARCHITECTURE.md` (Doc ID `ZB-SA-ARCH-001`). Both are recorded here as **ABSENT AS FILES**, consistent with the mandate's own instruction to record absence honestly rather than assume.

**Documented conflicts found between the (uncommitted, local-only) documents themselves — not reconciled by this audit, flagged per the mandate's own instruction:**

1. **IA vs. build, at the content level** (§10) — never explicitly reconciled in any document; the IA doc is never marked superseded despite ~half its leaf pages not existing as distinct implementations.
2. **A same-day (2026-08-22), same-baseline-commit scope reversal never explicitly acknowledged:** `SUPER_ADMIN_CURRENT_STATE.md` and `SUPER_ADMIN_IMPLEMENTATION_STATUS.md` both state Domain A/Plane 1 work is "explicitly out of scope... not being built," while `SUPER_ADMIN_PHASE3F_PLANE1_REPORT.md` (dated the same or an adjacent session) builds exactly that. `SUPER_ADMIN_METRIC_DICTIONARY.md` was never updated to reflect the MRR metric that Phase 3F actually shipped.
3. **Three same-day QA reports on the same baseline commit (`86163a2`) materially disagree:** one claims 680 passed/1 skipped and 17/17 Playwright with 0 failures; a second claims the identical 680/1 backend figure but only 13/17 Playwright assertions passed for what is presented as the same spec run; a third claims the backend suite never completed (337/681, terminated in an SSL/network path) and that accessibility auditing was "NOT CONFIGURED" for that run — directly contradicting the other two reports' "18/18, 0 violations" claims made the same day.
4. **One document (`SUPER_ADMIN_REAL_BROWSER_QA_REPORT.md`) contradicts itself internally** — the first half claims a fully successful authenticated Playwright run; from roughly its midpoint onward, the same file asserts "0 browser sessions authenticated" and marks every authenticated workflow "NOT EXECUTED."
5. A tracked-vs-superseded MFA design reversal (`SUPER_ADMIN_ENTERPRISE_READINESS_REPORT.md`'s "mandatory login MFA" design was later reversed and is explicitly tracked as `ISS-028` in `SUPER_ADMIN_ISSUE_REGISTER.md` — not a silent conflict, but a trap for anyone reading documents out of chronological order).

**This audit's own re-run of the accessibility check independently corroborates the pattern above rather than resolving it:** a live re-run during this audit (§3, §14) found **1 serious violation on 1 of 18 routes**, not the "18/18, 0 violations" figure repeated across most prior reports. Whether this is a new regression introduced by the in-progress Phase 4 diff or a pre-existing gap that some prior runs caught and others didn't cannot be determined from this pass alone — it is simply the honest, current, directly-observed result.

**Recommendation, stated once here and not repeated:** before any further phase work, the ~29 untracked `SUPER_ADMIN_*` documents (and the four other overlapping report lineages found in `docs/`, per §2.4) should be triaged — decide which are genuinely authoritative-going-forward, commit those, and either delete or clearly archive the rest. An "authoritative" document that no one else can see by cloning the repository is not durable governance.

---

## 29. Phase 1–3 Completion Matrix

| Phase | Claimed | This audit's independent verification |
|---|---|---|
| Phase 1 (Command Center foundation) | Complete, 15/15 acceptance criteria | Command Center, 5 lenses, context bar all present and routed; confirmed by direct code read. Not independently re-run against the original 15-criteria checklist in this pass. |
| Phase 2 (Operational control plane) | Complete, partial R1/R2 coverage documented | Attention Engine, breakers, JIT access, audit log all present with real enforcement (§15-19). R1/R2 (subsystem/integration health) confirmed **not** genuinely implemented — hardcoded arrays (§3, §14), consistent with "partial" framing but the specific gap (fabricated data, not just missing coverage) is more serious than "partial" implies. |
| Phase 3A-3E (Orgs, Users, Lifecycle, Tenant Health, Support Access) | Complete | Confirmed present, routed, tested. |
| Phase 3F (Plane 1 SaaS admin) | Complete, 354 tests | Confirmed: honest MRR, real change-plan state machine, honesty remediation of previously-fabricated CommercialLens numbers. Genuinely solid. |
| Phase 3G (Cross-plane governance) | Complete, 370 tests, 18 a11y routes/0 violations | Plane isolation confirmed at the schema and service level (§5, §11). The "18/18 a11y" claim from this phase **does not match this audit's live re-run** (17/18, 1 serious violation) — cannot determine from this pass whether this is regression or a gap this claim never actually closed. |
| Post-Phase-3 "Full System QA" / "Full Authenticated QA" / "Full E2E QA" (all same day) | Each claims "conditionally accepted, NOT READY FOR PHASE 4" | These three reports **materially contradict each other** (§28, finding 3) and cannot all be true descriptions of one coherent QA session on one commit. Recorded as CONFLICT, not reconciled. |
| Phase 4 | Not started, per every prior document's own closing instruction | **Contradicted by the actual repository state** — see §24. Five of six gap items are backend-complete and tested; the sixth is backend-complete but frontend-broken. |

**Nothing was found to have been marked "complete" with zero implementation evidence.** Every phase's claimed capabilities have corresponding code, and the backend test suite genuinely passes (703/704 non-skipped, 0 failures, re-run live during this audit). The gap between claims and reality is not "things were faked" — it is "the same-day QA reports disagree with each other and with a fresh re-run," and "IA compliance was claimed and is true at the label level but not the content level."

---

## 30. Dead / Duplicate / Legacy Code Findings

See §2.4 for the full table. No orphaned Super Admin pages or dangling routes were found. The most consequential findings in this category are the two parallel frontend HTTP/session layers (§3) and the half-migrated capability RBAC system (§4, §8) — both are "duplicate/inconsistent," not simply "dead."

---

## 31. P0–P3 Defect Register

| ID | Severity | Finding | Location | Status |
|---|---|---|---|---|
| D-01 | **P1 (correctness/availability)** | `isMulti` undefined — crashes Financial Operations page on every render | `FinancialOperationsPage.jsx:170` | Open, uncommitted, not fixed in this audit (see §24 rationale) |
| D-02 | **P1 (integrity)** | Hardcoded fake "integration health" status tiles contradict the mandate's no-fabrication rule and the file's own comment | `ReliabilityLens.jsx:37-59` | Open, pre-existing, unrelated to Phase 4 diff |
| D-03 | **P1 (security hygiene)** | Real test-account credential hardcoded in a git-tracked, currently-modified spec file | `frontend/tests/super-admin-browser-login.spec.ts:6-7` | Open |
| D-04 | **P2** | Two parallel, incompatible frontend HTTP/session-handling implementations | `frontend/src/api/client.js`, `frontend/src/service/api.js` | Open |
| D-05 | **P2** | Capability-based RBAC covers roughly half the super_admin router; sensitive mutations (password/MFA reset, commercial-plan CRUD, org lifecycle transitions) rely only on the coarse floor | `backend/app/modules/super_admin/router.py` (multiple endpoints) | Open |
| D-06 | **P2** | No DB-level backing for "one active JIT grant per admin" or "one published catalog version per plan" | `privileged_access_service.py`, `commercial/models.py` | Open |
| D-07 | **P2** | `PrivilegedTenantAccessGrant` audit trail hard-deleted on org deletion, unlike `PlatformAuditLog` | `organizations/router.py` delete sweep | Open |
| D-08 | **P2** | Live re-run of accessibility audit found 1 serious color-contrast violation on `/super-admin/commercial/invoices`, contradicting prior "0 violations" claims | `docs/a11y-audit-results.json` (this audit's own run) | Open |
| D-09 | **P2** | A confirmed test-account password is preserved in git history via a tracked spec file | same as D-03 | Open (rotation recommended) |
| D-10 | **P3** | Decorative Command Center context-bar selectors (incl. "Reporting Currency") control nothing and imply capabilities the product disclaims | `CommandCenterContextBar.jsx` | Open |
| D-11 | **P3** | Inconsistent MFA requirement across 3 structurally-identical breaker-toggle UIs | `KillSwitchPage.jsx` vs `GovernancePage.jsx`/`ApprovalQueuePage.jsx` | Open |
| D-12 | **P3** | Orphaned breaker with no management UI (`tenant_payment_attempts`) | frontend, no file (absence) | Open |
| D-13 | **P3** | Un-gitignored Playwright artifact directories | `frontend/playwright-report/`, `frontend/test-results/` | Open |
| D-14 | **P3** | Tracked stray file from an accidental pip-install redirect | `backend/=2.9.0` | Open |
| D-15 | **P3** | 34 test files' compiled bytecode present with no corresponding source — unexplained coverage loss | `backend/tests/__pycache__/` | UNKNOWN — needs a direct question to the team |
| D-16 | **P3** | Debug `print()` statements leak internal action/intent detail to stdout, bypassing log redaction | `chatbot/actions/action_engine.py` | Open |
| D-17 | **P3** | Playwright spec loosened to exclude 401/403 from failure counts | `super-admin-browser-login.spec.ts` (uncommitted diff) | Open — review before commit |

---

## 32. Missing / Partial Capabilities

- Integrations & Automation IA group has no dedicated implementation behind any of its 5 documented leaf labels (§10, §14).
- Entitlements are a read-only foundation, explicitly not enforced anywhere (§5, §12).
- Job replay/reprocessing is declared NOT IMPLEMENTED by design in the (uncommitted) Phase 4 planning doc — a defensible, honest deferral, not a gap this audit is flagging as a defect.
- Manual screen-reader validation has never been performed (automated axe-only coverage) — an open acceptance limitation carried across every phase.
- Frontend has zero component/unit test coverage (0 of 187 `.jsx`/`.js` files); `axe-core` is installed as a devDependency but never actually imported/used in either Playwright spec.

---

## 33. External Dependencies

| Dependency | Status |
|---|---|
| Stripe (payment gateway) | Code path fully implemented, real SDK integration (fails closed if unconfigured) — **NOT CONFIGURED** in this environment (env vars empty) |
| SMTP / email | Code path implemented — **CONFIGURED** in local `.env` (host + username both present) |
| Anthropic / AI model gateway | Code path fully implemented (chatbot module) — configuration key **absent from `.env.example` entirely** and not set locally; likely NOT CONFIGURED, and the template gap itself is a hygiene issue |
| Neon Postgres (primary DB) | **CONFIGURED and reachable** — confirmed live via `/health` returning `{"status":"ok","database":"connected"}` during this audit, though initial connection took longer than a brief health-check window allows (worth noting given prior QA reports' documented SSL/DNS-hang issues) |
| Recurring billing / dunning scheduler | Explicitly disabled by default (`ENABLE_RECURRING_BILLING_SCHEDULER=False`), a deliberate opt-in, not a gap |

---

## 34. NOT CONFIGURED / NOT IMPLEMENTED / UNKNOWN Matrix

| Item | Classification | Basis |
|---|---|---|
| Stripe payment gateway | NOT CONFIGURED | Real code, empty env vars |
| Anthropic AI gateway key | NOT CONFIGURED (likely) | Absent from both `.env.example` and local `.env` |
| Job replay/reprocessing engine | NOT IMPLEMENTED BY DESIGN | Explicit declaration in local Phase 4 planning doc; this audit did not evaluate whether that declaration itself is still current, only that no code path exists |
| Commercial (Plane 1) invoices/payments/collections | NOT IMPLEMENTED | Frontend explicitly renders honest "not implemented" panels; no backend model exists |
| Entitlement enforcement | NOT IMPLEMENTED (foundation only) | Explicit in-code docstring |
| `nikhil@zoikogroup.com` live account fields (role/org_id/is_active/is_verified) | UNKNOWN — NOT VERIFIED IN THIS PASS | Read-only code audit did not query the live DB; `/health` confirms DB reachability only |
| Whether the 34-test-file bytecode-without-source (§2.4, D-15) represents lost coverage or intentional consolidation | UNKNOWN | No commit history or documentation explains it |
| Whether the a11y regression found in this audit (D-08) is new or a gap every prior "18/18" claim simply missed | UNKNOWN | No prior report's raw axe output (only summary claims) was available to diff against |
| Whether `billing/`'s breaker call sites actually invoke `require_enabled()` at every documented gate point | NOT INDEPENDENTLY RE-VERIFIED IN THIS PASS | Out of the assigned scope of the research pass that covered breakers; flagged, not assumed |
| Manual screen-reader validation | NOT PERFORMED (any phase) | Open acceptance limitation, carried forward honestly by every prior report |

---

## 35. Standalone Product Readiness (detail)

Restating §25 with the supporting reasoning: the mandate's non-negotiable boundaries (auth boundary, data boundary, domain boundary, API boundary, database scope) were checked and **hold** — a super admin authenticates through the same JWT issuer as everyone else but is checked against a distinct role+org-null invariant, hits a distinct API namespace under `/api/super-admin/*`, and touches database tables that are either super-admin-exclusive or explicitly, deliberately isolated from tenant financial tables (§5, §11). No accidental dependency on an unrelated "Zoiko One" runtime module was found in the code read during this audit.

What does **not** hold is the framing of Super Admin as a "standalone platform" in the deployable-artifact sense: it is one `React Router` branch inside one Vite app that also bundles the tenant billing product, the org-admin console, and the AI assistant, built and presumably deployed together as one unit. Whichever meaning of "standalone" the original mandate intended should be stated explicitly going forward, because the two meanings (security/data isolation vs. independent deployability) have very different implications for what "Phase 4" should even be scoped to build.

---

## 36. Architecture Risks

Consolidated in §26.

---

## 37. Required Cleanup Before Next Phase

See §29 (verdict) for the authoritative, categorized list. In one line: fix the `isMulti` crash and the fabricated `ReliabilityLens` tiles, resolve the documentation-versioning gap, and get a human decision on the in-flight Phase 4 diff, before touching anything else.

---

## 38. Recommended Next Phase Prerequisites

See §29.

---

## 39. Final Architecture Verdict

# C — CONDITIONALLY READY

The committed Phase 1–3 baseline (`23f54e3`) is a defensible, well-tested foundation: strong FK/tenant-isolation discipline, genuinely honest UNKNOWN/VERIFIED/FAILED state machines where they matter most (financial consistency, MRR), real server-side enforcement of JIT access, MFA step-up, and maker-checker self-approval rejection, and a passing test suite (703 passed / 1 skipped / 0 failed as independently re-run during this audit).

It is not, however, a codebase that should proceed straight into a new phase today, for three independent reasons, each sufficient on its own:

1. **The working tree is not in a committable state.** It contains a render-crashing bug and a genuine accessibility regression, both inside in-progress Phase 4 work that was never supposed to have started under this audit's own instruction.
2. **The documentation this audit (and presumably any future phase) is meant to be governed by does not durably exist.** It lives on one machine's disk, outside git, in a state that already contains internal contradictions across same-day QA reports.
3. **A real, if less dramatic, list of architectural inconsistencies** (half-migrated capability RBAC, two incompatible frontend session layers, a hardcoded fake-integration panel, two unenforced application-level uniqueness invariants) represents accumulated technical debt that a new phase would otherwise build on top of, compounding it further.

None of these are fabricated or exaggerated to force a conservative verdict — each is backed by the file:line evidence in the sections above, gathered by direct code reading and, where possible, by actually re-running the test/build/health/accessibility checks rather than trusting prior claims. Equally, none of them are so severe as to warrant "NOT READY" — the core engineering is sound, and every item on the required-cleanup list below is bounded and concrete, not open-ended.

**MUST FIX BEFORE NEXT PHASE:**
- Fix `FinancialOperationsPage.jsx:170` (`isMulti` undefined) — one-line, bounded.
- Fix or explain the color-contrast violation on `/super-admin/commercial/invoices` found by this audit's live a11y re-run.
- Get an explicit human decision on the uncommitted Phase 4 diff: finish it (fix the above two items and commit), pause it for review, or revert it. Do not leave it in limbo.
- Fix the hardcoded fake "integration health" tiles in `ReliabilityLens.jsx` (independent of the Phase 4 decision — this predates it).
- Review (do not simply accept) the loosening of the Playwright spec's 401/403 failure-count exclusion before it is committed.

**SHOULD FIX BEFORE NEXT PHASE:**
- Commit the currently-untracked authoritative documentation (or explicitly decide it should not be committed and say why) — a phase built on documentation only one machine can see is not durably governed.
- Reconcile or explicitly retire the contradictory same-day QA reports (§28) rather than letting all three stand as if consistent.
- Rotate the hardcoded test credential in `super-admin-browser-login.spec.ts` and move it to an environment variable.
- Close the two DB-level uniqueness gaps (JIT grant, published plan version) with either a partial unique index or explicit row-locking.
- Decide whether `PrivilegedTenantAccessGrant` should survive organization deletion, matching `PlatformAuditLog`'s treatment.

**CAN DEFER:**
- Consolidating the two parallel frontend HTTP/session layers.
- Completing the capability-RBAC migration for the remaining ~40 endpoints.
- Deduplicating the Financial Operations / Integrations & Automation IA groups' aliased pages into genuinely distinct workspaces, or formally descoping them in the IA document.
- Cleaning up the stray `backend/=2.9.0` file and gitignoring the Playwright artifact directories.

**DOCUMENTATION-ONLY:**
- Clarify what "standalone" is meant to guarantee (§35).
- Investigate and document what happened to the 34 test files whose bytecode survives without source (§2.4, D-15).

**EXTERNAL DEPENDENCY:**
- Stripe and (likely) the Anthropic AI gateway remain NOT CONFIGURED in this environment — no action item, just an honest status.

**NOT CONFIGURED / NOT IMPLEMENTED BY DESIGN:**
- See §34 in full.

**Do not start Phase 4 planning until the "MUST FIX" list above is resolved and the human decision on the in-flight diff is made.**
