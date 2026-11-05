# Tax Control Center — API Contract (B1, B3, Phase 4a-2, Phase 4c)

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

## Behaviour change for external API clients (B3)

Twelve list endpoints used to return **every** row. Since PR #134 they
return **at most 50 by default** (up to 200 with `limit`), and the rest
through `next_cursor`. No current frontend called them, so nothing in the
product broke. **External or scripted API clients must follow `next_cursor`
until it is `null`.**

| Endpoint | Previously | Now |
|---|---|---|
| `GET /api/v1/super-admin/tax-registry/source-revisions` | all rows | 50 by default |
| `GET /api/v1/super-admin/tax-registry/market-availability` | all rows | 50 by default |
| `GET /api/v1/super-admin/tax-registry/tax-code-sets` | all rows | 50 by default |
| `GET /api/v1/super-admin/tax-registry/rule-packs` | all rows | 50 by default |
| `GET /api/v1/tax/jurisdictions` | all rows | 50 by default |
| `GET /api/v1/tax/legal-entities` | all rows | 50 by default |
| `GET /api/v1/tax/registrations` | all rows | 50 by default |
| `GET /api/v1/tax/legal-bases` | all rows | 50 by default |
| `GET /api/v1/tax/activations` | all rows | 50 by default |
| `GET /api/v1/tax/product-classifications` | all rows | 50 by default |
| `GET /api/v1/tax/review-items` | all rows | 50 by default |
| `GET /api/v1/tax/exceptions` | 200 drafts checked | unchanged default (200), plus `cursor` |

`staged-rates` keeps its previous `skip` and `limit` (default 100). New
screens must page with `next_cursor`.

## Phase 4a-2 endpoints (tenant, `/api/v1/tax`)

These are tenant-only: platform tokens get `403` (T13). Every list follows
the B3 contract (`limit`, `cursor` → `items`, `next_cursor`). Approvals follow
the existing tenant two-person rule: proposers are `org_admin` or
`billing_admin`; approvers are `finance_approver` and never the proposer.

### Provider connections (T-screen: Provider Connections)

```
GET  /provider-connections?seller_entity_id=&limit=&cursor=     -> {items: [Connection], next_cursor}
GET  /provider-connections/{id}                                 -> Connection
POST /provider-connections                    (billing admin)   -> 201 Connection
     {"seller_entity_id": 3, "provider_name": "avatax", "environment": "SANDBOX", "mode": "COMMIT"}
POST /provider-connections/{id}/approve       (finance approver, not the proposer)  {"reason": null} -> Connection
POST /provider-connections/{id}/reject        (finance approver)                    {"reason": "..."} -> Connection
POST /provider-connections/{id}/withdraw      (billing admin)                                        -> Connection
PUT  /provider-connections/{id}/credentials   (billing admin)   {"secret": "..."}    -> Connection   (write-only)
POST /provider-connections/{id}/credentials/revoke (billing admin) {"reason": "leaked"} -> Connection (SUSPENDED)
POST /provider-connections/{id}/resume        (billing admin; new credentials set first)             -> Connection
POST /provider-connections/{id}/resume-approve (finance approver, not the requester)                 -> Connection
POST /provider-connections/{id}/resume-reject  (finance approver)                                    -> Connection
POST /provider-connections/{id}/test          (billing admin; allowlisted endpoint only)             -> Connection
```

**Request fields:**
- `environment`: `SANDBOX` or `PRODUCTION`.
- `mode`: `ESTIMATE_ONLY` or `COMMIT`.

Any other field is refused with `422`. That includes `base_url`, `endpoint`,
`url` and `host`: **the endpoint comes from a code-defined allowlist per
provider and environment.**

**Connection:**

```json
{
  "id": 7, "seller_entity_id": 3, "provider_name": "avatax", "environment": "SANDBOX", "mode": "COMMIT",
  "status": "APPROVED", "proposed_by": 11, "approved_by": 12, "approved_at": "2026-11-05T10:01:00+00:00",
  "decision_reason": null, "suspended_reason": null, "resume_requested_by": null,
  "credentials": {"present": true, "last_rotated_at": "2026-11-05T10:00:00+00:00", "last4": "9999",
                  "store": "gcp", "rotation_pending_test": false},
  "health": {"ok": true, "checked_at": "2026-11-05T10:02:00+00:00", "detail": "reachable"},
  "created_at": "...", "updated_at": "..."
}
```

**Status:** `PROPOSED`, `APPROVED`, `REJECTED`, `WITHDRAWN` or `SUSPENDED`.

**Credentials are never returned**: only `present`, `last_rotated_at`, the
masked `last4`, `store` (`fernet` or `gcp`) and `rotation_pending_test`
(Phase 4d-0). Setting, rotating and revoking them are all audited.

`rotation_pending_test: true` means a rotation is waiting for a successful
**Test connection**, after which the previous version is disabled. Prompt
for it.
Revoking makes the connection `SUSPENDED`. Quotes and issuing through it then
fail closed until two people resume it.

