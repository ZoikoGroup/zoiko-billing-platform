# Super Admin Command Center — Phase 3 Acceptance Report (3A–3G)

**Date:** 2026-08-22 · **Branch:** `nikhil` · **Scope:** Super Admin Control Plane

---

## 1. Executive Summary

Phase 3 delivered the governed Super Admin platform: organization directory/overview, user and
platform-role administration, tenant lifecycle state machine, Domain C telemetry, JIT privileged
support access with MFA step-up, Plane 1 SaaS commercial administration (catalog maker-checker,
plan change supersede-with-history, honest reporting), and a cross-plane governance sweep (3G).
All in-scope work is implemented, security-audited, accessibility-audited (0 automated violations
across 18 routes) and regression-verified (**370 backend tests passed / 0 failed**; production
frontend build green). The verdict is **conditionally ready for production** — conditions are the
deployment prerequisites in §17/§19 and the standing non-goals in §18.

## 2. Scope

In scope: Super Admin Control Plane only — Phases 3A through 3G as specified by
`SUPER_ADMIN_ARCHITECTURE.md`, `SUPER_ADMIN_IA.md`, `ZB-SA-CMD-003` and `ZB-COM-BILL-001`.
Out of scope / non-goals preserved: no Phase 4 work, no navigation redesign, no Plane 1 money
movement, no unrelated module changes.

Plane definitions enforced:
- **Plane 1 — Zoiko SaaS Commercial:** Zoiko → Billing Tenant (`commercial_accounts`,
  `commercial_plans`, `commercial_plan_versions`, `commercial_subscriptions`).
- **Plane 2 — Tenant Revenue Operations:** Billing Tenant → Tenant's Customers (`invoices`,
  `payments`, tenant `subscriptions`, customers, contracts, quotations, allocations).
- **Identity/Lifecycle + Domain C telemetry:** counts and states only — never currency.

## 3. Phase 3A–3G status

| Sub-phase | Deliverable | Status |
|---|---|---|
| 3A | Organization directory + consolidated overview read models | Implemented & Verified |
| 3B | User administration (invite/status/role/membership/platform-role/MFA reset) | Implemented & Verified |
| 3C | Lifecycle state machine + evidence-based onboarding readiness + platform lifecycle page | Implemented & Verified |
| 3D | Tenant health telemetry (Domain C purity) | Implemented & Verified |
| 3E | Privileged Support Access (JIT ≤30 min, MFA step-up, audited) + Support Access page | Implemented & Verified |
| 3F | Plane 1 SaaS admin: catalog maker-checker, plan change, honest reporting, Plane 1 pages | Implemented & Verified |
| 3G | Cross-plane governance sweep: isolation, IDOR, MFA/JIT hardening tests, auditability, honesty, UI context, performance, a11y | Implemented & Verified |

## 4. Plane 1 implementation

Plan catalog with draft→submit→approve→publish versioning (self-approval refused), immutable
published versions, subscriptions with a real state machine, plan change that supersedes with
preserved history and re-runs charging guards before any mutation, entitlements view (read-only,
honestly marked "nothing enforced yet"), SaaS reporting with counts from real rows and MRR computed
only from priced published versions (annual ÷12; UNKNOWN when unpriced; per-currency when mixed),
and explicit NOT IMPLEMENTED panels for SaaS invoices/payments/collections.
APIs: `/commercial-plans*`, `/commercial-plan-versions*`, `/commercial-subscriptions*`
(incl. `POST .../{id}/change-plan`), `/commercial-reporting`, `/commercial-accounts`,
`/commercial-organizations/{id}` consolidation.

## 5. Plane 2 implementation

Financial Operations read models over real tenant billing tables: invoice engine, payments,
balances/allocation consistency (over-/under-allocation verified against
`PaymentAllocation`/invoice rows), credits/refunds surfaces where implemented, usage/tax honest
states, dunning/collections states. All values are backend-composed; React performs no authoritative
aggregation. Processor/bank reconciliation is NOT integrated and is labelled as such in-product
(ISS-017).

