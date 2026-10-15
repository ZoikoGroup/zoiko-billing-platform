# Public Billing Assistant — Wireframe & Specification Conformance Report

**Spec:** `docs/Zoiko_Billing_Public_Chatbot_Detailed_Wireframe_v1_0.docx` (ZB-PUBCHAT-WF-001 v1.0, 2026-10-09)
**Target:** `zoiko-billing-nextjs/` public widget (marketing site) — **not** the Vite dashboard copilot
**Backend:** `backend/app/modules/chatbot/` (`public_config.py`, `public_assistant.py`, `public_router.py`)
**Date:** 2026-10-14
**Method:** static read of every public-chatbot source file against the spec, plus automated tests, a
production build, and a **headless-Chromium browser QA run** against the built app (`npx next build` +
`npx next start`, proxy → backend `:8001`). The geometry and functional results in §13.2/§15 are
**observed** live at 1440×900, 768×900, 440×800, 390×800, 320×700 plus a keyboard-only traversal. Every
item below is a requirement from the spec, not a restatement of the code.

Legend: **PASS** = implemented and machine-verified · **PARTIAL** = implemented with a documented,
accepted deviation or an unmet sub-clause · **NOT VERIFIED** = requires human/manual evidence (screen
reader, zoom, cross-browser, live telemetry) · **N/A** = optional clause, deliberately not implemented.

---

## 1. Verdict summary

The public widget is **substantially conformant**. All shipping copy, the eight topic tiles, the
component contracts, the state model and the instrumentation event set match the spec. Automated
backend isolation/security suites and the frontend build/lint pass.

This pass implemented four code-level fixes (see §2). The only open items are **external
dependencies** (DBA migration, legal copy, live-chat/webhook config, unmapped KB citation URLs) and
**manual evidence** (screen-reader/zoom/cross-browser/performance). None is a code defect in the
public widget.

---

## 2. Changes implemented in this pass

| # | Requirement | File | Change |
| --- | --- | --- | --- |
| 1 | §4.1 *Assistant title = “Billing Assistant”* | `backend/app/modules/chatbot/public_config.py:21`; `PublicAssistantWidget.tsx` `DEFAULT_CONFIG.assistant_title` | `"Zoiko Billing Assistant"` → `"Billing Assistant"` so the served config field matches the spec (the header already rendered “Billing Assistant”). |
| 2 | §8.2 Waiting recovery *“Retry / Contact support”* | `PublicAssistantWidget.tsx` (message error banner) | Added a **Contact support** action beside **Retry** (previously Retry only). |
| 3 | C-01 *Escape closes only when chat focus context is active* | `PublicAssistantWidget.tsx` (Escape effect) | Added a `panelRef.contains(document.activeElement)` guard; the comment now matches the behaviour. |
| 4 | §11.2 *Buttons ≥ 24 × 24 CSS px* | `app/globals.css` | Gave the compact controls a `min-height: 24px` target: feedback buttons, degraded/error action buttons, link buttons; added `.ab-form-error__actions`. |
| 5 | §15 *Header within 76–84px at all breakpoints* | `app/globals.css` | `.ab-panel__header` vertical padding `10px → 8px` (and mobile `env(safe-area-inset-top)` base to 8px); measured header is now a uniform **81px** (was 85px) at every tested viewport. |
| — | §4.1 config versioning | `public_config.py` | `PUBLIC_CONFIG_VERSION` `2026-10-14.2` → `2026-10-14.3` (shipped copy changed). |
| — | Test coverage for #1 | `backend/tests/ai_assistant/test_public_assistant_config_support.py` | `test_disclosure_and_greeting_are_exact` now asserts `assistant_title == "Billing Assistant"` and the sign-in label. |

---

## 3. Files changed (cumulative)

