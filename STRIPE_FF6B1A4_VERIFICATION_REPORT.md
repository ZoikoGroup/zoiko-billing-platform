# Stripe Commit `ff6b1a4` — Independent Verification Report

Companion to the `rugvedh` email-system report. Same method: every claim
verified against the actual code, not the commit message, and every
"still open" item cross-checked rather than assumed.

- **Branch:** `rugvedh`
- **Commit under review:** `ff6b1a4` "fix(stripe): pin API version, correlate webhooks, dedup payments, adjust lost disputes"
- **Predecessor:** `f1940c7` "feat: integrate Stripe Plane 2 billing" — the commit that actually landed the Plane 2 integration
- **Baseline for cross-checking:** `STRIPE_PLANE2_READINESS_REPORT.md` §16 (consolidated gap register)

---

## 1. Executive Summary

**The verification brief's central premise does not hold, and correcting it
changes the priority order substantially.**

The brief instructed: *"Read this before assuming the commit is more complete
than it is… `git show ff6b1a4 -- …stripe_service.py | grep stripe_account`
confirms zero occurrences of `stripe_account=` — meaning GAP-1, the single
CRITICAL finding… is not touched by this commit."*

The grep is accurate. **The inference drawn from it is not.** GAP-1 connected-account
routing was already closed, in `f1940c7` — the commit immediately preceding `ff6b1a4`,
in the same branch. `ff6b1a4` is a *follow-up hardening* commit layered on top of a
complete integration, not a commit that left the critical path untouched.

Concretely, of the items the brief predicted were "still open," the following
are in fact **closed and verified**:

| Predicted open | Actual state | Closed in |
|---|---|---|
| **GAP-1 (CRITICAL)** connected-account routing | **CLOSED** — all 7 money ops pass `stripe_account=` behind a fail-closed gate | `f1940c7` |
| CON-3 `account.updated` unhandled | **CLOSED** — `_handle_account_updated` registered and syncs connection status | `f1940c7` |
| DIS-1 dispute `account` misread | **CLOSED** — `connected_account_id` taken from trusted envelope `event.account` | `f1940c7` |
| DIS-2 charge-id-only matching | **CLOSED** — three-tier attribution chain incl. `payment_intent` fallback | `f1940c7` |
| ID-3 no network retries/timeouts | **CLOSED** — `max_network_retries` + bounded `timeout` set on the SDK | `f1940c7` |
| ID-2 no outbound idempotency keys | **PARTIALLY CLOSED by this very commit** — 3 of 4 writes now keyed | `ff6b1a4` |
| WEB-1 envelope `account` ignored | **CLOSED** — `event.account` → connected-account row → org, authoritative | `f1940c7` |

The pattern: the brief inferred "not in this diff" ⇒ "still open", but most of
these were closed by the *preceding* commit on the same branch. A diff-scoped
search cannot distinguish "never implemented" from "implemented in the parent
commit", and that distinction drove every one of these predictions.

**Every claim `ff6b1a4` makes about its own work is accurate.** Seven of seven
verified against the code, including both specific risk areas the brief flagged
(double-adjustment on dispute replay, and payment-id contamination) — both are
correctly guarded, and both are covered by a passing test.

**The genuinely open items are narrower and less dramatic than predicted:** CON-1
(OAuth vs Account Links — an unmade product decision, not a defect), full REC-1
(a real nightly reconciliation job), and the Connect-scope/MIG-1 deployment items
inherited from `f1940c7`.

**Verdict: this commit is sound, well-tested, and closes ID-2 — the most
underrated item in the register. GAP-1 is not the next priority, because it is
already done.**

---

## 2. Claim-by-Claim Verification of `ff6b1a4`

### API-1 — API version pin
**CONFIRMED.**

