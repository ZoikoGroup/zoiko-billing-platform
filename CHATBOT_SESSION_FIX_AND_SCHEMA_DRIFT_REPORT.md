# Chatbot Session Fix + Schema-Drift Report

**Scope:** "How do payments work in Zoiko Billing platform?" returning *"Your session
has expired. Please sign in again to continue."* for a public visitor, plus the
approved-wireframe (ZB-PUBCHAT-WF-001) font/button audit.
**Date:** 2026-10-13 · **HEAD at start:** `6559de9`

---

## 1. Root cause — two independent defects

**A. Frontend mislabelling (the message the client sees).**
The exact string *"Your session has expired. Please sign in again to continue."* exists
only in the authenticated admin copilot
(`frontend/src/modules/ai-assistant/AssistantPanel.jsx` → `notifySendFailure`). It was
raised whenever `err.sessionExpired` was set, and `api.js` set that flag on **either a
401 or a 403** from `/api/chatbot`. A 403 (forbidden) is not an expiry, so an
authenticated-but-not-permitted or a transient rejection was reported to the user as a
dead-end "sign in again". General product questions had no anonymous path at all, so a
public-style question on the dashboard surface always dead-ended.

**B. Backend 503 (the real reason the public assistant could not answer).**
The live Postgres (Neon) was at Alembic revision `c3d4e5f6a7b8` while head was
`f6b2d1e8c4a7`. `ai_public_assistant_message.idempotency_key` did **not** exist, yet
`PublicAssistantService.send_message` INSERTs it on every turn →

```
sqlalchemy.exc.ProgrammingError: column "idempotency_key" of
relation "ai_public_assistant_message" does not exist
```

`public_router` catches this and returns `503 "I ran into a temporary issue…"`.
Every public message failed, regardless of content. `ai_public_support_request`
and `ai_public_assistant_feedback` were also entirely missing.

---

## 2. The fix

### 2.1 Frontend — classify auth failures and add a real anonymous fallback
- `frontend/src/modules/ai-assistant/api.js`
  - Added `classifyAuthRejection(err, status)`: **401 → `authInvalid`**, **403 → `forbidden`**
    (no longer conflated as "expired").
  - `createSession` and `sendMessageStreamed` now attempt a **token refresh + single
    replay** on 401 (guarded so a stream that already emitted a frame is never
    replayed); `sessionExpired` is set **only** if the refresh itself fails.
  - `403` sets `forbidden` and never `sessionExpired`.
- `frontend/src/modules/ai-assistant/publicAssistant.js` (new)
  - Anonymous client for `/api/assistant/public` (no `Authorization` header):
    `ensurePublicSession`, `sendPublicMessage`, `clearPublicSession`, `newPublicUid`,
    `hasAuthenticatedSession`. Recovers once from a 404 (dead session → fresh uid).
- `frontend/src/modules/ai-assistant/AssistantPanel.jsx`
  - `notifySendFailure` gained a `forbidden` branch ("You don't have access…",
    status "Not permitted") — no false expiry.
  - `handleSend` pre-check: when there is **no usable admin session**, the user's
    bubble is shown and the turn is answered through the public assistant.
  - `submitViaPublic(text)`: calls the public service; if the response is
    `requires_auth: true` it renders the answer immediately plus a **Sign in** action.
  - `handleAction("sign_in")` → `navigate("/login")` + close panel.
  - `createSession` catch and the streaming `onError` fall back to the public path on
    `authInvalid` (not on `forbidden`).
- `frontend/src/service/api.js`: exports `tryRefreshToken`.

### 2.2 Backend — apply the pending schema
- Ran `alembic upgrade head` (`f2b8d4a6c1e3 → a9f3c2e8d1b4 → 6a17bacad9bb →
  d6f1a8c2b4e5 → f6b2d1e8c4a7`), additive and reversible:
  adds `idempotency_key`, the unique `uq_ai_public_msg_session_idem` index, the
  `ai_public_support_request` / `ai_public_assistant_feedback` /
  `ai_escalation_request` tables and `client_request_id`. `alembic current` now reports
  `f6b2d1e8c4a7 (head)`.

### 2.3 Backend — stop the drift from being silent
- `backend/app/database.py` `_verify_postgres_schema_is_migrated()` now also detects
  **missing columns** (one `information_schema` round trip) and logs a loud, actionable
  warning — warning-only, non-fatal, wrapped in try/except. Previously only missing
  *tables* were detected, which is exactly why the missing `idempotency_key` column
  slipped through to a runtime 503.