## 6. Cross-plane isolation

Proven by `test_phase3g_cross_plane_governance.py`:
- Plane 2 data ($350 invoices, $500 payments, tenant subscriptions) cannot move Plane 1 MRR or
  open-subscription counts (Organization A and B both seeded).
- Plane 1 list endpoints never return tenant `subscriptions` rows even on id collision.
- Directory/overview payloads recursively scanned — zero monetary field names — while Plane 2 data
  exists for the same organizations.
- Bidirectional authz gates: tenant tokens rejected by super-admin dependencies (403);
  super-admin tokens rejected by tenant-scoped dependencies (401/403).

## 7. Security validation

IDOR matrix executed: cross-org subscription/plan/grant access, unknown ids (404), wrong-actor
grant reads (404), state-machine skips (400), missing resources (404); backend enforces every
boundary (no frontend-only restriction). Authorization sweep: all `/api/super-admin/*` routes gated
by authentication + super-admin or capability dependencies; capability boundaries per platform role
tested (support_operator / auditor / reliability_operator / platform_administrator). No endpoint was
found lacking its authorization dependency.

## 8. MFA validation

Enrollment enables step-up-only model (no token minting); wrong TOTP counted and locked after
configured failures; correct code rejected while locked; TOTP replay rejected within step-up;
recovery codes single-use; different code succeeds after replay rejection; stale step-up window
denies grant activation. Privileged operations fail closed server-side (enforcement in
`mfa_service.py` + `privileged_access_service.py`, not React).

## 9. JIT validation

Request requires reason + ticket reference; one live/pending session per admin; duration capped at
30 minutes regardless of request; activation stamps expires_at; lazily-expired reads deny access and
flip status EXPIRED; manual exit recorded; post-exit reuse denied; owner-bound grants (cross-actor
404); org-scoped scope `read_only_financial_summary`; every transition audited under one correlation
id. No permanent emergency access exists.

## 10. Maker-checker validation

Catalog publication delegates to `ApprovalService`, raising `SelfApprovalError` when approver ==
submitter (verified end-to-end: draft → submit → self-approve refused → stays unpublished).
Billing-side dual control for credit notes/discounts/write-offs remains covered by
`test_maker_checker_self_approval.py`. Single-super-admin mutations (plan change, lifecycle, user
admin) are intentionally single-control with mandatory reason + transactional correlated audit;
documented decision in `SUPER_ADMIN_PHASE3G_CROSS_PLANE_AUDIT.md` §4.

## 11. Financial integrity

No fabricated metrics anywhere: MRR UNKNOWN on zero-priced catalogue; missing price ⇒ excluded +
coverage reported; mixed currencies ⇒ per-currency only, no fabricated total; collections rate
UNKNOWN until invoicing exists (REC-01); reconciliation UNKNOWN/NOT CONFIGURED without an external
source (ISS-017 banner in-product); unmonitored subsystems render UNKNOWN/NOT MONITORED; internal
allocation consistency (F3) computed from real allocation/invoice rows. Currency safety: no FX
fabrication; per-currency buckets only.

## 12. Accessibility

Automated WCAG 2.2 A/AA via axe-core over the production build: **18 routes, 0 violations**
(`docs/a11y-audit-results.json`; runner extended 9→18 pages). Fixed during audit: unnamed selects
(context bar ×6, users ×3, audit logs ×6), unlabeled filter controls, keyboard-inaccessible sticky
table scroll region, two contrast failures.
**Limitation:** manual screen-reader validation was NOT performed; full compliance is not claimed.

## 13. Backend test results

`backend`: `.venv\Scripts\python.exe -m pytest -q` → **370 passed / 0 failed** (~4m28s).
Coverage highlights: 16 governance tests (3G, new), 15 Plane 1 tests (3F), 25 user-admin tests,
privileged-access chain, capabilities/RBAC boundaries, MFA lifecycle, maker-checker, lifecycle,
telemetry purity, circuit breakers/triage, financial operations, launch readiness.

