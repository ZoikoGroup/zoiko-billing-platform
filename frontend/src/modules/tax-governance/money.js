/* Phase 8 PR 6: every amount shown with its currency's minor units
 * (Intl.NumberFormat knows them: JPY 0, GBP 2, KWD 3). Falls back to the plain
 * value and code for a code Intl doesn't know. */

export function formatMoney(amount, currency) {
  if (amount === null || amount === undefined || amount === "") return "—";
  const value = Number(amount);
  if (!currency || Number.isNaN(value)) return `${amount}${currency ? ` ${currency}` : ""}`;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(value);
  } catch {
    return `${amount} ${currency}`;
  }
}

/* The two review-item kinds the anomaly checks raise (Phase 7 PR 3). The
 * Reports hub card and the Review items filter use this same list, so their
 * counts always agree. */
export const ANOMALY_KINDS = ["TAX_SNAPSHOT_MISMATCH", "CREDIT_EXCEEDS_ORIGINAL"];
