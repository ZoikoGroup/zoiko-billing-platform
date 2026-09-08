# Migration Readiness Checklist — optimistic-lock `version` columns

**Status:** READY-FOR-REVIEW ONLY — **do NOT execute**. This document is for the
person who runs deployments. Neither the agent nor any automated pass runs
`alembic upgrade` or touches the real Neon database.

Target: **real Neon (PostgreSQL)** tenant database (org 49/XYZ + all tenants).
This holds real tenant data — schema changes go through your team's normal
backup / staging / rollback process, not an ad-hoc run.

---

## Scope — what needs to be applied

Two changes share the same deployment event because they are the same feature
(optimistic-lock `version` columns) and must be applied together for the
CRIT-Q17 guard to have any real effect.

### Migration A — CRIT-Q17 (already written, not applied)
- File: `backend/alembic/versions/b5e2f8c0d3a1_add_version_to_billing_customers_and_configs.py`
- Revision: `b5e2f8c0d3a1` (down_revision `a3c7e91f4d28`)
- DDL:
  - `ADD COLUMN version INTEGER` to `billing_customers` (nullable → backfill 1 → `SET NOT NULL`)
  - `ADD COLUMN version INTEGER` to `billing_configurations` (nullable → backfill 1 → `SET NOT NULL`)
- `server_default = 1` guarantees backfill; then `NOT NULL` enforced.

### Migration B — CRIT-Q17b (author: `c7d1a9b3f2e4`, NOT applied)
- File: `backend/alembic/versions/c7d1a9b3f2e4_add_version_not_null_to_price_lists.py`
- Revision: `c7d1a9b3f2e4` (down_revision `b5e2f8c0d3a1`)
- `PriceList.version` changed in code to `nullable=False, default=1, server_default="1"`.
  The existing column is `INTEGER` (nullable, default only at ORM layer) — a DDL
  migration is REQUIRED to backfill any NULLs and set `NOT NULL` so it matches the
  model and the repository bump logic.
- DDL (Postgres branch): `version` **already exists**, so it does NOT `ADD COLUMN`;
  it `SET DEFAULT 1` → backfills NULLs → 1 → `SET NOT NULL`. SQLite branch is a
  no-op (SQLite dev/test DBs build via `create_all`, and Alembic never runs against
  them — see "Deployment path note" below).
- Chains on top of `b5e2f8c0d3a1` (Migration A). Apply A first, then B, in the
  same deploy.

> Both A and B are written but **not applied to any database** (including
> staging/prod Neon). They are reviewable artifacts only.

---

## Rows on affected tables (MEASURED 2026-09-04, live read-only)

Run on a **read replica or during low traffic** (avoid load on primary):
```sql
SELECT 'billing_customers'      AS t, count(*) FROM billing_customers
UNION ALL SELECT 'billing_configurations', count(*) FROM billing_configurations
UNION ALL SELECT 'price_lists',            count(*) FROM price_lists;
```
**Actual measured values (read-only query against live Neon, this session):**

| table | row count | total size |
|-------|----------:|-----------:|
| `billing_customers` | **32** | 128 kB |
| `billing_configurations` | **55** | 336 kB |
| `price_lists` | **3** | 112 kB |

- All three tables are **tiny** (3–55 rows, ≤336 kB total). This is what the
  per-tenant design predicts: one config per org, only a handful of price lists,
  and only actively-billed customers.
- Because row counts are so small, every downstream claim below (lock duration,
  rewrite/scan cost) is **effectively instant**. The numbers above are real, not
  estimates.
- The `UPDATE ... SET version = 1 WHERE version IS NULL` only touches NULL rows
  (Postgres materializes `DEFAULT 1` at `ADD COLUMN` time, so there may be zero),
  so the heavy step is the `SET NOT NULL` verification, which is proportional to
  **table size**, not the number of NULLs.

---

## Expected lock / downtime (MEASURED target: Postgres 18.6 + tiny tables)

- **Target Postgres version (measured live):** Neon is on **PostgreSQL 18.6**
  (`server_version_num` 180006) as of 2026-09-04.
- **`SET NOT NULL` behavior on PG 18:** this does **NOT rewrite the heap / create a
  new table file**. It takes an `ACCESS EXCLUSIVE` lock and performs a scan of the
  column purely to verify no NULLs remain. Because both A and B backfill to a
  non-NULL value first (Migration A via `ADD COLUMN ... DEFAULT 1`; Migration B via
  explicit `SET DEFAULT 1` + backfill), every row is non-NULL before the `SET NOT
  NULL`, so the verification scan finds zero NULLs and completes quickly.
- With **32 / 55 / 3 rows and ≤336 kB** per table, that verification scan is
  **effectively instantaneous** (sub-millisecond to a few ms) — not "ms-to-seconds
  on a rewrite", because there is no rewrite at all.
- **Lock caveat that still applies:** `SET NOT NULL` holds `ACCESS EXCLUSIVE` for
  its duration, so it blocks concurrent reads/writes *to that table* during the
  ALTER. On tables this small the lock window is negligible, but the principle
  stands — run it during low traffic and don't hold unrelated transactions open.
- `billing_configurations` is written by CRUD + the FX refresh (automatic);
  `price_lists` by pricing edits; `billing_customers` by customer edits + balance
  recalc. Expect a (very brief) write stall on each table while its ALTER runs.
