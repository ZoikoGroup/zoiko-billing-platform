import { RateLookup } from "../tax-control-center/RateLookup";
import { PANEL } from "../tax-control-center/shared";
import { SectionTitle } from "./common";
import { listJurisdictions, lookupReferenceRates } from "./governanceService";

/* T9 Reference rates (Phase 5c PR 3): the platform's published reference
 * rates, read-only, for any tenant tax role. Reference only: what an invoice
 * charges comes from its governed quote, never from this page. */

export function ReferenceRatesScreen() {
  return (
    <section className={PANEL} aria-labelledby="t9-title">
      <SectionTitle id="t9-title" title="Reference rates">
        Rates the platform has published from official sources, for reference. An invoice's tax always comes from its
        own quote. Where no rate is approved, tax is not determined, never 0%.
      </SectionTitle>
      <RateLookup listJurisdictions={listJurisdictions} lookupRates={lookupReferenceRates} idPrefix="t9" />
    </section>
  );
}