**Production credentials** are refused (`400`) until the managed secret store
exists (4d gate).

**`test`** records `health`. It never echoes a credential. When the secret
store is unreachable or denies access, quotes are `PROVIDER_UNAVAILABLE` and
revoking still suspends but returns `400` asking to revoke again.

### Activations: a new field

`POST /activations` accepts `provider_connection_id`. It is required when
`mode` is `PROVIDER_APPROVED` and refused for other modes. The activation
response includes it.

A provider activation is approvable only when its connection is `APPROVED`,
has credentials, and belongs to the same seller entity. A provider market is
therefore approved three times, each by two people:
1. the platform market;
2. the tenant connection;
3. the tenant activation.

### Exemption certificates

```
GET  /exemption-certificates?customer_id=&limit=&cursor=        -> {items: [Certificate], next_cursor}
POST /customers/{id}/exemption-certificates  (billing admin)   + optional "reason_code": "RESALE"
POST /exemption-certificates/{id}/evidence   (billing admin)   multipart: file=<PDF|PNG|JPEG>, sha256=<optional hex>
     -> Certificate     400: wrong type, signature mismatch, empty, over the size limit, hash mismatch, already attached
GET  /exemption-certificates/{id}/evidence                      -> the file (Content-Type as stored;
                                                                   X-Content-SHA256; Cache-Control: no-store)
```

**Certificate:**

```json
{"id": 4, "certificate_number": "EX-1", "jurisdiction_id": 1, "tax_type_id": null, "scope_description": "Charity",
 "valid_from": "2026-01-01", "expires_at": null, "evidence_ref": "file", "status": "ACTIVE",
 "reason_code": "CHARITY", "evidence_attached": true, "created_at": "...", "revoked_at": null}
```

**Evidence storage:**
- write-once per certificate;
- content-addressed per tenant;
- size limit `TAX_EVIDENCE_MAX_BYTES` (5 MB);
- never served to platform roles.

### Regime changes (product question 6)

```
POST /legal-entities/{id}/regime   (org admin)   {"tax_regime": "governed"|"legacy_manual", "reason": "..."}
     -> 201 RegimeChange (PROPOSED)       400: already that regime / not qualified / one already open
GET  /regime-changes?seller_entity_id=&limit=&cursor=           -> {items: [RegimeChange], next_cursor}
POST /regime-changes/{id}/approve   (finance approver, not the proposer)   -> RegimeChange (applies it)
POST /regime-changes/{id}/reject    (finance approver)                     -> RegimeChange
POST /regime-changes/{id}/withdraw  (org admin)                            -> RegimeChange
```

**RegimeChange:**

```json
{"id": 2, "seller_entity_id": 3, "from_regime": "GOVERNED", "to_regime": "LEGACY_MANUAL", "reason": "pilot ended",
 "status": "APPROVED", "proposed_by": 10, "approved_by": 12, "approved_at": "...", "decision_reason": null,
 "created_at": "...", "eligibility_at_proposal": {"would_qualify": true, "...": "..."}}
```

**Behaviour change:**
- `POST /regime` with `governed` used to switch immediately. It now
  **proposes**, in both directions.
- The settings toggle (`PATCH /legal-entities/{id}`) refuses changing a
  GOVERNED entity's regime.

### Provider transactions (stuck-transaction view)

```
GET  /provider-transactions?state=&operation=&limit=&cursor=    -> {items: [Transaction], next_cursor}   (newest first)
GET  /provider-transactions/{id}                                -> Transaction
POST /provider-transactions/{id}/check-state   (billing admin)  -> {"transaction": Transaction, "provider": {...}}  read-only
POST /provider-transactions/{id}/retry         (billing admin)  -> Transaction   (ROW_ERROR / UNRESOLVED_COMMIT only)
POST /provider-transactions/{id}/void-request  (billing admin)  -> Transaction   (committed, needs review)
POST /provider-transactions/{id}/void-approve  (finance approver, not the requester) -> Transaction (never-sent only)
```

**Filter values:**
- `state`: `PENDING`, `UNCERTAIN`, `REMOTE_COMMITTED`, `DONE`, `FAILED`,
  `VOIDED`, `CANCELLED` or `REVIEW_REQUIRED`.
- `operation`: `COMMIT`, `ADJUST`, `VOID`, `EMAIL` or `LINK`.

**Transaction:**

```json
{"id": 15, "operation": "COMMIT", "state": "REVIEW_REQUIRED", "provider_name": "avatax", "provider_connection_id": 7,
 "invoice_id": 41, "invoice_number": "INV-0041", "credit_note_id": null, "review_kind": "UNRESOLVED_COMMIT",
 "review_reason": "...", "last_error": "...", "attempts": 3, "age_seconds": 1260, "grace_deadline": "...",
 "next_attempt_at": "...", "provider_transaction_id": null, "verified": false, "send_requested": true,
 "void_requested_by": null, "created_at": "...", "completed_at": null}
```

