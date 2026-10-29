# Mobile UI Audit — Zoiko Billing frontend

**Branch:** `nikhil-new` (based on GitHub `main`, Oct 26) · **Scope:** `frontend/src`
**Phase 0:** code review, 2026-10-29 · **Phase 0.5:** browser measurement, 2026-10-29
**Viewports:** 360×800, 390×844, 412×915, 768×1024, 1280×800 · **Roles:** super_admin, org_admin, billing_admin, public

Status key used in every table:
- **Confirmed**: measured in the browser.
- **Not reproduced**: measured, and the problem did not occur.
- **Not reproducible locally**: the condition can't be produced with local data, so the severity still comes from the code.
- **Pending: production code**: depends on code that exists in production but not on this branch.

---

## 0. How this was measured

- **Stack:** backend on `:8001` against a throwaway SQLite file outside the repo (`D:/zoiko-local/`). SMTP pointed at a closed local port and Stripe keys replaced with inert values (see §9). Vite dev server on `:5173`.
- **Data:** 1 org (Northwind Traders Ltd, Business plan, trialing), 6 customers (UK/US/IN/DE, business, non-profit, individual), 5 products, 8 invoices (2 each of draft, sent, overdue, paid), 1 subscription plan + 1 subscription, 2 payments allocated to the paid invoices.
- **Sweep:** a Playwright script logged in as each role and loaded each route once. It then resized through the 5 viewports and measured, at each size:
  - horizontal page overflow (`scrollWidth − innerWidth`)
  - content cut off past the right edge outside any horizontal scroller
  - tables, and whether they scroll or squeeze
  - tap targets under 44px
  - form controls under 16px
  - text under 12px
  - screen height taken by the top bar and banners
  - AI-launcher overlap with other controls (at top and after scrolling to the bottom)
  - drawer behavior

  It saved screenshots at 390px and 1280px.
- **Coverage:** 135 route checks: org_admin 83 (all billing routes, including detail pages for seeded records, plus organization-admin), billing_admin 12 (workspace plus a billing sample), super_admin 34, public 6. Separate focused probes covered tables on data pages, the invoice sticky footer, the shared `Modal`, and the customer create form.
- **Not covered:** routes whose detail pages need records that weren't seeded (quotation, contract, credit-note, refund, write-off, dunning and collections case details). These rows keep their code-based status.

## 1. Measured headline numbers

| Measure (360×800 unless noted) | Result |
|---|---|
| Pages that scroll sideways | **6 / 135**, all auth pages: `/login` +170px, the other 5 +146px |
| Pages with content cut off at the right edge (not inside a scroller) | **22 pages**, mostly page-header action buttons pushed past the edge (§4) |
| Overflow at 768 and 1280 | **0**: tablet and desktop are clean |
| Tables that scroll inside their own box | **All billing tables with data** (8–13 columns, 431–1,124px wide) |
| Tables squeezed or clipped | **1**: Super-admin Organizations (name column ≈ 36px) |
| Pages where the AI launcher covers a control | **19 pages** (§4), including the draft invoice footer's "Recalculate" |
| Banner + top-bar share of the screen | **org/billing admin: 38% at 360, 34% at 390** (trial banner). Super admin: 8% (no privileged session or incidents locally) |
| Tap targets under 44px | **52% on average** per page |
| Form controls under 16px (iPhone zoom) | **100%**: every form control on all 123 pages that have inputs |
| Text under 12px | median **2** elements per page (lower than the code count suggested) |
| Drawer | Closes on overlay tap ✓ and on browser back ✓. **Esc does not close it ✗; no scroll lock ✗; links stay keyboard-focusable while closed ✗** |
| Shared `Modal` (New Organization, 390) | **Create/Cancel are below the screen edge** (top at 877px of 844); close button 30px |
| Customer create form (360/412) | One column ✓. **Create button 1,662px down a 1,690px scroll, not sticky**; inputs 14px; close 28×28 |

### Corrections to the Phase 0 code audit

- **R1/R2 (tables) go down from P0 to P1.** `DataTable` does ignore `minWidth`, and about 70 files use raw `<table>`. But every table measured with real rows is already inside a horizontal scroll container and keeps readable columns (≥ 40px). The real problem is the experience: an 11–13-column table you swipe sideways through on a phone, with 85–130px-tall rows. Applying `minWidth` (Phase 1) and adding card mode (Phase 2) still stand, as experience fixes rather than breakage fixes.
- **Small text** is much rarer in rendered pages than the class count suggested: median 2 elements per page. It stays P2.
- **Page-header action rows** are a bigger problem than the code audit suggested: 22 pages push a primary button such as "New Customer", "Add Product" or "Save Changes" past the right edge at 360px.

---

## 2. Root causes (updated)

| # | Root cause | Status | Sev |
|---|---|---|---|
| R1 | `DataTable` ignores `minWidth`; no mobile card layout | **Confirmed (code); measured effect is a wide horizontal swipe, not squeezing** | P1 |
| R2 | ~70 files with raw `<table>` (~100 tables) | **Confirmed**; all measured ones scroll inside a wrapper. Super-admin Organizations name column squeezed | P1 |
| R3 | ~40 hand-rolled dialogs | **Confirmed** on the customer form (actions 1,662px down, no side gutter) | P1 |
| R4 | `LandingHeader` right cluster ≈ 540px | **Confirmed**: +146–170px sideways scroll on all 6 auth pages | **P0** |
| R5 | AI launcher covers actions | **Confirmed**: 19 pages, including the draft invoice sticky footer ("Recalculate") and the "Next" button on invoice and quotation create | **P0** |
| R6 | 14px form controls → iPhone zoom on focus | **Confirmed**: every control measured | P1 |
| R7 | Banners eat the screen | **Confirmed**: trial banner 38% at 360 / 34% at 390. Privileged banner and triage strip: **not reproducible locally** | P1 |
| R8 | `h-screen`, no `viewport-fit=cover` | **Confirmed (code)**; iOS toolbar effect not measurable in desktop Chromium emulation | P1 |
| R9 | Primitives not mobile-shaped | **Confirmed**: header action rows clip on 22 pages; `Modal` actions below the screen edge; `HubTabs` wrap | P1 |
| R10 | Small tap targets / small text | **Confirmed**: 52% of targets under 44px. Text under 12px is rare | P2 |
| R11 *(new)* | Page header / `DashboardHeader` action rows are `flex` without wrapping or an overflow menu | **Confirmed**: 22 pages clip a header button at 360 | **P1** |

---

## 3. Shell and global layout (Phase 1)

| ID | Where | Issue | Sev | Status | Fix |
|---|---|---|---|---|---|
| S1 | `index.html` | No `viewport-fit=cover`; safe-area insets inert | P2 | Confirmed (code) | Add `viewport-fit=cover`. |
| S2 | `BillingShell.jsx:812,823` | `h-screen` on root and content row | P1 | Confirmed (code); iOS effect not measurable in emulation | `h-dvh` with `h-screen` fallback. |
| S3 | `BillingShell.jsx:879` | Launcher covers controls | **P0** | **Confirmed**, 19 pages (§4) | Smaller on mobile, lifted above sticky footers, safe-area offset. |
| S4 | `BillingShell.jsx` drawer | Esc doesn't close; links focusable when closed; active item not scrolled into view | P1 | **Confirmed** (Esc ✗, focusable ✗). Closes on back/route change ✓, so that part is **not reproduced** | `inert` when closed, Esc handler, `scrollIntoView` on open. |
| S5 | Drawer | No scroll lock while open | P2 | **Confirmed** | Lock `main` and `body` while open below `lg`. |
| S6 | Drawer close / nav items | 36px targets | P2 | Confirmed | 44px. |
| S7 | `TopBar.jsx` | Icons 36px; menu button 40px; no top safe area | P2 | Confirmed | 44px targets; safe-area padding. |
| S8 | `PrivilegedSessionBanner.jsx` | `sticky top-0`, wraps to 2 rows | P1 | **Not reproducible locally** (no privileged session) | Compact single line on mobile; keep pinned only as a single line (security-critical). |
| S9 | `TriageStrip.jsx` | Wraps to 2 rows | P1 | **Not reproducible locally** (no open incidents) | One-line summary below `sm`. |
| S10 | `TrialBanner.jsx` | 225px card under a 65px top bar = **38% of 360×800** | P1 | **Confirmed** on every org_admin / billing_admin route | Compact one-line version below `sm` with a collapse that persists for the session. |
| S11 | `CommandCenterContextBar.jsx` | `text-xs` selects, 26px targets | P1 | Confirmed (command-center routes) | Scrollable chip row, 16px selects, 44px targets. |
| S12 | `AssistantPanel.jsx` | Same z-index as TopBar; no safe area; no scroll lock | P2 | Not measured (panel not opened by the sweep) | z-[60], `h-dvh`, safe areas. |
| S13 | Shell gutter + card `p-6`/`p-8` | ≈280–296px usable at 360 | P1 | **Confirmed** (customer form 296px content width) | `p-4 sm:p-6` in primitives. |
| S14 | `index.css` | No 16px rule for form controls | P1 | **Confirmed** (all controls 14px) | `@media (max-width: 767px) { input, select, textarea { font-size: 16px } }`. |

