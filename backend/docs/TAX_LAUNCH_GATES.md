# Tax Market Launch Gates (01–07)

A market goes live in a calculating mode only when **all seven gates of
handoff §13.2** pass for it.

A market here means one cell: a jurisdiction, a tax type and a transaction
class. The cell is set by a published `tax_market_availability_versions`
row. Without it, every tax decision for that market stays NOT_DETERMINED.

This file is the checklist for each market type. It gives each gate's owner
role, the evidence required, how to verify it, and the status as of
2026-11-05. Owner roles follow handoff §14.1 (RACI). Names are filled in by
the product owner.

## How the system enforces the gates

- **Gates are recorded per market.** Each market-availability version carries
  all seven gates, each with `status`, `evidence_ref` and `notes`.
  - `validate` refuses a version unless all seven gates are present.
  - A gate marked PASSED needs an `evidence_ref`.
  - A gate marked NOT_APPLICABLE needs a note.
- **A calculating mode needs the gates.** For `NATIVE_RULEPACK_APPROVED`,
  `PROVIDER_APPROVED` or `TENANT_CONFIG_APPROVED`, three gates must be
  PASSED: **01, 02 and 04**. The other gates must be PASSED or
  NOT_APPLICABLE (`policy_service.MANDATORY_GATES`).
- **Provider markets also need gate 05.** For `PROVIDER_APPROVED`, gate
  **05** must be PASSED as well; it can't be waived
  (`policy_service.mandatory_gates`).
- **Coverage is visible.** Published coverage (supported / limited /
  unsupported) is readable by every signed-in user through
  `GET /api/v1/tax/coverage`, for gate 07.
- **Publishing takes two people.** A TAX_REVIEWER drafts, validates and
  submits. A different TAX_PUBLISHER approves and publishes, with MFA
  step-up. Everything is audited.
- **A published market isn't live for a tenant yet.** The tenant still
  needs two-person approval of the seller entity's registration or legal
  basis, the activation, and (for provider markets) the provider connection.
  The entity must also be GOVERNED, which is also two-person.

**Verify any gate** by viewing the published version:
`GET /api/v1/super-admin/tax-registry/market-availability?jurisdiction_id=…`.
This needs `tax_registry.read`. Check that the gate's status and
`evidence_ref` match the evidence filed.

### Gaps found while writing this checklist (both fixed)

| # | Gap | Fix | Tests |
|---|---|---|---|
| G1 | Gate 05 could be set NOT_APPLICABLE on a `PROVIDER_APPROVED` market, so a provider market could be published with no contract or SLA evidence. | `mandatory_gates(mode)`: for `PROVIDER_APPROVED`, gate 05 must be PASSED (with evidence). Native packs and tenant rates may still mark it NOT_APPLICABLE with a note. Validation says "A PROVIDER_APPROVED market requires gate PROVIDER_CONTRACTS_AND_RECOVERY PASSED". | `tests/privacy/test_tax_phase4d0_gates.py`: N/A, NOT_STARTED and FAILED are refused for a provider market; PASSED validates; N/A-with-note validates for a native market. |
| G2 | Gate 07 needs coverage visible to Sales/Support, but market availability was readable only by tax roles. | `GET /api/v1/tax/coverage`, for any signed-in user (platform roles and tenant users; there is no separate Sales platform role, so Sales uses a Support or tenant-side account). It returns **published** markets only: jurisdiction, tax type, class, mode, a state (SUPPORTED / LIMITED / UNSUPPORTED) with a plain meaning, and `published_at`. There are no drafts, no gate evidence and no tenant data. Its statement says anything not listed is UNSUPPORTED and that there is no global-compliance claim. It is paged (B3) and filterable by `state`. | Same file: published only, no evidence, every platform role and tenant users can read, sign-in required, state filter, paging. |

---

## The seven gates

