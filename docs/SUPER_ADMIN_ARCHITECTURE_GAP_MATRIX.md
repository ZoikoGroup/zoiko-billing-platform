# Super Admin — Architecture Gap Matrix

**Companion to `SUPER_ADMIN_COMPLETE_ARCHITECTURE_AUDIT.md`.** Statuses used: COMPLETE, PARTIAL, NOT IMPLEMENTED, NOT CONFIGURED, NOT MONITORED, UNKNOWN, DEFERRED, CONFLICT, NEEDS VERIFICATION — per the audit mandate. No item below is marked COMPLETE merely because a route or component exists; each status reflects the evidence in the main audit document.

---

## 1. Requirement-to-Evidence Matrix

| Requirement (per ZB-SA-ARCH-001 / ZB-SA-IA-001, the in-repo operationalizations of ZB-SA-CMD-003 v3.0 / ZB-COM-BILL-001) | Doc section | Implementation location | Test evidence | Status | Gap | Recommended action |
|---|---|---|---|---|---|---|
| Canonical 7-group IA | `SUPER_ADMIN_IA.md` | `BillingShell.jsx` `NAV_SECTIONS` | a11y route audit (partial) | **PARTIAL** | Labels match 7/7; ~18 of ~34 leaf routes alias a shared component with no distinct content; Integrations & Automation group has no dedicated implementation at all | Either build the missing distinct pages or formally descope/relabel the IA doc — do not leave the mismatch undocumented |
| Domain A / B separation ("no mixture") | `SUPER_ADMIN_ARCHITECTURE.md` §3 | `commercial/models.py`, `billing/models.py` | `test_phase3g_cross_plane_governance.py` | **COMPLETE** | None found — zero cross-referencing FKs, one narrow documented audit-trail exception | none |
| No standing impersonation; JIT only, ≤30 min, MFA step-up, audited, revocable, auto-expiring | `SUPER_ADMIN_ARCHITECTURE.md`, `SUPER_ADMIN_ACCEPTANCE_TEST_PLAN.md` | `privileged_access_service.py` | `test_super_admin_command_center.py` (expired-grant, cross-actor IDOR) | **COMPLETE** | Grant durability gap (hard-deleted on org delete) and no DB-level uniqueness for one-grant-per-admin | Add partial unique index; exclude table from org-delete sweep |
| MFA is step-up only, never a login gate | Session-8 directive, `SUPER_ADMIN_CURRENT_STATE.md` | `auth/service.py`, `mfa_service.py` | `test_session8_login_currency_notification.py` | **COMPLETE** | None | none |
| No client-side authoritative financial aggregation | `SUPER_ADMIN_ARCHITECTURE.md` | `FinancialOperationsPage.jsx`, `financial_consistency_service.py` | `test_financial_operations.py` | **COMPLETE (backend) / BROKEN (frontend render)** | `isMulti` undefined crashes the page before any of this correct data can be seen | Fix the one-line bug |
| Never sum different currencies | Session-8 directive | `financial_consistency_service.py`, `saas_reporting_service.py` | `test_phase4_governance.py` G-01, `test_phase3f_saas_plane1.py` | **COMPLETE** | Frontend crash prevents users from seeing the fix (see above) | Fix the frontend bug |
| No fabricated telemetry / no fake green integration states | `SUPER_ADMIN_ARCHITECTURE.md` | `telemetry_service.py` (clean) vs. `ReliabilityLens.jsx` (violation) | none specific to this claim | **CONFLICT — backend COMPLETE, frontend VIOLATES the rule** | Hardcoded `subsystems`/`integrations` arrays presented as live data | Replace with real data or explicit NOT MONITORED/UNKNOWN states, matching the R4 card's own honest pattern in the same file |
| No fabricated financial metrics / no fake MRR / no fake collection rates | `SUPER_ADMIN_ARCHITECTURE.md` | `saas_reporting_service.py` | `test_phase3f_saas_plane1.py` | **COMPLETE** | One residual hardcoded literal (`unbilled_usage_anomalies: 0`) — not a fabricated success claim but not real telemetry either | Replace with a real query or an explicit UNKNOWN |
| Self-approval refused server-side (maker-checker) | `SUPER_ADMIN_ARCHITECTURE.md` | `approval_service.py` | `test_maker_checker_self_approval.py`, `test_phase3g_cross_plane_governance.py` | **COMPLETE** | None | none |
| Append-only audit trail | `SUPER_ADMIN_ARCHITECTURE.md` | `audit_service.py`, `PlatformAuditLog` | `test_platform_audit.py` | **COMPLETE**, one documented exception (org-delete FK scrub, content preserved) | Redaction is caller-side convention, not mechanically enforced by the audit-write layer itself | Consider a defensive check in `_json_safe` as a backstop |
| Circuit breakers cannot be permanent; must have expiry, reason, MFA, maker-checker | `SUPER_ADMIN_ARCHITECTURE.md` | `kill_switch_service.py` | `test_domain_b_circuit_breaker.py`, `test_session7_breakers_and_triage.py` | **COMPLETE for Domain B breakers; PARTIAL for the Plane 1 (Domain A) charging switch** | Plane 1 switch has no MFA step-up, no maker-checker | Decide whether this asymmetry is intentional; if not, align it with Domain B |
| Every breaker actually stops the gated operation (not just UI state) | `SUPER_ADMIN_ARCHITECTURE.md` | `kill_switch_service.py` + call sites in `billing/` | Partial — traced catalog/enforcement-point design; billing-side call sites NOT independently re-verified in this pass | **NEEDS VERIFICATION** | Whether `InvoiceService.finalize_invoice`, `StripeService.create_payment_intent`, `DunningService.process_dunning` genuinely call `require_enabled()` at their real call sites was outside this pass's assigned scope | Dedicated pass reading `billing/services/*.py` call sites directly |
| Global search cannot bypass tenant isolation | `SUPER_ADMIN_ARCHITECTURE.md` | `search_service.py` | none specific found in this pass | **COMPLETE** (by design/code inspection) | Not independently probed with a live IDOR attempt against the search endpoint in this pass | Add a direct IDOR probe test if one doesn't already exist |
| Capability-based RBAC for all sensitive Super Admin actions | `SUPER_ADMIN_RBAC_MATRIX.md` | `core/capabilities.py` | `test_capabilities.py` | **PARTIAL** | ~40 endpoints (commercial mutations, org lifecycle, password/MFA reset, Plane 1 kill switch) rely only on the coarse super-admin floor | Extend `require_capability` coverage to the listed endpoints |
| Configuration governance (single inventory of all config) | Local Phase 4 planning doc (uncommitted) | `configuration_service.py` (new) | `test_phase4_governance.py` G-03 | **COMPLETE** | None found | none |
| API error-rate observability | Local Phase 4 planning doc (uncommitted) | `api_metrics.py` | `test_phase4_governance.py` G-05 | **COMPLETE** | None found | none |
| Search result plane/status enrichment | Local Phase 4 planning doc (uncommitted) | `search_service.py` | `test_phase4_governance.py` G-06 | **COMPLETE** | None found | none |
| Per-plan price-book coverage explainability | Local Phase 4 planning doc (uncommitted) | `saas_reporting_service.py` | `test_phase4_governance.py` G-04 | **COMPLETE** | None found | none |
| Job replay/reprocessing engine | Local Phase 4 planning doc (uncommitted) | — | — | **NOT IMPLEMENTED BY DESIGN** | Explicitly declared as a deliberate non-feature (dangerous operation, no governed replay mechanism) | No action — honest deferral, re-confirm the declaration is still current before relying on it |
| Manual screen-reader accessibility validation | Every phase's acceptance doc | — | — | **NOT PERFORMED** | Automated axe-only coverage across every phase to date | Schedule manual SR validation as its own workstream |
| Frontend component/unit test coverage | — | — | 0 of 187 `.jsx`/`.js` files | **NOT IMPLEMENTED** | No `vitest`/`jest`/RTL dependency, no `"test"` npm script | Decide whether to add component testing before or during the next phase, given the frontend now carries real branching logic (currency states, capability gates) worth unit-testing |
| Accessibility: 0 violations across all canonical routes | Every phase's acceptance doc claims this | `frontend/scripts/a11y-audit.mjs` | **This audit's own live re-run**: 17 of 18 routes clean, 1 serious violation on `/super-admin/commercial/invoices` | **CONFLICT with prior claims; CURRENTLY FAILING per this audit's direct test** | Whether this is new or previously missed is UNKNOWN | Fix the violation; add this route's data-heavy (new coverage table) markup to a regression-checked a11y suite |
| Backend test suite fully passing | Every phase's acceptance doc | `backend/tests/` | **This audit's own live re-run**: 703 passed, 1 skipped, 0 failed, 25 warnings | **COMPLETE** (better than the historical 680/1/22 baseline — extra tests are the in-progress `test_phase4_governance.py`) | None | none |
| Frontend production build | Every phase's acceptance doc | `frontend/` | **This audit's own live re-run**: exit 0, 23.16s | **COMPLETE** | None | none |
| `/health` endpoint reachable, DB connected | — | `backend/app/main.py` | **This audit's own live check**: `200 {"status":"ok","database":"connected"}` | **COMPLETE** | Initial connection to the remote Neon DB took longer than a brief health-check window — consistent with prior QA reports' documented SSL/DNS-hang pattern; not itself a defect but worth budgeting for in any future automated smoke test | Ensure any CI/smoke-test health check allows sufficient startup time before concluding failure |
| Playwright E2E (16-step authenticated login/session spec) | Every phase's acceptance doc | `frontend/tests/super-admin-browser-login.spec.ts` | **NOT RE-EXECUTED in this pass** | **UNKNOWN / NEEDS VERIFICATION** | Three same-day prior reports on this exact spec disagree with each other (17/17 vs. 13/17 vs. 337/681-incomplete-with-a11y-not-configured); re-running requires a live authenticated session against a seeded super-admin account and was judged out of scope for a bounded, read-only architecture audit | Run this spec in a dedicated, deliberate QA session with a controlled test account (not the hardcoded credential currently in the spec file — rotate that first, see D-03/D-09 in the main audit) |
| nikhil@zoikogroup.com: role=super_admin, organization_id=NULL, is_active=true, is_verified=true | Audit mandate | live DB row | **NOT VERIFIED IN THIS PASS** | **UNKNOWN** | Read-only code audit did not query the live database | Direct DB query in a session with explicit authorization to do so |