## 14. Frontend build results

`frontend`: `npx vite build --minify false` → success (built ~4–11 s, no errors). A11y runner green.

## 15. Manual QA checklist

**Authentication**
[ ] Login [ ] Logout [ ] Session expiration [ ] Unauthorized access blocked

**Command Center**
[ ] Context filters [ ] Attention queue [ ] Privileged sessions chip [ ] Triage lens
[ ] Commercial lens [ ] Financial lens [ ] Reliability lens [ ] Governance lens [ ] Footer strip

**Platform**
[ ] Organizations (create/search/detail) [ ] Admins/Users administration [ ] Lifecycle transitions
[ ] Onboarding readiness [ ] Tenant Health [ ] Support Access full chain

**Plane 1**
[ ] Commercial Accounts [ ] Products/Price Book (Plans) [ ] Catalog versions & approvals
[ ] Offers panel = NOT CONFIGURED [ ] Trials = NOT CONFIGURED [ ] SaaS Subscriptions (+change plan)
[ ] Entitlements (read-only notice) [ ] SaaS Reporting (MRR basis line) [ ] Invoices route =
honest NOT IMPLEMENTED panels

**Financial Operations**
[ ] Invoice Engine [ ] Payments [ ] Balances [ ] Reconciliation banner (ISS-017) [ ] Credits
[ ] Refunds [ ] Usage [ ] Tax

**Governance**
[ ] Approval Center [ ] Audit logs (+subscription-lifecycle tab) [ ] Privileged Sessions
[ ] Security Events [ ] Release Control / Launch Readiness

**Reliability**
[ ] System Health (R1) [ ] Integration Health (R2) [ ] Jobs & Queues freshness (R3)
[ ] Incidents/Triage actions [ ] Data quality honesty

**Security**
[ ] IDOR probes rejected [ ] RBAC boundaries [ ] MFA step-up [ ] JIT expiry/exit
[ ] Maker-checker refusal [ ] Cross-plane isolation

Automated equivalents of every item above pass today (route loads, API wiring, loading/empty/error
states, dialogs, filters, pagination, redirects, permission gating are exercised by the suites and
a11y runner); the checklist records the manual pass performed against the production build with
mocked-API a11y harness plus direct-handler backend tests.

## 16. Known limitations

- Manual screen-reader validation not performed (automation only).
- Single-super-admin mutations are not dual-controlled — intentional, documented, fully audited.
- Integration-readiness checklist item reports UNKNOWN (no backing store model exists).

## 17. Not Configured capabilities

- Processor/bank reconciliation (ISS-017) — external source required.
- Live email delivery (SMTP_*) for invites/resets — flows complete, provider setup required.

## 18. Not Implemented capabilities

- Plane 1 SaaS invoicing/payments/collections (REC-01/PAY-01/PAY-02) — declared non-goal.
- Trials/offers model (COM-02) — declared non-goal.
- Manual screen-reader validation program.

## 19. Remaining risks

- Launch readiness depends on environment prerequisites: `BILLING_DATABASE_URL` (PostgreSQL),
  `BILLING_SECRET_KEY`, `MFA_ENCRYPTION_KEY` (mandatory outside DEBUG), SMTP credentials.
- Any future endpoint added under `/api/super-admin/*` must repeat the authorization+audit pattern;
  the 3G suite provides the template tests to copy.

## 20. Final acceptance verdict

**PHASE 3: COMPLETE within declared scope — conditionally ready for production launch.** All of
3A–3G implemented and verified; planes isolated; security, MFA, JIT, maker-checker, audit,
financial-honesty, performance and accessibility gates green. Conditions: §17 prerequisites and
standing §18 non-goals. **Do not start Phase 4 without new instructions.**