| File | Change |
| --- | --- |
| `backend/app/modules/chatbot/public_config.py` | Assistant title + version (this pass); greeting body/disclosure/sign-in label (prior pass). |
| `backend/tests/ai_assistant/test_public_assistant_config_support.py` | Locked assertions for title + sign-in label + copy. |
| `zoiko-billing-nextjs/components/assistant/PublicAssistantWidget.tsx` | Header brand lockup; fallback `assistant_title`; error-state Contact support; Escape focus guard. |
| `zoiko-billing-nextjs/app/globals.css` | Compact card/greeting/brand spacing; composer/footer trim; ≥24px control targets. |
| `zoiko-billing-nextjs/public/zoiko-billing-log.png` | Supplied wordmark asset (3263×1163) placed at the referenced path. |

> `zoiko-billing-nextjs/` is a **separate git repository** (branch `madhu`); `public_config.py` is a new
> untracked file in the main repo. No commit was made (not requested).

---

## 4. §4.1 — Fixed first-view copy

| Region | Spec copy | Implementation | Status |
| --- | --- | --- | --- |
| Header wordmark | Zoiko Billing (supplied lockup) | `<Image src="/zoiko-billing-log.png" alt="Zoiko Billing">` | **PASS** |
| Assistant title | Billing Assistant | Header `<h2>` + `config.assistant_title` (aligned this pass) | **PASS** |
| Status | Online / Unavailable | `available ? "Online" : "Unavailable"` (health-derived) | **PASS** |
| Greeting title | Hi, I’m your Zoiko Billing Assistant 👋 | `config.greeting_title` | **PASS** |
| Greeting body | Ask me about invoices, payments, customers, or billing workflows. I can explain features and guide you to the right place. Sign in for account-specific information. | backend `GREETING_BODY` + fallback, byte-exact | **PASS** |
| Composer placeholder | Ask about billing... | `config.composer_placeholder` | **PASS** |
| Disclosure | AI-assisted guidance about Zoiko Billing. Verify financial information in your billing records. | backend `DISCLOSURE`, byte-exact | **PASS** |
| Link in footer | Privacy and AI assistance *(opens local disclosure)* | Link labelled “Privacy and AI assistance” opening the published `/privacy-and-data-governance` page in a new tab — not an in-widget disclosure panel | **PARTIAL** — a dedicated approved disclosure panel is a product/legal dependency (copy can’t be invented). |

---

## 5. §5 — Component interaction contracts

| ID | Requirement (abridged) | Status | Evidence |
| --- | --- | --- | --- |
| C-01 | Launcher opens + focuses heading; Escape closes only in chat focus context; focus returns to launcher; persists | **PASS** | Focus guard added this pass; open→`headingRef.focus()`, close→`launcherRef.focus()`. |
| C-02 | Fixed wordmark/favicon assets; logo not a nav link; accessible name “Zoiko Billing” | **PASS** | `Image` (not an `<a>`), `alt="Zoiko Billing"`. |
| C-03 | Online status from health (not operator availability); non-intrusive; never blink | **PASS** | `fetchHealth()` drives `available`; static dot, no animation. |
| C-04 | Overflow menu: New conversation; Privacy and AI assistance; Contact support; closes on Escape/outside click | **PASS** | `role="menu"`/`menuitem`; `menuRef` outside-click handler; Escape handled. |
| C-05 | Minimize hides without destroying state; restore via launcher + prior scroll | **PASS** | `widget_minimized` saves `savedScrollRef`; restore effect reapplies it. Browser QA: minimize hides panel, messages preserved on restore, scroll position (40 → 40px) restored. |
| C-06 | Close preserves state within retention; no deletion implication | **PASS** | Close keeps in-memory state; no destructive copy. |
| C-07 | Greeting visible before first action; *may* collapse after | **PASS** | Greeting block renders only when `messages.length === 0`. |
| C-08 | Whole tile is a button; posts approved starter prompt; no billing mutation | **PASS** | `<button className="ab-tile">` → `handleTile(tile)` sends `starter_question`. |
| C-09 | Full-width “Speak to a human” action | **PASS** | `.ab-human-btn` full-width. |
| C-10 | Multi-line field max 2,000 chars; Enter sends; Shift+Enter newline | **PASS** | `MAX_INPUT_CHARS = 2000`; `handleKeyDown`. |
| C-11 | Send disabled if empty/offline/submitting; idempotency key; pending + error states | **PASS** | `disabled` conditions; `client_request_id`/`clientId`; typing indicator + error banner. |
| C-12 | Disclosure visible; “Privacy and AI assistance” from menu | **PASS** | Footer disclosure + menu item. |
| C-13 | Streaming *allowed* with stop control; cite approved docs / verified destinations | **PASS** (streaming N/A) | Typewriter reveal + source links; token streaming is optional and not implemented, so no stop control is required. |

