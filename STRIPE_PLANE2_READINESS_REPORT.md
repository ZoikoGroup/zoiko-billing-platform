# Stripe Plane 2 — Post-Implementation Readiness Report

**Date:** 2026-08-24
**Scope:** Plane 2 only (tenant revenue operations, `app/modules/billing`). Plane 1 / Super Admin explicitly untouched (§21).
**Method:** Independent source-code inspection (not a restatement of the implementation report), live execution of the 41-test suite, git state review, repository-wide secret scan, and comparison of every Stripe-touching code path against **current official Stripe documentation** (docs.stripe.com, retrieved 2026-08-24).
**Companion artifacts:** `docs/STRIPE_PLANE2_REAL_STRIPE_TEST_PLAN.md` (new), `docs/STRIPE_PLANE2_AUDIT_PHASE1.md` (prior audit), `STRIPE_PLANE2_IMPLEMENTATION_REPORT.md` (previous phase claims).

---

## 1. Executive Summary

The previous phase delivered a genuinely solid **money-movement core**: webhook signature verification against the raw body, an event-id idempotency ledger, `SELECT FOR UPDATE` allocation locking, a shared refund-reversal routine used by both webhook and internal approval paths, dispute upsert handlers, currency fail-fast validation, and consistent server-derived tenant scoping. The claimed 41/41 test result was **independently re-executed and confirmed (41 passed in 12.14 s)**.

However, verification found one finding that blocks the stated architecture from being true end-to-end, plus a cluster of material gaps:

- **GAP‑1 (CRITICAL): No Stripe API call ever carries the connected account.** `stripe_account=`/`Stripe-Account` appears only in comments/docstrings. Checkout Sessions, PaymentIntents, Customers, Subscriptions, and Refunds all execute on the **platform’s own Stripe account**. Onboarding/status tracking for tenant Connect accounts is implemented; actually routing tenant money through those accounts is not.
- Real-Stripe validation has never been attempted (no credentials configured anywhere in the repo — `.env` STRIPE values are empty). Everything below is therefore mock/SQLite-level assurance only.
- Webhook endpoint returns HTTP 200 even when processing fails → Stripe will never retry failed *processing* (only undelivered events), so failed handler runs require manual replay tooling that doesn’t exist yet.
- OAuth uses Stripe’s legacy flow (still functional, deprecated for new platforms in favor of Account Links); `state` is accepted but never validated (CSRF gap); `account.updated` is not handled; `StripeEvent` enrichment columns exist but are never populated.
- Frontend has **zero** Connect UI; embedded card form remains a static mockup; reconciliation does not exist.

**Bottom line:** CODE = PARTIALLY READY · REAL STRIPE VALIDATION = BLOCKED pending test-environment access (§17–18) · Production = NOT READY (Test Mode only, §20).

---

## 2. Previous Implementation Verification (Claim-by-Claim)

Classification: VERIFIED / PARTIALLY VERIFIED / NOT VERIFIED / BROKEN / BLOCKED.