## 4. Shared primitives (Phase 2)

| ID | Component | Issue | Sev | Status |
|---|---|---|---|---|
| P1 | `DataTable` | `minWidth` ignored; no card mode; nested `max-h-[560px]` scroll | P1 | **Confirmed**; scrolls rather than squeezes in practice |
| P2 | `PageHeader` | Action row doesn't wrap / no overflow menu | P1 | **Confirmed**: "New Customer" clipped at 378px, "Add Product" 412px, "New Quotation" 419px, "Save Changes" 417px (billing settings) |
| P3 | `DashboardHeader` (`billing-shared.jsx`) | Same, plus the time-range button row | P1 | **Confirmed**: "Monthly view" (products dashboard), "Refresh" clipped at 369px on 6 report pages |
| P4 | `HubTabs` + 7 hand-rolled tab lists | Wrap into several rows; 36px tabs | P1 | **Confirmed**: super-admin commercial invoices "Payments" tab clipped at 371px |
| P5 | `StickyFooter` | Launcher overlap; primary action left-aligned; no safe area | **P0** | **Confirmed**: draft invoice at 390, "Recalculate" under the launcher, "Finalize" pushed left |
| P6 | `Modal` | Footer actions scroll off; 30px close; `92vh` | P1 | **Confirmed**: New Organization at 390, Create/Cancel at 877px of 844 |
| P7 | `FormModal` | Actions inside the scrolling body | P1 | Confirmed (code); same pattern as P6 |
| P8 | `ConfirmDialog` ×3 | No side gutter; 36px buttons | P1 | Confirmed (code); not opened by the sweep |
| P9 | `SectionCard`, stat/chart cards | `p-6` + `rounded-3xl` | P2 | Confirmed |
| P10 | `ListToolbar` / list filter rows | Search squeezed ("Search by n"); "Filters" button clipped | P1 | **Confirmed**: `/billing/invoice-schedules`, `/billing/credits` ("Filters" at 386px); super-admin Organizations |
| P11 | `SearchInput` | 20px clear button | P2 | Confirmed (code) |
| P12 | `StatGroup` / KPI cards | Long values | P2 | **Not reproduced**: values like "$17,764.00" fit at 360 |
| P13 | `Stepper` | Long label row | P2 | Confirmed (invoice/quotation create) |
| P14 | `Field` / `Select` | 14px | P1 | **Confirmed**: covered by S14 |
| P15 | `Button` | `sm` ≈ 28px, `md` ≈ 40px | P2 | Confirmed |
| P16 | `DashboardDateRangeFilter` | Popover may clip left; `text-xs` date inputs | P2 | Not measured (popover not opened) |
| P17 | `BulkProductPickerModal` | Hand-rolled dialog | P1 | Not measured |
| P18 | Detail-page toasts | `max-w-sm` clips at 360; launcher collision | P1 | Not reproducible (toasts need a write action) |
| P19 *(new)* | Dashboard "insight" lines | Long single-line sentences clipped | P2 | **Confirmed**: products dashboard (441px), collections dashboard, credit-notes dashboard |

## 5. Page findings

Every route below was measured at all 5 viewports. **No route overflows at 768 or 1280.** "Clean" means no clipping, sideways scrolling, launcher overlap or crushed table was measured. The shared problems from §3–§4 (14px inputs, about 50% small targets, trial banner 38%) apply to every authenticated page and aren't repeated per row.

### 5.1 Billing: org_admin (billing_admin samples matched)

| Route(s) | Status | Measured issue(s) | Sev | Fix |
|---|---|---|---|---|
| `/billing` dashboard | Confirmed (shared only) | KPI grid and charts fit; header actions wrap but are not clipped | P2 | P3 |
| `/billing/customers` | **Confirmed** | "New Customer" clipped at 378px; 13-column table scrolls sideways (880px), rows 85px tall | P1 | P2 header; P1 cards |
| `/billing/customers/:id` | Not reproduced (top of page) | No overflow or clipping measured; 7 raw tables lower on the page, outside the probe | P2 | Phase 3 |
| Customer create / edit dialog (`customer-list.jsx:474,551`) | **Confirmed** | Edge-to-edge panel with `p-8`; Create button 1,662px down, not sticky; close 28×28; 14px inputs; mixed `*` styles | P1 | Phase 2 form pattern, Phase 3 reference screen |
| `/billing/customers/{dashboard, billing-history, profitability, settings}` | Clean | billing-history 6-column table scrolls (651px) | P2 | — |
| `/billing/customers/reports` | **Confirmed** | "Refresh" clipped at 369px | P1 | P3 |
| `/billing/invoices` | **Confirmed** | 11-column `DataTable` scrolls (1,066px); launcher covers the first rows of the "Recently created" list | P1 | S3, P1 |
| `/billing/invoices/:id` | **Confirmed** | Draft: "Recalculate" under the launcher, primary "Finalize" left-aligned. Sent: no overlap. Line-item table scrolls (500px) | **P0** | S3 + P5 |
| `/billing/invoices/create` | **Confirmed** | Launcher covers "Next" | **P0** | S3 |
| `/billing/invoices/{dashboard, settings}`, `/billing/invoice-schedules` | invoice-schedules **confirmed**; others clean | "Filters" clipped at 386px | P1 | P10 |
| `/billing/credit-notes` | **Confirmed** | Launcher covers "Refresh" | P1 | S3 |
| `/billing/credit-notes/dashboard` | **Confirmed** | Insight line clipped | P2 | P19 |
| `/billing/credits` | **Confirmed** | "Filters" clipped at 386px | P1 | P10 |
| `/billing/payments` | **Confirmed** | 8-column table scrolls (731px); launcher covers the "Cleared" chip | P1 | S3, P1 |
| `/billing/payments/:id` | Clean | — | — | — |
| `/billing/{refunds, write-offs, dunning, promise-to-pay}` (+ dashboards) | Clean (empty data) | Empty-state `DataTable`s; card mode still needed once there is data | P2 | P1 |
| `/billing/collections-receivables` | Clean | 5-column `DataTable` scrolls (431px); rows 221px tall | P2 | P1 cards |
| `/billing/collections/dashboard` | **Confirmed** | Insight line clipped | P2 | P19 |
| `/billing/subscriptions` | **Confirmed** | 10-column table scrolls (950px); launcher covers the "Active" chip | P1 | S3, P1 |
| `/billing/subscriptions/:id` | Clean | — | — | — |
| `/billing/subscriptions/create` | **Confirmed** | Launcher covers the "Direct creation" option card | P1 | S3 |
| `/billing/subscriptions/reports` | **Confirmed** | "Refresh" clipped | P1 | P3 |
| `/billing/subscriptions/{dashboard, plans, settings}` | Clean | — | — | — |
| `/billing/quotations` | **Confirmed** | "New Quotation" clipped at 419px; launcher covers the "Sent" chip | P1 | P2, S3 |
| `/billing/quotations/create` | **Confirmed** | Launcher covers "Next" | **P0** | S3 |
| `/billing/quotations/reports` | **Confirmed** | "Refresh" clipped | P1 | P3 |
| `/billing/quotations/settings` | Not reproduced on retry | The page crashed once during the first sweep run, then loaded normally | P2 (watch) | Re-check in Phase 5 |
| `/billing/contracts` | **Confirmed** | Launcher covers the "Active contracts" chip | P1 | S3 |
| `/billing/contracts/create` | **Confirmed** | Launcher covers "Search accepted quotations" | P1 | S3 |
| `/billing/contracts/reports` | **Confirmed** | "Refresh" clipped | P1 | P3 |
| `/billing/contracts/{dashboard, settings}`, `/billing/retainers` | Clean | — | — | — |
| Quotation / contract / credit-note / refund / write-off / dunning / collections case **detail** pages | Not measured (no seeded records) | Code findings stand: hand-rolled dialogs, toasts | P1 | Phase 3 |
| `/billing/products` | **Confirmed** | "Add Product" clipped at 412px; 10-column table scrolls (1,000px), rows 129px | P1 | P2, P1 |
| `/billing/products/:id` | Clean (top of page) | 5 raw tables lower on the page | P2 | Phase 3 |
| `/billing/products/dashboard` | **Confirmed** | Insight line clipped (441px); "Monthly view" clipped | P1 | P3, P19 |
| `/billing/products/pricing-plans` | **Confirmed** | "Annual – Save 20%" toggle clipped at 393px | P1 | Page |
| `/billing/products/reports` | **Confirmed** | "Refresh" clipped | P1 | P3 |
| `/billing/products/{categories, settings}`, `/billing/usage-billing` | Clean | — | — | — |
| `/billing/pricing/*` (8 routes) | Clean except reports | `/billing/pricing/reports`: launcher covers the "Product pricing" tab | P1 | S3 |
| `/billing/tax` | **Confirmed** | 9-column table scrolls (821px); launcher covers the "Sales tax" chip | P1 | S3, P1 |
| `/billing/tax/configuration` | **Confirmed** | Launcher covers "Save Changes" | **P0** | S3 |
| `/billing/tax/reports` | **Confirmed** | "Refresh" clipped | P1 | P3 |
| `/billing/tax/{dashboard, settings}` | Clean | — | — | — |
| `/billing/settings` | **Confirmed** | "Save Changes" clipped at 417px; "Auto-configured" badge clipped | P1 | Page |
| `/billing/reports`, `/billing/reports/forecast`, `/billing/invoicing/reports` | Clean | — | — | — |

