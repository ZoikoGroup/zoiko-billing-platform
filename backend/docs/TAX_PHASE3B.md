# Global Tax — Phase 3b: UK/Australia Packs, GOVERNED Enablement, Tax UX

This is the second half of **ZB-TAX-ARCH-001** Phase 3. It starts with the
3a follow-ups F1–F4, then adds:

- the first **native rule packs**: UK VAT and Australian GST, domestic
  standard-rated services only (§14 pilot);
- **two-person rule-pack approval** routes with an audit trail;
- **GOVERNED enablement** through `POST /regime`, only for an entity with a
  backed activation (T12);
- the **invoice editor tax panel** and **Taxes → Exceptions** (§11);
- tests T05, T12 and T14, the UX tests and the F1–F4 regressions.

**Still not switched on in production:**

- **Both packs are drafts.** Nothing registers or publishes them
  automatically. A pack is used only after a reviewer registers it, attaches
  golden tests and submits it, and the tax lead (a different person, with MFA
  step-up) approves and publishes it. See the sign-off checklist below.
- **No rate is published for GB-VAT or AU-GST.** The Phase 1 seed only
  *proposed* them, without a rate figure. Until the tax lead publishes a rate,
  a published pack still returns NOT_DETERMINED (`NO_APPROVED_RATE`).
- **Sources S11 and S16 have no captured evidence yet**, so validation
  refuses both packs today ("Source S11 is not approved").
- `LEGACY_MANUAL` invoicing is unchanged, apart from F2.

This is a bounded pilot. It is not global compliance, and it is not full
UK or Australian compliance either: everything outside the two packs'
declared coverage is NOT_DETERMINED.

**Branch:** `feature/global-tax`, the single branch used for all global-tax
work. **PR #131**, merged only after review.

## 3a follow-ups

