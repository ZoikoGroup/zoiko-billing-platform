# Zoiko Billing Public Chatbot — Gap Analysis & Final Deliverables

**Spec:** `docs/Zoiko_Billing_Public_Chatbot_Detailed_Wireframe_v1_0.docx` (ZB-PUBCHAT-WF-001)
**Backend contract:** ZB-AI-PUB-001 (`/api/assistant/public/*`)
**Date:** 2026-10-12
**Status:** Implemented and green — frontend lint 0 errors, `next build` (full TypeScript) passes, backend suite green. Hardening landed across two passes: session expiry, cross-visitor session binding, support-request + message-insertion idempotency at the database; then support-webhook durability (commit-before-dispatch), KB citation-URL mapping, a batched session-expiry sweep, and a mobile input-zoom fix. See §8 for the current verified numbers.

---

## 1. Objective & scope

Ship the **public, unauthenticated** Billing Assistant for the `zoikobilling.com`
marketing site, matching the approved wireframe: branded launcher, tall
right-anchored panel, the eight approved topic tiles, an unmistakable
human-support path, and a persistent composer — while **never** exposing tenant
billing data in public mode.

- **In scope:** `zoiko-billing-nextjs/` (public widget + same-origin proxy) and the backend public assistant (`backend/app/modules/chatbot/*` + config/schema/migration/tests).
- **Out of scope:** the authenticated platform assistant (`frontend/`, Vite) — a different surface with its own auth context.

---

## 2. Source of truth & spec conformance

All copy, tile order, colors and geometry are taken from the spec (§03 layout/tokens, §3.2 colors), not invented.

| Token | Spec | Shipped |
| --- | --- | --- |
| Launcher | 56 × 56, 24px inset | `.ab-launcher` 56×56, `right/bottom: 24px` |
| Desktop panel | 440px × `min(720px, 100dvh − 32px)` | `.ab-panel` (progressive `100vh`/`100dvh`) |
| Mobile | ≤599px fixed full-screen sheet, safe-area | `@media (max-width:599px)` → `100dvh`, `env(safe-area-inset-*)` |
| Panel radius/geometry | 18–24px radius, 1px stroke | 20px, 1px `--ab-border` |
| Header / composer | header 76–84px, composer ~90–112px | header `min-height:78px`, composer padded region |
| Body spacing | 16px side padding, 12px grid gap | `.ab-panel__inner` padding 16px, `.ab-tiles` gap 12px |
| Tiles | min-height 94px 2-col / 72–84 1-col | `.ab-tile` 94px / 76px one-col |
| Grid | 2 cols if inner width ≥ 376px | `ResizeObserver` → `ab-tiles--two` at `clientWidth-32 ≥ 376` |
| Colors | navy `#082644`, action `#0868F7`, cyan `#04ADD1`, canvas `#F6F9FC`/`#FFF`, border `#D6E4F2`, secondary `#53677F`, online `#008E5A` | All present as `--ab-*` tokens in `THEME` + `.ab-widget` CSS defaults |
| Motion | 120–180ms, honour reduced motion | 160ms panel; `prefers-reduced-motion` block disables animations/transitions |

Exact copy shipped verbatim: greeting title/body, placeholder `Ask about billing...`, disclosure, uncertainty `I can’t verify that from published Zoiko Billing guidance.`, degraded `The assistant is temporarily unavailable.`

Eight tiles in locked order (from `public_config.py`): Getting started, Invoices, Payments, Reconciliation, Credits & refunds, Entities & currencies, Permissions, What assistant can do.

---

## 3. Deliverables by file

### Frontend (`zoiko-billing-nextjs/`)
- `components/assistant/PublicAssistantWidget.tsx` — full rewrite to spec: `THEME` tokens, `DEFAULT_CONFIG` fallback, 8 tiles, support modal + explicit consent, composer (Enter to send / Shift+Enter newline, 2000-char cap, idempotent `message_id`), trust footer, sign-in CTA, uncertainty/degraded states, feedback, focus management, `aria-live` status, allowlisted links. No dark mode / history dropdown / maximize controls.
- `app/globals.css` — **new** complete `.ab-*` stylesheet (panel/launcher geometry, tiles, messages, markdown, composer, support modal, ≤599px full-screen sheet, safe-area, reduced-motion) replacing the stale block that referenced old `--ab-accent-text` vars.
- `app/api/assistant/public/[...path]/route.ts` — same-origin server proxy (backend origin server-side only; forwards `X-Forwarded-For`; 45s upstream timeout; single-read body).
- `app/layout.tsx` — mounts `<PublicAssistantWidget />`.