### 5.2 Billing-admin workspace

| Route | Status | Measured issue(s) | Sev |
|---|---|---|---|
| `/billing/workspace/dashboard` | **Confirmed** | Activity line clipped at 529px; it also shows the raw enum `InvoiceStatus.OVERDUE` (new formatting bug) | P1 |
| `/billing/workspace/help` | **Confirmed** | Launcher covers the "Billing dashboard" and "Billing settings" link cards | P1 |
| `/billing/workspace/{organization, subscription, zoiko-subscription, usage, activity, notifications}` | Clean (shared issues only) | Trial banner 38% | P1 |

### 5.3 Organization admin

| Route | Status | Measured issue(s) | Sev |
|---|---|---|---|
| `/organization-admin/dashboard` | **Confirmed** | Launcher covers the "Outstanding amount" card; one decorative block measured past the edge (404px, hero background, not visible content) | P1 |
| `/organization-admin/organization` | Measured | A block extends to 504px; looks like the decorative hero (not visible content). **Verify in Phase 3** | P2 |
| `/organization-admin/users` | Clean | 5-column table scrolls (640px) | P2 |
| `/organization-admin/{notifications, privileged-access-log}` | Clean | — | — |

### 5.4 Super admin

| Route | Status | Measured issue(s) | Sev |
|---|---|---|---|
| `/super-admin/organizations` | **Confirmed** | Name column squeezed to ≈36px ("Nort / hw…"); search squeezed to "Search by n"; launcher next to "Clear filters" | P1 |
| `/super-admin/users` | **Confirmed** | Launcher covers "Clear filters"; table fits by hiding columns | P1 |
| `/super-admin/commercial/overrides` | **Confirmed** | Launcher covers search and "Clear filters" | P1 |
| `/super-admin/commercial/invoices` | **Confirmed** | "Payments" tab clipped at 371px | P1 |
| `/super-admin/governance/configuration` | **Confirmed** | Long config keys (`circuit_breaker.auto_expire_bounds_minut…`) clipped | P2 |
| `/super-admin/{dashboard, command-center}` | Not reproduced | Clipped elements are decorative hero backgrounds; the content fits | — |
| `/super-admin/commercial/{plans, subscriptions}`, `/organizations/1`, `/audit-logs` | Clean | Tables scroll (509–1,124px) | P2 |
| `/super-admin/kill-switch`, `/support-access` | Clean | `MobileWriteBlock` shows as intended below 768; **keep as is** | — |
| All other super-admin routes (22) | Clean | — | — |
| `/super-admin/tenant-health/jobs` | Redirects to `/super-admin/tenant-health` (legacy redirect, expected) | — | — |

### 5.5 Auth and public

| Route | Status | Measured issue | Sev |
|---|---|---|---|
| `/login` | **Confirmed** | +170px sideways scroll; "Book a Demo" and "Create Account" past the edge | **P0** |
| `/register`, `/forgot-password`, `/auth/reset-password`, `/auth/accept-invite`, `/register/success`* | **Confirmed** | +146px sideways scroll (`LandingHeader`); `/register` has 12 inputs, all 14px | **P0** |
| Public invoice / quote / estimate / platform checkout | Not measured (need public tokens) | Code findings stand | P1 |

\* `/register/success` redirects to `/register` without registration state (expected).

---

## 6. Team feedback → fix mapping

Reported on the production customer create/edit form, Android, about 412px.

| # | Team report | Status on this branch | Root cause → fix | Phase |
|---|---|---|---|---|
| T1 | **P0** Form stays two-column on mobile; "United Kingdom" truncates to "United King"; phone placeholder clipped; "Primary contact (optional)" wraps and misaligns its row | **Not reproduced on this branch**: the branch's customer form is already one column at 360/412 (`grid-cols-1 md:grid-cols-2`). The production form ("Billing contact" / "Billing defaults") is different code. **Pending: production code** for the exact screen | General rule fixed in shared form layout: one column below `sm`, labels that never force row misalignment (`items-start`, label `min-h`), 16px controls | 2 (shared) + after merge |
| T2 | **P0** Bottom navigation overflows; "Receivables" and "Customers" labels collide | **Pending: production code** (no bottom navigation on this branch) | — | After merge |
| T3 | **P0** Bottom navigation covers the end of page content | **Pending: production code** | — | After merge |
| T4 | **P1** Long forms have no visible save action or page context while scrolling | **Confirmed**: customer create dialog Create button 1,662px down; shared `Modal` actions below the screen edge | Mobile form-page pattern: sticky top bar (back, title, step) + sticky action footer with safe area; `Modal`/`FormModal` sticky footer | 2 |
| T5 | **P1** Card headers waste width (icon chip + title + badge, indented description, heavy padding) | **Confirmed in shape**: `SectionCard` and `PageHeader` indent the description under the icon and use `p-6`/`p-8` | Mobile card header: smaller icon, description full width under the header row, `p-4` | 2 |
| T6 | **P1** "Coming soon" pill under a disabled field looks like a button; disabled select looks filled | **Not reproduced on this branch** (no "Coming soon" fields exist here) | `Field` gets an optional `comingSoon` tag next to the label; a shared disabled style for inputs and selects (muted background, dashed border, `cursor-not-allowed`) that the production form can adopt | 2 |
| T7 | **P2** Mixed required/optional markers | **Confirmed in part**: the branch mixes a red `<span>*</span>` with a plain-text " *" on the same form; no "(optional)" here | `Field required` renders the single `*` style; one "* Required" note per form; no "(optional)" | 2 |

