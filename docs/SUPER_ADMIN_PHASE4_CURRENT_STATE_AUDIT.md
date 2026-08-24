# Super Admin Control Plane — Phase 4 Current State Audit

**Document ID:** ZB-SA-P4-AUDIT-001
**Baseline:** Commit `23f54e3` (Phase 3 complete & accepted), branch `nikhil`
**Date:** 2026-08-22
**Method:** Every claim below was verified by reading the actual repository state at HEAD —
documentation (all Phase 1–3 docs listed in the mandate), backend modules
(`backend/app/modules/super_admin/`, `commercial/`, `billing/`, `auth/`, `core/`), frontend
(`frontend/src/modules/super-admin/`), tests (`backend/tests/`, `frontend/tests/`,
`frontend/scripts/a11y-audit.mjs`) and a marker sweep for TODO/FIXME/NOT IMPLEMENTED/
mock/fabricated/hardcoded/placeholder/bypass/fallback/legacy.

---

## 1. Accepted baseline (verified, must not regress)

| Capability | Implementation | Verified evidence |
|---|---|---|
| Command Center (5 lenses, context bar, freshness) | `PlatformDashboardPage.jsx` + `lenses/*` + `CommandCenterContext.jsx` | Phase 1 acceptance; routes load in Playwright |
| Attention Engine | `attention_service.py`, `AttentionItem` | Dedup via `source_key`; occurrence escalation; SLA deadlines from Table-24 minutes; full operator lifecycle audited |
| Circuit breakers | `kill_switch_service.py`, `BillingKillSwitch` | 5 registered scopes each wired to real service-layer gates; mandatory auto-expiry; MFA step-up + maker-checker paths |
| JIT privileged access | `privileged_access_service.py`, `PrivilegedTenantAccessGrant` | ≤30 min cap, owner-bound, lazy expiry, one live session per admin, fully audited |
| Maker-checker | `approval_service.py` | Self-approval refused server-side (catalog publish, breaker proposals); single-admin exceptions documented in 3G §4 |
| Platform audit | `PlatformAuditLog`, `audit_service.py` (`log_no_commit`) | Transactional with mutation; actor/role/reason/correlation captured; no secrets (tested) |
| Financial consistency (internal) | `financial_consistency_service.py` | Over-allocation = FAILED; empty = UNKNOWN; ISS-017 declared honestly |
| Domain C telemetry purity | `telemetry_service.py` | Counts/states only; no monetary fields (recursively tested) |
| Global search | `search_service.py` | Identifier-first; org results route to Support Access (`requires_access=true`); tenant financial entities never indexed |
| Freshness | `freshness.py` | FRESH/STALE/UNKNOWN only; never green-by-default |
| RBAC capabilities | `core/capabilities.py` | Per-platform-role capability map enforced server-side |
| MFA / step-up | `mfa_service.py` | TOTP + recovery codes, replay protection, lockout |

Test baseline at audit time: backend **680 passed / 1 skipped**, frontend production build PASS,
Playwright **17/17**, axe **18 routes / 0 violations**.

## 2. Marker sweep results

- `TODO/FIXME/XXX/HACK`: one benign comment in `billing/models.py:1506` (enum-migration note; no functional gap).
- Frontend `mock/fake/hardcoded/placeholder` hits are exclusively: HTML input placeholders,
  honesty notes ("nothing is fabricated"), and CSS placeholder styling. **No fabricated data found.**
- Backend honesty vocabulary (`NOT_CONFIGURED`, `NOT IMPLEMENTED`, `UNKNOWN`) used correctly in
  production-acceptance items and financial surfaces.

## 3. Gap register (Phase 4 targets)

Legend: P0 = correctness/integrity defect in accepted surface; P1 = implement this phase;
P2 = deferred with honest declaration; P3 = documentation/process item.

### G-01 · P0 — Multi-currency aggregation in Plane 2 billings summary
`financial_consistency_service.get_financial_operations_summary()` sums
`Invoice.total_amount` across **all currencies** into single `invoiced_amount`,
`collected_amount`, `overdue_amount` strings. `Invoice.currency` is a real column
(`billing/models.py`). Summing mixed currencies violates the platform rule
"Never sum different currencies". The SaaS MRR read model already demonstrates the correct
pattern (per-currency buckets; UNKNOWN when empty). Fix: per-currency buckets + coverage +
honesty basis line; keep single-currency convenience total ONLY when exactly one currency
exists. UI (`FinancialOperationsPage.jsx` F1 card) currently labels amounts "raw database
values" without currency attribution — must render per-currency.

### G-02 · P1 — Settings mutations unaudited + ungated (Workstreams A/G)
`POST /super-admin/settings` and `PUT /super-admin/settings/{key}` mutate `PlatformSetting`
with **no platform-audit event** and **no capability gate** beyond the super-admin floor.
Every other platform mutation writes a transactional audit row. Fix: audit both endpoints,
gate via new `platform_config.manage` capability, surface audit status in a governance view.

### G-03 · P1 — No configuration governance view (Workstream A)
Configuration lives in three places with no unified visibility:
1. `PlatformSetting` rows (DB; masked on read when sensitive) — has value/source/category but
   no updated-by or audit-status surfacing.
2. Code-declared operational thresholds: SLA ack/mitigate minutes (`attention_service.py`),
   breaker default expiry window (`kill_switch_service.py`), JIT max grant minutes
   (`privileged_access_service.py`), freshness multipliers (`freshness.py`), p95 latency
   budget (`api_metrics.py`), search result caps, pagination caps.