### Backend (`backend/`)
- `app/modules/chatbot/public_config.py` — **new**: copy, 8 tiles, allowlist, support config, `build_public_config()`.
- `app/modules/chatbot/public_router.py` — public endpoints incl. new `/config`, `/support/request`, `/feedback`; minimized `/health`.
- `app/modules/chatbot/public_assistant.py` — idempotency (`_find_by_idempotency_key`), `_needs_auth`, sign-in/degraded/uncertain paths, support request + transcript excerpt + webhook dispatch, feedback. Hardening: inactivity session expiry, ip_hash ownership binding on send/resume/excerpt, support-request dedupe (`client_request_id`), DB-level message idempotency with IntegrityError replay.
- `app/modules/chatbot/schemas.py` — `PublicTopicTile`, `PublicSupportConfig`, `PublicLinkAllowlist`, `PublicConfigResponse`, `PublicHealthResponse`, `PublicSupportRequestCreate/Response` (+ `client_request_id`), `PublicFeedbackRequest/Response`; extended `PublicChatResponse` (`requires_auth`, `safety_state`); `PublicSendMessageRequest` now carries `message_id`/`intent_id`.
- `app/modules/chatbot/models.py` — `PublicSupportRequest` (+ unique `client_request_id`), `PublicAssistantFeedback`, `idempotency_key` column + **unique** `(session_id, idempotency_key)` constraint.
- `app/modules/chatbot/guardrails/guardrails.py` — rewritten `PUBLIC_SYSTEM_PROMPT` (answer format, uncertainty, prohibitions).
- `app/config.py` — new settings: `PUBLIC_ASSISTANT_LIVE_CHAT_ENABLED=False`, `AI_PUBLIC_SUPPORT_WEBHOOK_URL=""`, `AI_PUBLIC_SUPPORT_WEBHOOK_TIMEOUT_SECONDS=5.0`, `PUBLIC_ASSISTANT_ALLOWED_ORIGINS=""`, `PUBLIC_ASSISTANT_REQUIRE_TRANSCRIPT_CONSENT=True`, `PUBLIC_ASSISTANT_MAX_SESSION_AGE_SECONDS=86400` (24h inactivity expiry).
- `alembic/versions/d6f1a8c2b4e5_add_public_support_and_feedback.py` — **new** migration (head `d6f1a8c2b4e5`, revises `6a17bacad9bb`).
- `alembic/versions/f6b2d1e8c4a7_add_public_session_expiry_support_idempotency.py` — **new** migration (head `f6b2d1e8c4a7`): unique `(session_id, idempotency_key)` message index + unique `ai_public_support_request.client_request_id`.
- `tests/ai_assistant/test_public_assistant_config_support.py` — **new** suite.

### Endpoints (mounted at `/api/assistant/public`)
`GET /config`, `GET /health`, `POST /sessions`, `GET /sessions`, `POST /sessions/{uid}/messages`, `POST /support/request`, `POST /feedback`.

---

## 4. Gap analysis — spec vs. shipped

