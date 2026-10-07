// Number of distinct jurisdictions a set of tax rates covers. A rate with a
// blank/missing jurisdiction is not a jurisdiction: both the Tax page and the
// Tax Dashboard used to count it as one extra "country" (as `undefined`/"" in
// a Set, or bucketed as "Unknown"). Comparison ignores case and surrounding
// whitespace so "India" and " india " are one jurisdiction.
export function countCoveredJurisdictions(rates) {
  const keys = (rates || [])
    .map((r) => String(r?.jurisdiction ?? "").trim().toLowerCase())
    .filter(Boolean);
  return new Set(keys).size;
}

// Tax Reports tabs that can be deep-linked with /billing/tax/reports?tab=<key>.
export const TAX_REPORT_TABS = ["overview", "collection", "jurisdiction", "filing"];

// tax_rounding_method is stored and validated, but no calculation reads it.
// What actually happens today, whatever is selected (CalculationService):
// each line's tax is rounded on its own (stored per line), while the invoice
// or quote header tax is the unrounded sum rounded once -- so line amounts can
// differ from the header total by a cent. Shown beside the control so the
// setting never implies an effect it doesn't have. Remove once the engine
// honours the setting.
export const TAX_ROUNDING_NOT_APPLIED_NOTICE =
  "Not applied yet: the selected method is saved but doesn't change calculations. Today each line's tax is rounded on its own, while the invoice total rounds the combined tax once, so line amounts can differ from the total by a cent.";
