# Global Tax — Phase 4b: Canada Through a Provider

Canada is a **specialist-provider market** (§14). There is no native Canada
pack, Ontario included. The provider decides GST, HST, PST and QST. Around
it, everything is ours: activations, registrations, the connection, the
nexus and contradiction checks, and failing closed.

**Not switched on:** no provider is registered and no Canadian activation
exists. Canada goes live only through launch gates 01–07, including the
provider contract (gate 05) and the tax lead's sign-off.

## What changed

- **Provider engines always require the routing facts.**
  - 4a-1 moved `ProviderAdapter` into `provider_contract.py`. That reset its
    default `required_facts` to empty, so a provider quote would have
    treated missing routing facts as warnings.
  - `ProviderEngine` now always adds `ROUTING_FACTS` to whatever the
    adapter declares.
  - (Regression fix.)
- **Sub-national countries need the province.** `SUBNATIONAL_COUNTRIES`
  (CA, US) makes `BUYER_SUBDIVISION_MISSING` a blocking fact. A postal code
  alone never resolves a Canadian or US jurisdiction; the quote is
  NEEDS_EVIDENCE.
- **Several jurisdictions per line.** A buyer in a province resolves to the
  country (`CA`) and the province (`CA-ON`). The entity's activations in both
  go to the provider in one request (one engine, one connection). Every
  component the provider returns must fall inside those activations;
  anything else is REVIEW_REQUIRED.
- **Registrations are per jurisdiction and tax type:** CA GST, CA-ON HST,
  CA-BC PST, and QST if registered. The commit payload's
  `registered_jurisdictions` lists them.
- **The fake provider** gains per-(jurisdiction, tax type) plumbing rates
  for tests.

## T06: plumbing only

`tests/test_tax_phase4b_canada.py` (7) covers:
- Ontario gives one HST component;
- British Columbia gives GST plus PST;
- a QST charge without a QST registration is REVIEW_REQUIRED;
- a missing province blocks;
- issue through the connection with the registrations in the payload;
- there is no native Canada pack;
- a suspended connection freezes Canada.

The rates and the "HST replaces GST" behaviour are **fake-provider
fixtures**. They prove routing, components, nexus and blocking. They are
not legal answers. **T06 counts as passed only in 4d, against a provider
sandbox, with golden values from the tax lead.**

## Open

- **Place of supply:** jurisdictions come from the buyer's billing address
  (`BILLING_FALLBACK`). Canadian place-of-supply rules for services (and
  ship-to for goods) arrive with the `AddressResolver` in 4c, and the
  provider's own rules apply in the meantime.
- **Registration matching is exact** (Phase 2 finding 1). A single GST/HST
  account number must be recorded once per tax type and province it covers.
