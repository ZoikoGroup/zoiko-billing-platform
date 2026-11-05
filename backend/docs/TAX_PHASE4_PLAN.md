# Global Tax — Phase 4 Plan: Specialist Tax Providers

The approved plan for **ZB-TAX-ARCH-001** Phase 4, including the reviewer's
changes and answers (2026-11-05). It is provider-neutral: no provider has
been chosen, and contract and sandbox status are unknown.

Phase 4 merges with **no activations**. A market goes live only through
launch gates 01–07 (§13.2), including gate 05 (provider contract, SLA and
recovery) and tax/legal sign-off.

**Branch:** `feature/global-tax`, rebased on `main` before each round. One PR
per sub-phase, and each stops for review.

## Sub-phases

| Sub-phase | Delivers | Exit |
|---|---|---|
| **4a-1 core** | Adapter contract and conformance suite, transactional outbox, issuance state machine, reconciliation job with heartbeat, circuit breaker, fail-closed checks, T10, T16, T20, Postgres tests | All pass against the fake |
| **4a-2 admin and UI** | Provider Connections and credentials, provider activations and nexus checks, exemption-certificate model, corrections by reference, product question 6, stuck-transaction view, frontend tests | All pass against the fake |
| **4b Canada** | GST, HST, PST and QST through the provider; place of supply | T06 **plumbing only** (see below) |
| **4c US** | `AddressResolver` to district level, state registrations and nexus, certificates in use | T07 **plumbing only**, T14 |
| **4d real adapter** | The provider's adapter; conformance against its sandbox | Conformance passes; T06/T07 against the sandbox with the tax lead's golden values |

**T06 and T07 in 4b/4c are plumbing tests.** They prove routing,
components and blocking against the fake. Their expected values are not
legal answers. They count as passed for the gate only in 4d, run against a
sandbox, with golden expected values supplied by the tax lead. Nothing in
4b/4c invents expected tax values.

## Adapter contract (4a-1)

`ProviderAdapter` (extends the 3a interface; independent of the payment
processor, §16):

| Method | Contract |
|---|---|
| `capabilities()` | Markets and tax types, address validation, exemptions, void/adjust support, rate limits, and the mode (`ESTIMATE_ONLY` or `COMMIT`) |
| `determine(request)` | A non-binding estimate. Returns lines, components and the jurisdictions applied. Per line it also returns the provider's tax date, currency and total, plus a canonical reason code when tax is zero. |
| `commit(idempotency_key, payload)` | Returns the provider transaction id. May raise `ProviderTimeout` (outcome unknown). |
| `transaction_state(idempotency_key)` | **State plus the provider's document totals, per-component amounts, tax date and currency** (change 1), used by the drift check |
| `void(transaction_id, idempotency_key, reason)` | Compensation and cancellation by reference |
| `adjust(...)` | Returns and credits by reference (4a-2) |
| `health()`, `test_connection()` | Used by Provider Connections (4a-2) |

**Reason codes** (change 6): adapters map provider codes to canonical
codes. The service maps those to outcomes:

| Canonical code | Outcome |
|---|---|
| `EXEMPT` | EXEMPT |
| `ZERO_RATED` | ZERO_RATED |
| `NON_TAXABLE` | NON_TAXABLE_BY_RULE |
| `BELOW_THRESHOLD` | NON_TAXABLE_BY_RULE |
| `REVERSE_CHARGE` | REVERSE_CHARGE |
| `OUT_OF_SCOPE` | OUT_OF_SCOPE |
| Unknown code, or zero tax with no code where we hold a registration | `REVIEW_REQUIRED` |

**Conformance suite** (`tests/tax_provider_conformance/`). It takes any
adapter as input and runs against the fake now. It checks:
- idempotent commit;
- `transaction_state` reflects the last commit or void, with totals,
  components and tax date;
- void by reference;
- a timeout is reported as `ProviderTimeout`, never as success;
- decimal-exact money with signs preserved, and components reconcile to
  the cent;
- the jurisdictions applied are reported;
- rate limits are surfaced as retryable;
- credentials never appear in exceptions or logs;
- the payload contains only allowed fields.

## Outbox and issuance state machine (4a-1)

Only quotes from a provider engine use the outbox. Native and tenant-config
issuance is unchanged.

