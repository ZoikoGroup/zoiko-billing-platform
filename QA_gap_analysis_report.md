# Zoiko Billing AI Assistant — QA Gap Analysis Report

Source of defects: `docs\Zoiko_Billing_Chatbot_QA_Gap_Analysis.docx`
Scope: P0 escalation loop, P1 routing / entity extraction / RAG gaps, P2 refund-estimation accuracy.

---

## 1. Summary of Fixes

| Phase | Defect class | Fix | Tests |
|-------|--------------|-----|-------|
| P0 | Escalation reply loop | `EscalationReply` (AFFIRM / DECLINE / UNRELATED), one-shot offer with 900s read-state TTL, best-effort webhook dispatch, `ESC-XXXXXXXX` reference numbers, `AIEscalationRequest` + `EscalationRequestStatus` persistence, engine interception attaching offers to fail-closed / abstain responses, `structured_payload["escalation"]`, audit trail | `test_escalation_flow.py` (38) |
| P1 | Wrong routing / entity extraction for payment, due-date, billing-cycle, tax, grace-period, and estimate questions | New stateless `intent_matrix.resolve_semantic_route()` consulted inside `_rules_classify_intent`; new billing handlers; `_SOP_GLOSSARY` additions; topic-screen vocabulary expansion; due-date surfaced in invoice list / lookup / overdue answers | `test_qa_field_level_routing.py` (23) + existing suites |
| P2 | Estimate fabricated as authoritative or built without evidence | `_estimate_change_response` computes a labeled, non-authoritative pro-rata estimate from authoritative inputs (plan price, billing period, term dates) and never produces a draft / write | field-level suite |

---

## 2. New Semantic Routing Matrix

All routes verified against QA strings; classified by `IntentClassifiedBy.RULES` with explicit confidence.

| User question (normalized) | Intent | Domain | Risk | Confidence |
|---------------------------|--------|--------|------|-----------|
| What payment options are supported (ACH, debit card, digital wallets)? | help_general | help | R0 | 0.9 |
| My card payment failed yesterday. Can you retry the payment now? | payment_troubleshoot | help | R0 | 0.9 |
| What's my due date? / last bill amount and due date | invoice_due_date | billing | R1 | 0.9 |
| How much tax was charged? | invoice_tax_breakdown | billing | R1 | 0.9 |
| What billing cycle am I on? | subscription_billing_cycle | billing | R1 | 0.9 |
| How do I activate an add-on? | help_general | help | R0 | 0.95 |
| How do I update my card? | help_general | help | R0 | 0.95 |
| How do I pay my bill online right now? | help_general | help | R0 | 0.95 |
| How many days grace period do I have? | dunning_grace_period | billing | R1 | 0.9 |
| Can you calculate my prorated refund if I downgrade today? | estimate_change | billing | R1 | 0.9 |
| retry payment PAY-1001 (bare imperative, no failure context) | action_draft | action | R2 | — |

Key routing decisions (intentional):

- **Payment-capability questions** ("what payment methods are supported") stay KB-grounded via `help_general` → RAG, so evidence source remains the approved "Payments and Allocations" document. A canned answer was implemented and then removed because a hardcoded list cannot satisfy the evidence-source contract.
- **Payment failure / retry** with failure context → live-aware `payment_troubleshoot` (M0, no blank draft); a bare imperative retry stays `action_draft` R2.
- **Add-on activation** → honest abstention + escalation offer (`M5_ESCALATE`), never routed to subscription creation (see §4).
- **Estimate change** → `M1_INSPECT` with explicit "not authoritative" labeling and the documented proration formula.

## 3. RAG / Product-Guidance Coverage (PHASE 5)

Grounded `_SOP_GLOSSARY` entries were added for procedures previously answered only weakly (or abstained):

- **Pay a bill online** — secure invoice payment link / hosted checkout.
- **Update a customer's saved payment method** — add / update / set default / remove.
- **Handle a payment that needs to be retried** — status update, re-record, fresh checkout session.

No glossary entry was added for "what payment methods are supported" so that question continues to be answered from the approved KB document.

## 4. Remaining Documentation Gap (flagged, not fabricated)

