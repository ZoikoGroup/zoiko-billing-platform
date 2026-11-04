# Global Tax — Phase 2: Policy, Activation and Tax Context

Implements the second slice of **ZB-TAX-ARCH-001**: §05 (operating modes and
market activation), §07 (obligation, classification and buyer-evidence
objects), §08.1 steps 1–4, §11 and §13.2. Phase 2 decides who **may**
calculate tax where, and collects the facts a determination needs. It still
calculates nothing:
- Every entity stays `LEGACY_MANUAL`, and `GOVERNED` is refused until Phase 3.
- No invoice path reads any of this yet.

## What changed

**First commit: import-cycle fix.** `invoice_service` now imports
`LegalEntityService` lazily through `_legal_entities()`.
`tests/test_tax_import_cycle.py` imports each tax module first in a fresh
interpreter: it fails 2/4 on the old code and passes now.

**Platform (non-tenant)** in `app/modules/tax/policy_models.py` and `policy_service.py`:

| Object | Purpose |
|---|---|
| `tax_market_availability_versions` | Jurisdiction × tax type × transaction class → supported mode (`NATIVE_RULEPACK_APPROVED`, `PROVIDER_APPROVED`, `REFERENCE_ONLY`, `UNSUPPORTED`, `SUSPENDED`). Records status, evidence ref and notes for each §13.2 gate, plus `tenant_config_permitted` (default false). |
| `tax_code_set_versions` + `tax_codes` | Versioned product tax-code taxonomy. Each code carries `supply_category` (SERVICES / DIGITAL / GOODS) and the registry `product_scope` it maps to. |

Both use the Phase 1 workflow, through
`/api/v1/super-admin/tax-registry/{market-availability,tax-code-sets}`:
1. A TAX_REVIEWER drafts, validates and submits.
2. A different TAX_PUBLISHER approves, then publishes, both with MFA step-up.
3. The decision itself is an `approval_requests` row
   (`tax_market_availability`, `tax_code_set`).
4. Publishing supersedes the previous ACTIVE version first, so there is at
   most one ACTIVE version per key, enforced by a partial unique index.

**Gate rules.** A calculating mode needs these gates PASSED:
`LEGAL_AUTHORITY_AND_USAGE_RIGHTS`, `SOURCE_PROVENANCE_AND_FRESHNESS` and
`GOLDEN_TESTS_SIGNED_OFF`. Every other gate must be PASSED, or
NOT_APPLICABLE with a written note. PASSED needs an evidence reference.
`tenant_config_permitted` has two further conditions:
- the mode is not SUSPENDED or UNSUPPORTED;
- the legal-authority gate is PASSED.

**Tenant-private** tables in `app/modules/tax/models.py`. Every table has
`organization_id`, and every query is scoped by it:

| Table | Purpose |
|---|---|
| `entity_tax_registrations` | Seller entity × jurisdiction × tax type: registration number, validity, status, verification facts |
| `entity_tax_legal_bases` | Structured legal basis for collecting without a registration, approved by tenant maker-checker (change D) |
| `entity_tax_activations` | Seller entity × jurisdiction × tax type × transaction class → calculating mode, linked to a registration or legal basis and the availability version in force at approval. Holds the tenant rate and source for `TENANT_CONFIG_APPROVED`. |
| `product_tax_classifications` + `tax_classification_counters` | Product → tax code with review workflow and history; per-org classification version |
| `customer_tax_addresses`, `customer_tax_ids`, `customer_exemption_certificates` | Buyer evidence, added alongside the existing customer fields; the free-text customer fields are never modified |
| `tax_review_items` | Tenant-private T14 queue. It is not the platform `AttentionItem`, because super admins can read those. |

**Quotes** gain:
- `seller_entity_id`, assigned like invoices on create, validated on update,
  and carried onto the invoice at conversion;
- `tax_context_status` (`CURRENT` / `STALE`);
- `tax_classification_version`.

All three are in `CRITICAL_COLUMNS`.

**Services:** `tenant_tax_service.py` (registrations, legal bases,
activations, effective state, regime eligibility),
`classification_service.py`, `buyer_evidence_service.py`,
`context_builder.py`, `review_service.py` + `tasks.py`.

**Tenant API** (`/api/v1/tax`, all through `get_organization_id`):