| # | Wireframe requirement | Before | Now |
| --- | --- | --- | --- |
| 1 | Brand colors navy/blue/cyan | Orange accent | Approved palette everywhere |
| 2 | Exactly 8 tiles, locked order | 9 tiles, drifting | 8 from managed config |
| 3 | No dark mode toggle | Present | Removed |
| 4 | No history dropdown | Present | Removed (overflow menu = New conversation / Privacy / Contact support) |
| 5 | Online status only when truly ready | Always “Online” | Real `/health` → Online/Unavailable dot |
| 6 | Human support path + consent | Missing | Full-width action + modal + explicit, off-by-default transcript consent |
| 7 | No fabricated tickets/availability | — | Reference minted only on persist; delivery claimed only on webhook ack |
| 8 | 2000-char composer cap | Not enforced | Enforced client + server |
| 9 | Idempotent send | Not present | `message_id` → `idempotency_key` |
| 10 | Uncertainty / degraded copy | Ad hoc | Exact approved strings |
| 11 | Allowlisted links only | Weak | `isAllowedUrl` allowlist + `react-markdown` (no raw HTML) |
| 12 | Mobile full-screen + safe-area | Partial | `≤599px` sheet + `env(safe-area-inset-*)` |
| 13 | Support/feedback persistence | None | 2 new tables + migration |
| 14 | Public-mode isolation | — | No `get_current_user`/subscription deps; tenant context never sent |

---

## 5. Security & privacy posture

- Public routes carry **no auth/tenant dependency**; the widget never sends tenant context.
- Client IPs are **hashed** before storage (`PublicRateLimiter.ip_key`) — no raw IP persisted.
- Two-tier abuse control: DB-backed per-IP limit (15 / 120s) + SlowAPI transport limits per route.
- Responses render via `react-markdown` with **no** `rehype-raw`; unverifiable/unsafe URLs are rendered as plain text.
- Support transcript sharing requires **explicit opt-in**, stored per request.
- `/health` exposes only `status`/`available`/`degraded` — no provider/model/version leakage.

---

## 6. Accessibility

- Dialog semantics (`role=dialog`, `aria-modal`, labelled), focus moves to heading on open / restores to launcher on close, `Escape` closes.
- `aria-live` status region announces state changes; typing indicator has `role=status`.
- Keyboard-complete: composer, tiles, menu, and support form are all reachable/operable without a pointer; visible `:focus-visible` rings.
- Form errors use `aria-invalid`/`role="alert"`; reduced-motion honoured.

*Note: assistive-tech execution (A09) requires manual device/screen-reader testing; code paths are in place.*

---

## 7. Responsive & branding conformance

- Panels: floating 440px at ≥600px; fixed full-screen sheet ≤599px; composer remains available above the virtual keyboard.
- Tiles: 2-column only at inner width ≥ 376px (measured live), else 1-column.
- Branding: Zoiko wordmark + favicon mark, approved colors only, no alternate branding.

---

## 8. Verification & test results

| Command | Result |
| --- | --- |
| `npx eslint .` (`zoiko-billing-nextjs`) | **0 errors**, 223 pre-existing warnings (all `no-img-element` / unrelated unused vars, outside the widget) |
| `npx next build` (`zoiko-billing-nextjs`) | ✅ Compiled, **TypeScript passed**, 123 static pages generated, dynamic `/api/assistant/public/[...path]` proxy present |
| `pytest tests/ai_assistant/` (`backend`) | ✅ **2943 passed, 1 skipped** (0 failures) |
| Public suites (`test_public_assistant.py` 39 + `..._config_support.py` 45 + `..._knowledge_question_coverage.py` + `TestEvidenceUrlSanitization` 7) | ✅ **validated; included in the 2943** |

