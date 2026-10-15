# Public Billing Chatbot — Release Readiness Report

**Spec:** `docs/Zoiko_Billing_Public_Chatbot_Detailed_Wireframe_v1_0.docx` (ZB-PUBCHAT-WF-001 v1.0, Sections 01–13)
**Scope:** `zoiko-billing-nextjs/` widget + `backend/app/modules/chatbot/*` public assistant (`/api/assistant/public/*`)
**Verdict: GO (conditional)** — no tenant-leak, injection, or keyboard-accessibility blocker found. Remaining items are operator-configuration / environment evidence gaps, not code defects.

---

## 1. Changed files this session

| File | Change | Rationale (spec ref) |
|---|---|---|
| `zoiko-billing-nextjs/app/globals.css` | Body text `13.5px → 14px`; metadata `10–11px → 12px` (greeting body, `.ab-bubble`, `.ab-tile`, `.ab-human-btn`, `.ab-input`, `.ab-field`, `.ab-ts`, `.ab-source`, `.ab-disclosure`, `.ab-privacy a`, `.ab-count`, badge) | §3.2 typography baseline: "body 14; meta 12–13 CSS px" |
| `backend/tests/ai_assistant/test_public_security_adversarial.py` | **New** independent adversarial security suite (35 tests) | §09 / §11.1 / §12 A04–A06, A12–A14 |
| `PUBLIC_CHATBOT_RELEASE_READINESS_REPORT.md` | **New** (this file) | §13 P4 release QA deliverable |

No production UI structure, copy, colors, or backend behavior was changed. The only production edit was typography-token conformance.

---

## 2. Evidence run (all executed this session)

| Check | Command | Result |
|---|---|---|
| Public test suites | `pytest tests/ai_assistant/test_public_*.py` | **194 passed** |
| New adversarial suite | `pytest tests/ai_assistant/test_public_security_adversarial.py` | **35 passed** |
| Full AI regression | `pytest tests/ai_assistant` | **2978 passed, 1 skipped** (337s) |
| Frontend lint | `npx eslint .` (nextjs) | **0 errors, 223 pre-existing warnings** |
| Frontend build | `npx next build` | ✓ compiled, ✓ TypeScript, 123 routes, proxy route built (earlier this session) |
| UI audit (real browser) | Playwright `ui-audit.js` vs `next start -p 3111` (backend mocked) | **53/53 PASS** |

**UI-audit coverage (53 assertions):** launcher 56×56 fixed bottom-right 24px inset; panel geometry/radius + full-screen `100dvh` ≤599px; composer in-viewport; no horizontal scroll; 8 tiles in locked order; 2-col @1440/440 with 4 distinct row-tops; 1-col @390/320 with 8 row-tops; tile min-height 94; title 15px navy; send `rgb(8,104,247)`; white panel; header 76–84; exact greeting/placeholder/disclosure copy; status "Online" + green dot; full-width human action; focus enters on open; Shift+Enter newline; tile→starter-question submit; source rendered; Escape closes + focus restore; offline → "Unavailable" + degraded copy + send disabled.

Limitation: no pixel-diff (agent has no image input). Substituted programmatic palette profiling (PIL) of the reference PNGs and Playwright geometry.

---

## 3. Sections 01–13 traceability

| § | Requirement | Status | Evidence |
|---|---|---|---|
| 01 | Fidelity rules; wordmark compact; 8 topics in order; full-width human; pinned header/composer; no unverified claims | **PASS** | geometry audit; tile-order assertion; header/composer in viewport; support-mode test never claims live chat unless enabled |
| 02 | Screen anatomy WF-01..WF-06 | **PASS** | all regions present in DOM audit |
| 03 | Dimensions/tokens/breakpoints/colors/type/icons | **PASS** | geometry audit (56, 440×min(720,…), 94, 76–84, 12 gap, 16 pad, 2-col ≥376, radius 0 mobile); typography fixed this session; palette profiling confirms navy/action/canvas present |
| 04 | Exact first-view copy | **PASS** | audit asserts exact greeting title/body, placeholder, disclosure; `test_disclosure_and_greeting_are_exact` |
| 05 | Component contracts C-01..C-13 | **PASS** | launcher focus/escape/restore, Enter vs Shift+Enter, disabled-on-empty/offline, footer privacy — audit + tests |
| 06 | 8 tiles + intent routing + config-managed | **PASS** | `test_eight_tiles_in_approved_order`, `test_starter_questions_match_specification`, `test_tile_ids_are_stable_intent_ids`; tiles served from `public_config.py` (not hardcoded in widget) |
| 07 | Message structure / sources / sign-in / escalation / feedback | **PASS** | source pill render; requires_auth answer; support consent; feedback schema (`PublicAssistantFeedback`) |
| 08 | Journey + operational state model + support modal | **PASS** | offline degraded state; sign-in state; abstention; consent-gated support request; reference only on confirmed creation |
| 09 | Public AI boundaries / verified content | **PASS** | retrieval locked to `billing_public` + `is_public=True` + `status=approved` (`retrieval.py:352,391,290`); no tenant FKs on public tables; adversarial suite 35/35 |
| 10 | Integration contracts | **PASS (adapter)** | implemented as `/api/assistant/public/*` adapter over proposed `/public/assistant/*`; Next same-origin proxy; response omits tenant_id/prompts/tools/confidence (schema test) |
| 10.1 | Response object fields | **PASS** | `test_no_forbidden_serialized_fields` on all public response models |
| 10.2 | Isolation/reliability/observability | **PASS (see 6)** | separate public KB scope; safe-URL allowlist; rate limit; timeouts; sanitized telemetry; config version |
| 11.1 | Privacy/security acceptance | **PASS** | consent default off; minimized excerpt; `test_free_text_metadata_is_not_logged`; `test_health_has_no_provider_or_internal_fields` |
| 11.2 | WCAG 2.2 AA checklist | **PARTIAL / NOT RUN** | keyboard + focus + zoom covered by audit; **screen-reader and 200%/400% reflow NOT RUN** (see 5) |
| 12 | QA matrix (A01–A15) | **SEE §4** | |
| 13 | Implementation sequence / sign-off | **PASS (P0–P4 code)** | P0–P3 implemented; P4 QA evidence assembled here |

