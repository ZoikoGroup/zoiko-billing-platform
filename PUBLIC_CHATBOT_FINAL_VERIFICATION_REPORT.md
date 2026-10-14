# Public Billing Assistant + Admin Copilot — Final Verification Report

**Spec:** `docs/Zoiko_Billing_Public_Chatbot_Detailed_Wireframe_v1_0.docx` (ZB-PUBCHAT-WF-001 v1.0)
**Date:** 2026-10-13
**Method:** re-verified against the **running** stack (uvicorn :8001 + Vite :5173) and the
live Neon Postgres — not against prior test claims. Each section marks
**[VERIFIED]** (executed this session, evidence quoted) or **[ASSUMPTION/NOT RUN]**.

---

## 1. Objective & scope

Two assistants were in scope:

1. **Public widget** — `zoiko-billing-nextjs/` (`PublicAssistantWidget.tsx`, same-origin
   proxy `app/api/assistant/public/[...path]/route.ts`) → backend `/api/assistant/public/*`
   (unauthenticated).
2. **Admin dashboard copilot** — `frontend/src/modules/ai-assistant/AssistantPanel.jsx`
   docked in `BillingShell.jsx` → backend `/api/chatbot/*` (authenticated).

Deliverable: verify real running behavior, fix only the confirmed defects, keep tenant
data protected, and separate verified facts from assumptions. **[VERIFIED]** — scope confirmed
by reading both mounts and both routers.

---

## 2. Environment & runtime **[VERIFIED]**

| Fact | Value |
|---|---|
| Backend | uvicorn `:8001`, repo-root `.venv` (`C:\zoiko-billing-platform\.venv`), cwd `backend/`, `--reload` |
| Frontend dev | Vite `:5173`, proxy `/api → http://localhost:8001` |
| DB | Neon Postgres; pings succeed but 0.6–7 s latency (documented ISS-012) |
| Admin routes | `backend/app/modules/chatbot/router.py` (auth + subscription gate) |
| Public routes | `backend/app/modules/chatbot/public_router.py` (no auth/tenant dependency) |

---

## 3. Verified root causes & fixes **[VERIFIED]**

| # | Defect | Root cause | Fix | Evidence |
|---|---|---|---|---|
| A | "Your session has expired…" shown wrongly | `api.js` treated **401 OR 403** as expiry | `classifyAuthRejection`: 401→`authInvalid`, 403→`forbidden`; `sessionExpired` only when refresh fails | code + unit tests |
| B | Public send always 503 | Live DB lacked `ai_public_assistant_message.idempotency_key` | applied public migration `… → f6b2d1e8c4a7` | 201 session + 200 send now |
| C | Topic question answered from wrong doc | Retrieval ranking (see §4) | peripheral demotion | trace + tests |
| D | Public widget sent `Authorization` | `publicAssistant.js` reused admin client | anonymous client, no auth header, single 404 recovery | 45 s timeout, tests |

---

## 4. Retrieval ranking defect — NEW fix **[VERIFIED]**

**Defect:** the approved tile question **"How do I create and send an invoice?"** was answered
from **"Pricing and Plans (Marketing)"** — whose blurb literally lists "create, send, …
invoices" — and degraded to the canned abstention.

**Fix:** `backend/app/modules/chatbot/knowledge/retrieval.py` — added public-only
`_PERIPHERAL_DEMOTION = 0.4`, applied as a final scoring stage, guarded by
`is_public_only and not price_words and topical_titles_present and not title_hit`
(demotes name-drops in unrelated docs; price questions exempt).

**Verified live (HTTP):** "How do I create and send an invoice?" → **`Invoices Overview`**
(top evidence, real create/send steps), `safety_state=answered`. "How do I send an invoice?"
also fixed. Regression locked by `TestInvoiceTileQuestionTopicalRanking` (4 phrasings +
public-only source guard).

---

## 5. Knowledge coverage — five questions **[VERIFIED]**

| Q | Result | Cited doc |
|---|---|---|
| A "How do payments work in Zoiko Billing platform?" | answered, evidence=3 | Zoiko Billing Platform Overview |
| B "How does payment reconciliation work?" | answered, evidence=3 | Payments and Reconciliation (How It Works) |
| C "How do I create and send an invoice?" | **answered** (was abstention) | **Invoices Overview** |
| D "How can I issue a credit or refund?" | answered | Credit Notes vs Refunds |
| E "What can you help me with?" | answered | What This Assistant Can Answer (Marketing) |

Each request ~8–34 s (DB+LLM latency). **[VERIFIED]** via fresh live session.

---

## 6. Session lifecycle & idempotency **[VERIFIED]**

| Behavior | Observed |
|---|---|
| Message to unknown session | `404 {"detail":"Session not found or no longer active."}` → widget drops uid, creates fresh, retries once |
| Re-create same `session_uid` | `201`, status `active` (idempotent resume) |
| Replay same `message_id` | returns the **same** `message_uid` (no duplicate turn) |
| Public tables tenant-free | no `tenant_id`/`organization_id`/`user_id` columns |

**[NOT RUN]** Full browser E2E of the 404-recovery path (verified in code + unit tests only).

---

## 7. Auth classification (401 vs 403) **[VERIFIED]**

- `POST /api/chatbot/sessions` **no auth** → `401 Not authenticated`.
- **fake bearer token** → `401 {"success":false,"error":"UNAUTHORIZED","message":"Invalid or expired token…"}`.
  (An earlier 503 here was the transient Neon DB failure, not a code defect.)