1. **Transaction 1.**
   - **Kill switch** `TENANT_INVOICE_FINALIZATION` is checked first
     (change 2).
   - The quote is validated: expiry, fingerprint and document hash.
   - **Refusals:**
     - **Estimate-only** connections are refused (change 5).
     - An open circuit or a stale reconciliation heartbeat gives
       `PROVIDER_UNAVAILABLE`.
   - **Writes, one database transaction:**
     - the invoice becomes a **locked DRAFT**;
     - one outbox row (`COMMIT`) is written with a fixed key,
       `zb:{org}:{invoice}:{quote}`;
     - the quote's remote state becomes `PENDING`.
2. **Deliver.** One inline attempt is made, then the worker takes over.
   The row is locked (`FOR UPDATE SKIP LOCKED` on Postgres).
   - **Success:** `REMOTE_COMMITTED`, storing the provider's totals.
   - **Timeout:** `UNCERTAIN`. A timed-out commit is **never retried**:
     the next attempt calls `transaction_state(key)` first.
   - **Definite failure:** the quote becomes `PROVIDER_UNAVAILABLE` and the
     invoice unlocks.
3. **Transaction 2.**
   - **Kill switch** is checked again (change 2).
   - The quote is applied.
   - **The tax date and currency stamped are the committed quote's**, never
     the time transaction 2 runs (change 3).
   - The invoice becomes SENT, the quote COMMITTED, and the outbox row DONE.
   - Email and PDF are sent only after this.
4. **Compensation** (Q5).
   - Transaction 2 is retried within a grace window: configurable, default
     15 minutes, never past quote expiry.
   - After that, the provider transaction is **voided by reference**, but
     only if the invoice was never sent anywhere.
   - Otherwise the row becomes `REVIEW_REQUIRED` and goes to Exceptions.

**What the user sees** (Q4): issuing can return "Issuing — waiting on
provider", shown with an icon and text. The invoice stays a locked DRAFT
with no email or PDF. If it is still unresolved after the grace window, it
goes to Exceptions with an owner.

**An invoice can never reach SENT from a provider quote without a remote
commit.** Estimate-only mode can quote but never issue (change 5).

### Invoice number: two options (change 4, for the tax lead)

The seam supports both. The setting is `TAX_PROVIDER_DOCUMENT_REFERENCE`,
defaulting to `KEY_ONLY` until the tax lead decides.

| | A — `INVOICE_NUMBER` | B — `KEY_ONLY` |
|---|---|---|
| What is sent | The invoice number, as reserved in transaction 1, becomes the provider's document code | Only our idempotency key; the number is linked afterwards (`LINK` outbox step) |
| Provider records | Show our invoice number from the start | Show the key until linked |
| When an attempt is voided | The provider holds a voided document with that number, and many providers refuse to reuse a code. A retry would need a suffixed code (`INV-123-R1`), or the number is burned and the invoice renumbered. A gap or suffix appears in provider-side numbering. | Nothing is burned: the next attempt uses a new key, and the invoice number is linked only to the committed transaction |
| Risk | Number gaps or suffixes, depending on provider rules | A short window where the provider transaction has no invoice number; linking can fail and needs reconciliation |

Our own invoice numbering never changes because of a voided attempt: the
draft keeps its number.

## Reconciliation (4a-1)

- **Own job registration**, independent of
  `ENABLE_RECURRING_BILLING_SCHEDULER` (Q9). It has its own flag,
  `TAX_PROVIDER_RECONCILIATION_ENABLED`, and its own interval (default
  5 minutes).
- It writes a **heartbeat** row every run.
- **If the heartbeat is stale** (older than 3 intervals), provider issuing
  is blocked with `PROVIDER_UNAVAILABLE`. Without reconciliation we can't
  issue safely.
- **Each run:**
  - resolves `PENDING` and `UNCERTAIN` rows (state lookup first);
  - finishes or compensates `REMOTE_COMMITTED` rows;
  - runs the **drift check** on recently committed rows: our committed
    totals, components and tax date against `transaction_state`. A mismatch
    becomes `REVIEW_REQUIRED`.
- **A dedicated worker process is a 4d gate.**

## Fail closed (4a-1)

- **Provider error, timeout during an estimate, open circuit or stale
  heartbeat:** `PROVIDER_UNAVAILABLE`. Drafts are allowed; issuing is
  blocked. There is no fallback to a native pack, a last-known rate or zero.
- **Circuit breaker:** stored in the database per provider. Defaults are 5
  failures in 60 s, then a 120 s cool-down. Values are configurable; ops/SRE
  agree on them before go-live (gate 05).
- **`REVIEW_REQUIRED` when the provider contradicts our context:**
  - jurisdictions outside our recorded registrations or obligations;
  - zero tax with no or an unknown reason code where we hold a
    registration;
  - a tax date or currency different from what we sent;
  - components that don't sum to line totals.