- `stripe_connect_service.py:77` — `_PINNED_STRIPE_API_VERSION = "2026-08-26.dahlia"`, a module-level string literal assigned at `configure_stripe_runtime` (line 111: `stripe.api_version = _PINNED_STRIPE_API_VERSION`). Not a comment, not a read of the SDK's own default.
- `requirements.txt:52` — `stripe>=15.0.0,<16.0.0`.
- **No drift between the two.** Verified against the installed SDK:

  ```
  installed stripe: 15.6.1
  bundled api_version: 2026-08-26.dahlia
  ```

  The pinned string is exactly `stripe==15.6.1`'s own bundled default, so the pin constrains the API version without freezing the package below a version that supports it. The commit message's claim that these "must move together" is accurate as a maintenance constraint.

### SEC-3 — `correlation_id` on `stripe_events`
**CONFIRMED, on both paths.**

- **Insert:** `stripe_service.py:765` — `correlation_id=event_id` on the `StripeEvent` constructor.
- **Backfill:** `stripe_service.py:806` — `row.correlation_id = row.correlation_id or event_id`, inside `_finalize_event`, which runs on **every** touched event, not only at insert. Legacy rows self-heal on next touch. The `or` makes it non-destructive.
- **No error leakage:** `webhook_router.py:38-44` returns `{"message": "Webhook processing failed; the event will be retried", "event_id": result.get("event_id")}`. The message is a fixed literal; no `str(exc)` reaches the wire. An operator gets the lookup key without the internal error text.

### WEB-4 — payment dedup for `invoice.paid` with no PaymentIntent
**CONFIRMED, and the contamination risk the commit message warns about is genuinely avoided.**

- `_record_cleared_payment` (stripe_service.py) takes an explicit `idempotency_key: Optional[str] = None` and computes `effective_idempotency_key = idempotency_key or payment_intent_id`, which is passed **only** to `record_payment(idempotency_key=…)` for the dedup check.
- The handler `_handle_invoice_paid` supplies the fallback:
  `fallback_idempotency_key = None if payment_intent_id else f"invpaid-{data_object.get('id')}"` — stable across redeliveries, since a Stripe invoice's `id` does not change.
- **Contamination check (every assignment to `stripe_payment_intent_id`):**

  ```
  stripe_service.py:393   invoice.stripe_payment_intent_id  = payment_intent.id      (real pi_, from a create call)
  stripe_service.py:966   payment.stripe_payment_intent_id  = payment_intent_id       (real, guarded by `if payment_intent_id:`)
  stripe_service.py:1059  invoice.stripe_payment_intent_id  = payment_intent_id
  stripe_service.py:1064  invoice.stripe_payment_intent_id  = payment_intent_id
  stripe_service.py:1076  invoice.stripe_payment_intent_id  = payment_intent_id or invoice.stripe_payment_intent_id
  stripe_service.py:1137  invoice.stripe_payment_intent_id  = payment_intent_id
  stripe_service.py:1156  invoice.stripe_payment_intent_id  = payment_intent_id
  ```

  Every one is a real PaymentIntent value or an existing-column carry-forward. The `invpaid-…` fallback appears in **none** of them. The invariant "`stripe_payment_intent_id` holds only a real `pi_…` id or NULL" holds — which matters beyond tidiness, because the reconciliation engine and `_handle_dispute_event` both query on that column expecting real ids.

### DIS-3 — lost-dispute financial adjustment
**CONFIRMED, double-adjustment correctly prevented at two independent levels.**

- **Transition gate, not status check.** Line 1487:
  `became_lost = previous_status != DisputeStatus.LOST and status == DisputeStatus.LOST` — a genuine transition *into* lost. A redelivery of an already-LOST event yields `previous_status == LOST` → no adjustment. The same guard exists on the new-dispute path (lines 1526-1532), which only fires when no prior local row exists.
- **Independent idempotency guard.** `_apply_lost_dispute_adjustment` (line 1575) checks `Refund.gateway_refund_id == dispute.gateway_dispute_id` before creating anything, explicitly commented as "defense-in-depth on top of the transition-into-LOST gate."
- Reuses `_create_gateway_refund` + `reverse_allocations_for_refund` rather than a parallel money path, and scopes strictly to the dispute's own already-attributed `payment_id`/`organization_id`.
- Raises an Attention Engine item (`source_key=f"stripe_dispute_lost:{gateway_dispute_id}"`) so a debit nobody requested is visible to a human.
- **Test exists and passes:** `test_redelivered_lost_event_does_not_double_adjust`.

