const JURISDICTION_TO_CURRENCY = {
  IN: "INR", US: "USD", UK: "GBP", AE: "AED", AU: "AUD", BD: "BDT",
  BH: "BHD", BR: "BRL", CA: "CAD", CH: "CHF", CN: "CNY", DK: "DKK",
  EU: "EUR", GH: "GHS", HK: "HKD", JP: "JPY", KE: "KES", KR: "KRW",
  KW: "KWD", LK: "LKR", MX: "MXN", MY: "MYR", NG: "NGN", NO: "NOK",
  NP: "NPR", NZ: "NZD", OM: "OMR", PK: "PKR", QA: "QAR", RW: "RWF",
  SA: "SAR", SE: "SEK", SG: "SGD", TH: "THB", TZ: "TZS", UG: "UGX",
  ZA: "ZAR",
  India: "INR", "United States": "USD", "United Kingdom": "GBP",
  "United Arab Emirates": "AED", Australia: "AUD", Bangladesh: "BDT",
  Bahrain: "BHD", Brazil: "BRL", Canada: "CAD", Switzerland: "CHF",
  China: "CNY", Denmark: "DKK", "European Union": "EUR", Germany: "EUR",
  France: "EUR", Italy: "EUR", Spain: "EUR", Netherlands: "EUR",
  Ireland: "EUR", Belgium: "EUR", Austria: "EUR", Finland: "EUR",
  Portugal: "EUR", Greece: "EUR", Ghana: "GHS", "Hong Kong": "HKD",
  Japan: "JPY", Kenya: "KES", "South Korea": "KRW", Kuwait: "KWD",
  "Sri Lanka": "LKR", Mexico: "MXN", Malaysia: "MYR", Nigeria: "NGN",
  Norway: "NOK", Nepal: "NPR", "New Zealand": "NZD", Oman: "OMR",
  Pakistan: "PKR", Qatar: "QAR", Rwanda: "RWF", "Saudi Arabia": "SAR",
  Sweden: "SEK", Singapore: "SGD", Thailand: "THB", Tanzania: "TZS",
  Uganda: "UGX", "South Africa": "ZAR",
};