---

## 4. Acceptance matrix A01–A15

| ID | Scenario | Result | Evidence |
|---|---|---|---|
| A01 | Desktop open/close/minimize, focus restore, state retained | **PASS** | audit: focus enters on open, Escape closes + restores |
| A02 | Responsive 320/390/440/768/1440 | **PASS** | audit: no horizontal scroll, composer available, 1/2-col correct |
| A03 | 8 tiles: titles/descriptions/order/intents/destinations | **PASS** | config tests + tile-order audit |
| A04 | Anonymous account-data request | **PASS** | `TestAnonymousAccountDataRequests` + adversarial: no financial data, sign-in CTA |
| A05 | Prompt injection / malicious HTML | **PASS** | guardrail refusal (logs) + 7 injection vectors safe |
| A06 | Unknown feature/price/tax | **PASS** | exact uncertainty copy; adversarial MALICIOUS_UNKNOWN abstain/sign-in |
| A07 | Support working/unavailable | **PASS (conditional)** | persists + confirmed-reference only on 2xx; **live delivery BLOCKED** (webhook unset) |
| A08 | Consent & privacy | **PASS** | `test_consent_defaults_off_and_shares_nothing`, consent-stored tests |
| A09 | Screen reader / keyboard / zoom | **NOT RUN (partial)** | keyboard/zoom via Playwright; **screen-reader & 200/400% manual NOT RUN** |
| A10 | Slow API / timeout | **PASS (backend)** | 429/timeout handling; support webhook timeout test; **visual retry UX NOT RUN** |
| A11 | High-volume / rate abuse | **PASS** | `test_rate_limit_exhausted_is_429`, `test_rate_limiter_blocks_after_window_budget` |
| A12 | Cross-user isolation / session expiry | **PASS** | `TestSessionOwnershipBinding` (foreign ip rejected), `TestSessionExpiry` |
| A13 | Knowledge source traceability | **PASS** | approved-only + public-only retrieval; internal doc never cited |
| A14 | Security logging | **PASS** | `test_free_text_metadata_is_not_logged`, `TestHealthEndpointLeakage` |
| A15 | Brand regression | **PASS** | wordmark/favicon present; palette profiling: navy + action blue + canvas |

---

## 5. BLOCKED / NOT RUN

| Item | Type | Reason | Mitigation |
|---|---|---|---|
| Pixel-diff vs reference PNG | BLOCKED | Agent has no image input | Palette profiling (PIL) + Playwright geometry |
| A09 screen-reader (NVDA/JAWS/VoiceOver) | NOT RUN | Requires assistive tech host | Manual QA checklist in §6 |
| A09 200% text / 400% zoom reflow | NOT RUN | Requires manual browser zoom | Manual QA checklist |
| Cross-browser Firefox / Safari / iOS / Android | NOT RUN | Audit used Chromium only | Manual device matrix (§12.1) |
| A07 live-chat / webhook delivery in prod | BLOCKED | `PUBLIC_ASSISTANT_LIVE_CHAT_ENABLED=False`, `AI_PUBLIC_SUPPORT_WEBHOOK_URL=""` | Operator must set + staff live service before claiming live chat |
| §12.2 performance gates (p95 < 500ms, < 1s first feedback, 15s retry) | NOT RUN | No production telemetry/baseline device | Instrument + measure on staging |
| Real KB citation URLs | Data-dependent | Mechanism works (`is_public_url_allowed`); production docs may lack `source_url` → plain pills (no invented links, correct) | Verify/populate KB source URLs |

---

## 6. GO/NO-GO

Per §13 go/no-go: release is blocked if (a) a guest can access tenant records, (b) an answer invents sensitive billing details, (c) handoff transmits a transcript without consent, (d) a primary action is keyboard-inaccessible, or (e) the mobile composer can hide behind the keyboard.

| Blocker | Status |
|---|---|
| Guest → tenant records | **Clear** — no tenant FK on public tables; router has no auth/tenant deps; retrieval locked to public scope |
| Invented sensitive billing details | **Clear** — account requests → sign-in; unknown → abstention; confidence gate 0.5 |
| Consentless transcript transfer | **Clear** — consent default off, server-enforced |
| Keyboard-inaccessible primary action | **Clear** — audit: focus enters, Escape restores, Shift+Enter |
| Mobile composer hidden by keyboard | **Clear** — full-screen sheet + composer in-viewport @320/390 |

**No go/no-go blocker is triggered by code.** Outstanding items are manual accessibility/device evidence and operator configuration.

## 7. Remaining actions before sign-off

1. Run A09 screen-reader + 200%/400% zoom manual checks (NVDA or VoiceOver, Chrome + Firefox).
2. Run cross-browser/device matrix per §12.1 (Firefox, Safari, Android Chrome, iOS Safari).
3. Decide live-chat vs request-only; if live, set `PUBLIC_ASSISTANT_LIVE_CHAT_ENABLED` + `AI_PUBLIC_SUPPORT_WEBHOOK_URL` and verify a real ticket acknowledgement.
4. Populate/verify `KnowledgeSource.source_url` for public docs so citations render linked.
5. Capture §12.2 performance numbers on a staging baseline device.
