export const SUPPORTED_COUNTRIES = [
  "India",
  "United States",
  "United Kingdom",
  "Australia",
  "UAE",
  "Singapore",
  "Canada",
];

// The customer/currency country picker (frontend/src/utils/currency.js) lists this
// country as "United Arab Emirates" while this file's own dataset predates that and
// keys the UAE entry as "UAE" — alias so lookups from either source resolve to the
// same COUNTRY_DEFAULTS entry.
const COUNTRY_KEY_ALIASES = {
  "United Arab Emirates": "UAE",
};

function resolveCountryKey(country) {
  return COUNTRY_KEY_ALIASES[country] || country;
}

export const COUNTRY_CURRENCY_MAP = {
  "India": "INR",
  "United States": "USD",
  "United Kingdom": "GBP",
  "Australia": "AUD",
  "UAE": "AED",
  "Singapore": "SGD",
};

export const COUNTRY_DATE_FORMAT_MAP = {
  "India": "DD-MM-YYYY",
  "United States": "MM-DD-YYYY",
  "United Kingdom": "DD-MM-YYYY",
  "Australia": "DD-MM-YYYY",
  "UAE": "DD-MM-YYYY",
  "Singapore": "DD-MM-YYYY",
};

export const COUNTRY_TIMEZONE_MAP = {
  "India": "Asia/Kolkata",
  "United States": "America/New_York",
  "United Kingdom": "Europe/London",
  "Australia": "Australia/Sydney",
  "UAE": "Asia/Dubai",
  "Singapore": "Asia/Singapore",
};

export const COUNTRY_CURRENCY_SYMBOL_MAP = {
  "INR": "\u20B9",
  "USD": "$",
  "GBP": "\u00A3",
  "AUD": "A$",
  "AED": "AED",
  "SGD": "S$",
};

export const COUNTRY_NUMBER_FORMAT_MAP = {
  "India": { locale: "en-IN", example: "12,34,567.89" },
  "United States": { locale: "en-US", example: "1,234,567.89" },
  "United Kingdom": { locale: "en-GB", example: "1,234,567.89" },
  "Australia": { locale: "en-AU", example: "1,234,567.89" },
  "UAE": { locale: "ar-AE", example: "1,234,567.89" },
  "Singapore": { locale: "en-SG", example: "1,234,567.89" },
};

