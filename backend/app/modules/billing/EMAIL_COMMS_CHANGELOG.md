# Zoiko Billing Email Compliance Changelog

Spec: ZB-COMMS-EMAIL-002 v2.0.0 (Sections 08, 12) — Billing module only.
Scope: `backend/app/email_templates/` (11 billing templates) + `backend/app/services/email_service.py`.
No context-key renames, no templating-engine change, `_render_template()` and `_html_to_text()` untouched.

---

## Per-template mapping and changes

| Template | Doc ID | Subject (new) | Preheader | Primary action |
|---|---|---|---|---|
| invoice_sent.html | ZB-INV-006 (T1) | `Invoice {invoice_number} from {company_name} — {currency} {total_amount} due {due_date}` | Review the invoice or billing-document status. | View invoice |
| quote_sent.html | ZB-CHG-006 (T1) | `Estimate {quote_number} from {company_name}` | Review the charge, estimate, quote, or pricing event. | Review estimate |
| dunning_reminder.html | ZB-COL-001 (T2) | `Collection workflow started for invoice {invoice_number}` | Review the outstanding-balance or collections event. | Review collection case |
| collections_notice (service) | ZB-COL-001 (T2) | `Collection workflow started for invoice {invoice_number}` | (same template as dunning) | Review collection case |
| subscription_renewed.html | ZB-SUB-005 (T1) | `Your {plan_name} subscription was renewed` | Review the subscription, renewal, usage, or recurring-billing event. | View receipt |
| past_due_notice.html | ZB-INV-013 (T1) | `Invoice {subscription_number} is overdue` | Review the invoice or billing-document status. | Pay or review invoice |
| payment_received.html | ZB-PAY-002 (T1) | `Payment received by {company_name}` | Review the payment, refund, dispute, or reconciliation status. | View receipt |
| refund_processed.html | ZB-PAY-013 (T1) | `Your refund from {company_name} is complete` | Review the payment, refund, dispute, or reconciliation status. | View refund |
| write_off_executed.html | ZB-COL-011 (T1) | `Write-off decision recorded for {customer_name}` | Review the outstanding-balance or collections event. | Review decision |
| credit_note_issued.html | ZB-INV-018 (T1) | `Credit note {credit_note_number} from {company_name}` | Review the invoice or billing-document status. | View credit note |
| contract_activated.html | NO DIRECT MATCH (gap) | `Contract {contract_number} activated` | Review the contract, its term, and the agreed billing value. | View contract |
| contract_renewed.html | NO DIRECT MATCH (gap) | `Contract {contract_number} renewed` | Review the contract renewal and the updated term. | View contract |

### What changed per template
- **Subject** — rewritten to the doc canonical text (above), built in the matching `send_*` function in `email_service.py`; `{company_name}` resolves from org branding at dispatch time (see global notes). Previous subjects were `"... | Zoiko One"` variants.
- **Preheader** — added to every template: hidden `display:none; max-height:0; overflow:hidden; mso-hide:all` div immediately after `<body>`, using the doc PREHEADER text.
- **Body restructure (Section 08)** — each template now follows: Opening (what happened + why recipient is getting it) → Facts table (authoritative record/amount/date/reference only) → ONE primary-action button → Footer (sender identity, "automated billing message" product context, `{{support_email}}` contact, `{{invoice_footer}}` conditional preserved).
- **Primary action** — single dominant button per template (labels in table). Routes to `{{login_url}}` (platform login; see gaps).
- **Accessibility** — every `font-size` audited and raised to ≥16px (was 12–13px); primary-action buttons sized ≥44px tall (15px vertical padding + 16px line-height); color-coded amounts/days retain adjacent text labels (no color-only signaling). Quote template heading renamed `Quotation` → `Estimate` to match doc vocabulary (facts/records still quotation-scoped).

### Doc requirements that could NOT be met with current data (flagged, not fabricated)
- **No per-document deep links**: buttons point to `LOGIN_URL` (`https://zoikoone.com/login`); there is no invoice/quote/refund/credit-note URL in any context dict. Adding real deep links needs a new context key per document.
- **`balance_due_formatted` equivalent absent** for invoice: only `total_amount` exists, so the INV-006 subject uses the total; `due_date_local` (timezone-localized) also absent — plain `due_date` used.
- **past_due_notice** is subscription-scoped in code (context key `subscription_number`), while doc INV-013 assumes `invoice.number`. Reference notes expected `invoice_number`; actual key is `subscription_number`, mapped as-is. Do not rename without touching `subscription_service.py`.
- **Contracts**: doc has no contract family (no exact INV/PAY/SUB/COL/CHG/COM analog). Self-authored subjects/preheaders/primary action per "closest analog, note the mismatch" instruction. Flagged as a spec gap.
- **dunning subject tension**: `Collection workflow started for invoice {invoice_number}` is the doc canonical but also fires on mid-sequence reminders (not just case start). The template is additionally reused for pre-due reminders and final notices via `subject_override` strings in `dunning_service.py`; those overrides were deliberately left unchanged (distinct events outside the 12-template mapping). Body copy kept neutral ("outstanding balance") so the dual-use stays coherent and non-threatening (doc ZB-COL-001 control).
- **payment_received mapping**: recipient confirmed as payer/customer (`payment_service.py` sends to `customer.email`), so ZB-PAY-002 (payer notification) was chosen over ZB-PAY-003 (tenant). No payment credentials/provider payload included (doc PAY control).

---

## Global changes

### `backend/app/services/email_service.py`
- `send_approval_email()`: after building `full_context`, subjects containing `{{` are rendered against `full_context` so `{{company_name}}` resolves from org branding without a second lookup. Subjects without `{{` (all pre-existing payroll/registration senders) pass through unchanged.
- All 12 billing `send_*` subjects rewritten (table above). `{{company_name}}` is written as `{{{{company_name}}}}` inside f-strings so the runtime string keeps the double-brace placeholder for dispatch-time substitution.
- Added one new context key, `"login_url": LOGIN_URL`, to each billing send function's context dict (used by the primary-action button). No existing context keys renamed; all existing callers (`invoice_service`, `payment_service`, `subscription_service`, etc.) unchanged.
- `_render_template()`, `_html_to_text()`, all signatures, and the True/False return contract untouched.

### Verification
- `py_compile` clean.
- Rendered all 11 templates with sample context: no unresolved `{{...}}`, every template has preheader + ≥44px button, no font-size <16px, subject placeholders resolve.
- `_html_to_text()` output spot-checked (invoice_sent) — plain-text reads cleanly; function itself unchanged.
