# Global Tax — Phase 5c: Finishing the Vendor-Independent Work

Phase 5c finishes the tax module's work that doesn't depend on a provider
contract. It has three PRs, each merged only after CI is fully green:

- **PR 1:** fixes, plus the audit-evidence export for launch gate 06.
- **PR 2:** tenant reports and the provider operations screens.
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

### Tests

| Test file | Covers |
|---|---|
| `backend/tests/privacy/test_tax_phase5c1_backend.py` (15) | An auditor gets 403 on all four document downloads. Upload and decide roles can download; another org gets 404; platform staff get 403. Classifications carry product names. Rate bundle: sealed, verifies, tamper fails, names in history, `step_up_verified` on the approval, no organization data, export audited. HTML summary with the hash header; unknown kind 400; missing record 404. Platform bundles refused to non-tax platform roles. Tenant bundles: evidence hash, names, audited `EXPORT`; legal basis proposer and decider; auditor 403, platform 403 (T13), other org 404. **Every** platform and tenant kind exports and verifies. |
| `backend/tests/test_tax_phase4c_pg.py` (+1, Postgres, CI tax step) | A tenant bundle on Postgres verifies and writes its `EXPORT` audit row |
| `frontend/.../TaxControlCenter.test.jsx` (+2) | JSON and printable exports from a detail view, the SHA-256 shown, files saved; a refusal shown as text |
| `frontend/.../TaxGovernance.test.jsx` (+2) | Product name, not id; classification export; export hidden from an auditor |

**CI result:** _see PR_.