| Area | Routes |
|---|---|
| Registrations | `GET/POST /registrations`, `PATCH /registrations/{id}` (validity end, status, verification only) |
| Legal bases | `GET/POST /legal-bases`, `POST /legal-bases/{id}/{approve,reject,withdraw}` |
| Activations | `GET/POST /activations`, `POST /activations/{id}/{approve,reject,withdraw}`, `GET /activations/{id}/effective?date=` |
| Regime | `GET /legal-entities/{id}/regime-eligibility`, `POST /legal-entities/{id}/regime` (refuses GOVERNED) |
| Classification | `GET /tax-codes`, `GET/POST /product-classifications`, `POST /product-classifications/impact-preview`, `POST /product-classifications/{id}/{approve,reject,withdraw}` |
| Buyer evidence | `GET /customers/{id}/tax-evidence`, `POST /customers/{id}/{tax-addresses,tax-ids,exemption-certificates}`, `POST /tax-ids/{id}/{verification,retire}`, `POST /exemption-certificates/{id}/revoke` |
| Review and context | `GET /review-items`, `POST /review-items/{id}/resolve`, `GET /context/{invoice\|quote}/{id}` |

Proposals need org_admin or billing_admin. Approvals need finance_approver,
and the proposer can never decide their own proposal.

## Guardrails

- **Two-level activation (§05, T12).** A tenant activation can only be
  approved when:
  - the platform's ACTIVE availability for that exact market offers the same
    mode;
  - the jurisdiction is active in the registry;
  - a registration or approved legal basis covers the activation date, for
    the same entity, jurisdiction and tax type.

  `REFERENCE_ONLY`, `UNSUPPORTED` and `SUSPENDED` are not activatable modes.
  Nothing activates through settings, plan or currency: the entity `PATCH`
  still refuses GOVERNED, and changing the org's currency or country creates
  nothing.
- **`TENANT_CONFIG_APPROVED` fails closed.** It's allowed only when the
  active availability version sets `tenant_config_permitted = true`. A
  missing record, or a false flag, means not allowed. The tenant's rate must
  cite the tenant's own legal source with a citation and an https URL, and
  goes through tenant maker-checker. Every activation response carries
  `verification_label: "tenant-configured, not verified by Zoiko"`.
- **GOVERNED stays refused until Phase 3.**
  - `POST /legal-entities/{id}/regime` refuses it with a Phase 3 message.
  - `GET …/regime-eligibility` reports `would_qualify`, the unmet
    conditions and `governed_available: false`.
  - The gate is satisfied by at least one approved activation in a
    calculating mode that is in effect.
- **Effective mode at use time (change B).**
  `TenantTaxService.effective_state(activation, date)` recomputes from the
  current platform availability, the activation and its registration or
  legal basis. A platform SUSPENDED/UNSUPPORTED, a mode withdrawn from
  availability, or an expired or deregistered registration takes effect
  immediately. Nothing waits for T14, and the activation row is never
  rewritten.
- **Transaction classes are routing categories, not legal
  characterization.** The six classes are B2B/B2C × SERVICES/DIGITAL/GOODS.
  - **B2B or B2C:** derived only from evidence, meaning a VERIFIED,
    unexpired tax ID. An unverified ID is never B2B evidence (T08).
    `customer_type` is reported but never used. Unclear buyer status is
    `AMBIGUOUS`.
  - **Supply category:** comes from the product's tax code.
  - **Legal characterization** belongs to Phase 3+ rule packs.
- **Maker-checker at both levels.** On the platform, ApprovalService refuses
  self-approval, and checkers can't be the drafter or submitter either. On
  the tenant side, the proposer can't approve or reject their own proposal,
  following the existing `created_by` / `approved_by` pattern.
- **Classification version (change G).**
  `UPDATE tax_classification_counters SET version = version + 1 … RETURNING`
  takes a row lock. Concurrent approvals serialize, and each gets a distinct
  version; a Postgres test runs two real transactions to prove it.
  Approving a mapping change:
  - supersedes the previous mapping;
  - bumps the version;
  - marks open quotes (DRAFT/SENT) containing the product `STALE`.

  The impact preview lists affected DRAFT invoices and open quotes before
  approval.
- **No duplicate customer master.** Buyer evidence references
  `billing_customers`. A tax ID's raw value is stored exactly as given;
  `value_normalized` only strips whitespace and upper-cases, for matching.
  VERIFIED needs the method and the verification response.

## Tax Context Builder and fingerprint