| Gate | Handoff §13.2 | Owner (accountable) | Must approve |
|---|---|---|---|
| **01** | Legal authority and usage rights mapped for each source, rate type and supported product class | Global Head of Tax / qualified tax counsel | Tax reviewer + independent Finance controller |
| **02** | Approved source provenance, freshness policy and effective-dated history | Tax compliance operations lead | Two-person review + release manager |
| **03** | Jurisdiction resolution, registered seller obligation and product/buyer determination tested | Native: backend lead. Provider: tax integrations owner. | QA + tax reviewer |
| **04** | Golden tests signed off by Tax/Finance and QA; no critical correctness or tenancy defects | Global Head of Tax | Finance controller + QA lead |
| **05** | Provider contracts, SLAs, failure/rollback process and reconciliations validated (where a provider is used) | Tax integrations owner | Procurement/Legal + provider owner; SRE (operations); Finance systems owner (reconciliation) |
| **06** | UI explains unsupported/stale states; audit evidence exportable under authorized controls | Product owner | Security architecture + QA |
| **07** | Availability registry updated **only** for approved coverage, and visible to Sales/Support | Product/Commercial director | Tax/Legal sign-off + QA and Security |

---

## Native markets: United Kingdom (GB-VAT) and Australia (AU-GST)

**Scope:** domestic standard-rated **services**, B2B and B2C. Packs:
`GB-VAT-DOMESTIC-SERVICES v1` and `AU-GST-DOMESTIC-SERVICES v1`, both
**DRAFT**.

**Gate 05** is **NOT_APPLICABLE**, with the note "native rule pack; no
external provider".

### Gate 01: legal authority and usage rights
- **Evidence:**
  - S11 (HMRC) and S16 (ATO) source entries, approved, with usage rights
    recorded.
  - For GB, either S11 accepted as enough, or `https://www.gov.uk/vat-rates`
    registered as a new source and added to a new pack version (S11 doesn't
    state the rate).
  - For AU, a manual capture of the public ATO page, because S16's cited URL
    refuses automated retrieval (HTTP 403).
- **Verify:** the source registry shows each source APPROVED, with rights;
  `source_dependency_status` is approved for every `source_ref` of the pack.
- **Status:** ☐ **Open.** Both items are on the 3b sign-off checklist
  (`TAX_PHASE3B.md`).

### Gate 02: provenance, freshness, effective-dated history
- **Evidence:**
  - Captured, server-hashed source revisions.
  - The STANDARD/GENERAL rate published through the Phase 1 pipeline, with
    `valid_from` from the legal instrument.
  - The freshness policy agreed: review cadence, and who watches for
    changes.
- **Verify:** the rate version is ACTIVE with a source revision and hash;
  staged-rate history shows the two-person publish; the freshness policy is
  filed as the `evidence_ref`.
- **Status:** ☐ **Open.** No rate is published for either market yet.

### Gate 03: resolution and determination tested
- **Evidence:** the CI run of the pack tests.
  - Seller established in the market.
  - Buyer billed in the market.
  - Services only.
  - GBP or AUD only.
  - Everything else NOT_DETERMINED (T01).
  - Buyer status: unresolved is treated as a consumer.
- **Verify:** `tests/test_tax_phase3b_packs.py` and the 3a governed tests,
  passed on the release commit; attach the run URL.
- **Status:** ◐ **Built and passing in CI.** Not yet filed as gate evidence.

### Gate 04: golden tests signed off
- **Evidence:**
  - GB: T05 (£100 net → £20 VAT → £120 gross, rate and source version
    preserved), B2B/B2C, outside-coverage and T14 cases.
  - AU: the 10% per-document case and outside coverage.
  - T09 rounding (GB PER_LINE + HALF_UP; AU PER_DOCUMENT + HALF_UP),
    confirmed against HMRC and ATO guidance.
  - Signed by the tax lead, the Finance controller and QA. The CI report is
    attached (commit, passed, failed = 0, run URL).
- **Verify:** sign-off record referenced as the `evidence_ref`.
- **Status:** ☐ **Open.** Waiting for the tax lead's review.

### Gate 06: UI and audit evidence
- **Evidence:**
  - The invoice editor and Taxes → Exceptions explain NOT_DETERMINED,
    NEEDS_EVIDENCE, stale and unsupported states, and offer a re-quote
    (WCAG 2.2 AA).
  - Audit evidence exportable by authorized roles only: platform registry
    bundles for tax roles; tenant bundles and documents for tenant
    admin/finance roles; platform roles get 403 on tenant data (T13).
- **Verify:** QA walkthrough of the Tax Control Center screens; the
  privacy/T13 test suite.
