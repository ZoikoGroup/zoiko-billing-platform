# Global Tax — Phase 3a: Governed Determination Contract

This is the first half of **ZB-TAX-ARCH-001** Phase 3: §08 (determination,
status model, stop conditions) and §09 (quote/commit contract, provider
lifecycle). It adds:

- governed tax **quotes**;
- **immutable snapshots** committed at issuance;
- an **issuance gate** on every DRAFT → SENT path;
- **credit notes** built from the original snapshot;
- a provider adapter interface with a Phase 4 outbox seam.

**Still not switched on:**

- `GOVERNED` stays refused by the API until 3b, which brings the invoice
  editor that shows blocking reasons. 3a code paths run only for entities
  whose regime is already GOVERNED (tests set it directly).
- No real market rule pack exists. Golden tests use a **test-only fixture
  pack** under `tests/fixtures/`.
- `LEGACY_MANUAL` invoicing is unchanged, apart from the agreed fixes (a)–(c)
  below.

## What changed

**Tenant tables** in `app/modules/tax/quote_models.py`. Every row carries
`organization_id` and is retained like the Phase 2 records:

| Table | Purpose |
|---|---|
| `tax_quotes` | One quote per determination request, keyed by document type and id. |
| `tax_quote_lines` | Per line: taxable base, legal outcome (`TaxOutcome`), explanation code, legal reason, effective rate. |
| `tax_quote_components` | Per line component: rate source (registry / tenant config / provider), rate version or activation, rate, tax. |
| `credit_note_tax_lines` | Governed credit notes. Each row reverses one snapshot component, with **signed** amounts. |
| `invoices.tax_quote_id` | The committed quote, i.e. the invoice's tax snapshot. |

What `tax_quotes` records:

- status, engine kind, name and version, and rounding rule;
- currency and its minor units, tax date and pricing mode;
- the context fingerprint and document hash;
- request hash and idempotency key;
- totals, unrounded and rounded;
- blocking issues and warnings, plus any refusal code and reason;
- provider remote-commit state;
- expiry, validation, commit and void timestamps.

**Platform table:** `tax_rule_pack_versions` registers approved native
rule-pack versions. It is empty in 3a; packs and their approval routes arrive
in 3b. The engine resolver uses a pack only when **both** its code is
registered in `engines.RULE_PACKS` (empty in 3a) **and** its row is ACTIVE.

**Services**

| File | Role |
|---|---|
| `engines.py` | The `TaxEngine` contract. Each engine declares its required facts, rounding rule and consumer-treatment flag. It contains `TenantConfigEngine`, `RulePackEngine` / `RulePack`, `ProviderAdapter` / `ProviderEngine` and `EngineResolver` (with injectable lookups). |
| `determination_service.py` | Creates quotes. Owns the single money path and the governed currency rules. |
| `issuance_gate.py` | `prepare` (revalidate, then commit remotely first), `apply` (set invoice figures from the quote) and `commit` (local commit in the issuing transaction). `RemoteCommitter` is the Phase 4 outbox seam. |
| `governed_credit_service.py` | Builds credit notes from the snapshot, by line fraction. |
| `report_service.py` | The two findings reports. |

**API**, under `/api/v1/tax`, tenant-scoped through `get_organization_id`:

| Route | Who | Notes |
|---|---|---|
| `POST /quotes` | billing admin | Body `{document_type, document_id}`, optional `Idempotency-Key` header |
| `GET /quotes?document_type=&document_id=` | tenant user | |
| `GET /quotes/{id}` | tenant user | |
| `POST /invoices/{id}/credit-notes` | billing admin | Lines given as `{invoice_item_id, fraction}` |
| `GET /reports/legacy-discount-overcollection` | org admin, finance approver | Invoice-level detail |
| `GET /reports/duplicate-tax-rows` | org admin, finance approver | Invoice-level detail |

Platform routes, under `/api/v1/super-admin/tax-registry`, need the
`tax_registry.read` capability:

- `GET /reports/legacy-discount-overcollection`
- `GET /reports/duplicate-tax-rows`

Both return **aggregate counts and totals only**.

## Determination (§08.1 steps 1–7)

1. **Facts.** The Phase 2 Tax Context Builder supplies facts, issues and the
   `context_fingerprint`. A `document_hash` covers the commercial inputs:
   lines, prices, discounts, currency, tax date, entity and customer.
   Client-sent tax fields are excluded, because governed tax never comes from
   them.
2. **Refused as UNSUPPORTED** in 3a:
   - currencies with more than 2 minor units (BHD, IQD, JOD, KWD, LYD, OMR,
     TND), because invoice money columns are NUMERIC(14,2). JPY and other
     0-decimal currencies are allowed;
   - shipping or round-off on a governed invoice;
   - **mixed engines or rounding rules** on one document.
