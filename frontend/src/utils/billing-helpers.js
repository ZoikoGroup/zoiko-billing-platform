import { formatCurrency as localeFormatCurrency } from "./locale";
import { getCurrencySymbol, CURRENCY_MASTER } from "./currency";
import { getOrgBaseCurrency } from "../modules/billing/utils/CurrencyContext";
import { assertExportsAllowed } from "./export-helpers";

export function extractArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.data)) return data.data;
  if (data.monthly_revenue && Array.isArray(data.monthly_revenue)) return data.monthly_revenue;
  if (data.monthly_revenue && data.monthly_revenue.monthly_revenue && Array.isArray(data.monthly_revenue.monthly_revenue)) return data.monthly_revenue.monthly_revenue;
  if (data["0_30"] !== undefined) {
    const labels = {
      "0_30": "0-30 Days",
      "31_60": "31-60 Days",
      "61_90": "61-90 Days",
      "91_plus": "90+ Days"
    };
    return ["0_30", "31_60", "61_90", "91_plus"].map(k => ({
      name: labels[k] || k,
      bucket: labels[k] || k,
      amount: parseFloat(data[k]?.total || 0),
      total_amount: parseFloat(data[k]?.total || 0),
      total: parseFloat(data[k]?.total || 0),
      count: data[k]?.count || 0
    }));
  }
  return [];
}

export function formatDisplayCurrency(v, fallbackOrCurrency, currencyCode) {
  let fb = "\u2014";
  let cc = "";
  if (currencyCode) {
    fb = fallbackOrCurrency || "\u2014";
    cc = currencyCode;
  } else if (fallbackOrCurrency && /^[A-Z]{3}$/.test(fallbackOrCurrency)) {
    cc = fallbackOrCurrency;
  } else {
    fb = fallbackOrCurrency || "\u2014";
  }
  if (v == null || v === "") return fb;
  const num = Number(v);
  if (Number.isNaN(num)) return fb;
  const effectiveCurrency = cc || getOrgBaseCurrency();
  const symbol = getCurrencySymbol(effectiveCurrency);
  const info = CURRENCY_MASTER[effectiveCurrency];
  const precision = typeof info?.decimalDigits === "number" ? info.decimalDigits : 2;
  return `${symbol}${num.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision })}`;
}

export function formatCompactCurrency(v, currencyCode) {
  if (v === null || v === undefined) return `${getCurrencySymbol(currencyCode)}0.00`;
  const num = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(num)) return `${getCurrencySymbol(currencyCode)}0.00`;
  const symbol = getCurrencySymbol(currencyCode);
  const absNum = Math.abs(num);
  if (absNum >= 1e9) return `${symbol}${(num / 1e9).toFixed(2)}B`;
  if (absNum >= 1e6) return `${symbol}${(num / 1e6).toFixed(2)}M`;
  if (absNum >= 1e3) return `${symbol}${(num / 1e3).toFixed(2)}K`;
  return `${symbol}${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function trimCompactZeros(n) {
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Compact count notation for KPI cards — never truncates the true value:
 * 23,754,492 → "23.75M". The full figure is kept for hover tooltips.
 */
export function formatCompactNumber(value) {
  if (value === null || value === undefined || value === "") return "\u2014";
  const num = Number(value);
  if (Number.isNaN(num)) return "\u2014";
  const abs = Math.abs(num);
  const sign = num < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}${trimCompactZeros(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}${trimCompactZeros(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}${trimCompactZeros(abs / 1e3)}K`;
  return `${sign}${Math.round(abs).toLocaleString("en-US")}`;
}

/**
 * Compact money notation that respects the organization currency.
 * Indian Rupee uses Indian unit conventions (Cr / L / K); all other
 * currencies use B / M / K. The full amount is never lost — use with a
 * hover `title` populated by formatDisplayCurrency.
 */
