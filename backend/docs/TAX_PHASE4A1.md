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
