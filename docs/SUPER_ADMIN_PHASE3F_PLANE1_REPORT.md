# Phase 3F — Plane 1 SaaS Administration: Implementation Report

Generated: 2026-08-22. Implements items **F4, F5, F7, F8, F10, F11 (surface)**
of the agreed 3F scope in `SUPER_ADMIN_PHASE3_GAP_ANALYSIS.md` §3F, plus the
honesty remediation of the fabricated figures on `CommercialLens.jsx`.

---

## 1. What was built

### F5 — Subscription plan change (upgrade/downgrade)

**Backend** — `commercial/service.py :: CommercialSubscriptionService.change_plan()`
+ `POST /api/super-admin/commercial-subscriptions/{id}/change-plan`
(`CommercialSubscriptionPlanChange`: `new_plan_id`, mandatory `reason ≥3 chars`).

Semantics (gap analysis: "new subscription replacing prior (history preserved),
audited; reuse existing transitions"):

1. Only OPEN subscriptions may change plan; terminal rows are immutable history.
2. The current subscription is CANCELLED **through the state machine** — never
   mutated in place.
3. A replacement is created on the target plan. If the previous subscription
   was ACTIVE, the replacement activates immediately in the same transaction,
   re-running every real-charging guard (`can_charge` / COM-04 double-charge
   prevention + plan-ACTIVE check). All preconditions are validated **before**
   any mutation (fail fast), and re-checked by the state machine afterwards
   (defense in depth). Any other previous status yields a PENDING replacement.
4. Both audit trails are written on the caller's transaction:
   - `platform_audit_logs` with actor/role/reason/correlation id (`pc-{hex12}`)
     and `change_type=PLAN_CHANGE`;
   - org-scoped `billing_audit_logs` referencing the replacement row.

Rejected cases (400): missing reason, no-op (same plan), archived target,
terminal source, ACTIVE→non-ACTIVE plan, charging-guard failure.

### F10 — Honest SaaS reporting read model

**Backend** — new `super_admin/saas_reporting_service.py` +
`GET /api/super-admin/commercial-reporting` → `SaasReportingResponse`.

- Account/subscription counts are real grouped row counts.
- MRR is computed ONLY from open subscriptions whose own `catalog_version_id`
  points at a PUBLISHED version with non-null `price_amount`; annual prices are
  normalized ÷12; unknown intervals are skipped (never guessed).
- Coverage is always reported (`open_subscriptions_total`,
  `open_subscriptions_priced`, `plans_with_published_price`) alongside any figure.
- Zero priced catalogue ⇒ `state="unknown"`, amount NULL — mirrors COM-01;
  never zero, never fabricated.
- Mixed currencies ⇒ `state="multi_currency"`, per-currency breakdown only.

### F4 — Offers & Trials honesty

No trial/offer model exists in the schema (COM-02). The Plans page ("Plans,
Offers & Trials") now renders an explicit **NOT CONFIGURED** declaration panel.
No placeholder programs are rendered anywhere.

### F7/F8 — SaaS Invoices / Payments / Collections honesty

New dedicated Plane 1 billing page `Plane1BillingPage.jsx` at
`/super-admin/commercial/invoices` (replaces the PlatformDashboardPage
placeholder for that route):

- SaaS Reporting section (F10 read model): stat cards, MRR basis line,
  per-status count tables, open-by-plan table, honesty notes.
- Three explicit NOT IMPLEMENTED panels for invoices / payments / collections
  referencing acceptance items PAY-01 / PAY-02 / REC-01. No fabricated rows or
  amounts can appear here because there is no backing model at all.

### Honesty remediation — CommercialLens (Platform Dashboard)

The lens previously **fabricated** MRR as `$100 × activeSubs.length` and a
"100.0%" collections rate. It now consumes the real reporting endpoint:
MRR shows the computed figure, UNKNOWN, or a multi-currency indicator;
C4 shows UNKNOWN with the REC-01 pointer until a payments engine exists.

### Latent bug fixed en route

`_version_snapshot()` emitted raw `Decimal`/`date` values into the JSON column
`approval_requests.proposed_state`. Publishing a priced catalog version (the
exact path MRR depends on) crashed with "Object of type Decimal is not JSON
serializable". The snapshot is now JSON-safe. No prior test exercised priced
version publication end-to-end; `test_phase3f_saas_plane1.py` now does.

### F1/F2 labels

Plane 1 markers added to the Subscriptions and Plans page descriptions
("PLANE 1 · Zoiko→Tenant …") to remove Plane 1/Plane 2 ambiguity.

---

## 2. Files changed

| Layer | File | Change |
|---|---|---|
| Backend | `app/modules/commercial/service.py` | `change_plan()` (+fail-fast guards); JSON-safe `_version_snapshot()` |
| Backend | `app/modules/commercial/schemas.py` | `CommercialSubscriptionPlanChange` |
| Backend | `app/modules/super_admin/saas_reporting_service.py` | NEW — honest read model |
| Backend | `app/modules/super_admin/schemas.py` | Saas* response schemas |
| Backend | `app/modules/super_admin/router.py` | `change-plan` + `commercial-reporting` endpoints |
| Backend | `tests/test_phase3f_saas_plane1.py` | NEW — 15 tests |
| Frontend | `src/service/commercialService.js` | `changeCommercialSubscriptionPlan`, `getSaasCommercialReporting` |
| Frontend | `src/modules/super-admin/SubscriptionsPage.jsx` | Plan-change modal + row action |
| Frontend | `src/modules/super-admin/Plane1BillingPage.jsx` | NEW — reporting + honest panels |
| Frontend | `src/modules/super-admin/lenses/CommercialLens.jsx` | Fabricated MRR/collections replaced with real read model |
| Frontend | `src/modules/super-admin/PlansPage.jsx` | Trials NOT CONFIGURED panel |
| Frontend | `src/App.jsx` | `/super-admin/commercial/invoices` → Plane1BillingPage |

## 3. Verification evidence

- `pytest -q` (full suite): **354 passed** (339 prior + 15 new), 0 failures.
- `npx vite build`: green.
- New tests cover: supersede-with-history (ACTIVE & PENDING), no-op/archived/
  terminal/missing-reason rejections, fail-fast before mutation, both audit
  trails with correlation id, empty-DB UNKNOWN MRR, priced/unpriced exclusion,
  annual÷12 normalization, multi-currency behavior, response-schema parity.

## 4. Standing honest non-goals (unchanged)

- No Plane 1 payment processing; invoice/payment/collections surfaces render
  explicit NOT IMPLEMENTED states (PAY-01/PAY-02/REC-01 remain declared FAIL).
- No trials/offers model (COM-02 stands).
- No bank/processor reconciliation (ISS-017 stands).