**§5.1 Visual feedback states** (default/hover/focus/pressed/disabled/busy/failure; no composer shift):
**PASS** — CSS defines hover/`:focus-visible`/`:disabled`; loading indicator is appended below the log,
the composer is `flex: 0 0 auto`.
**§5.2 Header menu decision** (no history/dark-mode/attachment/maximize): **PASS** — not present.

---

## 6. §6 — Topic tiles (eight, locked order)

Verified byte-exact against the spec (label order, `starter_question`, provider-managed config):

| # | Tile | Starter intent | Status |
| --- | --- | --- | --- |
| 01 | Getting started | How do I get started with Zoiko Billing? | **PASS** |
| 02 | Invoices | How do I create and send an invoice? | **PASS** |
| 03 | Payments | How do payments work in Zoiko Billing? | **PASS** |
| 04 | Reconciliation | How does payment reconciliation work? | **PASS** |
| 05 | Credits & refunds | How can I issue a credit or refund? | **PASS** |
| 06 | Entities & currencies | Can Zoiko Billing support multiple entities or currencies? | **PASS** |
| 07 | Permissions | How do user roles and permissions work? | **PASS** |
| 08 | What this assistant can do | What can you help me with? | **PASS** |

Tiles are defined in `public_config.py` (`PUBLIC_TOPIC_TILES`), not hardcoded in the model prompt
(**PASS** for §6 “editable from managed configuration”). Order preserved at all breakpoints (§7);
two columns ≥376px inner width, else one. Duplicate activation blocked while submitting.

---

## 7. §7.1 — Message structure & rendering

| Type | Rule | Status |
| --- | --- | --- |
| User message | Right-aligned colored surface; timestamp via accessible description | **PASS** — `.ab-bubble--user`; `MessageTimeStamp` with `title` (full timestamp). |
| Assistant message | Left-aligned neutral; headings/steps/sources/actions distinguished | **PASS** — `MarkdownTypewriter` + source/CTA/nav regions. |
| Source link | Descriptive title + domain; domain allowlist; no invented URLs | **PASS** (logic) — `isAllowedUrl` on both sides; renders `title · domain`. **Observed:** answers return 3 source pills but **0 clickable links**, because every public KB document currently resolves to a single source whose `source_url` is unset (see §14.6) → `.ab-source` renders as a non-link pill rather than inventing a URL. |
| Sign-in action | “Sign in to view your billing account”; legitimate flow; never collects password | **PASS** — label from config; `navigate(config.sign_in_url = "/sign-in")`. |
| Escalation action | “Contact support”; contextual summary; consent before transcript | **PASS** — human-support button; consent checkbox gates transcript. |
| Feedback | Optional compact Helpful / Not helpful, no profiling by default | **PASS** — `Feedback` component; no per-user profiling. |

---

## 8. §8 — Journey, states and escalation

### §8.1 End-to-end guest flow — **PASS**
Open/minimize/close, topic-or-typed entry, source-restricted retrieval, uncertainty fallback, sign-in
destination instead of tenant APIs, consent-gated human handoff and no cross-visitor restoration are
all implemented (guards verified by `test_public_assistant.py` + `test_public_security_adversarial.py`).

### §8.2 Operational state model

