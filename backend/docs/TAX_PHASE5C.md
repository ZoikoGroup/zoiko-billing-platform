# Global Tax — Phase 5c: Finishing the Vendor-Independent Work

Phase 5c finishes the tax module's work that doesn't depend on a provider
contract. It has three PRs, each merged only after CI is fully green:

- **PR 1:** fixes, plus the audit-evidence export for launch gate 06.
- **PR 2:** tenant reports and the provider operations screens (built below).
- **PR 3:** the read-only screens and the UK/AU pilot runbook.

API: `TAX_CONTROL_CENTER_API.md` (the "Phase 5c" section).

## PR 1: fixes and gate 06 evidence

### 1. Who can download tenant tax documents

Before this PR, any signed-in member of the organization could download
registration and legal-basis evidence. These downloads now need the same
roles as upload and decision:

- **Allowed:** org_admin, billing_admin and finance_approver
  (`TAX_EVIDENCE_READER_ROLES` in `app/modules/tax/router.py`).
- **Refused (403):** any other tenant role, such as auditor.
- **Refused (404):** another organization.
- **Refused (403):** platform staff (T13).

The same rule now covers every tenant tax document download:

| Download | Before | Now |
|---|---|---|
| `GET /registrations/{id}/evidence` | any org member | reader roles |
| `GET /legal-bases/{id}/evidence` | any org member | reader roles |
| `GET /exemption-certificates/{id}/evidence` | any org member | reader roles |
| `GET /manual-resolutions/{id}/evidence` | any org member | reader roles |

The audit-evidence bundles below use the same rule.

### 2. Product names on classifications

`GET /api/v1/tax/product-classifications` now returns `product_name`, looked
up within the caller's organization only. The T6 screen shows "Consulting
hours → SVC" instead of "Product #5". Older rows fall back to the id.

### 3. Audit-evidence bundles (G-5a-5, gate 06)

A bundle is one record's full evidence and history. It comes in two
formats:
- **JSON:** machine-checkable.
- **HTML:** a printable summary. Save it as PDF from the browser.

| | Platform | Tenant |
|---|---|---|
| Route | `GET /api/v1/super-admin/tax-registry/evidence-bundles/{kind}/{id}` | `GET /api/v1/tax/evidence-bundles/{kind}/{id}` |
| Kinds | `source_revision`, `rate`, `tax_code_set`, `rule_pack`, `market_availability` | `registration`, `legal_basis`, `activation`, `classification`, `regime_change` |
| Who | Tax roles only (`tax_registry.read`); other platform roles and tenant users get 403 | org_admin, billing_admin, finance_approver; other roles 403; another org 404; platform staff 403 (T13) |
| Data | Platform data only; no tenant data | The caller's organization only |
| History from | `platform_audit_logs` (rows with no organization) | `billing_audit_logs` for this organization |
| Export audited as | `TAX_EVIDENCE_BUNDLE_EXPORTED` (platform audit), with kind and bundle SHA-256 | `EXPORT` (billing audit), with `evidence_bundle_sha256` |

**What a bundle contains:**
- **The record:** the same view the console shows. For a source, it
  excludes the internal storage URI.
- **Sources and evidence hashes:**
  - **Rate:** its legal source and that source's SHA-256.
  - **Rule pack:** each source dependency, resolved to its source
    revision's SHA-256.
  - **Tenant records:** the SHA-256, type and size of the attached
    document, and the evidence reference.
- **The golden-test report reference** (rule packs): suite, commit, passed,
  failed and CI run URL.
- **Approvals:** who drafted, made, checked and published, by name and
  role. Tenant bundles show who proposed or recorded, who decided and when.
- **History:** every state change in order, each with:
  - its timestamp;
  - the action;
  - the actor's name and role;
  - the reason and details.

  On platform decision events (approve, publish), `step_up_verified`
  records whether the same person passed an MFA step-up in the 10 minutes
  before. `step_up_required_for_decisions` records whether step-up was
  enforced.