Client now maps 401→re-auth, 403→"forbidden" (not "session expired"). **[VERIFIED]** over HTTP.

---

## 8. Security boundary & adversarial **[VERIFIED]**

**Boundary (live HTTP):**
- "What is my outstanding invoice balance?" / "show my overdue invoices" →
  `requires_auth=True`, `safety_state=signin_required`, `evidence=[]`.
- Account-ish prompts outside the narrow detector ("list my customers", "what is our revenue
  this month", "delete invoice 123", "issue a refund now") → **no tenant data, no fabricated
  records**: returned the abstention copy plus a sign-in hint, or guidance only
  ("I can't issue a refund for you directly, but here's how…"). Retrieval is hard-scoped to
  `is_public=True` docs, so no internal doc can be cited.

The adversarial suite deliberately documents that such prompts may answer from public docs or
abstain as long as they never leak/fabricate — behavior matches the intended design.

**Suite:** `test_public_security_adversarial.py` (35 tests) green — wire-schema, router
dependency, behavioural battery.

---

## 9. DB schema drift **[VERIFIED] + plan (NOT applied)**

Verified against live `information_schema`:

- `alembic_version = f6b2d1e8c4a7`; 139 tables.
- **Missing:** 6 tables (`communication_logs`, `communication_sends`, `email_outbox`,
  `marketing_consents`, `notification_template_states`, `suppressed_recipients`),
  `subscriptions.idempotency_key`/`idempotency_request_hash`, and 8
  `billing_configurations.*` columns.
- **Root cause:** DB was **stamped** (schema built out-of-band), so ancestor revisions never
  ran; the DAG also has **6 unmerged heads**.
- Public-chatbot tables are **present and correct** (`idempotency_key` + unique index).

Full analysis + exact, additive, idempotent proposed migration, preconditions, risk, rollback
and required approvals: **`DB_SCHEMA_DRIFT_REMEDIATION_PLAN.md`**.
**Nothing was applied.** `alembic stamp`/drops are prohibited. **[VERIFIED not-applied]**

---

## 10. UI/UX conformance & deviations **[VERIFIED / 1 change]**

- **Public widget:** fully spec-conformant — panel `440px`, `border-radius:20px` (spec 18–24),
  launcher 56×56 at 24 px inset, header 78 px (spec 76–84), tiles body 14 px, exact palette
  (`#082644`/`#0868f7`/`#04add1`/`#008e5a`…), full-screen sheet ≤599 px.
- **Admin copilot:** docked edge-to-edge (no radius) — **deliberate internal-surface deviation**
  (spec describes the public widget). **Changed this session:** topic-tile label
  `13px → 15px` (`AssistantPanel.jsx:1610`) to meet spec §3.2 title 15–16 (was meta-size).
  `AssistantPanel.test.jsx` **47 passed** after the change.

---

## 11. Test matrix **[VERIFIED]**

| Check | Result |
|---|---|
| Public backend suites (5 files) | **199 passed** (37.5 s) |
| Full AI regression `pytest tests/ai_assistant` | **2983 passed, 1 skipped** (289 s) |
| Frontend unit `vitest run` | **405 passed** (40 files) |
| Frontend build `npm run build` | ✓ built in 1.32 s (only chunk-size warning) |
| Playwright `assistant-header assistant-error-fallback` | **6 passed** |

---

## 12. Assumptions / limitations / not run **[ASSUMPTION/NOT RUN]**

- **No image input** — pixel-diff vs reference PNGs impossible; audited via geometry +
  palette profiling instead.
- **No live backend logs** for the :8001 process; used in-process repro scripts.
- **`502 Create session failed: 502`** (from a screenshot) **not reproduced locally** — no
  proxy layer locally (Vite proxies `/api → :8001`). Handled in code by the single-404/error
  recovery path; exact prod cause is environmental, not verified here.
- **Browser E2E** of session recovery and composer error UX **[NOT RUN]** (unit + code only).
- **Screen-reader / 200 %–400 % zoom / cross-browser** **[NOT RUN]** (see readiness report).
- **`frontend/` has no ESLint config** → `npx eslint` cannot run.
- The 6-section report headings are reconstructed from this session's scope; if the source
  task used fixed §1–§13 titles, map them 1:1 to the sections above.

---

## 13. Go/No-Go & remaining actions

**Public chatbot: GO (conditional).** No tenant-leak, injection, ranking, or
keyboard-accessibility blocker remains. Outstanding items are operator/environment evidence,
not code defects.

**Remaining actions**
1. Decide on the tile-label change (applied, low-risk) and the docked-panel radius deviation
   (accepted; document if sign-off requires radius).
2. **Approve + schedule** the DB drift migration (`DB_SCHEMA_DRIFT_REMEDIATION_PLAN.md`) with
   owner/DBA; reconcile the migration DAG to a single head first.
3. Manually run screen-reader + zoom + cross-browser/device checks.
4. Investigate the prod `502 Create session failed` at the proxy/ingress layer.
5. Re-confirm DB latency (Neon) is not masking any behavior before release.

**Files changed this session**
- `backend/tests/ai_assistant/test_public_knowledge_question_coverage.py` (+5 tests)
- `frontend/src/modules/ai-assistant/AssistantPanel.jsx` (tile label 13→15 px)
- `DB_SCHEMA_DRIFT_REMEDIATION_PLAN.md` (new — proposal, not applied)
- `PUBLIC_CHATBOT_FINAL_VERIFICATION_REPORT.md` (this file)
