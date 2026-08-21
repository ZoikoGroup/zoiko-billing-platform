# Zoiko Billing AI Assistant — Database Schema

28 tables under the `ai_*` prefix. All tables carry `tenant_context_id` (or `organization_id`) for tenant isolation. No table duplicates or replaces any existing Zoiko Billing billing/invoice/payment table.

## Identity & Context (4 tables)

| Table | Purpose |
|-------|---------|
| `ai_tenant_context` | Resolved tenant + legal entity + billing plane for each interaction |
| `ai_iam_user_ref` | Authenticated user reference within a tenant context |
| `ai_permission_snapshot` | Point-in-time permission scopes for a user |
| `ai_chatbot_session` | Top-level session linking user, tenant, channel |

## Conversation (2 tables)

| Table | Purpose |
|-------|---------|
| `ai_conversation` | Business conversation thread scoped to tenant |
| `ai_conversation_message` | Individual message with sender type, risk class, PII flag |

## AI/Retrieval Evidence (4 tables)

| Table | Purpose |
|-------|---------|
| `ai_intent_classification` | Classified intent for each user message |
| `ai_model_run` | Record of every model invocation with latency/tokens |
| `ai_prompt_template` | Versioned prompt templates for reproducibility |
| `ai_tool_invocation` | Record of each tool call made during a model run |

## Governed Action Control Plane (8 tables)

| Table | Purpose |
|-------|---------|
| `ai_action_draft` | Proposed structured intent — draft only, no mutation |
| `ai_action_preview` | Deterministic preview from authoritative billing service |
| `ai_action_confirmation` | Explicit user confirmation bound to a preview hash |
| `ai_approval_request` | Maker-checker approval request for high-risk actions |
| `ai_approval_decision` | Individual approve/reject decision |
| `ai_action_execution` | Record of confirmed and executed action |
| `ai_financial_resource_pointer` | References to billing resources — never copies data |
| `ai_service_response_snapshot` | Redacted snapshots of service responses for audit |

## Knowledge/RAG (7 tables)

| Table | Purpose |
|-------|---------|
| `ai_knowledge_namespace` | Scoped knowledge namespaces for retrieval isolation |
| `ai_knowledge_source` | Registry of knowledge sources within a namespace |
| `ai_knowledge_document` | Versioned documents with lifecycle (draft/approved/revoked) |
| `ai_knowledge_chunk` | Text chunks with embedding references for vector search |
| `ai_retrieval_run` | Record of each retrieval operation with filters |
| `ai_retrieval_citation` | Citation linking retrieval results to source chunks |
| `ai_policy_evaluation` | Risk/policy evaluation result for an action |

## Audit (3 tables)

| Table | Purpose |
|-------|---------|
| `ai_audit_event` | Immutable audit event for every material action |
| `ai_evidence_packet` | Bundled evidence for support/audit/dispute/QA |
| `ai_support_access_session` | Scoped support access for cross-tenant investigation |

## Key Design Decisions

- **UUID strings** for all public-facing UIDs (36-char UUID4)
- **Integer PKs** for internal foreign keys (performance)
- **`ai_*` prefix** on all tables to avoid collisions with existing billing tables
- **JSON columns** for flexible payloads (evidence, params, thresholds) with schema versioning
- **Soft delete** only on non-evidence entities
- **`native_enum=False`** on all SQLAlchemy Enum columns for SQLite compatibility
- **No Alembic** — uses `create_all` + `_add_missing_columns` migration pattern
