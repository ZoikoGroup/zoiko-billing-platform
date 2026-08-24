# Super Admin Command Center — Phase 3G Cross-Plane Governance Audit

**Status:** COMPLETE — all audits executed, all findings either already safe or fixed and re-verified
**Date:** 2026-08-22
**Scope:** Cross-plane isolation, IDOR/privilege escalation, maker-checker, auditability,
financial honesty, UI plane context, Support Access workflow, accessibility, performance.
**New regression evidence:** `backend/tests/test_phase3g_cross_plane_governance.py` — 16 tests.

---

## 1. Plane definitions (explicit, as enforced by code and tests)

| Plane | Domain | Tables / sources | Super Admin access model |
|---|---|---|---|
| **Plane 1 — SaaS administration** | Domain A (commercial) | `commercial_accounts`, `commercial_plans`, `commercial_plan_versions`, `commercial_subscriptions` | Direct super-admin endpoints (gated by `get_current_super_admin`) |
| **Plane 2 — Tenant revenue operations** | Domain B (billing) | `invoices`, `payments`, `subscriptions` (tenant), `customers`, `contracts`, `quotations` | Capability-gated Financial Operations endpoints; tenant billing detail additionally behind JIT privileged-access grants |
| **Identity / lifecycle plane** | Tenants | `organizations`, `users` | Directory/overview/user-admin endpoints; identity + counts only |
| **Domain C — Telemetry** | Platform health | attention items, job freshness, lifecycle states | Counts and states ONLY; never currency |

Enforcement primitives verified this phase:
- `get_current_super_admin` (app/core/dependencies.py:104) rejects non-super-admin actors AND super
  admins that carry an organization scope (no hybrid tokens).
- `get_organization_id` (app/core/dependencies.py:156) rejects super_admin tokens in the opposite
  direction — a super-admin token cannot be used as a tenant-scoped credential.
- Tenant billing detail (`get_tenant_summary`) requires a live JIT grant with completed MFA step-up.

## 2. Isolation verification (both directions)

New tests (`test_phase3g_cross_plane_governance.py`):

| Test | Direction | Result |
|---|---|---|
| `test_plane2_data_cannot_move_plane1_numbers` | Plane 2 → Plane 1 | PASS — invoices ($350), payments ($500) and tenant subscriptions seeded against the same organizations leave SaaS MRR exactly at the priced-catalogue value (50.00) and open-subscription count unchanged |
| `test_plane1_subscription_list_excludes_tenant_subscriptions` | leakage probe | PASS — `/commercial-subscriptions` returns exactly its own row even when a same-id tenant `subscriptions` row exists |
| `test_directory_payload_is_identity_and_counts_only` | Plane 1/2 → identity plane | PASS — directory + overview payloads recursively scanned: zero monetary field names (`amount/mrr/revenue/price/paid/balance_due/total_due/cost`) even with invoice/payment data present |

Existing coverage retained: telemetry non-financial assertions, reporting honesty rules
(`test_phase3f_saas_plane1.py`).

## 3. IDOR / privilege escalation probes

| Probe | Expected | Result |
|---|---|---|
| ORG_ADMIN token → any `get_current_super_admin` endpoint (incl. change-plan, reporting) | 403 | PASS (`test_tenant_actor_rejected_by_super_admin_gate`) |
| super_admin token → tenant-scoped dependency | 401/403 | PASS (`test_super_admin_rejected_by_tenant_scope_dependency`) |
| change-plan with unknown subscription id | 404 | PASS (`test_change_plan_idor_guards`) |
| change-plan with unknown target plan id | 404 | PASS (same test) |
| Lifecycle transition without reason | 400 | PASS (`test_lifecycle_transition_guardrails`) |
| Lifecycle transition ACTIVE→DEACTIVATED (state-machine skip) | 400 | PASS (same test) |
| Grant request with `requested_minutes=9999` | capped to 30 | PASS (`test_grant_duration_capped_at_thirty_minutes`) |
| Re-activate EXITED grant | 400 | PASS (`test_exited_grant_cannot_be_reactivated`) |
| Read tenant summary after mid-session expiry | 403, grant → EXPIRED | PASS (`test_mid_session_expiry_blocks_summary_read`) |
| Activate grant while MFA account is locked | 401 + `PRIVILEGED_ACCESS_STEP_UP_FAILED` audit row | PASS (`test_mfa_locked_admin_cannot_activate_grant`) |