export function formatCompactMoney(value, currencyCode) {
  if (value === null || value === undefined || value === "") return "\u2014";
  const num = Number(value);
  if (Number.isNaN(num)) return "\u2014";
  const code = (currencyCode || "").toUpperCase();
  const symbol = getCurrencySymbol(code);
  const abs = Math.abs(num);
  const sign = num < 0 ? "-" : "";
  if (code === "INR") {
    if (abs >= 1e7) return `${sign}${symbol}${trimCompactZeros(abs / 1e7)}Cr`;
    if (abs >= 1e5) return `${sign}${symbol}${trimCompactZeros(abs / 1e5)}L`;
    if (abs >= 1e3) return `${sign}${symbol}${trimCompactZeros(abs / 1e3)}K`;
    return `${sign}${symbol}${Math.round(abs).toLocaleString("en-IN")}`;
  }
  if (abs >= 1e9) return `${sign}${symbol}${trimCompactZeros(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}${symbol}${trimCompactZeros(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}${symbol}${trimCompactZeros(abs / 1e3)}K`;
  return `${sign}${symbol}${Math.round(abs).toLocaleString("en-US")}`;
}

// TaxRate.rate is stored and returned as a percentage (Numeric(5,2):
// 18.00 = 18%, 0.50 = 0.5% -- see utils/tax_catalogue.py and
// currency_utils.apply_percentage's `amount * pct / 100`). Never scale it:
// a "<= 1 means fraction" guess turns a real 0.5% or 1% rate into 50%/100%.
// The numeric percentage to use in calculations (tax_percentage on a line):
// the stored value as-is, or 0 when missing/invalid. 1.00 -> 1, 0.50 -> 0.5.
export function parseTaxRatePercent(rate) {
  const n = Number(rate);
  return rate == null || rate === "" || !Number.isFinite(n) ? 0 : n;
}

export function formatTaxRatePercent(rate) {
  const n = Number(rate);
  if (rate == null || rate === "" || !Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}%`;
}

// A bare "YYYY-MM-DD" is a calendar date, not an instant. `new Date("2026-01-01")`
// parses it as UTC midnight, which displays as Dec 31 west of UTC; build it
// in local time instead so the same calendar day shows in every timezone.
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDisplayDate(d) {
  if (d == null || d === "") return null;
  const dateOnly = typeof d === "string" ? DATE_ONLY_RE.exec(d) : null;
  const date = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

// One date format app-wide (decided): "Oct 1, 2026" \u2014 unambiguous for every
// reader, unlike 10/1 vs 1/10. Fixed en-US, like the currency formatting.
const DATE_FORMAT = { year: "numeric", month: "short", day: "numeric" };

/** "Oct 1, 2026"; "\u2014" for empty / invalid. Bare YYYY-MM-DD stays on its calendar day. */
export function formatDisplayDate(d) {
  const date = parseDisplayDate(d);
  return date ? date.toLocaleDateString("en-US", DATE_FORMAT) : "\u2014";
}

/** "Oct 1, 2026, 3:45 PM"; "\u2014" for empty / invalid. */
export function formatDisplayDateTime(d) {
  const date = parseDisplayDate(d);
  return date ? date.toLocaleString("en-US", { ...DATE_FORMAT, hour: "numeric", minute: "2-digit" }) : "\u2014";
}

/** "just now", "5 min ago", "3 hr ago", "2 days ago"; older than a week (or future) -> the date. */
export function formatRelativeTime(d, now = Date.now()) {
  const date = parseDisplayDate(d);
  if (!date) return "\u2014";
  const sec = Math.round((now - date.getTime()) / 1000);
  if (sec < 0) return formatDisplayDate(date);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatDisplayDate(date);
}

/** Plain number with thousands separators: 12,345 (or 12,345.68 with digits). */
export function formatDisplayNumber(v, digits = 0) {
  if (v == null || v === "") return "\u2014";
  const n = Number(v);
  if (Number.isNaN(n)) return "\u2014";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Percentage from a percent value (12.5 -> "12.5%"). */
export function formatPercent(v, digits = 1) {
  if (v == null || v === "") return "\u2014";
  const n = Number(v);
  if (Number.isNaN(n)) return "\u2014";
  return `${n.toFixed(digits)}%`;
}

export function downloadJSON(data, filename) {
  assertExportsAllowed();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
