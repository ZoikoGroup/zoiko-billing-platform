# Global Tax — Phase 4c: US Sales Tax Through a Provider

The US is a **specialist-provider market**, like Canada. There is no native
US pack. The provider decides the rates. Around it, everything is ours: the
resolved address, the activations and registrations, the connection, the
coverage and contradiction checks, the certificate evidence, and failing
closed.

The exact request and response shapes for the frontend are in
`TAX_CONTROL_CENTER_API.md` ("Phase 4c endpoints").

**Not switched on:**
- `ADDRESS_RESOLVERS` and `PROVIDER_REGISTRY` are empty in production.
- No US activation exists.

The US goes live only through the launch gates, including the procured
resolver and provider (4d) and the tax lead's sign-off.

## What changed

| Area | Summary |
|---|---|
| **Address resolution (T07)** | New `AddressResolver` interface (`address_resolver.py`), separate from the provider adapter: procurement decides whether one vendor does both. Resolvers are code-defined (`ADDRESS_RESOLVERS`); a tenant never supplies a URL. `POST …/tax-addresses/{id}/resolve` stores a write-once `tax_address_resolutions` row with the resolver, the source/dataset version, the precision, the candidate count and the jurisdiction codes. The row is audited. |
| **A ZIP alone never resolves** | Resolving refuses an address without a street line. Only `ROOFTOP` or `PARCEL` precision with exactly one candidate counts as RESOLVED. More candidates, or a ZIP-centroid, ZIP+4 or street-level match, are stored as AMBIGUOUS with no codes. |
| **Place of supply (review item 1)** | Each document has one place-of-supply address: **ship-to** when it has goods lines (a missing ship-to blocks with `SHIPPING_ADDRESS_MISSING` and never falls back to billing); otherwise the **service location** when one is recorded (new address role `SERVICE_LOCATION`); otherwise the **billing** address as the recorded fallback. That address alone gives the jurisdictions, is resolved and checked, is stored on the quote with its role (`SHIP_TO`, `SERVICE_LOCATION`, `BILLING_FALLBACK`) and the resolution id (4a-1 fix 4), and is what the provider receives. This applies to every governed quote, not only US ones. |
| **US quotes use only resolved districts** | For a US place-of-supply address the jurisdictions come from the latest resolution, not from the ZIP or state. The quote is NEEDS_EVIDENCE when: the street line is missing (`BUYER_STREET_ADDRESS_MISSING`); the address isn't resolved (`ADDRESS_NOT_RESOLVED`, which includes a re-recorded address); or the resolution isn't RESOLVED (`ADDRESS_AMBIGUOUS`). A resolved district that isn't in the registry is `JURISDICTION_NOT_IN_REGISTRY`. |
| **District coverage, tax-type aware** | A registration covers its jurisdiction's descendants **for the same tax type**: a state SALES registration covers that state's county and district sales tax. A component in another tax type, or outside the registered state, is REVIEW_REQUIRED (`PROVIDER_CONTRADICTS_CONTEXT`). This applies to Canada too: a GST registration never covers QST. |
| **Resolution expiry (review item 2)** | A resolution is valid for `TAX_ADDRESS_RESOLUTION_VALID_DAYS` (default 365) from `resolved_at`, and records the resolver's `dataset_version` when the resolver reports one. A resolution past its window, or made on a dataset the resolver has since replaced, is **stale**: the quote is NEEDS_EVIDENCE (`ADDRESS_RESOLUTION_STALE`) and an `ADDRESS_RESOLUTION_STALE` review item is raised (once per resolution) until the address is resolved again. Resolution views show `dataset_version` and `valid_until`. |
| **Exemption certificates (T14)** | A certificate counts when it covers a market on the quote: the jurisdiction or one of its ancestors, and the same tax type or all tax types. It is **claimed** only when it is ACTIVE, valid on the tax date and has its evidence document. Claims are frozen on the quote (`tax_quotes.exemption_claims`) and sent to the provider. A relevant certificate that is expired, not yet valid, not ACTIVE or without evidence blocks the quote (NEEDS_EVIDENCE, `EXEMPTION_CERTIFICATE_INVALID`); an expired one also raises a `CERTIFICATE_EXPIRED` review item. A certificate for an unrelated state is ignored. |
| **No exemption without a certificate** | A provider EXEMPT result on a line with no valid claim is REVIEW_REQUIRED. Zero-rated and non-taxable reason codes are unchanged. |
| **Pseudonymous customer reference** | When `TAX_PROVIDER_PSEUDONYM_KEY` is set, the payload's buyer carries `customer_ref` = `zc_` + HMAC-SHA256(key, "org:customer")[:32]. That is never the customer id, name or email. The buyer's `exemptions` carry the jurisdiction code, tax type and reason only: no certificate numbers or files. `ALLOWED_BUYER_FIELDS` = address, customer_ref, exemptions; the fake refuses anything else. |
| **Pseudonym key guard (review item 3)** | `tax_pseudonym_key_records` stores a **fingerprint** of the key per tenant (HMAC of a fixed label under the key, 32 hex; never the key or its plain hash). The first one is recorded when a provider activation is approved with the key set, by that activation's two people. A **US** provider activation cannot be approved while the key is unset. While a tenant has approved provider activations, a current fingerprint that differs from the acknowledged one (rotated, removed, or set for the first time after references were not being sent) blocks provider quoting (PROVIDER_UNAVAILABLE), issuing and outbox delivery with the reason "pseudonym key changed — remap required". A billing admin proposes acknowledging the new key and a different finance approver approves; approval is refused if the key changed again in between. |
| **Migrations** | `c7f3a1d9e5b2`: `tax_address_resolutions` plus its guard (write-once), `tax_quotes.exemption_claims`, and the quote guard recreated with it. `d2b8e4f6a1c3`: `tax_address_resolutions.dataset_version` (resolution guard recreated with it) and `tax_pseudonym_key_records` plus its guard. `CRITICAL_COLUMNS` updated. |

