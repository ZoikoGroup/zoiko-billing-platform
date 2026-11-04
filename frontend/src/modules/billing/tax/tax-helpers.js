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

// Format a tax rate percentage for display without losing legal precision
// (ZB-TAX-ARCH-001 §07). Rates are stored at up to 6 decimal places, so a
// fixed toFixed(2) would show New York City's 8.875% as "8.88". Shows at least
// 2 decimals and at most 6, trimming trailing zeros beyond the second.
export function formatTaxRate(value) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return "0.00";
  const fixed = n.toFixed(6).replace(/0+$/, "");
  const [whole, frac = ""] = fixed.split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}