export const COUNTRY_DEFAULTS = {
  India: {
    default_currency: "INR",
    home_currency: "INR",
    base_currency: "INR",
    supported_currencies: ["INR", "USD", "EUR", "GBP"],
    timezone: "Asia/Kolkata",
    language: "en",
    locale: "en-IN",
    date_format: "DD-MM-YYYY",
    number_format: "en-IN",
    currency_symbol_position: "before",
    fiscal_year_start: "04-01",
    fiscal_year_end: "03-31",
    tax_type: "GST",
    tax_label: "GST",
    tax_number_label: "GSTIN",
    tax_calculation_method: "exclusive",
    is_tax_inclusive_default: false,
    invoice_prefix: "INV-",
    invoice_number_format: "PREFIX-{YYYY}-{SEQ}",
    invoice_sequence_reset: "annually",
    quote_prefix: "QTE-IN-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    quote_sequence_reset: "annually",
    credit_note_prefix: "CN-IN-",
    credit_note_number_format: "PREFIX-{YYYY}-{SEQ}",
    credit_note_sequence_reset: "annually",
    refund_prefix: "RF-IN-",
    refund_number_format: "PREFIX-{YYYY}-{SEQ}",
    refund_sequence_reset: "annually",
    default_payment_terms: "net_30",
    default_due_days: 30,
    payment_gateway_suggestions: [
      { id: "razorpay", name: "Razorpay", recommended: true, reason: "Leading Indian payment gateway" },
      { id: "cashfree", name: "Cashfree", recommended: true, reason: "Popular for Indian businesses" },
      { id: "payu", name: "PayU", recommended: true, reason: "Wide payment method support" },
      { id: "phonepe", name: "PhonePe", recommended: true, reason: "UPI leader in India" },
      { id: "stripe", name: "Stripe", recommended: false, reason: "International cards only" },
      { id: "paypal", name: "PayPal", recommended: false, reason: "International transactions" },
    ],
    tax_defaults: {
      tax_type: "GST",
      gst_enabled: true,
      gst_types: ["CGST", "SGST", "IGST", "UTGST"],
      default_gst_rate: null,
      tds_enabled: true,
      tds_rates: { "194C": 1, "194J": 10, "194I": 10 },
    },
    invoice_defaults: {
      show_tax_breakdown: true,
      show_gstin: true,
      show_hsn_sac: true,
      e_invoice_enabled: true,
      irn_required: false,
    },
    registration_fields: [
      { key: "business_registration_number", label: "CIN / Business Reg. Number", required: true, placeholder: "U12345DL2020PTC123456", is_tax_field: false },
      { key: "gst_number", label: "GSTIN", required: true, placeholder: "29ABCDE1234F1Z5", pattern: "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$", is_tax_field: true },
      { key: "pan_number", label: "PAN Number", required: true, placeholder: "ABCDE1234F", pattern: "^[A-Z]{5}[0-9]{4}[A-Z]{1}$", is_tax_field: true },
    ],
    number_formats: {
      invoice: { prefix: "INV-IN-", format: "PREFIX-{YYYY}-{SEQ}", example: "INV-IN-2026-000001" },
      quote: { prefix: "QTE-IN-", format: "PREFIX-{YYYY}-{SEQ}", example: "QTE-IN-2026-000001" },
      credit_note: { prefix: "CN-IN-", format: "PREFIX-{YYYY}-{SEQ}", example: "CN-IN-2026-000001" },
      refund: { prefix: "RF-IN-", format: "PREFIX-{YYYY}-{SEQ}", example: "RF-IN-2026-000001" },
    },
  },
  "United States": {
    default_currency: "USD",
    home_currency: "USD",
    base_currency: "USD",
    supported_currencies: ["USD", "CAD", "EUR", "GBP"],
    timezone: "America/New_York",
    language: "en",
    locale: "en-US",
    date_format: "MM-DD-YYYY",
    number_format: "en-US",
    currency_symbol_position: "before",
    fiscal_year_start: "01-01",
    fiscal_year_end: "12-31",
    tax_type: "Sales Tax",
    tax_label: "Sales Tax",
    tax_number_label: "EIN",
    tax_calculation_method: "exclusive",
    is_tax_inclusive_default: false,
    invoice_prefix: "INV-",
    invoice_number_format: "PREFIX-{YYYY}-{SEQ}",
    invoice_sequence_reset: "annually",
    quote_prefix: "QTE-US-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    quote_sequence_reset: "annually",
    credit_note_prefix: "CN-US-",
    credit_note_number_format: "PREFIX-{YYYY}-{SEQ}",
    credit_note_sequence_reset: "annually",
    refund_prefix: "RF-US-",
    refund_number_format: "PREFIX-{YYYY}-{SEQ}",
    refund_sequence_reset: "annually",
    default_payment_terms: "net_30",
    default_due_days: 30,
    payment_gateway_suggestions: [
      { id: "stripe", name: "Stripe", recommended: true, reason: "Leading US payment platform" },
      { id: "square", name: "Square", recommended: true, reason: "Popular for US businesses" },
      { id: "authorize_net", name: "Authorize.Net", recommended: true, reason: "Established US gateway" },
      { id: "paypal", name: "PayPal", recommended: true, reason: "Widely accepted" },
      { id: "bank_transfer", name: "Bank Transfer", recommended: false, reason: "Manual processing" },
    ],
    tax_defaults: {
      tax_type: "Sales Tax",
      sales_tax_enabled: true,
      state_based: true,
      nexus_tracking: true,
      default_rates_by_state: {},
    },
    invoice_defaults: {
      show_tax_breakdown: true,
      show_ein: true,
      sales_tax_permit: true,
    },
    registration_fields: [
      { key: "business_registration_number", label: "EIN", required: true, placeholder: "12-3456789", pattern: "^[0-9]{2}-[0-9]{7}$", is_tax_field: true },
      { key: "tin_number", label: "Sales Tax ID", required: false, placeholder: "State-specific format", is_tax_field: true },
    ],
    number_formats: {
      invoice: { prefix: "INV-US-", format: "PREFIX-{YYYY}-{SEQ}", example: "INV-US-2026-000001" },
      quote: { prefix: "QTE-US-", format: "PREFIX-{YYYY}-{SEQ}", example: "QTE-US-2026-000001" },
      credit_note: { prefix: "CN-US-", format: "PREFIX-{YYYY}-{SEQ}", example: "CN-US-2026-000001" },
      refund: { prefix: "RF-US-", format: "PREFIX-{YYYY}-{SEQ}", example: "RF-US-2026-000001" },
    },
  },
  "United Kingdom": {
    default_currency: "GBP",
    home_currency: "GBP",
    base_currency: "GBP",
    supported_currencies: ["GBP", "EUR", "USD"],
    timezone: "Europe/London",
    language: "en",
    locale: "en-GB",
    date_format: "DD-MM-YYYY",
    number_format: "en-GB",
    currency_symbol_position: "before",
    fiscal_year_start: "04-01",
    fiscal_year_end: "03-31",
    tax_type: "VAT",
    tax_label: "VAT",
    tax_number_label: "VAT Number",
    tax_calculation_method: "exclusive",
    is_tax_inclusive_default: false,
    invoice_prefix: "INV-",
    invoice_number_format: "PREFIX-{YYYY}-{SEQ}",
    invoice_sequence_reset: "annually",
    quote_prefix: "QTE-UK-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    quote_sequence_reset: "annually",
    credit_note_prefix: "CN-UK-",
    credit_note_number_format: "PREFIX-{YYYY}-{SEQ}",
    credit_note_sequence_reset: "annually",
    refund_prefix: "RF-UK-",
    refund_number_format: "PREFIX-{YYYY}-{SEQ}",
    refund_sequence_reset: "annually",
    default_payment_terms: "net_30",
    default_due_days: 30,
    payment_gateway_suggestions: [
      { id: "stripe", name: "Stripe", recommended: true, reason: "Leading UK/EU payment platform" },
      { id: "gocardless", name: "GoCardless", recommended: true, reason: "Best for direct debit" },
      { id: "paypal", name: "PayPal", recommended: true, reason: "Widely accepted" },
      { id: "bank_transfer", name: "Bank Transfer", recommended: false, reason: "BACS/CHAPS" },
    ],
    tax_defaults: {
      tax_type: "VAT",
      vat_enabled: true,
      default_vat_rate: 20,
      reverse_charge_enabled: true,
      making_tax_digital: true,
    },
    invoice_defaults: {
      show_tax_breakdown: true,
      show_vat_number: true,
      vat_invoice_required: true,
    },
    registration_fields: [
      { key: "business_registration_number", label: "Company Number", required: true, placeholder: "12345678", pattern: "^[0-9]{8}$", is_tax_field: false },
      { key: "vat_number", label: "VAT Number", required: true, placeholder: "GB123456789", pattern: "^GB[0-9]{9}$", is_tax_field: true },
    ],
    number_formats: {
      invoice: { prefix: "INV-UK-", format: "PREFIX-{YYYY}-{SEQ}", example: "INV-UK-2026-000001" },
      quote: { prefix: "QTE-UK-", format: "PREFIX-{YYYY}-{SEQ}", example: "QTE-UK-2026-000001" },
      credit_note: { prefix: "CN-UK-", format: "PREFIX-{YYYY}-{SEQ}", example: "CN-UK-2026-000001" },
      refund: { prefix: "RF-UK-", format: "PREFIX-{YYYY}-{SEQ}", example: "RF-UK-2026-000001" },
    },
  },
  Australia: {
    default_currency: "AUD",
    home_currency: "AUD",
    base_currency: "AUD",
    supported_currencies: ["AUD", "USD", "NZD"],
    timezone: "Australia/Sydney",
    language: "en",
    locale: "en-AU",
    date_format: "DD-MM-YYYY",
    number_format: "en-AU",
    currency_symbol_position: "before",
    fiscal_year_start: "07-01",
    fiscal_year_end: "06-30",
    tax_type: "GST",
    tax_label: "GST",
    tax_number_label: "ABN",
    tax_calculation_method: "exclusive",
    is_tax_inclusive_default: false,
    invoice_prefix: "INV-",
    invoice_number_format: "PREFIX-{YYYY}-{SEQ}",
    invoice_sequence_reset: "annually",
    quote_prefix: "QTE-AU-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    quote_sequence_reset: "annually",
    credit_note_prefix: "CN-AU-",
    credit_note_number_format: "PREFIX-{YYYY}-{SEQ}",
    credit_note_sequence_reset: "annually",
    refund_prefix: "RF-AU-",
    refund_number_format: "PREFIX-{YYYY}-{SEQ}",
    refund_sequence_reset: "annually",
    default_payment_terms: "net_30",
    default_due_days: 30,
    payment_gateway_suggestions: [
      { id: "stripe", name: "Stripe", recommended: true, reason: "Popular in Australia" },
      { id: "eway", name: "eWAY", recommended: true, reason: "Australian payment gateway" },
      { id: "paypal", name: "PayPal", recommended: true, reason: "Widely accepted" },
      { id: "bank_transfer", name: "Bank Transfer", recommended: false, reason: "BPAY/Direct Entry" },
    ],
    tax_defaults: {
      tax_type: "GST",
      gst_enabled: true,
      default_gst_rate: 10,
      bas_reporting: true,
    },
    invoice_defaults: {
      show_tax_breakdown: true,
      show_abn: true,
      tax_invoice_label: "Tax Invoice",
    },
    registration_fields: [
      { key: "business_registration_number", label: "ABN", required: true, placeholder: "12 345 678 901", pattern: "^[0-9]{2} [0-9]{3} [0-9]{3} [0-9]{3}$", is_tax_field: true },
      { key: "gst_number", label: "GST Registration", required: true, placeholder: "Same as ABN", is_tax_field: true },
    ],
    number_formats: {
      invoice: { prefix: "INV-AU-", format: "PREFIX-{YYYY}-{SEQ}", example: "INV-AU-2026-000001" },
      quote: { prefix: "QTE-AU-", format: "PREFIX-{YYYY}-{SEQ}", example: "QTE-AU-2026-000001" },
      credit_note: { prefix: "CN-AU-", format: "PREFIX-{YYYY}-{SEQ}", example: "CN-AU-2026-000001" },
      refund: { prefix: "RF-AU-", format: "PREFIX-{YYYY}-{SEQ}", example: "RF-AU-2026-000001" },
    },
  },
  UAE: {
    default_currency: "AED",
    home_currency: "AED",
    base_currency: "AED",
    supported_currencies: ["AED", "USD", "EUR", "GBP"],
    timezone: "Asia/Dubai",
    language: "en",
    locale: "ar-AE",
    date_format: "DD-MM-YYYY",
    number_format: "ar-AE",
    currency_symbol_position: "before",
    fiscal_year_start: "01-01",
    fiscal_year_end: "12-31",
    tax_type: "VAT",
    tax_label: "VAT",
    tax_number_label: "TRN",
    tax_calculation_method: "exclusive",
    is_tax_inclusive_default: false,
    invoice_prefix: "INV-",
    invoice_number_format: "PREFIX-{YYYY}-{SEQ}",
    invoice_sequence_reset: "annually",
    quote_prefix: "QTE-AE-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    quote_sequence_reset: "annually",
    credit_note_prefix: "CN-AE-",
    credit_note_number_format: "PREFIX-{YYYY}-{SEQ}",
    credit_note_sequence_reset: "annually",
    refund_prefix: "RF-AE-",
    refund_number_format: "PREFIX-{YYYY}-{SEQ}",
    refund_sequence_reset: "annually",
    default_payment_terms: "net_30",
    default_due_days: 30,
    payment_gateway_suggestions: [
      { id: "checkout_com", name: "Checkout.com", recommended: true, reason: "Leading UAE gateway" },
      { id: "stripe", name: "Stripe", recommended: true, reason: "Available in UAE" },
      { id: "paytabs", name: "PayTabs", recommended: true, reason: "MENA payment platform" },
      { id: "paypal", name: "PayPal", recommended: false, reason: "Limited in UAE" },
      { id: "bank_transfer", name: "Bank Transfer", recommended: false, reason: "Local bank transfers" },
    ],
    tax_defaults: {
      tax_type: "VAT",
      vat_enabled: true,
      default_vat_rate: 5,
      trn_required: true,
      federal_tax_authority: true,
    },
    invoice_defaults: {
      show_tax_breakdown: true,
      show_trn: true,
      vat_invoice_required: true,
      arabic_support: true,
    },
    registration_fields: [
      { key: "business_registration_number", label: "Trade License", required: true, placeholder: "123456", is_tax_field: false },
      { key: "vat_number", label: "TRN (Tax Registration Number)", required: true, placeholder: "100000000000003", pattern: "^1[0-9]{14}$", is_tax_field: true },
    ],
    number_formats: {
      invoice: { prefix: "INV-AE-", format: "PREFIX-{YYYY}-{SEQ}", example: "INV-AE-2026-000001" },
      quote: { prefix: "QTE-AE-", format: "PREFIX-{YYYY}-{SEQ}", example: "QTE-AE-2026-000001" },
      credit_note: { prefix: "CN-AE-", format: "PREFIX-{YYYY}-{SEQ}", example: "CN-AE-2026-000001" },
      refund: { prefix: "RF-AE-", format: "PREFIX-{YYYY}-{SEQ}", example: "RF-AE-2026-000001" },
    },
  },
  Singapore: {
    default_currency: "SGD",
    home_currency: "SGD",
    base_currency: "SGD",
    supported_currencies: ["SGD", "USD", "EUR", "GBP", "MYR"],
    timezone: "Asia/Singapore",
    language: "en",
    locale: "en-SG",
    date_format: "DD/MM/YYYY",
    number_format: "en-SG",
    currency_symbol_position: "before",
    fiscal_year_start: "01-01",
    fiscal_year_end: "12-31",
    tax_type: "GST",
    tax_label: "GST",
    tax_number_label: "GST Reg No",
    tax_calculation_method: "exclusive",
    is_tax_inclusive_default: false,
    invoice_prefix: "INV-",
    invoice_number_format: "PREFIX-{YYYY}-{SEQ}",
    invoice_sequence_reset: "annually",
    quote_prefix: "QTE-SG-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    quote_sequence_reset: "annually",
    credit_note_prefix: "CN-SG-",
    credit_note_number_format: "PREFIX-{YYYY}-{SEQ}",
    credit_note_sequence_reset: "annually",
    refund_prefix: "RF-SG-",
    refund_number_format: "PREFIX-{YYYY}-{SEQ}",
    refund_sequence_reset: "annually",
    default_payment_terms: "net_30",
    default_due_days: 30,
    payment_gateway_suggestions: [
      { id: "stripe", name: "Stripe", recommended: true, reason: "Wide international support" },
      { id: "paypal", name: "PayPal", recommended: true, reason: "Popular in Singapore" },
      { id: "adyen", name: "Adyen", recommended: true, reason: "Enterprise payment platform" },
      { id: "bank_transfer", name: "Bank Transfer", recommended: false, reason: "Local bank transfers" },
    ],
    tax_defaults: {
      tax_type: "GST",
      gst_enabled: true,
      default_gst_rate: 9,
      gst_registration_required: true,
    },
    invoice_defaults: {
      show_tax_breakdown: true,
      show_gst: true,
      gst_invoice_required: true,
    },
    registration_fields: [
      { key: "business_registration_number", label: "UEN (Unique Entity Number)", required: true, placeholder: "201234567A", is_tax_field: false },
      { key: "gst_number", label: "GST Registration Number", required: false, placeholder: "M12345678X", is_tax_field: true },
    ],
    number_formats: {
      invoice: { prefix: "INV-SG-", format: "PREFIX-{YYYY}-{SEQ}", example: "INV-SG-2026-000001" },
      quote: { prefix: "QTE-SG-", format: "PREFIX-{YYYY}-{SEQ}", example: "QTE-SG-2026-000001" },
      credit_note: { prefix: "CN-SG-", format: "PREFIX-{YYYY}-{SEQ}", example: "CN-SG-2026-000001" },
      refund: { prefix: "RF-SG-", format: "PREFIX-{YYYY}-{SEQ}", example: "RF-SG-2026-000001" },
    },
  },
  Canada: {
    default_currency: "CAD",
    home_currency: "CAD",
    base_currency: "CAD",
    supported_currencies: ["CAD", "USD", "EUR"],
    timezone: "America/Toronto",
    language: "en",
    locale: "en-CA",
    date_format: "DD-MM-YYYY",
    number_format: "en-CA",
    currency_symbol_position: "before",
    fiscal_year_start: "01-01",
    fiscal_year_end: "12-31",
    tax_type: "GST/HST",
    tax_label: "GST/HST",
    tax_number_label: "Business Number",
    tax_calculation_method: "exclusive",
    is_tax_inclusive_default: false,
    invoice_prefix: "INV-",
    invoice_number_format: "PREFIX-{YYYY}-{SEQ}",
    invoice_sequence_reset: "annually",
    quote_prefix: "QTE-CA-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    quote_sequence_reset: "annually",
    credit_note_prefix: "CN-CA-",
    credit_note_number_format: "PREFIX-{YYYY}-{SEQ}",
    credit_note_sequence_reset: "annually",
    refund_prefix: "RF-CA-",
    refund_number_format: "PREFIX-{YYYY}-{SEQ}",
    refund_sequence_reset: "annually",
    default_payment_terms: "net_30",
    default_due_days: 30,
    payment_gateway_suggestions: [
      { id: "stripe", name: "Stripe", recommended: true, reason: "Widely used in Canada" },
      { id: "paypal", name: "PayPal", recommended: true, reason: "Widely accepted" },
      { id: "moneris", name: "Moneris", recommended: true, reason: "Canadian payment processor" },
      { id: "bank_transfer", name: "Bank Transfer", recommended: false, reason: "EFT/Interac e-Transfer" },
    ],
    tax_defaults: {
      tax_type: "GST/HST",
      gst_hst_enabled: true,
      provincial_sales_tax: true,
      default_gst_rate: 5,
    },
    invoice_defaults: {
      show_tax_breakdown: true,
      show_business_number: true,
      show_gst_hst_number: true,
    },
    registration_fields: [
      { key: "business_registration_number", label: "Business Number", required: true, placeholder: "123456789", is_tax_field: true },
      { key: "gst_number", label: "GST/HST Number", required: false, placeholder: "123456789RT0001", pattern: "^[0-9]{9}RT[0-9]{4}$", is_tax_field: true },
    ],
    number_formats: {
      invoice: { prefix: "INV-CA-", format: "PREFIX-{YYYY}-{SEQ}", example: "INV-CA-2026-000001" },
      quote: { prefix: "QTE-CA-", format: "PREFIX-{YYYY}-{SEQ}", example: "QTE-CA-2026-000001" },
      credit_note: { prefix: "CN-CA-", format: "PREFIX-{YYYY}-{SEQ}", example: "CN-CA-2026-000001" },
      refund: { prefix: "RF-CA-", format: "PREFIX-{YYYY}-{SEQ}", example: "RF-CA-2026-000001" },
    },
  },
};

