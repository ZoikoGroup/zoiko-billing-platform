# Global Tax — Phase 0: Foundation

Implements the first slice of **ZB-TAX-ARCH-001** (Global Tax Intelligence &
Determination Framework). Phase 0 adds no tax calculation. It lays the
vocabulary, ownership model and data precision every later phase depends on,
without changing how existing tenants invoice today.

## What changed

**Tax domain module** — `backend/app/modules/tax/`

| File | Purpose |
|---|---|
| `enums.py` | Canonical taxonomy: `TaxOutcome` (incl. `NOT_DETERMINED` as an error state, never a rate), `TaxQuoteStatus`, `TaxOperatingMode`, `EntityTaxRegime`. |
| `models.py` | `SellerLegalEntity` — the issuing legal entity that owns registrations and obligations (§02, §07). |
| `legal_entity_service.py` | Tenant-scoped lifecycle with audit logging and guardrails (below). |
| `router.py` / `schemas.py` | `GET/POST /api/v1/tax/legal-entities`, `GET/PATCH/DELETE /api/v1/tax/legal-entities/{id}`, `POST …/{id}/set-default`. |

**Invoices** gain `seller_entity_id` and `tax_date`.
`create_invoice` assigns the requested entity (validated as the tenant's own
and active) or the org default. Both issuance paths (`finalize_invoice`,
`send_invoice_via_email`) stamp a missing entity and, under the legacy regime,
set `tax_date = issue_date` — the tax point the existing code already assumed.

**Precision** — all eight tax rate / tax percentage columns move from
`NUMERIC(5,2)` to `NUMERIC(9,6)` (§07), so rates such as 8.875% are stored
exactly. Rate inputs in the UI accept up to 6 decimals and display via
`formatTaxRate()` instead of rounding to 2 places.

**Bootstrap** — every organization gets one default entity (`PRIMARY`) from its
profile: at self-registration, at super-admin provisioning, and via the
migration backfill for existing tenants. A partial unique index enforces one
default per organization.

## Guardrails (handoff references)

- **Tenant isolation (§12.1, T13).** All tax routes resolve the tenant through
  `get_organization_id`, which refuses super-admin tokens. Another tenant's
  entity is indistinguishable from a missing one.
- **No activation by toggle (§05, T12).** `tax_regime = governed` is refused
  from settings; it will require approved jurisdiction activation records
  (Phase 2).
- **No retroactive re-attribution.** An entity's country/subdivision is locked
  once it has issued invoices; register a new entity instead.
- **Unknown stays unknown.** An unrecognized org country yields a null
  `country_code`, not a guess.

## Compatibility

Existing tenants stay on `LEGACY_MANUAL`: the current per-line percentage
calculation is unchanged. No invoice is blocked by Phase 0. The governed,
fail-closed pipeline arrives in Phase 3 and is opted into per entity.

## Migration — `a7c4e1b9d3f0`

Verified on PostgreSQL 16 against seeded pre-Phase-0 data: backfill of
entities and invoice attribution, `tax_date` on issued (not draft) invoices,
partial-unique default, FK enforcement, 8.875% round-trip, downgrade/upgrade
round-trip, re-run idempotency, and zero autogenerate drift on Phase 0
objects.

**Downgrade warning:** narrowing back to `NUMERIC(5,2)` rounds any rate stored
with more than two decimals. Export such rows first.

New invoice columns are registered in `CRITICAL_COLUMNS`, so a database that
missed this migration fails startup loudly.

## Test evidence

| Suite | Before | After |
|---|---|---|
| Backend (`pytest tests/ --ignore=tests/ai_assistant`) | 1635 passed, 4 failed | 1664 passed, 4 failed |
| Frontend tax module (`vitest src/modules/billing/tax`) | — | 13 passed |
| Frontend touched modules (invoicing, products, contracts, subscriptions, pricing) | — | 231 passed* |
| `npm run build` | — | passes |

The four backend failures are pre-existing and identical before and after
(`test_email_t0_security::test_ops_t0_alerts_route_to_internal_channels` and
three in `test_super_admin_bugs.py`).
\* One wizard test hit vitest's 5 s timeout under a 2-worker run; it passes
6/6 when run alone with CI's single-worker settings.

New: `backend/tests/test_tax_phase0_legal_entities.py` (29 tests),
`frontend/src/modules/billing/tax/tax-helpers.format.test.js` (3 tests).

## Findings outside Phase 0 scope (not changed)

1. `send_invoice_via_email` issues invoices without the super-admin
   finalization kill-switch check that `finalize_invoice` enforces.
2. The `resolve_tax` branch in `create_invoice` is unreachable:
   `filter_allowed` drops `resolve_tax` and `items` before they are read. If
   revived as written it would fail open (summing every active org rate).
3. Document-level discounts are applied after tax, so tax is computed on the
   pre-discount base (to be fixed with T09 in Phase 3).
4. `TaxPricing`/`TaxGroup` are not used by invoice calculation; they duplicate
   `TaxRate`. Consolidation is proposed for Phase 2.

## Next: Phase 1 — Global Tax Reference Registry

Non-tenant reference tables (jurisdiction hierarchy, tax types/components,
bitemporal `RateVersion`, `LegalSourceRevision` with SHA-256), staging and
two-person publication, read-only `/api/v1/tax/jurisdictions`, `/rates`,
`/source-revisions`, and REFERENCE_ONLY seed data for UK, Australia, Canada
and EU. Targets T02, T04, T11.
