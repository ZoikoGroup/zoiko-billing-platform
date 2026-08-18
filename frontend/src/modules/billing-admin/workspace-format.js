const CURRENCY_SYMBOLS = {
  USD: "$", EUR: "\u20AC", GBP: "\u00A3", JPY: "\u00A5", INR: "\u20B9",
  AUD: "A$", CAD: "C$", CHF: "CHF", CNY: "\u00A5", KRW: "\u20A9",
  BRL: "R$", MXN: "MX$", SGD: "S$", HKD: "HK$", SEK: "kr",
  NOK: "kr", DKK: "kr", PLN: "z\u0142", THB: "\u0E3F", ZAR: "R",
  AED: "AED", SAR: "SAR", NZD: "NZ$", TRY: "\u20BA", RUB: "\u20BD",
};

export function resolveOrgCurrency(config) {
  const code = config?.default_currency || config?.base_currency || "USD";
  if (typeof code !== "string" || code.length !== 3) return "USD";
  return code.toUpperCase();
}

export function getCurrencySymbol(currencyCode) {
  return CURRENCY_SYMBOLS[currencyCode] || currencyCode;
}

export function formatOrgMoney(amount, config) {
  const currency = resolveOrgCurrency(config);
  if (amount == null || isNaN(amount)) return "\u2014";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(Number(amount));
  } catch {
    return `${getCurrencySymbol(currency)} ${Number(amount).toFixed(2)}`;
  }
}

export function formatCurrencyChip(config) {
  const currency = resolveOrgCurrency(config);
  const symbol = getCurrencySymbol(currency);
  return `${symbol} ${currency}`;
}

export function normalizeOrgName(name) {
  if (!name) return "\u2014";
  const suffixes = ["llc", "ltd", "inc", "corp", "co", "plc", "gmbh", "ag", "sa", "pty"];
  return name
    .split(/\s+/)
    .map((w) => {
      const lower = w.toLowerCase();
      if (suffixes.includes(lower)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

export function formatFiscalYearLabel(fiscalYearStart) {
  if (!fiscalYearStart) return "\u2014";
  const [mm] = fiscalYearStart.split("-");
  const monthIndex = parseInt(mm, 10) - 1;
  if (isNaN(monthIndex) || monthIndex < 0 || monthIndex > 11) return "\u2014";
  const startYear = 2026;
  const endYear = monthIndex === 0 ? startYear : startYear + 1;
  return `FY ${startYear}\u2013${String(endYear).slice(-2)}`;
}

export function formatFiscalYearRange(fiscalYearStart, fiscalYearEnd) {
  if (!fiscalYearStart || !fiscalYearEnd) return "\u2014";
  const [sm, sd] = fiscalYearStart.split("-");
  const [em, ed] = fiscalYearEnd.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const startMonth = months[parseInt(sm, 10) - 1];
  const endMonth = months[parseInt(em, 10) - 1];
  if (!startMonth || !endMonth) return "\u2014";
  return `${startMonth} ${sd} \u2013 ${endMonth} ${ed}`;
}

export function parseMmDd(mmDd) {
  if (!mmDd || typeof mmDd !== "string") return null;
  const [mm, dd] = mmDd.split("-").map(Number);
  if (isNaN(mm) || isNaN(dd)) return null;
  return { month: mm, day: dd };
}