## 7. Pending: production code

These depend on production code that is not on `nikhil-new`. They will be picked up after the production branch is merged.
- T2, T3: mobile bottom navigation (label collision; covering page content), plus the bottom-nav parts of Phase 1 (safe-area padding under the nav, launcher clearance above it, content padding).
- T1 exact screen: the new customer form ("Billing contact" / "Billing defaults"). The shared fixes from Phase 2 will apply once it uses the shared form primitives.
- T6 exact screen: the "Coming soon" field on that form.

## 8. Follow-ups (not in scope to change)

- **Correction (Phase 2): on `nikhil-new`, `vite.config.js` already proxies `/api` to `http://localhost:8001`**, the same port as the backend. The `:8002` target was in the separate, non-git copy of the frontend read during the Phase 0 code audit. There is no stale proxy on this branch. (Locally the proxy is unused either way, because `frontend/.env` sets `VITE_API_BASE_URL=http://localhost:8001`.) Remove this item from the changelog follow-ups.
- New formatting bug: a raw enum value (`InvoiceStatus.OVERDUE`) is shown in the workspace dashboard activity feed. **Scheduled for Phase 4** (shared status label formatting).
- **`/billing/quotations/settings` crash: not reproduced, not an app bug as far as can be measured.** 10 targeted attempts (5 fresh logins, 5 after the same preceding routes, each cycling all 5 viewports) loaded cleanly with **0 page errors and no crash**. The one crash in the first sweep happened while Vitest, Vite, the backend and Chromium were all running on an 8GB machine with about 2GB free. During the same session my own Node test process died with `FATAL ERROR: Zone Allocation failed - process out of memory` (heap only about 48MB, so system memory, not a JS leak), and two Vitest workers exited unexpectedly. **Best guess: Chromium's renderer was killed under machine memory pressure.** No console error or stack trace exists for it, because the renderer died rather than throwing. Not fixed (out of mobile scope).
- **Fonts failing to load — resolved; it was a local environment problem, not a code bug, and production was not affected.** In the local runs, Inter and JetBrains Mono failed on every route and pages fell back to the system font. Root cause: `@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono` are declared in `package.json` and pinned in `package-lock.json` (5.3.0), but **were not installed in this machine's `node_modules`**. `src/fonts.css` uses `url("@fontsource-variable/…/*.woff2")`; Vite resolves that as a package import when the package exists. When it's missing, Vite silently leaves the specifier as-is, so the browser requested route-relative URLs and got `index.html` (`OTS parsing error: invalid sfntVersion`). After installing the locked versions locally (`npm install --no-save`, no change to `package.json` or the lockfile):
  - `npm run build` emits hashed `/assets/*.woff2` with absolute URLs (route-independent).
  - `npm run preview` loads both faces (200, `font/woff2`).
  - The restarted dev server loads both faces on nested routes with 0 font warnings.
  - Production builds via `npm ci` in the Dockerfile, which installs these packages, so production was fine.
  - **No change to `src/fonts.css` was needed.** Possible hardening for the team (not done): import the fontsource CSS from JS so a missing package fails the build instead of degrading silently.
  - **All Phase 0.5 and Phase 1 screenshots/measurements were taken with fallback fonts.** The 5 key Phase 1 "after" screenshots were retaken with correct fonts (`shots/phase1/after-fonts/`); their metrics are unchanged (login 0 overflow at 360/390; banner 14% at 390; AI button covers nothing at 390/1280; drawer checks pass). The desktop trial card measures 26% instead of 24% of 1280×800 because Inter is slightly taller. A full sweep with correct fonts is in `shots/phase2/sweep-2026-10-29-before-fonts/`.