export const FIELD_STATUS = {
  AUTO_CONFIGURED: "auto",
  SUGGESTED: "suggested",
  CUSTOMIZED: "custom",
  NEEDS_REVIEW: "review",
  MISSING: "missing",
  INVALID: "invalid",
};

export function getCountryDefaults(country) {
  return COUNTRY_DEFAULTS[resolveCountryKey(country)] || {};
}

export function getRegistrationFields(country) {
  const defaults = COUNTRY_DEFAULTS[resolveCountryKey(country)];
  return defaults?.registration_fields || [];
}

export function getPaymentGatewaySuggestions(country) {
  const defaults = COUNTRY_DEFAULTS[resolveCountryKey(country)];
  return defaults?.payment_gateway_suggestions || [];
}

export function getTaxDefaults(country) {
  const defaults = COUNTRY_DEFAULTS[resolveCountryKey(country)];
  return defaults?.tax_defaults || {};
}

export function getInvoiceDefaults(country) {
  const defaults = COUNTRY_DEFAULTS[resolveCountryKey(country)];
  return defaults?.invoice_defaults || {};
}

// Maps a country's registration_fields (keyed for org-level onboarding, e.g.
// "pan_number", "business_registration_number") onto the actual BillingCustomer
// tax columns (gst_number, pan, vat_number, tin, tax_id), returning only the
// fields flagged is_tax_field for that country. This is the single wiring point
// for "show only the relevant tax identifiers for the selected country" — no
// per-country label/pattern data is duplicated here, it's all read from
// COUNTRY_DEFAULTS via getRegistrationFields() above.
const REGISTRATION_KEY_TO_CUSTOMER_FIELD = {
  gst_number: "gst_number",
  pan_number: "pan",
  vat_number: "vat_number",
  tin_number: "tin",
  business_registration_number: "tax_id",
};