| | Change | Regression tests |
|---|---|---|
| **F1** | `app/modules/tax/currencies.py`: a full ISO 4217 allowlist with minor units (List One, reviewed 2026-11; withdrawn codes left out). Governed quotes accept a currency only if it is listed with at most 2 minor units. Unknown, malformed, no-minor-unit (XAU, XDR), withdrawn (HRK) and 3/4-decimal codes (KWD, CLF, UYW) are `UNSUPPORTED`. | `test_unknown_invalid_or_over_two_decimal_currencies_are_unsupported` (10 codes, including the unknown `ZZZ`), `test_currency_allowlist_unit` |
| **F2** | The assistant's legacy issuance checks the finalization kill switch. While paused, the invoice stays a DRAFT and the action returns `invoice_draft_finalization_paused`. The line-items rule remains the open product question. | `test_f2_assistant_legacy_issue_obeys_the_finalization_kill_switch` |
| **F3** | The over-collection report includes fixed document discounts. Document discount = invoice `discount_amount` − line discounts (line discounts are applied before tax and don't over-collect). Estimate = `tax_amount × document discount / pre-discount subtotal`. Rows whose stored `discount_amount` lacks the document discount fall back to `discount_percentage`. The method note is updated; the platform view stays aggregate-only. | `test_f3_overcollection_includes_fixed_document_discounts` |
| **F4** | New `RoundingMode` (HALF_UP, HALF_EVEN, HALF_DOWN, UP, DOWN). Every engine declares a mode as well as a level, and packs must declare it. Governed rounding takes the mode as a required argument; an engine without one gets `UNSUPPORTED` / `ROUNDING_MODE_UNDECLARED`. Quotes store `rounding_mode`, and credits reuse the quote's mode. The tenant-config engine declares HALF_UP, matching the org's own billing arithmetic. | `test_f4_*` (5 tests, including a source scan for `ROUND_HALF_UP` / `round_money` in the governed modules) |

## Native rule packs

`app/modules/tax/rule_packs/`. A pack holds **no rate**. For each line it reads
the published registry rate (component, tax code `STANDARD`, product scope
`GENERAL`) that is valid on the tax date, and records that rate version on the
quote. The rate's source revision is reachable from that rate version. No
single published rate gives `NO_APPROVED_RATE`. Anything outside coverage
gives `OUTSIDE_PACK_COVERAGE`. Both are NOT_DETERMINED and block issue.

| | GB-VAT-DOMESTIC-SERVICES v1 | AU-GST-DOMESTIC-SERVICES v1 |
|---|---|---|
| Market | GB · VAT | AU · GST |
| Coverage | Seller entity established in GB; buyer billing address in GB; service lines whose tax code has registry scope `GENERAL`; GBP | Seller entity in AU; buyer billed in AU; same service rule; AUD |
| B2B / B2C | Both charged the standard rate (domestic). An unresolved buyer is treated as a consumer, so it doesn't block. | Same |
| Rate | Published `GB-VAT` STANDARD/GENERAL | Published `AU-GST` STANDARD/GENERAL |
| Required facts | The routing facts (`ROUTING_FACTS`) | Same |
| Rounding (proposed) | PER_LINE, HALF_UP | PER_DOCUMENT, HALF_UP |
| Source dependencies | S11 (HMRC) | S16 (ATO) |

**US and Canada** are specialist-provider markets (Phase 4). There is no
native Canada pack, Ontario included. A test asserts the only native markets
are GB VAT and AU GST.

**The rounding declarations are proposals.** The tax lead must confirm them
against HMRC and ATO guidance at sign-off. Neither guidance is in the source
register yet. A different answer is a new pack version, not an edit.

## Rule-pack approval (§09.2)

`RulePackService` reuses the Phase 2 maker-checker workflow (ApprovalService
self-approval guard, platform audit log, ORM and Postgres content guards).
Routes under `/api/v1/super-admin/tax-registry`:

| Route | Who | What |
|---|---|---|
| `GET /rule-packs/catalogue` | `tax_registry.read` | Packs in code, their declarations, and the live approval status of each source dependency |
| `GET /rule-packs` | `tax_registry.read` | Registry versions |
| `POST /rule-packs` `{code}` | `tax_registry.write` (TAX_REVIEWER) | Register a coded pack as a draft. Its declarations are **copied from code**, not typed in. |
| `PATCH /rule-packs/{id}` | `tax_registry.write` | Attach the golden-test report (`suite`, `commit`, `passed`, `failed`, `ci_run_url`) and notes |
| `POST …/validate`, `…/submit` | `tax_registry.write` | Submitting needs a reason |
| `POST …/approve`, `…/publish` | `tax_registry.approve` (TAX_PUBLISHER) + MFA step-up | Refused for the author or submitter |
| `POST …/reject` | `tax_registry.approve` | Needs a reason |

**Validation refuses:**
- declarations that no longer match the code;
- a missing rounding mode;
- any source dependency that is not approved (evidence captured *and*
  reviewed);
- a missing golden-test report, or one with failures or no commit.

The resolver uses a pack only when its row is `ACTIVE` and its rounding
declaration still matches the code. Draft, approved-but-unpublished and
drifted rows are ignored.

## GOVERNED enablement (T12)

`POST /api/v1/tax/legal-entities/{id}/regime` (org admin) accepts `GOVERNED`
only when the entity is active and has at least one effective, approved
activation **backed** by one of:

- a published rule pack (draft packs never qualify);
- an approved tenant-configured rate above zero;
- a configured provider (none exist yet).

The change bumps the entity version, which changes the context fingerprint,
so existing quotes go stale. It is written to the tenant audit log with the
backing activations. `GET …/regime-eligibility` now reports
`governed_available: true` and `backing_activations`.

**Not a route to GOVERNED:**
- the settings toggle (`update_entity` still refuses it);
- currency;
- the tenant's plan (billing classification).

A source scan asserts that `request_regime` is the only code that assigns
`GOVERNED`.

## Tax UX (§11)

**Read models** (`app/modules/tax/exception_service.py`). They are read-only
and tenant-scoped, and freshness uses the issuance gate's own checks (expiry,
context fingerprint, document hash):

- `GET /api/v1/tax/invoices/{id}/tax-summary` returns:
  - net, tax per component, gross and tax date;
  - the legal treatment and legal reason per line;
  - the engine label and each component's source (handoff ref, title, rate
    version);
  - quote freshness (`FRESH`, `STALE`, `EXPIRED`, `REFUSED`, `NONE`,
    `COMMITTED`) and blocking reasons, each with an owner and a resolution;
  - `can_issue`.
- `GET /api/v1/tax/exceptions` lists every governed draft that can't be
  issued, with the reason, the missing facts (each with an owner), the
  responsible owner and resolution, and the re-quote call
  (`POST /api/v1/tax/quotes`).

**Frontend:**
- `GovernedTaxPanel` on the invoice detail page. It renders nothing for
  legacy invoices.
- The **Taxes → Exceptions** page (`/billing/tax/exceptions`, in the Tax
  menu).
