# Global Tax — Phase 4a-1: Provider Core (Outbox, Reconciliation, Fail-Closed)

The core of **ZB-TAX-ARCH-001** Phase 4, built to the approved plan in
`TAX_PHASE4_PLAN.md`. It is provider-neutral and runs against the fake only.

**Not switched on:**
- `PROVIDERS` is empty, there are no provider activations, and no
  credentials are stored.
- Native and tenant-config issuing is unchanged, apart from one thing:
  issuing now writes its status history and audit row in the same commit as
  the status change.

## What changed

| Area | Files |
|---|---|
| Adapter contract | `app/modules/tax/provider_contract.py`: `ProviderAdapter`, `ProviderCapabilities` (with `ESTIMATE_ONLY` / `COMMIT` mode), `ProviderTransaction` (state, totals, per-component amounts, tax date, currency), `ProviderTimeout`, `ProviderRateLimited`, canonical `REASON_CODES`, and the allowed payload fields. `engines.py` re-exports it. |
| Outbox and state machine | `provider_models.py` (`tax_provider_outbox`, `tax_provider_circuits`, `tax_job_heartbeats`) and `provider_issuance.py` (`ProviderIssuanceService`, `ProviderHealth`, `aggregate_health`, the locked-draft guard) |
| Reconciliation job | `reconciliation_runner.py`, started from the app lifespan. It has its own flag (`TAX_PROVIDER_RECONCILIATION_ENABLED`) and does not depend on `ENABLE_RECURRING_BILLING_SCHEDULER`. |
| Gate | `issuance_gate.py`: `prepare()` validates only. Provider quotes go to the outbox. `commit()` refuses a provider quote that has no remote commit. `apply()` stamps the committed tax date and currency. |
| Invoice issuing | `InvoiceService.complete_governed_issue()` is the single DRAFT→SENT unit. `finalize_invoice` and `send_invoice_via_email` route provider quotes through the outbox. Email returns `ISSUING` with no PDF or email until the invoice is SENT. |
| Determination | Provider errors and an open or suspended circuit give `PROVIDER_UNAVAILABLE`. Contradictions give `REVIEW_REQUIRED`. Canonical reason codes map to outcomes. |
| Operations | `GET /api/v1/super-admin/tax-registry/provider-health` returns aggregates only (`tax_registry.read` or `reliability.read`). `POST …/provider-health/{name}/suspend` and `…/resume` need `tax_registry.approve` and MFA step-up, and are audited. |
| T16 sources | `source_dependency_status` treats a source whose redistribution permission is DENIED as not approved. The pack resolver re-checks sources at use time. |
| Migration | `f2c7a9e1b4d3`: the three tables; the Postgres tenant record guard on the outbox (key fields frozen; delete only under the erasure flag); the terminal-state guard. `CRITICAL_COLUMNS` gains `tax_provider_outbox.idempotency_key`. Platform tables are excluded from the tenant purge. |

## The state machine

```
begin (T1)          PENDING ──commit ok──► REMOTE_COMMITTED ──T2 ok──► DONE (+ LINK row if key-only)
  kill switch,         │                         │
  estimate-only,       ├─timeout──► UNCERTAIN ───┤ (transaction_state first, never a blind retry;
  circuit, heartbeat   │                         │  NOT_FOUND → commit again with the same key)
                       ├─refused──► FAILED        ├─drift at commit──► REVIEW_REQUIRED
                       └─throttled → retry later  └─T2 fails: retry until the grace deadline,
                                                     then VOID by reference (only if never sent)
                                                     → VOIDED, or REVIEW_REQUIRED if a void
                                                     isn't possible
```

- **The key is fixed:** `zb:{org}:{invoice}:{quote}`.
- **One active COMMIT per invoice** (partial unique index).
- **While a row is active, the invoice is a locked DRAFT.** An ORM guard
  refuses any change to the invoice or its lines. Transaction 2 is the only
  writer.
- **The grace deadline** is `TAX_PROVIDER_GRACE_MINUTES` (default 15), never
  past quote expiry.