## Decisions to review

1. **Resolution is an explicit action, not automatic on save.** A billing
   admin resolves an address after recording it. Auto-resolving on save
   (or at quote time) would call the resolver from more paths; it is a
   small change if you want it.
2. **Only rooftop and parcel precision are accepted.** Street-level
   interpolation is treated as ambiguous. The tax lead may want to accept
   it once the procured resolver's accuracy is known.
3. **Without `TAX_PROVIDER_PSEUDONYM_KEY`, no customer reference is sent.**
   Non-US provider markets still work without it; US provider activations
   cannot be approved without it.
4. **One place of supply per document.** A document with goods lines uses
   the ship-to for every line, including any service lines on it. Split the
   document if its services are supplied elsewhere. Per-line places of
   supply would need one supply address per quote line.
5. **The pseudonym fingerprint is per tenant**, so each tenant acknowledges
   a rotation separately (each has its own provider records to remap).
6. **Staleness is checked at quote time.** The Phase 2 review sweep does not
   yet warn before a resolution expires; the review item is raised when a
   quote first meets the stale resolution.

## Deferred

Both items below are now built: see `TAX_PHASE4D.md`.

- **Manual address resolution.** For an address with no rooftop or parcel
  match: a person records the districts with evidence (for example, the
  authority's lookup result), and a second person approves. Until then such
  an address stays AMBIGUOUS and blocks.
- **Pseudonym remapping tool.** Exporting old-to-new customer references
  for the provider when the key is rotated. Until then rotation is manual:
  remap at the provider, then acknowledge the new key (two people).

## Tests

T07 and T14 here are **plumbing only**. They count as passed for the gate
only in 4d, against a provider sandbox and a procured resolver with golden
values from the tax lead.

| Test file | Covers |
|---|---|
| `tests/test_tax_phase4c_us.py` (27) | **T07:** same ZIP, different district, different tax; a ZIP alone never resolves; unresolved, ambiguous, imprecise and unknown addresses block; the resolution is recorded, audited and write-once; a changed address needs a new resolution; a district missing from the registry blocks; a state registration covers its districts but not another tax type. **T14:** a valid certificate with evidence is claimed, the line is exempt, and it is issued with the pseudonymous reference and exemptions in the payload; an expired certificate blocks and raises a review item; a certificate without evidence isn't claimed; a provider exemption without a certificate is REVIEW_REQUIRED; another state's certificate is ignored. Pseudonym: stable, keyed, absent without a key. **Place of supply:** billed in Nevada and shipped to a California district gives the ship-to district, stored as SHIP_TO and sent to the provider; an unresolved ship-to blocks even with a resolved billing address; goods without a ship-to never fall back to billing; a service location beats billing; billing is recorded as BILLING_FALLBACK. **Staleness:** an expired resolution blocks and raises a review item; a newer dataset blocks until re-resolved. **Key guard:** a US provider activation can't be approved without the key; the key is recorded by fingerprint only, by two people; a changed or removed key blocks quoting and issuing until a two-person acknowledgement. |
| `tests/privacy/test_tax_phase4c_api.py` (11) | Resolve over HTTP and the resolution in tax evidence; ZIP-only gives 400 and a mismatched customer 404; a billing admin is required; **T13:** platform roles get 403 and other tenants 404, and the resolver is never called. Pseudonym key status (no key material), two-person acknowledgement over HTTP, paged list; platform roles get 403 |
| `tests/test_tax_phase4c_pg.py` (4, Postgres only, CI tax step) | Tables, column and triggers; resolutions write-once including the dataset version; pseudonym key records frozen; a US quote with districts and a claim, with claims frozen |

**Changed tests and fixtures:**
- `test_known_reason_code_maps_to_our_outcome` (4a-1) now uses ZERO_RATED,
  because EXEMPT needs a valid certificate since 4c.
- `tests/conftest.py` sets a per-session test `TAX_PROVIDER_PSEUDONYM_KEY`,
  so every provider world records a baseline fingerprint.

**CI result:** _see PR_.