- Safe template: run each statement on its own so per-table lock time is minimal;
  do NOT wrap the whole migration in one long transaction if that's avoidable.

---

## Backup step (mandatory)

1. Take a Postgres logical/physical backup of the affected database immediately
   before the migration:
   - `pg_dump -Fc` (logical) or your normal nightly snapshot as the baseline,
     PLUS a fresh pre-migration dump taken right before the change.
   - Verify the backup restores (size > 0, restore to a scratch DB) before
     proceeding — a backup you haven't verified doesn't count.
2. Ensure the DB user running `alembic upgrade` has DDL + `UPDATE`/`SELECT`
   privileges on the three tables and on `alembic_version`.
3. Optionally snapshot tables directly for a surgical restore:
   ```sql
   CREATE TABLE billing_customers_version_backup AS SELECT * FROM billing_customers;
   -- repeat for billing_configurations, price_lists
   ```

---

## Rollback command

- Standard Alembic down:
  ```bash
  alembic downgrade b5e2f8c0d3a1   # from Migration B -> back to A applied
  alembic downgrade a3c7e91f4d28   # from A -> back to pre-version state
  ```
- This drops the `version` columns. Only valid as a rollback of an **unreleased**
  change — do not run it after any code that reads `version` is live on the same
  DB (your code and schema must move together).
- If a row-level restore is needed instead (e.g. backfill corrupted data), use
  the `*_version_backup` snapshots above — but the migration is purely additive
  (backfill-to-1 + NOT NULL), so destructive-or-broken states are unlikely.

---

## Low-traffic window (suggested)

- **Off-peak** for the org's primary operating region — e.g. weekends or
  02:00–05:00 local, avoiding the daily billing/recurring run and any scheduled
  FX/dunning jobs, since those write `billing_configurations` and `price_lists`.
- Confirm no long-running ETL / report jobs touch these three tables at that time.
- Pause or queue any automatic FX refresh / balance recalc job for the brief
  window so the `ACCESS EXCLUSIVE` ALTER isn't blocked by a long transaction.

---

## Pre-flight checklist (run in staging first)

- [ ] Migration A (`b5e2f8c0d3a1`) and Migration B (`price_lists`) both render
      cleanly: `alembic upgrade head --sql` in **staging** shows the expected
      `ADD COLUMN`/`ALTER` for the three tables.
- [ ] Fresh Staging DB seeded with a representative copy (incl. org 49) applies
      both migrations with no errors and `version` backfilled to 1 everywhere.
- [ ] Row-count estimates gathered (above) and lock-time expectation confirmed on
      staging at production-like volume.
- [ ] Backup verified restorable.
- [ ] After apply in staging: insert/update a customer, config, and price list
      and confirm `version` increments 1→2 via the repos (matches the unit tests).
- [ ] Document the concrete `alembic upgrade` command + the exact rollback
      command in your change request before the production window.

---

## Post-apply verification (production)

```sql
-- all three tables: no NULLs, no zeroes, sensible distribution
SELECT t, count(*) FILTER (WHERE version IS NULL) AS nulls,
       min(version), max(version)
FROM (SELECT 'billing_customers' t, version FROM billing_customers
      UNION ALL SELECT 'billing_configurations', version FROM billing_configurations
      UNION ALL SELECT 'price_lists', version FROM price_lists) x
GROUP BY t;
-- expect max(version)=1 for untouched rows (or >1 where post-deploy writes ran)
```
Confirm `alembic_version` shows the head revision for both A and B.

---

## Notes

- **CRIT-Q17 / CRIT-Q17b are "resolved in code" but have ZERO effect on
  production until this migration actually runs.** Until then, production rows
  have no live `version` column to read or bump, so the guard is inert against
  real data.
- The migration files are reviewable artifacts only; no database (including
  staging/prod Neon) was modified by the QA session.

## Deployment path note — SQLite no-op (Migration B)

Migration B's SQLite branch is a no-op. Verified this is **safe for every
sanctioned path**: docker-compose runs `alembic upgrade head` against Postgres 16
(`BILLING_DATABASE_URL=postgresql+psycopg://...`), the `.github/workflows/deploy.yml`
CI does not run Alembic (it restarts the Postgres-backed service), and the
SQLite development fallback builds schema via `Base.metadata.create_all()`, not
Alembic. So no repo-wired dev/staging/CI/docker/docs path runs the migration
against SQLite, and no NOT NULL enforcement is silently skipped there.

**One dev-caveat to keep in mind:** `alembic/env.py` feeds `resolve_database_url()`
into the migration URL, and that helper *can* return `sqlite:///...billing_dev.sqlite3`
when `BILLING_DATABASE_URL` is unset in a dev env (`ENVIRONMENT`/`DEBUG`).
A developer who **manually** runs `alembic upgrade head` locally with no
`BILLING_DATABASE_URL` would target the SQLite file, where Migration B's NOT NULL
is a no-op (Migration A *does* enforce it there). This is a latent footgun, not an
active deployment path — if you ever run Alembic by hand in a bare dev env, set
`BILLING_DATABASE_URL` first (or accept that `price_lists.version` NOT NULL is not
enforced on the throwaway SQLite file).
