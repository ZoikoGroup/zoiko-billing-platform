# Tax Pilot Runbook: UK VAT and Australian GST (native rule packs)

This runbook takes the first pilot tenant from nothing to a governed
invoice and a credit note, and back again if needed. It covers UK VAT
(GB-VAT-DOMESTIC-SERVICES) and Australian GST (AU-GST-DOMESTIC-SERVICES).
Both are **native rule packs**: no tax provider is involved.

Scope is deliberately narrow. Each pack covers domestic, standard-rated
services in the home currency (GBP or AUD). Everything else is
**NOT_DETERMINED**: the invoice can't be issued with governed tax, and the
tax is never treated as 0%. This is not a claim of global compliance.

## Who does what

| Role | Who | Where they work |
|---|---|---|
| **Tax reviewer** (TAX_REVIEWER) | Zoiko tax team member who prepares changes | `/super-admin/tax/…` |
| **Tax lead** (TAX_PUBLISHER, MFA enrolled) | Approves and publishes. Never the same person as the reviewer for the same item. | `/super-admin/tax/…` |
| **Security operator** | Holds the platform "Pause invoice finalization" switch | `/super-admin/governance` |
| **Tenant org admin** | Legal entities, regime proposals | `/billing/tax/governance/…` |
| **Tenant billing admin** | Registrations, evidence, classifications, customer evidence, activations, invoices | `/billing/tax/governance/…`, invoices |
| **Tenant finance approver** | Approves tenant proposals. Never their own. | `/billing/tax/governance/…` |

**Two people, always:**
- **Platform:** every approval is by a different person from the one who
  prepared or submitted it, with MFA step-up.
- **Tenant:** every proposal is decided by a different finance approver.

The screens disable a button you may not use and say why.

**Before you start:**
- Every tenant finance approver who will approve the regime switch (2.6),
  a provider activation, a connection mode change or a provider void sets
  up MFA at `/billing/tax/governance/mfa`. Approving those asks for a code
  from an authenticator app; signing in doesn't.
- `/super-admin/tax/overview` shows "Two-person publishing: Ready". That
  means at least one reviewer and one publisher with MFA, and step-up
  required.
- If it shows "Not ready", enrol the publisher's MFA first.

---

## Part 1: Tax lead (platform). Do this once per market.

### 1.1 Capture source evidence (S11 for GB, S16 for AU)

1. **Open the source.** Tax reviewer: go to `/super-admin/tax/sources` and
   open **S11** (HMRC) for GB, or **S16** (ATO) for AU.
2. **Capture the evidence.** Under "Capture evidence":
   - upload the official page (PDF or HTML capture);
   - set "Redistribution" to the permission the tax lead has confirmed.

   The server computes the SHA-256.
   - **S11** doesn't itself state the UK standard rate; it links to
     `https://www.gov.uk/vat-rates`. Either record that the tax lead accepts
     S11 as enough, or register `https://www.gov.uk/vat-rates` as a new
     source (**Register source**) and capture it too.
   - **S16's** cited URL refuses automated retrieval. Save the public ATO
     page manually and upload that.
3. **Review.** The tax lead reviews the capture. The source is approved
   only when its evidence is captured **and** reviewed.

**Check:**
- the source shows "Evidence captured" with a SHA-256;
- "Export evidence (JSON)" on the source produces a bundle whose SHA-256 is
  shown on screen;
- keep the bundle with the gate 01/02 evidence.

### 1.2 Stage, approve and publish the rate

1. **Stage.** Tax reviewer: go to `/super-admin/tax/rates` and click
   **Stage rate**.
   - **GB:** component GB-VAT, tax code `standard`, scope GENERAL, 20%.
   - **AU:** component AU-GST, `standard`, GENERAL, 10%.
   - Take `valid_from` from the legal instrument, and pick the legal source
     from 1.1.
2. **Submit.** Validate, then **Submit for approval** with a reason.
   Then click **Run regression** on the rate's detail (Phase 7). It
   replays the anonymised fixtures and lists every case whose tax changes.
   Approval is refused until a current report is attached.
