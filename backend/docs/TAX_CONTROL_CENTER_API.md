# Tax Control Center — API Contract for Gaps B1 and B3

The backend for the Tax Control Center frontend (plan:
`TAX_PHASE4_PLAN.md`, "Tax Control Center UI"). It contains two gaps:

- **B1:** the approvals inbox.
- **B3:** additive cursor pagination.

**B2** (an admin API for jurisdictions and components) is **deferred**.
Jurisdictions stay seed- or migration-only, with review.

All routes require a login. Platform routes are under
`/api/v1/super-admin/tax-registry` and require platform capabilities; they
carry no tenant data. Tenant routes are under `/api/v1/tax` and are scoped
to the caller's organization; super-admin tokens are refused.

## B3 — pagination contract

Applies to every list endpoint below.

**Request (query parameters):**

| Param | Type | Default | Notes |
|---|---|---|---|
| `limit` | int, 1–200 | 50 | Page size |
| `cursor` | string, opaque | none | The `next_cursor` of the previous page |

**Response:** every existing field is kept, plus `next_cursor`.

```json
{ "items": [ ... ], "next_cursor": "eyJhZnRlciI6IDQyfQ" }
```

**Rules:**
- `next_cursor` is `null` on the last page. Keep requesting with
  `cursor=<next_cursor>` until it is `null`.
- Order is unchanged per endpoint. The cursor continues after the last item
  of the previous page.
- **Errors:**
  - A malformed cursor, or one whose item no longer exists, returns `400`;
    restart from the first page.
  - `limit` over the maximum returns `422`.
- An old client that sends neither parameter gets the first 50 items and
  the same fields as before, plus `next_cursor`.

**Endpoints:**

| Endpoint | Existing fields | Notes |
|---|---|---|
| `GET /api/v1/super-admin/tax-registry/source-revisions` | `items` | |
| `GET …/tax-registry/staged-rates` | `items`, `total` | **Keeps its own** `skip` and `limit` (default 100, max 500); `cursor` added. With a cursor, `skip` is ignored. `total` counts all matching rows. |
| `GET …/tax-registry/market-availability?status=` | `items` | |
| `GET …/tax-registry/tax-code-sets` | `items` | |
| `GET …/tax-registry/rule-packs` | `items` | |
| `GET …/tax-registry/approvals-inbox` | new (B1) | |
| `GET /api/v1/tax/jurisdictions?country=&level=&parent_code=` | `items` | Reference read; ordered by code |
| `GET /api/v1/tax/legal-entities?include_inactive=` | `items` | Ordered: default first, then code |
| `GET /api/v1/tax/registrations?seller_entity_id=` | `items` | |
| `GET /api/v1/tax/legal-bases` | `items` | |
| `GET /api/v1/tax/activations?seller_entity_id=` | `items` | |
| `GET /api/v1/tax/product-classifications?product_id=` | `items` | |
| `GET /api/v1/tax/review-items?include_resolved=` | `items` | Ordered by due date, then id |
| `GET /api/v1/tax/exceptions` | `items`, `count`, `checked` | **Keeps its own** `limit` (default 200, max 500). `limit` caps the governed drafts checked per page; `count` and `checked` describe this page. `cursor` added. |

**Not paginated:**
- `GET /rule-packs/catalogue` (code-defined, small);
- `GET /api/v1/tax/tax-codes` (one active code set);
- `GET /api/v1/tax/rates` (a lookup for one jurisdiction);
- `GET /provider-health` and `/readiness` (aggregates).

## B1 — approvals inbox

```
GET /api/v1/super-admin/tax-registry/approvals-inbox
    ?kind=staged_rate|tax_code_set|rule_pack|market_availability   (optional)
    &limit=50&cursor=...                                            (B3)
```

**Who:**
- Platform tax roles only (`tax_registry.read`): TAX_REVIEWER and
  TAX_PUBLISHER.
- Everyone else gets `403`: other platform roles, including
  PLATFORM_ADMINISTRATOR, and all tenant users.

**What:** every platform change in `IN_APPROVAL`, oldest submission first
(ties: kind, then id).

**Response `200`:**

```json
{
  "items": [
    {
      "kind": "market_availability",
      "id": 12,
      "title": "GB VAT B2C_GOODS -> REFERENCE_ONLY",
      "submitted_by": 7,
      "submitted_at": "2026-11-05T09:14:03.120000+00:00",
      "can_approve": true,
      "reason_if_not": null
    },
    {
      "kind": "staged_rate",
      "id": 31,
      "title": "GB-VAT STANDARD/GENERAL 21% from 2026-12-01",
      "submitted_by": 9,
      "submitted_at": "2026-11-05T09:20:44.000000+00:00",
      "can_approve": false,
      "reason_if_not": "You prepared or submitted this change; a different person must approve it."
    }
  ],
  "next_cursor": null
}
```

| Field | Meaning |
|---|---|
| `kind` | `staged_rate`, `tax_code_set`, `rule_pack` or `market_availability` |
| `id` | The id within its kind; actions go to the existing routes (`/staged-rates/{id}/approve`, `/tax-code-sets/{id}/approve`, `/rule-packs/{id}/approve`, `/market-availability/{id}/approve`) |
| `title` | Human-readable summary; platform data only |
| `submitted_by` | User id of the maker or submitter (a platform user) |
| `submitted_at` | ISO-8601, UTC |
| `can_approve` | Whether **the caller** may approve |
| `reason_if_not` | `null` when `can_approve` is true |

**`can_approve` is false** when:
- the caller lacks `tax_registry.approve` (a TAX_REVIEWER). The reason is
  "Your role cannot approve tax registry changes (TAX_PUBLISHER only).";
- or the caller authored, submitted or (for AI proposals) adopted the
  change. The reason is "You prepared or submitted this change; a different
  person must approve it."

The approve routes still enforce both rules, and the inbox only reflects
them. Approve and publish need MFA step-up (`code` or `recovery_code` in the
body), as before.

**No tenant data:** items carry no organization, customer or invoice
fields. A test asserts this against a tenant with invoices.

## Tests

`tests/privacy/test_tax_control_center_api.py` (24) covers:
- maker-checker per item;
- reviewers can't approve;
- platform data only;
- tax roles only (other platform roles and tenant users get 403);
- inbox pagination and the kind filter; invalid cursor 400; limit over 200
  gives 422;
- old clients get the same fields plus `next_cursor` (four platform lists,
  six tenant lists, jurisdictions);
- full page-through equals the unpaged list;
- staged-rates keeps `skip`/`limit`/`total`;
- exceptions keeps its `limit` and pages by cursor.
