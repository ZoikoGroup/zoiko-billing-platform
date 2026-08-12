# Create All — schema bootstrap

The standalone Billing Platform has **no alembic**. Schema is created fresh,
in one shot, via `Base.metadata.create_all` against an **empty** database.
This directory is that bootstrap.

## When to run

| Scenario | Action |
|---|---|
| First-time setup on an empty Postgres DB | `python -m migrations.create_all.create_all` |
| Dev with no `BILLING_DATABASE_URL` set | same command — falls back to SQLite at `app/data/billing_dev.sqlite3` |
| Wipe + recreate a scratch/dev DB | `python -m migrations.create_all.create_all --drop` |

`initialize_database()` in `app/database.py` already calls the same
`create_all` on app startup (`/health` / lifespan), so running this script is
optional for dev — it exists as the documented, repeatable bootstrap and for
CI/staging provisioning.

## Table inventory (created by this bootstrap)

Every table is registered by importing the model modules at the bottom of
`app/database.py`:

- **Auth / users** — `users`, `security_action_tokens`
- **Organizations** — `organizations`
- **Super Admin** — `platform_settings` (key/value platform config, e.g. SMTP override)
- **Billing** — every table defined in `app/modules/billing/models.py`
  (customers, products, invoices, quotes, contracts, subscriptions, payments,
  credit notes, write-offs, refunds, dunning/collections cases, tax &
  pricing config, audit log, etc.)

## Post-bootstrap seeds

```sh
set SETUP_KEY=...            # required
set BILLING_SUPER_ADMIN_EMAIL=admin@example.com
set BILLING_SUPER_ADMIN_PASSWORD=...
python -m scripts.seed_super_admin

python -m scripts.seed_org   # demo org + org_admin
```

## Schema changes

Any model change takes effect on the next `create_all` run **only for a
fresh/empty database**. On a DB that already has data, `create_all` is
additive (new tables/columns are created; existing columns are not altered).
There is no destructive migration — that is a deliberate trade-off for this
standalone build.