3. **Routing.** Each line goes to the activations in effect on the tax date
   (Phase 2 use-time effective state) and their engine:
   - Buyer class comes from **evidence only**: a verified, unexpired tax ID
     makes the buyer B2B (T08).
   - A buyer without that evidence gets consumer treatment, but only where
     the engine declares `unresolved_buyer_as_consumer`. Otherwise
     `BUYER_STATUS_UNRESOLVED` blocks the quote.
   - No activation, or no engine, means **NOT_DETERMINED**, never 0% (T01).
4. **Required facts (change C).** Only context issues on the engine's declared
   `required_facts` block a quote, with status NEEDS_EVIDENCE. All other issues
   are stored as warnings. Example: a missing subdivision does not block a
   tenant-config or fixture quote.
5. **Money path**, the same for every engine:
   - The document discount is allocated pro-rata **before tax** (T09). This
     is governed only; legacy is unchanged.
   - Inclusive prices are extracted; reverse-charge components carry rate 0.
   - Rounding follows the engine's rule:
     - **PER_LINE:** each component is rounded on each line.
     - **PER_DOCUMENT:** each component's document total is rounded once,
       then allocated back to lines by largest remainder.

     Either way the lines always sum to the document total.
   - Tenant-config quotes follow the org's `tax_rounding_method` setting,
     which until now nobody read.
   - Header figures are derived so that `subtotal − discount + tax = total`
     holds exactly.
   - **Unrounded amounts are kept at NUMERIC(18,6) next to the rounded ones
     (change E).**
6. **Persistence and expiry.**
   - A quote is persisted as QUOTED. It expires after `TAX_QUOTE_TTL_HOURS`
     (default 24).
   - Refused quotes are persisted too, as the record of why determination
     stopped.
   - The same idempotency key with the same request returns the same quote;
     the same key with a different request returns 409.

## Issuance gate (§08.1 step 8)

For a GOVERNED seller entity, **every** DRAFT → SENT path goes through the
gate instead of the legacy recalculation:

- `finalize_invoice`;
- `mark_sent`;
- `send_invoice_via_email`, which also covers the super-admin resend;
- the assistant's invoice action (see finding 1).

What the gate does, in order:

1. **No usable quote: refuse.** If there is no quote, or the latest one isn't
   QUOTED/VALIDATED, issuance is refused as NOT_DETERMINED.
2. **Expired or changed: refuse and record.** If the quote has expired it is
   marked EXPIRED; if the fingerprint or document hash no longer matches it is
   marked STALE (T19). The new status is persisted and issuance is refused.
3. **Provider engines commit remotely before the invoice is touched.** A
   timeout marks the remote state UNCERTAIN, and the invoice stays DRAFT. The
   next attempt asks the provider (`remote_state`) before committing again,
   so a timeout after remote success never produces a second commit (T10).
4. **Apply and commit.** The invoice's line and header tax figures are set
   from the quote, overwriting client percentages. The quote becomes
   COMMITTED and `invoices.tax_quote_id` is set, in the same transaction as
   the SENT status.
5. **No legacy tax rows.** For governed invoices `_record_invoice_tax_snapshots`
   is skipped, because the committed quote is the snapshot.

**Creation paths (change A).** Each was tested for its status and gate:

| Path | Creates | Governed | Legacy |
|---|---|---|---|
| `InvoiceService.create_invoice` (API) | DRAFT | gated at issue | unchanged |
| `QuoteService.convert_to_invoice` | DRAFT | gated; **quoted prices kept**, `tax_rate_id` and price semantics carried over (fix d) | unchanged: still re-prices (product question) |
| `ContractService.generate_invoice_from_contract` | DRAFT | gated | unchanged |
| `SubscriptionService.generate_invoice` | DRAFT, now with `seller_entity_id` set at creation | gated; its lines carry no product, so the quote is NEEDS_EVIDENCE (see question 3) | Phase 0 stamping at issue |
| Assistant `_execute_invoice_draft` | **was DRAFT, then immediately SENT** | **stays DRAFT**, reports `invoice_draft_requires_tax_quote` | still SENT, now with `seller_entity_id` and the Phase 0 `tax_date` stamp |

## Fixes from the Phase 0 findings