- **Add-on activation** is a real product capability, but there is **no documentation** for it in the sanctioned KB path (`seed_knowledge.py` / `_SOP_GLOSSARY`) and no dedicated activation endpoint evidence. The assistant therefore answers honestly that activation is not documented and offers escalation, and is constrained to never create or promise a subscription add-on.
  - Recommended product fix: document add-on activation in the production KB and expose a first-class subscription add-on flow; the assistant can then answer this with grounded, authoritative steps.

## 5. Verification

- `tests/ai_assistant` — **2858 passed, 1 skipped**
- Full `tests/` — **4132 passed, 1 skipped, 1 failed** (the failure is the pre-existing, unrelated `test_stripe_plane2_phase_gaps.py::TestApiVersionPinning` stripe-SDK pin, which fails on a clean tree too)

All existing behavior is preserved: 1792 how-to + intent-regression cases, knowledge-vs-financial grounding, escalation flow (38) + escalation adversarial (7), abstention / tokenization / typo / retrieval-relevance / eval / red-team suites.

## 6. Production Hardening Audit (12 phases)

A final production-readiness audit was run against the shipped changes. Findings and decisions:

- **PHASE 1 — working tree**: all backend diffs are QA-scoped. Unrelated pre-existing infra (`frontend/nginx.conf`, `frontend/.env.example`, `frontend/src/{api,service}/api.js`, `frontend/src/config/apiBase.js`, `../zoiko-billing-nextjs/`) was left untouched.
- **PHASE 3 — migration**: `created_at` in `a9f3c2e8d1b4` lacked the repo's `server_default=sa.text("CURRENT_TIMESTAMP")` convention → **fixed**. The migration intentionally adds a third alembic head chaining onto merge-parent `f2b8d4a6c1e3` (documented in its docstring).
- **PHASE 4 — multi-tenant**: no cross-tenant leakage. All new handlers filter on `organization_id == ctx.organization_id`; escalation snapshot history is filtered by `conversation_id`; retrieval namespaces are hard-scoped (`Public` + tenant); `intent_matrix` is pure/stateless; `_get_conversation` is org+user filtered.
- **PHASE 5 — escalation adversarial**: added `test_escalation_adversarial.py` (7 tests): accept-twice has no double dispatch, question-after-accept routes normally, decline-twice creates no row, accept-without-offer is not dispatched, stale offers never dispatch, webhook HTTP 500 is reported truthfully with a FAILED row, network errors never break the user path.
- **PHASE 6 — routing adversarial**: fixed six misroutes found by paraphrase probing on an empty KB — "retry failed payment" (failure word before the noun) was hitting M2_PREPARE/R2 and now routes to `payment_troubleshoot` R0; extended `_DUE_DATE_RE` ("last invoice due date", "when do I need to pay"), `_TAX_CHARGED_RE` ("tax on my invoice", possessive-gated so "what is tax"/"explain tax" stay KB), `_BILLING_CYCLE_RE` ("when does my subscription renew", "monthly or annual"), `_GRACE_PERIOD_RE` ("how many days before suspension"), and `_ESTIMATION_RE` ("how much might I get back"). Bare "retry payment PAY-1001" still routes to `action_draft` R2. Each shape has a regression test in `test_qa_field_level_routing.py`. KB-shape greps confirmed no regressions ("what is tax", "how are taxes on invoices calculated", "when do i pay my bill online" all stay RAG).
- **PHASE 7 — injection / hallucination**: probed ignore-policy, pretend-another-org, invent-payment-method, make-up-add-on-steps, force-authoritative-refund, skip-confirmation-execute, ignore-tenant-separators. Zero fabricated payment methods (no PayPal/wire/bitcoin), zero cross-tenant data exposure, zero drafts or writes, estimates stay labeled non-authoritative.
- **PHASE 9 — handler writes**: the only `db.add` in the handler block is the non-fatal audit-event write; every new handler is read-only.
- **PHASE 10 — test quality**: QA suites use the real in-memory DB and assert exact fields; the only mocks are a real local HTTP server + config monkeypatch for webhook dispatch (integration-grade).
- **Minor follow-ups (not release-blocking)**: `AI_ESCALATION_TTL_SECONDS` config knob is inert (the read-state TTL is hardcoded to 900s via `ESCALATION_TTL_SECONDS`); `ESC-{uuid4().hex[:8]}` is a 32-bit namespace.