- **T16:**
  - **A suspended provider** (contract ended, credentials revoked) freezes
    with `PROVIDER_UNAVAILABLE` and no coverage claim.
  - **A registry source whose redistribution permission is DENIED** stops
    every pack that depends on it from resolving, giving NOT_DETERMINED.
    GOVERNED eligibility drops that backing.

## Operations visibility (change 8, T13)

- **Tenants** see their own provider transactions (4a-2 view).
- **Platform operations** get aggregate health only:
  - counts per outbox state;
  - the oldest age;
  - circuit state per provider;
  - heartbeat age.
- There are no org, invoice or customer identifiers. A test asserts the
  response contains none.

## Credentials and secrets (Q3, 4a-2)

- A `SecretStore` interface, with an interim Fernet envelope implementation
  through 4c.
- A **dedicated key** `TAX_PROVIDER_ENCRYPTION_KEY`, separate from MFA, with
  a written rotation procedure.
- **GCP Secret Manager is a 4d gate:** no production credential is stored
  until it exists (Security provisions it).
- Credentials are never logged or returned.

## Data sent to the provider (minimized)

| Field | DPO review |
|---|---|
| Idempotency key / quote ref; document type, tax date, currency | No |
| Seller: country, subdivision, registration numbers for the requested jurisdictions | No |
| Seller ship-from address | Yes, if it is a sole trader's home |
| Buyer ship-to / place-of-supply address (validated) | **Yes** |
| Buyer tax ID, only when business status matters | **Yes** |
| Pseudonymous customer reference: an HMAC with a **stable per-tenant key** (change 9) | **Yes** |
| Exemption certificate id, jurisdiction, reason (US) | **Yes** |
| Line id, quantity, net, discounts, provider tax code, inclusive flag | No |
| Invoice number, only under option A | No |

**Never sent:** customer name, email or phone; product names or
descriptions; notes or other free text; payment data; user identities;
PDFs.

**Pseudonymous reference key (change 9).** Rotating it needs a remapping
step that re-registers every customer reference and certificate at the
provider. Without it, exemption matching breaks. This is part of the
rotation procedure.

**Also for the DPO:** response storage; residency; retention versus erasure
(still open from Phase 2).

**Payload additions (4a-2).**
- The commit payload already carries the quote's place-of-supply address,
  with street lines and role (4a-1 fix 4).
- 4a-2 adds the **registered-jurisdiction set**: the jurisdictions where the
  entity holds a recorded registration or obligation. The provider can then
  only apply tax inside that set, and anything outside it stays
  REVIEW_REQUIRED.

## Exemption certificates (model 4a-2, used 4c)

- **Ours is the source of truth** (Q6). A provider's certificate store, if
  any, is a synced copy.
- **The record** is tenant-private: customer, jurisdiction, tax type,
  reason, number, valid-from and expiry dates, status, and a hashed,
  write-once evidence file.
- **Expired or missing** means review and block (T14), never an automatic
  0%.
- T13 applies.

## Corrections (4a-2)

Credit notes and refunds create an `ADJUST` outbox row, and cancellation a
`VOID` row, each referencing the original provider transaction. They go
through the same state machine and reconciliation (T15, T18).

## Product question 6 (4a-2)

**Working assumption until the product owner answers:** leaving GOVERNED
goes through `POST /regime`, with the same two-person approval and audit as
enabling it. The settings toggle refuses both directions. Issued invoices
and committed quotes are never altered.

## Addresses (4c)

- An `AddressResolver` interface, **separate from the tax-provider
  adapter**. Procurement decides whether the same vendor provides it.
- **US:** a ZIP or ZIP+4 alone never resolves a jurisdiction. An ambiguous
  match means `NEEDS_EVIDENCE` and a block (T07). We record the source and
  confidence.

## Procurement checklist (before 4d)

1. Provider and contract status.
2. Sandbox credentials and how they are issued.
3. API scope and version; licensed endpoints (calculate, commit, void and
   return, address validation, certificates).
4. Rate limits, quotas and batch limits.
5. Response-storage rights and retention.
6. Data residency, processing locations, sub-processors, DPA.
7. SLA: availability, latency, support, incident notice, maintenance.
8. Idempotency guarantees, and lookup by our key.
9. Void, return and adjust semantics and time limits.
10. Liability for calculation errors.
11. **Account model:** Zoiko master account with tenant sub-accounts, or
    per-tenant accounts. This decides who the data processor is.

## 4d gates recorded