- **The seal:** `bundle_sha256`, the SHA-256 of the canonical JSON
  (sorted keys, compact) without that field. The HTML summary prints the
  same hash and sends it in `X-Bundle-SHA256`. To verify a bundle, remove
  `bundle_sha256`, canonicalise, hash, and compare (`evidence_bundle.verify`).

**In the UI:** each record has "Export evidence (JSON)" and "Printable
summary" buttons:
- **Platform:** in the detail view for sources, rates, market availability
  and rule packs.
- **Tenant:** on each registration, legal basis, activation,
  classification and regime change.
- After a JSON export, the screen shows the bundle's SHA-256.
- The tenant buttons are hidden from roles the backend refuses.
- Tax-code sets have no console screen yet (P5 is PR 3), so their bundles
  are API-only for now.

**Notes:**
- Tenant decisions don't use MFA step-up today, so tenant bundles carry no
  step-up flags.
- The bundle includes the full platform audit trail for a record, which
  covers most of G-5a-2 (a per-item audit endpoint). A separate endpoint
  stays deferred.

### 4. Gate 06

`TAX_LAUNCH_GATES.md` gate 06 now lists what's built and what's left. Left:
- the QA walkthrough;
- a manual WCAG 2.2 AA pass;
- the PR 2 and PR 3 screens.

### PR 1 tests

| Test file | Covers |
|---|---|
| `backend/tests/privacy/test_tax_phase5c1_backend.py` (15) | An auditor gets 403 on all four document downloads. Upload and decide roles can download; another org gets 404; platform staff get 403. Classifications carry product names. Rate bundle: sealed, verifies, tamper fails, names in history, `step_up_verified` on the approval, no organization data, export audited. HTML summary with the hash header; unknown kind 400; missing record 404. Platform bundles refused to non-tax platform roles. Tenant bundles: evidence hash, names, audited `EXPORT`; legal basis proposer and decider; auditor 403, platform 403 (T13), other org 404. **Every** platform and tenant kind exports and verifies. |
| `backend/tests/test_tax_phase4c_pg.py` (+1, Postgres, CI tax step) | A tenant bundle on Postgres verifies and writes its `EXPORT` audit row |
| `frontend/.../TaxControlCenter.test.jsx` (+2) | JSON and printable exports from a detail view, the SHA-256 shown, files saved; a refusal shown as text |
| `frontend/.../TaxGovernance.test.jsx` (+2) | Product name, not id; classification export; export hidden from an auditor |

**CI result:** _see PR_.

## PR 2: reports and provider operations screens

### Screens

| # | Where | What it does | Who |
|---|---|---|---|
| **T10** Reports | `/billing/tax/governance/reports` | Legacy over-collection (percentage **and fixed** document discounts, labelled per invoice), totals by currency, and duplicate tax rows, with invoice detail. "Export CSV" on each. Read-only. | org_admin, finance_approver. Others see a note and no request is made. |
| Provider connections | `/billing/tax/governance/providers` | Status, mode, health (last test), credential (set or not, masked last four, last rotation), `rotation_pending_test` note, suspension reason. Actions: propose; approve/reject (DecisionBar); withdraw; Test connection; set/rotate credential; revoke credential (reason; suspends at once); ask to resume; approve/reject resume. | Read: every tenant role. Propose, test, credentials, revoke, ask to resume: org_admin, billing_admin. Decide: a **different** finance_approver. |
| Provider transactions | `/billing/tax/governance/transactions` | Stuck or closed rows with state, age, attempts, last error, review reason and **owner**. Filter by state (default: needs review). "Check provider state" shows what the provider holds and changes nothing. "Retry local finalize" (only for rows that failed on our side or are unresolved). "Void remote", then "Approve void" by a different finance approver. | Read: every tenant role. Check, retry, request void: org_admin, billing_admin. Approve void: finance_approver, not the requester. |
| **P9** Provider operations | `/super-admin/tax/providers` | Per provider: circuit (closed, open, suspended), counts per state, oldest active age. The reconciliation worker heartbeat. Suspend (reason) and resume. | Tax roles read. Suspend/resume: TAX_PUBLISHER with MFA step-up (prompt, then one retry); a reviewer sees the button disabled with the reason. |
| **P10** Findings | `/super-admin/tax/findings` | The same two findings as counts and totals only: organizations affected, invoices, totals by currency, duplicate rows. | Tax roles. |

