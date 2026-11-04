# Global Tax — Phase 1: Reference Registry

Implements the Global Tax Reference Registry slice of **ZB-TAX-ARCH-001**
(§06, §07, §09.1, §10.1). Phase 1 stores reference facts (jurisdictions, tax
components, legal sources and effective-dated rate versions) behind a
staging and two-person publication pipeline. It calculates nothing: every
published version is `REFERENCE_ONLY`, and production calculation stays
`NOT_ACTIVATED` until Phase 2 activation records exist. Existing tenants
invoice exactly as before.

## What changed

**Registry module**: `backend/app/modules/tax/`

| File | Purpose |
|---|---|
| `enums.py` | Registry vocabulary: jurisdiction level, component combination, taxable-base rule, source tier (§06.1), acquisition method (§06.2; no crawler or AI value), redistribution permission, evidence status, rate kind, staging origin and status, rate-version status. |
| `registry_models.py` | Nine non-tenant tables (below), plus the Postgres-only DDL attached so `create_all` on Postgres matches the migration. |
| `registry_service.py` | `RegistryReadService` (reference lookups), `TaxRegistryPipeline` (stage → validate → submit → approve → publish), and the ORM immutability guard. |
| `registry_router.py` / `registry_schemas.py` | Public reads under `/api/v1/tax`; the pipeline under `/api/v1/super-admin/tax-registry`. |
| `registry_seed.py` + `scripts/seed_tax_registry.py` | REFERENCE_ONLY seed for UK, Australia, Canada and the EU-27 (dry run by default, `--apply` to write). |

**Tables** (no `organization_id`; foreign keys only to registry tables, `users` and `approval_requests`):

| Table | Holds |
|---|---|
| `tax_jurisdictions` | Code, ISO country/subdivision, level, parent hierarchy, official area id, IANA timezone, boundary ref/version |
| `tax_authorities` | Levying or publishing authority |
| `tax_type_definitions` | VAT, GST, HST, PST, QST, … (named `…Definition` because billing already exports a tenant-side `TaxType`) |
| `tax_components` | Jurisdiction + type + authority, compounding order, combination, `is_cumulative`, taxable-base rule, reporting code |
| `tax_source_artifacts` | Captured source bytes, content-addressed by server-computed SHA-256, write-once |
| `tax_legal_source_revisions` | Authority, tier, method, permanent URL, document id/version, title, citation, language, redistribution permission, `retrieved_at`, SHA-256, storage URI, reviewer |
| `tax_rate_staging` | Every proposal (seed, manual, feed, AI) with raw payload and its hash, plus validation results and escalation |
| `tax_change_approvals` | §07 ChangeApproval: maker, checker, publisher, detector, source comparison, linked to the shared `approval_requests` row (`request_type="tax_rate_publish"`) |
| `tax_rate_versions` | Published, immutable rate facts with predecessor link |

**Platform roles**: `TAX_REVIEWER` (maker) and `TAX_PUBLISHER` (checker and
publisher) are added to `PlatformRole`. They hold the capabilities
`tax_registry.read`, `tax_registry.write` (reviewer) and
`tax_registry.approve` (publisher), and nothing else. All three are
explicit-only: `PLATFORM_ADMINISTRATOR` does not get them implicitly.

**API**

| Route | Who | Notes |
|---|---|---|
| `GET /api/v1/tax/jurisdictions` | any authenticated user | Reference status (`REFERENCE_ONLY` / `NO_APPROVED_RATES`), `production_calculation: NOT_ACTIVATED`, freshness |
| `GET /api/v1/tax/rates?jurisdiction_id=&tax_code=&as_of=&known_at=` | any authenticated user | Published versions plus a public source summary (authority, title, URL, citation, reviewed-by). `coverage: NO_APPROVED_RATE` when empty, never 0% |
| `GET /api/v1/tax/source-revisions/{id}` | TAX_REVIEWER, TAX_PUBLISHER | Hash, storage URI, internal notes |
| `…/super-admin/tax-registry/source-revisions` (GET, POST) | read / reviewer | Register a new source revision |
| `…/source-revisions/{id}/evidence` (POST, multipart) | reviewer | Server computes SHA-256, sets `retrieved_at` and the storage location; accepts no client hash |
| `…/staged-rates` (GET, POST), `/{id}` (GET, PATCH) | read / reviewer | Stage (origin MANUAL) and amend |
| `…/staged-rates/{id}/adopt`, `/validate`, `/submit` | reviewer | |
| `…/staged-rates/{id}/approve`, `/publish` | publisher + **MFA step-up** | |
| `…/staged-rates/{id}/reject` | publisher | |

## Time model

