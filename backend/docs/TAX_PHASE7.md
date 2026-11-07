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
