# Global Tax — Phase 5b: Control Center Follow-Ups and Tenant Tax Settings

Phase 5b has two PRs:
- **PR 1** finishes two Tax Control Center gaps the tax lead needs before
  sign-off.
- **PR 2** adds the tenant Settings → Taxes screens (`TAX_PHASE4_PLAN.md`,
  T1–T8).

API: `TAX_CONTROL_CENTER_API.md` (the "Phase 5b" sections).

## PR 1 (merged as #142): pickers and names in the Tax Control Center

- **G-5a-1:** read-only `GET /tax-registry/authorities`, `/tax-types` and
  `/components` (tax roles only, paged).
  - The forms now use pickers: authority, component, legal source and tax
    type.
  - Creating or editing these stays deferred (B2).
- **G-5a-3:** `GET /tax-registry/people` lists only platform users holding
  a tax role: name and role, no email.
  - The inbox, timelines and detail views show "Mara Maker (Tax Reviewer)".
  - Tests prove no other platform users and no tenant users are exposed.

## PR 2: tenant Settings → Taxes (`/billing/tax/governance/…`)

### Who can use it

These mirror the backend dependencies:

| Role | Can do |
|---|---|
| **org_admin** | Everything a billing admin can; plus legal entities (add, edit, set default) and proposing or withdrawing a regime change |
| **billing_admin** | Read; add registrations; propose legal bases, activations, classifications and manual resolutions; upload evidence; record customer addresses, tax IDs and certificates; resolve addresses; resolve review items |
| **finance_approver** | Read; approve or reject proposals, never their own |
| **auditor** | Read only |
| Anyone else, including super admin | "No access to tax governance". The `/billing` area is already closed to super admins, and the tenant tax API refuses platform tokens. |

### Screens

| # | Section | What it does |
|---|---|---|
| T1 | `overview` | Each seller entity's regime as a badge, and **what blocks governed issuing** (the eligibility endpoint's unmet conditions) or "ready". A legacy-manual notice explains that nothing changes until a regime switch is approved. |
| T2 | `entities` | Legal entities: country, timezone, tax ID, default. Org admins add, edit (with the version check) and set the default. The regime is changed only on T5. |
| T3 | `registrations` | Registrations (status and verification badges, validity, evidence) and legal bases (proposal, approve/reject/withdraw). **Evidence upload** for both: a registration any time, a legal basis while proposed. Pickers for entity, jurisdiction and tax type. |
| T4 | `activations` | Activations with their mode, period, and backing registration, legal basis or provider connection. "Check if in effect today" shows the effective state and why not. **Proposing offers only the mode the platform published for that market** (from the coverage view). A provider activation picks an approved provider connection of the entity; a tenant-rate activation shows its rate fields. |
| T5 | `regime` | Current regime, **the eligibility checklist**, and proposing a switch in **either direction** (org admin). The proposal dialog warns that **open drafts' tax quotes go stale and issued invoices never change**. Lists regime changes with approve/reject (a different finance approver) and withdraw. |
| T6 | `classification` | Product classifications. Proposing one picks a product (search) and a tax code. **"Preview impact"** shows the draft invoices and open quotes that would need a re-quote. Then approve/reject/withdraw. |
| T7 | `customers` | Find a customer, then: **addresses** with resolution status as a badge (Resolved, **Stale** when past `valid_until`, Ambiguous, Not found, Not resolved), resolve or "Resolve again", and the **manual-resolution request** for ambiguous or not-found addresses (codes, reason, evidence, then a two-person decision); **tax IDs** (add, retire); **exemption certificates** (add with a jurisdiction picker, evidence, revoke; an expired certificate shows "Expired"). |
| T8 | `review` | **Added because review items were not reachable from Taxes → Exceptions.** Lists open items (or all) with kind, detail, subject, due date, **owner role and age**: certificate or registration expiry, stale address resolution, provider drift, credential versions not destroyed. Billing admins mark them resolved. |

### Rules applied on every screen

