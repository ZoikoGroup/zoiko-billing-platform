# Tax Phase 8: change pipeline completion

ZB-TAX-ARCH-001, handoff §10.1 steps 01–03 and 07, §10.2 and §10.3.

**No market is live.** This phase changes how approved tax content is
protected, activated, rolled back, re-checked and monitored. It does not
publish any market, integrate a real provider, add the B2 admin API, add
e-invoicing, or change legacy invoicing.

| PR | Scope | Status |
|---|---|---|
| 1 | Rule-pack integrity (step 07) | Merged (#157) |
| 2 | Scheduled activation (step 07) | This PR |
| 3 | Emergency rollback (§10.3) | Planned |
| 4 | Retroactive change analysis (§10.3, T04) | Planned |
| 5 | Source change detection and review cadence (steps 01–03, §10.2) | Planned |
| 6 | Tenant reference rates and reports screens (G-5b-1) | Planned |

## Open product questions (not acted on)

- **Legacy quote → invoice repricing** (product question 1): no tooling;
  waits on the product decision.
- **Remediation enablement:** the Phase 7 remediation allow-lists
  (`TAX_REMEDIATION_*_ORGS`) stay empty until the product owner decides per
  organization.

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