Notable fixes during this pass:
- Removed unused `fetchSessionsList`/`SessionSummary`, hoisted `currentPage` above its consumer, moved `setStarting(true)` inside the async IIFE to satisfy `react-hooks/set-state-in-effect` (2 lint errors → 0).
- **Tile intent now preserved:** `intent_id` was accepted by `PublicSendMessageRequest` but never forwarded; the router now passes it to `send_message`, which records it as privacy-minimized `topic_selected` telemetry (config id only — never the question text).
- **UUID hardening:** added a `uuid()` helper that falls back when `crypto.randomUUID` is unavailable (plain-HTTP/non-secure contexts) instead of throwing mid-send.
- **Modal focus trap:** the support dialog (`aria-modal="true"`) now cycles `Tab`/`Shift+Tab` within the dialog and returns focus to the trigger on close.
- Fixed stale `public_router.py` module docstring (listed 4 of 7 endpoints).
- **Evidence-URL sanitization:** backend `_evidence_from` drops any `source_url` that is not an allowlisted https URL (safe schemes/paths/hosts only); opens unsafe-scheme risk to `None` so the widget renders a plain pill. Pinned by `TestEvidenceUrlSanitization` (7 tests).
- **Session expiry (A12):** `PUBLIC_ASSISTANT_MAX_SESSION_AGE_SECONDS` (24h). Expired sessions are marked `expired` and rejected (`404`) on send and resume; the widget clears the dead key and starts a fresh conversation. 
- **Cross-visitor session binding (A12):** `send_message`, `create_session` resume, and consented transcript extraction now reject any caller whose hashed IP differs from the session owner with the same `404` as an unknown session — a guessed UUID can never read or write another visitor's anonymous conversation.
- **Support-request idempotency (A07):** `PublicSupportRequestCreate.client_request_id` (widget mints one UUID per form instance, reused across retries) + unique DB column. A retried submit returns the ORIGINAL reference; the Dedupe runs before the rate limit so a retry after a lost response never 429s or duplicates.
- **Message-insertion idempotency (A12):** the `(session_id, idempotency_key)` index is now UNIQUE; a concurrent duplicate that outruns the send-time lookup is caught at `commit`, rolled back, and replayed as the original exchange (never twin rows, never a 5xx).
- **Support-webhook durability (A07):** `create_support_request` now commits the request *before* forwarding to the support desk (then re-commits `dispatched` on a 2xx ack). A 5xx or timeout leaves the row durably in `received` and never claims delivery; a commit lost to the `client_request_id` unique race is rolled back and the winner returned. Pinned by `TestSupportWebhookDelivery` (6 tests, real local HTTP server: 2xx/5xx/timeout/dedupe/race).
- **KB citation-URL mapping (A13):** `PUBLIC_SOURCE_URLS` maps 16 public KB documents to existing zoikobilling.com pages, attached as `KnowledgeDocument.object_uri` and gated by `is_public_url_allowed`; the other 6 intentionally cite no URL. Pinned by `TestPublicSourceUrlMapping` (6 tests: only-public, explicit-decision, allowed-same-site, end-to-end mapped + unmapped).
- **Batched expiry sweep (A12/retention):** `expire_stale_sessions(max_age_seconds=None, batch_size=500)` marks the inactive set expired (no deletion), idempotent and bounded. Pinned by 3 tests.
- **Mobile input zoom (responsive):** on `(pointer: coarse)` the assistant's text fields render at 16px so iOS Safari no longer force-zooms the sheet on focus.

---

## 9. Known limitations & configuration requirements

1. **No dedicated “Privacy and AI assistance” page yet.** `privacy_url` points at the existing `/privacy-and-data-governance`. Creating/approving the dedicated page is a Product/Legal config item.
2. **Live chat is off** (`PUBLIC_ASSISTANT_LIVE_CHAT_ENABLED=False`) → the widget offers the request form only, and never advertises response-time SLAs (`response_time_claim: None`).
3. **Support desk webhook unset** (`AI_PUBLIC_SUPPORT_WEBHOOK_URL=""`). Requests are durably persisted with a real reference *before* any forward attempt (commit → dispatch → re-commit status), so a dispatch failure or a process death mid-forward never loses the request and a retried submit is caught by `client_request_id` dedupe instead of being forwarded twice. *Delivery* is only claimed when a webhook acknowledges 2xx.
4. **No streaming.** Backend returns a complete JSON answer; the typewriter is a client-side reveal. The spec only permits a stop control with streaming, so none is shown.
5. **No automated browser/e2e/visual tests** exist in `zoiko-billing-nextjs` (only lint + build). A01/A02/A09/A15 device evidence must be captured manually.
6. Backend `PUBLIC_ASSISTANT_ALLOWED_ORIGINS` is empty (proxy is same-origin server-to-server, so CORS is not in the browser path).
7. **KB source links.** `backend/seed_knowledge.py` now attaches an approved per-document citation URL via `KnowledgeDocument.object_uri` (retrieval surfaces it, `is_public_url_allowed` gates it). 16 of the 22 public documents are mapped to existing zoikobilling.com pages (`PUBLIC_SOURCE_URLS`); the remaining 6 (`Subscriptions and Plans`, `Proration and Multi-Currency Billing`, `Overdue Invoices and Dunning`, `Contracts and Quotations`, `Billing Workflows and Policies`, `What This Assistant Can Answer`) have **no page that covers the whole topic**, so they intentionally cite a plain, non-clickable pill rather than an invented link. The backend never fabricates a URL (unsafe scheme / unapproved host is dropped to `None`). Adding or changing a mapping is a Product/Legal decision and must point at a page that actually covers the document; the mapping is locked by `TestPublicSourceUrlMapping`. **Owner (for the 6 unmapped): Product/Legal.**
8. **Session-retention cleanup.** Expired sessions are invalidated and marked `expired` on access; a new batched, idempotent sweep (`PublicAssistantService.expire_stale_sessions`, bounded by `batch_size`) marks the inactive set expired without deleting anything. Hard deletion/purge is deliberately **not** implemented: the retention window and any deletion of stored transcripts are a legal/product decision (the spec says retention periods are published only once legally validated). This is a deployment/config item, not a code gap.

