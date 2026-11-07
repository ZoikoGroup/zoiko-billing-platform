# Global Tax — Phase 7: Shadow Compare, Regression, Anomaly Monitoring, Remediation

Phase 7 covers handoff §10.1 steps 06 and 08, in four PRs. Each is merged
only on fully green CI:

- **PR 1:** shadow compare (step 06).
- **PR 2:** historical regression and boundary tests (step 06).
- **PR 3:** live anomaly monitoring (step 08).
- **PR 4:** targeted remediation tooling (step 08: no silent historical
  mutation).

## PR 1: shadow compare

### What it is

A **LEGACY_MANUAL** entity can opt in to shadowing.
- **Invoicing doesn't change.** Invoices keep being issued on legacy tax,
  exactly as before.
- **Every invoice is checked.** For each legacy invoice issued while
  shadowing, the platform computes what governed tax **would have been**
  and stores the comparison.
- **Nothing real changes:** no quote, no regime, no invoice.

### Who does what

| Step | Who | Route |
|---|---|---|
| Choose the pack shadows use (ACTIVE or a **draft**), and the advisory exit threshold | Tax lead (TAX_PUBLISHER), with MFA step-up; platform-audited | `POST /api/v1/super-admin/tax-registry/shadow/selections` `{rule_pack_version_id, exit_min_invoices, exit_min_days, reason}`; `…/{id}/end` |
| Propose shadowing an entity | Org admin, with a reason | `POST /api/v1/tax/shadow/enrolments` `{seller_entity_id, reason}` |
| Approve or reject | A **different** finance approver | `…/enrolments/{id}/approve` or `…/reject` |
| Withdraw a proposal, or end shadowing | Org admin | `…/withdraw`, `…/end` |

**Rules:**
- **Pack selection:**
  - one active selection per pack code (choosing again replaces it);
  - SUPERSEDED or REJECTED packs are refused;
  - the version must match the code.
- **Enrolment:**
  - only LEGACY_MANUAL entities;
  - one open proposal or shadow per entity at a time;
  - every step is in the tenant audit log.

### How the comparison is computed

- **When:** the scheduled job "Tax Shadow Compare" (`tax_shadow_job`, every
  `TAX_SHADOW_INTERVAL_MINUTES`, default 15, up to `TAX_SHADOW_BATCH_SIZE`
  invoices per run) picks the issued legacy invoices of shadowing entities.
  It takes those issued between the shadow's start and end that have no
  comparison yet.
- **Off the request path:** it runs after the invoice has committed, so
  issuing never waits for it.
- **Idempotent:** at most one comparison per invoice, enforced by a unique
  constraint.
- **Same engine as real issuing:** it reuses the governed engine's own
  `_determine`, with two differences:
  - lines are routed to the chosen shadow pack instead of the tenant's
    activations (the tenant has none for this);
  - the result is captured instead of writing a quote.

  So a shadow is exactly what governed issuing would compute with that
  pack.
- **Nothing is saved from the computation.** It runs inside a savepoint
  that is always rolled back; only the comparison row is written.
- **Failures are contained.** A failure is stored as outcome `ERROR` for
  that invoice, and the batch continues. Issuing is never affected.
- **Write-once.** A comparison never changes afterwards (ORM guard and
  Postgres trigger).

**Outcomes:** `MATCH`, `DIFFERENT`, `NOT_DETERMINED` (would have been
blocked), `REVIEW_REQUIRED`, `UNSUPPORTED` and `ERROR`.

**Causes for `DIFFERENT`**, most specific first:

| Cause | Means |
|---|---|
| `DISCOUNT_AFTER_TAX` | Legacy taxed before the document discount (the Phase 3a over-collection finding) |
| `TAX_MISSING_ON_LEGACY` | Legacy charged no tax on a line where governed tax applies |
| `RATE_DIFFERENT` | A line's legacy rate differs from the governed rate |
| `ROUNDING` | Same rates; the totals differ by at most one minor unit per line |
| `UNEXPLAINED` | None of the above |

For blocked outcomes, the cause is the engine's own refusal code (for
example `REQUIRED_FACTS_MISSING`), with its reason and issues.

**Each comparison stores:**
- per line: legacy rate and tax, governed rate and tax, the difference, the
  outcome and the legal reason;
- per component: code, label, rate and tax;
- the pack used.

### Exit signal (advisory only)

Per shadow:

> **N invoices over M days with zero unexplained differences** (UNEXPLAINED
> or ERROR)

- N and M are the tax lead's threshold on the active selection.
- It is shown as "threshold met (advice)".
- It **never switches the regime**: that stays the separate two-person
  regime switch, with MFA.

### Screens

- **Tenant:** **Tax governance → Shadow compare**
  (`/billing/tax/governance/shadow`).
  - Pick an entity; propose, approve, reject, withdraw or end.
  - The summary: match rate, differences by cause, would-have-been-blocked
    by reason, and unexplained.
  - The exit signal.
  - A drill-down list with an outcome filter, and the per-line and
    per-component detail on demand.
  - Export CSV (audited, formula-safe, the same exporter as the T10
    reports).
  - Read for every tenant tax role.
- **Platform:** **Tax Control Center → Shadow compare**
  (`/super-admin/tax/shadow`).
  - The chosen packs and thresholds, **Choose pack** (tax lead with MFA),
    and stop.
  - Across tenants: enrolments by state, compared, match rate and
    unexplained. **Counts only (T13).**

### PR 1 tests