| State | Spec UI / recovery | Status |
| --- | --- | --- |
| Idle | Greeting, eight tiles, human action, composer | **PASS** |
| Waiting | User bubble + progress; send locked; timeout → Retry / Contact support | **PASS** — Contact support added this pass. |
| Streaming | Incremental answer; stop if implemented | **N/A** — streaming not implemented. |
| Answered | Answer with verified citations | **PASS** |
| Sign-in required | Explanation + “Sign in” CTA; return to guidance if declined | **PASS** |
| No approved answer | “I can’t verify that from published Zoiko Billing guidance.” | **PASS** — `UNCERTAINTY_MESSAGE` byte-exact. |
| Service degraded | “The assistant is temporarily unavailable.” + retry + human contact | **PASS** — `SERVICE_DEGRADED_MESSAGE` byte-exact; Retry + Contact support. |
| Escalating | Support availability + consent; confirmed handoff ID only after successful request | **PARTIAL** — the reference is shown after the request is **durably persisted locally**, not only after the external support platform acknowledges it. This is the deliberate “never lose the request” behaviour; `delivered_to_desk` is returned but not surfaced. Documented in the readiness report. |

### §8.3 Human support modal — **PASS (with §8.2 PARTIAL above)**
Title “Speak to Zoiko Billing support”; channels described from live config (“Start live chat” only
when `PUBLIC_ASSISTANT_LIVE_CHAT_ENABLED`); required issue type/email/summary + optional details;
consent checkbox before transcript sharing (off by default); client + server email validation; no
unverified response-time claims (`response_time_claim: null`).

---

## 9. §9 — Public AI boundaries

| Clause | Status | Evidence |
| --- | --- | --- |
| No tenant data / no authenticated context | **PASS** | Public router uses no tenant auth; adversarial suite passes. |
| No mutations/refunds/credential reset/export | **PASS** | Tool registry deny-by-default; no write tools. |
| No card/bank/secret/OTP capture | **PASS** | Sanitizer + `requires_auth` handling. |
| No fabricated citations / unsupported claims | **PASS** | Source allowlist + uncertainty fallback. |
| Permitted KB only | **PASS** | Separate public retrieval index (see §10.2). |

---

## 10. §10 — Integration contracts (proposed; subject to API review)

| Contract | Status | Note |
| --- | --- | --- |
| Session / messages / config / health / support / feedback | **PASS** | Routes exist under `/api/assistant/public/*` (same-origin proxy → backend `:8001`). |
| §10.1 response object fields | **PARTIAL** | Adapter returns the safe subset (`session_uid`, `message_uid`, `answer`, `mode`, `risk_class`, `evidence`, `suggested_prompts`, `requires_auth`, `safety_state`, `intent_id`, `created_at`); forbids `tenant_id`, prompts, tool traces, confidence. Field names differ from the *proposed* contract, which the spec marks “subject to API review”. |
| §10.2 isolation / reliability / observability | **PASS** | Public KB separated from tenant stores; TLS/CSRF/origin controls; timeouts/retries/request IDs; versioned config + consent language. |

---

## 11. §11 — Privacy, accessibility, interaction

| Clause | Status |
| --- | --- |
| §11.1 truthful AI ID + public boundary; retention/subprocessor/geo copy only once legally validated | **PARTIAL** — copy deps flagged to Legal; no invented retention claims. |
| §11.2 semantic dialog/region + focus order + focus return + no traps | **PASS** |
| §11.2 buttons ≥24×24; 44×44 touch preferred; labels for icon-only controls | **PASS** — compact controls brought to ≥24px this pass; icon buttons have `aria-label`. |
| §11.2 visible focus; 4.5:1 text / 3:1 control boundaries | **PASS** (static) — token pairs meet contrast; **NOT VERIFIED** against gradients in a real render. |
| §11.2 programmatic label + accessible errors; judicious `aria-live`; no whole-answer re-read | **PASS** — `role="alert"` errors; action announcements via `aria-live`. |
| §11.2 200% text / 400% zoom / reduced motion / safe-area / screen reader | **NOT VERIFIED** — manual device + AT testing required. |

---

## 12. §12 — QA matrix (A01–A15)

