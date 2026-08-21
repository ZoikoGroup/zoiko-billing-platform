# Zoiko Billing AI Assistant — Governance Rules

**Non-negotiable rules for every file in this module.**

## 1. System of Record

The chatbot is never a financial system of record. Invoice/payment/balance/ledger state is always read from and written through existing Zoiko Billing services — never duplicated in chatbot tables. `financial_resource_pointer` stores only references (resource type + id + version), never copied balances/totals.

## 2. Action State Machine

Every consequential action follows this exact state machine and no state may be skipped:

```
DRAFT -> VALIDATING -> READY_FOR_PREVIEW -> PREVIEWED ->
  { CONFIRMATION_REQUIRED | APPROVAL_REQUIRED | READY_TO_EXECUTE } ->
  EXECUTING ->
  { SUCCEEDED | FAILED | PENDING_EXTERNAL | EXCEPTION }
```

Terminal/cancel states: `CANCELLED`, `EXPIRED`, `REJECTED`.

## 3. Authority Modes

Five authority modes gate what the model may do:

| Mode | Description | Mutation |
|------|-------------|----------|
| M0 | Explain — no tenant data | No |
| M1 | Inspect — read-only, tenant-scoped | No |
| M2 | Prepare — draft only, no mutation | Draft objects only |
| M3 | Preview/Confirm — deterministic preview, explicit user confirmation bound to a preview hash | No |
| M4 | Execute — canonical mutation only via authoritative service call | **Yes** |

## 4. No Direct Mutation

The model never receives DB credentials or direct mutation capability. It only emits structured tool-call requests; a deterministic policy/permission layer decides if they execute.

## 5. Confirmation from Structure

Confirmation text shown to the user must be generated from structured preview data, not inferred from free-form model text.

## 6. Injection Defense

Retrieved knowledge/RAG content is always data, never treated as an instruction (indirect prompt-injection defense).

## 7. Tenant Isolation

Every session/message/action/retrieval record carries `tenant_id` and `legal_entity_id`; nothing crosses tenant boundaries.

## 8. Abstention Over Fabrication

Insufficient or conflicting evidence → abstain / ask for clarification / escalate. Never fabricate a financial answer.

## 9. Audit Trail

Every material action has an immutable `audit_event` with actor, tenant, timestamp, evidence, and outcome.

## 10. Idempotency

All mutation operations use idempotency keys. Replaying an execute call with the same key must not double-execute.

## 11. Safe Degradation

If the model provider, retrieval, or a billing dependency is degraded, fall back to M0/M1 only — never allow M2-M4 during degraded state.

## 12. No Dark Patterns

No accidental execution, hidden tenant/entity context, or ambiguous money values. Risk and state are always expressed through copy/iconography, never color alone.