- **Status:** ◐ **Platform sign-off console built (Phase 5a, `TAX_PHASE5A.md`).**
  - Built: the Tax Control Center sign-off screens (source register, rates
    and change review, market availability, rule packs, approvals inbox) at
    `/super-admin/tax`.
  - Correction: an earlier version of this file said the frontend was
    "being built in a separate session". No such work existed on any
    branch; Phase 5a is the first frontend for the platform console.
  - Phase 5b added the tenant Settings → Taxes screens T1–T8 at
    `/billing/tax/governance` (`TAX_PHASE5B.md`): overview with what blocks
    issuing, legal entities, registrations and legal bases with evidence,
    activations, regime switch, product classification with impact preview,
    customer tax evidence with resolution status, and review items.
  - **Phase 5c PR 1 (`TAX_PHASE5C.md`): audit-evidence export built.**
    - **Platform bundles:** for a source, rate, tax-code set, rule pack and
      market availability version. Each has:
      - the record;
      - source references and evidence hashes;
      - the golden-test report reference;
      - every state change, with names and timestamps;
      - approvals and MFA step-up flags.

      Tax roles only, and no tenant data.
    - **Tenant bundles:** for a registration, legal basis, activation,
      classification and regime change. Tenant admin/finance roles only;
      platform roles get 403 (T13).
    - **Format and seal:** JSON plus a printable HTML summary. Each bundle
      records its own SHA-256 and is audited on export.
    - **Downloads tightened:** tenant document downloads (registration,
      legal basis, certificate, manual resolution) now need the same roles.
  - **Phase 5c PR 2:** T10 tenant reports with CSV export (audited,
    formula-safe) and P10 aggregate findings.
  - **Phase 5c PR 3:**
    - T9 reference rates;
    - P1 overview, P4 jurisdictions and rates, P5 tax-code catalogue
      (read-only), with the tax-code set evidence export;
    - the governed connection mode change (in the connection's evidence
      bundle);
    - the pilot runbook (`TAX_PILOT_RUNBOOK_UK_AU.md`).
  - **Phase 5d PR 1:** the governed credit-note screen, from the invoice's
    Governed tax panel. Full or partial, a preview from the snapshot, and
    the provider ADJUST state.
  - Still open:
    - the QA walkthrough of the console and tenant screens (follow the
      pilot runbook);
    - a manual WCAG 2.2 AA pass (automated axe checks run in CI).

### Gate 07: availability registry and visibility
- **Evidence:**
  - GB · VAT and AU · GST, both B2B_SERVICES and B2C_SERVICES, published as
    `NATIVE_RULEPACK_APPROVED` only after gates 01–06.
  - Visible to Sales/Support.
- **Verify:** the published availability versions;
  `GET /api/v1/tax/coverage` shows exactly the approved cells (Sales/Support
  read it there).
- **Status:** ☐ **Open.** The visibility path exists; nothing is published
  yet.

### After the platform gates: per tenant
- The tenant entity's registration (number, validity) is recorded.
- The activation is approved by two people.
- The entity is switched to GOVERNED (two people).
- A first live invoice is reviewed by the tenant's finance approver.

---

## Provider markets: Canada (GST/HST/PST/QST) and United States (sales tax)

**Scope:** every Canadian and US tax is decided by the contracted provider.
We own the context, nexus/registration checks, contradiction checks,
outbox, reconciliation, evidence and failing closed.

**There is no native Canada or US pack.**

### Gate 01: legal authority and usage rights
- **Evidence:**
  - The provider contract states its content rights (rates, boundaries,
    taxability) and our permitted use.
  - For the US, the address resolver's dataset licence, if it comes from a
    separate vendor.
- **Verify:** contract clauses referenced as the `evidence_ref`.
- **Status:** ☐ **Open.** No provider is contracted.

### Gate 02: provenance and freshness
- **Evidence:**
  - The provider's update cadence and change notices.
  - The resolver's `dataset_version` reporting.
  - Our resolution validity, `TAX_ADDRESS_RESOLUTION_VALID_DAYS` (365).
- **Verify:** provider documentation is filed; the resolver reports
  `dataset_version`, and a newer one makes stored resolutions stale
  (ADDRESS_RESOLUTION_STALE). This is tested.
- **Status:** ☐ **Open.** The mechanism is built (4c); vendor evidence is
  pending.

