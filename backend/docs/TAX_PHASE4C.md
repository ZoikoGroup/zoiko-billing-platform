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
| **US quotes use only resolved districts** | For a US billing address the jurisdictions come from the latest resolution, not from the ZIP or state. The quote is NEEDS_EVIDENCE when: the street line is missing (`BUYER_STREET_ADDRESS_MISSING`); the address isn't resolved (`ADDRESS_NOT_RESOLVED`, which includes a re-recorded address); or the resolution isn't RESOLVED (`ADDRESS_AMBIGUOUS`). A resolved district that isn't in the registry is `JURISDICTION_NOT_IN_REGISTRY`. |
| **District coverage, tax-type aware** | A registration covers its jurisdiction's descendants **for the same tax type**: a state SALES registration covers that state's county and district sales tax. A component in another tax type, or outside the registered state, is REVIEW_REQUIRED (`PROVIDER_CONTRADICTS_CONTEXT`). This applies to Canada too: a GST registration never covers QST. |
| **Exemption certificates (T14)** | A certificate counts when it covers a market on the quote: the jurisdiction or one of its ancestors, and the same tax type or all tax types. It is **claimed** only when it is ACTIVE, valid on the tax date and has its evidence document. Claims are frozen on the quote (`tax_quotes.exemption_claims`) and sent to the provider. A relevant certificate that is expired, not yet valid, not ACTIVE or without evidence blocks the quote (NEEDS_EVIDENCE, `EXEMPTION_CERTIFICATE_INVALID`); an expired one also raises a `CERTIFICATE_EXPIRED` review item. A certificate for an unrelated state is ignored. |
| **No exemption without a certificate** | A provider EXEMPT result on a line with no valid claim is REVIEW_REQUIRED. Zero-rated and non-taxable reason codes are unchanged. |
| **Pseudonymous customer reference** | When `TAX_PROVIDER_PSEUDONYM_KEY` is set, the payload's buyer carries `customer_ref` = `zc_` + HMAC-SHA256(key, "org:customer")[:32]. That is never the customer id, name or email. The buyer's `exemptions` carry the jurisdiction code, tax type and reason only: no certificate numbers or files. `ALLOWED_BUYER_FIELDS` = address, customer_ref, exemptions; the fake refuses anything else. |
| **Migration** | `c7f3a1d9e5b2`: `tax_address_resolutions` plus its guard (write-once), `tax_quotes.exemption_claims`, and the quote guard recreated with it. `CRITICAL_COLUMNS` updated. |

## Decisions to review

1. **Resolution is an explicit action, not automatic on save.** A billing
   admin resolves an address after recording it. Auto-resolving on save
   (or at quote time) would call the resolver from more paths; it is a
   small change if you want it.
2. **Only rooftop and parcel precision are accepted.** Street-level
   interpolation is treated as ambiguous. The tax lead may want to accept
   it once the procured resolver's accuracy is known.
3. **Without `TAX_PROVIDER_PSEUDONYM_KEY`, no customer reference is sent.**
   Quotes and issuing still work. A provider that needs a customer code
   for its own exemption records will need the key set at 4d.
4. **Rotating the pseudonym key changes every reference.** Before rotating,
   export the old-to-new mapping for any customers the provider holds
   exemption records for, and remap them at the provider. No job is built
   in 4c.

## Tests

T07 and T14 here are **plumbing only**. They count as passed for the gate
only in 4d, against a provider sandbox and a procured resolver with golden
values from the tax lead.

| Test file | Covers |
|---|---|
| `tests/test_tax_phase4c_us.py` (16) | **T07:** same ZIP, different district, different tax; a ZIP alone never resolves; unresolved, ambiguous, imprecise and unknown addresses block; the resolution is recorded, audited and write-once; a changed address needs a new resolution; a district missing from the registry blocks; a state registration covers its districts but not another tax type. **T14:** a valid certificate with evidence is claimed, the line is exempt, and it is issued with the pseudonymous reference and exemptions in the payload; an expired certificate blocks and raises a review item; a certificate without evidence isn't claimed; a provider exemption without a certificate is REVIEW_REQUIRED; another state's certificate is ignored. Pseudonym: stable, keyed, absent without a key. |
| `tests/privacy/test_tax_phase4c_api.py` (7) | Resolve over HTTP and the resolution in tax evidence; ZIP-only gives 400 and a mismatched customer 404; a billing admin is required; **T13:** platform roles get 403 and other tenants 404, and the resolver is never called |
| `tests/test_tax_phase4c_pg.py` (3, Postgres only, CI tax step) | Table, column and trigger; resolutions write-once; a US quote with districts and a claim, with claims frozen |

**Changed test:** `test_known_reason_code_maps_to_our_outcome` (4a-1) now
uses ZERO_RATED, because EXEMPT needs a valid certificate since 4c.

**CI result:** _see PR_.