- **Valid time.** `valid_from` and `valid_to` are `DATE` values in the
  jurisdiction's local legal calendar, end-exclusive (`[from, to)`).
  `valid_to = NULL` means open-ended. `as_of` defaults to today in the
  jurisdiction's timezone. A jurisdiction with no single timezone (CA, AU,
  FR, PT, several provinces) has `timezone = NULL`, and lookups then require
  an explicit `as_of`.
- **Knowledge time.** `announced_at`, `observed_at`, `approved_at`,
  `published_at`, `activated_at` and `superseded_at` are UTC `timestamptz`.
  A version was known during `[published_at, superseded_at)`, and
  `known_at` queries that interval, so you can see exactly what the registry
  said on an earlier date.
- A future-dated `ACTIVE` version is valid. It appears for an `as_of` on or
  after its `valid_from`, and only for `known_at` at or after its
  publication.

## Guardrails (handoff references)

- **Separate from tenant data (§12.1).** The registry tables hold no tenant
  keys (checked in a test). The public reference responses are explicit
  allow-lists. A test seeds a tenant with a tax ID, legal entity, customer
  and invoice, then asserts none of it reaches `/jurisdictions` or `/rates`.
- **No tenant access to evidence (§09.1, §11.1).** Captured artifacts,
  hashes, storage locations and internal notes appear only on the
  TAX_REVIEWER/TAX_PUBLISHER route. No tenant-facing path exposes an
  artifact, whatever its redistribution permission.
- **Ingestion never writes published tables (§10.1).** Every proposal lands
  in `tax_rate_staging`. Only `publish()` inserts into `tax_rate_versions`.
- **Validation (§10.1 step 4).** A rate must have:
  - a rate in `[0, 100)` with at most 6 decimals, and `valid_from` set;
  - `valid_to > valid_from`;
  - a source with a permanent https URL and a citation, never secondary
    commentary alone;
  - an owner;
  - a valid superseded version, if it declares one.

  Warnings flag missing evidence, UNKNOWN redistribution permission and
  guidance-tier sources.
- **T02, overlaps.** Validation rejects an overlap with an `ACTIVE` version
  of the same (component, tax_code, product_scope): the same rate is a
  duplicate, and a different rate is a conflict. Cumulative components are
  exempt. Postgres adds `EXCLUDE USING gist (component_id =, tax_code =,
  product_scope =, daterange(valid_from, valid_to,'[)') &&) WHERE status =
  'ACTIVE' AND NOT is_cumulative`, `DEFERRABLE INITIALLY DEFERRED`.
  Validation also runs again at submit, approve and publish.
- **T11, conflicts.** A proposal that disagrees with an active version, or
  with another open proposal, becomes `CONFLICT_ESCALATED` and raises an
  `AttentionItem` (source `tax_registry`). It cannot be submitted. The prior
  version stays `ACTIVE` and keeps being served.
- **T04, no rewriting.** A correction or retroactive notice is a new version
  carrying `supersedes_rate_version_id`. Publishing marks the old version
  `SUPERSEDED` and sets `superseded_at` first, then inserts the new version
  with `predecessor_id`, all in one transaction. End-dating is also a new
  version, with `valid_to` set. Immutability is enforced three ways:
  - **ORM guard**, for a clear 409: on `tax_rate_versions`, only `status` and
    `superseded_at` may change, and only from ACTIVE to SUPERSEDED, with no
    deletes. `tax_legal_source_revisions` may only have its evidence fields
    set, once. `tax_source_artifacts` never change.
  - **Postgres triggers** enforce the same rules for `query().update()` and
    raw SQL.
  - **The service** never issues such writes.
- **Maker-checker (§10.1 step 5, §14.1).** This reuses
  `ApprovalService`, whose self-approval check is server-side. In addition,
  the checker and publisher can't be the maker, the stager or the adopter.
  The maker and checker are separate roles, and one account holds one
  platform role.
- **Evidence before approval.** Approval and publication are refused until
  the source has a captured artifact and a redistribution permission other
  than UNKNOWN.
- **MFA step-up.** Approve and publish always require a fresh TOTP or
  recovery code, even though platform-wide step-up is retired
  (`MFA_STEP_UP_ENABLED=false`). The new `TAX_REGISTRY_STEP_UP_REQUIRED`
  (default `true`) enforces it through `verify_step_up(...,
  enforce_when_retired=True)`. The dev-only `MFA_STEP_UP_BYPASS` still
  applies.
- **AI may propose, never publish (§06.2, §12.2).** An `AI_PROPOSAL` row
  can't be submitted until a human TAX_REVIEWER adopts it. Adoption resets it
  to PENDING_REVIEW, so it must be validated again. Only the adopter may
  submit it.