Pre-existing suites continue to cover: duplicate live grant rejection, cross-actor grant access
(404), wrong TOTP, stale step-up window, post-exit access denial, platform-role self-service
escalation refusal, capability boundaries per platform role.

## 4. Maker-checker audit

**Where it is enforced:** catalog publication. `CommercialPlanVersionService.approve_and_publish`
delegates to `ApprovalService.approve`, which raises `SelfApprovalError`
(app/modules/super_admin/approval_service.py:32) when approver == submitter.
Verified end-to-end by `test_catalog_publish_refuses_self_approval` (draft → submit as user 42 →
approve as user 42 refused; version stays unpublished).

**Single-super-admin mutations that are intentionally NOT maker-checker** (documented design, not a gap):
plan change, lifecycle transitions, user administration. Rationale: each writes an immutable,
reason-mandated, correlated audit record transactionally with the mutation, and destructive/
financial-grade actions are additionally fenced (charging guards on plan change; access-blocking
side effects on lifecycle). The privileged-support path substitutes a second-person control of a
different kind: MFA step-up plus a ticket reference before any tenant data can be read.
Billing-side maker-checker for credit notes/discounts/write-offs remains covered by
`tests/test_maker_checker_self_approval.py`.

## 5. Auditability audit

- **Transactional integrity:** every platform/billing/lifecycle audit write uses `log_no_commit`,
  so the audit row persists if-and-only-if the mutation commits. No orphaned entries possible.
- **Correlation:** plan change emits one `pc-*` correlation id shared by the platform trail
  (old/new values incl. `replaced_by_subscription_id`) and the org-scoped billing trail
  (`changes.correlation_id`). Verified by `test_change_plan_writes_correlated_audit_without_secrets`.
- **No secrets:** all rows written during invite + plan-change flows scanned for
  `password / token_urlsafe / secret_encrypted / hashed_password` and for the live invite link —
  zero hits (`test_invite_audit_trail_never_carries_tokens_or_links`,
  `test_change_plan_writes_correlated_audit_without_secrets`). The invite link exists only in the
  email path (monkeypatched capture in tests); audit payloads store email/role/org/send_invite only.
- **Reason mandate:** lifecycle transitions and user admin refuse empty reasons; grant requests
  require reason + ticket reference.
- Application logs for grant events include grant id / org / actor email only — no codes, tokens
  or recovery material.

## 6. Financial honesty audit

- Backend-composed read models only; the React layer performs no aggregation or derivation.
- MRR computed exclusively from PUBLISHED catalog versions with a non-null `price_amount`;
  annual normalized ÷12; unpriced ⇒ `state="unknown"`, never zero; mixed currencies ⇒
  `multi_currency` with no fabricated single total (covered in 3F suite, still green).
- Coverage metrics always reported beside computed figures.
- Financial Operations page states plainly that processor reconciliation is "Not integrated
  (ISS-017)" rather than implying coverage.
- Plane 1 invoicing/payments surfaces are explicit NOT IMPLEMENTED panels (REC-01/PAY-01/PAY-02),
  not placeholders pretending to work.

## 7. UI plane context

Every ambiguous page now names its plane:

| Page | Marker |
|---|---|
| SubscriptionsPage | "PLANE 1 · ZoikoTenant SaaS subscriptions …" (pre-existing) |
| Plane1BillingPage | title + "PLANE 1 · … money surfaces" (pre-existing) |
| PlansPage / Catalog Versions | "PLANE 1 · SaaS catalog governance …" (versions updated this phase) |
| EntitlementsPage | "PLANE 1 · Read-only entitlement view …" (added this phase) |
| FinancialOperationsPage | "Plane 2 tenant revenue operations …" (pre-existing) |
| Organizations / Lifecycle / Tenant Health | render backend-supplied `plane: TENANT/PLATFORM` meta |

