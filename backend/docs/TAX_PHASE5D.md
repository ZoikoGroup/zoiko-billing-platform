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