| # | Claim | Class | Evidence |
|---|---|---|---|
| 1 | `StripeConnectedAccount` model | **VERIFIED** | `models.py:3275–3324`. FK org RESTRICT; unique `(organization_id, provider, environment)`; unique global `connected_account_id`; capabilities/requirements JSON; env enum; timestamps |
| 2 | `StripeConnectService` | **VERIFIED** | `stripe_connect_service.py` — onboarding URL builder, `complete_oauth` (OAuth.token → Account.retrieve → persist/sync), `sync_status`, `disconnect`, safe status dict (no secrets) |
| 3 | Connect router | **VERIFIED** (untested) | `routers/stripe_connect_router.py`: `/status /onboarding-url /callback /sync /disconnect`; all gated `get_current_billing_admin`; mounted at `router.py:59`. Zero automated tests hit this router |
| 4 | OAuth flow | **PARTIALLY VERIFIED** | Code follows legacy docs (`connect.stripe.com/oauth/authorize` + `OAuth.token`); BUT: (a) Stripe now recommends Account Links for new platforms; (b) `state` optional & never validated server-side → CSRF; (c) no `livemode` cross-check of token response vs environment |
| 5 | Account status sync | **VERIFIED** (pull only) | `sync_status()` refetches Account and remaps via `_derive_status`. No push path: `account.updated` absent from `_handlers()` map |
| 6 | Disconnect | **VERIFIED** | Local-only DISCONNECTED transition, documented decision not to deauthorize |
| 7 | Payment idempotency | **VERIFIED (app-level)** | `payment_service.record_payment:147–198` — key lookup + unique `(organization_id, transaction_id)` race backstop. NOT applied to outbound Stripe API calls (see §4, ID-2) |
| 8 | Refund idempotency | **VERIFIED (app-level)** | `refund_service.create_refund:151–156` key replay + `gateway_refund_id` dedup on webhook path (`stripe_service._process_succeeded_refund:970–972`) |
| 9 | Refund allocation reversal fix | **VERIFIED** | `reverse_allocations_for_refund` `payment_service.py:268–346`; wired into both `RefundService.complete_refund` and Stripe refund webhooks; tests confirm REFUNDED flips incl. allocated-payment case (the Phase‑1 BROKEN bug is fixed) |
| 10 | Dispute model | **VERIFIED** | `models.py:3332–3361`, unique `gateway_dispute_id`, payment FK SET NULL |
| 11 | Dispute webhooks | **VERIFIED w/ defects** | Handlers registered for created/updated/closed; upsert correct. Defects: `connected_account_id=data_object.get("account")` reads a field that exists on the event envelope, not the dispute object → always NULL (DIS‑1); charge-id-only matching fails for checkout-created payments (DIS‑2) |
| 12 | Currency validation | **VERIFIED** | `_resolve_and_validate_currency` vs `VALID_CURRENCY_CODES` pre-flight (stripe_service:157–165); allocation & refund cross-currency rejection |
| 13 | organization_id enforcement | **VERIFIED** | Routers derive org from `current_user` only; webhook handlers refuse unscoped invoice lookups (`stripe_service:695–711, 752–768, 838–846`); IDOR tests present & passing |
| 14 | Webhook tenant resolution | **PARTIALLY VERIFIED** | Solid for platform-scope events (metadata + scoped DB lookups). For the actual Plane 2 topology (connect-scope events carrying envelope `account`) resolution is **not implemented** — envelope `account` never read; `StripeEvent.connected_account_id/environment/processing_attempts/correlation_id` columns are dead code (never written) |
| 15 | Payment allocation | **VERIFIED** | `allocate_payment:377+` — dual SELECT…FOR UPDATE, over-allocation guards recomputed under lock, currency match, customer match, non-allocatable statuses |
| 16 | Reconciliation | **NOT VERIFIED** | Only an internal `reconcile_payment` flag endpoint exists. No Stripe↔ledger comparison job/service/report anywhere in repo |
| 17 | Audit logging | **VERIFIED** (core paths) | BillingAuditService on connect lifecycle, payments, refunds. Webhook money-movement itself relies on the `stripe_events` ledger rather than audit entries (acceptable, noted) |
| 18 | RBAC | **VERIFIED** (code) | `/billing/stripe/*` admin-gated; refund approve behind finance_approver (maker-checker preserved). Router-level tests absent |
| 19 | Frontend integration | **NOT VERIFIED — NOT IMPLEMENTED** | No Connect UI/status/onboarding/callback anywhere under `frontend/src`; no `@stripe/stripe-js` dependency; PublicInvoicePage card form still static placeholder; only hosted-Checkout redirect works. Implementation report itself defers frontend |
| 20 | Error handling | **PARTIALLY VERIFIED** | Graceful BadRequestException when unconfigured; handler failures captured in ledger row. BUT endpoint returns HTTP 200 on failure (WEB‑2), no SDK retry/timeouts (ID‑3), broad except-swallowing in `_finalize_event` |

Also verified independently: **41/41 tests pass** (executed locally); all seven documentation files exist (plus prior `AUDIT_PHASE1`).

---

## 3. Test Coverage Analysis (the 41 tests)

### 3.1 Matrix

