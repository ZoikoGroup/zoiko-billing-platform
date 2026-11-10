# Tax Phase 8: change pipeline completion

ZB-TAX-ARCH-001, handoff §10.1 steps 01–03 and 07, §10.2 and §10.3.

**No market is live.** This phase changes how approved tax content is
protected, activated, rolled back, re-checked and monitored. It does not
publish any market, integrate a real provider, add the B2 admin API, add
e-invoicing, or change legacy invoicing.

| PR | Scope | Status |
|---|---|---|
| 1 | Rule-pack integrity (step 07) | This PR |
| 2 | Scheduled activation (step 07) | Planned |
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