- **Drift after DONE:** the row can't change once DONE, so drift found
  later opens a tenant-private `PROVIDER_DRIFT` review item instead.

## Fail-closed defaults (configurable; ops/SRE agree them before gate 05)

| Setting | Default |
|---|---|
| Circuit opens | 5 failures in 60 s |
| Cool-down | 120 s |
| Reconciliation interval | 300 s |
| Heartbeat stale | 3 intervals |
| Grace | 15 min |
| Drift window | 24 h |
| Document reference | `key_only`, until the tax lead decides (see the plan) |

## Tests

| Test | Covers |
|---|---|
| `tests/test_tax_provider_conformance.py` (10) | The conformance suite in `tests/tax_provider_conformance/`, run against the fake: idempotent commit, `transaction_state` with totals, components and tax date, void by reference, a timeout is never success, retryable rate limits, decimal-exact signed money, minimal payload, no credential leaks |
| `tests/test_tax_phase4a_outbox.py` (31) | Happy path, with no customer identity in the payload. **T10:** timeout after success, timeout before success, duplicate delivery, a crash after transaction 1, after the remote commit, and during transaction 2. Locked draft. **Kill switch** at transaction 1 (nothing sent) and transaction 2 (held, then voided after grace). **Tax date** after local midnight. **Estimate-only** can never issue. Circuit breaker. Stale heartbeat. **T16** (provider suspended; source revoked). **REVIEW_REQUIRED** ×6 and a mapped reason code. Drift at commit and after DONE. **Invoice-number seam**, both options. **Email** waits for the provider. **T20** batch. Aggregate-only ops. Heartbeat. |
| `tests/privacy/test_tax_phase4a_provider_ops_access.py` (6) | Tax and operations roles get aggregates with no identifiers. Other roles are refused. Suspending needs the approve capability and step-up, and is audited. |
| `tests/test_tax_phase4a_pg.py` (6, Postgres only, in the CI tax step) | Tables and triggers exist; end to end on Postgres; frozen keys; terminal rows final; erasure-only delete; one active COMMIT per invoice; `SKIP LOCKED` |

The 3a T10 test now follows the outbox. A timeout leaves a locked DRAFT
rather than an error, and the next attempt checks the provider's state first.

**On `SKIP LOCKED`:** live two-connection concurrency isn't exercised here.
The Postgres test checks the generated `FOR UPDATE SKIP LOCKED` and runs the
real query. A two-worker race test belongs with the dedicated worker
(4d gate).

## Fixes after the post-merge review of PR #132 (PR "4a-1 fixes")

PR #132 was merged (6ef722c) and deployed with `f2c7a9e1b4d3` before review.
No provider activations exist, so production never reached this path. These
fixes follow the review.