### WEB-2 — manual replay
**CONFIRMED, and the docstring's claim about the router is true.**

- `replay_failed_event(event_id, organization_id)` queries by `event_id`, then rejects on `row.organization_id != organization_id`, on `row.status != "failed"`, and on a missing payload.
- The endpoint (`stripe_router.py:148-165`) is `POST /webhooks/{event_id}/replay`, gated `get_current_user` + `get_current_billing_admin`, and passes `organization_id=current_user.organization_id`. The only request-derived input is `event_id`; `organization_id` is never taken from the body or query string. **Cross-tenant replay is not reachable.**

### REC-1 (partial) — `recover_missing_payment_intent`
**CONFIRMED partial, with one nuance worth recording.**

- Exactly one call site, `super_admin/router.py:4227` — an explicit super-admin HTTP action. **No scheduler job, no automatic path.** Confirmed against the 17 registered `get_job_definitions()` entries: none reference reconciliation recovery.
- Defensive preconditions are real: requires an `ACTIVE` connected account (line 501), and refuses unless **Stripe itself reports `status == "succeeded"`** (line 523), so it cannot be used to force-record a payment that never succeeded.
- Resolves the connected account from its own `stripe_connected_accounts` row, never from caller input.
- **Nuance:** the docstring describes recovering "one PaymentIntent a reconciliation run flagged as `KIND_MISSING_IN_LEDGER`", but the function does **not** verify such a flag exists. The "human reviews the exception first" step is a workflow convention, not an enforced precondition. Low severity (it is a super-admin-only action, and the succeeded-status check bounds the blast radius), but the docstring overstates what is enforced.

### Frontend — Connect UI, Checkout, CSRF
**CONFIRMED on all three.**

- **CSRF:** `issue_oauth_state` / `verify_oauth_state` (stripe_connect_service.py:215/223), HMAC-signed, organization-bound, short-TTL (`STRIPE_OAUTH_STATE_TTL_SECONDS`, default 600). `stripe-connect-callback.jsx` reads `state` from Stripe's redirect and forwards it to `completeOAuth(code, state)`; the client never *generates* a state. **No leftover client-generated-state path.**
- **Mock card form removed, not supplemented.** `PublicInvoicePage.jsx` contains no `cardNumber`/`expiry`/`cvc` inputs; it calls `publicInvoiceApi.createCheckout(...)` and redirects to the hosted Stripe Checkout URL. The mock is gone.
- Connect onboarding/status/disconnect UI present in `stripe-connect.jsx`.

---

## 3. Test Results

`backend/tests/test_stripe_plane2_phase_gaps.py` — **actually executed**, not assumed:

```
$ BILLING_DATABASE_URL=sqlite:///./test_stripe_run.db \
  python -m pytest tests/test_stripe_plane2_phase_gaps.py -q -p no:randomly

22 passed, 91 warnings in 10.87s
```

Zero failures, zero errors, zero skips. (The scratch SQLite file was deleted afterwards.)

Named coverage includes the two risk cases the brief asked to see proven:

```
TestLostDisputeAdjustment::test_transition_into_lost_reverses_allocation_and_opens_attention
TestLostDisputeAdjustment::test_redelivered_lost_event_does_not_double_adjust
TestLostDisputeAdjustment::test_lost_dispute_without_matching_payment_only_raises_attention
TestInvoicePaidDedupWithoutPaymentIntent::test_redelivered_invoice_paid_without_pi_does_not_duplicate
TestInvoicePaidDedupWithoutPaymentIntent::test_different_invoice_events_without_pi_each_record_once
TestManualReplay::test_replay_failed_event_reprocesses_and_records_payment
TestRecoverMissingPaymentIntent::test_recover_records_payment_via_shared_handler
TestRecoverMissingPaymentIntent::test_recover_is_idempotent_on_replay
```