---

## 10. Acceptance scenarios A01–A15

| ID | Scenario | Status | Evidence / caveat |
| --- | --- | --- | --- |
| A01 | Desktop open/close/minimize | ✅ Implemented | Geometry, focus restore, scroll retention; manual visual check recommended |
| A02 | Responsive 320/390/440/768/1440 | ✅ Implemented | ≤599 sheet + safe-area; needs manual device pass |
| A03 | Eight tiles: all actions | ✅ Implemented | Config-driven, locked order, intents sent |
| A04 | Anonymous account-data request | ✅ Implemented | `_needs_auth` → no financial data + sign-in CTA with authorized URL |
| A05 | Prompt injection / malicious HTML | ✅ Implemented | Public prompt guardrails; no raw HTML; link allowlist; IDOR-free public scope + sanitized evidence URLs |
| A06 | Unknown feature/prices/tax | ✅ Implemented | Approved uncertainty copy + support route |
| A07 | Support working/unavailable | ✅ Implemented | Availability from config/health; acknowledgement only on confirmed creation; request committed before any forward; retried submits dedupe to the original reference (`client_request_id`); delivery claimed only on webhook 2xx (6 tests) |
| A08 | Consent and privacy | ✅ Implemented | Transcript off by default; consent stored per request; excerpt ownership-bound to the session owner |
| A09 | Screen reader / keyboard / zoom | ⚠️ Code-complete | Requires manual AT + device testing |
| A10 | Slow API / model timeout | ✅ Implemented | 15s request / 45s message timeouts, retry, idempotent send, degraded state; 504/502 distinguished in the proxy |
| A11 | High-volume / rate abuse | ✅ Implemented | Per-IP DB limiter + SlowAPI limits; idempotent retries bypass the budget |
| A12 | Cross-user isolation / expiry | ✅ Implemented | Sessions bound to the owner's hashed IP (foreign caller → 404); 24h inactivity expiry invalidates correctly; message idempotency enforced at DB with replay |
| A13 | Knowledge source traceability | ✅ Implemented | Source-restricted public KB scope; sources surfaced; per-document citation URLs mapped for 16/22 public docs (`object_uri`, allowlist-gated, tests), 6 intentionally unmapped — see §9 item 7 |
| A14 | Security logging | ✅ Implemented | Sanitized structured logs; no finance payloads/credentials; server-only backend origin in proxy logs |
| A15 | Brand regression | ✅ Implemented | Approved wordmark/favicon/colors only; manual visual check recommended |

**Go/No-Go:** no open code blockers. Recommend **GO** for the website build-out with these items tracked: the dedicated “Privacy and AI assistance” page + retention-period copy (see §9 items 1 and 8, Legal), the 6 topic pages that would let the remaining KB citations become clickable (§9 item 7, Product/Legal), the optional support-desk webhook URL, and manual device/AT evidence for A01/A02/A09/A15.