- **"Book a Demo" does nothing (team follow-up, not fixed here).** The "Book a Demo" button in `src/landing/LandingHeader.jsx` has no click handler or link, at every width including desktop. Phase 1 hides it below `sm` to make the auth header fit; on desktop it is still shown and still does nothing. Needs a product decision on where it should go (demo form, calendar link, sales email).
- **Screenshot history:** the Phase 0.5 sweep screenshots were overwritten by the first Phase 1 sweep (both wrote to `D:\zoiko-local\audit\shots\`). The Phase 0.5 numbers in this document are unaffected (they come from the saved results). From Phase 2 on, every run writes to its own folder (`phaseN\before\`, `phaseN\after\`, `phaseN\sweep-<date>-<label>\`), and the capture scripts refuse to write into a non-empty folder.
- **Back doesn't close dialogs (follow-up, needs a router change, out of scope).** Esc and the dialog's own Back/✕/Cancel close dialogs; the browser Back button doesn't. Doing it safely means pushing a history entry per open dialog, which interacts with save-then-navigate flows and needs router-level support.
- **The unsaved-changes guard can't catch the browser Back button (follow-up, needs a router change, out of scope).** The app uses `<BrowserRouter>` rather than a data router, so React Router's navigation blocking (`useBlocker`) isn't available. `useUnsavedChangesGuard` covers reload, tab close and in-app link clicks; Back needs the data router.
- **Local-environment limitation (not a UI bug):** some dashboard and report queries use PostgreSQL's `date_trunc`, which SQLite lacks (40 errors in the local backend log), so a few charts are empty in the local audit. Production on Postgres is unaffected.

## 8a. Phase 1 results (re-measured, all 135 route checks)

| Target | Before | After Phase 1 |
|---|---|---|
| Auth pages scrolling sideways at 360 | 6 / 6 (+146–170px) | **0 / 6** (also 0 at 390 / 412) |
| Trial banner + top bar, share of 360×800 | 38% | **15%** (banner alone ≈ 7%); desktop card unchanged |
| AI button over a control, the 19 listed pages (360/390/412, scrolled top / mid / bottom) | 19 pages | **0**. Below `lg` the button lives in the top bar |
| AI button over the draft-invoice action bar at 1280 | "Recalculate" covered | **None**: the button lifts above `StickyFooter` via `--sticky-footer-h` |
| Form controls under 16px (phones) | all, on 123 pages | **0** |
| Header and toolbar buttons clipped at 360 | 22 pages | **0** header/toolbar clips. Remaining clipped content is P19 insight lines, the P4 tab row, decorative hero backgrounds and long config keys (Phase 2+) |
| Drawer: Esc / scroll lock / links focusable while closed | ✗ / ✗ / 23 links | **✓ / ✓ / 0** (overlay tap and browser back still close it) |
| Overflow at 768 / 1280 | 0 / 0 | 0 / 0 |

**Desktop AI button (decided: top bar at every width; commit `86273a4`, revertible on its own):** at 1280 the floating button covered a control on 6 of the 19 pages ("Record Payment" at first paint, "Sort by Status", "Continue", help-page links, row "View" links). After moving it into the top bar: 21 checks (top/mid/bottom) on those pages at 1280, **0 covered controls**.

**Phase 1 follow-up (review notes):**
- *16px inputs, phones and touch only (per decisions log):* the rule is `@media (max-width: 639.98px), (pointer: coarse)`. Verified on the customer create form: **16px** on phones (360/412) and touch tablets (768/1024); **14px** on a 700px mouse window and at 1280 (desktop unchanged). Auth pages inputs (inline styles) are 16px at 360. Checkboxes are excluded on purpose.
- *Trial banner keeps its information:* below `sm` it is one strip with a short title ("Free trial" / "Trial ended"), the **days-left badge** and **Upgrade** always visible, and a **"Show trial details"** toggle that reveals the end date and the Free-trial note in place. Still dismissible for the session. Measured with a 14-days-left trial: 57px, **15% of 360×800 including the top bar** (14% at 390); expanded 197px, no sideways scroll.
- *AI button on mobile:* rather than a smaller floating button offset above footers (and hidden on create/edit pages and when a modal is open), it moved into the top bar below `lg`. It therefore can't cover a footer, primary action, toast or form at any scroll position, and stays available everywhere. Desktop is unchanged apart from lifting above `StickyFooter` (see the open decision above).

**Super-admin privileged banner and support-access strip:** made single-line on mobile in code (Phase 1). They are measured with fake API responses in Phase 5, as agreed.

## 8b. Phase 2 results (shared primitives and form pattern)

Measured with real fonts: before = commit `559d02d` served from a separate worktree; after = Phase 2 working tree. Full 135-route sweeps (before: `shots/phase2/sweep-2026-10-29-baseline-559d02d-run2/`, after: `shots/phase2/sweep-2026-10-29-after/`); targeted screens in `shots/phase2/before/` and `shots/phase2/after-final/`.

| Check (390px unless noted) | Before | After |
|---|---|---|
| Customer form: Create button | 1,709px down (off-screen); also off-screen at 1280 (986px) | **Pinned at the bottom, visible at 390 and 1280** (sticky `DialogActions`, flush to the panel edge) |
| `FormModal` (New Refund) | Actions in the scrolling body | **Actions in the pinned footer** |
| `ConfirmDialog` | Centred card touching the screen edges, 36px buttons | **Edge-to-edge bottom sheet, 44px full-width buttons** |
| Wide `DataTable` (invoices, 11 columns) | Sideways-scrolling table | **9 cards, no overflow**; desktop table unchanged |
| Squeezed tables (sweep) | 1 (super-admin Organizations) | **0** |
| Page header actions | Wrapped buttons, no menu | **Primary + "⋯" menu** (Refresh, Export CSV/JSON) on phones; inline on desktop |
| `HubTabs` (Plans hub) | **7 rows** | **1 row, scrolls sideways**; desktop unchanged (2 rows at 1280, as before) |
| Wizard stepper (invoice create) | 7 labelled steps scrolling sideways | **"Customer · Step 1 of 7"** with a progress bar |
| Page overflow at 360 (sweep) | 0 | 0 |

**The 10 remaining clips from the real-font baseline:**
- **Resolved (2):** super-admin invoices "Payments" tab (the Plane1 tab row now scrolls); long configuration keys (`break-all`).
- **Left as planned:**
  - decorative hero backgrounds (4 pages: org-admin dashboard/organization, super-admin dashboard/command-center)
  - insight lines for Phase 4 (products, credit-notes and collections dashboards; the workspace activity line, which is also the `InvoiceStatus.OVERDUE` bug)
  - the "Auto-configured" badge on billing settings (page-level, Phase 3)
- **Regression found and fixed before commit:** card mode clipped the super-admin entitlement key column (a cell render built for wide table cells). Fixed in the shared card cell (`[&_*]:min-w-0`). A re-check of all 22 card-mode pages at 360/390 found 0 clipped elements.
- The collections-dashboard insight line clips in some runs and not others (data-dependent width). It's grouped with the Phase 4 insight lines.

**Not yet met: "Save/Create always visible" for every dialog.** It is met for the customer form, every `FormModal`, and both confirm dialogs. Pages that use `Modal` but put their buttons inside the dialog body instead of the `footer` prop still scroll their actions away. Example: super-admin New Organization, Create at 816–856px on an 844px screen. Moving those buttons to `footer` is a page migration, scheduled for Phase 3.

**Desktop differences (all deliberate):**
- **`FormModal`:** Cancel/Save moved from the bottom of the form body into the dialog's footer bar (light grey bar, top border). It's always visible instead of scrolling with the fields.
- **Customer create/edit dialogs:** the actions row is pinned at the bottom of the panel. At 1280, Create is visible without scrolling (was 986px down).
- **Phase 2 also changed the desktop AI launcher** (separate commit `86273a4`, see §8a).
- **No other desktop change measured:** `PageHeader`, `DashboardHeader`, `HubTabs`, `SectionCard`, `DataTable`, `Stepper`, `ConfirmDialog` and `Modal` keep their desktop classes.

**Corrected during Phase 2:**
- Inside `<main>` (which has `pt-[65px]`), Chrome resolves `sticky top-0` below the scroll container's padding, so it already sits right under the fixed top bar (measured: `top-0` → 65px, `top-[65px]` → 130px). The privileged-session banner's original `sticky top-0` is therefore correct and was left unchanged.
- The same rule means a sticky bar inside a padded scroll panel needs a negative offset equal to the padding to sit flush; `DialogActions` does this.

**Limits of the new pattern:**
- **Unsaved-changes guard:** the app uses `<BrowserRouter>` (not a data router), so React Router's `useBlocker` isn't available. `useUnsavedChangesGuard` covers reload, tab close and in-app link clicks; the browser Back button isn't intercepted.
- **Dialogs and Back:** Esc closes dialogs; the browser Back button doesn't. Doing that safely needs history entries that interact with save-then-navigate flows.
- **`FormPageBar` / `FormActionBar`** (sticky mobile top bar with back, title and step; sticky Cancel/primary footer) are built and tested but not yet used by any page. They are applied to create/edit pages in Phase 3.

## 8c. Phase 3 Step A — customer create/edit form (reference screen)

The customer create and edit dialogs (`customers/customer-form-dialog.jsx`, used by `customer-list.jsx`) are rebuilt on the shared form pattern. Validation, API calls, field names and handlers are unchanged; the billing-country handlers were moved out of the JSX verbatim.

| Acceptance criterion | Result |
|---|---|
| Sticky top bar on phones: back, title, "Section X of Y" | **Met.** Back (44×44), "New Customer" / "Edit Customer", "Section 1 of 5" chip that follows the scroll position (create 5 sections, edit 4) |
| Cancel + Save pinned, safe area, visible at every scroll position | **Met.** Visible and on top at top/middle/bottom at 360 and 412 for create and edit (Save 44px tall), and at 1280 |
| One column below `sm`, two from `sm` up | **Met.** Every form grid has 1 column at 360/412; 2 at 1280 (billing terms 4 at `lg`, as before) |
| `*` + one "* Required" note, no "(optional)" | **Met.** One note per form; 0 "(optional)" labels |
| Mobile card headers (smaller icon, full-width description, `p-4`) | **Met** via `SectionCard` (Phase 2) |
| Disabled fields / "Coming soon" | **Not applicable:** this form has no disabled or coming-soon fields. The shared styles are in place for forms that do |
| Unsaved-changes guard only when values differ from the loaded ones, never after save | **Met.** Unchanged form closes at once; an edit asks "Discard changes?" (prompt stacks above the dialog); "Keep editing" keeps input; editing a field back to its loaded value counts as unchanged; after a successful save the dialog closes without a prompt (it unmounts). Reload/in-app links are guarded too. Browser Back is not (router limitation, §8) |
| AI button doesn't crowd the top bar | **Met.** On phones the form is a full-screen sheet above the app top bar; the AI button is covered while the form is open |
| No horizontal scroll | **Met.** 0 at 360/412/1280 |

**Supporting changes (shared, optional/non-breaking):**
- `Modal`: optional `size="3xl"` (full-screen on phones), `headerAside`, `mobileBack`, `bodyRef`.
- `useActiveSection` hook; `FormGrid cols={4}`.
- Both confirm dialogs stack above `Modal` (`z-[110]`), so a prompt raised from inside a dialog is never hidden under it.

**Desktop differences (1280):**
- **Fields grouped into five section cards** (Basic details, Billing terms, Addresses, Tax identifiers, Notes) with icon headers.
- **Labels use the shared `Field` style** (small uppercase) instead of sentence-case labels.
- **Same width as before** (`max-w-3xl`); Cancel/Save sit in the dialog's footer bar.
- **The form is taller** (scrollable height 826px vs 294px before, because of the section headers). Save stays visible throughout.
- **New behavior on desktop too:** Esc closes the dialog (asking first if edited), focus stays inside the dialog (focus trap) and returns to the opening button afterwards.
- **No backdrop-click close** (unchanged).

**Test changes (intentional):**
- `customer-list.test.jsx` and `customer-list.create.bug13.test.jsx` locate the dialog with `getByRole("dialog", { name: /^New Customer$/i })` instead of walking up from the heading (the old path depended on the dialog's inner markup).
- The "Require Billing Address" test now checks that the label carries `*` and the textarea has `aria-required`, because the shared `Field` renders the asterisk in its own element.
- New `customer-form-dialog.stepA.test.jsx` (4 tests) covers the guard and the pattern.

Screenshots: `shots/phase3/stepA/before/` and `shots/phase3/stepA/after/` (`create-form__{360,412}__{top,middle,bottom}.png`, `create-form__1280__top.png`, the same for `edit-form`, plus `create-form__360__discard-prompt.png`). A first capture before a header-alignment fix is kept in `after-draft1/`.

### Dialogs with the primary action inside the content (Phase 3 Step B, first item)

Generated by scanning `frontend/src` (scanner kept outside the repo). **76 dialogs**: 15 use the shared `Modal` but put their buttons in the body instead of the `footer` prop; 61 are hand-rolled overlays (`fixed inset-0 …`), which never have the shared pinned footer. Excluded: the three shared confirm sheets (`ConfirmDialog`, the `useConfirmationDialog` sheet and the assistant's confirm, which are short bottom sheets whose buttons are always visible), the super-admin command palette (search overlay, no primary action) and the AI assistant panel's backdrop. Already migrated: customer create/edit (Step A).

**A. Shared `Modal` without a `footer` (15)** — fix: move the action buttons into `footer` (small, mechanical).

| Location | Dialog | Buttons detected |
|---|---|---|
| `modules/super-admin/EvaluationProgramsPage.jsx:341` | Create evaluation program | Cancel, Create program |
| `modules/super-admin/GovernancePage.jsx:103` | Suppress attention item | Cancel |
| `modules/super-admin/GovernancePage.jsx:226` | *(title computed in code)* | Pause |
| `modules/super-admin/KillSwitchPage.jsx:49` | *(title computed in code)* | Disable charging |
| `modules/super-admin/OrganizationsPage.jsx:107` | New Organization | Retry, Create |
| `modules/super-admin/OverridesPage.jsx:171` | Draft a commercial override | Create draft |
| `modules/super-admin/Plane1BillingPage.jsx:1341` | *(title computed in code)* | Set Discount, Send Quote, Approve |
| `modules/super-admin/Plane1BillingPage.jsx:1557` | *(title computed in code)* | Finalize, Send Invoice |
| `modules/super-admin/ReconciliationPage.jsx:175` | Reconciliation run #${run.id} | Acknowledge, Resolve |
| `modules/super-admin/SubscriptionsPage.jsx:356` | Create commercial subscription | Cancel, Create subscription |
| `modules/super-admin/SubscriptionsPage.jsx:418` | Change subscription plan | Cancel, Change plan |
| `modules/super-admin/SupportAccessPage.jsx:924` | Review emergency access | Submit review |
| `pages/UsersPage.jsx:73` | *(title computed in code)* | Cancel |
| `pages/UsersPage.jsx:709` | Delete organization permanently | Delete organization |
| `pages/UsersPage.jsx:843` | Invite tenant administrator | Create invitation |

#### B1 results — Group A (shared `Modal` without a footer): done

Action buttons moved verbatim into each `Modal`'s `footer` (same buttons, handlers, disabled/loading conditions). Submit buttons of form dialogs are tied to their form with `form="<id>"`, so Enter-to-submit and validation are unchanged.

| Dialog | Status | Notes |
|---|---|---|
| EvaluationProgramsPage — Create evaluation program | **Migrated** | |
| GovernancePage — Suppress attention item | **Migrated** | |
| GovernancePage — Pause/Resume invoice finalization | **Migrated** | Title already set in code ("Pause/Resume invoice finalization?"). Verified at 390/1280 on `/super-admin/governance` |
| KillSwitchPage — Disable/Re-enable commercial charging | **Migrated** | Typed confirmation kept. Checked at 768 and 1280. Below 768 `MobileWriteBlock` still replaces the action (verified at 390: notice shown, 0 write buttons) |
| OrganizationsPage — New Organization | **Migrated** | Create was off-screen at 390 (816–856 of 844); now in the pinned footer (791–831) |
| OverridesPage — Draft a commercial override | **Migrated** | |
| Plane1BillingPage — Quote detail | **Migrated** | Reject / Approve (sent) and Convert to Invoice (accepted) in the footer under the same status conditions; capability notice stays in the body |
| Plane1BillingPage — Invoice detail | **Migrated** | Finalize (draft) and Void / Send Invoice (issued) in the footer under the same conditions |
| ReconciliationPage — Reconciliation run | **Wrapped** (no primary action invented) | Per-row Acknowledge/Resolve: the exceptions table now scrolls sideways on phones (it only scrolled vertically, so the actions column could be clipped). Verified with a faked run at 390: all row actions reachable, no page overflow. Desktop unchanged (`sm:` restores the 420px scroll box) |
| SubscriptionsPage — Create commercial subscription | **Migrated** | |
| SubscriptionsPage — Change subscription plan | **Migrated** | Verified at 390/1280 (opened from the row's "Plan" button) |
| SupportAccessPage — Review emergency access | **Migrated** | Below 768 `MobileWriteBlock` unchanged (verified at 390) |
| UsersPage — Reason dialog (Deactivate/Reactivate user, Move membership) | **Migrated** | Shared helper; every caller passes a title. Deactivate verified at 390/1280 |
| UsersPage — Delete organization permanently | **Migrated** | ConfirmDialog destructive look: solid red "Delete organization" (new optional `Button` variant `destructive`) and red icon chip (new optional `Modal` `tone="danger"`); reason + typed confirmation kept word for word |
| UsersPage — Invite tenant administrator | **Migrated** | |

"Untitled" in the inventory meant "title computed in code"; every Group A dialog already had a real title, so none needed adding.

Measured at 390 and 1280 (Kill Switch at 768/1280): every dialog that opens with local data has its primary action in the pinned footer, visible and not covered. Screenshots: `shots/phase3/stepB1/before/` and `shots/phase3/stepB1/after/`. **Desktop difference:** actions sit in the dialog's footer bar (light grey band with a divider) instead of at the end of the fields, as for `FormModal` in Phase 2.

**B1 follow-ups (after review):**
- *Plane1 worst-case footers:* at most two actions show at once (sent quote: Reject + Approve; issued invoice: Void + Send Invoice). Checked with faked data at 360 and 1280: both fit on one row with full labels (about 160px each at 360), so no "⋯" menu was needed; status conditions unchanged. Screenshots: `shots/phase3/stepB1/plane1-footers/`.
- *Previously unchecked dialogs:* Change subscription plan, Deactivate user and Pause/Resume finalization all open with existing local data (the earlier check used the wrong locators); primary action pinned and visible at 390 and 1280. No local data had to be added, and none needs route-interception tests in Phase 5. Screenshots: `shots/phase3/stepB1/after-unchecked/`.
- *Desktop tightening of sectioned form dialogs (separate commit):* from `lg` up, `FormSection` cards use tighter padding, a one-line header and denser fields; phones unchanged. Customer form scrollable height at 1280: **create 826 → 524px** (old unsectioned form: 294px), **edit 504 → 260px** (old: 138px). The remaining difference from the old height is the five section headers and card borders. This is the pattern for B2's form dialogs. Screenshots: `shots/phase3/stepA-tighten/{before,after}/` (`*-form__1280__{top,bottom}.png`).

**B. Hand-rolled overlays (61)** — fix: rebuild on `Modal` (or `FormModal` for simple forms), with actions in `footer`.

| Location | Dialog | Buttons detected |
|---|---|---|
| `modules/billing-admin/PlanChangePanel.jsx:326` | *(title computed in code)* | Not now, Schedule downgrade |
| `modules/billing/contracts/contract-detail.jsx:896` | Renew Contract | Renew |
| `modules/billing/contracts/contract-detail.jsx:924` | Terminate Contract | Terminate |
| `modules/billing/contracts/contract-detail.jsx:944` | Create Amendment | Create Amendment |
| `modules/billing/contracts/contract-edit.jsx:669` | Active Contract Requires Amendment | Save with Amendment |
| `modules/billing/contracts/retainers.jsx:330` | Create Retainer | Create |
| `modules/billing/contracts/retainers.jsx:394` | Edit | Save |
| `modules/billing/contracts/retainers.jsx:455` | Delete Retainer | Delete |
| `modules/billing/customers/customer-import-wizard.jsx:713` | Import Customers | Back |
| `modules/billing/customers/customer-profile.jsx:44` | *(title computed in code)* | Cancel |
| `modules/billing/payments/collections-case-detail.jsx:217` | Assign Case — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/payments/collections-case-detail.jsx:236` | Log Collection Action — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/payments/collections-case-detail.jsx:262` | Resolve Collections Case — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/payments/credits.jsx:358` | Void Credit Note — **Migrated (B2)** | Void |
| `modules/billing/payments/dunning-case-detail.jsx:249` | Resolve Dunning Case — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/payments/dunning-case-detail.jsx:268` | Log a Promise to Pay — **Migrated (B2)** | Save |
| `modules/billing/payments/dunning-levels.jsx:268` | *(title computed in code)* — **Migrated (B2)** | Create |
| `modules/billing/payments/payment-detail.jsx:820` | Reverse Allocation — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/payments/payment-detail.jsx:837` | Refund Payment — **Migrated (B2)** | Process Refund |
| `modules/billing/payments/payment-list.jsx:714` | Record Payment — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/payments/refund-detail.jsx:480` | Start Processing Refund — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/payments/refund-detail.jsx:511` | Reject Refund — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/payments/refund-detail.jsx:530` | Mark Refund as Failed — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/payments/refund-detail.jsx:549` | Cancel Refund — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/payments/write-off-detail.jsx:470` | Reverse Write-off — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/payments/write-off-detail.jsx:492` | Cancel Write-off — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/pricing/currency-pricing.jsx:74` | *(title computed in code)* | Save |
| `modules/billing/pricing/discount-engine.jsx:193` | *(title computed in code)* | Create Discount |
| `modules/billing/pricing/discount-engine.jsx:278` | Discount Details | Close |
| `modules/billing/pricing/pricing-plans.jsx:745` | *(title computed in code)* | (labels computed in code) |
| `modules/billing/pricing/pricing-plans.jsx:776` | Pricing Preview | (labels computed in code) |
| `modules/billing/pricing/pricing-rules.jsx:161` | *(title computed in code)* | Create Rule |
| `modules/billing/pricing/pricing-rules.jsx:229` | Pricing Rule Details | Close |
| `modules/billing/pricing/tax-pricing.jsx:106` | *(title computed in code)* | Create Tax |
| `modules/billing/pricing/tax-pricing.jsx:160` | Tax Pricing Details | Close |
| `modules/billing/pricing/tax-pricing.jsx:287` | Tax Groups | Create, Add |
| `modules/billing/pricing/tax-pricing.jsx:350` | Members: | Add |
| `modules/billing/pricing/tier-management.jsx:84` | Add Tier | Add Tier |
| `modules/billing/pricing/tier-management.jsx:138` | Remove Tier | Remove |
| `modules/billing/products/categories.jsx:498` | *(title computed in code)* | Create Category |
| `modules/billing/products/import-wizard.jsx:723` | Import Products & Services | Back |
| `modules/billing/products/pricing-plans.jsx:549` | *(title computed in code)* | Create Plan |
| `modules/billing/products/pricing-plans.jsx:646` | Pricing Tiers | Add |
| `modules/billing/products/product-list.jsx:718` | New Product | Create Product |
| `modules/billing/products/product-list.jsx:744` | Edit Product | Save Changes |
| `modules/billing/products/usage-billing.jsx:422` | Create Meter | Create Meter |
| `modules/billing/products/usage-billing.jsx:511` | Test API Event | Send Event |
| `modules/billing/quotations/quotation-detail.jsx:720` | Reject Quotation — **Migrated (B2)** | Reject |
| `modules/billing/quotations/quotation-detail.jsx:740` | Cancel Quotation — **Migrated (B2)** | Cancel Quotation |
| `modules/billing/quotations/quotation-detail.jsx:757` | Convert to Contract — **Migrated (B2)** | Create Contract |
| `modules/billing/quotations/quotation-detail.jsx:796` | Convert to Invoice — **Migrated (B2)** | Convert |
| `modules/billing/quotations/quotation-list.jsx:714` | New Quotation — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/subscriptions/subscription-detail.jsx:883` | Change Plan — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/subscriptions/subscription-detail.jsx:929` | Generate Invoice — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/subscriptions/subscription-detail.jsx:965` | Pause Subscription — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/subscriptions/subscription-detail.jsx:989` | Cancel Subscription — **Migrated (B2)** | (labels computed in code) |
| `modules/billing/tax/tax-rate-import-wizard.jsx:693` | Import Tax Rates | Back |
| `modules/billing/tax/tax-rates.jsx:481` | *(title computed in code)* | Create Tax Rate |
| `modules/organization-admin/UserManagementPage.jsx:612` | Invite User | Cancel, Send Invite |
| `modules/organization-admin/UserManagementPage.jsx:713` | Edit User | Cancel, Save Changes |
| `modules/super-admin/TriagePage.jsx:551` | *(title computed in code)* | (labels computed in code) |

#### B2 results — Payments (16 dialogs): done

The module has **16** hand-rolled dialogs, not 19 as stated in the B2 plan (the inventory above lists 16 rows). All 16 are rebuilt on the shared `Modal` with their actions in `footer`; handlers, validation, field names, disabled/loading conditions and API calls are copied word for word. Backdrop behaviour is kept per dialog: dialogs that only closed on Esc (Reject Refund, Log Collection Action, Reverse Allocation, Refund Payment) use `closeOnBackdrop={false}`; the guards that block closing while an action is running (`if (actionLoading !== "void")`, `isActing("dealloc")`, `!wizardLoading && !wizardSuccess`) are kept in `onClose`.

| Dialog | Status | Notes |
|---|---|---|
| refund-detail — Start Processing / Reject / Mark Failed / Cancel | **Migrated** | `size="sm"`; Cancel Refund keeps its red icon (`tone="danger"`) |
| write-off-detail — Reverse / Cancel | **Migrated** | Reverse keeps its orange button (no shared orange variant); sized like the shared `Button` and kept on one line. Cancel uses `destructive` |
| collections-case-detail — Assign / Log Collection Action / Resolve | **Migrated** | |
| dunning-case-detail — Resolve / Log a Promise to Pay | **Migrated** | |
| payment-detail — Reverse Allocation / Refund Payment | **Migrated** | Refundable amount moved into the dialog description |
| credits — Void Credit Note | **Migrated** | |
| dunning-levels — New / Edit Dunning Level | **Migrated** | Short form (4 fields): plain `Modal` `md`; sections would add height for nothing |
| payment-list — Record Payment (4-step wizard) | **Migrated** | `Modal size="xl"` (full screen on phones); the hand-built step row is replaced by the shared `Stepper` (compact "Step X of 4" bar on phones, where the old row was clipped at "Revie…"); Back / Cancel / Continue / Record Payment in the footer with the same step validation. Step contents unchanged |

**Shared change:** `Modal` footer buttons are at least 44px tall on phones (`max-sm:[&>*]:min-h-11`); unchanged from `sm` up.

Measured at 390 and 1280 (refund, write-off and dunning detail use route-intercepted data, since the local DB has no refunds, write-offs or dunning cases; Record Payment and Dunning Levels use real local data): primary action in the pinned footer, visible and uncovered, 44px tall on phones, no horizontal overflow. Screenshots: `shots/phase3/stepB2-payments/{before,after,after-r2}/` (`after-r2` = after the write-off Reverse button fix: 56px two-line → 44px one line at 390).

**Desktop differences (1280):** same as B1 — blurred backdrop, a close × in the header, actions in a light footer band with a divider, Cancel drawn as a bordered secondary button. Record Payment's step row now uses the shared `Stepper` (brand-coloured check for completed steps instead of green). Record Payment keeps its width (`xl` = `max-w-4xl`) but now scrolls inside the dialog with the footer pinned, instead of scrolling the whole overlay.

**Tests:** every rebuilt dialog now has a smoke test (opens → primary calls its handler/API with the expected arguments → closes): new `{write-off-detail,collections-case-detail,dunning-case-detail,payment-detail,credits,dunning-levels}.dialogs.test.jsx`, plus Start Processing and Mark Failed added to `refund-detail.test.jsx`. Payments: 14 files, 54 tests pass. Full suite (`--maxWorkers=1`): 135 files, 919 tests pass. `npm run build` passes (the first attempt ran out of Node heap while the dev server was running on this 8GB machine; it passed with `NODE_OPTIONS=--max-old-space-size=3072`, no code change).

**Caught by the new tests and fixed before commit:** the conversion script dropped attributes written on the same line as `<button` — the "Log a Promise to Pay" Save button had lost its `onClick={handleCreatePromise}` and its disabled rule. Restored word for word; a scan of every `onClick`/`disabled`/`onChange`/`value` expression in the 8 files against `HEAD` shows nothing else missing (the only differences are overlay/× close handlers, now in `onClose`). The script is fixed for the next modules.

**Follow-up (pre-existing, not changed):** `payment-detail.jsx` reads allocations through `extractArray`, which understands arrays, `items` and `data` but not `{ allocations: [...] }` (the shape its own error fallback uses). If the API returns that shape, the Allocations tab would show empty. Needs a check against the real response; out of scope here.

#### B2 results — Subscriptions & quotations (9 dialogs): done

All 9 rebuilt on the shared `Modal`, actions in the pinned footer, handlers / validation / field names / API calls word for word (checked mechanically: every `onClick`, `disabled`, `onChange`, `value`, `placeholder` … expression at `HEAD` is still present, except overlay and × close handlers, which are now the `Modal`'s `onClose`). Esc-only dialogs (Reject Quotation, Change Plan) keep `closeOnBackdrop={false}`.

| Dialog | Status | Notes |
|---|---|---|
| quotation-detail — Reject / Cancel / Convert to Contract / Convert to Invoice | **Migrated** | Plain-text intro lines became the dialog description; Cancel Quotation's warning stays in the body |
| quotation-list — New Quotation (4-step wizard, opened from `?create=1`) | **Migrated** | Same treatment as Record Payment: `xl` (full screen on phones), shared `Stepper`, Back / Cancel / Continue / Create Quotation in the footer with the same step validation; step contents unchanged. The header "New Quotation" button goes to the separate full-page create screen (`/billing/quotations/create`, B3), not this wizard |
| subscription-detail — Change Plan / Generate Invoice / Pause / Cancel | **Migrated** | Pause keeps its amber button (no shared amber variant), sized like the shared `Button`; Cancel Subscription uses `destructive`, Generate Invoice `success` |

No footer has more than three actions, so no "⋯" overflow was needed.

Measured at 390 and 1280 (sent/accepted quotations via route interception — the local DB has no quotations; subscription dialogs and the wizard use real local data): primary in the pinned footer, visible and uncovered, 44px on phones, no horizontal overflow. Before, at 390 the wizard's Continue sat mid-page under a clipped step row and the confirm dialogs' buttons were 36px. Screenshots: `shots/phase3/stepB2-subs-quotes/{before,before-r2,after}/` (`before-r2` re-shoots the wizard and Reject with the right openers).

**Desktop differences (1280):** as in B1 / Payments — blurred backdrop, close ×, footer band, bordered Cancel; wizard step row uses the shared `Stepper`.

**Tests:** smoke tests for every dialog (opens → primary calls its API with the expected arguments → closes), added to `quotation-detail.test.jsx` and `subscription-detail.test.jsx` plus a new `quotation-list.dialogs.test.jsx` that drives the wizard through all 4 steps to `quoteApi.create`. One existing test locator was updated (`quotation-detail.test.jsx` found the Convert to Invoice dialog through `heading.closest("div").parentElement`; it now uses `getByRole("dialog", { name })`, same assertions). Module run: 6 files, 38 passed, 1 skipped (below).

**Pre-existing bug found (not fixed — needs a decision):** the New Quotation wizard cannot be closed. `handleCloseWizard` hides it and navigates from `?create=1` to `/billing/quotations`, but the effect `if (searchParams.get("create") === "1" && !showWizard) openWizard();` runs before the navigation lands (React Router 7 applies it in a transition) and reopens and resets the wizard. Verified in the browser on the commit *before* this change: Cancel leaves it open. The old hand-built overlay had no Esc handler; the shared `Modal`'s Esc now calls the same `handleCloseWizard`, so Esc fails the same way. Only entry point is `?create=1`, used from the customer profile (`customer-profile.jsx` lines 1047, 2237). The test for it is `it.skip` with a pointer here.

## 9. Local environment safety notes

- `backend/.env` points at a remote PostgreSQL server. It was **not** used, edited, seeded or migrated. Overrides were applied per process only.
- **Windows PowerShell cannot hold an empty environment variable** (`$env:X = ""` deletes it), and the backend then falls back to `backend/.env`. In addition, `stripe_connect_service.resolve_stripe_setting` re-reads `backend/.env` whenever a Stripe key is blank. So "set it to empty" does not disable SMTP or Stripe on Windows. The local run used **non-empty inert values** instead: SMTP → `127.0.0.1:1` with dummy credentials, Stripe keys → `sk_test_local_disabled` and similar. The database URL and every override were verified by a dry run before the server started, and again from the startup log (SQLite table creation; the remote host never appears).
- Test accounts live only in `frontend/tests/.local-credentials.json`, which is git-ignored.

---

## Appendix A: pattern inventory (from Phase 0, still current on this branch)

- **Raw `<table>`:** 71 files (top offenders: `customer-profile` 7, `product-profile` 5; 3 each in tax/reports, subscription-detail, quotation-list, tax-pricing, payment-detail, dashboard/settings, customers/reports, WorkspaceZoikoSubscriptionPage, WorkspaceSubscriptionPage).
- **`DataTable` call sites passing the ignored `minWidth`:** payments/{collections-receivables, dunning, promise-to-pay, refunds, write-offs}; 22 super-admin pages; pages/{SettingsPage, UsersPage}.
- **Viewport-height units:** shell `h-screen` (`BillingShell.jsx:812,823`); inline `100vh` on login, forgot, reset, accept-invite, payment-success, checkout, the public invoice and quote pages, OrganizationPage, and products/categories; `min-h-screen` on register, registration-success, public estimate and quotation-create; `vh` caps on about 20 hand-rolled dialogs.
- **Hand-rolled overlays (`fixed inset-0`):** subscription-detail, quotation-detail, product-list, tax-pricing, refund-detail (4 each); collections-case-detail, retainers, contract-detail (3 each); 2 each in UserManagementPage, usage-billing, products/pricing-plans, tier-management, pricing-rules, pricing/pricing-plans, discount-engine, write-off-detail, payment-detail, dunning-case-detail, customer-list; 1 each in about 14 more files.
- **Unprefixed `grid-cols-3+`:** 22 occurrences in 16 files (each checked in Phase 3).
- **`whitespace-nowrap`:** 195 occurrences in 65 files (mostly inside scroll containers, which the browser check bears out).