export function getCustomerTaxFields(country) {
  if (!country) {
    return [{ key: "tax_id", label: "Tax ID", placeholder: "", pattern: undefined }];
  }
  const regFields = getRegistrationFields(country);
  const taxFields = regFields.filter((f) => f.is_tax_field);
  if (!taxFields.length) {
    return [{ key: "tax_id", label: "Tax ID", placeholder: "", pattern: undefined }];
  }
  return taxFields.map((f) => ({
    key: REGISTRATION_KEY_TO_CUSTOMER_FIELD[f.key] || "tax_id",
    label: f.label,
    placeholder: f.placeholder || "",
    pattern: f.pattern,
  }));
}

export function getCurrencySymbolForCountry(country) {
  const defaults = COUNTRY_DEFAULTS[country];
  if (!defaults) return "";
  const symbols = { INR: "\u20B9", USD: "$", GBP: "\u00A3", AUD: "A$", AED: "AED", SGD: "S$" };
  return symbols[defaults.default_currency] || defaults.default_currency || "";
}

export function getDateFormatForCountry(country) {
  const defaults = COUNTRY_DEFAULTS[country];
  return defaults?.date_format || "DD-MM-YYYY";
}

export function getNumberFormatExample(country) {
  const formats = {
    India: "12,34,567.89",
    "United States": "1,234,567.89",
    "United Kingdom": "1,234,567.89",
    Australia: "1,234,567.89",
    UAE: "1,234,567.89",
    Singapore: "1,234,567.89",
  };
  return formats[country] || "1,234,567.89";
}