| Fix | Scope | Change |
|---|---|---|
| (a) kill switch | all invoices | Emailing a DRAFT also requires `TENANT_INVOICE_FINALIZATION`. Re-sending an already-issued invoice still needs only the communications breaker. |
| (b) duplicate tax rows | all invoices | `_record_invoice_tax_snapshots` is idempotent: it writes nothing if active rows exist. Existing duplicates are **counted, not deleted** (reports below). |
| (c) dead `resolve_tax` | `create_invoice` | Branch removed. `ContractService` still has a live `resolve_tax` that sums every matching rate (legacy, unchanged; finding 4). |
| (d) quote → invoice re-pricing | governed only | `add_item(keep_quoted_price=True)` skips `PriceResolver`. Legacy behaviour is recorded as a product question. |

## Governed credit notes (T15, T18)

- **Lines, not amounts.** `POST /api/v1/tax/invoices/{id}/credit-notes` takes
  invoice lines and a fraction in `(0, 1]`.
- **Reversed from the snapshot.** Tax is reversed from the **snapshot
  components**: the original rates and rounding, never today's rates.
- **Capped and reconciled.** The cumulative credited fraction per line is
  capped at 100%. The credit that completes a line takes exactly what remains
  of each rounded amount, so the original plus its credits nets to zero to
  the cent.
- **Signed amounts.** Credit lines are signed reversals, so direction is
  preserved.
- **Invoices can't hold negative lines.** `ck_invoice_items_qty` /
  `ck_invoice_items_price` forbid them, so negative amounts appear only as
  reversals. The money path is also unit-tested with negative bases.
- **Generic flows refuse governed invoices:**
  - creating a credit note with free amounts against a governed invoice;
  - editing a governed credit note's amounts;
  - hard-deleting governed credit notes (void them instead).

## Retention

The four new tenant tables use the Phase 2 tenant guard. All content is
frozen from insert; only lifecycle columns change (status, validation, stale,
commit and void markers, remote state). Deletes are allowed only under the
erasure flag.

- **Status rule.** A Postgres status guard (and its ORM twin) allows a
  COMMITTED quote to move only to VOIDED, and makes VOIDED final.
- **Purge order.** `invoices.tax_quote_id` is `RESTRICT`, so even the erasure
  purge removes the invoice before its snapshot.
- **Open question:** the retention-vs-erasure question in `TAX_PHASE2.md`
  applies here too.

## Findings reports (read-only)

**Legacy discount-after-tax over-collection.** Legacy invoices charge tax on
the base **before** the document discount, then subtract the discount from
the tax-inclusive total.

- **Estimate:** `tax_amount × discount% / 100` per issued legacy invoice with
  a document discount and tax > 0. It is exact for one uniform rate and an
  estimate otherwise.
- **Tenant view:** invoice-level detail.
- **Platform view:** organizations affected, invoice count, and totals per
  currency. **No org names or ids, customers or invoice numbers** (tested
  over HTTP).

**Duplicate legacy tax rows.**

- **Definition:** a repeat of (invoice, tax_rate_id) among active `taxes`
  rows, caused by re-sending before fix (b).
- **Views:** per invoice for tenants; for the platform, organizations
  affected, invoices affected and duplicate rows.
- **Action:** rows are never deleted. Cleanup is a separate approved step.

**Aggregate figures:** _not yet run_. These must come from the production
database, through the platform endpoints (tax roles) after this migration is
deployed. I did not query the shared database the local `.env` points to.

## Test-only rule pack

- `tests/fixtures/tax_test_rulepack.py` (`TEST-ONLY-FIXTURE`) and
  `tests/fixtures/tax_fake_provider.py` are injected through
  `EngineResolver(rule_pack_lookup=…, provider_lookup=…)`.
- `test_test_only_pack_is_never_loadable_or_registered_by_the_app` fails if:
  - any `app/` file references `tests.fixtures` or the pack module;
  - `RULE_PACKS` contains it or any test pack;
  - a governed run inserts a `tax_rule_pack_versions` row;
  - the application's own resolver can find a pack for the fixture
    activation.

## Migration — `d7a3f9c2e8b6`

It chains from `c5e2d8a4b7f1` and leaves a single head. It uses idempotent
guards, and the Postgres DDL is a frozen copy in the migration:

- tenant guard triggers on the four tenant tables;
- `tax_quotes_status_guard`;
- the version guard on `tax_rule_pack_versions`.

`invoices.tax_quote_id` is in `CRITICAL_COLUMNS`. **Downgrade** drops all of
the above, and keeps the Phase 2 `tax_tenant_record_guard` function.

**Postgres verification** runs in the CI tax step:

1. A migration round trip from `a7c4e1b9d3f0` back to head.
2. `test_tax_phase3a_pg.py`, which covers:
   - an end-to-end quote → issue → credit run with every trigger active;
   - frozen snapshot content on all four tables;
   - COMMITTED → VOIDED only, and VOIDED final;
   - deletes only under the erasure flag;
   - `RESTRICT` from the invoice;
   - the rule-pack registry guard.