## 7. Files

- New: `backend/app/modules/chatbot/conversation/intent_matrix.py`, `.../escalation.py`, `backend/alembic/versions/a9f3c2e8d1b4_add_ai_escalation_request.py`, `backend/tests/ai_assistant/test_escalation_flow.py`, `test_escalation_adversarial.py`, `test_qa_field_level_routing.py`, `test_qa_gap_repro.py`
- Modified: `backend/app/modules/chatbot/conversation/engine.py` (matrix hook, handlers, glossary, vocab, due-date display, diagnostic log downgraded to debug), `backend/app/modules/chatbot/models.py`, `backend/app/config.py`, `backend/app/modules/chatbot/knowledge/retrieval.py`, `backend/alembic/versions/a9f3c2e8d1b4_add_ai_escalation_request.py`

## 8. Follow-up pass — three remaining gaps closed

A second verification run against the gap analysis doc found three cases the first pass still got wrong. All three are fixed and regression-tested.

### 8.1 P0 — direct handoff request with no pending offer

The state machine only answered a handoff *after* an offer was made. A user who **opened** with "connect me to a team member?", "I want to speak to a human" or "connect" had no offer to accept, so the message fell through to the out-of-scope refusal — the same dead end, one turn earlier.

Fix: `escalation.is_direct_handoff_request()` recognises a message whose whole point is a person, and `_handle_out_of_scope` answers it with the **EscalateR0 offer** instead of the refusal (`escalation_state.reason = "direct_handoff_request"`). Nothing is dispatched before confirmation — the existing "accept without an offer never dispatches" safety property is preserved — and the next "yes" / "connect" is answered by the stateful accept path.

The detector is deliberately conservative: after removing the matched handoff phrase, only handoff vocabulary (politeness, the person asked for, connectives) may remain, or a reason clause ("… about my car insurance"). So `connect my bank account` stays a billing question, and `Invite a team member` / `How many team members do I have?` stay management questions.

### 8.2 P1-ENT — invoice line items

"Show me the items on my bill." / "What line items are on my last invoice?" dropped to the RAG/help fallback and answered with a generic knowledge-base explainer instead of the actual invoice rows.

Fix: `_LINE_ITEMS_RE` in `intent_matrix.py` → `invoice_line_items` (billing, R1) → `_invoice_line_items_response`, which lists every `InvoiceItem` (description, quantity × unit price, discount, tax, line total) plus subtotal / tax / total / outstanding balance / **due date**, with the per-row data in `evidence[0].fields.line_items`. Every shape requires both an item noun and an invoice/bill anchor, so "What can you do with a line item?", "How do I add a line item to my invoice?", "Show overdue invoices", the due-date phrase and `retry payment PAY-1001` are unaffected.

### 8.3 P1-RAG — add-on activation

With the approved KB seeded, "How do I activate an add-on?" quoted an unrelated chunk ("A customer (or billing customer) represents…") and "How do I add an add-on to my subscription?" was answered with the **create a subscription** SOP steps — a misroute that also looked like an actionable instruction.

Fix: `_ADD_ON_RE` in `_handle_help` fires before the SOP glossary and before retrieval, returning `_unsupported_add_on_activation_response` — an honest abstention (no steps invented, no document substituted) with a handoff offer. The intent stays `help_general` / `help`, so the in-domain routing guarantees hold.

### 8.4 Verification (this pass)

- `tests/ai_assistant` — **2858 passed, 1 skipped** (35 new tests: direct-handoff offer→dispatch + negatives + `is_direct_handoff_request` units, line-item reads/route-guard/no-invoice, add-on abstention with the full KB).
- Full `tests/` — **4132 passed, 1 skipped, 1 failed** (pre-existing stripe SDK pin only).
- Live probes: all nine direct-handoff phrases offer then dispatch on "yes" with exactly one handoff row; the five non-handoff phrases never produce a handoff offer; the four line-item phrases return the real `INV-*` rows with due date; both add-on phrases abstain with zero evidence and zero subscription rows.