### Gate 03: resolution and determination tested
- **Evidence:**
  - Ours (plumbing, built):
    - routing facts and province/state required;
    - US street address resolved (ZIP alone never resolves; ambiguous
      blocks);
    - place of supply (ship-to, service location, billing fallback);
    - registrations per jurisdiction and tax type, covering districts for
      the same tax type only;
    - certificate claims (T14).
  - Theirs: the conformance suite (`tests/tax_provider_conformance`) run
    against the **provider sandbox**, including
    `check_secret_store_never_leaks` for the gcp store.
- **Verify:**
  - Phase 4b and 4c tests pass in CI.
  - Every check in `tests/tax_provider_conformance` (`CHECKS`, plus the
    payload-minimality and credential-redaction checks) passes against the
    sandbox adapter, with none skipped without a written reason.
  - Run it with `TAX_CONFORMANCE_SECRET=… python -m tests.tax_provider_conformance pkg.module:make_adapter`
    (`run_all`, `TAX_PHASE4D.md`); attach the JSON report.
- **Status:** ◐ **Plumbing built and passing** (T06/T07/T14 against the
  fake). Sandbox conformance is open: no provider yet.

### Gate 04: golden tests signed off
- **Evidence:**
  - **T06, T07 and T14 re-run against the provider sandbox, with expected
    values from the tax lead.**
  - The fixtures' rates are plumbing values, not legal answers, so they
    don't count.
  - Signed by the tax lead, the Finance controller and QA.
- **Verify:** the sandbox golden report (commit, provider version, cases,
  expected vs actual) referenced as the `evidence_ref`.
- **Status:** ☐ **Open.** Needs the provider sandbox and the tax lead's
  expected values.

### Gate 05: provider contracts, SLA, failure/rollback, reconciliation
This gate must PASS for provider markets: validation refuses
NOT_APPLICABLE (G1, fixed).

| Item | Evidence | Verify | Status |
|---|---|---|---|
| Contract and SLA | Signed contract, SLA (availability, latency, support), and a DPA covering the minimised payload and the pseudonymous `customer_ref` | Procurement/Legal sign-off | ☐ Open: no provider |
| Real adapter | `ProviderAdapter` for the vendor, registered in `PROVIDER_REGISTRY` with allowlisted https endpoints only | Code review; conformance suite on the sandbox | ☐ Open (4d) |
| **GCP Secret Manager** | 4d-0 PR 1 (merged). The GCP admin provisions it per `TAX_PHASE4D0.md`: API, region, service account with no keys, the `tax-provider-` IAM condition, Data Access audit logs, `ENVIRONMENT=production`. Then `TAX_PROVIDER_SECRET_STORE=gcp`. | Startup succeeds with gcp; creating `tax-provider-sandbox-org0-conn0` works and other names are denied; audit logs show access | ◐ Code merged; **provisioning pending (VM/GCP admin)** |
| Production credentials | `TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED=true`, only with gcp | Startup refuses it otherwise | ☐ Stays false until this gate |
| **Reconciliation worker** | 4d-0 PR 2: the `zoiko-billing-tax-worker` unit running; `TAX_PROVIDER_RECONCILIATION_MODE=worker`; heartbeat fresh; the two-worker race test green in CI | `systemctl status`; heartbeat age under 15 min; CI tax step | ◐ Code on the branch; **VM sudoers/unit pending (VM admin)** |
| Failure and rollback | Fail-closed defaults agreed by ops/SRE (circuit breaker, heartbeat, grace, quote expiry; `TAX_PHASE4A1.md`); the kill switch and runbook rehearsed; a stuck-transaction drill (check-state, retry, two-person void) | Drill record | ☐ Open |
| Reconciliation | Drift checks in place; a Finance systems owner signs a sandbox reconciliation: our totals, components and tax dates against the provider's records for a test batch (T10, T15, T18, T20) | Signed reconciliation report | ☐ Open |

### Gate 06: UI and audit evidence
- Same as for native markets, plus:
  - the provider-connection screens (write-only credentials,
    `rotation_pending_test`);
  - stuck transactions;
  - the address-resolution prompts (`ADDRESS_NOT_RESOLVED`, `_AMBIGUOUS`,
    `_RESOLUTION_STALE`);
  - certificate evidence upload.