// GHS/KES/RWF/TZS/UGX are deliberately absent: the backend's CurrencyCode
// enum and Customer/Product/PriceList currency validators don't support
// them (see backend/app/modules/auth/country_currency.py
// UNSUPPORTED_COUNTRY_NOTES), so offering them here meant a user could pick
// a currency that always failed backend validation. Ghana/Kenya/Rwanda/
// Tanzania/Uganda remain selectable as countries (COUNTRY_OPTIONS below) --
// getCurrencyForCountry() simply returns no auto-suggested currency for
// them, which is correct: an unsupported/unknown currency must require an
// explicit choice, never a silent default.
export const CURRENCY_MASTER = {
  AED: { code: 'AED', symbol: '\u062F.\u0625', name: 'UAE Dirham', nameNative: '\u062F\u0631\u0647\u0645 \u0625\u0645\u0627\u0631\u0627\u062A\u064A', locale: 'ar-AE', flag: '\uD83C\uDDE6\uD83C\uDDEA', decimalDigits: 2 },
  AUD: { code: 'AUD', symbol: 'A$', name: 'Australian Dollar', nameNative: 'Australian Dollar', locale: 'en-AU', flag: '\uD83C\uDDE6\uD83C\uDDFA', decimalDigits: 2 },
  BDT: { code: 'BDT', symbol: '\u09F3', name: 'Bangladeshi Taka', nameNative: '\u09AC\u09BE\u0982\u09B2\u09BE\u09A6\u09C7\u09B6\u09C0 \u099F\u09BE\u0995\u09BE', locale: 'bn-BD', flag: '\uD83C\uDDE7\uD83C\uDDE9', decimalDigits: 2 },
  BHD: { code: 'BHD', symbol: '\u062F.\u0628', name: 'Bahraini Dinar', nameNative: '\u062F\u064A\u0646\u0627\u0631 \u0628\u062D\u0631\u064A\u0646\u064A', locale: 'ar-BH', flag: '\uD83C\uDDE7\uD83C\uDDED', decimalDigits: 3 },
  BRL: { code: 'BRL', symbol: 'R$', name: 'Brazilian Real', nameNative: 'Real Brasileiro', locale: 'pt-BR', flag: '\uD83C\uDDE7\uD83C\uDDF7', decimalDigits: 2 },
  CAD: { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar', nameNative: 'Canadian Dollar', locale: 'en-CA', flag: '\uD83C\uDDE8\uD83C\uDDE6', decimalDigits: 2 },
  CHF: { code: 'CHF', symbol: 'CHF', name: 'Swiss Franc', nameNative: 'Schweizer Franken', locale: 'de-CH', flag: '\uD83C\uDDE8\uD83C\uDDED', decimalDigits: 2 },
  CNY: { code: 'CNY', symbol: '\u00A5', name: 'Chinese Yuan', nameNative: '\u4EBA\u6C11\u5E01', locale: 'zh-CN', flag: '\uD83C\uDDE8\uD83C\uDDF3', decimalDigits: 2 },
  DKK: { code: 'DKK', symbol: 'kr', name: 'Danish Krone', nameNative: 'Dansk Krone', locale: 'da-DK', flag: '\uD83C\uDDE9\uD83C\uDDF0', decimalDigits: 2 },
  EUR: { code: 'EUR', symbol: '\u20AC', name: 'Euro', nameNative: 'Euro', locale: 'de-DE', flag: '\uD83C\uDDEA\uD83C\uDDFA', decimalDigits: 2 },
  GBP: { code: 'GBP', symbol: '\u00A3', name: 'Pound Sterling', nameNative: 'Pound Sterling', locale: 'en-GB', flag: '\uD83C\uDDEC\uD83C\uDDE7', decimalDigits: 2 },
  HKD: { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar', nameNative: 'Hong Kong Dollar', locale: 'en-HK', flag: '\uD83C\uDDED\uD83C\uDDF0', decimalDigits: 2 },
  INR: { code: 'INR', symbol: '\u20B9', name: 'Indian Rupee', nameNative: '\u0930\u0942\u092A\u092F\u093E', locale: 'en-IN', flag: '\uD83C\uDDEE\uD83C\uDDF3', decimalDigits: 2 },
  JPY: { code: 'JPY', symbol: '\u00A5', name: 'Japanese Yen', nameNative: '\u5186', locale: 'ja-JP', flag: '\uD83C\uDDEF\uD83C\uDDF5', decimalDigits: 0 },
  KRW: { code: 'KRW', symbol: '\u20A9', name: 'South Korean Won', nameNative: '\uC6D0', locale: 'ko-KR', flag: '\uD83C\uDDF0\uD83C\uDDF7', decimalDigits: 0 },
  KWD: { code: 'KWD', symbol: '\u062F.\u0643', name: 'Kuwaiti Dinar', nameNative: '\u062F\u064A\u0646\u0627\u0631 \u0643\u0648\u064A\u062A\u064A', locale: 'ar-KW', flag: '\uD83C\uDDF0\uD83C\uDDFC', decimalDigits: 3 },
  LKR: { code: 'LKR', symbol: '\u20A8', name: 'Sri Lankan Rupee', nameNative: '\u0DC2\u0DCA\u200D\u0DBB\u0DD3 \u0DBD\u0D82\u0D9A\u0DC0 \u0DBB\u0DD4\u0DB4\u0DD2\u0DBA\u0DBD', locale: 'si-LK', flag: '\uD83C\uDDF1\uD83C\uDDF0', decimalDigits: 2 },
  MXN: { code: 'MXN', symbol: 'MX$', name: 'Mexican Peso', nameNative: 'Peso Mexicano', locale: 'es-MX', flag: '\uD83C\uDDF2\uD83C\uDDFD', decimalDigits: 2 },
  MYR: { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit', nameNative: 'Ringgit Malaysia', locale: 'ms-MY', flag: '\uD83C\uDDF2\uD83C\uDDFE', decimalDigits: 2 },
  NGN: { code: 'NGN', symbol: '\u20A6', name: 'Nigerian Naira', nameNative: 'Nigerian Naira', locale: 'en-NG', flag: '\uD83C\uDDF3\uD83C\uDDEC', decimalDigits: 2 },
  NOK: { code: 'NOK', symbol: 'kr', name: 'Norwegian Krone', nameNative: 'Norsk Krone', locale: 'nb-NO', flag: '\uD83C\uDDF3\uD83C\uDDF4', decimalDigits: 2 },
  NPR: { code: 'NPR', symbol: '\u20A8', name: 'Nepalese Rupee', nameNative: '\u0928\u0947\u092A\u093E\u0932\u0940 \u0930\u0942\u092A\u0948\u092F\u093E\u0901', locale: 'ne-NP', flag: '\uD83C\uDDF3\uD83C\uDDF5', decimalDigits: 2 },
  NZD: { code: 'NZD', symbol: 'NZ$', name: 'New Zealand Dollar', nameNative: 'New Zealand Dollar', locale: 'en-NZ', flag: '\uD83C\uDDF3\uD83C\uDDFF', decimalDigits: 2 },
  OMR: { code: 'OMR', symbol: '\u0631.\u0639', name: 'Omani Rial', nameNative: '\u0631\u064A\u0627\u0644 \u0639\u0645\u0627\u0646\u064A', locale: 'ar-OM', flag: '\uD83C\uDDF4\uD83C\uDDF2', decimalDigits: 3 },
  PKR: { code: 'PKR', symbol: '\u20A8', name: 'Pakistani Rupee', nameNative: '\u067E\u0627\u06A9\u0633\u062A\u0627\u0646\u06CC \u0631\u0648\u067E\u06CC\u06C1', locale: 'ur-PK', flag: '\uD83C\uDDF5\uD83C\uDDF0', decimalDigits: 2 },
  QAR: { code: 'QAR', symbol: '\u0631.\u0642', name: 'Qatari Riyal', nameNative: '\u0631\u064A\u0627\u0644 \u0642\u0637\u0631\u064A', locale: 'ar-QA', flag: '\uD83C\uDDF6\uD83C\uDDE6', decimalDigits: 2 },
  SAR: { code: 'SAR', symbol: '\u0631.\u0633', name: 'Saudi Riyal', nameNative: '\u0631\u064A\u0627\u0644 \u0633\u0639\u0648\u062F\u064A', locale: 'ar-SA', flag: '\uD83C\uDDF8\uD83C\uDDE6', decimalDigits: 2 },
  SEK: { code: 'SEK', symbol: 'kr', name: 'Swedish Krona', nameNative: 'Svensk Krona', locale: 'sv-SE', flag: '\uD83C\uDDF8\uD83C\uDDEA', decimalDigits: 2 },
  SGD: { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar', nameNative: 'Singapore Dollar', locale: 'en-SG', flag: '\uD83C\uDDF8\uD83C\uDDEC', decimalDigits: 2 },
  THB: { code: 'THB', symbol: '\u0E3F', name: 'Thai Baht', nameNative: '\u0E1A\u0E32\u0E17', locale: 'th-TH', flag: '\uD83C\uDDF9\uD83C\uDDED', decimalDigits: 2 },
  USD: { code: 'USD', symbol: '$', name: 'US Dollar', nameNative: 'US Dollar', locale: 'en-US', flag: '\uD83C\uDDFA\uD83C\uDDF8', decimalDigits: 2 },
  ZAR: { code: 'ZAR', symbol: 'R', name: 'South African Rand', nameNative: 'South African Rand', locale: 'en-ZA', flag: '\uD83C\uDDFF\uD83C\uDDE6', decimalDigits: 2 },
};

export function getCurrencyForJurisdiction(jurisdictionCountry) {
  if (!jurisdictionCountry) return null;
  const code = JURISDICTION_TO_CURRENCY[jurisdictionCountry];
  if (code) return CURRENCY_MASTER[code] || null;
  // Fall back to the COUNTRY_OPTIONS table so 2-letter codes not listed in
  // JURISDICTION_TO_CURRENCY (e.g. "DE", "FR") still resolve correctly.
  return getCurrencyForCountry(jurisdictionCountry);
}

export function getCurrencyInfo(code) {
  return CURRENCY_MASTER[code] || null;
}

export function getCurrencySymbol(code) {
  const info = CURRENCY_MASTER[code];
  return info ? info.symbol : (code || "");
}

export function getFlag(code) {
  const info = CURRENCY_MASTER[code];
  return info ? info.flag : '';
}

export function formatCurrency(amount, code, position = 'before') {
  const cleanCurrency = code;
  const info = CURRENCY_MASTER[cleanCurrency];

  const symbol = info?.symbol || cleanCurrency || '';
  const precision = typeof info?.decimalDigits === 'number' ? info.decimalDigits : 2;

  const numericValue = typeof amount === 'number' ? amount : parseFloat(amount);
  const formattedNumber = isNaN(numericValue) ? "0.00" : numericValue.toLocaleString(info?.locale || 'en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });

  if (!symbol) return formattedNumber;
  return position === 'before' ? `${symbol}${formattedNumber}` : `${formattedNumber} ${symbol}`;
}

const SORTED_CURRENCY_CODES = Object.keys(CURRENCY_MASTER);

export function getCurrencySelectOptions() {
  return SORTED_CURRENCY_CODES.map((code) => {
    const c = CURRENCY_MASTER[code];
    return {
      value: code,
      label: `${c.flag} ${c.name} (${code}) \u2014 ${c.symbol}`,
      searchLabel: `${code} ${c.name} ${c.symbol}`,
    };
  });
}

export function getSupportedCurrencyCodes() {
  return SORTED_CURRENCY_CODES;
}

export function getCurrencyCodes() {
  return SORTED_CURRENCY_CODES;
}

export function isValidCurrency(code) {
  return code && typeof code === 'string' && code.length === 3 && CURRENCY_MASTER[code.toUpperCase()] != null;
}

export const COUNTRY_OPTIONS = [
  { code: "IN", name: "India", currency: "INR" },
  { code: "US", name: "United States", currency: "USD" },
  { code: "GB", name: "United Kingdom", currency: "GBP" },
  { code: "AE", name: "United Arab Emirates", currency: "AED" },
  { code: "AU", name: "Australia", currency: "AUD" },
  { code: "BD", name: "Bangladesh", currency: "BDT" },
  { code: "BH", name: "Bahrain", currency: "BHD" },
  { code: "BR", name: "Brazil", currency: "BRL" },
  { code: "CA", name: "Canada", currency: "CAD" },
  { code: "CH", name: "Switzerland", currency: "CHF" },
  { code: "CN", name: "China", currency: "CNY" },
  { code: "DK", name: "Denmark", currency: "DKK" },
  { code: "DE", name: "Germany", currency: "EUR" },
  { code: "FR", name: "France", currency: "EUR" },
  { code: "IE", name: "Ireland", currency: "EUR" },
  { code: "NL", name: "Netherlands", currency: "EUR" },
  { code: "IT", name: "Italy", currency: "EUR" },
  { code: "ES", name: "Spain", currency: "EUR" },
  { code: "BE", name: "Belgium", currency: "EUR" },
  { code: "AT", name: "Austria", currency: "EUR" },
  { code: "FI", name: "Finland", currency: "EUR" },
  { code: "PT", name: "Portugal", currency: "EUR" },
  { code: "GR", name: "Greece", currency: "EUR" },
  { code: "GH", name: "Ghana", currency: "GHS" },
  { code: "HK", name: "Hong Kong", currency: "HKD" },
  { code: "JP", name: "Japan", currency: "JPY" },
  { code: "KE", name: "Kenya", currency: "KES" },
  { code: "KR", name: "South Korea", currency: "KRW" },
  { code: "KW", name: "Kuwait", currency: "KWD" },
  { code: "LK", name: "Sri Lanka", currency: "LKR" },
  { code: "MX", name: "Mexico", currency: "MXN" },
  { code: "MY", name: "Malaysia", currency: "MYR" },
  { code: "NG", name: "Nigeria", currency: "NGN" },
  { code: "NO", name: "Norway", currency: "NOK" },
  { code: "NP", name: "Nepal", currency: "NPR" },
  { code: "NZ", name: "New Zealand", currency: "NZD" },
  { code: "OM", name: "Oman", currency: "OMR" },
  { code: "PK", name: "Pakistan", currency: "PKR" },
  { code: "QA", name: "Qatar", currency: "QAR" },
  { code: "RW", name: "Rwanda", currency: "RWF" },
  { code: "SA", name: "Saudi Arabia", currency: "SAR" },
  { code: "SE", name: "Sweden", currency: "SEK" },
  { code: "SG", name: "Singapore", currency: "SGD" },
  { code: "TH", name: "Thailand", currency: "THB" },
  { code: "TZ", name: "Tanzania", currency: "TZS" },
  { code: "UG", name: "Uganda", currency: "UGX" },
  { code: "ZA", name: "South Africa", currency: "ZAR" },
].sort((a, b) => a.name.localeCompare(b.name));

export function getCurrencyForCountry(countryNameOrCode) {
  if (!countryNameOrCode) return null;
  const code = JURISDICTION_TO_CURRENCY[countryNameOrCode];
  if (code) return CURRENCY_MASTER[code] || null;
  const match = COUNTRY_OPTIONS.find(
    (c) => c.name.toLowerCase() === countryNameOrCode.toLowerCase() || c.code === countryNameOrCode
  );
  if (match && CURRENCY_MASTER[match.currency]) return CURRENCY_MASTER[match.currency];
  return null;
}

export function getCountrySelectOptions() {
  return COUNTRY_OPTIONS.map((c) => ({
    value: c.name,
    label: `${c.name} (${c.currency})`,
    code: c.code,
    currency: c.currency,
  }));
}

const COUNTRY_NAME_TO_CODE = {};
for (const c of COUNTRY_OPTIONS) {
  COUNTRY_NAME_TO_CODE[c.name.toLowerCase()] = c.code;
  COUNTRY_NAME_TO_CODE[c.code.toLowerCase()] = c.code;
}
COUNTRY_NAME_TO_CODE["uk"] = "GB";

const COUNTRY_CODE_TO_NAME = {};
for (const c of COUNTRY_OPTIONS) {
  COUNTRY_CODE_TO_NAME[c.code] = c.name;
}
COUNTRY_CODE_TO_NAME["UK"] = "United Kingdom";

export function normalizeCountryCode(value) {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (COUNTRY_NAME_TO_CODE[lower]) return COUNTRY_NAME_TO_CODE[lower];
  const upper = trimmed.toUpperCase();
  const match = COUNTRY_OPTIONS.find(
    (c) => c.name.toLowerCase() === lower || c.code.toUpperCase() === upper
  );
  return match ? match.code : "";
}

export function getCountryNameFromCode(code) {
  if (!code || typeof code !== "string") return "";
  const upper = code.trim().toUpperCase();
  return COUNTRY_CODE_TO_NAME[upper] || "";
}