export function getNumberFormats(country) {
  const defaults = COUNTRY_DEFAULTS[country];
  return defaults?.number_formats || {};
}

export function getAllIntelligentFields() {
  const fields = new Set();
  Object.values(COUNTRY_DEFAULTS).forEach((defaults) => {
    Object.keys(defaults).forEach((k) => fields.add(k));
    if (defaults.payment_gateway_suggestions) {
      defaults.payment_gateway_suggestions.forEach((g) => fields.add(`gateway_${g.id}_enabled`));
    }
  });
  return Array.from(fields);
}

export function getFieldChangePreview(currentCountry, newCountry, currentForm) {
  const currentDefaults = COUNTRY_DEFAULTS[currentCountry] || {};
  const newDefaults = COUNTRY_DEFAULTS[newCountry] || {};
  const changes = [];

  const allKeys = new Set([...Object.keys(currentDefaults), ...Object.keys(newDefaults)]);

  allKeys.forEach((key) => {
    const currentVal = currentDefaults[key];
    const newVal = newDefaults[key];
    const formVal = currentForm[key];

    if (currentVal !== newVal) {
      const isCustomized = formVal !== undefined && formVal !== null && formVal !== currentVal;
      changes.push({
        field: key,
        label: formatFieldLabel(key),
        currentDefault: currentVal,
        newDefault: newVal,
        currentValue: formVal,
        willChange: !isCustomized,
        status: isCustomized ? FIELD_STATUS.CUSTOMIZED : FIELD_STATUS.AUTO_CONFIGURED,
      });
    }
  });

  return changes;
}

function formatFieldLabel(key) {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (l) => l.toUpperCase())
    .replace(/Id$/, " ID")
    .replace(/Url$/, " URL")
    .replace(/Gst/, "GST")
    .replace(/Vat/, "VAT")
    .replace(/Pan/, "PAN")
    .replace(/Ein/, "EIN")
    .replace(/Trn/, "TRN")
    .replace(/Abn/, "ABN")
    .replace(/Cin/, "CIN");
}