| Test file | Covers |
|---|---|
| `backend/tests/privacy/test_tax_phase7_shadow.py` (13) | Two-person, audited enrolment for legacy entities only, one open at a time. **A matching invoice changes nothing**: no quote, the invoice and regime untouched. **Each cause** (rate, missing tax, discount after tax, unexplained). A would-be-blocked invoice (NOT_DETERMINED). **A failure is recorded as ERROR and the batch continues.** Idempotent, only invoices issued while shadowing, and write-once. Summary and the **advisory** exit signal (met, then not met after an unexplained difference; the regime never switched). The platform choice: one per pack code, the threshold, tax lead only with MFA. **HTTP:** summary, filtered drill-down, line detail, CSV; platform aggregate with no identifiers; platform 403 on tenant routes (T13); another org 404 or empty; enrolment route roles. |
| `backend/tests/test_tax_phase4c_pg.py` (+1, Postgres) | The comparison is write-once and can't be deleted; the enrolment's key fields are frozen; ending is allowed |
| `frontend/.../ProviderScreens.test.jsx` (+4) | Summary, causes, would-be blocks, the advisory exit signal and drill-down (axe); CSV; an org admin proposes and a different approver approves; an auditor has no controls |
| `frontend/.../ProviderOperations.test.jsx` (+2) | The chosen pack, threshold and counts only (axe); the tax lead chooses with step-up and one retry; a reviewer is refused |

**CI result:** _see PR_.

## PR 2: historical regression and boundary tests

### The regression runner (`app/modules/tax/regression/runner.py`)

- **Input.** It replays a fixed set of **anonymised** invoice inputs
  (`regression/fixtures/*.json`). These are shapes only: countries, buyer
  status, currency, tax date, line nets. There are no tenant, customer or
  invoice identifiers, and no production data.
- **Engine.** Fixtures go through the real native rule packs.
- **Report.** It lists every change in outcome, rate or tax between the
  version in force (the baseline) and the candidate:

| Subject | Candidate | Baseline |
|---|---|---|
| **Rule pack version** | The pack in code, with the published rates | The results recorded when the ACTIVE version of the same pack was approved. A first version has none, so every case is "new". |
| **Staged rate** | The published rates with the staged rate laid over them for its validity (through `EngineRequest.rate_lookup`; nothing is published) | The published rates alone |

**What a report records:**
- each case's per-line outcome, rate and tax;
- the document tax, using the pack's rounding (UK per line, AU per
  document);
- the changed cases (before and after), the unchanged and new ones, and any
  errors;
- the fixture-set hash and the baseline reference.

Reports are stored append-only in `tax_regression_reports`. Each run is
platform-audited.

### The approval gate

Approving a **rule pack version** (`RulePackService.approve`) or a **staged
rate** (`TaxRegistryPipeline.approve`) is refused without a **current**
report. A report is current when all three hold:
- **Same fixtures:** the fixture set is unchanged (same hash).
- **Same baseline:** the ACTIVE pack, or the rate versions published for
  that component.
- **Recent:** run within `TAX_REGRESSION_MAX_AGE_HOURS` (72).

The refusal says which of these failed. `TAX_REGRESSION_REQUIRED` (on by
default) controls the gate. The test suite turns it off by default, because
most tests exercise other approval rules;
`tests/privacy/test_tax_phase7_regression.py` turns it on and proves it.

**Routes** (platform, tax roles):
- `POST /api/v1/super-admin/tax-registry/regression/{rule_pack|rate}/{id}`
  runs and attaches a report (TAX_REVIEWER).
- `GET` the same path returns the latest report and `current_problem`.

**Screen.** The **Historical regression** panel on a rate's and a rule
pack's detail:
- whether the report is current, and if not, why approval would be refused;
- the cases, plus the changed ones with before and after;
- **Run regression**, for reviewers.

### Boundary cases (`tests/privacy/test_tax_phase7_boundaries.py`)

- **Midnight in the jurisdiction's time zone:**
  - The UK rate changes at 23:00 UTC on 30 June (00:00 BST); at 22:59 UTC
    it is still the old rate.
  - The AU rate changes at 14:00 UTC (00:00 AEST).
  - At UTC midnight both are past it, because the tax date is the local
    legal date (`legal_date_at`).
- **Tax dates either side:**
  - the day before and the day of the change;
  - before the first published rate, which is NOT_DETERMINED, never 0%.
- **A credit note across the change** reverses the original 20% after a
  25% rate is in force, both in the preview and in the credit note.
- **Multi-entity organizations:**
  - a governed GB entity quotes at 20%;
  - the organization's legacy AU entity can't get a governed quote;
  - each entity keeps its own regime;
  - a GB entity billing a French buyer is not determined, never 0%.

### PR 2 tests

| Test file | Covers |
|---|---|
| `backend/tests/privacy/test_tax_phase7_regression.py` (8) | Fixtures are anonymised shapes with a stable hash. A rate change lists every changed case (20.00 → 21.00, rate 20 → 21); cases outside the market don't run, and NOT_DETERMINED cases stay unchanged. A rate outside the fixture dates changes nothing. **Rate approval is refused without a report and with changed fixtures, then passes with a current one.** Staleness when the baseline changes and after 72 hours. Rule pack: no-baseline report, results incl. PER_LINE rounding (20.01) and out-of-coverage NOT_DETERMINED, and the approval gate. AU PER_DOCUMENT vs per-line rounding. Routes: a reviewer runs, a publisher reads only, unknown kind 400. |
| `backend/tests/privacy/test_tax_phase7_boundaries.py` (8) | The boundary cases above |
| `frontend/.../TaxControlCenter.test.jsx` (+2) | The regression panel: refusal reason, run, changes listed; a publisher can't run |

**CI result:** _see PR_.