- The quote request sends a fresh `Idempotency-Key`.

**Accessibility (WCAG 2.2 AA):**
- Every status is an icon (`aria-hidden`) plus a text label, never colour
  alone.
- Blocking reasons are an `alert` region, and the re-quote result is
  announced through a polite live region.
- Tables have captions and column headers.
- Context warnings sit behind progressive disclosure.

**Owners:**

| Owner | Covers |
|---|---|
| Billing admin | Classification, customer address or tax ID, document edits, re-quote |
| Organization admin | Entity, registrations and activations |
| Zoiko tax team | No published rate, outside pack coverage, registry gaps |

## Behaviour change: routing refusals name the real cause

When no engine applies (for example, every activation stopped being effective
because its registration expired), a quote used to report "buyer status
unresolved". Buyer status now blocks only when an engine applies and that
engine lacks a consumer rule. The refusal is `NOT_DETERMINED`, carrying the
routing problem and the activation issues (such as the expired registration).
It is still refused; only the explanation changed. 3a's T08 tests are
unchanged and pass.

## T14: expiry triggers review and blocks issue

`test_t14_expired_registration_blocks_issue_and_raises_an_exception`:

1. Quote, then end the registration before the tax date.
2. The editor panel shows STALE, and the draft appears in Exceptions as
   `QUOTE_STALE`.
3. Issue is blocked.
4. Re-quoting gives `NOT_DETERMINED`, owned by the organization admin, with
   the registration reason listed.
5. Issue is still blocked, and the invoice stays a DRAFT.

`test_t14_expired_quote_blocks_and_is_listed` covers quote expiry.
Certificate expiry has no 3b pack consumer: domestic standard-rated services
take no exemption certificates, so it applies with Phase 4 provider markets.

## Migration — `e4b8c1d6f2a9`

- `tax_quotes.rounding_mode` is added. Existing determined quotes are
  backfilled with `HALF_UP`, the mode Phase 3a always used. The VOIDED status
  guard is paused only for that one statement.
- `tax_rule_pack_versions` gets `rounding_mode` (NOT NULL; the default is
  dropped after the add) and `required_facts`, `coverage` and
  `source_dependencies` (JSON).
- **Postgres guards:**
  - The `tax_quotes` guard is recreated with `rounding_mode` frozen.
  - The rule-pack guard function now freezes the new declarations once a
    version is submitted.
- **Downgrade** restores the 3a guards and drops the columns.
- `CRITICAL_COLUMNS` gains `tax_quotes.rounding_mode` and
  `tax_rule_pack_versions.rounding_mode`.

## Test evidence