All warnings are pre-existing `datetime.utcnow()` deprecations, unrelated to this commit.

**Honest accounting of limits.** These 22 tests are unit/integration tests with a **mocked** Stripe SDK. No live Stripe API call was made — there are no test credentials in this environment. Every claim above is verified against code paths and mocked-transport behaviour, which is the strongest available evidence short of the §19 real-Stripe test plan in the readiness report. See §6.

---

## 4. What `ff6b1a4` Does NOT Address (confirmed, cross-checked against §16)

Each item below was checked against the current branch state, not against the diff.

| ID | Severity | Status | Evidence |
|---|---|---|---|
| **GAP-1** | CRITICAL | **CLOSED (in `f1940c7`, not this commit)** | All 7 ops pass `stripe_account=connected_account_id`; see §5 |
| **CON-1** | MED | **OPEN** — legacy OAuth retained, now CSRF-safe. No `accountLinks` usage anywhere. The OAuth-vs-Account-Links *decision* remains unmade. | No `account_links` references in `backend/app` |
| **CON-3** | MED | **CLOSED (in `f1940c7`)** | `_handlers()` registers `account.updated` → `_handle_account_updated`, which syncs connection status from the event |
| **DIS-1** | MED | **CLOSED (in `f1940c7`)** | `_handle_dispute_event` docstring: connected account taken from trusted envelope `event.account`, not the dispute payload |
| **DIS-2** | MED | **CLOSED (in `f1940c7`)** | Three-tier attribution: `gateway_charge_id` → `payment_intent` → metadata |
| **DIS-3** | MED | **CLOSED by `ff6b1a4`** | §2 |
| **ID-2** | MED | **PARTIALLY CLOSED by `ff6b1a4`** | See §5 — keyed on 3 of 4 writes; `create_checkout_session` deliberately not |
| **ID-3** | MED | **CLOSED (in `f1940c7`)** | `stripe.max_network_retries` + bounded `timeout` in `configure_stripe_runtime` |
| **WEB-1** | HIGH | **CLOSED (in `f1940c7`)** | `event.account` → `stripe_connected_accounts` → `organization_id`, authoritative; metadata is legacy fallback |
| **WEB-2** | HIGH | **CLOSED by `ff6b1a4`** | §2 |
| **WEB-4** | HIGH | **CLOSED by `ff6b1a4`** | §2 |
| **REC-1** | HIGH | **STILL PARTIAL** | Manual single-payment recovery only; no scheduled Stripe↔ledger diff job exists |
| **SEC-3** | LOW | **CLOSED by `ff6b1a4`** | §2 |
| **API-1** | LOW | **CLOSED by `ff6b1a4`** | §2 |
| **MIG-1** | HIGH (deploy) | **OPEN, inherited** | `correlation_id` is a new column on `stripe_events`; no ALTER path for existing databases. Needs confirmation that `f1940c7`'s migration strategy covers pre-existing deployments. |
| **ENV-1** | LOW | **OPEN** | `.env.example` still lacks `STRIPE_CONNECT_CLIENT_ID` |
| **FE-1** | — | **CLOSED by `ff6b1a4`** | Connect UI + Checkout shipped |

### Genuine remaining priorities, in order

1. **REC-1 (full).** The only HIGH-severity functional gap that is actually open. A real nightly Stripe↔ledger diff job — `recover_missing_payment_intent` is a manual scalpel, not a process. Note this partly overlaps the pre-existing `reconciliation_job` in `get_job_definitions()`; the question is specifically whether it diffs *Stripe* against the ledger.
2. **MIG-1 (deploy).** If any environment already has a `stripe_events` table, `ff6b1a4`'s new `correlation_id` column needs a migration before deploy. This is a deployment blocker, not a code-quality issue, and it is cheap to close.
3. **ENV-1.** Trivial, but blocks a clean first deploy.
4. **CON-1.** A product decision, not a bug. It should be made deliberately before any external exposure, but nothing is broken today.

**GAP-1 is not on this list because it is not open.**

---