**Safe mode.** The backend has no separate "safe mode" switch. The
nearest real control is the connection mode `ESTIMATE_ONLY`: it quotes
but can never issue. The screens label it "Safe mode: estimate only",
and new proposals default to it. Moving an approved connection between
modes means proposing a new connection; there is no mode-change route.
The other freezes are revoking the credential (the tenant's own
connection) and P9 suspend (the provider, for everyone).

**Credentials.** The secret goes into a password field (autocomplete off)
and is sent once with `PUT .../credentials`. The field is cleared on
success. The API never returns the secret, only `present`, `last4`,
`last_rotated_at` and `rotation_pending_test`. `rotation_pending_test` is
true only with the versioned Secret Manager store, which keeps the old
version until a test passes; with the local encrypted store, a rotation
replaces the secret at once.

### Backend additions

- **CSV export:** `format=csv` on the two tenant report routes.
  - The CSV has the invoice rows only.
  - A text cell starting with `=`, `+`, `-`, `@`, a tab or CR is prefixed
    with `'`, so a spreadsheet never runs it as a formula. Numbers,
    including negative ones, are left as they are.
  - Each export is audited as `EXPORT` on `TaxFindingsReport`, with the
    report name and row count.
  - Same roles as the JSON report.
- **`GET /api/v1/tax/providers`:** the code-defined provider registry, as
  names and environments only. No URLs, ever. Tenant users only.
- **`owner` on provider transactions:**
  - `system` (the reconciliation worker) while pending, uncertain or
    committed remotely;
  - `finance_approver` once a void is requested;
  - `billing_admin` when it needs a person (review, failed, cancelled);
  - `null` once closed.

### Not changed

- **P9 actions** use the existing Phase 4a-1 routes; suspend/resume
  already needed `tax_registry.approve` and MFA step-up.
- **P10** uses the existing aggregate reports.

### PR 2 tests

| Test file | Covers |
|---|---|
| `backend/tests/privacy/test_tax_phase5c2_backend.py` (25) | CSV formula-safety, headers, no-store and audit; JSON unchanged; bad format 422. CSV keeps the report roles (billing admin 403, platform 403). Cell rules. `/providers` has no URLs and refuses platform staff. **No connection route ever returns the secret** (set, rotate, list, get, test). Owner per state; owner moves to finance on a void request, then to none once voided; two-person void through the API. Platform staff can't reach connections or transactions (T13); provider health carries no organization or invoice data. |
| `frontend/.../ProviderScreens.test.jsx` (17) | T10: fixed and percentage discounts, CSV export, a billing admin is told and nothing is fetched, axe. Connections: propose defaults to safe mode, from the provider list, **no URL field**; status, health, masked credential and names. **The secret is sent once and is not in the DOM afterwards.** Revoke with reason; test; two-person approval; the resume requester can't approve; an auditor sees no write controls; axe. Transactions: state, age, error, owner, default filter; check-state changes nothing; retry only where allowed; **two-person void**; platform staff refused (T13); axe. |
| `frontend/.../ProviderOperations.test.jsx` (6) | P9: aggregate health and heartbeat; suspend with reason, then step-up and one retry; a reviewer is refused with the reason; closed to non-tax platform roles (T13); axe. P10: counts and totals only, with no tenant identifiers; axe. |

**CI result:** _see PR_.