3. **Approve and publish.** Tax lead: in `/super-admin/tax/inbox` (or the
   rate's detail), check "Current vs proposed" and any conflicts. Then
   **Approve**, then **Publish**; each asks for an MFA code.

**Check:**
- `/super-admin/tax/explorer`: look up GB (or AU) for today. It shows one
  approved reference rate with its source, never "0%".
- Export the rate's evidence bundle. Every approval step shows
  `step_up_verified: true`.

### 1.3 Register and approve the rule pack

1. **Register.** Tax reviewer: go to `/super-admin/tax/rule-packs` and click
   **Register draft** for GB-VAT-DOMESTIC-SERVICES or
   AU-GST-DOMESTIC-SERVICES.
   Its declarations (coverage, rounding) are copied from code.
2. **Attach the golden-test report** (suite, commit, passed, failed = 0, CI
   run URL). Validation refuses a pack:
   - with a failed or missing report;
   - with an unapproved source;
   - whose declarations have drifted from the code.
3. **Validate**, then **Submit for approval**. Then **Run regression** on the pack's detail; approval
   needs a current report.
4. **Approve and publish.** Tax lead: work through the pack's sign-off
   checklist, shown in the pack's detail and in `TAX_PHASE3B.md`:
   - coverage;
   - treatment;
   - rounding: GB PER_LINE + HALF_UP, AU PER_DOCUMENT + HALF_UP;
   - golden tests T05 / T14.

   Then **Approve** and **Publish**, with MFA.

**Check:**
- the pack shows "Published";
- its evidence bundle lists every source dependency with its SHA-256, plus
  the golden-test report reference.

### 1.4 File the gate evidence

For each cell (GB · VAT and AU · GST, each for B2B_SERVICES and
B2C_SERVICES), file the evidence for launch gates 01–06
(`TAX_LAUNCH_GATES.md`):
- the source and rate bundles (gates 01–02);
- CI determination tests (03);
- the signed golden tests (04);
- gate 05 is not applicable for native packs; record the note;
- the UI and audit-evidence QA (06).

Store each as an `evidence_ref` you can cite in 1.5.

### 1.5 Publish market availability

1. **Draft.** Tax reviewer: go to `/super-admin/tax/availability` and click
   **Draft availability**. Set GB · VAT · B2B_SERVICES, mode `NATIVE_RULEPACK_APPROVED`,
   and every mandatory gate `PASSED` with its evidence reference from 1.4.
   Repeat for B2C_SERVICES, and for AU · GST.
2. **Validate**, then **Submit**.
3. **Approve and publish.** Tax lead: **Approve**, then **Publish**, with
   MFA.

**Check:**
- `/super-admin/tax/overview` shows the cells under "Published coverage:
  Supported";
- tenants see the same at `/billing/tax/governance/overview`;
- `GET /api/v1/tax/coverage` lists exactly these cells.

---

## Part 2: First pilot tenant

Use a tenant that has agreed to be the pilot. All screens are under
`/billing/tax/governance/`.

### 2.1 Legal entity (org admin)

1. **Check the entity.** In `entities`, the seller entity exists, with
   country GB (or AU), and is the default.
2. **Leave the regime alone.** It stays **Legacy manual** for now.

**Check:** `overview` shows the entity, "Legacy manual", and what still
blocks governed issuing.

### 2.2 Registration with evidence (billing admin)

1. **Add the registration.** In `registrations`, click **Add
   registration**: GB · VAT (or AU · GST), the registration number, and
   `valid_from`.
2. **Upload the evidence.** Upload the registration certificate (PDF, PNG
   or JPEG, up to 5 MB). It is attached once and can't be replaced.

**Check:**
- the registration shows "evidence: document attached";
- **Export evidence (JSON)** gives a bundle containing the document's
  SHA-256 (org admin, billing admin or finance approver only).

### 2.3 Product classification (billing admin, then a finance approver)

1. **Propose.** In `classification`, click **Propose classification** for
   each product the pilot will invoice, choosing a standard-rated services
   tax code.
2. **Approve.** A different finance approver runs **Preview impact** (the
   drafts and quotes that will need re-quoting), then **Approve**.

**Check:** each product shows by name, "→ SVC (Services)", Approved.

### 2.4 Customer evidence (billing admin)

1. **Find the customer.** In `customers`, search for the pilot customer.
2. **Record the tax address.** Use **Record address**; the address must be
   in the same country as the seller.
3. **Add the tax ID** (**Add tax ID**) for B2B customers.

**Check:** the address and ID show. If you skip this, the customer is
treated as a consumer: B2C, the same rate for these domestic packs.

### 2.5 Activation (billing admin, then a finance approver)

1. **Propose.** In `activations`, click **Propose activation**:
   - the entity;
   - GB · VAT (or AU · GST);
   - B2B_SERVICES (and B2C_SERVICES if needed);
   - the mode the platform offers (`NATIVE_RULEPACK_APPROVED`);
   - the registration from 2.2;
   - `effective_from`.
2. **Approve.** A different finance approver approves.

**Check:**
- **Check if in effect today** shows "In effect";
- `overview` no longer lists a missing activation.

### 2.6 Regime switch (org admin, then a finance approver)

1. **Propose.** In `regime`, review the eligibility. It must say governed
   is available and list the backing activation. Then **Propose switch to
   governed**, with a reason (**Propose switch**).
2. **Read the warning first.** Open drafts will need a re-quote; issued
   invoices are never changed.
3. **Approve.** A different finance approver approves.

**Check:**
- the entity shows **Governed**;
- the regime change's evidence bundle names the proposer and the decider.

---

## Part 3: First governed invoice

### 3.1 Quote (billing admin)

1. **Create the draft.** Create a draft invoice for the pilot customer with
   a classified product, in GBP (or AUD).
2. **Request the quote.** On the invoice page, the **Governed tax** panel
   has no quote yet. Click **Request tax quote**.

### 3.2 Review

1. **Read the panel.** It shows, per line:
   - net, tax per component and gross;
   - the legal treatment and reason;
   - the engine and the source (S11/S16 and the rate version);
   - the tax date.
   For GB, £100 net gives £20 VAT, so £120 gross (T05). For AU, 10% on the
   document total.
2. **Fix any status that isn't "Fresh".** If the panel shows NOT_DETERMINED,
   STALE or a blocking reason:
   - fix what it names (each reason has an owner);
   - click **Re-quote**.

   Drafts that can't be issued also appear at `/billing/tax/exceptions`.

### 3.3 Issue

Finalize or send the invoice as usual. The gate re-checks that the quote
is fresh and matches the document, then copies the tax onto the invoice and
commits the quote.

**Check:**
- the invoice is SENT with the quoted tax;
- the panel shows the quote as **Committed**;
- the invoice's tax summary (`GET /api/v1/tax/invoices/{id}/tax-summary`)
  matches.

### 3.4 Credit note (billing admin)

1. **Open the dialog.** On the issued invoice's page, the **Governed tax**
   panel shows **Create governed credit note**. You need to be a billing
   admin or org admin.
2. **Choose what to credit:**
   - **Full credit** of everything not yet credited; or
   - **Partial:** a quantity per line.
   Then give a reason.
3. **Preview.** Click **Preview credit**. It shows what will be reversed,
   from the invoice's committed snapshot: net, tax per component with its
   rate, gross, and the legal treatment per line. It is never recalculated
   at today's rates. The preview runs the same calculation as the credit
   itself, so the amounts match to the cent.
4. **Confirm.** Click **Confirm credit note**.
5. **Provider invoices only.** For an invoice committed at a tax provider,
   the dialog shows the provider adjustment's progress; use **Refresh
   status**. If it needs review, follow **Open stuck transactions**
   (`/billing/tax/governance/transactions`).

The normal **Credit Notes** page (`/billing/credit-notes`) is unchanged and
still refuses governed invoices, so governed tax can't be changed by typed
amounts.

**Check:**
- the credit note's net, tax and gross equal the preview;
- crediting the rest later completes each line exactly: the original plus
  all its credits net to zero, to the cent;
- a provider adjustment ends as "Adjusted at the provider".

---

## Part 3b: Optional, a shadow period before switching (Phase 7)

Run this before 2.6 (the regime switch) to see what governed tax would have
charged, without changing any invoice.

1. **Tax lead** (`/super-admin/tax/shadow`): **Choose pack**.
   - Pick the UK (or AU) pack. A draft is fine.
   - Set the exit threshold, for example 50 invoices over 30 days.
   - Confirm with MFA.
2. **Org admin** (`/billing/tax/governance/shadow`): choose the entity, then
   **Propose shadowing this entity** with a reason.
3. **A different finance approver:** **Approve**.
4. **Keep invoicing as usual.** Every 15 minutes, newly issued invoices are
   compared.
5. **Review weekly.**
   - Look at the match rate and the differences by cause.
   - Open each **Unexplained** one (Show lines), and raise any with the tax
     lead.
   - "Would have been blocked" shows the facts to fix before switching,
     such as classifications and addresses.
   - Export CSV for the record.
6. **When the exit signal says the threshold is met,** with zero
   unexplained differences, the tenant may decide to switch (2.6). The
   signal is advice: switching is still the two-person regime switch.
7. **End shadowing** (org admin) once switched or abandoned.

**Check:**
- invoices keep their legacy tax;
- the comparisons appear within 15 minutes of issuing;
- the platform view shows counts only.

## Part 3c: Remediating legacy findings (Phase 7)

Use this only after the product owner has approved remediation for the
organization. Until then it is preview only.

1. **Ops:** add the organization id to `TAX_REMEDIATION_OVERCOLLECTION_ORGS`
   and/or `TAX_REMEDIATION_DUPLICATES_ORGS`, then redeploy.
2. **Org admin** (`/billing/tax/governance/remediation`):
   - review the previews: credit amounts, and rows to remove or flagged;
   - select up to 25 invoices;
   - **Propose batch** with a reason.
3. **A different finance approver:** **Approve**. This executes the batch.
4. **For corrective credit notes:** approve and issue each DRAFT credit note
   on **Credit Notes** as usual.
5. **Keep the batch's evidence** (Export evidence on the batch).
6. **To undo a duplicate-row batch:** **Reverse from archive**, with a
   reason. Credit notes are undone by voiding them in the credit-note flow.

**Check:**
- the invoices are unchanged;
- the batch shows Executed, with an evidence SHA-256;
- the T10 report and the duplicate count drop for the remediated invoices.

## Part 4: Rollback

Use the smallest step that stops the problem.

| Problem | Step | Who | Effect |
|---|---|---|---|
| Any issuing incident (all tenants) | **Pause invoice finalization** at `/super-admin/governance`, with a reason and an incident reference | Security operator | **Platform-wide.** No tenant can finalize or send a draft. Drafts are preserved. It auto-expires; resume it explicitly when fixed. Already-issued invoices are untouched. |
| The pilot tenant should stop governed tax | **Regime switch back:** in `regime`, **Propose switch to legacy manual** with a reason; a different finance approver approves | Org admin + finance approver | That entity's new issuing goes back to legacy manual tax. Issued invoices and committed quotes are never changed. |
| A published rate or pack is wrong | Publish a corrected version (the old one is superseded), or set the market availability back from `NATIVE_RULEPACK_APPROVED` | Tax reviewer + tax lead | New quotes use the correction. Existing quotes go stale or are refused at issue. |

**What happens to drafts after a switch back to legacy:**
- Their governed quotes go stale; the entity's version changes. They are
  never used again.
- When a draft is issued, it goes through legacy manual tax: the tax on its
  lines is recalculated the legacy way.
- **Review every open draft before issuing it.** The legacy tax rates on its
  line items may differ from the governed quote the customer saw.
- Drafts listed at `/billing/tax/exceptions` drop off the list, because
  they are no longer governed.

**Check after a rollback:**
- **Pause:** `/super-admin/governance` shows finalization paused, with the
  reason. Trying to finalize a test draft is refused, and the draft stays a
  DRAFT.
- **Regime:** the entity shows **Legacy manual**. Issued invoices are
  unchanged. The regime change's evidence bundle shows both people.

---

## Part 5: Checks after each step (summary)

| After | Check |
|---|---|
| 1.1 Sources | Evidence captured with SHA-256; the evidence bundle is exported and filed |
| 1.2 Rate | The explorer shows one approved rate with its source; the bundle shows step-up on approve and publish |
| 1.3 Pack | Published; the bundle lists source hashes and the golden report |
| 1.4 Gates | An evidence reference for each of gates 01–06 per cell |
| 1.5 Availability | The overview shows the cells "Supported"; tenants see them in their overview |
| 2.1 Entity | The tenant overview shows the entity and its remaining blockers |
| 2.2 Registration | Document attached; the bundle has its SHA-256 |
| 2.3 Classification | Products show by name, Approved |
| 2.4 Customer | Address (and tax ID) recorded |
| 2.5 Activation | "In effect" today |
| 2.6 Regime | Governed; the bundle names both people |
| 3.1–3.2 Quote | Fresh quote; £100 → £20 → £120 (GB) |
| 3.3 Issue | SENT; quote Committed |
| 3.4 Credit | The created credit equals the preview; provider adjustment done |
| 4 Rollback | Paused or Legacy manual as intended; issued records unchanged |

Keep every exported evidence bundle (JSON, with its SHA-256) with the
pilot record. Every export is itself in the audit log.