| # | Fix | Tests |
|---|---|---|
| 1 | **Poison-row isolation.** `reconcile()` handles each row on its own. An unexpected error on one row moves that row to `REVIEW_REQUIRED` (`ROW_ERROR`, with the error), and the run continues. `stats.row_failures` counts these. The heartbeat is `last_ok=false` only for a job-level failure, such as the database being unavailable. | `test_fix1_one_broken_row_never_stops_the_run` (tenant A's row is broken, tenant B issues, heartbeat stays fresh); `test_fix1_job_level_failure_marks_the_heartbeat_not_ok` |
| 2 | **Refusal versus ambiguous.** `ProviderRefused` (validation, auth, unsupported; `ProviderRateLimited` is one) means `FAILED`. `ProviderAmbiguous` (5xx, a reset after sending; `ProviderTimeout` is one) and any unclassified error mean `UNCERTAIN`, settled by `transaction_state`. Both are in the contract and the conformance suite. | `test_fix2_*` (3); conformance `check_refusal_is_definite`, `check_ambiguous_errors_are_never_refusals` |
| 3 | **Deadlines before commit.** A PENDING row, or an UNCERTAIN row whose state lookup says NOT_FOUND, is never committed after quote expiry. It becomes `CANCELLED` (final): the invoice unlocks as a DRAFT, the quote goes STALE, and Exceptions shows a re-quote item. An UNCERTAIN row still unresolved by the grace deadline becomes `REVIEW_REQUIRED` (`UNRESOLVED_COMMIT`). It stays locked, appears in Exceptions with owner and age, and reconciliation keeps checking its state. Resolved COMMITTED, it is finished; resolved NOT_FOUND, it is cancelled. It is never voided blindly. | `test_fix3_*` (5, including a multi-hour outage where the commit did and did not land) |
| 4 | **Payload address.** The quote stores the place-of-supply address it was determined with (`tax_quotes.supply_address`), including the street lines and the role. Today the role is always `BILLING_FALLBACK`, because jurisdictions come from the billing address; ship-to and service-location precedence arrives with 4c. The payload sends exactly that address. `customer_tax_addresses` gains `line1` and `line2`, frozen like the other fields. The allowed-fields check stays. The registered-jurisdiction set is recorded in the plan for 4a-2. | `test_fix4_payload_sends_the_quoted_place_of_supply_address` |
| 5 | **Send intent.** When "send by email" returns ISSUING, the intent is stored on the outbox row. Transaction 2 creates an `EMAIL` row in the same commit as SENT. The email is sent once, outside the transaction, and the result is audited. The row is claimed before sending, so an interrupted attempt is never resent automatically (`EMAIL_UNCERTAIN` review). | `test_send_intent_is_emailed_exactly_once_after_issue`, `test_interrupted_email_is_never_resent_automatically` |
| 6 | **Unverified commit.** If the state lookup after a successful commit fails, the snapshot is stored as unverified (`verified_at` empty). Reconciliation verifies it, with the drift check, on the next run, whatever its age. A terminal row may record its verification and nothing else. | `test_fix6_unverified_commit_is_verified_regardless_of_the_drift_window` |

**Also changed:**
- **Locking:** a `REVIEW_REQUIRED` COMMIT row keeps the invoice locked, and
  issuing it again is refused until a person settles it. `LOCKING_OUTBOX_STATES`
  covers this.
- **Exceptions:** lists `PROVIDER_REVIEW_REQUIRED` and `ISSUING_OVERDUE` items
  with owner and age.
- **Invoice tax summary:** has an `issuance` block ("Issuing — waiting on
  provider"), and `can_issue` is false while a provider issue is open.

**Migration `a8d3e6f1c9b2`:**
- **New columns:**
  - outbox `verified_at`, `review_kind`, `send_intent`;
  - `tax_quotes.supply_address`;
  - `customer_tax_addresses.line1` and `line2`.
- **Postgres guards:**
  - The terminal guard now covers `CANCELLED` and lets a terminal row change
    only its verification fields.
  - The quote and address guards are recreated with the new frozen columns.
- **`CRITICAL_COLUMNS`** gains the new columns.

**Postgres tests added:** the new columns exist; a DONE row can only record
its verification; CANCELLED is final; the supply address and street lines are
frozen.

**CI result:** PR #133 passed on `6d48238`, push and pull request, with
`backend-tests` (including the Postgres tax step) and `frontend-tests` green.
It was merged as `54ae5d0`, whose files match `6d48238` exactly.

The first push, `7314cb6`, failed the full-suite release gate. The new fix-3
tests took their clock from module import time (`BASE`). In a full run they
start about 25 minutes after collection, so "+20 minutes" was already in the
past. `6d48238` makes the clock relative to the call, and the code under
test was unchanged.

The local full run on `6d48238` had 4943 passed, 54 skipped (Postgres-only)
and 1 failure: the known order-dependent `test_aggregate_cache.py`.

## Open, carried to 4a-2 / 4d

- **4a-2:**
  - the tenant view of provider transactions, and the Exceptions stuck view;
  - the invoice tax summary showing "Issuing — waiting on provider";
  - Provider Connections, credentials and `SecretStore`;
  - provider activations and nexus;
  - the certificate model;
  - corrections by reference (`adjust`);
  - product question 6.
- **4d gates:**
  - GCP Secret Manager;
  - a dedicated worker;
  - ops-agreed thresholds;
  - golden T06/T07 values against a sandbox;
  - the invoice-number decision;
  - the procurement items, including the account model.
