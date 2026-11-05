# Global Tax — Phase 5a: Tax Control Center Sign-Off Screens

The first frontend for the platform tax-ops console (plan:
`TAX_PHASE4_PLAN.md`, "Tax Control Center UI", the sign-off subset). These
are the screens the tax lead needs to sign off the UK and Australia packs.

API: `TAX_CONTROL_CENTER_API.md`. Sign-off checklist: `TAX_PHASE3B.md`.
Gates: `TAX_LAUNCH_GATES.md`.

## Who can use it

| User | Access |
|---|---|
| **TAX_REVIEWER** (maker) | Reads everything. Registers sources and captures evidence; stages and amends rates; drafts and amends availability; registers packs and attaches golden-test reports; validates and submits. |
| **TAX_PUBLISHER** (checker, the tax lead) | Reads everything. Approves, rejects and publishes, with MFA step-up. Never on something they authored or submitted. |
| Every other platform role, **including PLATFORM_ADMINISTRATOR** | The "No access" page. The nav entry is hidden. The backend's `tax_registry.*` capabilities are explicit-only. |
| Tenant users | Can't reach `/super-admin/*`; the backend refuses them too. |

Everything shown is platform data. No screen calls a tenant endpoint or
shows tenant data.

## Screens (`/super-admin/tax/…`)

| # | Route | What it does |
|---|---|---|
| Foundations | — | **Route guard** and "No access" page. Section nav, keyboard operable (links with `aria-current`). **Status badges are icon + text**, never colour alone. **Cursor lists** follow `next_cursor` with "Load more" (50 per page). **MFA step-up:** on `TAX_REGISTRY_STEP_UP_REQUIRED`, prompt for an authenticator or recovery code and retry the action **once**. A wrong code is shown in the prompt; cancel does nothing. **Maker-checker action bar:** a disabled action shows its reason as text, tied to the button with `aria-describedby`. **Version timeline** from each version's own timestamps and people. |
| P8 | `inbox` | Approvals inbox (B1): everything IN_APPROVAL, oldest first, filter by kind. Approve uses the backend's `can_approve` / `reason_if_not`; the reason is shown when disabled. Approve with step-up from the list; "Review" opens the item's screen. |
| P2 | `sources` | Source register: revisions with authority, handoff ref, tier, evidence status, redistribution. Register (maker). Detail shows the **server SHA-256**, capture time, artifact type and size, and reviewer. **Evidence capture:** upload a file and choose the redistribution permission. Evidence is write-once. |
| P3 | `rates` | Staged rates, filterable by status. Stage and amend (maker); adopt AI proposals; validate; submit with a reason. **Old and new side by side:** the current rate (the superseded version, or else the overlapping ACTIVE one) beside the proposal, with citation and dates. Also shown: the errors, conflicts and warnings validation would give now; and a dated timeline of every ACTIVE version for the key plus the proposal. Approve or reject (checker), then publish, with step-up. |
| P6 | `availability` | Market availability versions, filterable by status. Draft and amend with a **gate editor for gates 01–07** (status, evidence ref, notes), showing as you edit what validation will say. **The G1 rule is shown:** for a provider market, gate 05 must be PASSED with evidence and can't be waived. Detail lists each gate with its status badge, evidence and problems, plus the history. Validate, submit, approve/reject, publish. |
| P7 | `rule-packs` | The packs available in code (markets, rounding, **live source-dependency status**). Register a draft (maker). The registry versions with the golden-test report. Detail shows the **TAX_PHASE3B sign-off checklist next to the pack**, attaching or replacing the golden-test report, the history and the workflow actions. |

## Backend changes (separate commit, additive)

1. **A distinct step-up error code.** A missing code on registry approve or
   publish now carries `"error": "TAX_REGISTRY_STEP_UP_REQUIRED"`, so the
   UI can tell "needs a code" from any other 400. The status (400) and
   message are unchanged, so existing clients and tests are unaffected.