`GET /api/v1/tax/context/{invoice|quote}/{id}` returns `document`, `facts`,
`issues[]`, `complete` and `context_fingerprint`.

It is pure. It never writes (a test asserts a clean session and unchanged
counts), and it never fills a default. An unknown tax date is reported as
`TAX_DATE_MISSING`; it is never replaced with today.

**Issue kinds:** `MISSING`, `EXPIRED`, `AMBIGUOUS`, `UNVERIFIED`,
`NOT_PERMITTED`.

**Issue codes:**
- **Document:** `TAX_DATE_MISSING`, `CURRENCY_MISSING`.
- **Seller:** `SELLER_ENTITY_MISSING`, `SELLER_COUNTRY_MISSING`,
  `SELLER_ENTITY_INACTIVE`.
- **Lines:** `NO_LINES`, `PRICING_MODE_MIXED`, `LINE_PRODUCT_MISSING`,
  `PRODUCT_CLASSIFICATION_MISSING`.
- **Buyer:** `CUSTOMER_MISSING`, `BUYER_COUNTRY_MISSING`,
  `BUYER_ADDRESS_DERIVED`, `BUYER_SUBDIVISION_MISSING`,
  `SHIPPING_ADDRESS_MISSING`, `TAX_ID_UNVERIFIED`,
  `TAX_ID_VERIFICATION_EXPIRED`, `BUYER_STATUS_UNRESOLVED`,
  `EXEMPTION_CERTIFICATE_EXPIRED`.
- **Market and activation:** `JURISDICTION_NOT_IN_REGISTRY`,
  `NO_ACTIVATION`, `NO_EFFECTIVE_ACTIVATION`, `ACTIVATION_NOT_EFFECTIVE`.

**`context_fingerprint`** is a SHA-256 over the canonical JSON of every fact
and version the builder used:
- the document's tax date, currency and seller entity;
- the seller entity's version and establishment facts;
- line classifications and the org's classification version;
- pricing mode;
- buyer addresses, tax IDs (including verification state and expiry) and
  certificates;
- jurisdictions;
- registrations;
- activations, with their effective state and the availability version and
  mode they were evaluated against.

It is deterministic, and a test changes each of 11 inputs one at a time and
checks that the fingerprint changes every time.

**This is the general staleness mechanism.** Phase 3 quotes store the
fingerprint at quotation and recompute it before issue; any mismatch makes
the quote STALE (§08.1 step 8). Classification STALE marking is kept as an
early, visible signal on existing quotes, but it covers only one input. The
fingerprint covers all of them.

## Retention vs. erasure — OPEN LEGAL QUESTION

Tax evidence often has a statutory retention period, commonly 6 years or
more and varying by jurisdiction: registrations, buyer tax IDs and
verifications, exemption certificates, classifications and activations that
supported invoices. The platform also supports tenant right-to-erasure
through `OrganizationPurgeService`. These conflict, and **retention periods
and legal-hold rules need DPO/counsel sign-off.** Until that is decided:

- Key fields of decided or recorded tenant tax records can't be updated.
  This is enforced by Postgres triggers (`tax_tenant_record_guard`) and the
  ORM guard.
- **DELETE is refused everywhere except inside the erasure purge.** The purge
  runs `SET LOCAL zoiko.tax_erasure = 'on'`, which ends with its transaction,
  and the trigger checks it. The ORM guard reads `session.info`.
- Ordinary tenant flows never delete. Proposals are withdrawn, tax IDs are
  retired, certificates are revoked, and addresses are superseded.
- `CustomerService.bulk_delete_customers` (a hard delete) now refuses
  customers that hold tax evidence, with a clear 400 and the advice to
  deactivate instead. The foreign keys are `RESTRICT`, as for
  contacts/invoices.
- **No retention exceptions are implemented.** The purge still erases
  everything for a tenant. Once counsel decides, the likely change is a
  retention/legal-hold check inside the purge.

## TaxPricing / TaxGroup consolidation proposal (not executed)

**Today.** `tax_pricing`, `tax_groups` and `tax_group_members` are
tenant-managed rate and group tables. They have free-text location fields,
`effective_from/to`, compound flags and `hsn_sac_code`. They are reachable
through `/billing/tax-pricing` and the "Tax Pricing" page.

**Nothing in invoice or quote calculation reads them.** Line tax comes from
`tax_percentage` and `TaxRate`, and `/tax-pricing/applicable` has no caller
outside its own page. They duplicate `TaxRate` and the Phase 1/2 model, with
none of the provenance or approval controls.