**CI result:** _pending_.

## Test evidence

| Suite | Before (Phase 2) | After |
|---|---|---|
| Backend local (venv, SQLite) | 1772 passed, 0 failed, 33 skipped | 1854 passed, 2 failed*, 39 skipped |
| Backend CI (postgres:16) | passed | _pending_ |

**New tests:**

- `tests/test_tax_phase3a_governed.py` (42): T01, T03, T08, T09, T10, T15,
  T17, T18 (×2), T19 and a light T20; every creation and issuance path;
  fixes (a)–(d); changes A–E; test-pack isolation; idempotency; frozen
  snapshots.
- `tests/privacy/test_tax_phase3a_reports_access.py` (18): report and quote
  visibility, including the aggregate-only platform response.
- `tests/test_tax_phase3a_pg.py` (6, Postgres only).

The Phase 2 route walk now also covers the new tenant routes.

\* The 2 failures are `test_aggregate_cache.py`
(`test_status_change_and_bulk_delete_invalidate`,
`test_explicit_invalidate_helper`). This is the pre-existing order-dependent
cache test (Phase 1 finding 7): the file passes 22/22 run alone on this tree.
The 39 skips are the Postgres-only modules (`TAX_PG_TEST_URL` unset), which
run in CI.

## Findings

1. **The assistant invoice action issued invoices directly (corrects the
   Phase 2 path list).** `_execute_invoice_draft` created an invoice and then
   set `status = "SENT"` in the same action. That bypassed `finalize_invoice`:
   no kill switch, no line-items rule, no tax-date stamp, no tax snapshot.
   `TAX_PHASE2.md` listed it as "creates DRAFT only"; that search looked for
   `InvoiceStatus.SENT` and missed the string literal.
   - **Now:** governed entities keep the DRAFT; legacy entities get the
     seller entity and tax date.
   - **Still open, for the product and security owners:** legacy assistant
     issuance skips the finalization kill switch and the line-items rule.
   - A codebase scan found no other string-literal invoice status writes.
2. **Rounding settings were dead.** `BillingConfiguration.tax_rounding_method`
   was never read by legacy math. Governed tenant-config quotes now honour it;
   legacy math still ignores it.
3. **Currency minor units are incomplete.** The billing module's
   `CURRENCY_DECIMAL_MAP` lacks JOD, IQD, LYD, TND and many 0-decimal
   currencies, so legacy rounding treats them as 2 decimals. Governed quotes
   use an explicit ISO 4217 table.
4. **`ContractService.generate_invoice_from_contract(resolve_tax=True)` is
   live.** It sums every matching org rate into one percentage (Phase 0
   finding 2's pattern). Legacy, unchanged.
5. **Invoice money columns are NUMERIC(14,2).** Widening them, or adding a
   minor-unit-aware representation, is needed before 3-decimal currencies can
   be governed.

## Open product questions

1. **Legacy quote → invoice re-pricing.** Converting an accepted quote re-prices
   product lines at today's price list and drops `tax_rate_id`. Is that
   intended? Governed invoices no longer do it.
2. **Legacy discount-after-tax.** Should legacy invoicing be corrected, and
   should affected customers be credited? The over-collection report gives
   the scale. This is for the product owner and tax lead.
3. **Governed subscriptions.** Subscription invoice lines carry no product, so
   they have no tax classification and a governed quote is NEEDS_EVIDENCE.
   Should plans map to products or to tax codes?
4. **Assistant issuance for legacy entities** (finding 1): should it go
   through `finalize_invoice`, gaining the kill switch and the line-items rule?
5. **Duplicate-row cleanup:** approve a correction step once the counts are
   known.

## Next: Phase 3b

- Enable GOVERNED through `POST /regime` (eligibility from Phase 2).
- Invoice editor UX: per-component tax, legal treatment, quote freshness and
  blocking reasons (§11).
- Rule-pack approval routes, then the first **draft** packs. They stay drafts
  until tax-lead sign-off.

**Pilot markets: the handoff's list.** §14 (Delivery roadmap), phase
"2 — bounded determination", reads:

> "Pilot approved UK/Australia simple cases and specialist-provider
> US/Canada complex cases".

What that means for 3b:
- **UK and Australia** are listed as simple native cases. UK covers
  standard-rated services. Australia's GST is in the list, so it isn't
  excluded.
- **Canada** is listed as a *specialist-provider* complex case, not a native
  pack. A native Canadian pack would be limited to GST/HST: Ontario HST from
  its approved source, and BC PST returning NOT_DETERMINED.
- **The final choice is yours before 3b starts.**