- GCP Secret Manager in place.
- A dedicated reconciliation worker.
- Ops/SRE-agreed circuit-breaker and reconciliation values.
- T06/T07 golden values from the tax lead, run against the sandbox.
- Provider contract (gate 05).
- The tax lead's decision on the invoice number option.

## Tax Control Center UI (proposal: estimate only, not built until approved)

**Today:**
- The governed-tax frontend has two pieces: the invoice tax panel and
  Taxes → Exceptions.
- Every setup step is API-only: the platform registry and the tenant's
  tax set-up.
- The APIs already exist. Each screen below names the routes it uses, and
  backend gaps are listed separately.

The Tax Control Center maps to handoff §11 in two parts. Both follow §11.1:
- Default to the user's legal entity and enabled jurisdictions; no global
  rate catalogue forced on tenants.
- Progressive disclosure.
- Side-by-side revision review, without implying a draft is final.
- Status is never shown by colour alone (WCAG 2.2 AA).
- No tenant data in platform views.

### Part 1: Platform tax-ops console (`/super-admin/tax`)

**Who:** TAX_REVIEWER (maker) and TAX_PUBLISHER (checker and tax lead).
Operations roles (`reliability.read`) see the provider health view only.

**Rules:**
- **Maker-checker:** the server refuses self-approval. The UI hides
  Approve and Publish on anything you authored or submitted, and explains
  why.
- **MFA step-up:** a modal before every approve, publish, suspend or resume
  (the existing `code` / `recovery_code` fields).
- **No tenant data on any screen:** only aggregates for reports and
  provider health.

| # | Screen (§11 destination) | Content and actions | APIs (existing) | Sign-off |
|---|---|---|---|---|
| P1 | Overview (Taxes → Overview, platform side) | Registry readiness; queues awaiting *my* action; provider health summary; last refresh and provenance | `GET /readiness`, `/provider-health`, the list endpoints below | |
| P2 | Source register | Source revisions per authority and handoff ref; register a revision; **evidence capture** (upload, server SHA-256 shown, redistribution permission); revoke (a new revision with DENIED); "reference only" badges | `GET/POST /source-revisions`, `POST /source-revisions/{id}/evidence`, `GET /api/v1/tax/source-revisions/{id}` | **Yes** (S11, S16) |
| P3 | Rates and change review (Jurisdictions & Rates; Change Review) | Staged rates; stage, amend, adopt (AI proposals), validate, submit, approve or reject, publish. **Old and new side by side**: effective date, authority citation, conflict and escalation alerts, future-effective timeline. | `/staged-rates` and its actions | **Yes** (GB/AU rates) |
| P4 | Jurisdictions & rates explorer | Country and subnational explorer: status, tax type, product scope, from/to dates, official source, reviewer, `as_of` / `known_at` time travel, "reference only" badge | `GET /api/v1/tax/jurisdictions`, `/rates` | |
| P5 | Tax-code catalogue | Code-set versions; code editor (supply category, registry scope); validate, submit, approve, publish; diff against the active version | `/tax-code-sets` and its actions | |
| P6 | Market availability | Matrix of jurisdiction × tax type × transaction class with the mode; the seven launch gates per cell, with evidence refs and notes; validate, submit, approve, publish | `/market-availability` and its actions | **Yes** (gates for GB/AU) |
| P7 | Rule packs | Catalogue (the declarations in code); register; attach the golden-test report; source-dependency status (live); validate, submit, approve, publish; **the TAX_PHASE3B sign-off checklist shown next to the pack** | `/rule-packs`, `/rule-packs/catalogue` and actions | **Yes** |
| P8 | Approvals inbox | Everything IN_APPROVAL across rates, code sets, availability and packs; "submitted by you" items read-only; audit trail per item | the list endpoints today; one combined endpoint (gap B1) | **Yes** |
| P9 | Provider operations | Counts per state, oldest age, circuit, heartbeat; suspend or resume with a reason and MFA | `/provider-health` and suspend/resume | |
| P10 | Findings reports (aggregate) | Over-collection and duplicate rows, totals only | `/reports/*` | |

### Part 2: Tenant Settings → Taxes (`/billing/settings/taxes`)

**Who:** org_admin and billing_admin propose; finance_approver approves. A
different user must approve: the server enforces it, and the UI hides
Approve on your own proposals. Only tenant users have access; super-admins
are refused (T13).

