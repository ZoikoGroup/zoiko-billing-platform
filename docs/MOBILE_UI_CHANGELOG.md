# Mobile UI changelog

What the mobile programme changed in Zoiko Billing, phase by phase. Measurements and decisions are in `docs/MOBILE_UI_AUDIT.md`.

## Phase 1 — Shell and layout
- Auth pages no longer scroll sideways on phones (were 146–170px too wide).
- Trial banner and top bar take 15% of a phone screen (was 38%).
- The AI assistant button lives in the top bar, so it never covers a page control.
- Form fields use 16px text on phones and touch screens (no zoom on focus).
- Navigation drawer: Esc / overlay / Back close it, the page behind doesn't scroll, nothing in it is focusable while closed.

## Phase 2 — Shared building blocks
- Dialogs keep Save / Create pinned at the bottom; confirm dialogs are full-width bottom sheets with 44px buttons on phones.
- Wide shared tables become cards on phones; page headers collapse extra actions into a "⋯" menu; long tab rows scroll in one line; wizards show "Step 1 of 7" with a progress bar.

## Phase 3 — Pages
- **Forms and wizards (B3):** Register, draft invoice, contract, quotation and subscription forms keep their main action pinned and reachable; settings pages have one pinned Save bar and warn before unsaved changes are lost.
- **Tables (B4):** every table with more than four columns becomes cards on phones, keeping selection, bulk actions and sorting.
- **Detail pages (B5):** customer profile edits get a pinned Save bar and an unsaved-changes prompt; line items and wide tab tables become cards; information rows stack.
- **Final check (B6):** settings badges, chart headers, tax filters and public invoice line items fit on phones. All 135 page/role checks: no sideways scrolling, nothing covered.

## Phase 4 — Polish
- **Tap targets:** controls under 44px on phones 863 → 381 (shared buttons, fields, breadcrumbs, card checkboxes, toolbar buttons).
- **Text size:** nothing under 12px on phones (1,026 → 0).
- **Consistency (all screen sizes):** one status label and colour map; one date format ("Oct 1, 2026", "Oct 1, 2026, 3:45 PM", "5 min ago"); one page loading spinner; one primary action per screen.
- **Fixes:** list search boxes get their own row on phones; dashboard insight lines wrap; breadcrumb links navigate; activity text shows "overdue" rather than "InvoiceStatus.OVERDUE"; date-only values no longer show the previous day in the Americas; missing dates show "—" rather than "1/1/1970"; pricing form labels linked to their fields; Terminate Contract forgets the typed reason when closed.

## Phase 5 — Verification
- `frontend/tests/mobile-responsive.spec.js` with iPhone 13, Pixel 7 and iPad (gen 7) projects plus desktop: overflow, primary action size, drawer, AI button overlap, dialog footer and axe (critical / serious) on 8 pages. Runs with fixtures only — no backend. Device projects use Chromium with each device's viewport, touch and user agent (layout, not Safari rendering).
- Accessibility fixes it found: one main landmark per page, contrast below 4.5:1 on five elements, a keyboard-focusable wizard step list.

## Not done (left for later)
- Measuring the super-admin privileged-session banner and triage strip with fake responses.
- An optional smoke test against a real local backend.
- Running the spec in real WebKit (Safari) — WebKit isn't installed on the build machine.
- Tap targets: 381 controls are still under 44px on phones (mostly page-specific small buttons and links).
- Pre-existing, reported: 7 local backend test failures in unrelated areas (email alert routing, Stripe SDK version pin, 3 super-admin tests).
