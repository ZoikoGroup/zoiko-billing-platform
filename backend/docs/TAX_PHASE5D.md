# Global Tax — Phase 5d: Pilot Completeness

Phase 5d closes the two gaps PR 3 of Phase 5c found before the UK/AU pilot
(`TAX_PILOT_RUNBOOK_UK_AU.md`). It has two PRs, each merged only after CI
is fully green:

- **PR 1:** a governed credit-note screen (pilot step 3.4).
- **PR 2:** tenant MFA step-up. It needs the security owner's approval
  before merge.

## PR 1: governed credit-note screen

### Screen

The dialog opens from the invoice's **Governed tax** panel
(`GovernedTaxPanel`), via **Create governed credit note**.

**Shown when:**
- the invoice is not a draft or cancelled;
- its quote is COMMITTED;
- the user is an org admin or billing admin. That is the existing
  credit-note flow's permission; the backend enforces it.

**Flow:**
- **Choose:**
  - full credit of everything not yet credited; or
  - partial: a quantity per line. The fraction is quantity ÷ invoiced
    quantity, and the exact remaining fraction when it completes the line.
- **Reason:** required.
- **Preview:** net, tax per component (label and rate), gross, and the
  legal treatment per line.
- **Confirm:** through the existing
  `POST /api/v1/tax/invoices/{id}/credit-notes`. Full sends type
  `full_credit`, partial sends `partial_credit`.
- **Provider-committed invoices:**
  - the dialog says the provider transaction will be adjusted;
  - after confirming, it shows the ADJUST state (adjusting, adjusted, needs
    review, refused) with **Refresh status**;
  - stuck states link to `/billing/tax/governance/transactions`;
  - earlier governed credit notes are listed with their ADJUST state.

The legacy Credit Notes page and its flow are unchanged, and it still
refuses governed invoices.

### Backend

`GovernedCreditService.create` is split into:
- `_plan()`: the reversal from the committed snapshot, with no writes;
- `create()`: writes it.

`preview()` uses the same `_plan()`, so the preview is exactly what will be
credited.

**New routes** (billing admin, the caller's organization; another
organization gets 404, platform 403):

```
GET  /api/v1/tax/invoices/{id}/credit-notes/creditable
     -> {invoice_number, status, currency, provider_committed,
         lines: [{invoice_item_id, line_number, description, quantity, net, tax_amount, line_total,
                  credited_fraction, remaining_fraction, outcome, legal_reason,
                  components: [{component_code, label, rate_percent, tax_amount}]}],
         credit_notes: [{id, credit_note_number, status, total_amount, tax_amount,
                         adjust: {transaction_id, state, last_error} | null}]}
POST /api/v1/tax/invoices/{id}/credit-notes/preview   {lines: [{invoice_item_id, fraction}]}
     -> {subtotal, tax_amount, total_amount, provider_committed,
         lines: [{…, credited_net, outcome, legal_reason, components: [{…, credited_tax}]}]}
     400: the same refusals as create (beyond 100%, not governed, not committed, …); nothing is written
```

### Tests

| Test file | Covers |
|---|---|
| `backend/tests/privacy/test_tax_phase5d1_credit_screen.py` (8) | Creditable lines; **preview equals the created credit note to the cent and writes nothing**, full and two partial cases; partial then the rest reconciles to the invoice's tax, creditable tracks it, and over 100% is refused; the same permissions (auditor and finance approver 403, other org 404, platform 403); a legacy invoice is refused; a provider-committed credit shows ADJUST, pending then done. |
| `frontend/src/modules/billing/tax/governed-credit-note.test.jsx` (11) | The button only for billing roles on a sent, committed invoice. Full credit: reason required, preview amounts exactly as the server returns them, confirm through the governed route; axe. Partial: lines and quantities; the exact remainder completes a line. Provider: ADJUST "needs review" with the stuck-transactions link; earlier credit notes' ADJUST state. |
| Legacy | `frontend/src/modules/billing/invoicing` unchanged; its 47 tests pass. |

Also in this PR: two console step-up tests wait for the MFA dialog by name
with a longer timeout. One failed once on a slow CI runner in Phase 5c
PR 3; the code is unchanged.

**CI result:** _see PR_.

## PR 2: tenant MFA step-up (security owner approval needed before merge)

### Security summary (for the security owner)

**Threat addressed.**
- The four tenant tax approvals rested on a password alone:
  - a regime switch;
  - a provider activation;
  - a provider connection mode change (safe mode ↔ commit);
  - a provider void.
- Each sends or stops a tenant's invoices through a tax provider, or
  changes how tax is charged.
- A stolen finance-approver password was enough to approve them. They now
  need a fresh TOTP or recovery code from that approver: possession of a
  second factor at the moment of approval.