| ID | Scenario | Status | Basis |
| --- | --- | --- | --- |
| A01 | Desktop open/close/minimize; focus restored; permitted state retention | **PASS** | Code + measured geometry. |
| A02 | Responsive 320/390/440/768/1440; no h-scroll; composer available | **PASS** | Measured (§7). |
| A03 | Eight tiles: titles/descriptions/order/intents/destinations | **PASS** | Exact config match (§6). |
| A04 | Anonymous account-data request → no data; sign-in + correct URL | **PASS** | `requires_auth` → sign-in CTA; tests. |
| A05 | Prompt injection / malicious HTML | **PASS** | `test_public_security_adversarial.py`. |
| A06 | Unknown feature/price/tax → honest uncertainty + support | **PASS** | Uncertainty copy + support route. |
| A07 | Support working/unavailable; ack only on confirmed creation | **PARTIAL** | Availability correct; ack shown after local durable persist (see §8.2). |
| A08 | Consent + privacy; transcript off by default | **PASS** | Consent checkbox default off; stored with request. |
| A09 | Screen reader / keyboard / zoom | **PARTIAL** | **Keyboard-only traversal verified** (launcher focusable → Enter opens → heading focused → Tab reaches tiles → Escape closes → focus returns to launcher). **Reflow verified**: 320 CSS px (~400% of 1280) has zero horizontal overflow. Screen-reader + real-device zoom still require manual AT testing. |
| A10 | Slow API / timeout → retry + fallback, no duplicate/frozen UI | **PASS** | Idempotency key + abort/timeout + Retry/Contact support. |
| A11 | High-volume / rate abuse → quotas, bounded cost, degradation | **PARTIAL** | Perimeter rate-limit rationale documented; live volumetric evidence not run. |
| A12 | Cross-user isolation / session expiry | **PASS** | Expiry migration + isolation tests. |
| A13 | Knowledge source traceability; disabled source not retrievable | **PASS** | Allowlist + retrieval tests. |
| A14 | Sanitized telemetry; no finance payloads/credentials in logs | **PASS** | `_safe_meta` redaction; event allowlist. |
| A15 | Brand regression (wordmark/favicon/colors) | **PASS** | Supplied asset + locked tokens. |

### §12.2 Performance/reliability gates — **NOT VERIFIED**
Lazy-load-after-critical, open-to-visible p95 < 500 ms, first feedback < 1 s, >15 s → retry/support are
**implementation-ready** but unproven without production telemetry (spec says final SLAs must be
approved with engineering).

### §12.3 Instrumentation — **PASS**
All ten spec events are allowlisted and wired: `widget_opened`, `widget_minimized`, `topic_selected`,
`message_submitted`, `answer_rendered`, `answer_source_clicked`, `auth_cta_clicked`,
`support_requested`, `ticket_confirmed`, `assistant_error`. Metadata is privacy-minimized (event,
anonymous session id, topic id, locale, config version, timing bucket) — no raw finance questions.
`support_requested` fires on opening the support modal; `ticket_confirmed` on successful persistence.

---

## 13. Verification evidence (re-run this pass)

| Check | Command | Result |
| --- | --- | --- |
| Config/support tests | `pytest tests/ai_assistant/test_public_assistant_config_support.py -q` | **50 passed** |
| Public flow / security / KB tests | `pytest tests/ai_assistant/test_public_assistant.py test_public_security_adversarial.py test_public_knowledge_question_coverage.py -q` | **184 passed** (29.5 s) |
| Full chatbot suite | `pytest tests/ai_assistant -q` | **2985 passed, 1 skipped** (350.7 s) |
| Widget + proxy lint | `npx eslint components/assistant/PublicAssistantWidget.tsx app/api/assistant/public` | **clean** (exit 0) |
| Full lint | `npx eslint .` | **0 errors**, 223 pre-existing warnings |
| Production build | `npx next build` | **✓ compiled**; 123 static routes + dynamic `/api/assistant/public/[...path]` proxy |
| Frontend public-client unit tests | `npx vitest run src/modules/ai-assistant/publicAssistant.test.js` | **5 passed** |
| Browser QA | `node frontend/_qa_public_widget.cjs` (Playwright) | **all functional checks pass** (see §13.1) |

### §13.1 Browser QA results (headless Chromium, built app)

- **Geometry (all 5 viewports):** panel `440×720` desktop / full-bleed sheet (`border-radius:0`, no border)
  at ≤599px; header uniform **81px**; 8 tiles in locked order; document + panel horizontal overflow `0`;
  body `overflow-y:auto` and scrollable; composer/footer in view.