**Proposal:**
1. **Freeze (Phase 3 start).**
   - Mark both pages "legacy — not used for invoice tax".
   - Stop new `TaxGroup` creation.
   - Keep reads so tenants can export their data.
   - Log a deprecation warning on writes.
2. **Map (Phase 3).**
   - For each active `TaxPricing` row whose free-text country resolves
     unambiguously, generate a *draft* `TENANT_CONFIG_APPROVED` activation
     proposal. The rate is tenant-entered, the tenant must cite a source,
     and it still goes through tenant maker-checker.
   - Rows that don't resolve cleanly go on a review list. They are never
     auto-converted.
   - `hsn_sac_code` becomes a hint for a product classification proposal,
     never an approved mapping.
   - `TaxGroup` compound/order semantics map to registry component
     combination rules only through a rule pack, never directly.
3. **Retire (after one release with no writes).**
   - Remove the router and page.
   - Keep the tables read-only for the statutory retention period (see the
     open question above).
   - Drop them later in a reviewed migration.

**Frontend impact:**
- `pricing/tax-pricing.jsx` (with `TaxGroupsModal`);
- `taxPricingApi` in `billingService.js` / `billingEndpoints.js`;
- the nav entry in `BillingShell.jsx`;
- `tax-pricing.dialogs.test.jsx`.

**Open questions for Product:** whether any tenant relies on the page as a
rate notebook, and whether the migration of step 2 should be
tenant-initiated or proposed automatically.

## Phase 3 reference lists (from the code map; no changes made)

**a. Every path that issues an invoice (DRAFT → SENT).** `status` is not an
editable invoice field; `invoice_service` keeps it out of the allowed update
fields.

| Path | Notes |
|---|---|
| `InvoiceService.finalize_invoice` (`services/invoice_service.py`) | Main issuance. Validates the transition, enforces the finalization kill switch, stamps the entity and `tax_date`. |
| `InvoiceService.mark_sent` | Delegates to `finalize_invoice`. Called by `POST /billing/invoices/{id}/send` (`routers/invoice_router.py`; `/finalize` calls `finalize_invoice`). |
| `InvoiceService.send_invoice_via_email` | Issues and emails. Phase 0 finding: it skips the finalization kill switch. Called from `POST /billing/invoices/{id}/send-email` and from the **super-admin email resend** (`super_admin/email_delivery_service.py`, template `ZB-INV-006`): a platform operator's resend re-runs this tenant issuance path. Whether a resend can reach a still-DRAFT invoice was not verified; Phase 3 should gate it either way. |
| `InvoiceRepository.mark_sent` (`repositories/invoice.py`) | Sets SENT directly with no guards. **No callers found (dead code).** Phase 3 should delete it or route it through `finalize_invoice`. |
| Recurring billing (`tasks/recurring_billing.py` → `SubscriptionService.generate_invoice`) | Creates **DRAFT** invoices only; issuance happens through the paths above. |
| Quote / contract conversion (`quote_service.convert_to_invoice`, `contract_service`) | `create_invoice` → DRAFT. |
| Assistant actions (`chatbot/actions/action_engine._execute_invoice_draft`) | Creates **DRAFT** only. No assistant action sends or finalizes. |
| Status reversions to SENT (`invoice_service.reverse_write_off`, `payment_service` deallocation) | Not issuance: these re-open an already-issued invoice. Payments can't allocate to DRAFT (`NON_ALLOCATABLE_INVOICE_STATUSES`). |

**b. Every place customer billing country or address is read with tax
relevance:**

| Place | What it does |
|---|---|
| `frontend/…/invoicing/create-invoice-wizard.jsx` `handleCustomerSelect` | Sets the wizard's tax `country_code` from `billing_country`. **If that is missing, it infers the country from the GSTIN or VAT number prefix** (`detectCountryFromGSTIN` / `detectCountryFromVAT`), then auto-selects a default `TaxRate` for that country. The value is UI-only (not persisted). Phase 3 must replace this with the context builder (T08). |
| `customer_import_service.py` (CSV import) | Resolves `billing_country` to ISO and derives `tax_id_type`, maps `tax_id` → `gst_number` for GST countries, and sets the default currency. |
| `frontend/…/customers/customer-form-dialog.jsx`, `customer-profile.jsx` | `getCustomerTaxFields(billing_country)` chooses which tax-ID fields to show and require. |
| `pdf_service.py` (5 templates) | Prints `billing_country` and the address. Display only. |
| `invoice_service.py` / `quote_service.py` document payloads | Copy the free-text `billing_address` / `shipping_address` onto the document view. Display only. |
| `customer_service.py` list filter | Filters by `billing_country`. Not tax. |
| Phase 2 | `customer_tax_addresses` backfill (`billing_country` / `shipping_country` via `resolve_country_code`) and the context builder, which reads only the structured table. |