| Suite (#tests) | What each proves | What it does NOT prove |
|---|---|---|
| Foundation (4) | currency resolver accepts/rejects; service boots keyless; missing-secret raises | Any real Stripe call shape |
| Connect (10) | status dict shape; `_derive_status` mapping (active/onboarding/action_required); persistence; unique (org,env) & unique acct id; disconnect transition; onboarding URL contains client_id / raises without it | HTTP layer of connect router (0 tests); OAuth token exchange against Stripe; redirect URI validation; CSRF state; livemode check |
| Customer mapping (3) | create-on-missing, reuse-existing, wrong-org raises | That `Customer.create` params satisfy current API (mock returns canned object) |
| Invoice payment flow (4) | checkout.completed records+allocates+marks PAID; idempotent replay; missing-org refused; PI-failed marks FAILED | Real session payload schema; amount taken from session vs balance; partial checkout; out-of-order delivery |
| Idempotency (3) | payment/refund key replay; event-ledger dedup returns `idempotent` | Concurrent (parallel-request) races — single-threaded SQLite; unique-constraint backstop on Postgres |
| Webhook security (4) | bad signature 400s; missing secret raises; unknown event recorded harmlessly; forged-org cannot pay another tenant’s invoice | Real HMAC vectors/timestamp tolerance; connect-scope envelope handling; duplicate-event across endpoints |
| Refund reversal (3) | full reversal flips payment+invoice; webhook path reverses; gateway-refund dedup | Partial multi-invoice split ordering; refunds on platform-push path; currency edge cases |
| Disputes (5) | persistence; created→recorded (payment preserved); updated→upsert; won→closed_at; unique constraint | lost/closed flows; evidence_due_by parsing from REAL epoch payloads; tenant attribution failure mode DIS‑2 |
| Currency safety (2) | unsupported code raises; mismatched allocation rejected | Stripe-side zero-decimal / exotic currencies |
| Tenant isolation (3) | cross-org invoice pay blocked; get_payment wrong org raises; dispute org resolved from payment not metadata | Router-level authZ; public-token flow scoping |

### 3.2 Explicit limitations of “41/41 passing”

The suite proves **internal logic against mocks and in-memory SQLite**. It does NOT prove any of the following (each requires real Stripe):

1. Stripe API parameter compatibility (payload schemas drift; SDK pin is open-ended `stripe>=9.0.0` while installed is 15.5.0).
2. Connect onboarding completes and yields a usable Standard account.
3. OAuth authorize/token round-trip works against Stripe (incl. dashboard-side “OAuth onboarding enabled” prerequisite).
4. Real PaymentIntent creation succeeds (zero tests even mock the success path of `create_payment_intent`).
5. Real Checkout session creation/hosted-page completion.
6. Real webhook **delivery** reaches our endpoint through routing/TLS/proxy.
7. Signature verification against genuine Stripe-signed headers (incl. timestamp tolerance).
8. Connected-account (`Stripe-Account:` header) semantics — header is never sent today (GAP‑1).
9. Real refunds execute upstream (push path untested even by mocks beyond happy-path).
10. Real dispute lifecycle payloads (epoch `due_by`, status vocabulary, envelope fields).
11. Capability/requirement changes propagate (`account.updated` unhandled).

---

## 4. Stripe API Boundary Audit (every call site, vs current official docs)

Call sites: `_stripe_module()` (both services), `ensure_customer`, `create_checkout_session`, `create_payment_intent`, `list_payment_methods`, `create_stripe_subscription`, `cancel_stripe_subscription`, `create_stripe_refund`, `handle_webhook`, `complete_oauth`, `sync_status`.

| Dimension | Current behavior | Official-docs verdict | Finding |
|---|---|---|---|
| SDK usage | lazy import; `stripe.api_key = settings.STRIPE_SECRET_KEY` per call | OK | — |
| API version | **not pinned** (`stripe.api_version` unset) | Docs: account-default version governs Event payloads; pinning avoids silent drift | **API‑1:** pin an explicit API version |
| Connected-account handling | **absent** — no `stripe_account=` param anywhere | Connect docs: act on behalf via `Stripe-Account` header / `stripe_account` kwarg; direct charges route to that account | **GAP‑1 (CRITICAL)** |
| Authentication | platform secret only; no per-tenant secrets stored | Matches recommended Standard-account model (secret + header) | Model correct; unused |
| Idempotency keys (outbound) | none sent; `max_network_retries` unset (SDK default = 0 retries, auto-key generation off) | Idempotent-requests doc: send `Idempotency-Key` on POSTs; SDK retry docs recommend enabling network retries | **ID‑2/ID‑3:** timeout-after-send ⇒ duplicate PaymentIntent/Refund risk; enable `stripe.max_network_retries` (auto-keys) or pass deterministic keys |
| Timeouts | none configured (SDK defaults) | Docs recommend bounded timeouts ahead of user-facing responses | **ID‑3a** |
| Webhook signature | `Webhook.construct_event(raw_body, sig, secret)`; raw body via `await request.body()`; default 300 s tolerance | Exactly the documented pattern | OK |
| Webhook response semantics | returns **200 with error body** when handler status=`failed`; 400 only on bad signature | Docs: return 2xx after processing; non-2xx triggers automatic retry (3 days exp backoff). Also “return quickly / process async” | **WEB‑2:** failed processing silently suppresses retries; synchronous heavy work risks delivery timeouts |
| Event parsing | `.to_dict()` normalization; metadata extraction; per-type handler map; unknown types recorded processed | Docs: log unknown types harmlessly | OK |
| Duplicate events | unique `event_id` ledger; pre-check + IntegrityError fallback | Docs: dedupe on event ids | OK |
| Ordering | not assumed (mostly upsert/converge); `invoice.paid` lacks existing-payment guard when PI absent | Docs: ordering not guaranteed; retrieve objects to fill gaps | **WEB‑4:** minor double-record window for non-PI invoices |
| OAuth flow | legacy `oauth/authorize` + `OAuth.token` | Docs: “OAuth isn’t recommended for new Connect platforms; use Connect Onboarding (Account Links)”; OAuth must be enabled in dashboard; `state` should be validated (CSRF) | **CON‑1/CON‑2** |
| Environment derivation | env inferred from `sk_test_` prefix; no `livemode` cross-check of token/account response | OAuth reference returns `livemode`; keys-best-practices: keep modes separated | **CON‑3** minor |
| Deprecated APIs | `datetime.utcfromtimestamp` (disputed-handler) | Python ≥3.12 deprecation | cosmetic |

---

## 5. Connect Audit

Chain as specified in the task, with current-state verdicts:

```
Platform                → Zoiko platform account concept        IMPLEMENTED (config-level)
Tenant onboarding       → onboarding-url endpoint               IMPLEMENTED (legacy OAuth)
Connected account       → StripeConnectedAccount table          IMPLEMENTED
OAuth authorization     → stripe-hosted consent                 PARTIAL (works if dashboard OAuth enabled; no state validation)
Callback                → /callback code exchange               IMPLEMENTED (single-use code consumed once; IntegrityError race handled)
Account persistence     → row w/ caps, requirements             IMPLEMENTED
Status synchronization  → pull-based sync                       IMPLEMENTED (pull) / MISSING (push: account.updated)
Capabilities            → JSON snapshot + disabled_reason       IMPLEMENTED (snapshot only)
Payment readiness       → charges/payouts gate payments         **MISSING — payment creation ignores connection entirely (GAP‑1 surface)**
Routing money           → stripe_account on every call          **NOT IMPLEMENTED**
```

Stripe-side configuration required (validated against docs; do not confuse with credentials request — see §18):
- A Stripe **platform account with Connect enabled** (Connect settings visible).
- If keeping OAuth: enable **“Onboarding accounts with OAuth”**, register ≥1 **redirect URI** (exact-match), copy the **test client_id**. Recommended alternative: migrate to Account Links (`type=standard` account create + `account_links`) before go-live decision.
- A **webhook endpoint** (platform scope AND a separate **Connected accounts** destination) with the event list in the test plan §7; two secrets (test/live differ).
- Required capabilities: whatever the tenants’ countries demand (`card_payments`/`transfers` equivalents are auto-requested for Standard accounts during onboarding; verify `capabilities.card_payments=active` post-onboarding).

## 6. Payment Flow Audit

Traced transitions (`Invoice → create checkout/intent → customer pays → webhook → PaymentAttempt-equivalent (Payment row CLEARED) → allocation → balances → invoice state`):

| Transition | Mutation | Idempotent? | Tenant-validated? | Error handling |
|---|---|---|---|---|
| Pay click → Checkout Session | `invoices.stripe_checkout_session_id` | session id overwrite (last wins) | invoice fetched org-scoped; payable guard | Stripe errors bubble as 400 |
| Session created → customer action | none local | n/a | n/a | cancel_url |
| `checkout.session.completed` | Payment(CLEARED)+allocation+invoice flags | intent-dedup + event ledger + record_payment key | metadata org AND scoped invoice fetch; forged-metadata test passes | exceptions → ledger `failed` |
| `payment_intent.succeeded` | same convergence | existing-payment short-circuit | scoped lookup; fallback by stored PI id (platform-written value) | as above |
| `payment_intent.payment_failed` | status FAILED + reason/code | ledger | org-scoped PI search | BadRequestException tolerated→skipped |
| Allocation | allocations row; paid/balance/status | unique(payment,invoice)+locks | both rows org-scoped FOR UPDATE | over-allocation/currency/customer guards |
| Invoice state | SENT→PARTIALLY_PAID→PAID | derived from locked balances | same txn | atomic commit |

**No shortcut exists**: there is no path where Stripe success marks an invoice PAID without a committed Payment + PaymentAllocation — confirmed by reading every success handler. ✅

Residual notes: checkout path stores **no `gateway_charge_id`** (harmful to dispute/refund matching, DIS‑2); `checkout.session.amount_total` is trusted implicitly equal to balance (true for this construction).

## 7. Webhook Audit

Endpoint: `POST /api/webhooks/stripe` (mounted outside auth router, `main.py:205`). Raw body ✅, `Stripe-Signature` required ✅, construct_event ✅, event-id ledger ✅, per-event status tracking (`processing/processed/failed` + error text) ✅, unknown events recorded ✅. Retry behavior: **inbound retries honored only while undelivered; processing failures answer 200 → never retried (WEB‑2)**; no manual replay tooling; enrichment columns unwritten; connected-account identification absent (WEB‑1).

Event table (H = handler exists; T = covered by automated tests):

| Event | Handler | DB mutation | Idempotent? | Tenant verified? | Tested? |
|---|---|---|---|---|---|
| checkout.session.completed | record+allocate | Payment, Allocation, Invoice | ✅ triple-layer | ✅ strict | T |
| checkout.session.expired | noop | — | ✅ | n/a | — |
| payment_intent.succeeded | converge/record | Payment, Allocation, Invoice | ✅ | ✅ (+stored-PI fallback) | indirect |
| payment_intent.payment_failed | mark FAILED | Payment.status | ✅ ledger | ✅ scoped PI | T |
| payment_intent.canceled | noop | — | ✅ | n/a | — |
| invoice.paid | record payment (subscription invoices) | Payment, Allocation | ⚠️ partial (no pre-guard when PI absent) | ✅ scoped | — |
| invoice.payment_failed | mark FAILED | Payment.status | ✅ | ✅ | — |
| customer.subscription.updated/deleted | sync sub status | Subscription | ✅ upsert | via stored stripe id | — |
| charge.refunded | reverse allocations + Refund row | Refund, Allocation, Payment, Invoice | ✅ gateway_refund_id | ✅ scoped PI | T |
| refund.updated | same convergence | as above | ✅ | ✅ | — |
| charge.dispute.created/updated/closed | Dispute upsert | Dispute | ✅ unique id | ⚠️ weak for checkout-path payments (DIS‑2) | T (happy) |
| **account.updated** | **NONE** | — | — | — (needed for capability changes) | — |
| unknown types | ledger-only | stripe_events row | ✅ | best-effort | T |

## 8. Refund Audit

Both directions converge on one primitive (`reverse_allocations_for_refund`), newest-allocation-first, invoice status recomputed (REFUNDED/PARTIALLY_PAID/PAID), payment flips only when completed refunds ≥ amount, over-refund logged as customer credit. Maker-checker internal flow intact (self-approval blocked; finance_approver role distinct). Push path guards: APPROVED/PROCESSING-only, `already_submitted` short-circuit, requires linked PI. Gaps: no Stripe-side idempotency key on `Refund.create` (ID‑2); GAP‑1 means refunds execute against platform account; refund of unallocated surplus logs but leaves credit-balance follow-up manual.

## 9. Dispute Audit

Record/upsert lifecycle solid for PI-path payments; original payment intentionally preserved (audit-friendly). Findings: DIS‑1 (`account` read from wrong object), DIS‑2 (charge-id-only matching misses checkout payments → NULL org recording), DIS‑3 (lost disputes produce no invoice/payment adjustment nor ops task — financial impact invisible). None are destructive; all are correctness/completeness gaps to schedule before real-dispute testing (D‑series in test plan).

## 10. Currency Audit

Fail-fast resolver against `VALID_CURRENCY_CODES` before ANY Stripe write; allocation and refund enforce same-currency; payment creation resolves explicit>customer>org-default without silent USD fallback; Stripe amounts converted via Decimal ROUND_HALF_UP cents. Multi-currency settlement/FX variance is out of scope and tracked under reconciliation (RC‑4).

## 11. Tenant Isolation Audit

Every router derives org from `current_user`; services accept org params and filter every fetch; webhook handlers refuse unscoped id lookups and resolve org via DB joins (metadata treated as hint, never authority — proven by `test_dispute_resolves_org_from_payment_not_metadata`); DB constraints (`uq_stripe_connected_account_id`, scoped uniques) prevent cross-tenant account sharing; kill-switch import is a known Plane-boundary coupling (documented Phase‑1, left intentionally). Verdict: READY at current scope; re-verify after GAP‑1 introduces per-account routing.

## 12. Security Audit

✅ Verified good: signature verification precedes any persistence; no secrets returned by any endpoint (status dict explicitly non-secret fields); repo-wide scan for `sk_live|sk_test|rk_live|rk_test|whsec_` literals → **none found**; `.env` gitignored, `.env.example` blank placeholders; no PAN/CVC storage anywhere (tokenized `gateway_payment_method_id`/last4 only); webhook route exempt from JWT by design but self-verifying; RBAC on all mutation endpoints; IDOR suite green.

Findings:
- **SEC‑1:** OAuth `state` accepted from client, never generated/verified → CSRF on connect callback (low impact: attacker can only link *an* account they control to victim org — still must fix).
- **SEC‑2:** Settings UI retains plaintext `webhook_secret` field bound to a column nothing reads (echoed on GET) — residual from Phase‑1 list, still present; remove to avoid operator confusion.
- **SEC‑3:** Failed-webhook bodies echo raw exception strings into HTTP response (info disclosure of internals) — replace with opaque message + correlation id.
- **ENV separation:** environment derived from key prefix only at connect time; no runtime assertion preventing test-mode key + LIVE-labeled rows beyond prefix logic (acceptable test-mode; revisit pre-live).

## 13. Database Audit

Tables: `stripe_events`, `stripe_connected_accounts`, `disputes` (+ existing `payments`, `payment_allocations`, `refunds`).

- FKs: org FKs present on all three; RESTRICT on org deletes for accounts/disputes, SET NULL for ledger/payment links — sensible.
- Uniqueness: event_id; (org,provider,environment); global connected_account_id; gateway_dispute_id; (org, transaction_id) via payments; refund idempotency_key column + lookup.
- Indexes: declared on all FK/gateway-id columns reviewed.
- Nullables: appropriate (ledger org nullable by design; dispute org nullable — becomes problematic under DIS‑2, flagged).
- Provider references: `provider='stripe'` default column present on accounts (multi-provider-ready).

**Migration safety (MIG‑1):** There is no migration framework (documented `create_all` bootstrap; no Alembic). New TABLES bootstrap fine on fresh DBs, but the additive columns added to the EXISTING `stripe_events` table will NOT be created on already-deployed databases (`create_all` never ALTERs) — first webhook insert/select touching them will fail there. A one-shot idempotent ALTER script (or adoption of the lightweight migration scripts pattern already used elsewhere in `backend/migrations/`) is required before any shared/staging deployment. Do not rewrite history tables; add forward-only script.

## 14. Frontend Audit

Verified by direct inspection (not inferred from backend):
- Connect: ❌ no UI for status/onboarding/callback/disconnect; no route captures Stripe’s redirect back.
- Payments: hosted Checkout redirect works (`PublicInvoicePage.handleCheckout` → `window.location = checkout_url`); success/cancel URL states handled minimally (alert on error); embedded card form = static mockup placeholder (“Stripe CardElement mounts here”), `@stripe/*` packages absent from `frontend/package.json`.
- Status/loading/error states for Stripe-specific outcomes (Processing / Requires action / Disputed badges): ❌ absent.
- Tenant context/permission checks: generic billing-admin gating exists app-wide; no Connect-specific UI gating because feature absent.
Verdict: FRONTEND = NOT READY (matches report §6 admission; do not claim otherwise).

## 15. Reconciliation Audit

No automated Stripe↔ledger reconciliation exists. Existing pieces: internal reconcile flag endpoint, auto_reconcile settings toggles, super-admin financial consistency service (Plane-adjacent). Acceptance bar defined in test plan RC‑1…RC‑6; minimum viable scope recommendation: nightly job diffing Stripe BalanceTransactions (per connected account post-GAP‑1) vs `payments/refunds` on (gateway id, gross, currency, date±1) → variance queue; plus recovery path for missed webhooks (fetch-PI-and-process, idempotent by design).

## 16. Remaining Gaps (consolidated register)

| ID | Severity | Gap | Where |
|---|---|---|---|
| GAP‑1 | CRITICAL | No `stripe_account` routing; payments/refunds/customers run on platform account; no connection-state gate before payment creation | stripe_service all call sites |
| WEB‑1 | HIGH | Connect-scope webhook handling: envelope `account` ignored; tenant resolution for connected-account events unimplemented; StripeEvent enrichment columns dead | handle_webhook/_extract_org_id |
| WEB‑2 | HIGH | 200-on-failure suppresses Stripe retries; no replay tooling | webhook_router/handle_webhook |
| REC‑1 | HIGH | No reconciliation job/process | — |
| CON‑1 | MED | Legacy OAuth (deprecated-for-new-platforms); plan Account Links migration decision | stripe_connect_service |
| CON‑2 | MED | `state` not validated (CSRF) | get_onboarding_url/router callback |
| CON‑3 | MED | `account.updated` unhandled → capability changes invisible until manual sync | _handlers() |
| DIS‑1/2/3 | MED | dispute `account` misread; checkout-payment matching miss; no lost-dispute financial handling | _handle_dispute_event |
| ID‑2/3 | MED | No outbound idempotency keys; no network retries/timeouts | all Stripe writes |
| MIG‑1 | HIGH(deploy) | stripe_events new columns missing on existing DBs (no ALTER path) | migrations strategy |
| API‑1 | LOW | API version unpinned; SDK pin open-ended (`>=9.0.0` vs installed 15.5.0) | config/requirements |
| FE‑1 | HIGH(scope) | Entire frontend integration missing | frontend |
| SEC‑1/2/3 | MED/LOW | state CSRF; dead webhook_secret UI field; error-body disclosure | connect/settings/webhook |
| ENV‑1 | LOW | `.env.example` missing `STRIPE_CONNECT_CLIENT_ID` | .env.example |

## 17. Test Environment Requirements (summary — full request in §18)

Validated against implementation needs: platform TEST secret+publishable keys, ONE webhook endpoint secret (test), Connect test client_id, one registered redirect URI, CLI-forwarded local listener, one test connected account, and dashboard ability to mint OAuth codes/create test disputes/refunds. Nothing production-grade requested.

## 18. Team Credential Requirements — FINAL TEST ENVIRONMENT ACCESS REQUEST

> Supersedes the minimal table in `STRIPE_PLANE2_CREDENTIAL_REQUIREMENTS.md` §1 (that doc omitted Connect/webhook-scope specifics). Values to be provided BY the team INTO the environment — none are requested here beyond access.

**A. Stripe Platform / Test Account**
- [ ] One Stripe account designated “Zoiko Connect Platform (TEST)” with **Connect enabled** (Connect settings reachable).
- [ ] Two dashboard seats for the integration team (Developer role sufficient).

**B. Connect Configuration**
- [ ] Confirm which onboarding mode is authorized: **OAuth** (current code) — requires enabling “Onboarding accounts with OAuth”; OR approval to implement **Account Links** (recommended by Stripe for new platforms; small code change, no credential change).
- [ ] Connect branding (name/icon/color) set — required by Connect Onboarding forms.

**C. OAuth Configuration** (only if B=OAuth)
- [ ] Test-mode `client_id` (`ca_…`) → `STRIPE_CONNECT_CLIENT_ID`.
- [ ] Registered Redirect URI (exact string, e.g. `https://staging.zoiko.example/connect/stripe/callback`) — team must supply the chosen URI; we configure code to match.

**D. Webhook Configuration**
- [ ] Endpoint URL to register: `{API_BASE}/api/webhooks/stripe`.
- [ ] Create TWO event destinations: **Account scope** and **Connected accounts scope** (event lists per test plan §7).
- [ ] Provide the resulting test `whsec_…` → `STRIPE_WEBHOOK_SECRET` (one per destination if two URLs are used).

**E. Test Connected Account**
- [ ] One pre-created (or self-onboarded via C) Standard test account with charges+payouts enabled for positive-path testing; one deliberately restricted for C‑7.

**F. Environment Variables** (test values only)
- [ ] `STRIPE_SECRET_KEY=sk_test_…`
- [ ] `STRIPE_PUBLISHABLE_KEY=pk_test_…`
- [ ] `STRIPE_WEBHOOK_SECRET=whsec_…`
- [ ] `STRIPE_CONNECT_CLIENT_ID=ca_…`
(No `sk_live_*`, no `rk_*`, no production whsec — explicitly out of request.)

**G. Redirect URLs / Webhook URLs**
- [ ] Team confirms public HTTPS host for staging webhook (live-mode requirement later; localhost acceptable now via Stripe CLI forwarding).
- [ ] Team supplies exact frontend callback route to pair with the redirect URI.

**H. Required Stripe Capabilities**
- [ ] Standard accounts: verify post-onboarding `charges_enabled && payouts_enabled && requirements.currently_due=[]` (capability requests are implicit for Standard; nothing to pre-request).
- [ ] If platform fees ever introduced later: `application_fee_amount` + transfer capabilities decision — explicitly deferred.

## 19. Real Stripe Test Plan

Delivered as `docs/STRIPE_PLANE2_REAL_STRIPE_TEST_PLAN.md` — 38 cases across CONNECT (9), PAYMENTS (9), REFUNDS (6), DISPUTES (6), SECURITY (8), RECONCILIATION (6), each with Precondition / Action / Expected Stripe / Expected Zoiko / Expected DB / Expected audit results, plus exit criteria. Cases blocked by GAP‑1 are labeled inline rather than silently omitted.

## 20. Production Readiness

**NOT READY — and intentionally so.** Test Mode only. Preconditions to revisit: GAP‑1, WEB‑1/2, MIG‑1, CON‑2/3, DIS‑2/3, REC‑1, FE‑1, outbound idempotency (ID‑2/3), pinned API version, live webhook destinations + rotated secrets, PCI SAQ-A posture confirmation (hosted fields only — currently satisfied architecturally by hosted Checkout; the static mock card form MUST be removed or replaced with Elements before any external exposure). No production claims are made or implied by this document.

## 21. Plane 1 Explicitly Deferred

No file under `app/modules/super_admin`, `app/modules/commercial`, or any Plane-1 billing surface was modified in this phase (git working-tree diff confined to billing module + config + tests + docs). The single acknowledged coupling (kill-switch service import) predates this phase, was assessed legitimate in Phase‑1, and was deliberately left untouched. Plane 1 remains out of scope.

---

## FINAL STATUS

OVERALL STATUS: **BLOCKED** (real-Stripe validation cannot begin until §18 items are provisioned; code gaps above must be sequenced)

CODE IMPLEMENTATION: **PARTIALLY READY**
TEST SUITE: **READY** *(41/41 independently re-executed; scope limits per §3)*
REAL STRIPE VALIDATION: **BLOCKED** *(no environment/credentials configured; zero real-Stripe evidence)*
SECURITY: **PARTIALLY READY** *(strong core; SEC‑1/2/3 open)*
TENANT ISOLATION: **READY** *(at current platform-account scope; re-audit post-GAP‑1)*
CONNECT: **PARTIALLY READY** *(onboarding/status done; routing + readiness gate missing)*
PAYMENTS: **PARTIALLY READY** *(correct ledger mechanics; not routed to tenant accounts; untested against real Stripe)*
WEBHOOKS: **PARTIALLY READY** *(verification/idempotency solid; connect-scope resolution + retry semantics open)*
REFUNDS: **PARTIALLY READY** *(reversal engine verified; routing + outbound idempotency open)*
DISPUTES: **PARTIALLY READY** *(recording works; attribution + lost-dispute handling open)*
RECONCILIATION: **NOT READY**
FRONTEND: **NOT READY**
PRODUCTION READINESS: **NOT READY** *(Test Mode only)*