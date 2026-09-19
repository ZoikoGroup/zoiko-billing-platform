# Q37 / Q38 / Q39 — One-Page Migration & Rollout Plan

Status: **DRAFT — for review and decision. No code written.** These three items are one
architecture bucket. Current state (from `QA_TRACEABILITY_PART1_PART2.md`):

| ID | Requirement | Current state | Classification |
|----|-------------|---------------|----------------|
| Q37 | every tenant-scoped query filters `tenant_id`; RLS blocks cross-tenant even if app filter omitted | **No RLS exists.** Billing scopes by `organization_id` (not `tenant_id`). Cross-tenant no-leak is engine-level only. | Architecture gap |
| Q38 | `legal_entity_id` enforced on every finance read/write | **No legal-entity model exists.** `legal_entity_id` is nullable/unenforced on `ai_tenant_context`; zero enforcement + zero tests. | Architecture gap |
| Q39 | `billing_plane` enum prevents mixing tenant/commercial records | Enum exists + tenant resolver + read-model separation — but **enforcement is by-convention only; no DB CHECK constraint** prevents a raw `ZOIKO_COMMERCIAL` insert. | Critical architecture gap |

All three share a root cause: **the isolation contract lives in Python/by-convention, not in the
database**. This plan adds schema-level enforcement. It is deliberately additive and staged so
nothing breaks existing tenant behavior.

---

## Dependencies / prerequisites (verify first)

- 1. Confirm current Neonscale/`resolve_database_url()` migration workflow (how `alembic` / DDL is applied).
- 2. Confirm no production path inserts a commercial-plane row through the re-named/relocated
     constraint columns (stock-take of ALL `insert(...)` against `billing_*` tables that must now
     carry `billing_plane` / `legal_entity_id`).
- 3. Decide DB driver constraint semantics (Postgres supports `CHECK` + real `RLS`; SQLite in tests
     supports `CHECK` but **not** row-level security — TEE the RLS portion behind a feature flag / test skip).

## Phased plan

### Phase 0 — Baseline (no behavior change)
- Add a `billing_plane` field to every financial table that is missing it (`billing_customers`,
  `billing_invoices`, `billing_payments`, `billing_credit_notes`, `billing_refunds`,
  `billing_allocations`, `billing_subscriptions`, `billing_contracts`, `billing_quotations`,
  `billing_write_offs`, `billing_configurations`, …).
- Backfill existing rows to `TENANT_BILLING`; add `NOT NULL DEFAULT TENANT_BILLING`.
- Release-neutral (column addition is additive, no downtime).

### Phase 1 — CHECK constraint (Q39, cheap, high-signal)
- Add a **DB CHECK** on `billing_plane` for the enum values it actually validates (e.g.
  `CHECK (billing_plane IN ('TENANT_BILLING','ZOIKO_COMMERCIAL'))`) so a raw insert can no longer
  put an arbitrary value in.
- Add a "plane-consistency" rule: a tenant-scoped row must never carry `ZOIKO_COMMERCIAL` (and vice
  versa), enforced by route layer + CHECK.
- **This alone closes the literal Q39 gap** (current finding is "by convention only").

### Phase 2 — `legal_entity_id` (Q38)
- Introduce a `legal_entities` table (id, org/tenant scope, name, defaults) if a model doesn't exist.
- Make `legal_entity_id` **NOT NULL** on all finance tables; enforce `FK -> legal_entities.id`.
- Route/enforce on every finance read/write (service-level + repository-level as a second layer;
  app filter first, DB constraint as backstop).
- Migration: backfill a single default legal entity per tenant, then flip columns to NOT NULL.

### Phase 3 — Row-Level Security (Q37, most invasive)
- Enable `RLS` on the financial tables with a policy like
  `tenant_id = current_setting('app.tenant_id')::int` (or `org_id` sub-select).
- Add a GUC/session-variable set at connection-open (DB session hook) so a query that omits the
  app-level `organization_id` filter is still blocked by the DB.
- This is the "RLS blocks cross-tenant even if app filter omitted" requirement. **Only viable on
  Postgres**; SQLite/test path must skip or emulate via the same filter.
- Rollout: `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` after confirming the app
  always sets the session variable; otherwise queries start returning empty sets (fail-closed safe).

## Rollout & risk

- **Order:** Phase 0 → 1 → 2 → 3 (additive to enforcing; each is independently reversible).
- **Downtime:** none for Phase 0/1; Phase 2/3 need a migration window for NOT NULL + RLS enable.
- **Key risk:** enabling RLS before every DB session sets the tenant variable → rows silently
  invisible. Mitigate with the fail-closed + feature-flag + canary-org rollout.
- **Tests already present (will need editing/extension):**
  - `test_qa_audit_encryption_retention.py` `TestBillingPlaneSeparationQ39` (pins by-convention; will
    become an insert-time CHECK test).
  - `test_phase3g_cross_plane_governance.py:195-240` (read-model separation).
- **Decision required from architecture/API owner:** (a) implement all three DB-level, (b) implement
  Q39 CHECK only now and defer Q37 RLS / Q38 legal_entity, or (c) accept by-convention and
  re-classify the three as intentionally-not-enforced. This plan assumes (b) unless told otherwise.

## Deliverable of this task
This document only. No schema change, no code, no migration is produced until the owner picks an option.