No backend tax calculation reads the customer's country today. Tax comes
from client-sent line `tax_percentage`, or from `TaxRate` through the dead
`resolve_tax` branch (Phase 0 finding 2).

## Migration — `c5e2d8a4b7f1`

It chains from `b3d8f2a6c1e4` and leaves a single head. It uses idempotent
`_has_table` / `_has_column` / `_has_index` guards. The Postgres DDL is a
frozen copy inside the migration.

**Backfills:**
- `quotations.seller_entity_id` is set to the org default entity, the same
  rule as the Phase 0 invoices.
- `customer_tax_addresses` gets an ISO country only where
  `resolve_country_code` is unambiguous. Its table covers 42 countries;
  anything else stays absent. These rows are `DERIVED`, and the builder
  flags them as `BUYER_ADDRESS_DERIVED` until confirmed.
- `customer_tax_ids` is filled from `tax_id`, `vat_number`, `gst_number`,
  `pan` and `tin` as UNVERIFIED. The raw value is kept and `source_field`
  recorded. `id_type` is taken only from `tax_id_type`, and only for the
  `tax_id` column. There is one row per distinct normalized value per
  customer.

A test runs the frozen backfill twice through Alembic `Operations` on SQLite:
it proves idempotency, raw values, ambiguous countries left null, and legacy
fields untouched.

**Downgrade** drops all of the above, backfilled rows included. The legacy
columns are untouched, so a re-upgrade rebuilds them.

**Postgres verification is in CI.** The existing step now runs the round
trip (`downgrade a7c4e1b9d3f0 → upgrade head`, so both phases are rebuilt),
then `test_tax_phase1_registry_pg.py` and `test_tax_phase2_pg.py`. The
Phase 2 Postgres tests cover:
- trigger presence;
- frozen submitted availability content;
- ACTIVE → SUPERSEDED only;
- one ACTIVE per market;
- tax codes frozen in a submitted set;
- frozen registration, activation and tax-ID key fields, with recordable
  end dates and verification;
- DELETE refused without the erasure flag and allowed with it;
- the purge end to end;
- concurrent version bumps.

**CI result:** _pending_.

## Test evidence

| Suite | Before (Phase 1) | After |
|---|---|---|
| Backend local (venv from `requirements.txt`, SQLite) | _pending_ | _pending_ |
| Backend CI (postgres:16) | passed | _pending_ |

New: `tests/test_tax_import_cycle.py` (4), `tests/test_tax_phase2_policy.py`
(36), `tests/privacy/test_tax_phase2_access.py` (11: T13 across every
platform role, a live vs. expired support account with real tokens, and a
route walk proving every tenant tax route resolves `get_organization_id`),
`tests/test_tax_phase2_pg.py` (13, Postgres only).

## Findings

1. **Registration matching is exact.** An activation needs a registration
   for the same jurisdiction and tax type. Real-world cross-coverage, such
   as a Canadian GST/HST registration number used for provincial HST, needs
   a rule (Phase 3) rather than a looser match here.
2. **Buyer business status has only one form of evidence: a verified tax
   ID.** "Other recorded proof" (for example a signed B2B declaration)
   needs its own evidence type before Phase 3 relies on it.
3. **`resolve_country_code` knows 42 countries**, so the backfill leaves
   many valid ISO countries unset. A full ISO 3166 table would widen it
   without guessing.
4. **Quotes have no tax date.** The builder always reports
   `TAX_DATE_MISSING` for quotes. Phase 3 needs an explicit quote tax-date
   rule, such as an expected supply date.
5. Phase 0 findings 1, 3 and 4 remain open. Finding 2 (dead `resolve_tax`)
   is now also listed in the Phase 3 issuance map above.

## Next: Phase 3 — governed determination

The quote/commit contract over effective activations, with the stored
context fingerprint; issuance gating on every path in list (a); native rule
packs for the first approved markets; GOVERNED enabled per entity through
`POST /regime`.