---

## 3. Verification (all green)

| Check | Result |
|---|---|
| `npx vitest run` (frontend) | **40 files / 405 tests passed** (was 38/392; +13 new) |
| `AssistantPanel.test.jsx` | **47/47** (incl. 3 public-fallback cases A/B/C) |
| `publicAssistant.test.js` + `api.test.js` | **10/10** |
| `npm run build` | ✓ built (AssistantPanel 104.9 kB gzip 28.9 kB) |
| `npx playwright test assistant-header assistant-error-fallback` | **6/6** |
| `pytest tests/ai_assistant -q` | **2978 passed, 1 skipped** |
| Public backend suites (5 files) | **194 passed** |
| Alembic | `current = f6b2d1e8c4a7 (head)` |
| Live HTTP end-to-end `POST /api/assistant/public/sessions/{uid}/messages` | answered |

End-to-end proof against the running server (port 8001):

```
"How do payments work in Zoiko Billing platform?"
  → mode=M0_EXPLAIN requires_auth=False safety=answered
  → full answer on payment capture / normalization / matching / exceptions / reconciliation

"show my invoices" / "how much do I owe?"
  → requires_auth=True safety=signin_required
  → "I can't access account-specific information in this public assistant. Sign in…"
```

---

## 4. Wireframe (ZB-PUBCHAT-WF-001 §3.2) font/colour audit

**Public widget (`zoiko-billing-nextjs`) — compliant.** `globals.css` uses the approved
tokens with WCAG-AA ink variants: navy `#082644`, action blue `#0868F7`, cyan `#04ADD1`
(accent only), canvas/surface `#F6F9FC`/`#FFFFFF`, border `#D6E4F2`, secondary `#53677F`,
online `#008E5A`; AA overrides `--ab-cyan-ink #0b7a8c`, `--ab-online-ink #00734a`,
`--ab-border-strong #7590a8`. Titles 15 px, body 14 px, meta 12–13 px; launcher 56×56 at
24 px inset; panel 440 px.

**Dashboard copilot — compliant with two deliberate deviations:**
1. **Docked panel, no radius** — the desktop panel is a flex child of the shell rather
   than a floating 18–24 px-radius card (intentional integration with the admin chrome).
2. **Topic tile label 13 px** — one step below the 15–16 px "title" scale; retained for
   density in the 2-col `min-[408px]` grid; body/meta remain 14/12–13 px.

All palette, border, spacing and contrast values match §3.2; header min-height 76 px,
title 15 px, `.ab-human-btn` full-width, 8 topic tiles + 1 human action.

---

## 5. Critical finding — pre-existing, broader schema drift (out of scope, NOT fixed)

Because the alembic version table was **stamped** rather than migrated, the hardened
check now reports additional drift that predates this task **and is not repaired by
`upgrade head`** (those revisions are already ancestors of `c3d4e5f6a7b8`):

- Missing tables: `communication_logs`, `communication_sends`, `email_outbox`,
  `marketing_consents`, `notification_template_states`, `suppressed_recipients`.
- Missing columns: `subscriptions.idempotency_key`, `subscriptions.idempotency_request_hash`,
  and 8 `billing_configurations.*` columns (`auto_send_invoices`,
  `default_billing_frequency`, `default_pricing_strategy`, `default_trial_days`,
  `payment_extra_settings`, `pricing_extra_settings`, `quote_terms_and_conditions`,
  `subscription_extra_settings`).

Verified directly against `information_schema` (not a false positive). Any code path
touching these will fail at runtime the same way the public chatbot did.

**Recommendation:** stop `alembic stamp head` in the deploy pipeline; reconcile this
environment with the manual scripts under `backend/migrations/` (or a reviewed,
additive `upgrade`) under DBA review, and keep the new startup warning as a gate.
I did **not** modify these tables, as repairing shared/production data is outside this
task and needs explicit owner sign-off.

---

## 6. Files changed

- `frontend/src/modules/ai-assistant/publicAssistant.js` (new)
- `frontend/src/modules/ai-assistant/api.js`
- `frontend/src/modules/ai-assistant/AssistantPanel.jsx`
- `frontend/src/service/api.js`
- `frontend/src/modules/ai-assistant/{publicAssistant.test.js,api.test.js}` (new)
- `frontend/src/modules/ai-assistant/AssistantPanel.test.jsx`
- `backend/app/database.py`
- Live DB: Alembic `f6b2d1e8c4a7`