| # | Screen (§11 destination) | Content and actions | APIs (existing) |
|---|---|---|---|
| T1 | Overview (Settings → Taxes → Overview) | Seller-entity switcher; regime and eligibility checklist; supported jurisdictions and activations; registration status and expiries; open review items (T14); Exceptions count; last refresh and provenance | `/legal-entities`, `/regime-eligibility`, `/activations`, `/registrations`, `/review-items`, `/exceptions` |
| T2 | Legal entities | Entities, default entity, jurisdiction-locked fields explained | `/legal-entities` (existing CRUD and set-default) |
| T3 | Entity registrations (Entity Registrations) | Registrations (number, validity, verification, evidence ref); legal bases (propose, approve, reject, withdraw); certificate references; private and scoped to the entity | `/registrations`, `/legal-bases` and actions |
| T4 | Activations | Propose per market (only the modes the platform offers, with the reason shown); approve, reject, withdraw; effective-state viewer by date | `/activations` and actions, `/activations/{id}/effective` |
| T5 | Regime | Eligibility checklist; request GOVERNED; leave GOVERNED with two-person approval (product question 6, built in 4a-2) | `/regime-eligibility`, `POST /regime` |
| T6 | Product classification (Product Classification) | Products to tax codes with the review queue, owner, change history; **bulk impact preview** before approving | `/tax-codes`, `/product-classifications`, `/impact-preview`, actions |
| T7 | Customer tax evidence (in the customer profile) | Tax addresses with street lines and role; tax IDs with verification and retire; exemption certificates (used in 4c) with revoke | `/customers/{id}/tax-evidence`, `/tax-addresses`, `/tax-ids`, `/exemption-certificates` |
| T8 | Review items (T14) | Expiring and expired registrations, certificates and tax IDs; provider drift items; resolve | `/review-items`, `/resolve` |
| T9 | Reference rates (read-only) | Jurisdictions & Rates for the entity's enabled jurisdictions only, with a "reference only" badge | `/jurisdictions`, `/rates` |
| T10 | Reports | Tenant over-collection and duplicate-row detail | `/reports/*` |
| — | Exceptions, invoice tax panel | Already built (3b); the provider-transactions view and Provider Connections come in 4a-2 | |

### Backend gaps found while mapping

| Gap | Size |
|---|---|
| **B1** Combined approvals-inbox endpoint (IN_APPROVAL across version types, maker flagged); optional, since the console can merge the lists | ≈ 0.5 d |
| **B2** Jurisdictions, authorities and components have no create or amend API (seed script only). New markets need either an admin API with maker-checker or a reviewed seed. Not needed for the GB/AU sign-off. | ≈ 2 d (if wanted) |
| **B3** List endpoints have no pagination (fine at today's volumes) | ≈ 0.5 d |

### Sign-off subset: schedule early

The tax lead's pack sign-off (TAX_PHASE3B checklist) needs only platform
screens:
- **Shared foundations:** console shell, capability-aware navigation, the
  MFA step-up modal, a maker-checker action bar, and a version timeline
  with audit.
- **Screens:** P2 Source register, P3 Rates, P6 Market availability,
  P7 Rule packs, P8 Approvals inbox.

This subset can ship as its own PR before 4a-2, so the UK and Australia
packs can be signed off while 4a-2 is built. **A pilot tenant switching to
GOVERNED** additionally needs T2–T7, or the API meanwhile.

### Estimates (frontend engineering days; tests and accessibility included)

| Block | Days |
|---|---|
| Shared foundations (console shell and navigation, MFA step-up modal, maker-checker action bar, version and audit timeline, status badges) | 5 |
| **Sign-off subset:** P2 (2.5), P3 (4.5), P6 (3), P7 (3), P8 (2 incl. B1) | **15** |
| Rest of the console: P1 (1.5), P4 (2), P5 (2.5), P9 (1), P10 (0.5) | 7.5 |
| Tenant shared components (propose/approve bar, "not your own" hints, entity switcher) | 2 |
| Tenant screens: T1 (2.5), T2 (1.5), T3 (3), T4 (3), T5 (1.5), T6 (3.5), T7 (3), T8 (1), T9 (1), T10 (1) | 21 |
| Docs and an end-to-end walkthrough of the sign-off path | 1.5 |
| **Total** | **≈ 52** (sign-off subset with foundations ≈ **20**) |

B2 is excluded. Each block is one PR on `feature/global-tax`, stopping for
review.

**Proposed order** (for decision):
1. Sign-off subset (≈ 20 d).
2. 4a-2.
3. Tenant screens T1–T7.
4. Rest of the console.

## Estimates (engineering days)

| Sub-phase | Days |
|---|---|
| 4a-1 | ≈ 11 |
| 4a-2 | ≈ 8 |
| 4b | ≈ 6 |
| 4c | ≈ 12 |
| 4d | ≈ 8–10 per provider |
