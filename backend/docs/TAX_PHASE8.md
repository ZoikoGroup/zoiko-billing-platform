# Tax Phase 8: change pipeline completion

ZB-TAX-ARCH-001, handoff §10.1 steps 01–03 and 07, §10.2 and §10.3.

**No market is live.** This phase changes how approved tax content is
protected, activated, rolled back, re-checked and monitored. It does not
publish any market, integrate a real provider, add the B2 admin API, add
e-invoicing, or change legacy invoicing.

| PR | Scope | Status |
|---|---|---|
| 1 | Rule-pack integrity (step 07) | Merged (#157) |
| 2 | Scheduled activation (step 07) | Merged (#158) |
| 3 | Emergency rollback (§10.3) | Merged (#159) |
| 4 | Retroactive change analysis (§10.3, T04) | Merged (#160) |
| 4b | Governed tax-only credit and retroactive remediation drafts | Outline below; not built |
| 5 | Source change detection and review cadence (steps 01–03, §10.2) | Merged (#161) |
| 6 | Tenant reference rates and reports screens (G-5b-1) | Merged (#162) |

## Open product questions (not acted on)

- **Legacy quote → invoice repricing** (product question 1): no tooling;
  waits on the product decision.
- **Remediation enablement:** the Phase 7 remediation allow-lists
  (`TAX_REMEDIATION_*_ORGS`) stay empty until the product owner decides per
  organization.
- **Under-collection after a retroactive change** (PR 4, product and tax
  lead): the analysis reports under-collected tax only. No debit notes or
  extra charges are created. Whether and how to recover under-collected tax
  is a product and tax-lead decision.
- **Source allowlist** (PR 5, tax lead): confirm the six official hosts
  (`www.gov.uk`, `www.legislation.gov.uk`, `www.ato.gov.au`,
  `www.legislation.gov.au`, `www.canada.ca`, `www.revenuquebec.ca`) and decide
  on the EU sources registered in Phase 1 (European Commission pages, TEDB
  for cross-checks), whose hosts are **not** allowlisted until then.
- **Sources, tiers and cadences** (PR 5, tax lead): sign off which sources are
  monitored, at which tier.
- **Single-person break-glass market stop** (PR 3, for the tax lead and the
  security owner): there is no market-scoped stop that one person can apply
  to a native market. Today a native market stops through a two-person
  SUSPENDED publish or rollback; the only single-person switch is the
  platform-wide invoice-finalization breaker, which stops all issuing for
  every tenant and market. Should a single TAX_PUBLISHER, with MFA, be able
  to stop one native market at once (time-bound, reviewed afterwards)? Not
  built.

---

## PR 1: rule-pack integrity

### The code hash

`app/modules/tax/rule_pack_integrity.py`. A pack's code hash is a SHA-256
over canonical JSON of:

- **the pack's source code:** every module in `app.modules.tax.rule_packs`
  that defines a class in the pack's class hierarchy, so the pack's own
  module plus the shared domestic logic. Line endings are normalised to LF,
  so a Windows checkout hashes the same as Linux;
- **its declarations:** markets, coverage, required facts, rounding rule
  and mode, and the declared source refs. The approval state of those
  sources is left out: it changes over time and is checked separately when
  the pack is used (T16);
- `hash_scheme: 1`.

The UK and AU packs moved into their own modules (`rule_packs/gb_vat.py`,
`rule_packs/au_gst.py`), so a change to one doesn't change the other's hash.
`rule_packs/__init__.py` only registers them.

The hash is computed once per process; a deploy restarts the process.

### Recorded and frozen

- `tax_rule_pack_versions.code_hash` is set when a version is registered.
  It is part of the frozen content (ORM guard and Postgres trigger), so
  nobody can change it once the version is submitted.
- Validation and approval refuse a version whose running code no longer
  matches: "the pack's code changed since this version was registered;
  register a new pack version".
- A draft registered before Phase 8 gets its hash on its next edit or
  validation. A recorded hash is never replaced.

### Fail closed at use time

For an ACTIVE version covering the market, the engine resolver checks the
running code against the approved hash. If the hash differs, or the
approved version's code isn't running (missing, or another version):

- the quote is refused: status **UNSUPPORTED**, refusal code
  **`RULE_PACK_INTEGRITY_FAILED`**, outcome NOT_DETERMINED. No tax is
  computed and nothing falls back to another engine or tenant rates;
- the tenant sees "Zoiko can't calculate tax for this market right now.
  This isn't something you can fix; our team has been alerted." No hashes
  or pack internals (T13);
- the **P1 alert `tax.rule_pack_integrity`** is raised.

A deploy that changes pack code without a new approved version therefore
fails closed for that pack. Other markets and legacy invoicing keep working.

### The P1 alert

An Attention item (source `tax_monitoring`) naming only the pack code,
version and state (no tenant data). It is raised from three places:

1. **startup** (`verify_rule_packs_at_startup`, after the secret-store
   check). It never stops the app;
2. **every run of the tax monitoring job**, which also clears it once every
   ACTIVE pack matches again;
3. **each refused quote**, best effort in a savepoint, so it never changes
   the refusal.

Runbook: `TAX_MONITORING_RUNBOOK.md`, "tax.rule_pack_integrity".

### Quote provenance

- `tax_quotes.rule_pack_version_id` (foreign key, indexed) and
  `rule_pack_code_hash` are recorded on every native-pack quote, and frozen
  with the rest of the quote. Tenant-config and provider quotes leave them
  null. The quote view's `engine` block shows both.
- **Checked alongside the context fingerprint, not inside it.** At issuance
  the quote's pack version must still be the ACTIVE one, with the same
  approved hash, and that hash must be the code running now. Otherwise the
  quote is STALE ("the tax rule pack changed since the quote; re-quote").
  Why not inside the fingerprint:
  1. the fingerprint is built before an engine is chosen;
  2. adding an input changes every open quote's fingerprint, so the deploy
     would mark them all STALE;
  3. a separate check gives a specific reason;
  4. PR 3's rollback finds affected quotes by `rule_pack_version_id`
     directly.

### Backfill

Migration `d2a6c8e4f1b7`:

- A native-pack quote whose `engine_name`/`engine_version` match exactly one
  `(code, version)` row gets that row's id. `(code, version)` is unique, so a
  match is never ambiguous.
- `rule_pack_code_hash` stays null on backfilled quotes: the code that
  produced a past quote can't be proven, so it isn't claimed.
- Every other quote stays null. The migration logs both counts. To count
  again:

```sql
SELECT count(*) FILTER (WHERE rule_pack_version_id IS NOT NULL) AS linked,
       count(*) FILTER (WHERE rule_pack_version_id IS NULL)     AS left_null
FROM tax_quotes WHERE upper(engine_kind) = 'NATIVE_RULE_PACK';
```

No pack is ACTIVE in production, so no live quote is affected.

The migration also recreates the Postgres tenant guard on `tax_quotes`
with every content column (including the ones added since Phase 3b, which
the ORM guard already froze) and the rule-pack version guard with
`code_hash`.

### Evidence and console

- `view_rule_pack` adds `code_hash`, `running_code_hash` and `integrity`
  (MATCH, MISMATCH or CODE_MISSING). The platform `rule_pack` evidence
  bundle carries `code_hash` in its record.
- **P7 Rule packs** (`/super-admin/tax/rule-packs`): a code-hash column
  with an integrity badge, both hashes in the detail, and a red alert on an
  ACTIVE pack whose code doesn't match.

### Decisions (approved with the plan)

| Question | Decision |
|---|---|
| Hash shared engine code (money path, `engines.py`)? | **No, deferred.** Covered by code review and the Phase 7 regression gate; hashing it would force every pack to be re-approved for unrelated fixes. |
| Fail the deploy on drift? | **No.** Runtime fail-closed plus P1. The deploy job has no production database access. |
| Refusal status | **UNSUPPORTED** with refusal code `RULE_PACK_INTEGRITY_FAILED`; no new quote status. |

### PR 1 tests

| Test file | Covers |
|---|---|
| `tests/privacy/test_tax_phase8_rule_pack_integrity.py` (12) | Hash stable, the same with CRLF, changes with pack code, declarations and shared domestic logic. Recorded at registration; frozen once submitted. Validation refuses changed code; pre-Phase 8 drafts get a hash. Native quotes record version and hash, shown in the quote view. Issuance marks a quote STALE when the pack version changed. Changed code: quote refused (UNSUPPORTED, `RULE_PACK_INTEGRITY_FAILED`, no tax, no fallback, no hash in the tenant message) and a P1 alert. Monitoring raises and clears the alert. Missing pack version fails closed. Startup check alerts. View and platform bundle carry the hash; the bundle verifies. Backfill links unambiguous quotes only and never claims a hash. |
| `tests/test_tax_phase8_pg.py` (3, CI Postgres step) | The trigger freezes `code_hash` once submitted but not on a draft; quote provenance recorded and frozen; changed code fails closed on Postgres. |
| `tests/test_tax_phase3b_packs.py` | Updated: the "packs hold no rates" check reads every pack module. |
| `frontend/.../TaxControlCenter.test.jsx` (+3) | Match (axe), mismatch alert, code-missing alert. |

**CI result:** _see PR_.

---

## PR 2: scheduled activation

### The decision: packs follow the tax date, availability follows the clock

Approved with the plan.

- **Rule packs are effective-dated, like rates.** Each version has
  `valid_from` and `valid_to` (local legal DATEs, end-exclusive). The
  quote's tax date picks the version in force:
  - an invoice dated 31 Dec that is quoted or issued on 2 Jan uses the old
    rules (T03);
  - backdated drafts and re-quotes stay stable;
  - selection compares dates, so DST and time zones don't affect which
    version applies (T17); a version can start on 29 Feb.
- **Market availability switches at `activate_at`,** whatever the tax
  date. It says whether a market is calculated *now*; a suspension must
  never wait for a tax date.

### Effective-dated packs

- `valid_from` is set by the reviewer (on registration, or "Set start date"
  on a draft) and frozen with the content. Null means "from the start".
- When a version activates, the open-ended ACTIVE version of the same pack
  is its predecessor:
  - **later start:** the predecessor's `valid_to` is set to the new
    version's `valid_from`. It stays ACTIVE and keeps deciding earlier tax
    dates. `valid_to` can be set once on an ACTIVE row (ORM guard and
    Postgres trigger);
  - **same start:** a full replacement (for a bug fix); the predecessor is
    SUPERSEDED, as before;
  - **earlier start:** refused.
- Several versions of a pack can therefore be ACTIVE, for date ranges that
  never overlap:
  - the service checks it;
  - on Postgres, `ex_tax_rule_pack_active_ranges` (an exclusion over code
    and date range, `btree_gist`) replaces the one-ACTIVE-per-code index.
- **Every ACTIVE version must stay in the running code.** A new version goes
  in a new module beside the old one; the code registry is keyed by (code,
  version) (`engines.RULE_PACK_VERSIONS`, `rule_pack_class`). Registration
  takes an optional `version`; the default is the newest in code.
- **Issuance:** PR 1's check now asks whether the quote's version is still
  ACTIVE *for the quote's tax date*, with the same hash. A quote for a date
  before a new version starts stays valid when it activates; a quote for a
  date on or after it becomes STALE.
- **Retroactive versions are refused** until PR 4's analysis exists: a
  version must activate no later than local midnight at the start of its
  `valid_from` (in the jurisdiction's zone, or the zone given for
  multi-zone jurisdictions).

### Scheduling

- **Publish** takes an optional `activate_at_local` (for example
  `2030-06-01T09:00`), `timezone` and `utc_offset`:
  - no time, or a time already past: published now, as before;
  - a future time: status **SCHEDULED** until then. It is audited, needs
    MFA like publishing, and the publisher must differ from the maker.
- **Converting the local time (T17):**
  - the zone is the jurisdiction's; multi-zone jurisdictions (AU, CA, US)
    must name one;
  - a time in the spring-forward gap is refused ("does not exist");
  - a time in the autumn overlap needs the UTC offset ("happens twice");
  - the stored record keeps the local text, the zone and the UTC instant.
- One SCHEDULED version per pack code or availability cell at a time.

### The activation job

`tax_activation_job` ("Tax Scheduled Activation", every
`TAX_ACTIVATION_INTERVAL_MINUTES`, default 1):

- takes each SCHEDULED version whose time has come, locks it
  (`FOR UPDATE SKIP LOCKED` on Postgres) and re-checks its status;
- re-runs validation, PR 1's integrity hash, the Phase 7 regression gate
  and the date-range rules;
- activates it, recording the scheduling publisher as publisher and
  "activated by schedule" in the platform audit log;
- if a check fails: the version stays SCHEDULED with `activation_error`,
  and nothing changes;
- is idempotent: a second run or a second worker does nothing.

### The late alert

`tax.activation_late` (**P1**): a SCHEDULED version more than
`TAX_ALERT_ACTIVATION_LATE_MINUTES` (10) past its time, whether the job
stopped or a check failed. The text names the pack or market, minutes late
and whether a check failed (no tenant data). Runbook:
`TAX_MONITORING_RUNBOOK.md`.

### Cancelling a scheduled activation (two people, MFA)

- **Propose:** a TAX_PUBLISHER, or the TAX_REVIEWER who submitted the
  version, with a reason (`POST …/{rule-packs|market-availability}/{id}/cancel-schedule`).
- **Decide:** a different TAX_PUBLISHER approves with MFA step-up, or
  rejects with a reason (`POST /activation-cancellations/{id}/approve|reject`).
  The request appears in the approvals inbox.
- **Approving** returns the version to APPROVED, so it can be published or
  scheduled again.
- **Too late:** once the version is ACTIVE, approving fails ("use emergency
  rollback", PR 3).
- **Records:** `tax_activation_cancellations` (frozen once decided: ORM
  guard and Postgres trigger), plus the version's audit history.

### Console

- **Publish dialog:** "Publish now" or "Schedule", with a local date and
  time, the zone (the jurisdiction's by default), an optional UTC offset
  and a live UTC preview (the server is authoritative).
- **Versions:** a Scheduled badge; the activation time in local and UTC;
  a red alert when the activation checks failed.
- **Packs:** an "In force" column and "Set start date" on drafts.
- **Cancellation:** propose, then approve or reject, in the version and in
  the approvals inbox.

### Migration

`e3b7d9f1a2c4`:
- adds `valid_from`/`valid_to` to packs;
- adds the scheduling columns to packs and availability;
- creates `tax_activation_cancellations`;
- on Postgres, replaces the one-ACTIVE index with the exclusion and
  recreates the pack guard and the cancellation guard.

The downgrade restores the one-ACTIVE index; it fails if several versions
of a pack are ACTIVE (supersede them first).

### PR 2 tests

| Test file | Covers |
|---|---|
| `tests/privacy/test_tax_phase8_scheduled_activation.py` (16) | Local time to UTC: BST, AEDT, the spring-forward gap refused, the autumn overlap needs an offset, leap day, unknown zone. **T03:** the tax date picks v1 or v2; a 31 Dec quote after v2 activates uses v1 and issues; a 1 Jan quote made under v1 goes STALE. **T17:** a version starting on 29 Feb. A version can't start before the one it follows; same start replaces; retroactive versions refused; activation after the start date refused; one schedule per pack. The job activates at the time, not before, exactly once, audited. A failed re-check stays SCHEDULED with an error; the P1 alert fires after 10 minutes and clears once activated. Availability switches at its time for old tax dates too; a suspension published now is immediate. Cancellation: not for tenant users; one pending; the proposer can't decide; approval returns the version to APPROVED and the job skips it; a decided request is final; rejection needs a reason; the submitting reviewer may propose; an activation that already ran can't be cancelled. HTTP: scheduling needs MFA; schedule, cancel, inbox entry, approve, list. |
| `tests/test_tax_phase8_pg.py` (+2, CI Postgres step) | `valid_to` set once on an ACTIVE pack; overlapping ACTIVE ranges rejected by the exclusion, a following range accepted; a decided cancellation can't be edited or deleted. |
| `frontend/.../TaxControlCenter.test.jsx` (+7) | UTC preview across DST; schedule a pack in the jurisdiction's zone (axe); publish now; a failed activation check and proposing a cancellation; a different publisher approves with step-up; schedule availability with an offset; the inbox lists a cancellation with its reason. |

**CI result:** _see PR_.

---

## PR 3: emergency rollback

`app/modules/tax/rollback_service.py`. Approved with the plan; answers and
additions as recorded below.

### Rule packs

- **V** is the bad ACTIVE version; **P** an earlier published version of
  the same pack to restore.
- **Open-ended V:** a new version **R** is created, ACTIVE at once:
  - R runs P's code: `code_version = P.version`, P's code hash and P's
    content; `restores_id = P`, `rollback_of_id = V`; version label
    `"{P.version}-rb{request}"`;
  - R starts on **today's local legal date** in the pack's zone, or on V's
    start if that is later (a version published early for a future date);
  - V's `valid_to` is set to R's start (the set-once rule) and V becomes
    **ROLLED_BACK**.
- **V already followed by a successor W: quarantine only.** No P and no R:
  V becomes ROLLED_BACK, W is untouched and keeps serving its range. Roll
  back W first only when W itself is bad.
- **V's range fails closed.** For a tax date in a ROLLED_BACK version's
  [`valid_from`, `valid_to`), the engine refuses: status UNSUPPORTED,
  refusal code **`RULE_PACK_ROLLED_BACK`**, outcome NOT_DETERMINED, never a
  fallback. Dates before V use the version before V; dates from R's start
  use R.
- **The one sanctioned retroactive path.** PR 2 still refuses retroactive
  versions; a rollback never creates a calculating version for a past date.
- **Never touched:** P and V are not edited, reactivated or deleted;
  committed quotes and issued invoices are not reopened (T04).
- **Open quotes made with V** are marked STALE at once: dates in V's range
  with "can't be calculated" (a re-quote returns `RULE_PACK_ROLLED_BACK`),
  later dates with "re-quote" (a re-quote uses R).

### P's fitness and the regression report

At proposal and again at approval:

- P's module must ship with P's recorded hash (and be in the retention
  manifest when the publish gate is on);
- P's validation must pass today (`errors()`, including that its source
  dependencies are still approved);
- the Phase 7 regression runs P against V on the anonymised fixtures and is
  attached to the request for the approver. Changed cases are
  informational; **run errors block**.

### Pending schedules

If the key has a SCHEDULED version, the proposal must set
`cancel_schedule`, or it is refused naming the schedule. Approval then
returns that version to APPROVED inside the same two-person decision,
audited with the rollback request id.

### Two people, MFA, concurrency

- A TAX_PUBLISHER proposes with a reason and a severity; a **different**
  TAX_PUBLISHER approves with MFA step-up, and it applies at once (no
  scheduling). Rejecting needs a reason; the proposer can withdraw.
- One open request per version (a partial unique index plus the service).
  Requests are frozen once decided (ORM guard and Postgres trigger).
- **Concurrency:** approval locks the scheduled version (if any) and then
  V with `FOR UPDATE` on Postgres, and re-reads both. The activation job
  locks with `SKIP LOCKED`. So either the rollback applies (and the job
  activates nothing) or the job activates the schedule first (and the
  approval is refused because V is now followed). The Postgres race test
  proves exactly one outcome.

### Severity

| Severity | Meaning | What it changes |
|---|---|---|
| SEV1 | Wrong tax is being charged now | Tenant review items due the same day; the email says "Action needed today." |
| SEV2 | Wrong tax in limited cases | Review items due in 3 days; "Please review soon." |
| SEV3 | Precautionary | Review items due in 14 days; "Please review soon." |

The platform alert is P1 whatever the severity: every rollback needs eyes.
The severity is also recorded in the request, the alert text and the
audit.

### Outputs

- **Platform:** the audit log (request, V, R and any cancelled schedule)
  and a **P1 Attention item `tax.rollback_applied:<request>`**, acknowledged
  by staff (not auto-resolved). Aggregate only: pack or market, the
  rolled-back date range, counts of open quotes made STALE and
  NOT_DETERMINED, committed quotes for analysis, and the number of
  organizations affected. No tenant identifiers.
- **Each affected organization** (an open quote marked STALE or a committed
  quote made with V; for availability, an approved activation in that
  market): its own review item (`TAX_ROLLBACK_APPLIED`, with its own counts)
  and an email to its admins (template **ZB-TAX-001**), with no amounts,
  invoice numbers or customer names.

### Market availability

Rollback copies P's content into a new version that is ACTIVE at once (it
follows the clock); V becomes ROLLED_BACK. **SUSPENDED** stays the stop for
when no known-good earlier state exists; see the runbook's decision tree.

### Code retention

- **Manifest:** `app/modules/tax/rule_packs/retention.json` lists every
  published version with its code hash. Entries are never deleted; a
  version that may stop shipping is marked `"retired": "<reason, date>"`.
  It starts empty: no pack has been published anywhere.
- **CI** (`tests/test_tax_rule_pack_retention.py`, its own step): every
  non-retired entry's module ships with that hash, and no entry on
  `origin/main` was removed. Removing an old module fails CI.
- **Publish gate:** publishing (and approving a rollback) refuses a
  version not in the manifest with a matching hash
  (`TAX_RULE_PACK_RETENTION_REQUIRED`, on; off in the test suite, where
  the gate's own tests turn it on).
- **Runtime enforcement** (CI can't see production): the startup and
  monitoring check (P1 `tax.rule_pack_integrity`) fails for any version
  that must ship but is missing, differs, or is marked retired: every
  ACTIVE and ROLLED_BACK version, the most recent SUPERSEDED version of
  each pack, and P whenever an ACTIVE (or most recent SUPERSEDED) R runs
  P's code. So "retired only when SUPERSEDED and not the most recent" is
  enforced there.

### For PR 4

Retroactive analysis must take **applied rollback requests** as an input,
alongside retroactive rate and pack versions. Each request's `result`
holds the pack code, V, P and R, the rolled-back range and when it was
applied. The scope is every committed quote with
`rule_pack_version_id = V`, whatever its date (this includes quotes dated
on R's start day that were committed before the rollback).

### Migration

`f4c8e2a6b9d1`: `code_version`, `restores_id`, `rollback_of_id` on packs;
`restores_id`, `rollback_of_id` on availability; `tax_rollback_requests`;
on Postgres, the pack and availability guards (ROLLED_BACK final; ACTIVE
may become it) and the request guard.

### PR 3 tests

| Test file | Covers |
|---|---|
| `tests/privacy/test_tax_phase8_rollback.py` (16) | **T03/T04:** R from today runs P's code with P's hash; dates before V use P, V's range returns `RULE_PACK_ROLLED_BACK` with no lines, R's start uses R; open quotes go STALE with the two reasons and counts; the committed quote and its invoice keep their snapshot. **Local midnight:** approval at 23:30 UTC (00:30 BST) starts R the next day. A quote made with V can't be issued after. **Quarantine:** refused for an open-ended V; a restore refused for a closed V; W keeps serving, V's range refuses, P's dates unchanged. **P:** tampered code refused at proposal, a removed module refused at approval; unapproved sources refused; the regression report attached; run errors block. **Two people:** one open request; proposer can't approve; rejection needs a reason; decided requests final; withdraw by the proposer only; a ROLLED_BACK version is immutable. **HTTP:** reviewers can't propose; candidates with integrity; the inbox entry; MFA required; the proposer is refused. **Schedules:** refused without acknowledgement; cancelled inside the approval and audited. **Availability:** immediate. **Outputs:** P1 alert with no tenant identifiers; the tenant's review item due per severity; an email to its admin only, without amounts. **Retention:** manifest checks (missing, hash, retired, removed); the publish gate; the runtime check flags RETIRED and CODE_MISSING, including P's module behind an active R. |
| `tests/test_tax_rule_pack_retention.py` (3, own CI step) | Listed versions ship with their hashes; entries are well formed; nothing on `origin/main` was removed. |
| `tests/test_tax_phase8_pg.py` (+2) | ACTIVE to ROLLED_BACK (with `valid_to` once) is the only change allowed and then final; a decided request is final. |
| `tests/test_tax_phase8_race_pg.py` (1, commits, CI race step) | A rollback approval and the activation job racing on one pack end in exactly one consistent outcome, with one open-ended ACTIVE version. |
| `frontend/.../TaxControlCenter.test.jsx` (+5) | Propose (axe; unusable versions listed, not offered); quarantine only for a followed version; a different publisher approves with step-up and the rolled-back state shows (axe); reviewers can't propose and R shows what it restores; the inbox. |

**CI result:** _see PR_.

---

## PR 4: retroactive change analysis

`app/modules/tax/retro_service.py`, `retro_models.py`. Approved with the plan;
answers and fixes A to D are recorded below. **Strictly read-only** for
issued records: quotes, snapshots, invoices and credit notes are never
written. Tests compare every issued-record row byte for byte before and
after (T04).

### Triggers and scope

| Trigger | Enqueued when | Documents (committed invoice quotes) | Comparison basis |
|---|---|---|---|
| Rollback with a restore | PR 3 approval | every quote made with V, whatever its date | P's logic: "Comparison against restored logic, not a determination" |
| Rollback, quarantine only | PR 3 approval | every quote made with V | none: each document `MANUAL_REVIEW_REQUIRED` ("the rules for this tax date were quarantined") |
| Retroactive rate version | its publish | native quotes using that component in the jurisdiction, dated in the past part of its validity: selected by the rate's **key**, not the superseded version id (fix A), so a product-scope rate covering dates served by GENERAL is included | the rate now in force, under the quote's own pack version |
| Retroactive pack version | its publish | quotes of that pack dated in the past part of its validity | that pack version |

- **Provider quotes** in those markets and dates are listed
  `NOT_ANALYSABLE` ("decided by the tax provider; a provider re-run isn't
  available").
- **Out of scope by construction:** availability rollbacks (they follow the
  clock; nothing is retroactive) and tenant-configured rates (no trigger
  changes them).
- **"Past"** is the local legal date in the jurisdiction's zone; for
  multi-zone jurisdictions the zone furthest ahead (UTC+14), so a date counts
  as past once it has started anywhere.

### Rate corrections today, and the gate

- **Before this PR** a staged rate with a past `valid_from`, including a
  correction superseding a rate already used by issued invoices, published
  with no analysis.
- **Now** a rate or pack version whose validity covers past dates needs a
  **current preview** to be approved and published
  (`TAX_RETRO_PREVIEW_REQUIRED`, on; off in the test suite, where the gate's
  own tests turn it on). A retroactive pack version can't be scheduled.
- **A preview** (`POST /super-admin/tax-registry/retro-previews/{rate|rule_pack}/{id}`)
  runs the same comparison against the candidate and stores **aggregates
  only**. It is current when:
  - it is for the same subject;
  - the candidate and the versions in force are unchanged (`inputs_hash`);
  - the **sorted in-scope committed quote ids** are unchanged
    (`scope_hash`; fix 4: a quote created before the preview and committed
    after it makes it stale);
  - it is at most `TAX_RETRO_PREVIEW_MAX_AGE_HOURS` (24) old.
- The approver sees the preview on the rate or pack screen. Publishing
  enqueues the full per-tenant analysis.

### Commit-time facts (fix 2)

A pack comparison uses the values recorded at commit, never today's:

| Fact | Commit-time source |
|---|---|
| Currency, tax date | `tax_quotes` (snapshot) |
| Line inputs and amounts, tax code, supply category, transaction class | `tax_quote_lines` (snapshot) |
| Activation (jurisdiction, tax type) | `tax_quote_components.activation_id`, frozen once approved |
| Registry product scope | `tax_quotes.decision_facts` (new), else the line's component rate version (immutable) |
| Seller country, buyer billing country, buyer status | `tax_quotes.decision_facts` (new in this PR, frozen with the quote) |

- No commit-time value (quotes committed before this PR) →
  `MANUAL_REVIEW_REQUIRED`, "commit-time value unknown", never assumed.
- A current value that differs from the commit-time one →
  `MANUAL_REVIEW_REQUIRED`, "facts changed since commit".
- A basis that doesn't determine a line → `MANUAL_REVIEW_REQUIRED`.
- Each result records the exact versions and hashes used and an
  `inputs_hash`, so a re-run gives the same answer.

### Execution

`tax_retro_analysis_job` (every `TAX_RETRO_ANALYSIS_INTERVAL_MINUTES`):
- one row per affected organization, locked `FOR UPDATE SKIP LOCKED`, so two
  workers never take the same tenant and results never mix tenants;
- batches of `TAX_RETRO_BATCH_SIZE` (200) after a stored cursor, committed
  per batch: resumable;
- results unique per (analysis, quote): idempotent;
- each comparison runs in a rolled-back savepoint;
- progress is visible to the platform as counts; a failure raises P1
  `tax.retro_analysis:<id>` and is retried.

### Outputs and privacy (T13)

- **Tenant report** (org admin and finance approver; another org 404,
  platform users 403): `GET /tax/retro-analyses` and
  `GET /tax/retro-analyses/{id}/documents` (JSON or audited, formula-safe
  CSV): per document and line, original vs comparison outcome, rate and tax,
  totals per currency, and "superseded by analysis #N" (fix D).
- **Platform** (`GET /super-admin/tax-registry/retro-analyses`): organizations
  affected (a count), documents by status, net difference per currency and
  the over/under split. **Fix B:** below 3 organizations, amounts are bands
  (< 1k, 1k–10k, 10k–100k, > 100k) in views and alerts; counts stay exact.
- **Retention:** results and per-organization runs are tenant tax records
  under the tenant record guard (erasure purge only).

### Communication (fix C)

- **Rollback triggers:** the analysis updates the PR 3 tenant review item
  (no second item) and the PR 3 P1 Attention item `tax.rollback_applied:<id>`
  (same incident, no disconnected alert). Admins get one "analysis ready"
  email (ZB-TAX-002) referencing the rollback: the rollback email said what
  happened; this one says the comparison is ready.
- **Rate and pack triggers:** a new review item (`TAX_RETRO_ANALYSIS`), the
  ZB-TAX-002 email and a P2 Attention item `tax.retro_analysis:<id>`.
- Emails and alerts never carry amounts (banded on the platform side).

### Remediation: preview only

- Over-collection shows, per document and component, the proposed tax-only
  correction. `TAX_RETRO_REMEDIATION_ORGS` (empty) is the allow-list for
  drafts in PR 4b.
- **The governed credit path can't express a tax-only correction:**
  `GovernedCreditService` credits a fraction of a whole line (net and tax
  together) from the snapshot. What is missing is listed in the PR 4b
  outline. Nothing works around it.
- Under-collection: report only (see open questions).

### Tenant-configured rates (answer 5)

Before this PR a tenant could propose (and approve) a tenant-configured
activation with a past `effective_from` without analysis. It is now refused
(fail closed) when invoices were already issued in that jurisdiction on or
after that date: "retroactive analysis of tenant rates isn't available yet".
A first tenant rate with a past start, over no issued invoices, is still
allowed.

### Overlapping analyses (fix D)

Results stay independent per analysis. **Rule for PR 4b:** remediation
drafts must use the latest DONE analysis covering a document and refuse a
document whose latest analysis is superseded or still running.

### Finding (fix B)

Phase 7's platform aggregates (P10 legacy over-collection and duplicate
rows, the anomaly alerts) show exact counts and amounts even when one or two
organizations are affected. They should get the same banding; not changed
in this PR.

### Migration

`a5d9f3b7c1e8`: `tax_quotes.decision_facts` (frozen; the quote guard is
recreated), `tax_retro_analyses`, `tax_retro_org_runs`, `tax_retro_results`
(tenant guard triggers).

### PR 4 tests

| Test file | Covers |
|---|---|
| `tests/privacy/test_tax_phase8_retro.py` (14) | **Rate correction:** refused without a preview; the preview's aggregates (no tenant rows); published; the job compares 20.00 vs 18.00 (OVER 2.00) with the exact versions; **T04 byte-identical**. Under-collection report only. **Fix A:** a product-scope rate selects the document by key. **Fix 4:** a quote created before the preview and committed after makes it stale; older than 24 hours is stale. **Pack:** refused without a preview, can't be scheduled, compared (UNDER 5.00). **Fix 2:** commit-time value unknown and facts changed since commit are both manual review. Provider quotes NOT_ANALYSABLE. **Rollback:** restored logic with its label (T04); quarantine is manual review with no comparison; the PR 3 review item and alert are updated, one email without amounts (fix C). Idempotent and resumable. Tenant report private (finance and admin; billing 403; other org 404/empty; platform 403); CSV; platform aggregates banded with no identifiers; P2 alert banded. Exact amounts from 3 organizations; bands. Superseded by a later analysis. Past-dated tenant rate over issued invoices refused. |
| `tests/test_tax_phase8_pg.py` (+1) | Results can't be edited or deleted; `decision_facts` frozen with the quote. |
| `tests/test_tax_phase8_retro_race_pg.py` (1, commits, CI race step) | Two workers: each document analysed once, never mixing tenants; the analysis finishes once. |
| `frontend/.../TaxControlCenter.test.jsx` (+2), `ProviderScreens.test.jsx` (+2) | Platform list with progress and banded aggregates (axe); the preview gate on a pack and running a preview (axe); the tenant report with superseded marks, preview-only remediation, line table and CSV (axe); other roles closed. |

**CI result:** _see PR_.

---

## PR 4b outline: governed tax-only credit and retroactive remediation drafts (not built)

Needs its own plan and approval.

1. **Governed tax-only credit** in `GovernedCreditService`: credit a
   per-component tax amount with zero credited net, bounded by the remaining
   creditable tax of each component (after earlier credits), recorded in
   `credit_note_tax_lines` with the same signed-amount and reconciliation
   rules (T09, T18), shown on the invoice and ledger as a tax adjustment.
   Tenant maker-checker (a different finance approver), audited.
2. **Retroactive remediation drafts:** for an over-collected document, a
   DRAFT tax-only credit note built with (1), from the **latest DONE
   analysis** covering it; refuse a document whose latest analysis is
   superseded or still running. Gated per organization by
   `TAX_RETRO_REMEDIATION_ORGS` (empty = preview only), never twice per
   (analysis, document), re-checking existing credits at creation.
3. **Under-collection** stays report only unless the product and tax-lead
   decision says otherwise.
4. **Tests:** reconciliation to the cent with earlier partial credits;
   allow-list; the latest-analysis rule; two-person approval; T04 for the
   original invoice.

---

## PR 5: source change detection and review cadence

`source_fetch.py`, `source_normalize.py`, `source_monitor_service.py`,
`source_parsers.py`, `source_monitor_models.py`. Platform data only.
**Detection only:** nothing creates a source revision, a staged rate or a
publication. Formal evidence is still captured by a reviewer through the
Phase 1 evidence-attach flow.

### Monitors and change control (answer 1)

A monitor is an official source's URL on an allowlisted host, a risk tier
(sets the cadence) and an access mode.

| Tier | Cadence |
|---|---|
| `HIGH_VOLATILITY` | daily (`TAX_SOURCE_CADENCE_HIGH_HOURS` 24) |
| `NATIONAL_VAT_GST` | weekly (`TAX_SOURCE_CADENCE_NATIONAL_HOURS` 168) |
| `RESEARCH_ONLY` | quarterly (`TAX_SOURCE_CADENCE_RESEARCH_DAYS` 91) |

- **One TAX_REVIEWER, audited:** create a monitor, raise its tier (more
  frequent), "check now", record manual checks, close reviews.
- **A different TAX_REVIEWER or TAX_PUBLISHER decides** anything that can
  weaken detection: disable, delete (the monitor is retired; its history is
  kept), lower the tier, switch to manual by hand, change the URL.
- **Automatic switch to manual checks** (raises reminders, so it stays
  automatic): HTTP 401/403 at once; three consecutive 429s; robots.txt
  disallowing the path.

### Fetching (fixes A, C, D)

- **Hosts:** https only, the standard port, no credentials, on the code
  allowlist `OFFICIAL_SOURCE_HOSTS` (see open questions).
- **DNS rebinding:** each hop resolves the host **once**; every address must
  be public (not private, loopback, link-local, multicast, reserved or
  unspecified). The request goes to that validated IP with TLS SNI and the
  Host header set to the hostname (`sni_hostname`), so the certificate is
  verified for the hostname and no second lookup happens. Redirects (at
  most 3) repeat the checks and must stay on the allowlist.
- **Egress proxy:** the fetcher ignores environment proxies
  (`trust_env=False`) so the pinned address is the one connected to. If
  production must egress through a proxy, the proxy itself has to enforce
  the same host allowlist (CONNECT allowlist); that is a deployment item,
  not configured here.
- **Courtesy:** robots.txt per host, cached a day (4xx = no robots.txt; 5xx =
  not fetched this time, per RFC 9309); at most one request per host per
  minute (a robots.txt refresh defers the page to the next run); User-Agent
  `ZoikoBillingTaxMonitor/1.0 (+TAX_SOURCE_MONITOR_CONTACT_URL)`, an
  organisational URL and no personal data.
- **429:** back off honouring Retry-After (seconds or a date), bounded to
  1 minute to 24 hours; manual checks after three in a row.
- **Limits:** 20-second timeout, 5 MB.

### Normalization and storage (fix F, answer 4)

| Content type | Normalization | Change signal |
|---|---|---|
| `text/html`, `application/xhtml+xml` | `html-text-v1`: visible text only (script, style, noscript, template, head dropped), whitespace collapsed | normalized hash |
| `application/pdf` | `pdf-text-v1 (pypdf 5.1.0)`: text of every page, whitespace collapsed; **pypdf pinned** in requirements.txt | normalized hash |
| other `text/*` | `plain-text-v1` | normalized hash |
| anything else (or an unreadable PDF) | `raw-bytes`: no text | raw hash; a change still opens a review, labelled raw |

- Every check is an **append-only** observation (ORM guard and Postgres
  trigger): time, URL, HTTP status, raw and normalized hashes.
- The raw artifact is stored (in `tax_source_artifacts`, de-duplicated)
  **only for the first observation and when the normalized hash changes**.

### Reviews and reminders

- **SOURCE_CHANGED:** a unified text diff (2,000 lines at most) against the
  last stored artifact. Closed as **evidence captured** (linking the new
  source revision) or **dismissed** with a reason; dismissals are counted per
  monitor and a monitor with 3 or more shows as **flapping** with its recent
  reasons (answer 3; ignore patterns come later).
- **MANUAL_CHECK_DUE:** for manual monitors, once per cycle; closed by
  recording the check (a note), which moves the next check a cadence on.
- **PRE_EFFECTIVE_CHECK:** a published rate whose `valid_from` is within
  `TAX_RATE_REVERIFY_DAYS` (14) of its jurisdiction's legal date gets one
  reminder; a rate published already inside the window gets it at once
  (answer 5).
- **Untrusted content (fix B):** fetched text and diffs are shown as escaped
  plain text in the console, never as HTML, and are never sent to any AI
  model.

### Revalidation due dates (answer 6)

- Every approved source and every ACTIVE availability version has a due
  date: sources by their monitor's tier (weekly if unmonitored);
  availability by the most volatile monitored tier of its jurisdiction,
  otherwise weekly for calculating modes and quarterly for reference-only.
- "Mark reviewed" (a TAX_REVIEWER with a note) moves it a cadence on.
- **Research-only jurisdictions** (every monitored source RESEARCH_ONLY and
  no calculating market) show "Research only: not cleared for billing" in
  `GET /tax/jurisdictions` and the console.

### Parser plugins

`SourceParser.parse(monitor, text) -> [ProposedRate]`; `SOURCE_PARSERS` is
**empty**. A registered parser's proposals become staged rates with origin
`OFFICIAL_FEED`, which still need validation and two people.

### Job and alerts (fix E)

`tax_source_monitor_job` (hourly): due monitors (each locked `FOR UPDATE
SKIP LOCKED`, the host row locked for the courtesy rules), manual
reminders, re-verification reminders, review dues, alerts. Platform data
only.

| Alert | Severity | When |
|---|---|---|
| `tax.source_fetch_failing` | P3 | a monitor failed 3 times in a row (network, 5xx, policy) |
| `tax.source_stale:<tier>` | P2 | a monitor's next check is more than one cadence overdue (failing, refused, backing off or the job down), aggregated per tier |
| `tax.review_overdue` | P2 | a revalidation is past due |

### Migration

`b6e0a4c8d2f9`: `tax_source_monitors`, `tax_source_monitor_changes`,
`tax_source_observations` (append-only trigger), `tax_source_reviews`,
`tax_review_dues`, `tax_source_hosts`.

### PR 5 tests

| Test file | Covers |
|---|---|
| `tests/privacy/test_tax_phase8_source_monitoring.py` (26) | Only https on allowlisted hosts and the standard port, no credentials. **Fix A:** one lookup, connection to the validated IP with SNI and Host, a resolver turning private later is never used; private, loopback, link-local, multicast, unspecified, IPv6 and reserved addresses refused; every redirect hop checked (private resolution, host off the allowlist). Size cap; Retry-After bounds. **Fix F:** HTML text (markup churn gives the same hash), PDF text, raw. **Detection:** baseline, unchanged, markup churn, change with a diff; artifacts only first and on change; no source revision, staged rate or rate created; raw-only types still open reviews; observations append-only. **Fix C/D:** 403 switches to manual at once and reminds at the cadence without retries; 429 backs off then switches after three; robots.txt disallow and one request per host per minute. **Answer 1:** weakening changes need a second person; raising alone; URL checks. **Answer 3:** dismissals counted, flapping. **Answer 5:** reminder at once when published inside the window, once only. **Fix E:** dues by tier, P2 overdue and stale, P3 failing, cleared by review. Research-only label. A test parser stages an OFFICIAL_FEED draft; none registered. HTTP roles. |
| `tests/test_tax_phase8_pg.py` (+1) | Observations can't be updated or deleted. |
| `tests/test_tax_phase8_source_race_pg.py` (1, commits, CI race step) | Two workers: one observation per monitor per cycle and one request to the host. |
| `frontend/.../TaxControlCenter.test.jsx` (+3) | **Fix B:** a diff with `<script>` and `<img onerror>` renders as text, no element, no execution (axe); flapping and manual reasons; closing reviews, recording checks and revalidations; a different person approves a weakening change. |

**CI result:** _see PR_.

---

## PR 6: tenant reference rates and reports screens (G-5b-1)

Frontend, plus one optional query parameter on an existing endpoint. Both
screens existed in basic form since Phase 5c; this PR completes G-5b-1.

### Reference rates (T9)

- Every rate row carries a **"Reference only"** badge and a source summary:
  authority, title (linked to the official page), citation, and
  **"Reviewed by Zoiko Tax Review on <date>"** (adjustment B).
- For the chosen jurisdiction, two separate facts (adjustment A); nothing
  says "cleared" and the existing disclaimer stays:
  - **Zoiko support:** "Zoiko calculates this market (native rule pack)",
    "… (provider)", "Calculated from your organization's own approved rate",
    "Research only" or "Reference only", from the published coverage
    (`/tax/coverage`) and the jurisdiction's research-only label (PR 5);
  - **Your entity:** "Activated (<mode>)" or "Not activated" for the
    selected seller entity: an APPROVED activation in effect on the lookup
    date, from the tenant activations API (`/tax/activations`). A role that
    can't read activations sees that, not a guess.

### Reports hub (T10)

One screen for every tax report of the organization (org admins and
finance approvers). Each card loads on its own, links to its screen, and
shows amounts with the currency's minor units (`Intl.NumberFormat`: JPY 0,
GBP 2, KWD 3; adjustment C):

| Card | Source | Not applicable when |
|---|---|---|
| Legacy over-collection (CSV) | `/reports/legacy-discount-overcollection` | every entity is governed |
| Duplicate tax rows (CSV) | `/reports/duplicate-tax-rows` | every entity is governed |
| Shadow compare → Shadow compare screen | `/shadow/summary` | every entity is governed |
| Anomaly findings → Review items (`?kind=anomalies`) | `/review-items?kind=TAX_SNAPSHOT_MISMATCH,CREDIT_EXCEEDS_ORIGINAL` | no governed entity |
| Remediation → Remediation screen | `/remediation/batches` | every entity is governed |
| Retroactive analyses → its screen | `/retro-analyses` | no governed entity |

- **Not applicable vs no data (adjustment D):** a card that can't apply says
  so ("Applies once your entity uses governed tax." or "Applies to invoices
  issued under legacy manual tax"), separately from "no data yet". **Note:**
  the review listed shadow compare and remediation as governed-only; they
  apply to **legacy** invoices (shadow compare runs a legacy entity against
  a governed pack; remediation corrects legacy findings), so their "not
  applicable" condition is "every entity is governed". Retroactive analyses
  and anomaly findings are the governed-only cards.
- **Per-card access (adjustment E):** a 403 from a card's API shows "Your
  role can't open this report." on that card; an error stays on its card.
  Today no tenant role can open the hub but be refused one card's API (all
  six APIs accept org admins and finance approvers), so the test simulates
  the 403.
- **Anomaly counts (answer 2):** the card and the Review items screen use
  the same server-side filter (`kind` on `/review-items`, added here) and
  the same kind list, so their counts match (tested).

### Finding (adjustment B)

`PublicSourceSummary.reviewed_by` (the public reference API) returned the
reviewer's display name. **Closed** in e051890 (findings burn-down, below):
the API now says "Zoiko Tax Review".

### PR 6 tests

| Test file | Covers |
|---|---|
| `frontend/.../ProviderScreens.test.jsx` (+5, 2 updated) | T9: badge, authority, "Zoiko Tax Review" (no person's name), Zoiko support and entity activation, never "cleared" (axe); research only and not activated with the disclaimer; no rate is not 0%. Hub: every card, minor units for JPY and KWD, links (axe); anomaly counts equal Review items for the same filter; not applicable vs no data; a 403 and an error stay on their cards. |
| `backend/tests/privacy/test_tax_phase8_reports_hub.py` (1) | The `kind` filter returns exactly the anomaly kinds, matches the unfiltered list, and never another organization's. |

**CI result:** _see PR_.

---

## Known flaky tests

Tests that have failed without a code fault. Non-tax tests are recorded here
only; they are not changed by this phase.

| Test | Where it failed | Cause | Status | Telling a real failure from a flake |
|---|---|---|---|---|
| `TaxControlCenter.test.jsx` › approvals inbox › "prompts for step-up and retries the approval once with the code" and "shows a wrong code in the prompt…" | CI on 07e2135 (Phase 8 PR 6); once locally on 10 Nov | Timing: the test clicked Confirm as soon as any dialog appeared and waited vitest's default 1 s for the retried approval; a loaded runner exceeded it | **Fixed** in 0a92f1b: waits for the named "Confirm with MFA" dialog, an enabled Confirm button and up to 5 s for the retry. The same hardening was applied to the recovery-code flows in 9f6081e | A real fault fails the same way every run and in isolation (`npx vitest run src/modules/tax-control-center/TaxControlCenter.test.jsx`); a flake passes on re-run and alone |
| `create-invoice-wizard*.test.jsx` (billing, non-tax) | Phase 0, under a 2-worker local run | vitest's 5 s per-test timeout on a slow, multi-step wizard render under parallel load | **Not changed** (non-tax). Passes 6/6 alone with CI's single-worker settings (`TAX_PHASE0.md`) | A timeout ("Test timed out in 5000ms") under parallel load that passes alone is the flake; an assertion failure, or a failure alone, is real |
| `backend/tests/test_aggregate_cache.py` (non-tax) | Locally on 10 Nov, on `main` and on the branch alike (1–2 tests: `test_status_change_and_bulk_delete_invalidate`, `test_rollback_keeps_cache_commit_invalidates`); green in CI | Not established. It depends on run order and the local environment: the cache service uses Redis when `REDIS_URL` is set and reachable, otherwise an in-process cache, and query-count assertions are sensitive to what earlier tests left warm | **Not changed** (non-tax) | Reproduce on `main` with the same environment: if `main` fails the same way, it is environmental; CI (no Redis) is the reference |

---

## Phase 8 close-out

### What shipped

| PR | Merged | Merge commit | What it delivers |
|---|---|---|---|
| 1. Rule-pack integrity | #157 | e38822b | A code hash per pack version, frozen; quotes refused (`RULE_PACK_INTEGRITY_FAILED`) and P1 when running code differs; each native quote records its pack version and hash; STALE at issue if the version changed |
| 2. Scheduled activation | #158 | c8f0119 | Effective-dated packs (the tax date picks the version); availability switches at a local time; DST-safe scheduling; an idempotent activation job; P1 when late; two-person, MFA cancellation |
| 3. Emergency rollback | #159 | ba926ee | Two publishers with MFA; a rollback version runs the restored code from today; the rolled-back range fails closed (`RULE_PACK_ROLLED_BACK`); quarantine for a followed version; immediate availability rollback; code-retention manifest, CI step and publish gate |
| 4. Retroactive change analysis | #160 | 46d2614 | Past-dated rate and pack versions need a current preview; rollbacks and retroactive publishes run a read-only per-tenant comparison against commit-time facts; tenant-private reports; banded platform aggregates; remediation preview only |
| 5. Source change detection | #161 | f4e45c0 | Allowlisted official-source monitors by risk tier; DNS-rebinding-safe fetching; robots.txt and courtesy limits; append-only observations; change reviews with escaped diffs; manual-check and re-verification reminders; revalidation due dates; P2/P3 alerts |
| 6. Tenant rates and reports | #162 | a98e709 | Reference rates with "Reference only" badges, source summaries, Zoiko support and entity activation; a reports hub with the Phase 7 and PR 4 reports |

**No market is live.** Phase 8 changed how approved content is protected,
activated, reverted, re-checked and monitored; it didn't publish a market.

### Open decisions and their owners

| Decision | Owner | Since |
|---|---|---|
| Confirm the six monitored hosts; decide on the EU sources (European Commission, TEDB) | Tax lead | PR 5 |
| Sign off which sources are monitored, their tiers and cadences (gate 02 stays not passed until then) | Tax lead | PR 5 |
| Sign off the GB and AU packs and their rates (gates 01, 02, 04) | Tax lead (+ Finance controller, QA for gate 04) | Phase 3b |
| Under-collection after a retroactive change: recover or not, and how (report only today) | Product owner + tax lead | PR 4 |
| Repricing legacy quotes on conversion (product question 1) | Product owner | Phase 3a |
| Which organizations may run remediation (Phase 7 and PR 4b allow-lists; empty today) | Product owner | Phase 7 |
| Product questions 3, 4 (line items) and 5 | Product owner | Phase 3a |
| A single-person, time-bound break-glass stop for one native market | Security owner + tax lead | PR 3 |
| Production egress: if a proxy is used, it must enforce the source-host allowlist | Security owner (+ ops) | PR 5 |
| MFA hardening (Phase 5d-F) and tenant MFA step-up sign-off | Security owner | Phase 5d |
| Evidence retention vs erasure (certificates, address resolutions) | DPO | Phase 2 |
| Provider items: DPA, data residency, minimised payload | DPO | Phase 4 |

### Unfixed findings

| Finding | Where | Suggested fix |
|---|---|---|
| ~~The public reference-rates API (`PublicSourceSummary.reviewed_by`) still returns the reviewer's display name~~ | PR 6 | **Closed** in e051890: returns "Zoiko Tax Review" |
| ~~Phase 7 platform aggregates show exact amounts for one or two organizations~~ | PR 4 (fix B) | **Closed** in e051890: one shared banding rule (see below) |
| The governed credit path can't express a tax-only correction, so retroactive remediation is preview only | PR 4 | PR 4b (outline above) |
| Shared engine code (money path, `engines.py`) is outside the pack hash | PR 1 (decision) | Revisit if engine-core changes become frequent |
| A deploy with drifted pack code isn't stopped; it fails closed at runtime with P1 | PR 1 (decision) | A deploy-time check needs production database access |
| Quotes committed before PR 1 have no pack hash; before PR 4 no commit-time facts, so pack comparisons of them are manual review | PRs 1, 4 | None (history can't be reconstructed) |
| Past-dated tenant-configured rates over issued invoices are refused; there is no tenant retroactive analysis | PR 4 | A tenant trigger for retroactive analysis |
| Flapping sources are only made visible; no ignore patterns | PR 5 | Per-monitor ignore patterns when dismissal data shows the need |
| Source artifacts are stored in the database (bytea, 25 MB cap) | Phase 1, PR 5 | Object storage with retention controls |
| The rollback migration's downgrade fails if several versions of a pack are ACTIVE | PR 3 | Documented; supersede first |
| The staging rehearsals (rollback, source monitoring) haven't been run | PRs 3, 5 | Gate 05/06 item |
| QA walkthrough and a manual WCAG 2.2 AA pass of the console and tenant screens, including T9 and the T10 hub | Phase 5 onwards | Gate 06 item |

### PR 4b

Outlined above ("PR 4b outline"); not built. It needs its own plan and
approval.

---

## Findings burn-down (after close-out)

Both privacy findings from the close-out are closed in e051890.

### Public reference rates name the team, not a person

- `public_source_summary` returns `reviewed_by: "Zoiko Tax Review"` when the
  source has been reviewed and `null` otherwise. No name, email or user id
  reaches the public `/tax/rates` and jurisdiction responses.
- The privileged `/source-revisions/{id}` view (TAX_REVIEWER /
  TAX_PUBLISHER) keeps `reviewer_user_id` and the reviewer's name. The only
  screen that shows the name (the console's source register) reads it from
  there; the tenant reference-rates screen already showed the team label.

### One banding rule for platform aggregates

`app/modules/tax/aggregate_privacy.py` holds the PR 4 fix B rule: when fewer
than 3 organizations are affected, platform amounts become magnitude bands
(< 1k, 1k–10k, 10k–100k, > 100k) and counts stay exact. Every platform
surface that shows money uses it.

| Surface | Before | Now |
|---|---|---|
| Retroactive analysis platform view (PR 4) | Banded (own copy of the rule) | Banded via the shared module; output unchanged |
| P10 legacy over-collection (Phase 7) | Exact totals | Banded below 3 organizations, with `amounts` ("exact" or "banded (fewer than 3 organizations)"); the Findings screen says when amounts are banded |
| P10 duplicate tax rows | Counts only | Unchanged; tested to stay counts only |
| Anomaly runs and alerts | Counts and percentages | Unchanged; alert text tested to carry no amounts or currencies |
| Remediation | Tenant-only | Unchanged; tested that no platform route exists |

Tenant reports are never banded.

### Tests

| Test file | Covers |
|---|---|
| `backend/tests/privacy/test_tax_phase8_findings_burndown.py` (9) | Public rates carry no person identifier and name the team; unreviewed sources claim no reviewer; the privileged view keeps the reviewer; the shared rule's bands and threshold; retroactive banding unchanged and using the shared rule; over-collection banded with 2 organizations and exact with 3; tenant report exact; duplicates counts only; every anomaly alert fires with no amounts in its text; no platform remediation route |
| `backend/tests/test_tax_phase1_registry.py` (1 updated) | The public blob no longer contains the reviewer's name |
| `backend/tests/privacy/test_tax_phase3a_reports_access.py`, `backend/tests/test_tax_phase3a_governed.py` (updated) | Platform over-collection with one organization is banded |
| `frontend/.../ProviderOperations.test.jsx` (+1, 1 updated) | The banded note shows with fewer than 3 organizations and not otherwise |