- **Unknown stays unknown.** An empty lookup returns
  `coverage: NO_APPROVED_RATE`. Missing authorities, timezones and rates are
  stored as NULL, never guessed.
- **No compliance claim.** Every rate response carries a disclaimer: it is
  reference information only and is not cleared for production invoicing.

## Seed data — `REFERENCE_ONLY`, all `PENDING_REVIEW`

`python -m scripts.seed_tax_registry --apply` is idempotent and inserts
missing rows only. It approves, activates and publishes nothing.

| | Seeded |
|---|---|
| Jurisdictions | EU (supranational), GB, AU, CA, all 13 Canadian provinces/territories, 27 EU Member States |
| Authorities | HMRC, ATO, CRA, European Commission. EU national administrations are not recorded, because the handoff cites none |
| Components | GB-VAT, AU-GST, CA-GST, five provincial HST, CA-BC/MB/SK-PST, CA-QC-QST, 27 national VAT |
| Source revisions | S9, S10, S11, S12, S16 from the handoff register, evidence `NOT_CAPTURED`, redistribution `UNKNOWN` |
| Staged standard-rate proposals | 35 (GB, AU, CA-GST, 5 × HST, 27 × EU VAT). `valid_from` and `owner` are empty |
| PST/QST | Jurisdictions and components only (`INTERDEPENDENT`, `RULE_PACK_DEFINED`, no authority), no rates, until the tax lead supplies provincial sources |

**A rate is filled in only where the cited page states it.** An automated
check of the cited pages on 2026-11-04 found:

| Source | Finding |
|---|---|
| S9 (EC "VAT rates") | No Member State rate table. It gives only the EU 15% minimum and refers to TEDB [S10] |
| S11 (HMRC) | Lists category treatments but not the standard-rate figure. It links to gov.uk/vat-rates, which is not in the handoff |
| S12 (CRA) | States Ontario 13% HST and Nova Scotia 14% HST (from 1 April 2025) in prose. It gives no GST figure and no NB/NL/PE HST figure in the page text |
| S16 (ATO) | The cited URL is an API endpoint and refused automated retrieval (HTTP 403) |

So only **CA-ON-HST = 13** and **CA-NS-HST = 14** carry a rate. The other 33
proposals carry none, and a reviewer must enter them from the official
source while capturing evidence. These findings are recorded on each source
revision's internal notes. This automated check is not evidence capture.

**Reviewer workflow for a seeded row:**
1. Capture the source artifact (`POST …/source-revisions/{id}/evidence`)
   and record its redistribution permission.
2. Amend the staged row with the rate, `valid_from` from the legal
   instrument, and an owner.
3. Validate, then submit (TAX_REVIEWER).
4. Approve, then publish (a different TAX_PUBLISHER, with MFA).

## Compatibility

No tenant-facing behaviour changes. `LEGACY_MANUAL` invoicing is untouched,
and no invoice path reads the registry. The existing `/api/v1/tax`
legal-entity routes are unchanged. The new reference routes sit on a
separate router without the tenant subscription gate.