**What changed in auth:**
- **Enrolment is open to tenant users.** `/api/auth/mfa/setup/start`,
  `/setup/verify`, `/status` and `/disable` accept any signed-in user. It
  is opt-in. They reuse the platform implementation unchanged: the same
  `super_admin_mfa` row per user, TOTP secret encrypted with
  `MFA_ENCRYPTION_KEY`, recovery codes stored as SHA-256 only and shown
  once, replay protection, and the account lockout counter.
- **Audit placement.** A tenant user's MFA events are written to their own
  organization's billing audit log (entity `UserMFA`), not the platform
  audit log. A Super Admin's stay in the platform log as before.
- **Two-person reset.** An org admin requests a reset of another user in
  the same organization, with a reason. A different org admin approves it.
  - Never their own MFA.
  - Never another organization's user (404).
  - Never a platform user.
  - Audited; the target is emailed.
  - Stored as `reset_requested_by` / `_at` / `_reason` on
    `super_admin_mfa` (migration `e6b1d3f5a7c9`).
- **Phase 1 finding 8 fixed.** `GET /api/auth/mfa/status` returned
  `enabled: true` while platform step-up was retired, whether or not the
  account had a factor. It now reports real enrolment (`enabled` =
  `enrolled`), and says separately whether each control asks for a factor:
  `step_up_required`, `tax_registry_step_up_required`,
  `tax_tenant_step_up_required`, `bypassed`.
- **`bypassed` now means only the dev bypass.** It used to be true
  whenever no code was required, including while step-up was retired.
  "No code needed" is now `step_up_required: false`. No frontend reads this
  endpoint; `tests/test_mfa_step_up_retired.py` is updated to match.

**What did not change:**
- **Login.** `login_user` never involves MFA, for any role; a test proves
  an enrolled tenant user signs in with the password alone.
- The platform MFA flows (Super Admin enrolment, platform step-up,
  `admin_reset_mfa`).
- `MFA_STEP_UP_ENABLED`.
- The dev-only `MFA_STEP_UP_BYPASS`, which is still refused unless DEBUG
  is on.

**Settings.**
- `TAX_TENANT_STEP_UP_REQUIRED` (default true) governs the tenant
  approvals only. `TAX_REGISTRY_STEP_UP_REQUIRED` governs the platform
  registry only. Neither turns the other off (tested both ways).
- Turning either off is logged as a warning on every decision.

**Fail-closed behaviour:**
- An approver without MFA gets `TAX_MFA_ENROLMENT_REQUIRED`; the screen
  shows "Enrol MFA to approve" with a link to set it up.
- Enrolled but no code: `TAX_REGISTRY_STEP_UP_REQUIRED`, with the same
  prompt and one retry as the console.
- The factor is verified before any change.

### What it covers

| Approval | Route | Step-up when |
|---|---|---|
| Regime switch | `POST /regime-changes/{id}/approve` | Always (either direction) |
| Provider activation | `POST /activations/{id}/approve` | The activation has a provider connection. Native and tenant-config activations are unchanged. |
| Connection mode change | `POST /provider-connections/{id}/mode-change/approve` | Always (was the registry setting in 5c; now the tenant setting) |
| Provider void | `POST /provider-transactions/{id}/void-approve` | Always. The requester is refused before any factor is asked for. |

The approval bodies accept `code` or `recovery_code`. Rejections don't need
a factor.

### Screens

- **MFA** at `/billing/tax/governance/mfa`:
  - **Your MFA:** set up (key and authenticator link, a code, then the
    recovery codes shown once), or turn off with your password.
  - **Org admins also see** who in the organization has MFA on, and request,
    approve or cancel a reset. Their own row and their own request are
    disabled, with the reason.
- **Approvals.** On the regime, activation, mode-change and void approvals,
  a missing enrolment shows "Enrol MFA to approve … Set up MFA" with a
  link. A missing code opens the MFA prompt and retries once.

### Tests

| Test file | Covers |
|---|---|
| `backend/tests/privacy/test_tax_phase5d2_tenant_mfa.py` (13) | Tenant enrolment over HTTP, with events in the org's billing log and none in the platform log; a recovery code works once. **Step-up on each of the four approvals:** enrol prompt, then code prompt, then success; native activations are unaffected; the void requester is refused first. **The settings are independent,** both ways. The dev bypass is refused outside DEBUG. **A reset needs two org admins, never your own;** non-admins are refused; audited. Admins see enrolment; **no cross-org access** (list and reset); platform 403. **Finding 8:** status reports real enrolment while step-up is retired. **Login unchanged** for an enrolled tenant user. |
| Existing tests updated | `test_tax_phase4a2_api` (regime two-person) and `test_tax_phase5c2_backend` (void owner) turn tenant step-up off, with a pointer to this file. `test_tax_phase5c3_mode_change` expects the new enrolment error. |
| `frontend/.../ProviderScreens.test.jsx` (+5) | Enrol-to-approve message and link; void approval step-up with one retry; enrolment with the key, code and recovery codes shown once (axe); the org admin list with self and requester rules (axe); non-admins don't load the list. |

**CI result:** _see PR_.