**`check-state` → `provider`:** either
`{"available": true, "provider": {"state": "COMMITTED", "total_tax": "10.00", ...}}`
or `{"available": false, "detail": "..."}`.

`GET /exceptions` and `GET /invoices/{id}/tax-summary` (the `issuance`
block) keep showing provider issuing that is overdue or needs review, with
owner and age.

## Phase 4c endpoints (tenant, `/api/v1/tax`)

Phase 4b (Canada) adds no endpoints. Phase 4c adds the address-resolution
route, the pseudonym-key routes, one address role and one field.

### Resolving a US tax address (T-screen: Customer tax evidence)

```
POST /customers/{customer_id}/tax-addresses/{address_id}/resolve   (billing admin, no body)
     -> 201 Resolution
     400: no street line (a ZIP alone never resolves), or no resolver is available yet
     404: the address is not this customer's, or not this organization's
```

**Resolution:**

```json
{"id": 9, "address_id": 31, "resolver": "fake-resolver", "source": "fake-2026.11",
 "dataset_version": "fake-2026.11", "status": "RESOLVED", "precision": "ROOFTOP", "candidates": 1,
 "jurisdiction_codes": ["US", "US-CA", "US-CA-LA", "US-CA-LA-D1"], "resolved_at": "...", "valid_until": "..."}
```

- `status`: `RESOLVED`, `AMBIGUOUS` or `NOT_FOUND`. Only `RESOLVED` with
  `ROOFTOP` or `PARCEL` precision and exactly one candidate counts. Anything
  else is stored as `AMBIGUOUS` (or `NOT_FOUND`) with no jurisdiction codes.
- Each call adds a new, write-once row. The latest one for the address is
  used. Recording a new address needs a new resolution.

**Added field.** `GET /customers/{id}/tax-evidence` → each item in
`addresses[]` gains `"resolution": Resolution | null`, the latest one.

**New address role.** `POST /customers/{id}/tax-addresses` accepts
`"role": "SERVICE_LOCATION"` as well as `BILLING` and `SHIPPING`. The quote's
place of supply is ship-to for goods, else the service location if recorded,
else billing. Resolve whichever address that is.

**New quote issue codes (US buyers):**

| Code | What the UI should prompt |
|---|---|
| `BUYER_STREET_ADDRESS_MISSING` | enter a street line |
| `ADDRESS_NOT_RESOLVED` | resolve the address |
| `ADDRESS_AMBIGUOUS` | correct the address and resolve it again |
| `ADDRESS_RESOLUTION_STALE` | resolve the address again (expired, or a newer dataset) |
| `SHIPPING_ADDRESS_MISSING` | goods need a ship-to address |

Each issue's field names the address role, for example
`buyer.addresses.SHIPPING.resolution`.

**New refusal code:** `EXEMPTION_CERTIFICATE_INVALID` (NEEDS_EVIDENCE). A
relevant certificate is expired, not yet valid, not ACTIVE, or has no
evidence document.

### Pseudonym key (T-screen: Provider Connections)

```
GET  /pseudonym-key                                   -> {key_set, current_fingerprint, acknowledged_fingerprint,
                                                          blocked_reason}
GET  /pseudonym-key/acknowledgements?limit=&cursor=   -> {items: [KeyRecord], next_cursor}
POST /pseudonym-key/acknowledgements (billing admin)  {"reason": "..."} -> 201 KeyRecord (PROPOSED)
POST /pseudonym-key/acknowledgements/{id}/approve|reject (finance approver, not the proposer) {"reason"?}
```

**KeyRecord:**

```json
{"id": 2, "fingerprint": "3f9c...", "reason": "remapped at the provider", "status": "APPROVED",
 "proposed_by": 7, "approved_by": 8, "approved_at": "...", "decision_reason": null, "created_at": "..."}
```

- Fingerprints only; the key is never returned.
- `blocked_reason` is `"pseudonym key changed — remap required"` when
  provider quoting and issuing are blocked. Show it with the acknowledge
  action.

## Published coverage (launch gate 07)

```
GET /api/v1/tax/coverage?state=SUPPORTED|LIMITED|UNSUPPORTED&limit=&cursor=     (any signed-in user)
 -> {"statement": "...anything not listed is UNSUPPORTED... does not claim global tax compliance...",
     "items": [Coverage], "next_cursor": null}
```

**Coverage:**

```json
{"jurisdiction_code": "GB", "jurisdiction_name": "United Kingdom", "tax_type": "VAT",
 "transaction_class": "B2B_SERVICES", "mode": "NATIVE_RULEPACK_APPROVED", "state": "SUPPORTED",
 "meaning": "Calculated by Zoiko's approved rule pack.", "published_at": "..."}
```

- **Published markets only.** No drafts, gate evidence or tenant data.
- **States:**
  - Native and provider modes are SUPPORTED.
  - A tenant's own rate and reference-only markets are LIMITED.
  - Suspended and unsupported markets are UNSUPPORTED.
- **Show the statement** with the list. Sales/Support and tenants read this
  page; never promise a market that isn't SUPPORTED here.

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