- **Two people:**
  - Approve and reject are **disabled for the proposer**. The reason ("You
    proposed this; a different finance approver must decide it.") is shown
    as text and tied to the buttons.
  - For non-approvers the reason is "Only a finance approver can approve or
    reject."
  - The backend enforces both.
- **MFA step-up:** tenant decisions don't need it on the backend today.
  Approvals still go through 5a's step-up hook, so a future
  `TAX_REGISTRY_STEP_UP_REQUIRED` prompts for a code and retries once.
  This is tested.
- **Uploads:**
  - The backend's rules are checked in the browser too: PDF, PNG or JPEG
    only, not empty, at most 5 MB.
  - Each rule has its own error message, and nothing is sent until it
    passes.
  - The browser computes a SHA-256 and sends it. The server verifies it and
    stores the file write-once.
- **Names, not ids:** proposers and deciders are shown by name and role from
  the tenant's own directory (`GET /api/v1/tax/people`).
- **Legacy-manual tenants:**
  - The existing Tax Rates, Tax Configuration, Exceptions, Reports and
    Settings pages are unchanged.
  - The governance screens are visible, and viewing them makes no change
    (tested: no write calls when the overview loads).
- **Tenant data only:** only tenant tax routes plus reference data
  (jurisdictions, tax types, published coverage). No platform-registry or
  cross-tenant calls.
- **Accessibility and themes:**
  - Statuses are always icon + text.
  - Navigation uses links with `aria-current`; forms use labelled fields;
    dialogs use the shared Modal.
  - Light and dark themes.
  - Lists page with `next_cursor`.
  - axe runs on T5 and T7.

### Backend additions (separate commit, additive)

1. **Registration and legal-basis evidence:**
   - `POST`/`GET /registrations/{id}/evidence` and `/legal-bases/{id}/evidence`.
   - The same type, size and hash rules as certificate evidence.
   - Write-once (ORM guard and Postgres trigger).
   - Migration `c9f1e3a5b7d2`.
2. **`GET /api/v1/tax/people`:** the caller's own organization's users
   (name, role; no email, no platform users, no other tenants).
3. **`GET /api/v1/tax/tax-types`:** reference data for tenant pickers.

## Gaps (bigger than an additive endpoint)

| # | Gap | Effect today |
|---|---|---|
| G-5b-1 | Tenant **reference rates (T9)** and **reports (T10)** screens | Not built (not in this PR's scope); the APIs exist |
| G-5b-2 | No **provider-connection or stuck-transaction screens** for tenants | Provider activations pick an existing connection; connections are managed through the API |
| G-5b-3 | **No product names on classifications** | The classification view carries only `product_id`, so the list shows "Product #5". The proposal picker shows names. A `product_name` field on the view would fix it. |
| G-5b-4 | **Customer search uses the billing customers list** | Needs `search_term`; fine for now, and no tax-specific customer index |

## What was cut

- **Registrations:** editing (validity, verification results) beyond
  recording one.
- **Legal entities:** deactivating one (available in the API).
- **Tax IDs:** verification recording (`/tax-ids/{id}/verification`; the
  badge shows its status).
- **Pseudonym key screens:** acknowledgement and remap export (API only;
  they are platform-wide operations).
- **Provider-connection management.**

## Tests

| Test file | Covers |
|---|---|
| `frontend/src/modules/tax-governance/TaxGovernance.test.jsx` (20) | **No-access guard** (super admin, unknown role, no user); an auditor reads with no write controls. T1: regime, blockers, the **legacy notice, and no write calls**. T2: an org admin adds an entity; a billing admin can't. T3: a registration with pickers; **upload validation** (type, size, empty; nothing sent until valid; a valid PDF is sent); **the proposer can't approve**, with the reason; names, not ids. T4: a different approver approves with **step-up then one retry**; only the platform's published mode is offered; **pagination**. T5: eligibility, the stale-drafts and issued-invoices warning, propose, decide; **axe**. T6: impact preview. T7: stale and ambiguous resolution badges, "Resolve again", an expired certificate, a manual-resolution request; **axe**; the resolution-state rules. T8: owner, age, resolve. |
| `backend/tests/privacy/test_tax_phase5b2_backend.py` (7) | Registration evidence upload, download, hash and write-once; legal-basis evidence only while proposed; size limit; only billing admins upload; other tenants get 404; platform staff get 403; `/people` lists only the caller's organization with no email; `/tax-types` |
| `backend/tests/test_tax_phase4c_pg.py` (+1, Postgres) | Registration evidence write-once, and both triggers present |

**CI result:** _see PR_.
