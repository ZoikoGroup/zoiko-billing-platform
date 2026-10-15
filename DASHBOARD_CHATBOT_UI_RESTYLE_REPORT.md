# Dashboard Copilot — Visual Shell Restyle Report

**Scope:** Align the authenticated dashboard copilot (`frontend/src/modules/ai-assistant/AssistantPanel.jsx`)
with the approved design in `docs/Zoiko_Billing_Public_Chatbot_Detailed_Wireframe_v1_0.docx`
(ZB-PUBCHAT-WF-001). Admin tenant-data and action capability are preserved; public-only
content rules (sign-in walls, no-tenant access) were **not** applied.

## Root causes
- The dashboard panel is a separate (authenticated) assistant, not the public widget. Its
  visual shell had drifted from the approved spec:
  - Oversized, cluttered header with six controls (New, Back, Recent, theme, expand, close)
    where the approved header specifies only **options menu + minimize + close**.
  - Off-brand accent palette: orange `#F5841F` accent and purple `#4C2CC5` icon buttons,
    plus an emerald status dot.
  - Nine grid tiles (topics + an inline "Speak to a human" tile) instead of 8 topics + a
    full-width human action.
  - Old greeting copy and a terse `10px` disclosure line.

## Changes

### `AssistantPanel.jsx`
- **Theme tokens** rewritten to the approved palette for both light and dark: navy
  `#082644`, action `#0868F7`, cyan `#04ADD1`, canvas `#F6F9FC`, surface `#FFFFFF`,
  border `#D6E4F2`, secondary `#53677F`, online `#008E5A`. Added token set used by the
  new shell (`--ab-user-bubble`, `--ab-online`, etc.).
- **Header rebuilt** (spec §5): compact `minHeight: 76`, mark `36px`, title `15px`,
  status "Online" with a token-coloured dot. Right side exposes only **Assistant options**,
  **Minimize assistant panel**, **Close assistant panel**.
- **Options menu** added (Escape / outside-click close) containing the preserved admin
  affordances: New conversation, Recent conversations (nested listbox), Back to Main Menu,
  theme toggle, expand/collapse, and Privacy and AI assistance.
- **Topic grid** (spec §6): 8 numbered tiles, `grid-cols-1 min-[408px]:grid-cols-2`; tile
  min-height 84 (1-up) / 94 (2-up). "Speak to a human" is now a separate full-width
  `.ab-human-btn` after the grid (spec §8), wired to the existing escalate handler.
- **Composer**: `maxLength={2000}`, placeholder "Ask about billing...", send/stop buttons
  use `--ab-accent` via `.ab-send-btn`.
- **Trust footer** (spec §4/§10): exact disclosure copy plus an inline
  "Privacy and AI assistance" link opening a local `PrivacyDisclosure` dialog (no external
  route invented).
- User bubble switched from `bg-brand` to `.ab-bubble-user` (`--ab-user-bubble`).
  The `.order-1` wrapper and MessageBubble structure were left untouched.

### `suggestedPrompts.js`
- `FAQ_CATEGORIES` = the 8 approved topics in spec order with exact starter questions.
- Added `HUMAN_SUPPORT` (label + `action: "escalate"`), rendered as the full-width action.
- `WELCOME_MESSAGE` = approved greeting ("Hi, I'm your Zoiko Billing Assistant 👋" + body,
  no sign-in clause for the authenticated user).

### `index.css`
- Tile geometry (min-height 84/94, radius 14), `.ab-human-btn`, `.ab-menu-item`,
  `.ab-send-btn`, `.ab-bubble-user`.

### `ConfirmDialog.jsx`
- Accent fallbacks updated from orange `#F5841F` to `#0868F7`.

### Tests updated
- `AssistantPanel.test.jsx`: greeting regex → `/hi, i'm your zoiko billing assistant/i`;
  added `ensureAssistantMenuOpen()` helper; header-control interactions now open the
  options menu first; duplicate-menu assertion updated.
- `tests/assistant-header.spec.js`: asserts approved controls (options/minimize/close) and
  the admin controls inside the options menu.
- `tests/assistant-error-fallback.spec.js`: `.ab-cat-btn` count 9 → 8, plus `.ab-human-btn`
  count 1.

## Verification
- `npx vitest run` — **392 passed / 38 files** (assistant panel: **44/44**).
- `npx playwright test assistant-header assistant-error-fallback` — **6 passed**.
- `npm run build` — succeeds.

### Public widget topic-tile restructure (`.ab-tile__head` + full-width description)
- `npx next build` — succeeds; `npx eslint .` — 0 errors (warnings pre-existing).
- Real Playwright UI audit against `next start -p 3111` (mocked endpoints),
  viewports 320/390/440/600/768/1024/1440 — **TOTAL 56 PASS 56 FAIL 0**:
  - 8 tiles in locked order; `.ab-tile__icon`=8, `.ab-tile__desc`=8.
  - 2-col / 4-row grid at panel width ≥ 376 (`@1440/768/600/440`),
    1-col at `@390/320`; consistent tile heights `[98.4, 99.4]` (≥ 94 min).
  - No horizontal scroll at any viewport; composer always in viewport.
  - Panel 440×720 radius 20 at desktop; full-screen sheet (radius 0) ≤ 440.
  - Greeting `Hi, I'm your Zoiko Billing Assistant 👋`; header 81.1 px;
    title 15 px navy `rgb(8,38,68)`; send action blue `rgb(8,104,247)`;
    human card full-width (406 vs 408) with label + description.

## Dependencies / notes
- Header status remains a static "Online" indicator; wiring it to a real service-health
  signal is a backend dependency (deferred).
- "Privacy and AI assistance" is implemented as an in-panel disclosure because no privacy /
  AI-assistance route exists in the frontend; point it at the real destination when available.
- Pixel-diff against reference PNGs was not performed (no image input available to the
  agent); palette values and geometry were verified programmatically instead.