2. **`GET /tax-registry/staged-rates/{id}/comparison`.** P3 can't show the
   old rate without it: the staged-rate response has only ids, and there
   was no read for a rate version by id. It is read-only and needs
   `tax_registry.read`.

Both are tested (`tests/privacy/test_tax_phase5a_backend.py`) and
documented in `TAX_CONTROL_CENTER_API.md`.

## Gaps (not built: bigger than an additive endpoint)

| # | Gap | Effect today | Suggested fix |
|---|---|---|---|
| G-5a-1 | **No list of authorities, tax types or components** (B2, deferred) | Registering a source, staging a rate and drafting availability take numeric ids. The source form suggests the authorities already used; availability lists jurisdictions from the reference read. | B2's read side only: `GET /tax-registry/authorities`, `/tax-types`, `/components`. |
| G-5a-2 | **No per-item audit trail endpoint** | "History" is the version's own timeline (created, submitted, approved, published, superseded, with user ids) and the predecessor link, not the full platform audit log entry by entry. | `GET /tax-registry/{kind}/{id}/audit` (tax roles only). |
| G-5a-3 | **User ids, not names** | Inbox and timelines show "user #9". | A platform-user name lookup for tax roles. |
| G-5a-4 | **Sign-off checklist completion isn't recorded** | The checklist is shown read-only; completion is evidenced through the registry itself (sources, rates, gates, golden report, two-person approval). | A checklist record per pack version, if the tax lead wants ticked items stored. |
| G-5a-5 | **Audit-evidence export** (gate 06) | Not in this console. | An export of a version's evidence and approvals for authorised roles. |

## What was cut (by the brief: minimum to operate)

- **No charts, dashboards, bulk import or explorers.** P1 overview, P4
  jurisdiction/rate explorer, P5 tax-code catalogue, P9 provider operations
  and P10 reports are not in this phase. Tax-code sets can still be
  approved from the inbox.
- **No dedicated "revoke source" button.** Withdraw a source by registering
  a new revision and capturing it with redistribution DENIED, as the screen
  explains.
- **No deep links to a single item.** The inbox's "Review" opens the right
  screen, not the item.
- **No editing of jurisdictions, authorities or components** (B2,
  deferred).

## Accessibility and themes

- **Status:** always icon + text.
- **Disabled actions:** explained in text, tied to the button with
  `aria-describedby`.
- **Tables:** have a caption.
- **Dialogs:** use the shared Modal (focus trap, Esc, focus returned).
- **Forms:** use labelled fields with required markers.
- **Navigation:** links with `aria-current`.
- **Themes:** light and dark through the app's `dark:` variant, as in the
  rest of the app.
- **axe:** a test runs it against the inbox with approvable and blocked
  items; no violations.
- **Remaining:** a manual WCAG 2.2 AA pass (screen reader, zoom, contrast
  in both themes) is part of gate 06 QA.

## Tests

| Test file | Covers |
|---|---|
| `frontend/src/modules/tax-control-center/TaxControlCenter.test.jsx` (20) | **No-access guard** (platform administrator, support operator, no role) and tax reviewers let in. **Inbox:** maker-checker disabling with the backend's reason; **step-up then exactly one retry** with the code; a wrong code shown without another retry; cancel approves nothing; **pagination** following `next_cursor`, appended; axe. **Sources:** register and capture evidence (server SHA-256 shown), registration hidden from publishers. **Rates:** old and new side by side with conflicts; approve disabled from the backend's verdict; publish disabled for the maker. **Availability:** the G1 rule and gate rules; drafting with seven gate entries and the provider rule shown; gates as icon + text in the detail. **Rule packs:** register from the catalogue; the sign-off checklist; approve with a recovery code after step-up. |
| `backend/tests/privacy/test_tax_phase5a_backend.py` (5) | The step-up error code (direct and over HTTP); the comparison (superseded, overlapping, timeline, conflicts); tax roles only |

**CI result:** _see PR_.