| Suite | Before (3a) | After |
|---|---|---|
| Backend local (venv, SQLite) | 1854 passed, 2 failed*, 39 skipped | 4881 passed, 2 failed*, 44 skipped |
| Backend CI (postgres:16, tax step incl. `test_tax_phase3b_pg.py`) | passed | passed on `c0c7005` (push and PR #131) |
| Frontend (vitest) | 1242 passed | 1255 passed; CI passed on `c0c7005` (push and PR #131) |

**New tests:**
- `tests/test_tax_phase3b_packs.py`: pack scope and declarations, two-person
  review and audit, unapproved source, draft never used, T12 ×2, T05 ×2,
  outside coverage ×5, Australia ×2, T14 ×2, read models ×5.
- `tests/test_tax_phase3b_pg.py` (Postgres only): columns, UK end to end,
  frozen `rounding_mode`, frozen pack declarations.
- F1–F4 regressions in `tests/test_tax_phase3a_governed.py`.
- `frontend/src/modules/billing/tax/governed-tax.test.jsx`: the fresh,
  blocked, stale, NOT_DETERMINED and legacy panel states, status badges with
  text and icon, and Exceptions list, re-quote and error.

**Changed tests:**
- `test_governed_regime_needs_an_activation_backed_by_a_published_pack`
  replaces the Phase 2 "refused even when eligible" test.
- The 3a Postgres rule-pack insert now supplies `rounding_mode`.

\* `test_aggregate_cache.py`, pre-existing and order-dependent (Phase 1
finding 7); it passes 22/22 run alone on this tree.

The first push (`16d92ce`) failed one CI check: the 3a Postgres test inserted
a rule-pack row without the now-required `rounding_mode`. Fixed in `c0c7005`.

## Draft-pack sign-off checklist (tax lead)

Work through this for each pack before publishing it. The reviewer and the
tax lead must be different people.

**GB-VAT-DOMESTIC-SERVICES v1**

- [ ] **Source S11 approved.** Capture the HMRC page as evidence (it is
      server-hashed) and review it. S11 does not itself state the standard
      rate; it links to `https://www.gov.uk/vat-rates`. Either confirm S11
      is enough, or register that page as a new source entry and add it to
      the pack (a new pack version).
- [ ] **Rate published.** Publish the GB-VAT STANDARD / GENERAL rate through
      the Phase 1 pipeline, with `valid_from` taken from the legal
      instrument.
- [ ] **Coverage confirmed:**
  - [ ] seller entity established in the UK;
  - [ ] buyer billed in the UK;
  - [ ] standard-rated services only;
  - [ ] GBP only;
  - [ ] everything else NOT_DETERMINED.
- [ ] **Treatment confirmed.** Domestic B2B and B2C are charged identically,
      and an unresolved buyer is treated as a consumer.
- [ ] **Rounding confirmed.** PER_LINE + HALF_UP, checked against HMRC
      rounding guidance. If not confirmed, a new pack version declares the
      approved mode.
- [ ] **Market availability:** GB · VAT · B2B_SERVICES and B2C_SERVICES set
      to `NATIVE_RULEPACK_APPROVED`, with all mandatory gates PASSED.
- [ ] **Golden tests reviewed:**
  - [ ] T05 (£100 net → £20 VAT → £120 gross, rate and source version
        preserved);
  - [ ] B2B/B2C;
  - [ ] outside coverage;
  - [ ] T14.
  - [ ] The CI run is attached as the golden-test report (commit, passed,
        failed = 0, run URL).
- [ ] **Two-person flow:** a TAX_REVIEWER registers and submits; the tax lead
      (TAX_PUBLISHER) approves and publishes with MFA step-up.

**AU-GST-DOMESTIC-SERVICES v1**

- [ ] **Source S16 approved.** Its cited URL refused automated retrieval
      (HTTP 403, and it is an API endpoint). Capture the corresponding
      public ATO page manually and review it.
- [ ] **Rate published:** the AU-GST STANDARD / GENERAL rate, with
      `valid_from` from the legal instrument.
- [ ] **Coverage confirmed:**
  - [ ] Australian seller entity;
  - [ ] buyer billed in Australia;
  - [ ] taxable supplies of services;
  - [ ] AUD only;
  - [ ] everything else NOT_DETERMINED.
  - [ ] Also confirm GST-free and input-taxed supplies are out of scope
        (they are NOT_DETERMINED, not 0%).
- [ ] **Rounding confirmed.** PER_DOCUMENT + HALF_UP (whole-invoice), checked
      against ATO rounding rules.
- [ ] **Market availability:** AU · GST · B2B_SERVICES and B2C_SERVICES set
      to `NATIVE_RULEPACK_APPROVED`, with gates PASSED.
- [ ] **Golden tests reviewed:** the AU 10% per-document case and outside
      coverage; the CI run is attached.
- [ ] **Two-person flow**, as above.

## Findings

1. **CI does not run on `main`.**
   - `ci.yml` skips pushes to `main`, and `deploy.yml` deploys `main` with no
     test step. So a merge commit is never tested itself. It is only covered
     by the PR's `pull_request` run on the merged tree.
   - For PR #130 the trees were identical (`c9aad79` = `83e1dba`).
   - **Recommendation:** branch protection requiring the PR checks, or a test
     job that `deploy` waits for.
2. **A GOVERNED entity can be switched back to LEGACY_MANUAL from settings.**
   `update_entity` refuses only *enabling* GOVERNED. Leaving it needs a
   decision: should it be blocked, or go through approval?
3. **S11 does not state the UK standard rate** (finding 3 of Phase 1). See
   the checklist.
4. **S16's cited URL cannot be fetched automatically.** See the checklist.

## Open product questions

These stay with the product owner, from 3a:

1. Legacy quote → invoice re-pricing.
3. Governed subscriptions: plans have no product or tax code.
4. Legacy assistant issuance and the **line-items rule**. The kill-switch
   half is fixed by F2.
5. Duplicate-row cleanup approval.

New in 3b:

6. Should leaving GOVERNED need approval (finding 2)?

**Production report figures** come from the product owner's team.

## Next: Phase 4

- Specialist-provider markets (US, Canada) through the provider interface and
  the outbox seam.
- Certificate-driven exemptions (the rest of T14).
- The tax lead's sign-off on the two packs, which is outside the code.