`approval_requests` gains a new `request_type` value, `tax_rate_publish`.
The generic super-admin decision endpoint refuses it ("decided on its own
domain endpoint"), so tax approvals can't bypass the registry's checks.

## Migration — `b3d8f2a6c1e4`

This migration chains from `a7c4e1b9d3f0` and leaves a single head
(checked in a test). It uses idempotent `_has_table`/`_has_fk` guards. The
circular staging foreign keys are added after table creation, on Postgres
only. On Postgres it also:

- runs `CREATE EXTENSION IF NOT EXISTS btree_gist`, and fails loudly if the
  role can't create it;
- adds the deferrable EXCLUDE constraint;
- adds three guard functions and triggers.

The Postgres DDL is a frozen copy inside the migration.

**Downgrade** drops all nine registry tables and the guard functions, and
leaves `btree_gist` installed. Export any reviewed registry work first.

There are no new columns on existing tables, so `CRITICAL_COLUMNS` is
unchanged.

**Postgres verification is done in CI**, because no local PostgreSQL was
available. A new CI step runs against the workflow's `postgres:16` service:
`alembic downgrade a7c4e1b9d3f0 → upgrade head`, then
`tests/test_tax_phase1_registry_pg.py` with
`TAX_PG_TEST_URL=$BILLING_DATABASE_URL`. `TAX_PG_TESTS_REQUIRED=1` turns a
missing URL into an error. Those 21 tests cover:

- btree_gist presence, and that the EXCLUDE constraint is deferrable
  initially deferred;
- trigger presence;
- raw SQL and `query().update()` rejected on every immutable field;
- raw DELETE rejected;
- only ACTIVE → SUPERSEDED (with `superseded_at`) allowed;
- overlapping ACTIVE rows rejected; adjacent, superseded and cumulative rows
  allowed;
- a correction covering the same interval, inserted before the old version
  is superseded, in one transaction;
- the pipeline correction path;
- source revision and artifact freezes.

Elsewhere (SQLite, local) they skip with the reason
`TAX_PG_TEST_URL is not set`.

**CI result:** run 41774147615 on commit 89670fe passed the postgres:16
service steps: `alembic upgrade head`, the downgrade → upgrade round trip,
and all 21 PG-only tests. Phase 0 (run 41769879247 on 5198104) had already
applied `a7c4e1b9d3f0` on the same service.

## Test evidence

| Suite | Before | After |
|---|---|---|
| Backend local (`pytest tests/ --ignore=tests/ai_assistant`, SQLite, Windows) | 1667 passed, 1 failed | 1709 passed, 4 failed, 21 skipped* |
| Backend CI release gate (`postgres:16` service) | passed, 0 failures (run 41769879247) | passed, 0 failures (run 41774147615) |
| CI tax registry PG step (round trip + 21 PG-only tests) | — | passed |
| Frontend CI (vitest + build) | passed | passed |

\* The local full run predates two late tests, so it counts 45 of the 47
new SQLite tests. The 21 skips are the PG-only module (`TAX_PG_TEST_URL`
unset). The local failures are environmental or flaky, not regressions:
- `test_stripe_plane2_phase_gaps::test_pinned_version_matches_installed_sdk_default`
  fails on both trees (local stripe SDK version; see finding 6).
- Three tests in `test_aggregate_cache.py` (dashboard cache invalidation)
  fail depending on run order and timing. The same failure reproduces on the
  Phase 0 tree with the same ordered subset (`tests/privacy/*` then
  `test_aggregate_cache.py`), and the tests pass in isolation and in CI.

New: `backend/tests/test_tax_phase1_registry.py` (47 tests, SQLite) and
`backend/tests/test_tax_phase1_registry_pg.py` (21 tests, Postgres-only).

## Findings

1. **Cited sources rarely state the rates** (see the seed section). S11,
   S9 and S16 don't give the figures we need, and S12 gives only two.
   Sourcing the figures (for example gov.uk/vat-rates, TEDB, an ATO public
   page, or national legal publications) needs a tax-lead decision before
   Phase 2 pilots.
2. **MFA step-up is retired platform-wide** (`MFA_STEP_UP_ENABLED=false`,
   MFA UI removed). Tax approve/publish still demand it, so TAX_PUBLISHER
   accounts must enrol through the retained MFA endpoints before they can
   publish anything.
3. **No blob storage exists in the platform.** Evidence artifacts live in
   `tax_source_artifacts` (Postgres `bytea`, 25 MB cap), addressed as
   `db://tax_source_artifacts/<sha256>`. Object storage with retention
   controls should replace this before high-volume ingestion.
4. **Import cycle (Phase 0).** Importing `app.modules.tax.legal_entity_service`
   before the billing services fails, because `legal_entity_service` →
   `billing.services` → `invoice_service` → `legal_entity_service`. It works
   today only because of import order in `main.py` and the Phase 0 tests.
   Not changed here.
5. **Jurisdiction timezones** were set only for single-zone jurisdictions
   and should be confirmed by a reviewer. They decide the legal calendar
   for `as_of` (T03/T17).
6. **Local baseline differs from TAX_PHASE0.md.** On this machine the four
   "pre-existing" failures pass, and they also passed in CI.
   `test_stripe_plane2_phase_gaps::test_pinned_version_matches_installed_sdk_default`
   fails locally only, because the installed `stripe` 15.5.0 bundles API
   `2026-07-29.dahlia` against the pinned `2026-08-26.dahlia`. This is an
   environment difference, unrelated to tax.
7. **Flaky dashboard cache tests (pre-existing).** `test_aggregate_cache.py`
   can fail after `tests/privacy/*` on a slower machine. This reproduces on
   Phase 0 code, and CI is unaffected. Not changed here.

The four Phase 0 findings (email-send kill switch, dead `resolve_tax`
branch, discounts after tax, `TaxPricing`/`TaxGroup` duplication) are still
open and untouched.

## Next: Phase 2 — Bounded determination

Per-entity jurisdiction activation records (`TENANT_CONFIG_APPROVED` /
`PROVIDER_APPROVED`), `LegalEntityTaxProfile` registrations, a quote
contract over approved registry versions, and the first golden cases
(T01, T03, T05, T06, T12, T17).