3. Environment-dependent capabilities (SMTP, Stripe, scheduler enablement, MFA encryption key):
   presence/absence only — values must never be exposed.
No endpoint inventories these; operators cannot answer "what is configured, where, by whom".
Fix: authoritative registry module importing existing constants (no duplicate sources of
truth) + `GET /api/super-admin/configuration` read model + governance UI page under the
existing Governance & Security group.

### G-04 · P1 — Plane 1 price-book coverage not explained per plan (Workstream B)
SaaS reporting reports aggregate `plans_with_published_price` coverage but does not identify
WHICH plans lack a published priced version — the exact reason MRR may be UNKNOWN. Fix:
additive per-plan price-coverage breakdown (real rows only).

### G-05 · P1 — API error-rate observability missing (Workstream F)
`api_metrics.py` records latency only. Error rate (5xx ratio over window) is a real,
already-observable measurement (response status is available in the middleware) that R4 /
launch readiness could consume honestly. Fix: extend record() with optional status_code
(backward compatible) + snapshot fields + middleware passes status; ReliabilityLens renders
UNKNOWN when no samples.

### G-06 · P1 — Search results lack status/plane enrichment (Workstream H)
Organization results carry domain/entity/label/route/requires_access but no status;
Plane 1 commercial subscriptions (identity-level: plan code + subscription status) are not
searchable at all, though they are directly visible to super admins elsewhere. Tenant
financial entities MUST remain unindexed (verified: they are). Fix: enrich org results with
lifecycle status (identity-level), add plane-labelled Plane 1 subscription results, assert
tenant invoice/payment/customer entities never appear in results.

### G-07 · P2 — Job replay / reprocessing engine — NOT IMPLEMENTED (Workstream E)
`JobRunLog` exposes failure inspection (last_error, failure counts, freshness) and attention
triage covers remediation workflow. A generic "replay job" action would re-run billing/dunning
loops that move money and gate on breakers — no governed replay mechanism exists. Declared
**NOT IMPLEMENTED**: dangerous operations will not be added as unrestricted "force" actions.
Failure inspection remains available; `/super-admin/reliability/reprocessing` continues to
render the triage workspace.

### G-08 · P2 — Audit-log export artifact — DEFERRED
Extended audit export/compliance artifacts (Phase 2 doc §9 P3-4) remain deferred; append-only
query surface (`GET /audit-logs` with filters) already satisfies investigation needs this phase.

### G-09 · P2 — External integrations — NOT CONFIGURED (unchanged)
Stripe gateway credentials absent locally; ERP/accounting connectors NOT IMPLEMENTED;
processor/bank reconciliation NOT integrated (ISS-017); SMTP provider configuration required
for outbound email. All honestly labelled in-product. Unchanged by Phase 4.

### G-10 · P3 — Manual screen-reader validation still not performed
Automated axe-only (0 violations across audited routes). Remains an open acceptance item;
Phase 4 extends automated coverage to any new routes but does not claim manual SR compliance.

### G-11 · VERIFIED-NO-GAP — Workstreams D (attention/triage)
Field-level audit of `AttentionItem` against the mandate checklist: source ✓ source_key ✓
severity ✓ created (`opened_at`) ✓ SLA deadlines ✓ owner ✓ status ✓ acknowledgement ✓
mitigation (`mitigating_at`) ✓ resolution (`resolved_at`+`resolution_code`) ✓ suppression
(`suppressed_until`+reason, time-bound) ✓ correlation ID ✓ dedup enforced ✓ severity
evidence-driven (server-computed, occurrence escalation, P0 floor for financial integrity) ✓
no synthetic alerts (only two real ingestion sources) ✓. Only gap: none requiring code change;
covered by regression tests instead.

### G-12 · VERIFIED-NO-GAP — Workstream I security posture
Authorization floor (`get_current_super_admin` rejecting tenant tokens AND hybrid tokens),
capability boundaries, JIT/MFA chains, IDOR probes and cross-plane isolation all covered by
existing suites (370-test Phase 3 evidence; 680-test current suite). Phase 4 adds regression
tests for every NEW endpoint plus expired-token denial; no weakening anywhere.

## 4. Constraints honored

- Canonical 7-group IA preserved; the only navigation addition is one entry inside the
  existing Governance & Security group (Configuration Governance) — mandated by Workstream A.
- No Plane 1 money movement; no payment processing; no reconciliation fabrication.
- All new mutations: reason-mandated where destructive, transactionally audited, correlated.
- Sensitive setting values stay masked (existing schema behavior reused, not duplicated).

## 5. Disposition summary

| ID | Workstream(s) | Priority | Disposition |
|---|---|---|---|
| G-01 | C | P0 | IMPLEMENT this phase |
| G-02 | A/G | P1 | IMPLEMENT this phase |
| G-03 | A/J/K | P1 | IMPLEMENT this phase |
| G-04 | B | P1 | IMPLEMENT this phase |
| G-05 | F/L | P1 | IMPLEMENT this phase |
| G-06 | H | P1 | IMPLEMENT this phase |
| G-07 | E | P2 | NOT IMPLEMENTED (declared, honest) |
| G-08 | G | P2 | DEFERRED |
| G-09 | — | P2 | NOT CONFIGURED (external dependency) |
| G-10 | K | P3 | Open acceptance limitation (documented) |