No navigation redesign was performed (per scope constraints).

## 8. Support Access workflow verification

Full chain exercised across existing + new tests:
request (reason+ticket mandatory, one live session per admin, duration ≤30 min) →
MFA step-up (TOTP; recovery codes single-use; replay rejected; lockout after configured
failures) → activate (expires_at stamped) → narrow read (`get_tenant_summary`, read-only
financial summary scope) → exit (post-exit reads denied). Failure paths verified: wrong TOTP,
stale step-up window, expired grant reuse, locked account, reactivation of exited grant,
mid-session expiry. Every state change lands in the platform audit trail under one correlation id.

## 9. Accessibility audit

- Tool: Playwright + axe-core against the PRODUCTION BUILD (`scripts/a11y-audit.mjs`).
- Coverage extended this phase from 9 to **18 routes**, including all new Phase 3 pages
  (organizations, users, platform lifecycle, plans, subscriptions, entitlements, plane-1 billing,
  financial operations, audit logs).
- Result: **0 violations on all 18 pages** (WCAG 2.2 A/2.2 AA tags; results in
  `docs/a11y-audit-results.json`).
- Violations found and fixed during this audit:
  1. Dashboard context bar: 6 `<select>`s without accessible names → aria-labels added.
  2. Audit Logs: filter inputs/selects without programmatic labels → id/htmlFor wiring on both filter blocks.
  3. Users: role/status/platform-role selects unnamed → aria-labels; phantom pagination row when `total` missing → `?? 0` fallback.
  4. Organizations: sticky-header table scroll region not keyboard-reachable → `role=region` + `tabIndex=0` + label on DataTable (shared component).
  5. Contrast: honesty notes slate-500→600 (Plane 1 Billing); "Not integrated" amber-600→700 (Financial Operations).
- **Limitation:** automated axe validation only. Manual screen-reader (NVDA/JAWS/VoiceOver)
  walkthrough has NOT been performed and remains an open acceptance item.

## 10. Performance

- Fixed a real N+1 in the organization directory: `_directory_item` previously issued per-org
  queries for commercial account + active subscription + plan. Now batched via
  `OrganizationDirectoryService._commercial_map` (2 queries per page regardless of page size;
  plan preloaded with `joinedload`; overview path keeps direct lookups).
- New query-count guards (statement-count instrumentation on SQLite):
  - `test_directory_query_count_independent_of_page_size`: ≤12 SELECTs per page and identical
    count for limit=5 vs limit=50.
  - `test_reporting_query_count_constant_as_data_grows`: SaaS reporting issues the same number of
    SELECTs on an empty database as with 12 orgs/plans/subscriptions of Plane 1+2 data.
- No frontend aggregation exists to move client-side (read models are server-composed);
  lists remain paginated server-side (skip/limit caps enforced by FastAPI Query bounds).

## 11. Regression evidence

| Command | Result |
|---|---|
| `backend: .venv\Scripts\python.exe -m pytest -q` | **370 passed** (354 pre-existing + 16 new), ~4m28s |
| `frontend: npx vite build --minify false` | success, built in ~4–11 s |
| `frontend: node scripts\a11y-audit.mjs` | 18 pages, 0 violation rules |

No existing test was weakened or deleted to achieve these results.

## 12. Honest limitations / unknowns

- Processor/bank reconciliation (ISS-017): NOT integrated — stated in-product, unchanged here.
- Plane 1 invoicing/payments/collections: intentionally NOT IMPLEMENTED (REC-01/PAY-01/PAY-02).
- Manual screen-reader validation: NOT PERFORMED (automation only).
- Maker-checker on single-admin platform mutations: intentionally absent by documented design
  (see §4); revisit if organizational policy later requires dual control there.