- **Copy:** greeting `Hi, I’m your Zoiko Billing Assistant 👋` + disclosure byte-exact; logo
  `naturalWidth 3263`, `alt="Zoiko Billing"`; `lang="en"`; exactly one `<h1>`/title.
- **Functional (all true):** heading focused on open + visible focus outline; overflow menu = exactly
  `New conversation / Privacy and AI assistance / Contact support`, closes on Escape and outside click;
  Escape **keeps the panel open** when focus is outside the chat, **closes** it when focus is inside,
  then focus returns to the launcher; support modal title / `role="dialog"` / live-chat-unavailable copy
  / 5 issue options; submit disabled when empty and when invalid; inline validation + `aria-invalid`;
  no consent prompt without a conversation and consent prompt **with** one; Shift+Enter inserts a newline
  without sending; 2,000-char cap enforced; tile click sends the exact starter prompt; answer rendered
  with correct user→assistant order, timestamps, feedback acknowledgement; minimize/restore preserves
  messages and scroll; close/reopen preserves messages; “New conversation” resets to the tile grid.
- **Console:** zero console errors; the only failed network requests are benign Next.js RSC-prefetch
  (`?_rsc=`) cancellations, not widget calls.
- **Keyboard-only traversal:** launcher focusable (`aria-label="Open the Zoiko Billing assistant"`) →
  Enter opens + heading focused → Tab reaches the tiles → Escape closes → focus returns to launcher.

---

## 14. Remaining items / external dependencies (not code-fixable)

1. **Escalating reference timing** (§8.2/§8.3/A07) — surfaced after local durable persistence rather
   than external platform acknowledgement. Requires a product decision + webhook integration.
2. **Live chat** — `PUBLIC_ASSISTANT_LIVE_CHAT_ENABLED=False`, no webhook configured. The widget
   correctly shows “Send a support request”. Enabling live chat is a config/support-platform task.
3. **“Privacy and AI assistance” local disclosure** (§4.1) — currently opens the published
   data-governance page; a dedicated approved disclosure panel needs Legal copy.
4. **Privacy/retention copy** (§11.1) — retention periods, subprocessors, geographic handling and
   deletion channel must be legally validated before publication.
5. **DB schema drift migration** — see `DB_SCHEMA_DRIFT_REMEDIATION_PLAN.md`; requires DBA
   authorization. Not applied.
6. **Unmapped KB citation URLs** — the public answers cite correctly, but **all 23 `is_public` knowledge
   documents resolve to a single source whose `source_url` is unset** (verified against the DB), so no
   approved URL is available and the widget correctly renders non-link source pills. Approved source
   URLs must be supplied by content owners before any clickable citation can appear.
7. **Performance/telemetry gates** (§12.2) and **manual a11y/cross-browser evidence**
   (§11.2, A09, A11) — require a staging environment and human testers.

---

## 15. Measured geometry (headless Chromium, built app — this pass)

| Viewport | Panel | Radius | Header | Tiles | Composer/footer | H-overflow | Body scrolls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1440×900 | 440×720 | 20px | **81px** | 8 | 137px | 0 | yes |
| 768×900 | 440×720 | 20px | **81px** | 8 | 137px | 0 | yes |
| 440×800 | 440×800 (sheet) | 0 | **81px** | 8 | 137px | 0 | yes |
| 390×800 | 390×800 (sheet) | 0 | **81px** | 8 | 137px | 0 | yes |
| 320×700 | 320×700 (sheet) | 0 | **81px** | 8 | 137px | 0 | yes |

Panel 440px wide (desktop), ≤599px full-screen sheet; header uniform **81px** (within the 76–84px guide);
8 tiles in locked order; logo ratio exact (3263/1163 = 2.805); zero horizontal overflow at 320–1440px
(reflow at 320 px ≈ 400% of 1280 px); header/composer pinned while the body scrolls.

> **Composer/footer height 137px** exceeds the wireframe’s ~90–112px padding guidance. The extra height is
> the required §4.1 disclosure line plus the “Privacy and AI assistance” link — content the spec mandates,
> so this is an accepted deviation rather than a defect.