- **Status:** ◐ **Platform console (5a), tenant governance screens (5b)
  and provider operations screens (5c PR 2) built.**
  - Address resolution status (including stale), manual resolution
    requests and certificate evidence are on T7.
  - **Provider connections:** status, health, test, write-only credential
    entry and rotation (`rotation_pending_test`), revoke, safe mode
    (estimate only), and two-person propose/approve and resume.
  - **Stuck transactions:** state, age, last error and owner; check
    provider state, retry local finalize, and a two-person void.
  - **P9 provider operations:** aggregate health, plus suspend/resume
    with TAX_PUBLISHER and MFA.
  - **Mode change (5c PR 3):** safe mode (estimate only) ↔ commit on the
    same connection; a different finance approver approves with MFA. Tenant
    MFA enrolment doesn't exist yet, so approval is fail-closed until it
    does.
  - Still open:
    - QA and a manual WCAG pass;
    - tenant MFA enrolment, for mode-change approval.

### Gate 07: availability registry and visibility
- **Evidence:**
  - Each Canadian and US cell published as `PROVIDER_APPROVED` only after
    gates 01–06.
  - Visible to Sales/Support through `GET /api/v1/tax/coverage`.
- **Status:** ☐ **Open.**

### Provider-specific go-live items (part of gates 05 and 07)

| Item | Owner | Evidence | Status |
|---|---|---|---|
| **Pseudonym key set once** | GCP admin + security owner | `tax-provider-pseudonym-key` created in Secret Manager, and `TAX_PROVIDER_PSEUDONYM_KEY_SECRET` pins a **numbered** version (latest is refused). Set **before** the first US provider activation; approval is refused without it. Never rotated without the remap procedure (the remapping tool is deferred). | ☐ Open |
| DPO items | DPO / counsel | (a) The data sent to the provider is minimised: address, `customer_ref` pseudonym, exemption jurisdiction, tax type and reason; no names, emails, certificate numbers or files. (b) A DPA with the provider and the resolver. (c) Evidence retention vs erasure for certificates and resolutions (open since Phase 2). (d) Data residency: the Secret Manager region and provider data location. | ☐ Open |
| Address resolver (US) | Tax integrations owner | A resolver procured and registered in `ADDRESS_RESOLVERS`; rooftop/parcel precision confirmed (decision 2 of 4c); `dataset_version` reported | ☐ Open |
| Manual resolution and remap | Product owner | Both built (`TAX_PHASE4D.md`): two-person manual address resolution with evidence, and the pseudonym remap export. Rehearse the key-rotation procedure once in staging. | ◐ Built; rehearsal open |

### After the platform gates: per tenant
- An approved, credentialed provider connection (two people).
- Registrations per jurisdiction and tax type.
- Activations referencing the connection (two people).
- The pseudonym key baseline is recorded automatically at the first
  provider activation.
- The entity switched to GOVERNED (two people).
- For the US, buyers' addresses resolved.

---

## Status summary (2026-11-06)

| Gate | GB | AU | CA | US |
|---|---|---|---|---|
| 01 Legal authority and rights | ☐ | ☐ | ☐ | ☐ |
| 02 Provenance and freshness | ☐ | ☐ | ☐ | ☐ |
| 03 Resolution and determination tests | ◐ CI | ◐ CI | ◐ fake only | ◐ fake only |
| 04 Golden tests signed off | ☐ | ☐ | ☐ | ☐ |
| 05 Provider contract, SLA, recovery | N/A (note) | N/A (note) | ☐ (must PASS) | ☐ (must PASS) |
| 06 UI and audit evidence | ◐ screens + evidence export built; QA/WCAG open | ◐ screens + evidence export built; QA/WCAG open | ◐ screens + evidence export built; QA/WCAG open | ◐ screens + evidence export built; QA/WCAG open |
| 07 Availability and visibility | ☐ | ☐ | ☐ | ☐ |

☐ open · ◐ partly done (built, evidence or sign-off pending) · N/A only with a note

**No market is live.**
- No calculating availability is published.
- `PROVIDER_REGISTRY` and `ADDRESS_RESOLVERS` are empty in production.
- Production provider credentials are refused.

This file is updated as evidence is filed. The registry's gate entries
remain the record of truth.