## 5. GAP-1 Re-Investigated in Full (the brief's CRITICAL item)

Because the brief flagged this as the single blocking item, it was verified exhaustively rather than by grep.

`_connected_account_id()` calls `resolve_connected_account(self.db, organization_id)`, whose contract is to **raise before any outbound Stripe request** when no active connection exists — i.e. it fails closed rather than silently falling back to the platform account.

| Operation | `stripe_account=` passes | Gated | Mechanism |
|---|---|---|---|
| `ensure_customer` | ✅ 2 (retrieve + create) | ✅ | explicit kwarg |
| `create_checkout_session` | ✅ 2 | ✅ | explicit kwarg |
| `create_payment_intent` | ✅ 1 | ✅ | via `**kwargs` dict |
| `list_payment_methods` | ✅ 1 | ✅ | explicit kwarg |
| `create_stripe_subscription` | ✅ 1 | ✅ | via `**params` dict |
| `cancel_stripe_subscription` | ✅ 2 | ✅ | explicit kwarg |
| `create_stripe_refund` | ✅ 1 | ✅ | explicit kwarg |

All 7 money-moving operations route to the tenant's connected account. A naive `'stripe_account=' in source` scan returns 0 for two of these because they build a dict and splat it — a scan that would have produced a false negative here and, on the earlier `f1940c7` version, would have been equally easy to misread.

**ID-2 detail (also newly closed):** `ff6b1a4` added outbound idempotency keys to three of four writes, all deterministic per business identity:

- `create_payment_intent` → `pi-{organization_id}-{invoice_id}`
- `create_stripe_subscription` → `sub-{organization_id}-{subscription_id}`
- `create_stripe_refund` → `rf-{organization_id}-{refund_id}`
- `create_checkout_session` → `cs-{org}-{invoice}-{uuid4().hex}` — **deliberately non-deterministic.** A fresh key per attempt means a retry creates a genuinely new Checkout session rather than replaying a possibly-expired one. That is a defensible choice for this resource, but it is a deliberate exception to the pattern and is commented as such.

---

## 6. Limits of This Verification

- **No live Stripe calls.** All Stripe interaction was via mocked SDK objects. Real connected-account behaviour, real dispute lifecycles, and real signature verification need the §19 test plan in `STRIPE_PLANE2_READINESS_REPORT.md` plus test credentials.
- **Migration state not exercised.** MIG-1 was assessed by reading migration code, not by running a migration against a pre-existing `stripe_events` table.
- **Diff-scoped reasoning corrected, once.** §1 documents where the brief's own method produced a wrong conclusion. That is flagged rather than quietly dropped, because the same trap — reading a single commit's diff as a statement about the branch — is the likeliest way this branch gets mis-assessed again.

---

## 7. Bottom-Line Verdict

`ff6b1a4` is a **well-executed hardening commit**. All seven of its claims are accurate against the code. Both specific risks called out in the brief — double-adjustment on dispute replay and payment-id contamination — are correctly guarded and covered by passing tests. The commit also closes ID-2, which the brief listed as open.

**GAP-1 is not the top-priority open item, and this report's central finding contradicts the brief it was written against.** Connected-account routing is implemented, gated fail-closed, and verified across all seven money-moving operations. It was closed by `f1940c7`, the commit immediately before this one on the same branch. Anyone acting on the brief's instruction to treat GAP-1 as the blocking item would be re-closing work that is already done, while the two items that genuinely would block a deploy — **MIG-1** (missing ALTER path for the new `correlation_id` column) and **REC-1** (no automated Stripe↔ledger reconciliation) — stayed unaddressed.

The correct next actions, in order: **MIG-1** (cheap, deployment-blocking), then **REC-1 full** (the one remaining HIGH functional gap), then **ENV-1** (trivial).

The single most valuable lesson from this exercise is procedural rather than technical: a per-commit diff cannot establish whether a branch-level gap is open. That determination needs the whole-branch cross-check performed in §4 and §5 — and the GAP-1 row in §16 of the readiness report should now be marked closed as of `f1940c7`.