---

## 2. Conflict Register (explicitly not reconciled, per mandate instruction)

| Conflict | Documents/evidence involved |
|---|---|
| IA doc vs. actual navigable content | `SUPER_ADMIN_IA.md` vs. `BillingShell.jsx` (§10 of main audit) |
| Domain A "out of scope" vs. Domain A shipped | `SUPER_ADMIN_CURRENT_STATE.md`/`SUPER_ADMIN_IMPLEMENTATION_STATUS.md` vs. `SUPER_ADMIN_PHASE3F_PLANE1_REPORT.md` |
| Three same-day QA reports on commit `86163a2` | `SUPER_ADMIN_PHASE3_FULL_SYSTEM_QA_REPORT.md` vs. `SUPER_ADMIN_FULL_AUTHENTICATED_QA_REPORT.md` vs. `SUPER_ADMIN_FULL_E2E_QA_REPORT.md` |
| Self-contradictory single document | `SUPER_ADMIN_REAL_BROWSER_QA_REPORT.md` (successful run claimed, then "0 sessions authenticated" claimed, same file) |
| "18/18, 0 a11y violations" (multiple reports) vs. this audit's live re-run (17/18, 1 violation) | See row above in §1 |
| Login-time MFA gate: mandated-then-reversed design | `SUPER_ADMIN_ENTERPRISE_READINESS_REPORT.md` (superseded) vs. session-8 directive (current); tracked as `ISS-028` — not a silent conflict, but a trap for out-of-order reading |