const getRegFieldValidator = (key, country, required) => {
  return (v) => {
    if (v === undefined || v === null || v === "") {
      return !required;
    }
    if (country === "India") {
      if (key === "gst_number") return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(v);
      if (key === "pan_number") return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(v);
    }
    if (country === "United States") {
      if (key === "business_registration_number") return /^[0-9]{2}-[0-9]{7}$/.test(v);
    }
    if (country === "United Kingdom") {
      if (key === "business_registration_number") return /^[0-9]{8}$/.test(v);
      if (key === "vat_number") return /^GB[0-9]{9}$/.test(v);
    }
    if (country === "Australia") {
      if (key === "business_registration_number") return /^[0-9]{2} [0-9]{3} [0-9]{3} [0-9]{3}$/.test(v);
      if (key === "gst_number") return /^[0-9]{2} [0-9]{3} [0-9]{3} [0-9]{3}$/.test(v) || v.toLowerCase() === "same as abn";
    }
    if (country === "UAE") {
      if (key === "vat_number") return /^1[0-9]{14}$/.test(v);
    }
    return v.length >= 2;
  };
};

export function validateConfiguration(form) {
  const errors = [];
  const warnings = [];
  const passed = [];

  const checks = [
    { key: "company_name", label: "Company Name", required: true, validator: (v) => v && v.length >= 2 },
    { key: "billing_email", label: "Billing Email", required: true, validator: (v) => v && /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(v) },
    { key: "support_email", label: "Support Email", required: false, validator: (v) => !v || /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(v) },
    { key: "billing_phone", label: "Billing Phone", required: false, validator: (v) => {
        if (!v) return true;
        const cleaned = v.replace(/[\s\-\+\(\)]/g, "");
        return /^\d+$/.test(cleaned) && cleaned.length >= 7 && cleaned.length <= 15;
      }
    },
    { key: "website", label: "Website", required: false, validator: (v) => !v || /^https?:\/\/([\w\-]+\.)+[\w\-]+(\/[\w\-\.~:/?#\[\]@!$&'\(\)\*\+,;=]*)?$/.test(v) },
    { key: "country", label: "Country", required: true, validator: (v) => v && SUPPORTED_COUNTRIES.includes(v) },
    { key: "default_currency", label: "Default Currency", required: true, validator: (v) => v },
    { key: "home_currency", label: "Home Currency", required: false, validator: (v) => !v || v },
    { key: "timezone", label: "Timezone", required: true, validator: (v) => v },
    { key: "language", label: "Language", required: false, validator: (v) => !v || v.length >= 2 },
    { key: "date_format", label: "Date Format", required: true, validator: (v) => v },
    { key: "short_name", label: "Short Name", required: false, validator: (v) => !v || v.length >= 1 },
    { key: "invoice_prefix", label: "Invoice Prefix", required: true, validator: (v) => v && v.length <= 10 && /^[A-Za-z0-9\-_]+$/.test(v) },
    { key: "invoice_number_format", label: "Invoice Number Format", required: true, validator: (v) => v },
    { key: "quote_prefix", label: "Quote Prefix", required: false, validator: (v) => !v || (v.length <= 10 && /^[A-Za-z0-9\-_]+$/.test(v)) },
    { key: "credit_note_prefix", label: "Credit Note Prefix", required: false, validator: (v) => !v || (v.length <= 10 && /^[A-Za-z0-9\-_]+$/.test(v)) },
    { key: "refund_prefix", label: "Refund Prefix", required: false, validator: (v) => !v || (v.length <= 10 && /^[A-Za-z0-9\-_]+$/.test(v)) },
    { key: "tax_number", label: "Tax Registration Number", required: false, validator: (v) => !v || v.length >= 2 },
    { key: "tax_label", label: "Tax Label", required: true, validator: (v) => v && v.length >= 1 },
    { key: "tax_calculation_method", label: "Tax Calculation Method", required: true, validator: (v) => v },
    { key: "fiscal_year_start", label: "Fiscal Year Start", required: true, validator: (v) => v && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v) },
    { key: "fiscal_year_end", label: "Fiscal Year End", required: true, validator: (v) => v && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v) },
    { key: "default_payment_terms", label: "Default Payment Terms", required: true, validator: (v) => v },
    { key: "default_due_days", label: "Default Due Days", required: true, validator: (v) => v && v > 0 },
    { key: "address_line1", label: "Address Line 1", required: false, validator: (v) => !v || v.length >= 5 },
    { key: "city", label: "City", required: false, validator: (v) => !v || v.length >= 2 },
    { key: "state", label: "State / Province", required: false, validator: (v) => !v || v.length >= 1 },
    { key: "postal_code", label: "Postal Code", required: false, validator: (v) => !v || v.length >= 3 },
    { key: "currency_precision", label: "Currency Precision", required: false, validator: (v) => v === undefined || v === null || (v >= 0 && v <= 10) },
    { key: "rounding_method", label: "Rounding Method", required: false, validator: (v) => !v || ["none","up","down","half_up","half_down","half_even"].includes(v) },
    { key: "exchange_rate_provider", label: "Exchange Rate Provider", required: false, validator: (v) => !v || v },
    { key: "default_tax_rate_id", label: "Default Tax Rate", required: false, validator: (v) => true },
  ];

  if (form.country) {
    const regFields = getRegistrationFields(form.country);
    regFields.forEach((rf) => {
      checks.push({
        key: rf.key,
        label: rf.label,
        required: !!rf.required,
        validator: getRegFieldValidator(rf.key, form.country, !!rf.required),
      });
    });
  }

  checks.forEach((check) => {
    const value = form[check.key];
    const isValid = check.validator(value);

    if (check.required && (value === undefined || value === null || value === "")) {
      errors.push({ field: check.key, label: check.label, message: `${check.label} is required` });
    } else if (value !== undefined && value !== null && value !== "" && !isValid) {
      errors.push({ field: check.key, label: check.label, message: `${check.label} is invalid` });
    } else if (value !== undefined && value !== null && value !== "" && value !== false) {
      passed.push({ field: check.key, label: check.label });
    }
  });

  // Smart warnings
  if (form.company_name && !form.logo_url) {
    warnings.push({ field: "logo_url", label: "Company Logo", message: "Consider uploading a company logo for professional invoices" });
  }
  if (form.default_currency && form.home_currency && form.default_currency !== form.home_currency) {
    warnings.push({ field: "home_currency", label: "Home Currency", message: "Home currency differs from default currency; exchange rates will apply" });
  }
  if (form.country && !SUPPORTED_COUNTRIES.includes(form.country)) {
    warnings.push({ field: "country", label: "Country", message: `Smart defaults not available for ${form.country}. Configure manually.` });
  }
  if (form.billing_email && form.support_email && form.billing_email === form.support_email) {
    warnings.push({ field: "support_email", label: "Support Email", message: "Billing and support emails are identical; consider using separate addresses" });
  }
  if (form.invoice_prefix && form.quote_prefix && form.invoice_prefix === form.quote_prefix) {
    warnings.push({ field: "invoice_prefix", label: "Invoice Prefix", message: "Invoice and quote prefixes are identical; consider differentiating them" });
  }
  if (form.default_payment_terms && !form.supported_payment_methods?.length && !form.gateway_stripe_enabled && !form.gateway_razorpay_enabled && !form.gateway_paypal_enabled && !form.gateway_bank_transfer_enabled) {
    warnings.push({ field: "default_payment_terms", label: "Payment Gateways", message: "No payment gateways enabled; customers cannot make online payments" });
  }
  if (form.fiscal_year_start && form.fiscal_year_end && form.fiscal_year_start === form.fiscal_year_end) {
    warnings.push({ field: "fiscal_year_start", label: "Fiscal Year", message: "Fiscal year start and end are identical; check the dates" });
  }

  const totalChecks = checks.length;
  const score = totalChecks > 0 ? Math.round((passed.length / totalChecks) * 100) : 0;

  return {
    valid: errors.length === 0,
    score,
    passed: passed.length,
    warnings: warnings.length,
    errors: errors.length,
    checks: { passed, warnings, errors },
    fieldErrors: errors.reduce((acc, e) => ({ ...acc, [e.field]: e.message }), {}),
  };
}

export function calculateHealthScore(form) {
  const sections = {
    organization_profile: {
      label: "Organization Profile",
      weight: 20,
      fields: ["company_name", "billing_email", "website", "logo_url", "address_line1", "city", "postal_code", "country"],
    },
    regional_settings: {
      label: "Regional Settings",
      weight: 15,
      fields: ["default_currency", "home_currency", "timezone", "language", "date_format", "number_format", "fiscal_year_start", "fiscal_year_end"],
    },
    invoice_configuration: {
      label: "Invoice Configuration",
      weight: 20,
      fields: ["invoice_prefix", "invoice_number_format", "quote_prefix", "credit_note_prefix", "refund_prefix", "default_due_days", "invoice_template", "default_payment_terms"],
    },
    tax_configuration: {
      label: "Tax Configuration",
      weight: 20,
      fields: ["tax_label", "tax_calculation_method", "tax_number", "gst_enabled", "sales_tax_enabled", "vat_enabled"],
    },
    payment_configuration: {
      label: "Payment Configuration",
      weight: 15,
      fields: ["default_payment_terms", "gateway_stripe_enabled", "gateway_razorpay_enabled", "gateway_paypal_enabled", "gateway_bank_transfer_enabled", "auto_send_receipts"],
    },
    notification_configuration: {
      label: "Notification Configuration",
      weight: 10,
      fields: ["notify_invoice_created", "notify_invoice_paid", "notify_invoice_overdue", "notify_payment_failed", "notify_payment_success"],
    },
  };

  const results = {};
  let totalScore = 0;
  let totalWeight = 0;
  const completedItems = [];
  const missingItems = [];
  const warningItems = [];

  Object.entries(sections).forEach(([key, section]) => {
    let completed = 0;
    let total = section.fields.length;
    let sectionWarnings = 0;

    section.fields.forEach((field) => {
      const value = form[field];
      if (value !== undefined && value !== null && value !== "" && value !== false) {
        completed++;
      } else if (field.endsWith("_enabled") && value === false) {
        completed++;
      } else {
        missingItems.push({ section: section.label, field: formatFieldLabel(field) });
      }
    });

    if (section.label === "Organization Profile" && form.company_name && !form.logo_url) {
      sectionWarnings++;
      warningItems.push({ section: section.label, message: "Company logo not uploaded" });
    }
    if (section.label === "Tax Configuration" && form.country) {
      const taxDefaults = getTaxDefaults(form.country);
      if (taxDefaults.gst_enabled && !form.gst_enabled) {
        sectionWarnings++;
        warningItems.push({ section: section.label, message: `GST recommended for ${form.country} but not enabled` });
      }
      if (taxDefaults.vat_enabled && !form.sales_tax_enabled) {
        sectionWarnings++;
        warningItems.push({ section: section.label, message: `VAT recommended for ${form.country} but not enabled` });
      }
    }
    if (section.label === "Payment Configuration") {
      const gateways = ["gateway_stripe_enabled", "gateway_razorpay_enabled", "gateway_paypal_enabled", "gateway_bank_transfer_enabled"];
      const enabledGateways = gateways.filter((g) => form[g]).length;
      if (enabledGateways === 0) {
        sectionWarnings++;
        warningItems.push({ section: section.label, message: "No payment gateways enabled" });
      }
    }

    const sectionScore = total > 0 ? Math.round((completed / total) * 100) : 0;
    results[key] = {
      label: section.label,
      score: sectionScore,
      completed,
      total,
      weight: section.weight,
      warnings: sectionWarnings,
    };

    totalScore += sectionScore * section.weight;
    totalWeight += section.weight;
    completedItems.push(...section.fields.filter((f) => {
      const v = form[f];
      return v !== undefined && v !== null && v !== "" && v !== false;
    }).map((f) => ({ section: section.label, field: formatFieldLabel(f) })));
  });

  const overallScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;

  let readiness = "Not Ready";
  if (overallScore >= 90) readiness = "Production Ready";
  else if (overallScore >= 70) readiness = "Almost Ready";
  else if (overallScore >= 50) readiness = "Needs Configuration";
  else readiness = "Not Configured";

  return {
    overallScore,
    readiness,
    sections: results,
    completedItems: completedItems.length,
    missingItems: missingItems.length,
    warnings: warningItems.length,
    completedDetails: completedItems,
    missingDetails: missingItems,
    warningDetails: warningItems,
  };
}

export function getSmartRecommendations(form) {
  const recommendations = [];

  if (!form.logo_url && form.company_name) {
    recommendations.push({
      id: "logo",
      title: "Upload Company Logo",
      description: "Add a professional logo to your invoices and documents",
      action: "Upload logo",
      field: "logo_url",
      priority: "high",
      completed: false,
    });
  }

  if (form.country) {
    const taxDefaults = getTaxDefaults(form.country);
    if (taxDefaults.gst_enabled && !form.gst_enabled) {
      recommendations.push({
        id: "gst",
        title: `Configure ${taxDefaults.tax_type || "GST"}`,
        description: `${taxDefaults.tax_type || "GST"} is required for ${form.country}. Enable and configure tax rates.`,
        action: "Configure Tax",
        field: "gst_enabled",
        priority: "high",
        completed: false,
      });
    }
    if (taxDefaults.vat_enabled && !form.sales_tax_enabled) {
      recommendations.push({
        id: "vat",
        title: `Configure ${taxDefaults.tax_type || "VAT"}`,
        description: `${taxDefaults.tax_type || "VAT"} is required for ${form.country}. Enable and configure VAT rates.`,
        action: "Configure Tax",
        field: "sales_tax_enabled",
        priority: "high",
        completed: false,
      });
    }
  }

  if (!form.address_line1 || !form.city || !form.postal_code) {
    recommendations.push({
      id: "address",
      title: "Complete Business Address",
      description: "Full address is required for tax compliance and invoice generation",
      action: "Add Address",
      field: "address_line1",
      priority: "high",
      completed: false,
    });
  }

  if (!form.invoice_prefix || form.invoice_prefix === "INV-") {
    recommendations.push({
      id: "invoice_prefix",
      title: "Configure Invoice Numbering",
      description: "Set up country-specific invoice prefixes for professional numbering",
      action: "Set Prefix",
      field: "invoice_prefix",
      priority: "medium",
      completed: false,
    });
  }

  const gateways = ["gateway_stripe_enabled", "gateway_razorpay_enabled", "gateway_paypal_enabled", "gateway_bank_transfer_enabled", "gateway_upi_enabled", "gateway_cash_enabled"];
  const enabledGateways = gateways.filter((g) => form[g]).length;
  if (enabledGateways === 0) {
    recommendations.push({
      id: "payment_gateway",
      title: "Enable Payment Gateway",
      description: "Configure at least one payment gateway to accept online payments",
      action: "Configure Gateway",
      field: "gateway_stripe_enabled",
      priority: "high",
      completed: false,
    });
  }

  if (!form.tax_number && form.country) {
    const taxDefaults = getTaxDefaults(form.country);
    recommendations.push({
      id: "tax_number",
      title: `Add ${taxDefaults.tax_number_label || "Tax Registration Number"}`,
      description: `Enter your ${taxDefaults.tax_number_label || "tax registration number"} for compliance`,
      action: "Add Tax Number",
      field: "tax_number",
      priority: "high",
      completed: false,
    });
  }

  if (!form.website) {
    recommendations.push({
      id: "website",
      title: "Add Company Website",
      description: "Website improves credibility and enables auto-suggestions for emails",
      action: "Add Website",
      field: "website",
      priority: "low",
      completed: false,
    });
  }

  if (!form.enable_auto_tax_calculation) {
    recommendations.push({
      id: "auto_tax",
      title: "Enable Auto Tax Calculation",
      description: "Automatically calculate taxes based on customer location and tax rules",
      action: "Enable Auto Tax",
      field: "enable_auto_tax_calculation",
      priority: "medium",
      completed: false,
    });
  }

  return recommendations.filter((r) => !r.completed);
}

export function getInvoiceNumberSuggestions(country, prefix, format) {
  const defaults = COUNTRY_DEFAULTS[country] || {};
  const formats = defaults.number_formats || {};
  const suggestions = [];

  if (formats.invoice) {
    suggestions.push({
      label: "Recommended (Country Default)",
      prefix: formats.invoice.prefix,
      format: formats.invoice.format,
      example: formats.invoice.example,
    });
  }

  const year = new Date().getFullYear();
  const seq = "000001";

  if (prefix && format) {
    const example = format
      .replace("{PREFIX}", prefix)
      .replace("{YYYY}", year.toString())
      .replace("{YY}", year.toString().slice(-2))
      .replace("{MM}", String(new Date().getMonth() + 1).padStart(2, "0"))
      .replace("{SEQ}", seq);
    suggestions.push({
      label: "Current Configuration",
      prefix,
      format,
      example,
    });
  }

  const templates = [
    { prefix: `${prefix || "INV-"}${year}-`, format: "PREFIX{SEQ}", example: `${prefix || "INV-"}${year}-${seq}` },
    { prefix: `${prefix || "INV-"}${year}`, format: "PREFIX-{SEQ}", example: `${prefix || "INV-"}${year}${seq}` },
    { prefix: `${prefix || "INV-"}`, format: "PREFIX-{YYYY}-{SEQ}", example: `${prefix || "INV-"}${year}-${seq}` },
    { prefix: `${prefix || "INV-"}`, format: "PREFIX-{YYYYMM}-{SEQ}", example: `${prefix || "INV-"}${year}${String(new Date().getMonth() + 1).padStart(2, "0")}-${seq}` },
  ];

  templates.forEach((t) => {
    if (!suggestions.some((s) => s.example === t.example)) {
      suggestions.push({ label: "Alternative", ...t });
    }
  });

  return suggestions;
}