---

## 3. Absent Documents (recorded honestly, not assumed)

| Named document | Status |
|---|---|
| `ZB-SA-CMD-003 v3.0` | **ABSENT AS A FILE** — external mandate reference only, cited inside `SUPER_ADMIN_ARCHITECTURE.md` and others; no standalone file exists in this repository |
| `ZB-COM-BILL-001` | **ABSENT AS A FILE** — same as above |

All ~30 other named `SUPER_ADMIN_*` documents in the audit mandate were located and read in full; none were absent. (Most are, however, untracked in git — see main audit §28, a governance finding distinct from "absent.")

---

## 4. NOT CONFIGURED / NOT IMPLEMENTED / NOT MONITORED / UNKNOWN — Consolidated

| Item | Classification |
|---|---|
| Stripe payment gateway credentials | NOT CONFIGURED |
| Anthropic AI gateway key | NOT CONFIGURED (likely; absent from template and local env) |
| ERP/accounting connectors | NOT IMPLEMENTED |
| Processor/bank reconciliation | NOT IMPLEMENTED |
| Job replay/reprocessing engine | NOT IMPLEMENTED BY DESIGN |
| Commercial (Plane 1) invoices/payments/collections | NOT IMPLEMENTED |
| Entitlement enforcement (beyond read-only lookup) | NOT IMPLEMENTED (foundation only) |
| R1/R2 "subsystem"/"integration" health tiles | Presented as MONITORED; **actually NOT MONITORED** — this is the fabrication finding, not a legitimate NOT MONITORED disclosure |
| Manual screen-reader validation | NOT PERFORMED |
| Frontend component/unit tests | NOT IMPLEMENTED |
| Billing-side breaker call-site enforcement | NOT INDEPENDENTLY RE-VERIFIED (assume NEEDS VERIFICATION, not COMPLETE) |
| Playwright E2E current pass/fail state | UNKNOWN (not re-run; prior reports conflict) |
| Live `nikhil@zoikogroup.com` account fields | UNKNOWN (not queried) |
| Whether the missing-source test bytecode (34 files) represents lost coverage | UNKNOWN |
| Whether the current a11y violation is new or pre-existing | UNKNOWN |

---

## 5. Verdict Cross-Reference

See `SUPER_ADMIN_COMPLETE_ARCHITECTURE_AUDIT.md` §39 for the full verdict and categorized prerequisite list. Verdict: **C — CONDITIONALLY READY.**
