import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";

import { Save, RefreshCw, AlertCircle, CheckCircle, Settings2,
  Building2, Globe, FileText, Receipt, Wallet, Percent,
  Bell, Shield, RotateCcw, MapPin, CreditCard,
  BadgePercent, Activity, ChevronDown, X, Search, Info,
  ArrowRight, Zap, Mail, Eye, Server, Hash, DollarSign,
  Thermometer, FileJson } from "lucide-react"
import { settingsApi } from "../../../service/billingService";
import {
  CURRENCY_MASTER, getCurrencySymbol, formatCurrency, getCurrencySelectOptions,
} from "../../../utils/currency";
import { getLanguageSelectOptions } from "../../../utils/language";
import { formatNumber, getEffectiveLocale } from "../../../utils/locale";
import { formatLastUpdated } from "../../../components/billing-shared";

const TABS = [
  { id: "general", label: "General", icon: Building2 },
  { id: "invoicing", label: "Invoicing", icon: FileText },
  { id: "payments", label: "Payments", icon: Wallet },
  { id: "tax", label: "Tax", icon: Receipt },
  { id: "dunning", label: "Dunning", icon: Percent },
  { id: "revenue", label: "Revenue", icon: Activity },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "advanced", label: "Advanced", icon: Shield },
  { id: "administration", label: "Administration", icon: Server },
];

const TAB_ACTIVE_CLASSES = {
  general: "border-[#FF7A00] text-[#FF7A00]",
  invoicing: "border-blue-500 text-blue-600",
  payments: "border-emerald-500 text-emerald-600",
  tax: "border-amber-500 text-amber-600",
  dunning: "border-rose-500 text-rose-600",
  revenue: "border-cyan-500 text-cyan-600",
  notifications: "border-indigo-500 text-indigo-600",
  advanced: "border-slate-500 text-slate-600",
  administration: "border-slate-500 text-slate-600",
};

const CURRENCY_OPTIONS_WITH_INFO = getCurrencySelectOptions();

const FIELD_STATUS = {
  AUTO_CONFIGURED: "auto",
  CUSTOMIZED: "custom",
  SUGGESTED: "suggested",
  NEEDS_REVIEW: "review",
  MISSING: "missing",
  INVALID: "invalid"
};

const defaultForm = {
  company_name: "", billing_email: "", billing_phone: "", website: "", logo_url: "",
  country: "", state: "", city: "", postal_code: "", address_line1: "", address_line2: "",
  support_email: "", short_name: "",
  business_registration_number: "", gst_number: "", vat_number: "", pan_number: "", tin_number: "",
  fiscal_year_start: "01-01", fiscal_year_end: "12-31",
  default_currency: "USD", home_currency: "USD", base_currency: "USD",
  supported_currencies: ["USD"],
  date_format: "DD-MM-YYYY", timezone: "UTC", language: "en",
  currency_precision: 2, currency_symbol_position: "before",

  invoice_prefix: "INV-", invoice_number_format: "PREFIX-{YYYY}-{SEQ}", invoice_sequence_reset: "annually",
  quote_prefix: "QTE-", quote_number_format: "PREFIX-{YYYY}-{SEQ}", quote_sequence_reset: "annually",
  credit_note_prefix: "CN-", credit_note_number_format: "PREFIX-{YYYY}-{SEQ}", credit_note_sequence_reset: "annually",
  refund_prefix: "RF-", refund_number_format: "PREFIX-{YYYY}-{SEQ}", refund_sequence_reset: "annually",
  auto_generate_invoice_number: true,
  invoice_footer: "", invoice_terms: "", invoice_notes: "",
  invoice_logo_url: "", invoice_watermark: "", invoice_template: "standard",
  invoice_pdf_template: "standard", draft_behaviour: "save_as_draft",
  invoice_terms_and_conditions: "",
  show_tax_breakdown: true, show_discount: true, show_shipping: false,
  default_due_days: 30, payment_reminder_days_before: 3,
  late_payment_fee_percentage: 0, late_payment_fee_flat: 0,

  default_payment_terms: "net_30",
  payment_term_options: ["net_30", "net_15", "net_7", "due_on_receipt"],
  supported_payment_methods: ["credit_card", "bank_transfer", "paypal"],
  auto_send_receipts: true,
  exchange_rate_provider: "manual", exchange_rate_auto_update: false,
  rounding_method: "half_up", rounding_precision: 2,

  gateway_stripe_enabled: false, gateway_razorpay_enabled: false,
  gateway_paypal_enabled: true, gateway_cash_enabled: true,
  gateway_bank_transfer_enabled: true, gateway_upi_enabled: false,
  gateway_offline_enabled: true,
  webhook_secret: "", auto_capture_enabled: true,
  grace_period_days: 0, credit_limit: 0,

  tax_calculation_method: "exclusive", default_tax_rate_id: null,
  tax_label: "VAT", tax_number: "", tax_profiles: [],
  is_tax_inclusive_default: false, show_tax_on_invoice: true,
  enable_auto_tax_calculation: false,
  gst_enabled: false, sales_tax_enabled: false, service_tax_enabled: false,
  withholding_tax_enabled: false, reverse_charge_enabled: false, compound_tax_enabled: false,
  tax_rounding_method: "per_line",

  auto_dunning: false, dunning_level_count: 4, dunning_wait_days: 3,
  dunning_action_types: ["email_reminder"],
  enable_escalation_to_collections: false, collections_wait_days: 30,
  dunning_email_template: "",
  reminder_sms_enabled: false, reminder_whatsapp_enabled: false,
  auto_suspend_enabled: false, grace_days: 0,

  enable_revenue_recognition: false,
  revenue_recognition_method: "immediate", revenue_recognition_deferral_days: 0,
  recognized_revenue_method: "accrual", recognition_frequency: "monthly",

  enable_multi_currency: false,

  notification_preferences: {}, email_templates: {}, sms_templates: {},
  notify_invoice_created: true, notify_invoice_sent: true,
  notify_invoice_paid: true, notify_invoice_overdue: true,
  notify_subscription_renewed: true, notify_subscription_cancelled: true,
  notify_payment_failed: true, notify_payment_success: true,
  notify_customer_created: false,

  enable_approval_workflow: false, enable_credit_notes: true,
  enable_discounts: true, enable_retainers: false,
  enable_schedule_invoicing: false, enable_partial_payments: true,
  enable_auto_apply_credits: true,
  enable_quotes: true, enable_contracts: true,
  enable_usage_billing: false, enable_refunds: true,
  enable_auto_taxes: false, enable_audit_logs: true,
  security_settings: {},
};

const registrationFieldConfig = (country) => {
  const c = country || "";
  const isPhase = SUPPORTED_PHASE1.includes(c);
  // Default: show all fields
  const defaults = {
    business_registration_number: { show: true, label: "Business Registration Number" },
    gst_number: { show: true, label: "GSTIN" },
    vat_number: { show: true, label: "VAT Number" },
    pan_number: { show: true, label: "PAN Number" },
    tin_number: { show: true, label: "Tax ID / Sales Tax ID" },
  };
  if (!isPhase) return defaults;
  if (c === "India") {
    return {
      business_registration_number: { show: true, label: "CIN / Business Reg. Number" },
      gst_number: { show: true, label: "GSTIN" },
      vat_number: { show: false, label: "VAT Number" },
      pan_number: { show: true, label: "PAN Number" },
      tin_number: { show: false, label: "TIN Number" },
    };
  }
  if (c === "United States") {
    return {
      business_registration_number: { show: true, label: "EIN" },
      gst_number: { show: false, label: "GSTIN" },
      vat_number: { show: false, label: "VAT Number" },
      pan_number: { show: false, label: "PAN Number" },
      tin_number: { show: true, label: "Sales Tax ID" },
    };
  }
  if (c === "United Kingdom") {
    return {
      business_registration_number: { show: true, label: "Company Number" },
      gst_number: { show: false, label: "GSTIN" },
      vat_number: { show: true, label: "VAT Number" },
      pan_number: { show: false, label: "PAN Number" },
      tin_number: { show: false, label: "TIN Number" },
    };
  }
  if (c === "Australia") {
    return {
      business_registration_number: { show: true, label: "ABN" },
      gst_number: { show: true, label: "GST" },
      vat_number: { show: false, label: "VAT Number" },
      pan_number: { show: false, label: "PAN Number" },
      tin_number: { show: false, label: "TIN Number" },
    };
  }
  if (c === "UAE") {
    return {
      business_registration_number: { show: true, label: "Trade License" },
      gst_number: { show: false, label: "GSTIN" },
      vat_number: { show: true, label: "VAT Number" },
      pan_number: { show: false, label: "PAN Number" },
      tin_number: { show: false, label: "TIN Number" },
    };
  }
  return defaults;
};


const COUNTRY_DEFAULTS = {
  "India": {
    default_currency: "INR",
    home_currency: "INR",
    base_currency: "INR",
    supported_currencies: ["INR", "USD", "EUR", "GBP"],
    timezone: "Asia/Kolkata",
    language: "en",
    date_format: "DD-MM-YYYY",
    currency_symbol: "\u20B9",
    currency_symbol_position: "before",
    number_format: "en-IN",
    invoice_prefix: "INV-",
    invoice_number_format: "PREFIX-{YYYY}-{SEQ}",
    invoice_sequence_reset: "annually",
    quote_prefix: "QTE-IN-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    credit_note_prefix: "CN-IN-",
    credit_note_number_format: "PREFIX-{YYYY}-{SEQ}",
    refund_prefix: "RF-IN-",
    refund_number_format: "PREFIX-{YYYY}-{SEQ}",
    default_payment_terms: "net_30",
    default_due_days: 30,
    fiscal_year_start: "04-01",
    fiscal_year_end: "03-31",
    tax_label: "GST",
    tax_type: "GST",
    tax_calculation_method: "exclusive",
    is_tax_inclusive_default: false,
    gst_enabled: true,
    sales_tax_enabled: false,
  },
  "United States": {
    default_currency: "USD",
    home_currency: "USD",
    base_currency: "USD",
    supported_currencies: ["USD", "CAD", "EUR", "GBP"],
    timezone: "America/New_York",
    language: "en",
    date_format: "MM-DD-YYYY",
    currency_symbol: "$",
    currency_symbol_position: "before",
    number_format: "en-US",
    invoice_prefix: "INV-",
    invoice_number_format: "PREFIX-{YYYY}-{SEQ}",
    invoice_sequence_reset: "annually",
    quote_prefix: "QTE-US-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    credit_note_prefix: "CN-US-",
    credit_note_number_format: "PREFIX-{YYYY}-{SEQ}",
    refund_prefix: "RF-US-",
    refund_number_format: "PREFIX-{YYYY}-{SEQ}",
    default_payment_terms: "net_30",
    default_due_days: 30,
    fiscal_year_start: "01-01",
    fiscal_year_end: "12-31",
    tax_label: "Sales Tax",
    tax_type: "Sales Tax",
    tax_calculation_method: "exclusive",
    is_tax_inclusive_default: false,
    gst_enabled: false,
    sales_tax_enabled: true,
  },
  "United Kingdom": {
    default_currency: "GBP",
    home_currency: "GBP",
    base_currency: "GBP",
    supported_currencies: ["GBP", "EUR", "USD"],
    timezone: "Europe/London",
    language: "en",
    date_format: "DD-MM-YYYY",
    currency_symbol: "\u00A3",
    currency_symbol_position: "before",
    number_format: "en-GB",
    invoice_prefix: "INV-",
    invoice_number_format: "PREFIX-{YYYY}-{SEQ}",
    invoice_sequence_reset: "annually",
    quote_prefix: "QTE-UK-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    credit_note_prefix: "CN-UK-",
    credit_note_number_format: "PREFIX-{YYYY}-{SEQ}",
    refund_prefix: "RF-UK-",
    refund_number_format: "PREFIX-{YYYY}-{SEQ}",
    default_payment_terms: "net_30",
    default_due_days: 30,
    fiscal_year_start: "04-01",
    fiscal_year_end: "03-31",
    tax_label: "VAT",
    tax_type: "VAT",
    tax_calculation_method: "exclusive",
    is_tax_inclusive_default: false,
    gst_enabled: false,
    sales_tax_enabled: true,
  },
  "UAE": {
    default_currency: "AED",
    home_currency: "AED",
    base_currency: "AED",
    supported_currencies: ["AED", "USD", "EUR", "GBP"],
    timezone: "Asia/Dubai",
    language: "en",
    date_format: "DD-MM-YYYY",
    currency_symbol: "AED",
    currency_symbol_position: "before",
    number_format: "ar-AE",
    invoice_prefix: "INV-",
    invoice_number_format: "PREFIX-{YYYY}-{SEQ}",
    invoice_sequence_reset: "annually",
    quote_prefix: "QTE-AE-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    credit_note_prefix: "CN-AE-",
    credit_note_number_format: "PREFIX-{YYYY}-{SEQ}",
    refund_prefix: "RF-AE-",
    refund_number_format: "PREFIX-{YYYY}-{SEQ}",
    default_payment_terms: "net_30",
    default_due_days: 30,
    fiscal_year_start: "01-01",
    fiscal_year_end: "12-31",
    tax_label: "VAT",
    tax_type: "VAT",
    tax_calculation_method: "exclusive",
    is_tax_inclusive_default: false,
    gst_enabled: false,
    sales_tax_enabled: true,
  },
  "Singapore": {
    default_currency: "SGD",
    home_currency: "SGD",
    base_currency: "SGD",
    supported_currencies: ["SGD", "USD", "EUR", "GBP"],
    timezone: "Asia/Singapore",
    language: "en",
    date_format: "DD-MM-YYYY",
    currency_symbol: "S$",
    currency_symbol_position: "before",
    number_format: "en-SG",
    invoice_prefix: "INV-",
    invoice_number_format: "PREFIX-{YYYY}-{SEQ}",
    invoice_sequence_reset: "annually",
    quote_prefix: "QTE-SG-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    credit_note_prefix: "CN-SG-",
    credit_note_number_format: "PREFIX-{YYYY}-{SEQ}",
    refund_prefix: "RF-SG-",
    refund_number_format: "PREFIX-{YYYY}-{SEQ}",
    default_payment_terms: "net_30",
    default_due_days: 30,
    fiscal_year_start: "01-01",
    fiscal_year_end: "12-31",
    tax_label: "GST",
    tax_type: "GST",
    tax_calculation_method: "exclusive",
    is_tax_inclusive_default: false,
    gst_enabled: true,
    sales_tax_enabled: false,
  },
  "Australia": {
    default_currency: "AUD",
    home_currency: "AUD",
    base_currency: "AUD",
    supported_currencies: ["AUD", "USD", "NZD"],
    timezone: "Australia/Sydney",
    language: "en",
    date_format: "DD-MM-YYYY",
    currency_symbol: "A$",
    currency_symbol_position: "before",
    number_format: "en-AU",
    invoice_prefix: "INV-",
    invoice_number_format: "PREFIX-{YYYY}-{SEQ}",
    invoice_sequence_reset: "annually",
    quote_prefix: "QTE-AU-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    credit_note_prefix: "CN-AU-",
    credit_note_number_format: "PREFIX-{YYYY}-{SEQ}",
    refund_prefix: "RF-AU-",
    refund_number_format: "PREFIX-{YYYY}-{SEQ}",
    default_payment_terms: "net_30",
    default_due_days: 30,
    fiscal_year_start: "07-01",
    fiscal_year_end: "06-30",
    tax_label: "GST",
    tax_type: "GST",
    tax_calculation_method: "exclusive",
    is_tax_inclusive_default: false,
    gst_enabled: true,
    sales_tax_enabled: false,
  },
};

const SUPPORTED_PHASE1 = ["India","United States","United Kingdom","Australia","UAE","Singapore"];

const getCountryDefaults = (country) => {
  return COUNTRY_DEFAULTS[country] || {};
};

const generateInvoicePreview = (prefix, format, seq = 245) => {
  const year = new Date().getFullYear();
  const month = String(new Date().getMonth() + 1).padStart(2, "0");
  const seqStr = String(seq).padStart(6, "0");
  const nextSeqStr = String(seq + 1).padStart(6, "0");
  const current = (format || "PREFIX-{YYYY}-{SEQ}")
    .replace("PREFIX", prefix || "INV-")
    .replace("{YYYY}", String(year))
    .replace("{YY}", String(year).slice(-2))
    .replace("{MM}", month)
    .replace("{SEQ}", seqStr);
  const next = (format || "PREFIX-{YYYY}-{SEQ}")
    .replace("PREFIX", prefix || "INV-")
    .replace("{YYYY}", String(year))
    .replace("{YY}", String(year).slice(-2))
    .replace("{MM}", month)
    .replace("{SEQ}", nextSeqStr);
  return { current, next };
};

const TEMPLATE_DESCRIPTIONS = {
  standard: "Clean, professional layout suitable for most businesses",
  modern: "Contemporary design with bold colors and clean typography",
  professional: "Formal corporate layout with detailed sections",
  minimal: "Simple, distraction-free design focusing on content",
  bold: "High-impact design with strong visual elements",
};

const isManualOverride = (field, value, previousCountry) => {
  if (value === undefined || value === null || value === "") return false;
  const baseDefault = defaultForm[field];
  const previousCountryDefault = getCountryDefaults(previousCountry)[field];
  return value !== baseDefault && value !== previousCountryDefault;
};

const HighlightContext = React.createContext(null);

function Toggle({ id, checked, onChange, label, description, disabled }) {
  const highlightedField = React.useContext(HighlightContext);
  const isHighlighted = highlightedField && highlightedField === id;
  const highlightClass = isHighlighted ? "field-highlight-active" : "";
  return (
    <label htmlFor={id} className={`flex items-center justify-between py-3 px-4 border border-slate-100 rounded-lg hover:bg-slate-50 cursor-pointer group transition-colors ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${highlightClass}`}
      role="switch" aria-checked={checked} aria-label={label} aria-describedby={description ? `${id}-desc` : undefined} tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (!disabled) onChange(); } }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-slate-900">{label}</p>
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${checked ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>
            {checked ? "Enabled" : "Disabled"}
          </span>
        </div>
        {description && <p id={description ? `${id}-desc` : undefined} className="text-xs text-slate-500 mt-0.5">{description}</p>}
      </div>
      <div className="relative inline-flex items-center cursor-pointer shrink-0 ml-3">
        <input id={id} type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="sr-only peer" aria-hidden="true" />
        <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-brand-500" />
      </div>
    </label>
  );
}

function Field({ label, description, children, className = "", error, tooltip, id }) {
  const descId = id ? `${id}-desc` : undefined;
  return (
    <div id={id} className={className} role="group" aria-label={label}>
      <div className="flex items-center gap-1.5 mb-1">
        <label htmlFor={id} className="block text-sm font-medium text-slate-700">{label}</label>
        {tooltip && (
          <span className="group relative inline-flex" role="tooltip">
            <span className="text-slate-400 cursor-help text-xs border border-slate-300 rounded-full w-4 h-4 flex items-center justify-center" aria-hidden="true">?</span>
            <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 text-xs text-white bg-slate-800 rounded opacity-0 group-hover:opacity-100 whitespace-nowrap z-10 pointer-events-none">{tooltip}</span>
          </span>
        )}
      </div>
      {description && <p id={descId} className="text-xs text-slate-500 mb-2">{description}</p>}
      {children}
      {error && <p className="text-xs text-red-500 mt-1" role="alert">{error}</p>}
    </div>
  );
}

function StatusBadge({ fieldId, status, autoHide = true, hideAfterMs = 4000 }) {
  const [visible, setVisible] = React.useState(true);
  const [fading, setFading] = React.useState(false);
  const timerRef = React.useRef(null);
  const fadeTimerRef = React.useRef(null);

  React.useEffect(() => {
    if (!status || !autoHide) { setVisible(true); setFading(false); return; }
    setVisible(true);
    setFading(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    timerRef.current = setTimeout(() => { setFading(true); }, hideAfterMs);
    fadeTimerRef.current = setTimeout(() => { setVisible(false); setFading(false); }, hideAfterMs + 600);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current); };
  }, [status, autoHide, hideAfterMs]);

  if (!status || !visible) return null;

  const fadeStyle = fading ? { opacity: 0, transform: "scale(0.9)", transition: "opacity 0.6s ease-out, transform 0.6s ease-out" } : { opacity: 1, transition: "opacity 0.3s ease-in" };

  if (status === FIELD_STATUS.AUTO_CONFIGURED || status === 'auto') {
    return (
      <span style={fadeStyle} className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-green-50 text-green-700 border border-green-200">
        <CheckCircle size={10} /> Auto-configured
      </span>
    );
  }
  if (status === FIELD_STATUS.SUGGESTED || status === 'suggested') {
    return (
      <span style={fadeStyle} className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-sky-50 text-sky-700 border border-sky-200">
        <Zap size={10} /> Suggested
      </span>
    );
  }
  if (status === FIELD_STATUS.CUSTOMIZED || status === 'custom') {
    return (
      <span style={fadeStyle} className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-blue-50 text-blue-700 border border-blue-200">
        Customized
      </span>
    );
  }
  if (status === FIELD_STATUS.NEEDS_REVIEW || status === 'review') {
    return (
      <span style={fadeStyle} className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-yellow-50 text-yellow-700 border border-yellow-200">
        <AlertCircle size={10} /> Needs review
      </span>
    );
  }
  if (status === FIELD_STATUS.MISSING || status === 'missing') {
    return (
      <span style={fadeStyle} className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-red-50 text-red-700 border border-red-200">
        Missing
      </span>
    );
  }
  if (status === FIELD_STATUS.INVALID || status === 'invalid') {
    return (
      <span style={fadeStyle} className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-rose-50 text-rose-700 border border-rose-200">
        Invalid
      </span>
    );
  }
  return null;
}

function Card({ title, description, children, icon: Icon, color = "brand" }) {
  const colorClasses = {
    brand: "from-brand to-brand-hover", blue: "from-blue-500 to-cyan-500",
    emerald: "from-emerald-500 to-teal-500", amber: "from-amber-500 to-orange-500",
    rose: "from-rose-500 to-pink-500", slate: "from-slate-500 to-slate-500",
    cyan: "from-cyan-500 to-blue-500", indigo: "from-indigo-500 to-brand-hover",
  };
  return (
    <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <div className="flex items-center gap-3 mb-5">
        <div className={`h-10 w-10 rounded-xl bg-gradient-to-r ${colorClasses[color] || colorClasses.brand} text-white flex items-center justify-center shrink-0`}>
          {Icon && <Icon size={20} />}
        </div>
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900 truncate">{title}</h3>
          {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

function Select({ id, value, onChange, options, className = "", ariaLabel, ariaDescribedBy }) {
  const highlightedField = React.useContext(HighlightContext);
  const isHighlighted = highlightedField && highlightedField === id;
  const highlightClass = isHighlighted ? "field-highlight-active animate-pulse" : "";
  return (
    <select id={id} value={value} onChange={onChange} aria-label={ariaLabel} aria-describedby={ariaDescribedBy}
      className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30/20 focus:border-brand-300 bg-white ${highlightClass} ${className}`}>
      {options.map((opt) => {
        const val = typeof opt === "string" ? opt : opt.value;
        const lbl = typeof opt === "string" ? opt : opt.label;
        const desc = typeof opt === "object" ? opt.description : undefined;
        return <option key={val} value={val}>{lbl}{desc ? ` — ${desc}` : ""}</option>;
      })}
    </select>
  );
}

function Input({ id, value, onChange, type = "text", placeholder, min, max, step, className = "", ariaLabel, ariaDescribedBy }) {
  const highlightedField = React.useContext(HighlightContext);
  const isHighlighted = highlightedField && highlightedField === id;
  const highlightClass = isHighlighted ? "field-highlight-active animate-pulse" : "";
  return (
    <input id={id} type={type} value={value} onChange={onChange} placeholder={placeholder}
      min={min} max={max} step={step} aria-label={ariaLabel} aria-describedby={ariaDescribedBy}
      className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30/20 focus:border-brand-300 ${highlightClass} ${className}`} />
  );
}

function Textarea({ id, value, onChange, rows = 3, placeholder, ariaLabel, ariaDescribedBy }) {
  const highlightedField = React.useContext(HighlightContext);
  const isHighlighted = highlightedField && highlightedField === id;
  const highlightClass = isHighlighted ? "field-highlight-active animate-pulse" : "";
  return (
    <textarea id={id} value={value} onChange={onChange} rows={rows} placeholder={placeholder}
      aria-label={ariaLabel} aria-describedby={ariaDescribedBy}
      className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30/20 focus:border-brand-300 ${highlightClass}`} />
  );
}

function SearchableSelect({ id, value, onChange, options, placeholder = "Search...", className = "" }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const highlightedField = React.useContext(HighlightContext);
  const isHighlighted = highlightedField && highlightedField === id;
  const highlightClass = isHighlighted ? "field-highlight-active" : "";

  const filtered = useMemo(() => {
    if (!search) return options;
    const q = search.toLowerCase();
    return options.filter((opt) => {
      const lbl = (opt.label || "").toLowerCase();
      const val = (opt.value || "").toLowerCase();
      const srch = (opt.searchLabel || opt.label || "").toLowerCase();
      return lbl.includes(q) || val.includes(q) || srch.includes(q);
    });
  }, [options, search]);

  const selectedLabel = useMemo(() => {
    const found = options.find((o) => o.value === value);
    return found ? found.label : value;
  }, [options, value]);

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
        setSearch("");
        setActiveIndex(-1);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (open && activeIndex >= 0 && listRef.current) {
      const item = listRef.current.children[activeIndex];
      if (item) item.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open]);

  const handleKeyDown = (e) => {
    if (e.key === "Escape") {
      setOpen(false);
      setSearch("");
      setActiveIndex(-1);
      return;
    }
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        setOpen(true);
        setActiveIndex(0);
        e.preventDefault();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < filtered.length) {
        onChange(filtered[activeIndex].value);
        setOpen(false);
        setSearch("");
        setActiveIndex(-1);
      }
    } else if (e.key === "Tab") {
      setOpen(false);
      setSearch("");
      setActiveIndex(-1);
    }
  };

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button id={id} type="button" onClick={() => { setOpen(!open); setActiveIndex(-1); setTimeout(() => inputRef.current?.focus(), 50); }}
        aria-haspopup="listbox" aria-expanded={open} aria-label={placeholder}
        className={`w-full flex items-center justify-between px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30/20 focus:border-brand-300 ${highlightClass}`}>
        <span className="truncate text-left">{selectedLabel || placeholder}</span>
        {open ? <X size={14} className="shrink-0 ml-1 text-slate-400" onClick={(e) => { e.stopPropagation(); setOpen(false); setSearch(""); setActiveIndex(-1); }} /> : <ChevronDown size={14} className="shrink-0 ml-1 text-slate-400" />}
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-hidden">
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-slate-100">
            <Search size={14} className="text-slate-400 shrink-0" />
            <input ref={inputRef} type="text" value={search} onChange={(e) => { setSearch(e.target.value); setActiveIndex(0); }} onKeyDown={handleKeyDown}
              placeholder={placeholder} autoFocus aria-label="Search options"
              className="w-full text-sm outline-none border-none bg-transparent py-1" />
          </div>
          <div ref={listRef} className="overflow-y-auto max-h-48" role="listbox">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-slate-400 text-center">No results</div>
            ) : (
              filtered.map((opt, idx) => (
                <button key={opt.value} type="button" role="option" aria-selected={value === opt.value}
                  onClick={() => { onChange(opt.value); setOpen(false); setSearch(""); setActiveIndex(-1); }}
                  onMouseEnter={() => setActiveIndex(idx)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-brand-50 transition-colors flex items-center gap-2 ${idx === activeIndex ? "bg-brand-50" : ""} ${value === opt.value ? "text-brand-700 font-medium" : "text-slate-700"}`}>
                  {opt.label}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function BillingSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [validationResult, setValidationResult] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [activeTab, setActiveTab] = useState("general");
  const [fieldStatus, setFieldStatus] = useState({}); // FIELD_STATUS values
  const [suggestedDefaults, setSuggestedDefaults] = useState(null); // {country, suggestions}

  const [form, setForm] = useState({ ...defaultForm });
  const [original, setOriginal] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [showUnsavedWarning, setShowUnsavedWarning] = useState(false);
  const [highlightedField, setHighlightedField] = useState(null);
  const [validationExpanded, setValidationExpanded] = useState(false);

  const savedTimerRef = useRef(null);
  const confirmResetTimerRef = useRef(null);

  const hasChanges = original ? JSON.stringify(form) !== JSON.stringify(original) : false;

  useEffect(() => {}, [form, original, hasChanges]);

  const [lastSavedTimestamp, setLastSavedTimestamp] = useState(null);
  const [exchangeRates, setExchangeRates] = useState(null);
  const [refreshingRates, setRefreshingRates] = useState(false);
  const [exchangeRateError, setExchangeRateError] = useState(null);

  const modifiedFieldsCount = useMemo(() => {
    if (!original) return 0;
    let count = 0;
    Object.keys(defaultForm).forEach((k) => {
      if (JSON.stringify(form[k]) !== JSON.stringify(original[k])) count++;
    });
    return count;
  }, [form, original]);

  // Highlight Field System
  const highlightField = useCallback((fieldId) => {
    if (!fieldId) return;

    const tabMap = {
      company_name: "general", billing_email: "general", support_email: "general",
      website: "general", logo_url: "general", address_line1: "general",
      address_line2: "general", city: "general", state: "general",
      postal_code: "general", country: "general", short_name: "general",
      billing_phone: "general", default_currency: "general", home_currency: "general",
      base_currency: "general", timezone: "general", language: "general",
      date_format: "general", fiscal_year_start: "general", fiscal_year_end: "general",
      currency_precision: "general", currency_symbol_position: "general",
      business_registration_number: "general", gst_number: "general", vat_number: "general",
      pan_number: "general", tin_number: "general",

      invoice_prefix: "invoicing", invoice_number_format: "invoicing", invoice_sequence_reset: "invoicing",
      quote_prefix: "invoicing", quote_number_format: "invoicing", quote_sequence_reset: "invoicing",
      credit_note_prefix: "invoicing", credit_note_number_format: "invoicing", credit_note_sequence_reset: "invoicing",
      refund_prefix: "invoicing", refund_number_format: "invoicing", refund_sequence_reset: "invoicing",
      default_due_days: "invoicing", payment_reminder_days_before: "invoicing",
      late_payment_fee_percentage: "invoicing", late_payment_fee_flat: "invoicing",
      invoice_template: "invoicing", invoice_pdf_template: "invoicing", draft_behaviour: "invoicing",
      invoice_logo_url: "invoicing", invoice_watermark: "invoicing",
      auto_generate_invoice_number: "invoicing", show_tax_breakdown: "invoicing",
      show_discount: "invoicing", show_shipping: "invoicing",
      invoice_footer: "invoicing", invoice_terms: "invoicing", invoice_notes: "invoicing",
      invoice_terms_and_conditions: "invoicing",

      default_payment_terms: "payments", rounding_method: "payments", rounding_precision: "payments",
      exchange_rate_provider: "payments", grace_period_days: "payments", credit_limit: "payments",
      auto_send_receipts: "payments", exchange_rate_auto_update: "payments", auto_capture_enabled: "payments",
      gateway_stripe_enabled: "payments", gateway_razorpay_enabled: "payments",
      gateway_paypal_enabled: "payments", gateway_cash_enabled: "payments",
      gateway_bank_transfer_enabled: "payments", gateway_upi_enabled: "payments",
      gateway_offline_enabled: "payments", webhook_secret: "payments",

      tax_calculation_method: "tax", tax_label: "tax", tax_number: "tax",
      tax_rounding_method: "tax", is_tax_inclusive_default: "tax", show_tax_on_invoice: "tax",
      enable_auto_tax_calculation: "tax", gst_enabled: "tax", sales_tax_enabled: "tax",
      service_tax_enabled: "tax", withholding_tax_enabled: "tax", reverse_charge_enabled: "tax",
      compound_tax_enabled: "tax",

      dunning_level_count: "dunning", dunning_wait_days: "dunning", collections_wait_days: "dunning",
      grace_days: "dunning", auto_dunning: "dunning", enable_escalation_to_collections: "dunning",
      reminder_sms_enabled: "dunning", reminder_whatsapp_enabled: "dunning", auto_suspend_enabled: "dunning",
      penalty_settings: "dunning", interest_settings: "dunning",

      revenue_recognition_method: "revenue", revenue_recognition_deferral_days: "revenue",
      recognized_revenue_method: "revenue", recognition_frequency: "revenue",
      enable_revenue_recognition: "revenue", enable_multi_currency: "revenue",

      notify_invoice_created: "notifications", notify_invoice_sent: "notifications",
      notify_invoice_paid: "notifications", notify_invoice_overdue: "notifications",
      notify_subscription_renewed: "notifications", notify_subscription_cancelled: "notifications",
      notify_payment_failed: "notifications", notify_payment_success: "notifications",
      notify_customer_created: "notifications",

      enable_approval_workflow: "advanced", enable_credit_notes: "advanced", enable_discounts: "advanced",
      enable_retainers: "advanced", enable_schedule_invoicing: "advanced", enable_partial_payments: "advanced",
      enable_auto_apply_credits: "advanced", enable_quotes: "advanced", enable_contracts: "advanced",
      enable_usage_billing: "advanced", enable_refunds: "advanced", enable_auto_taxes: "advanced",
      enable_audit_logs: "advanced", security_settings: "advanced"
    };

    const tab = tabMap[fieldId] || "general";
    setActiveTab(tab);
    
    setTimeout(() => {
      let element = document.getElementById(fieldId);
      if (!element) {
        element = document.querySelector(`[data-field="${fieldId}"]`);
      }
      if (!element) {
        const input = document.getElementById(fieldId);
        if (input) element = input.closest('[role="group"]') || input.parentElement;
      }
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
        const focusable = element.querySelector('input, select, textarea, button, [tabindex]');
        if (focusable) focusable.focus();
        else element.focus();
        setHighlightedField(fieldId);
        setTimeout(() => {
          setHighlightedField((curr) => curr === fieldId ? null : curr);
        }, 5000);
      } else {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    }, 200);
  }, []);

  const handleRecommendationClick = useCallback((rec) => {
    highlightField(rec.field);
  }, [highlightField]);

  const [transientFields, setTransientFields] = useState(new Set());
  const transientTimersRef = useRef({});

  // Browser Exit/Reload Warning
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (hasChanges) {
        const message = "You have unsaved changes.";
        e.returnValue = message;
        return message;
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [hasChanges]);

  useEffect(() => {
    if (hasChanges && !showUnsavedWarning) {
      setShowUnsavedWarning(true);
    }
  }, [form, hasChanges]);

  const flashField = useCallback((field) => {
    setTransientFields((prev) => new Set(prev).add(field));
    if (transientTimersRef.current[field]) clearTimeout(transientTimersRef.current[field]);
    transientTimersRef.current[field] = setTimeout(() => {
      setTransientFields((prev) => {
        const next = new Set(prev);
        next.delete(field);
        return next;
      });
      delete transientTimersRef.current[field];
    }, 5000);
  }, []);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      if (confirmResetTimerRef.current) clearTimeout(confirmResetTimerRef.current);
      Object.values(transientTimersRef.current).forEach((t) => clearTimeout(t));
    };
  }, []);

  const getColor = () => COLORS[activeTab] || "brand";

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [configData, ratesData] = await Promise.allSettled([
        settingsApi.getConfig(),
        settingsApi.getExchangeRates(),
      ]);

      if (configData.status === "rejected") {
        const reason = configData.reason?.message || String(configData.reason || "Unknown error");
        // Config fetch rejected — initialize with defaults
        // Ensure UI remains editable and dirty-tracking works even when the
        // backend fails to respond. Initialize form + original from defaults
        // so user can still make changes locally and Save/Reset become active
        // once edits occur.
        const merged = { ...defaultForm };
        // Initialized with defaults due to config fetch failure
        setForm(merged);
        setOriginal(JSON.parse(JSON.stringify(merged)));
        setError(`Failed to load billing configuration: ${reason}`);
        setLoading(false);
        return;
      }

      if (!configData.value || (typeof configData.value === "object" && Object.keys(configData.value).length === 0)) {
        // getConfig returned empty data, using defaults
      }

      const data = configData.value || {};
      const merged = { ...defaultForm };
      Object.keys(defaultForm).forEach((key) => {
        if (data[key] !== undefined && data[key] !== null) {
          merged[key] = data[key];
        }
      });
      // Config merged with defaults
      setForm(merged);
      const deep = JSON.parse(JSON.stringify(merged));
      setOriginal(deep);

      const initialStatus = {};
      const country = merged.country;
      const defaults = getCountryDefaults(country);
      Object.keys(defaults).forEach((k) => {
        if (merged[k] !== undefined && merged[k] !== null && merged[k] === defaults[k]) initialStatus[k] = FIELD_STATUS.AUTO_CONFIGURED;
      });
      setFieldStatus(initialStatus);

      if (ratesData.status === "fulfilled" && ratesData.value) {
        setExchangeRates(ratesData.value);
      }
    } catch (err) {
      // Failed to load billing configuration
      setError("Failed to load billing configuration. The backend may not be available.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleRefreshExchangeRates = async () => {
    setRefreshingRates(true);
    setExchangeRateError(null);
    try {
      const result = await settingsApi.refreshExchangeRates();
      if (result) {
        setExchangeRates(result);
      } else {
        const rates = await settingsApi.getExchangeRates();
        if (rates) setExchangeRates(rates);
      }
    } catch (err) {
      const apiError = err?.response?.data || err?.data || {};
      const message = apiError.message || apiError.detail || err.message || "Failed to refresh exchange rates. Please try again.";
      setExchangeRateError(message);
    } finally {
      setRefreshingRates(false);
    }
  };

  const update = (field, value) => {
    if (field === 'website') {
      let domain = "";
      try {
        const u = value.startsWith('http') ? new URL(value) : new URL('https://' + value);
        domain = u.hostname.replace(/^www\./, '');
      } catch (e) {
        domain = value.replace(/^www\./, '');
      }
      setForm((prev) => {
        const next = { ...prev, website: value };
        if (!fieldStatus.billing_email || fieldStatus.billing_email !== FIELD_STATUS.CUSTOMIZED) {
          next.billing_email = `billing@${domain}`;
        }
        if (!fieldStatus.support_email || fieldStatus.support_email !== FIELD_STATUS.CUSTOMIZED) {
          next.support_email = `support@${domain}`;
        }
        if (!fieldStatus.short_name || fieldStatus.short_name !== FIELD_STATUS.CUSTOMIZED) {
          const short = domain.split('.')[0];
          next.short_name = (short || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
        }
        return next;
      });
      
      setFieldStatus((prev) => {
        const nextStatus = { ...prev };
        nextStatus.website = FIELD_STATUS.CUSTOMIZED;
        if (prev.billing_email !== FIELD_STATUS.CUSTOMIZED) nextStatus.billing_email = FIELD_STATUS.AUTO_CONFIGURED;
        if (prev.support_email !== FIELD_STATUS.CUSTOMIZED) nextStatus.support_email = FIELD_STATUS.AUTO_CONFIGURED;
        if (prev.short_name !== FIELD_STATUS.CUSTOMIZED) nextStatus.short_name = FIELD_STATUS.AUTO_CONFIGURED;
        return nextStatus;
      });
      
      setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
      return;
    }
    setForm((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    
    if (fieldStatus[field] !== FIELD_STATUS.CUSTOMIZED) {
      setFieldStatus((prev) => ({ ...prev, [field]: FIELD_STATUS.CUSTOMIZED }));
    }
  };

  const applyCountryDefaults = (country, previousCountry, currentForm) => {
    const defaults = getCountryDefaults(country);
    if (!defaults || Object.keys(defaults).length === 0) return currentForm;

    const updatedForm = { ...currentForm };
    Object.entries(defaults).forEach(([field, defaultValue]) => {
      if (!isManualOverride(field, currentForm[field], previousCountry)) {
        updatedForm[field] = defaultValue;
      }
    });
    return updatedForm;
  };

  const handleCountryChange = (country) => {
    const defaults = getCountryDefaults(country);
    const suggestions = {};
    Object.entries(defaults).forEach(([field, val]) => {
      if (form[field] === undefined || form[field] === null || form[field] !== val) {
        suggestions[field] = val;
      }
    });
    if (Object.keys(suggestions).length === 0) {
      setForm((prev) => ({ ...prev, country }));
      setFieldErrors((prev) => ({ ...prev, country: undefined }));
      setSuggestedDefaults(null);
      return;
    }
    setSuggestedDefaults({ country, suggestions, previousCountry: form.country });
    setFieldStatus((prev) => {
      const next = { ...prev };
      Object.keys(suggestions).forEach((k) => { next[k] = FIELD_STATUS.NEEDS_REVIEW; });
      return next;
    });
    setForm((prev) => ({ ...prev, country }));
    setFieldErrors((prev) => ({ ...prev, country: undefined }));
  };

  const applySuggestedDefaults = () => {
    if (!suggestedDefaults) return;
    const { suggestions } = suggestedDefaults;
    const flashed = [];
    
    setForm((prev) => {
      const next = { ...prev };
      Object.entries(suggestions).forEach(([field, val]) => {
        if (!fieldStatus[field] || fieldStatus[field] === 'auto' || fieldStatus[field] === 'review') {
          next[field] = val;
          flashed.push(field);
        }
      });
      return next;
    });

    setFieldStatus((prev) => {
      const nextStatus = { ...prev };
      flashed.forEach((field) => {
        nextStatus[field] = FIELD_STATUS.AUTO_CONFIGURED;
      });
      return nextStatus;
    });

    setSuggestedDefaults(null);
    setTimeout(() => flashed.forEach((f) => flashField(f)), 50);
  };

  const keepCurrentSettings = () => {
    setSuggestedDefaults(null);
  };

  const resetToCountryDefaults = () => {
    const country = form.country;
    if (!country) return;
    const defaults = getCountryDefaults(country);
    if (!defaults) return;
    const intelligentFields = Object.keys(defaults);
    setForm((prev) => {
      const next = { ...prev };
      intelligentFields.forEach((f) => { next[f] = defaults[f]; });
      return next;
    });
    setFieldStatus((prev) => {
      const next = { ...prev };
      intelligentFields.forEach((f) => { next[f] = FIELD_STATUS.AUTO_CONFIGURED; });
      return next;
    });
    setTimeout(() => intelligentFields.forEach((f) => flashField(f)), 50);
  };

  const updateToggle = (field) => {
    setForm((prev) => ({ ...prev, [field]: !prev[field] }));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    setFieldErrors({});
    try {
      // Sanitize payload: backend validates certain fields as strings.
      // Strip out null/undefined values for optional fields so the backend
      // treats them as absent rather than invalid.
      const nullableStringFields = [
        "default_tax_rate_id", "default_tax_rate",
        "webhook_secret", "dunning_email_template", "final_notice_template",
        "invoice_footer", "invoice_terms", "invoice_notes", "invoice_logo_url",
        "invoice_watermark", "invoice_terms_and_conditions",
        "tax_number", "logo_url", "support_email", "billing_phone", "website",
        "company_name", "short_name", "address_line1", "address_line2",
        "city", "state", "postal_code", "country",
        "business_registration_number", "gst_number", "vat_number", "pan_number", "tin_number",
        "default_category_id", "default_tax_rate", "auto_archive_days",
      ];
      const data = { ...form };
      nullableStringFields.forEach((field) => {
        if (data[field] === null || data[field] === undefined) {
          delete data[field];
        }
      });
      if (data.default_tax_rate !== undefined && data.default_tax_rate !== null) {
        data.default_tax_rate = String(data.default_tax_rate);
      }
      await settingsApi.updateConfig(data);
      setSaved(true);
      setLastSavedTimestamp(new Date());
      setOriginal(JSON.parse(JSON.stringify(form)));
      setShowUnsavedWarning(false);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => { setSaved(false); savedTimerRef.current = null; }, 3000);
      return true;
    } catch (err) {
      const msg = err.message || "Failed to save configuration. Please try again.";
      setError(msg);
      if (msg.includes(":")) {
        const parts = msg.split(",");
        const errs = {};
        parts.forEach((p) => {
          const [key, val] = p.split(":");
          if (key && val) errs[key.trim()] = val.trim();
        });
        if (Object.keys(errs).length > 0) setFieldErrors(errs);
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const parseApiErrorField = (errStr) => {
    if (typeof errStr !== "string") return null;
    const parts = errStr.split(":");
    if (parts.length > 1) {
      const field = parts[0].trim();
      const knownFields = [
        "company_name", "billing_email", "support_email", "billing_phone", "website", 
        "logo_url", "country", "address_line1", "city", "state", "postal_code", 
        "gst_number", "pan_number", "vat_number", "business_registration_number", "tin_number", 
        "invoice_prefix", "quote_prefix", "credit_note_prefix", "refund_prefix", 
        "default_currency", "home_currency", "base_currency", "timezone", "language", 
        "date_format", "fiscal_year_start", "fiscal_year_end", "default_due_days", 
        "payment_reminder_days_before", "late_payment_fee_percentage", "late_payment_fee_flat", 
        "default_payment_terms", "gst_enabled", "sales_tax_enabled"
      ];
      if (knownFields.includes(field)) return field;
    }
    return null;
  };

  const handleValidate = async () => {
    setValidating(true);
    setValidationResult(null);
    setValidationExpanded(false);
    setFieldErrors({});
    try {
      let apiResult = null;
      let apiError = null;
      try {
        apiResult = await settingsApi.validateConfig();
      } catch (e) {
        apiError = e?.message || "Backend validation service is temporarily unavailable.";
      }

      const extraWarnings = [];
      const extraErrors = [];

      if (form.invoice_prefix && form.quote_prefix && form.invoice_prefix === form.quote_prefix) {
        extraWarnings.push({ field: "invoice_prefix", label: "Duplicate Prefix", message: "Invoice and quote prefixes are identical — this may cause numbering conflicts" });
      }
      if (form.credit_note_prefix && form.invoice_prefix && form.credit_note_prefix === form.invoice_prefix) {
        extraWarnings.push({ field: "credit_note_prefix", label: "Duplicate Prefix", message: "Credit note prefix matches invoice prefix" });
      }
      if (form.refund_prefix && form.invoice_prefix && form.refund_prefix === form.invoice_prefix) {
        extraWarnings.push({ field: "refund_prefix", label: "Duplicate Prefix", message: "Refund prefix matches invoice prefix" });
      }
      if (form.payment_reminder_days_before > form.default_due_days) {
        extraErrors.push({ field: "payment_reminder_days_before", label: "Reminder Days", message: "Reminder days cannot exceed default due days" });
      }
      if (form.late_payment_fee_percentage > 100) {
        extraErrors.push({ field: "late_payment_fee_percentage", label: "Late Fee", message: "Late fee percentage cannot exceed 100%" });
      }
      if (form.late_payment_fee_percentage < 0) {
        extraErrors.push({ field: "late_payment_fee_percentage", label: "Late Fee", message: "Late fee percentage cannot be negative" });
      }
      if (form.logo_url && !/^https?:\/\/.+/.test(form.logo_url)) {
        extraWarnings.push({ field: "logo_url", label: "Logo URL", message: "Logo URL should start with http:// or https://" });
      }

      let backendPassed = [];
      let backendWarnings = [];
      let backendErrors = [];
      let readinessScore = 0;
      let fieldCount = 0;
      let sectionScores = {};

      if (apiResult && !apiError) {
        readinessScore = apiResult.readiness_score || 0;
        fieldCount = apiResult.field_count || 0;
        sectionScores = apiResult.section_scores || {};
        backendPassed = (apiResult.passed || []).map((p) => ({
          field: p.field, label: p.field, message: p.message, severity: p.severity || "passed",
        }));
        backendWarnings = (apiResult.warnings || []).map((w) => ({
          field: w.field, label: w.field, message: w.message, severity: w.severity || "warning", code: w.code,
        }));
        backendErrors = (apiResult.errors || []).map((e) => ({
          field: e.field, label: e.field, message: e.message, severity: e.severity || "error", code: e.code,
        }));
      }

      const allWarnings = [...backendWarnings, ...extraWarnings];
      const allErrors = [...backendErrors, ...extraErrors];
      const allPassed = [...backendPassed];

      const mergedFieldErrors = {};
      allErrors.forEach((e) => { if (e.field) mergedFieldErrors[e.field] = e.message; });

      const result = {
        valid: allErrors.length === 0,
        score: readinessScore,
        passed: allPassed.length,
        warnings: allWarnings.length,
        errors: allErrors.length,
        sectionScores,
        checkDetails: {
          passed: allPassed,
          warnings: allWarnings,
          errors: allErrors,
        },
        fieldErrors: mergedFieldErrors,
        field_count: fieldCount,
        apiErrors: apiError ? [{ message: apiError }] : [],
      };
      setValidationResult(result);
      setFieldErrors(mergedFieldErrors);
      setValidationExpanded(false);
      const firstError = mergedFieldErrors ? Object.keys(mergedFieldErrors)[0] : null;
      if (firstError) {
        setTimeout(() => highlightField(firstError), 200);
      }
    } catch (err) {
      setValidationResult({
        valid: false, errors: 1, score: 0, passed: 0, warnings: 1,
        checkDetails: {
          passed: [],
          warnings: [{ field: "validation", label: "Validation Error", message: "An unexpected error occurred during validation." }],
          errors: [{ message: "Failed to validate configuration" }],
        },
        fieldErrors: {}, apiErrors: [],
      });
    } finally {
      setValidating(false);
    }
  };

  const handleReset = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      if (confirmResetTimerRef.current) clearTimeout(confirmResetTimerRef.current);
      confirmResetTimerRef.current = setTimeout(() => { setConfirmReset(false); confirmResetTimerRef.current = null; }, 4000);
      return;
    }
    if (original) {
      setForm(JSON.parse(JSON.stringify(original)));
    }
    setValidationResult(null);
    setFieldErrors({});
    setFieldStatus({});
    setSuggestedDefaults(null);
    setShowUnsavedWarning(false);
    setSaved(false);
    setConfirmReset(false);
    setError(null);
    if (confirmResetTimerRef.current) {
      clearTimeout(confirmResetTimerRef.current);
      confirmResetTimerRef.current = null;
    }
    setSaved(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => { setSaved(false); savedTimerRef.current = null; }, 3000);
  };

  if (loading) {
    return (
      <div className="space-y-8" aria-label="Loading billing configuration">
        <div className="rounded-3xl bg-white border border-slate-200 p-6 md:p-8 shadow-[0_4px_20px_rgba(0,0,0,0.03)] animate-pulse">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-slate-200 shrink-0" />
            <div className="space-y-2">
              <div className="h-6 bg-slate-200 rounded w-56" />
              <div className="h-3.5 bg-slate-100 rounded w-72" />
            </div>
          </div>
        </div>
        <div className="animate-pulse space-y-4" aria-hidden="true">
          {[1,2,3].map((i) => (
            <div key={i} className="bg-white rounded-3xl border border-slate-200 p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
              <div className="flex items-center gap-3 mb-5">
                <div className="h-10 w-10 rounded-xl bg-slate-200 shrink-0" />
                <div className="space-y-2">
                  <div className="h-4 w-32 bg-slate-200 rounded" />
                  <div className="h-3 w-48 bg-slate-100 rounded" />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {[1,2,3,4,5,6].map((j) => (
                  <div key={j}>
                    <div className="h-3 w-20 bg-slate-100 rounded mb-2" />
                    <div className="h-9 bg-slate-100 rounded-lg" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <HighlightContext.Provider value={highlightedField}>
    <div className="space-y-8">
      <style>{`
        @keyframes fieldHighlightPulse {
          0% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.5); border-color: #eab308; }
          50% { box-shadow: 0 0 12px 4px rgba(234, 179, 8, 0.3); border-color: #facc15; }
          100% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0); border-color: #eab308; }
        }
        .field-highlight-active {
          border-color: #eab308 !important;
          box-shadow: 0 0 8px 2px rgba(234, 179, 8, 0.35);
          animation: fieldHighlightPulse 1s ease-in-out 3;
          transition: box-shadow 0.3s, border-color 0.3s;
        }
      `}</style>
      <div className="rounded-3xl bg-white border border-slate-200 p-6 md:p-8 shadow-[0_4px_20px_rgba(0,0,0,0.03)]">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-gradient-to-r from-[#FF7A00] to-[#FF5500] text-white flex items-center justify-center shadow-sm shrink-0">
              <Settings2 size={22} />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight dark:text-white">Billing Configuration</h1>
              <p className="text-slate-500 text-sm mt-0.5 dark:text-slate-400">Enterprise billing module settings</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {saved && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-green-50 border border-green-200 rounded-xl text-green-700 text-sm font-medium animate-in fade-in">
                <CheckCircle size={16} />
                <span>Saved Successfully</span>
                {formatLastUpdated(lastSavedTimestamp) && (
                  <span className="text-green-500 font-normal text-xs">
                    at {formatLastUpdated(lastSavedTimestamp)}
                  </span>
                )}
              </div>
            )}
            {showUnsavedWarning && hasChanges && (
              <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-xl text-amber-700 text-sm font-medium">
                <AlertCircle size={16} />
                <span>{modifiedFieldsCount} field{modifiedFieldsCount !== 1 ? 's' : ''} modified</span>
                <button onClick={() => { setForm(JSON.parse(JSON.stringify(original))); setFieldStatus({}); setShowUnsavedWarning(false); }} className="ml-2 text-amber-600 underline text-xs hover:text-amber-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 rounded">Undo all</button>
              </div>
            )}
            <button onClick={handleValidate} disabled={validating}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-medium transition-colors disabled:opacity-50 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A00]/50">
              <Settings2 size={14} />
              Validate
            </button>
            <button onClick={handleReset} disabled={!hasChanges}
              className={`flex items-center gap-2 px-3.5 py-2 rounded-xl border text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A00]/50 ${
                confirmReset
                  ? "border-red-300 bg-red-50 text-red-700"
                  : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
              }`}>
              <RotateCcw size={14} />
              {confirmReset ? "Confirm Reset" : "Reset"}
            </button>
            <button onClick={handleSave} disabled={saving || !hasChanges}
              className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-[#FF7A00] to-[#FF5500] text-white rounded-xl text-sm font-medium hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A00]/50 focus-visible:ring-offset-1">
              {saving ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-2xl text-red-700 text-sm" role="alert">
          <AlertCircle size={18} className="shrink-0" />
          {error}
        </div>
      )}

      {validationResult && (
        <div className="space-y-3">
          <div className={`p-4 border rounded-2xl text-sm ${validationResult.valid ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 font-medium">
                {validationResult.valid ? <CheckCircle size={16} className="text-green-600" /> : <AlertCircle size={16} className="text-amber-600" />}
                <span className={validationResult.valid ? "text-green-700" : "text-amber-700"}>
                  {validationResult.valid ? "Configuration is valid" : "Configuration needs attention"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {validationResult.score !== undefined && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">Score:</span>
                    <span className={`text-sm font-bold ${validationResult.score >= 80 ? "text-green-600" : validationResult.score >= 50 ? "text-amber-600" : "text-red-600"}`}>
                      {validationResult.score}%
                    </span>
                  </div>
                )}
                {!validationResult.valid && (
                  <button onClick={() => setValidationExpanded(!validationExpanded)}
                    className="text-xs text-slate-500 hover:text-slate-700 underline transition-colors">
                    {validationExpanded ? "Hide Details" : "View Details"}
                  </button>
                )}
              </div>
            </div>
            <div className="flex gap-4 text-xs mt-2">
              <span className="text-green-600">{validationResult.passed || 0} passed</span>
              {(validationResult.warnings || 0) > 0 && <span className="text-amber-600">{validationResult.warnings} warnings</span>}
              {(validationResult.errors || 0) > 0 && <span className="text-red-600">{validationResult.errors} errors</span>}
              {validationResult.field_count && <span className="text-slate-500">{validationResult.field_count} fields configured</span>}
            </div>
            {validationExpanded && (
              <>
                {(validationResult.checkDetails?.warnings || []).length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-amber-700 mb-1">Warnings:</p>
                    <ul className="list-none text-xs text-amber-600 space-y-1">
                      {validationResult.checkDetails.warnings.map((w, i) => (
                        <li key={i}
                          onClick={() => w.field && w.field !== 'backend' && w.field !== 'validation' && highlightField(w.field)}
                          className={`flex items-start gap-1.5 px-2 py-1 rounded ${w.field && w.field !== 'backend' && w.field !== 'validation' ? 'cursor-pointer hover:bg-amber-100 transition-colors' : ''}`}
                          title={w.field && w.field !== 'backend' && w.field !== 'validation' ? `Click to navigate to ${w.label || w.field}` : undefined}
                        >
                          <span className="mt-0.5 shrink-0">⚠</span>
                          <span>{w.message || (typeof w === "string" ? w : `${w.label || w.field}: ${w.message}`)}</span>
                          {w.field && w.field !== 'backend' && w.field !== 'validation' && <ArrowRight size={10} className="mt-0.5 shrink-0 text-amber-400" />}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {(validationResult.checkDetails?.errors || []).length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-red-700 mb-1">Errors:</p>
                    <ul className="list-none text-xs text-red-600 space-y-1">
                      {validationResult.checkDetails.errors.map((e, i) => (
                        <li key={i}
                          onClick={() => e.field && highlightField(e.field)}
                          className={`flex items-start gap-1.5 px-2 py-1 rounded ${e.field ? 'cursor-pointer hover:bg-red-100 transition-colors' : ''}`}
                          title={e.field ? `Click to navigate to ${e.label || e.field}` : undefined}
                        >
                          <span className="mt-0.5 shrink-0">✕</span>
                          <span>{e.message || (typeof e === "string" ? e : `${e.label || e.field}: ${e.message}`)}</span>
                          {e.field && <ArrowRight size={10} className="mt-0.5 shrink-0 text-red-400" />}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {(validationResult.checkDetails?.passed || []).length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-green-700 mb-1">Passed Checks:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {validationResult.checkDetails.passed.map((p, i) => (
                        <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-green-100 text-green-700">
                          <CheckCircle size={10} /> {p.label || p.field || p}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {validationResult.apiErrors?.length > 0 && (
                  <div className="mt-3">
                    <p className="text-xs font-medium text-slate-700 mb-1">Backend validation:</p>
                    <ul className="list-none text-xs text-slate-600 space-y-1">
                      {validationResult.apiErrors.map((e, i) => {
                        const fieldId = parseApiErrorField(e);
                        return (
                          <li key={i}
                            onClick={() => fieldId && highlightField(fieldId)}
                            className={`flex items-start gap-1.5 px-2 py-1 rounded ${fieldId ? 'cursor-pointer hover:bg-slate-100 transition-colors' : ''}`}
                            title={fieldId ? `Click to navigate to ${fieldId}` : undefined}
                          >
                            <span className="mt-0.5 shrink-0">•</span>
                            <span>{e}</span>
                            {fieldId && <ArrowRight size={10} className="mt-0.5 shrink-0 text-slate-400" />}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-1.5" role="tablist" aria-label="Billing settings tabs">
        <div className="flex gap-1 overflow-x-auto" role="tablist">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)} role="tab" aria-selected={isActive} aria-controls={`panel-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
                onKeyDown={(e) => { if (e.key === "ArrowRight") { const idx = TABS.findIndex(t => t.id === tab.id); const next = TABS[(idx + 1) % TABS.length]; setActiveTab(next.id); } if (e.key === "ArrowLeft") { const idx = TABS.findIndex(t => t.id === tab.id); const prev = TABS[(idx - 1 + TABS.length) % TABS.length]; setActiveTab(prev.id); } }}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-xl transition-all whitespace-nowrap ${
                  isActive
                    ? `${TAB_ACTIVE_CLASSES[tab.id]} bg-slate-50 shadow-sm`
                    : "border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50/50"
                }`}>
                <tab.icon className="w-4 h-4" aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === "general" && (
        <div className="space-y-6" role="tabpanel" aria-labelledby="tab-general" id="panel-general">
          <Card title="Organization Information" icon={Building2} color="brand">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <Field label="Company Name" tooltip="Legal name of your business">
                <Input value={form.company_name} onChange={(e) => update("company_name", e.target.value)} />
              </Field>
              <Field label="Billing Email" tooltip="Email address for billing correspondence" error={fieldErrors.billing_email}>
                <Input type="email" value={form.billing_email} onChange={(e) => update("billing_email", e.target.value)} />
              </Field>
              <Field label="Support Email" tooltip="Support contact email">
                <Input type="email" value={form.support_email} onChange={(e) => update("support_email", e.target.value)} />
              </Field>
              <Field label="Short Name" tooltip="Short display name used in compact UI elements">
                <Input value={form.short_name} onChange={(e) => update("short_name", e.target.value)} />
              </Field>
              <Field label="Billing Phone" tooltip="Contact phone number for billing" error={fieldErrors.billing_phone}>
                <Input value={form.billing_phone} onChange={(e) => update("billing_phone", e.target.value)} />
              </Field>
              <Field label="Website" tooltip="Your business website URL" error={fieldErrors.website}>
                <Input type="url" value={form.website} onChange={(e) => update("website", e.target.value)} />
              </Field>
              <Field label="Logo URL" tooltip="URL to your company logo image">
                <Input type="url" value={form.logo_url} onChange={(e) => update("logo_url", e.target.value)} />
              </Field>
              <Field label="Business Registration Number" tooltip="Official business registration or company number">
                {(() => {
                  const cfg = registrationFieldConfig(form.country);
                  return (
                    <>
                      {cfg.business_registration_number.show && (
                        <Field label={cfg.business_registration_number.label} tooltip="Official business registration or company number">
                          <Input value={form.business_registration_number} onChange={(e) => update("business_registration_number", e.target.value)} />
                        </Field>
                      )}
                      {cfg.gst_number.show && (
                        <Field label={cfg.gst_number.label} tooltip="Goods and Services Tax registration number" error={fieldErrors.gst_number}>
                          <Input value={form.gst_number} onChange={(e) => update("gst_number", e.target.value)} />
                        </Field>
                      )}
                      {cfg.vat_number.show && (
                        <Field label={cfg.vat_number.label} tooltip="Value Added Tax registration number" error={fieldErrors.vat_number}>
                          <Input value={form.vat_number} onChange={(e) => update("vat_number", e.target.value)} />
                        </Field>
                      )}
                      {cfg.pan_number.show && (
                        <Field label={cfg.pan_number.label} tooltip="Permanent Account Number (tax identifier)">
                          <Input value={form.pan_number} onChange={(e) => update("pan_number", e.target.value)} />
                        </Field>
                      )}
                      {cfg.tin_number.show && (
                        <Field label={cfg.tin_number.label} tooltip="Tax Identification Number">
                          <Input value={form.tin_number} onChange={(e) => update("tin_number", e.target.value)} />
                        </Field>
                      )}
                    </>
                  );
                })()}
              </Field>
            </div>
          </Card>

          <Card title="Address" icon={MapPin} color="brand">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <Field label="Address Line 1">
                <Input value={form.address_line1} onChange={(e) => update("address_line1", e.target.value)} />
              </Field>
              <Field label="Address Line 2">
                <Input value={form.address_line2} onChange={(e) => update("address_line2", e.target.value)} />
              </Field>
              <Field label="City">
                <Input value={form.city} onChange={(e) => update("city", e.target.value)} />
              </Field>
              <Field label="State / Province">
                <Input value={form.state} onChange={(e) => update("state", e.target.value)} />
              </Field>
              <Field label="Postal Code">
                <Input value={form.postal_code} onChange={(e) => update("postal_code", e.target.value)} />
              </Field>
              <Field label="Country">
                <Select value={form.country} onChange={(e) => handleCountryChange(e.target.value)}
                  options={["", "United States","United Kingdom","Canada","Australia","India","UAE","Saudi Arabia","Qatar","Kuwait","Japan","China","Singapore","Malaysia","Thailand","South Africa","Nigeria","Pakistan","Bangladesh","Sri Lanka","Nepal","Bahrain","Oman","Germany","France","Italy","Spain","Netherlands","Brazil","Mexico","Sweden","Norway","Denmark","Switzerland","New Zealand","Hong Kong","South Korea"]} />
                    {form.country && !SUPPORTED_PHASE1.includes(form.country) && (
                      <p className="mt-2 text-sm text-sky-700 bg-sky-50 border border-sky-100 rounded px-3 py-2 flex items-start gap-2">
                        <Info size={14} className="shrink-0 text-sky-700 mt-0.5" />
                        <span>
                          Smart Organization Intelligence is currently available for: India, United States, United Kingdom, UAE and Singapore. Please configure regional settings manually for this country. Support for additional countries will be added in future releases.
                        </span>
                      </p>
                    )}
                    {/* Suggestion banner when country changed */}
                    {suggestedDefaults && suggestedDefaults.country === form.country && (
                      <div className="mt-3 p-4 border rounded-lg bg-gradient-to-r from-amber-50 to-yellow-50 border-amber-200 text-sm">
                        <div className="flex items-start gap-3">
                          <div className="flex-1">
                            <div className="font-semibold text-slate-800 flex items-center gap-2">
                              <span className="text-lg">&#129504;</span> Smart Organization Intelligence
                            </div>
                            <div className="text-slate-600 mt-1">Recommended defaults for <span className="font-medium">{suggestedDefaults.country}</span> are ready to apply.</div>
                            
                            <div className="mt-3 space-y-1 max-h-48 overflow-y-auto">
                              {Object.entries(suggestedDefaults.suggestions).map(([field, newVal]) => {
                                const currentVal = form[field];
                                const isChanged = currentVal !== newVal && currentVal !== undefined && currentVal !== null && currentVal !== "";
                                return (
                                  <div key={field} className={`flex items-center justify-between px-2 py-1 rounded text-xs ${isChanged ? "bg-amber-100/60" : "bg-white/40"}`}>
                                    <span className="text-slate-600 font-medium capitalize">{field.replace(/_/g, " ")}</span>
                                    <div className="flex items-center gap-1.5">
                                      {isChanged && <span className="text-slate-400 line-through">{String(currentVal).slice(0, 15)}</span>}
                                      {isChanged && <span className="text-amber-500">&rarr;</span>}
                                      <span className="text-slate-800 font-medium">{String(newVal).slice(0, 20)}</span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                            
                            <div className="mt-3 flex gap-2 flex-wrap">
                              <button onClick={applySuggestedDefaults} className="px-3 py-1.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors">
                                Apply All Suggestions
                              </button>
                              <button onClick={keepCurrentSettings} className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors">
                                Keep Current Settings
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
              </Field>
            </div>
          </Card>

          <Card title="Regional Settings" icon={Globe} color="brand">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <Field label="Default Currency" tooltip="Primary currency for billing">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <SearchableSelect value={form.default_currency}
                      onChange={(v) => update("default_currency", v)}
                      options={CURRENCY_OPTIONS_WITH_INFO}
                      placeholder="Search currency..." />
                  </div>
                  <div className="shrink-0">
                    {fieldStatus.default_currency === 'auto' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-green-50 text-green-700">🟢 Auto-configured</span>
                    ) : fieldStatus.default_currency === 'custom' ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs bg-blue-50 text-blue-700">🔵 Customized</span>
                    ) : null}
                  </div>
                </div>
              </Field>
              <Field label="Home Currency" tooltip="Your reporting/home currency">
                <SearchableSelect value={form.home_currency}
                  onChange={(v) => update("home_currency", v)}
                  options={CURRENCY_OPTIONS_WITH_INFO}
                  placeholder="Search currency..." />
              </Field>
              <Field label="Base Currency" tooltip="Base currency for exchange rate calculations">
                <SearchableSelect value={form.base_currency}
                  onChange={(v) => update("base_currency", v)}
                  options={CURRENCY_OPTIONS_WITH_INFO}
                  placeholder="Search currency..." />
              </Field>
              <Field label="Currency Precision" tooltip="Number of decimal places for currency">
                <Input type="number" value={form.currency_precision} min={0} max={10}
                  onChange={(e) => update("currency_precision", parseInt(e.target.value) || 2)} />
              </Field>
              <Field label="Currency Symbol Position" tooltip="Where to place the currency symbol">
                <Select value={form.currency_symbol_position} onChange={(e) => update("currency_symbol_position", e.target.value)}
                  options={[
                    {value:"before", label:`Before amount (${formatCurrency(100, form.default_currency, "before")})`},
                    {value:"after", label:`After amount (${formatCurrency(100, form.default_currency, "after")})`},
                  ]} />
              </Field>
              <Field label="Date Format">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Select value={form.date_format} onChange={(e) => update("date_format", e.target.value)}
                      options={["DD-MM-YYYY","MM-DD-YYYY","YYYY-MM-DD","DD-MM-YY","MM-DD-YY"]} />
                  </div>
                  <div className="shrink-0">
                    <StatusBadge status={fieldStatus.date_format} />
                  </div>
                </div>
              </Field>
              <Field label="Fiscal Year Start" tooltip="Month and day when fiscal year starts (MM-DD)" error={fieldErrors.fiscal_year_start}>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Input value={form.fiscal_year_start} onChange={(e) => update("fiscal_year_start", e.target.value)} placeholder="MM-DD" />
                  </div>
                  <div className="shrink-0"><StatusBadge status={fieldStatus.fiscal_year_start} /></div>
                </div>
              </Field>
              <Field label="Fiscal Year End" tooltip="Month and day when fiscal year ends (MM-DD)" error={fieldErrors.fiscal_year_end}>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Input value={form.fiscal_year_end} onChange={(e) => update("fiscal_year_end", e.target.value)} placeholder="MM-DD" />
                  </div>
                  <div className="shrink-0"><StatusBadge status={fieldStatus.fiscal_year_end} /></div>
                </div>
              </Field>
              <Field label="Timezone">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Select value={form.timezone} onChange={(e) => update("timezone", e.target.value)}
                      options={["UTC","America/New_York","America/Chicago","America/Denver","America/Los_Angeles","Europe/London","Europe/Berlin","Europe/Paris","Asia/Tokyo","Asia/Shanghai","Asia/Dubai","Asia/Kolkata","Australia/Sydney","Africa/Johannesburg"]} />
                  </div>
                  <div className="shrink-0"><StatusBadge status={fieldStatus.timezone} /></div>
                </div>
              </Field>
              <Field label="Language">
                <Select value={form.language} onChange={(e) => update("language", e.target.value)}
                  options={getLanguageSelectOptions()} />
              </Field>
            </div>
            <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-5 bg-brand-50/40 border border-brand-100 rounded-xl">
                <p className="text-xs font-semibold text-brand-600 uppercase tracking-wider mb-3">Currency Preview</p>
                <div className="flex items-center gap-3 mb-3">
                  <span className="text-3xl">{CURRENCY_MASTER[form.default_currency]?.flag}</span>
                  <div>
                    <p className="text-base font-bold text-brand-800">
                      {CURRENCY_MASTER[form.default_currency]?.name || form.default_currency}
                    </p>
                    <p className="text-xs text-brand-500">
                      {form.default_currency} &middot; {getCurrencySymbol(form.default_currency)}
                    </p>
                  </div>
                </div>
                <div className="flex items-baseline gap-2 mt-2">
                  <span className="text-2xl font-bold text-brand-800">
                    {formatCurrency(123456.78, form.default_currency, form.currency_symbol_position)}
                  </span>
                  <span className="text-xs text-brand-300">
                    {form.currency_symbol_position === "after" ? "Symbol after amount" : "Symbol before amount"}
                  </span>
                </div>
                <div className="mt-2 flex gap-2">
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-white/60 rounded text-xs text-brand-600">
                    Before: {formatCurrency(100, form.default_currency, "before")}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-white/60 rounded text-xs text-brand-600">
                    After: {formatCurrency(100, form.default_currency, "after")}
                  </span>
                </div>
              </div>

              <div className="p-5 bg-gradient-to-r from-slate-50 to-slate-50 border border-slate-200 rounded-xl">
                <div className="flex items-center gap-2 mb-3">
                  <Info size={14} className="text-slate-500" />
                  <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Regional Information</p>
                </div>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Language</span>
                    <span className="font-medium text-slate-800">{getLanguageSelectOptions().find(o => o.value === form.language)?.label || form.language}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Locale</span>
                    <span className="font-medium text-slate-800">{getEffectiveLocale(form.language, form.default_currency)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Currency</span>
                    <span className="font-medium text-slate-800">{form.default_currency} ({getCurrencySymbol(form.default_currency)})</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Timezone</span>
                    <span className="font-medium text-slate-800">{form.timezone}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Date Format</span>
                    <span className="font-medium text-slate-800">{form.date_format}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Number Format</span>
                    <span className="font-medium text-slate-800">
                      {formatNumber(1234567.89, getEffectiveLocale(form.language, form.default_currency), form.currency_precision)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Tax Type</span>
                    <span className="font-medium text-slate-800">{form.tax_label || "Not configured"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Invoice Prefix</span>
                    <span className="font-mono font-medium text-slate-800">{form.invoice_prefix || "INV-"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Fiscal Year</span>
                    <span className="font-medium text-slate-800">{form.fiscal_year_start} to {form.fiscal_year_end}</span>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <button onClick={resetToCountryDefaults} className="px-3 py-2 bg-white border border-slate-300 rounded-lg text-sm">Reset to Country Defaults</button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {activeTab === "invoicing" && (
        <div className="space-y-6">
          <Card title="Numbering" icon={FileText} color="blue">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <Field id="invoice_prefix" label="Invoice Prefix" tooltip="Prefix for invoice numbers" error={fieldErrors.invoice_prefix}>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Input id="invoice_prefix" value={form.invoice_prefix} onChange={(e) => update("invoice_prefix", e.target.value)} ariaLabel="Invoice prefix" />
                  </div>
                  <div className="shrink-0"><StatusBadge status={fieldStatus.invoice_prefix} /></div>
                </div>
              </Field>
              <Field id="invoice_number_format" label="Invoice Number Format" tooltip="Pattern for generating invoice numbers">
                <Select id="invoice_number_format" value={form.invoice_number_format} onChange={(e) => update("invoice_number_format", e.target.value)}
                  ariaLabel="Invoice number format"
                  options={[
                    {value:"PREFIX-{SEQ}", label:"Simple Sequential", description:"INV-000001"},
                    {value:"PREFIX-{YYYY}-{SEQ}", label:"Annual Sequential", description:"INV-2026-000001"},
                    {value:"PREFIX-{YYYYMM}-{SEQ}", label:"Monthly Sequential", description:"INV-202601-000001"},
                    {value:"PREFIX-{YYYY}-{MM}-{SEQ}", label:"Year-Month-Seq", description:"INV-2026-01-000001"},
                    {value:"PREFIX-{MM}-{YYYY}-{SEQ}", label:"Month-Year-Seq", description:"INV-01-2026-000001"},
                  ]} />
              </Field>
              <Field id="invoice_sequence_reset" label="Sequence Reset" tooltip="When to reset the sequence counter">
                <Select id="invoice_sequence_reset" value={form.invoice_sequence_reset} onChange={(e) => update("invoice_sequence_reset", e.target.value)}
                  ariaLabel="Invoice sequence reset"
                  options={[
                    {value:"never", label:"Never", description:"Continuous numbering forever"},
                    {value:"monthly", label:"Monthly", description:"Reset at the start of each month"},
                    {value:"quarterly", label:"Quarterly", description:"Reset at the start of each quarter"},
                    {value:"annually", label:"Annually", description:"Reset at the start of each year"},
                  ]} />
              </Field>
              <Field id="quote_prefix" label="Quote Prefix" error={fieldErrors.quote_prefix}>
                <Input id="quote_prefix" value={form.quote_prefix} onChange={(e) => update("quote_prefix", e.target.value)} ariaLabel="Quote prefix" />
              </Field>
              <Field id="quote_number_format" label="Quote Number Format">
                <Select id="quote_number_format" value={form.quote_number_format} onChange={(e) => update("quote_number_format", e.target.value)}
                  ariaLabel="Quote number format"
                  options={[
                    {value:"PREFIX-{SEQ}", label:"Simple Sequential", description:"QTE-000001"},
                    {value:"PREFIX-{YYYY}-{SEQ}", label:"Annual Sequential", description:"QTE-2026-000001"},
                    {value:"PREFIX-{YYYYMM}-{SEQ}", label:"Monthly Sequential", description:"QTE-202601-000001"},
                    {value:"PREFIX-{YYYY}-{MM}-{SEQ}", label:"Year-Month-Seq", description:"QTE-2026-01-000001"},
                  ]} />
              </Field>
              <Field id="quote_sequence_reset" label="Quote Sequence Reset">
                <Select id="quote_sequence_reset" value={form.quote_sequence_reset} onChange={(e) => update("quote_sequence_reset", e.target.value)}
                  ariaLabel="Quote sequence reset"
                  options={[
                    {value:"never", label:"Never", description:"Continuous numbering"},
                    {value:"monthly", label:"Monthly", description:"Reset each month"},
                    {value:"quarterly", label:"Quarterly", description:"Reset each quarter"},
                    {value:"annually", label:"Annually", description:"Reset each year"},
                  ]} />
              </Field>
              <Field id="credit_note_prefix" label="Credit Note Prefix">
                <Input id="credit_note_prefix" value={form.credit_note_prefix} onChange={(e) => update("credit_note_prefix", e.target.value)} ariaLabel="Credit note prefix" />
              </Field>
              <Field id="credit_note_number_format" label="Credit Note Format">
                <Select id="credit_note_number_format" value={form.credit_note_number_format} onChange={(e) => update("credit_note_number_format", e.target.value)}
                  ariaLabel="Credit note number format"
                  options={[
                    {value:"PREFIX-{SEQ}", label:"Simple Sequential", description:"CN-000001"},
                    {value:"PREFIX-{YYYY}-{SEQ}", label:"Annual Sequential", description:"CN-2026-000001"},
                    {value:"PREFIX-{YYYYMM}-{SEQ}", label:"Monthly Sequential", description:"CN-202601-000001"},
                  ]} />
              </Field>
              <Field id="credit_note_sequence_reset" label="Credit Note Sequence Reset">
                <Select id="credit_note_sequence_reset" value={form.credit_note_sequence_reset} onChange={(e) => update("credit_note_sequence_reset", e.target.value)}
                  ariaLabel="Credit note sequence reset"
                  options={[
                    {value:"never", label:"Never", description:"Continuous numbering"},
                    {value:"monthly", label:"Monthly", description:"Reset each month"},
                    {value:"quarterly", label:"Quarterly", description:"Reset each quarter"},
                    {value:"annually", label:"Annually", description:"Reset each year"},
                  ]} />
              </Field>
              <Field id="refund_prefix" label="Refund Prefix">
                <Input id="refund_prefix" value={form.refund_prefix} onChange={(e) => update("refund_prefix", e.target.value)} ariaLabel="Refund prefix" />
              </Field>
              <Field id="refund_number_format" label="Refund Format">
                <Select id="refund_number_format" value={form.refund_number_format} onChange={(e) => update("refund_number_format", e.target.value)}
                  ariaLabel="Refund number format"
                  options={[
                    {value:"PREFIX-{SEQ}", label:"Simple Sequential", description:"RF-000001"},
                    {value:"PREFIX-{YYYY}-{SEQ}", label:"Annual Sequential", description:"RF-2026-000001"},
                    {value:"PREFIX-{YYYYMM}-{SEQ}", label:"Monthly Sequential", description:"RF-202601-000001"},
                  ]} />
              </Field>
              <Field id="refund_sequence_reset" label="Refund Sequence Reset">
                <Select id="refund_sequence_reset" value={form.refund_sequence_reset} onChange={(e) => update("refund_sequence_reset", e.target.value)}
                  ariaLabel="Refund sequence reset"
                  options={[
                    {value:"never", label:"Never", description:"Continuous numbering"},
                    {value:"monthly", label:"Monthly", description:"Reset each month"},
                    {value:"quarterly", label:"Quarterly", description:"Reset each quarter"},
                    {value:"annually", label:"Annually", description:"Reset each year"},
                  ]} />
              </Field>
            </div>

            <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 bg-gradient-to-r from-blue-50 to-cyan-50 border border-blue-200 rounded-xl">
                <p className="text-xs font-semibold text-blue-600 uppercase tracking-wider mb-3">Invoice Preview</p>
                {(() => { const inv = generateInvoicePreview(form.invoice_prefix, form.invoice_number_format, 245); return (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-blue-500">Current</span>
                      <span className="text-sm font-mono font-bold text-blue-900 bg-white/60 px-2 py-0.5 rounded">{inv.current}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-blue-500">Next</span>
                      <span className="text-sm font-mono font-bold text-blue-900 bg-white/60 px-2 py-0.5 rounded">{inv.next}</span>
                    </div>
                  </div>); })()}
              </div>
              <div className="p-4 bg-gradient-to-r from-slate-50 to-slate-50 border border-slate-200 rounded-xl">
                <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-3">All Document Types</p>
                {(() => { const types = [
                  { label: "Invoice", prefix: form.invoice_prefix, format: form.invoice_number_format },
                  { label: "Quote", prefix: form.quote_prefix, format: form.quote_number_format },
                  { label: "Credit Note", prefix: form.credit_note_prefix, format: form.credit_note_number_format },
                  { label: "Refund", prefix: form.refund_prefix, format: form.refund_number_format },
                ]; return (
                  <div className="space-y-1.5">
                    {types.map((t) => { const p = generateInvoicePreview(t.prefix, t.format, 1); return (
                      <div key={t.label} className="flex items-center justify-between">
                        <span className="text-xs text-slate-500">{t.label}</span>
                        <span className="text-xs font-mono font-medium text-slate-800 bg-white/60 px-2 py-0.5 rounded">{p.current}</span>
                      </div>); })}
                  </div>); })()}
              </div>
            </div>

            <div className="mt-3 p-3 bg-amber-50 border border-amber-100 rounded-lg flex items-start gap-2">
              <AlertCircle size={14} className="text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700">Changing the prefix or format after invoices have been generated may cause numbering conflicts. Consider resetting the sequence manually.</p>
            </div>
          </Card>

          <Card title="Invoice Defaults" icon={Settings2} color="blue">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <Field id="default_due_days" label="Default Due Days" tooltip="Default payment due period in days" error={fieldErrors.default_due_days}>
                <Input id="default_due_days" type="number" value={form.default_due_days} min={1} max={365}
                  onChange={(e) => update("default_due_days", parseInt(e.target.value) || 30)} ariaLabel="Default due days" />
                <p className="text-xs text-slate-400 mt-1">Must be at least 1 day</p>
              </Field>
              <Field id="payment_reminder_days_before" label="Reminder Days Before" tooltip="Days before due date to send reminder" error={fieldErrors.payment_reminder_days_before}>
                <Input id="payment_reminder_days_before" type="number" value={form.payment_reminder_days_before} min={0} max={form.default_due_days || 90}
                  onChange={(e) => {
                    const val = parseInt(e.target.value) || 0;
                    if (val > (form.default_due_days || 30)) {
                      setFieldErrors((prev) => ({ ...prev, payment_reminder_days_before: "Cannot exceed default due days" }));
                    } else {
                      setFieldErrors((prev) => ({ ...prev, payment_reminder_days_before: undefined }));
                    }
                    update("payment_reminder_days_before", val);
                  }} ariaLabel="Payment reminder days before due" />
                {form.payment_reminder_days_before > form.default_due_days && (
                  <p className="text-xs text-red-500 mt-1">Warning: Reminder days exceed due days</p>
                )}
              </Field>
              <Field id="late_payment_fee_percentage" label="Late Fee (%)" tooltip="Percentage-based late payment fee" error={fieldErrors.late_payment_fee_percentage}>
                <Input id="late_payment_fee_percentage" type="number" value={form.late_payment_fee_percentage} min={0} max={100} step={0.01}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value) || 0;
                    if (val > 100) {
                      setFieldErrors((prev) => ({ ...prev, late_payment_fee_percentage: "Cannot exceed 100%" }));
                    } else if (val < 0) {
                      setFieldErrors((prev) => ({ ...prev, late_payment_fee_percentage: "Cannot be negative" }));
                    } else {
                      setFieldErrors((prev) => ({ ...prev, late_payment_fee_percentage: undefined }));
                    }
                    update("late_payment_fee_percentage", val);
                  }} ariaLabel="Late payment fee percentage" />
                <p className="text-xs text-slate-400 mt-1">Max 100%, cannot be negative</p>
              </Field>
              <Field id="late_payment_fee_flat" label="Late Fee (Flat)" tooltip="Fixed late payment fee amount">
                <Input id="late_payment_fee_flat" type="number" value={form.late_payment_fee_flat} min={0} step={0.01}
                  onChange={(e) => update("late_payment_fee_flat", parseFloat(e.target.value) || 0)} ariaLabel="Late payment fee flat amount" />
                <p className="text-xs text-slate-400 mt-1">Fixed amount added as late fee</p>
              </Field>
              <Field id="invoice_template" label="Invoice Template" tooltip="Visual template for invoices">
                <Select id="invoice_template" value={form.invoice_template} onChange={(e) => update("invoice_template", e.target.value)}
                  ariaLabel="Invoice template"
                  options={[
                    {value:"standard", label:"Standard", description:"Clean, professional layout"},
                    {value:"modern", label:"Modern", description:"Contemporary design with bold colors"},
                    {value:"professional", label:"Professional", description:"Formal corporate layout"},
                    {value:"minimal", label:"Minimal", description:"Simple, distraction-free design"},
                    {value:"bold", label:"Bold", description:"High-impact visual design"},
                  ]} />
                <p className="text-xs text-slate-400 mt-1">{TEMPLATE_DESCRIPTIONS[form.invoice_template] || ""}</p>
              </Field>
              <Field id="invoice_pdf_template" label="PDF Template" tooltip="PDF export template">
                <Select id="invoice_pdf_template" value={form.invoice_pdf_template} onChange={(e) => update("invoice_pdf_template", e.target.value)}
                  ariaLabel="PDF template"
                  options={[
                    {value:"standard", label:"Standard", description:"Default PDF layout"},
                    {value:"modern", label:"Modern", description:"Contemporary PDF design"},
                    {value:"professional", label:"Professional", description:"Formal PDF layout"},
                    {value:"minimal", label:"Minimal", description:"Clean PDF layout"},
                  ]} />
              </Field>
              <Field id="draft_behaviour" label="Draft Behaviour" tooltip="How new invoices are handled">
                <Select id="draft_behaviour" value={form.draft_behaviour} onChange={(e) => update("draft_behaviour", e.target.value)}
                  ariaLabel="Draft behaviour"
                  options={[
                    {value:"save_as_draft", label:"Save as Draft", description:"Invoice saved as draft for review"},
                    {value:"auto_finalize", label:"Auto-finalize", description:"Immediately finalize invoice"},
                    {value:"send_for_approval", label:"Send for Approval", description:"Route to approver before sending"},
                  ]} />
              </Field>
              <Field id="invoice_logo_url" label="Invoice Logo URL" tooltip="Logo to display on invoices" error={fieldErrors.invoice_logo_url}>
                <Input id="invoice_logo_url" type="url" value={form.invoice_logo_url} onChange={(e) => update("invoice_logo_url", e.target.value)} ariaLabel="Invoice logo URL" placeholder="https://example.com/logo.png" />
                {form.invoice_logo_url && (
                  <div className="mt-2">
                    <img src={form.invoice_logo_url} alt="Invoice logo preview" className="h-8 object-contain rounded border border-slate-100"
                      onError={(e) => { e.target.style.display = "none"; e.target.nextSibling.style.display = "block"; }} />
                    <p className="text-xs text-red-400 hidden">Could not load image</p>
                  </div>
                )}
              </Field>
              <Field id="invoice_watermark" label="Invoice Watermark" tooltip="Watermark text or image URL">
                <Input id="invoice_watermark" value={form.invoice_watermark} onChange={(e) => update("invoice_watermark", e.target.value)} ariaLabel="Invoice watermark" placeholder="e.g. PAID, DRAFT, COPY" />
              </Field>
            </div>
            <div className="mt-4 space-y-1">
              <Toggle id="auto_generate_invoice_number" label="Auto-generate invoice numbers" description="Automatically generate sequential invoice numbers"
                checked={form.auto_generate_invoice_number} onChange={() => updateToggle("auto_generate_invoice_number")} />
              <Toggle id="show_tax_breakdown" label="Show tax breakdown" description="Display detailed tax lines on invoices"
                checked={form.show_tax_breakdown} onChange={() => updateToggle("show_tax_breakdown")} />
              <Toggle id="show_discount" label="Show discount" description="Display discount amounts on invoices"
                checked={form.show_discount} onChange={() => updateToggle("show_discount")} />
              <Toggle id="show_shipping" label="Show shipping" description="Display shipping charges on invoices"
                checked={form.show_shipping} onChange={() => updateToggle("show_shipping")} />
            </div>
          </Card>

          <Card title="Invoice Text & Terms" icon={FileText} color="blue">
            <div className="grid grid-cols-1 gap-5">
              <Field id="invoice_footer" label="Invoice Footer" tooltip="Text displayed at the bottom of invoices">
                <Textarea id="invoice_footer" value={form.invoice_footer} onChange={(e) => update("invoice_footer", e.target.value)} rows={2} ariaLabel="Invoice footer text" />
              </Field>
              <Field id="invoice_terms" label="Invoice Terms" tooltip="Payment terms and conditions">
                <Textarea id="invoice_terms" value={form.invoice_terms} onChange={(e) => update("invoice_terms", e.target.value)} rows={3} ariaLabel="Invoice terms" />
              </Field>
              <Field id="invoice_notes" label="Invoice Notes" tooltip="General notes on invoices">
                <Textarea id="invoice_notes" value={form.invoice_notes} onChange={(e) => update("invoice_notes", e.target.value)} rows={3} ariaLabel="Invoice notes" />
              </Field>
              <Field id="invoice_terms_and_conditions" label="Terms & Conditions" tooltip="Full terms and conditions text">
                <Textarea id="invoice_terms_and_conditions" value={form.invoice_terms_and_conditions} onChange={(e) => update("invoice_terms_and_conditions", e.target.value)} rows={4} ariaLabel="Terms and conditions" />
              </Field>
            </div>
          </Card>
        </div>
      )}

      {activeTab === "payments" && (
        <div className="space-y-6">
          <Card title="Payment Terms" icon={Wallet} color="emerald">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <Field label="Default Payment Terms">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Select id="default_payment_terms" value={form.default_payment_terms} onChange={(e) => update("default_payment_terms", e.target.value)}
                      options={["due_on_receipt","net_7","net_10","net_15","net_30","net_45","net_60","net_90"]} />
                  </div>
                  <div className="shrink-0"><StatusBadge status={fieldStatus.default_payment_terms} flash={transientFields.has('default_payment_terms')} /></div>
                </div>
              </Field>
              <Field label="Rounding Method">
                <Select id="rounding_method" value={form.rounding_method} onChange={(e) => update("rounding_method", e.target.value)}
                  options={["none","up","down","half_up","half_down","half_even"]} />
              </Field>
              <Field label="Rounding Precision">
                <Input id="rounding_precision" type="number" value={form.rounding_precision} min={0} max={10}
                  onChange={(e) => update("rounding_precision", parseInt(e.target.value) || 2)} />
              </Field>
              <Field label="Exchange Rate Provider">
                <Select id="exchange_rate_provider" value={form.exchange_rate_provider} onChange={(e) => update("exchange_rate_provider", e.target.value)}
                  options={["manual","open_er_api","ecb","fixer","xe","currency_layer"]} />
              </Field>
              <Field label="Grace Period (Days)" tooltip="Days after due date before late fees apply">
                <Input id="grace_period_days" type="number" value={form.grace_period_days} min={0} max={365}
                  onChange={(e) => update("grace_period_days", parseInt(e.target.value) || 0)} />
              </Field>
              <Field label="Credit Limit" tooltip="Default credit limit for customers">
                <Input id="credit_limit" type="number" value={form.credit_limit} min={0} step={0.01}
                  onChange={(e) => update("credit_limit", parseFloat(e.target.value) || 0)} />
              </Field>
            </div>
            <div className="mt-4 space-y-1">
              <Toggle id="auto_send_receipts" label="Auto-send receipts" description="Automatically send payment receipts to customers"
                checked={form.auto_send_receipts} onChange={() => updateToggle("auto_send_receipts")} />
              <Toggle id="exchange_rate_auto_update" label="Auto-update exchange rates" description="Fetch latest exchange rates from provider"
                checked={form.exchange_rate_auto_update} onChange={() => updateToggle("exchange_rate_auto_update")} />
              <Toggle id="auto_capture_enabled" label="Auto-capture payments" description="Automatically capture authorized payments"
                checked={form.auto_capture_enabled} onChange={() => updateToggle("auto_capture_enabled")} />
            </div>
          </Card>

          <Card title="Exchange Rate Management" icon={RefreshCw} color="emerald">
            <p className="text-xs text-slate-500 mb-4">Manage live exchange rates from ExchangeRate-API (open.er-api.com)</p>
            <div className="flex items-center gap-3 mb-4">
              <button
                onClick={handleRefreshExchangeRates}
                disabled={refreshingRates}
                className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${refreshingRates ? 'animate-spin' : ''}`} />
                {refreshingRates ? 'Refreshing...' : 'Refresh Now'}
              </button>
              {exchangeRates?.last_refreshed && (
                <span className="text-xs text-slate-500">
                  Last updated: {new Date(exchangeRates.last_refreshed).toLocaleString()}
                </span>
              )}
              {!exchangeRates?.last_refreshed && exchangeRates?.timestamp && (
                <span className="text-xs text-slate-500">
                  Last updated: {new Date(exchangeRates.timestamp).toLocaleString()}
                </span>
              )}
            </div>
            {exchangeRateError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {exchangeRateError}
              </div>
            )}
            {exchangeRates?.rates && Object.keys(exchangeRates.rates).length > 0 && (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50">
                    <tr>
                      <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase">Currency Code</th>
                      <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase">Rate (vs {exchangeRates.base_currency || "USD"})</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {Object.entries(exchangeRates.rates).map(([code, rate]) => (
                      <tr key={code}>
                        <td className="px-3 py-2 text-sm font-medium text-slate-900">{code}</td>
                        <td className="px-3 py-2 text-sm text-slate-600">{rate}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {exchangeRates?.supported_currencies && (
              <div className="mt-3">
                <span className="text-xs text-slate-500">Supported: {exchangeRates.supported_currencies.join(', ')}</span>
              </div>
            )}
          </Card>

          <Card title="Payment Gateways" icon={CreditCard} color="emerald">
            <p className="text-xs text-slate-500 mb-4">Enable or disable payment gateways for your organization</p>
            <div className="space-y-1">
              <Toggle id="gateway_stripe_enabled" label="Stripe" description="Accept credit/debit card payments via Stripe"
                checked={form.gateway_stripe_enabled} onChange={() => updateToggle("gateway_stripe_enabled")} />
              <Toggle id="gateway_razorpay_enabled" label="Razorpay" description="Accept payments via Razorpay (India)"
                checked={form.gateway_razorpay_enabled} onChange={() => updateToggle("gateway_razorpay_enabled")} />
              <Toggle id="gateway_paypal_enabled" label="PayPal" description="Accept payments via PayPal"
                checked={form.gateway_paypal_enabled} onChange={() => updateToggle("gateway_paypal_enabled")} />
              <Toggle id="gateway_cash_enabled" label="Cash" description="Accept cash payments"
                checked={form.gateway_cash_enabled} onChange={() => updateToggle("gateway_cash_enabled")} />
              <Toggle id="gateway_bank_transfer_enabled" label="Bank Transfer" description="Accept bank transfer payments"
                checked={form.gateway_bank_transfer_enabled} onChange={() => updateToggle("gateway_bank_transfer_enabled")} />
              <Toggle id="gateway_upi_enabled" label="UPI" description="Accept UPI payments (India)"
                checked={form.gateway_upi_enabled} onChange={() => updateToggle("gateway_upi_enabled")} />
              <Toggle id="gateway_offline_enabled" label="Offline" description="Accept offline payment methods"
                checked={form.gateway_offline_enabled} onChange={() => updateToggle("gateway_offline_enabled")} />
            </div>
            <div className="mt-5">
              <Field label="Webhook Secret" tooltip="Secret key for payment gateway webhooks">
                <Input id="webhook_secret" value={form.webhook_secret} onChange={(e) => update("webhook_secret", e.target.value)} />
              </Field>
            </div>
          </Card>
        </div>
      )}

      {activeTab === "tax" && (
        <div className="space-y-6">
          <Card title="Tax Configuration" icon={Receipt} color="amber">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <Field label="Tax Calculation Method">
                <Select id="tax_calculation_method" value={form.tax_calculation_method} onChange={(e) => update("tax_calculation_method", e.target.value)}
                  options={[{value:"exclusive",label:"Exclusive (added to subtotal)"},{value:"inclusive",label:"Inclusive (included in price)"}]} />
              </Field>
              <Field label="Tax Label" tooltip="Display label for tax (e.g. VAT, GST, Sales Tax)">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <Input id="tax_label" value={form.tax_label} onChange={(e) => update("tax_label", e.target.value)} />
                  </div>
                  <div className="shrink-0"><StatusBadge status={fieldStatus.tax_label} flash={transientFields.has('tax_label')} /></div>
                </div>
              </Field>
              <Field label="Tax Registration Number">
                <Input id="tax_number" value={form.tax_number} onChange={(e) => update("tax_number", e.target.value)} />
              </Field>
              <Field label="Tax Rounding Method">
                <Select id="tax_rounding_method" value={form.tax_rounding_method} onChange={(e) => update("tax_rounding_method", e.target.value)}
                  options={[{value:"per_line",label:"Per Line"},{value:"per_invoice",label:"Per Invoice"},{value:"per_line_item",label:"Per Line Item"}]} />
              </Field>
            </div>
            <div className="mt-4 space-y-1">
              <Toggle id="is_tax_inclusive_default" label="Tax inclusive by default" description="New items default to tax-inclusive pricing"
                checked={form.is_tax_inclusive_default} onChange={() => updateToggle("is_tax_inclusive_default")} />
              <Toggle id="show_tax_on_invoice" label="Show tax on invoice" description="Display tax amounts on invoices"
                checked={form.show_tax_on_invoice} onChange={() => updateToggle("show_tax_on_invoice")} />
              <Toggle id="enable_auto_tax_calculation" label="Auto-calculate tax" description="Automatically calculate tax based on tax rates"
                checked={form.enable_auto_tax_calculation} onChange={() => updateToggle("enable_auto_tax_calculation")} />
            </div>
          </Card>

          <Card title="Tax Types" icon={BadgePercent} color="amber">
            <p className="text-xs text-slate-500 mb-4">Configure which tax types are enabled for your organization</p>
            <div className="space-y-1">
              {(() => {
                const c = form.country;
                const mapping = {
                  India: ['gst_enabled'],
                  Australia: ['gst_enabled'],
                  Singapore: ['gst_enabled'],
                  'United States': ['sales_tax_enabled'],
                  'United Kingdom': ['sales_tax_enabled'],
                  UAE: ['sales_tax_enabled'],
                };
                const keys = mapping[c] || null;
                if (keys) {
                  return keys.map((k) => {
                    if (k === 'gst_enabled') return (
                      <Toggle id="gst_enabled" key={k} label="GST" description="Goods and Services Tax" checked={form.gst_enabled} onChange={() => updateToggle('gst_enabled')} />
                    );
                    if (k === 'sales_tax_enabled') return (
                      <Toggle id="sales_tax_enabled" key={k} label={c === 'United Kingdom' || c === 'UAE' ? 'VAT' : 'Sales Tax'} description={c === 'United Kingdom' || c === 'UAE' ? 'Value Added Tax' : 'Sales tax (state-based)'} checked={form.sales_tax_enabled} onChange={() => updateToggle('sales_tax_enabled')} />
                    );
                    return null;
                  });
                }
                return (
                  <>
                    <Toggle id="gst_enabled" label="GST" description="Goods and Services Tax (India, Australia, Canada, etc.)"
                      checked={form.gst_enabled} onChange={() => updateToggle("gst_enabled")} />
                    <Toggle id="sales_tax_enabled" label="Sales Tax" description="Sales tax (US states, Canada provinces)"
                      checked={form.sales_tax_enabled} onChange={() => updateToggle("sales_tax_enabled")} />
                    <Toggle id="service_tax_enabled" label="Service Tax" description="Service tax on specified services"
                      checked={form.service_tax_enabled} onChange={() => updateToggle("service_tax_enabled")} />
                    <Toggle id="withholding_tax_enabled" label="Withholding Tax" description="Withholding tax (WHT) on payments"
                      checked={form.withholding_tax_enabled} onChange={() => updateToggle("withholding_tax_enabled")} />
                    <Toggle id="reverse_charge_enabled" label="Reverse Charge" description="Reverse charge mechanism for VAT/GST"
                      checked={form.reverse_charge_enabled} onChange={() => updateToggle("reverse_charge_enabled")} />
                    <Toggle id="compound_tax_enabled" label="Compound Tax" description="Tax on tax (compound taxation)"
                      checked={form.compound_tax_enabled} onChange={() => updateToggle("compound_tax_enabled")} />
                  </>
                );
              })()}
            </div>
          </Card>
        </div>
      )}

      {activeTab === "dunning" && (
        <div className="space-y-6">
          <Card title="Dunning Configuration" icon={Percent} color="rose">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <Field label="Dunning Level Count" tooltip="Number of dunning escalation levels">
                <Input id="dunning_level_count" type="number" value={form.dunning_level_count} min={1} max={10}
                  onChange={(e) => update("dunning_level_count", parseInt(e.target.value) || 4)} />
              </Field>
              <Field label="Wait Days Between Levels" tooltip="Days to wait between each dunning level">
                <Input id="dunning_wait_days" type="number" value={form.dunning_wait_days} min={0} max={90}
                  onChange={(e) => update("dunning_wait_days", parseInt(e.target.value) || 3)} />
              </Field>
              <Field label="Collections Wait Days" tooltip="Days before escalating to collections">
                <Input id="collections_wait_days" type="number" value={form.collections_wait_days} min={0} max={365}
                  onChange={(e) => update("collections_wait_days", parseInt(e.target.value) || 30)} />
              </Field>
              <Field label="Grace Days" tooltip="Days after due date before dunning starts">
                <Input id="grace_days" type="number" value={form.grace_days} min={0} max={365}
                  onChange={(e) => update("grace_days", parseInt(e.target.value) || 0)} />
              </Field>
            </div>
            <div className="mt-4 space-y-1">
              <Toggle id="auto_dunning" label="Enable auto-dunning" description="Automatically process dunning for overdue invoices"
                checked={form.auto_dunning} onChange={() => updateToggle("auto_dunning")} />
              <Toggle id="enable_escalation_to_collections" label="Escalate to collections" description="Auto-escalate unresolved cases to collections"
                checked={form.enable_escalation_to_collections} onChange={() => updateToggle("enable_escalation_to_collections")} />
              <Toggle id="reminder_sms_enabled" label="SMS Reminders" description="Send dunning reminders via SMS"
                checked={form.reminder_sms_enabled} onChange={() => updateToggle("reminder_sms_enabled")} />
              <Toggle id="reminder_whatsapp_enabled" label="WhatsApp Reminders" description="Send dunning reminders via WhatsApp"
                checked={form.reminder_whatsapp_enabled} onChange={() => updateToggle("reminder_whatsapp_enabled")} />
              <Toggle id="auto_suspend_enabled" label="Auto-suspend on overdue" description="Automatically suspend services for overdue accounts"
                checked={form.auto_suspend_enabled} onChange={() => updateToggle("auto_suspend_enabled")} />
            </div>
          </Card>

          <Card title="Penalties & Interest" icon={AlertCircle} color="rose">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <Field label="Penalty Type">
                <Select id="penalty_settings" value={(form.penalty_settings && form.penalty_settings.type) || "percentage"}
                  onChange={(e) => update("penalty_settings", { ...(form.penalty_settings || {}), type: e.target.value })}
                  options={[{value:"percentage",label:"Percentage"},{value:"flat",label:"Flat Amount"},{value:"none",label:"No Penalty"}]} />
              </Field>
              <Field label="Penalty Value">
                <Input id="penalty_settings" type="number" value={(form.penalty_settings && form.penalty_settings.value) || 0} min={0} step={0.01}
                  onChange={(e) => update("penalty_settings", { ...(form.penalty_settings || {}), value: parseFloat(e.target.value) || 0 })} />
              </Field>
              <Field label="Interest Annual Rate (%)" tooltip="Annual interest rate for overdue amounts">
                <Input id="interest_settings" type="number" value={(form.interest_settings && form.interest_settings.annual_rate) || 0} min={0} max={100} step={0.01}
                  onChange={(e) => update("interest_settings", { ...(form.interest_settings || {}), annual_rate: parseFloat(e.target.value) || 0 })} />
              </Field>
              <Field label="Interest Compounding">
                <Select id="interest_settings" value={(form.interest_settings && form.interest_settings.compounding) || "simple"}
                  onChange={(e) => update("interest_settings", { ...(form.interest_settings || {}), compounding: e.target.value })}
                  options={[{value:"simple",label:"Simple"},{value:"compound",label:"Compound"}]} />
              </Field>
            </div>
          </Card>
        </div>
      )}

      {activeTab === "revenue" && (
        <div className="space-y-6">
          <Card title="Revenue Recognition" icon={Activity} color="cyan">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <Field label="Recognition Method">
                <Select id="revenue_recognition_method" value={form.revenue_recognition_method} onChange={(e) => update("revenue_recognition_method", e.target.value)}
                  options={[{value:"immediate",label:"Immediate"},{value:"daily_prorated",label:"Daily Prorated"},{value:"monthly_prorated",label:"Monthly Prorated"},{value:"milestone",label:"Milestone"},{value:"manual",label:"Manual"}]} />
              </Field>
              <Field label="Deferral Days">
                <Input id="revenue_recognition_deferral_days" type="number" value={form.revenue_recognition_deferral_days} min={0} max={3650}
                  onChange={(e) => update("revenue_recognition_deferral_days", parseInt(e.target.value) || 0)} />
              </Field>
              <Field label="Revenue Method" tooltip="Cash, Accrual, or Deferred revenue method">
                <Select id="recognized_revenue_method" value={form.recognized_revenue_method} onChange={(e) => update("recognized_revenue_method", e.target.value)}
                  options={[{value:"cash",label:"Cash"},{value:"accrual",label:"Accrual"},{value:"deferred",label:"Deferred"}]} />
              </Field>
              <Field label="Recognition Frequency">
                <Select id="recognition_frequency" value={form.recognition_frequency} onChange={(e) => update("recognition_frequency", e.target.value)}
                  options={[{value:"daily",label:"Daily"},{value:"weekly",label:"Weekly"},{value:"monthly",label:"Monthly"},{value:"quarterly",label:"Quarterly"},{value:"annually",label:"Annually"}]} />
              </Field>
            </div>
            <div className="mt-4 space-y-1">
              <Toggle id="enable_revenue_recognition" label="Enable revenue recognition" description="Track deferred and recognized revenue"
                checked={form.enable_revenue_recognition} onChange={() => updateToggle("enable_revenue_recognition")} />
              <Toggle id="enable_multi_currency" label="Enable multi-currency" description="Support multiple currencies in billing"
                checked={form.enable_multi_currency} onChange={() => updateToggle("enable_multi_currency")} />
            </div>
          </Card>
        </div>
      )}

      {activeTab === "notifications" && (
        <div className="space-y-6">
          <Card title="Notification Events" icon={Bell} color="indigo">
            <p className="text-xs text-slate-500 mb-4">Configure which events trigger notifications</p>
            <div className="space-y-1">
              <Toggle id="notify_invoice_created" label="Invoice Created" checked={form.notify_invoice_created} onChange={() => updateToggle("notify_invoice_created")} />
              <Toggle id="notify_invoice_sent" label="Invoice Sent" checked={form.notify_invoice_sent} onChange={() => updateToggle("notify_invoice_sent")} />
              <Toggle id="notify_invoice_paid" label="Invoice Paid" checked={form.notify_invoice_paid} onChange={() => updateToggle("notify_invoice_paid")} />
              <Toggle id="notify_invoice_overdue" label="Invoice Overdue" checked={form.notify_invoice_overdue} onChange={() => updateToggle("notify_invoice_overdue")} />
              <Toggle id="notify_subscription_renewed" label="Subscription Renewed" checked={form.notify_subscription_renewed} onChange={() => updateToggle("notify_subscription_renewed")} />
              <Toggle id="notify_subscription_cancelled" label="Subscription Cancelled" checked={form.notify_subscription_cancelled} onChange={() => updateToggle("notify_subscription_cancelled")} />
              <Toggle id="notify_payment_failed" label="Payment Failed" checked={form.notify_payment_failed} onChange={() => updateToggle("notify_payment_failed")} />
              <Toggle id="notify_payment_success" label="Payment Success" checked={form.notify_payment_success} onChange={() => updateToggle("notify_payment_success")} />
              <Toggle id="notify_customer_created" label="Customer Created" checked={form.notify_customer_created} onChange={() => updateToggle("notify_customer_created")} />
            </div>
          </Card>
        </div>
      )}

      {activeTab === "advanced" && (
        <div className="space-y-6">
          <Card title="Feature Flags" icon={Shield} color="slate">
            <p className="text-xs text-slate-500 mb-4">Enable or disable billing module features</p>
            <div className="space-y-1">
              <Toggle id="enable_approval_workflow" label="Approval workflow" description="Require approval for invoices and quotes"
                checked={form.enable_approval_workflow} onChange={() => updateToggle("enable_approval_workflow")} />
              <Toggle id="enable_credit_notes" label="Credit notes" description="Allow creating and applying credit notes"
                checked={form.enable_credit_notes} onChange={() => updateToggle("enable_credit_notes")} />
              <Toggle id="enable_discounts" label="Discounts" description="Allow discounts on invoices and quotes"
                checked={form.enable_discounts} onChange={() => updateToggle("enable_discounts")} />
              <Toggle id="enable_retainers" label="Retainers" description="Enable retainer-based billing"
                checked={form.enable_retainers} onChange={() => updateToggle("enable_retainers")} />
              <Toggle id="enable_schedule_invoicing" label="Schedule invoicing" description="Schedule invoices for future dates"
                checked={form.enable_schedule_invoicing} onChange={() => updateToggle("enable_schedule_invoicing")} />
              <Toggle id="enable_partial_payments" label="Partial payments" description="Allow partial payments on invoices"
                checked={form.enable_partial_payments} onChange={() => updateToggle("enable_partial_payments")} />
              <Toggle id="enable_auto_apply_credits" label="Auto-apply credits" description="Automatically apply available credits to invoices"
                checked={form.enable_auto_apply_credits} onChange={() => updateToggle("enable_auto_apply_credits")} />
              <Toggle id="enable_quotes" label="Quotes" description="Enable quotation management"
                checked={form.enable_quotes} onChange={() => updateToggle("enable_quotes")} />
              <Toggle id="enable_contracts" label="Contracts" description="Enable contract management"
                checked={form.enable_contracts} onChange={() => updateToggle("enable_contracts")} />
              <Toggle id="enable_usage_billing" label="Usage-based billing" description="Enable usage-based billing"
                checked={form.enable_usage_billing} onChange={() => updateToggle("enable_usage_billing")} />
              <Toggle id="enable_refunds" label="Refunds" description="Enable refund processing"
                checked={form.enable_refunds} onChange={() => updateToggle("enable_refunds")} />
              <Toggle id="enable_auto_taxes" label="Auto-tax calculation" description="Enable automatic tax calculation"
                checked={form.enable_auto_taxes} onChange={() => updateToggle("enable_auto_taxes")} />
              <Toggle id="enable_audit_logs" label="Audit logs" description="Enable audit trail for all billing changes"
                checked={form.enable_audit_logs} onChange={() => updateToggle("enable_audit_logs")} />
            </div>
          </Card>
        </div>
      )}

      {activeTab === "administration" && <AdministrationPanel />}

      <div className="bg-brand-50/40 border border-brand-200 rounded-2xl p-6">
        <h3 className="text-base font-semibold text-brand-700 mb-2">Enterprise Billing Configuration</h3>
        <p className="text-sm text-brand-700">
          Changes take effect immediately for all new billing transactions.
          Existing invoices, quotes, and subscriptions retain their original settings.
          Audit logs capture all configuration changes for compliance.
        </p>
      </div>
    </div>
    </HighlightContext.Provider>
  );
}

/* ── Administration Panel ──────────────────────────────────────────────── */

function HealthStatusBadge({ status }) {
  const classes = {
    healthy: "bg-green-100 text-green-700 border-green-200",
    warning: "bg-amber-100 text-amber-700 border-amber-200",
    critical: "bg-red-100 text-red-700 border-red-200",
    unknown: "bg-slate-100 text-slate-500 border-slate-200",
  };
  const icons = {
    healthy: <CheckCircle size={12} />,
    warning: <AlertCircle size={12} />,
    critical: <AlertCircle size={12} />,
    unknown: <AlertCircle size={12} />,
  };
  const s = (status || "unknown").toLowerCase();
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${classes[s] || classes.unknown}`}>
      {icons[s] || icons.unknown}
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </span>
  );
}

function AdminCard({ title, icon: Icon, color = "slate", children, action }) {
  return (
    <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <div className="flex items-center justify-between mb-5 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-gradient-to-r from-slate-500 to-slate-600 text-white flex items-center justify-center shrink-0">
            {Icon && <Icon size={20} />}
          </div>
          <h3 className="text-base font-semibold text-slate-900 truncate">{title}</h3>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function AdministrationPanel() {
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState(null);

  const [smtpForm, setSmtpForm] = useState({ recipient_email: "", test_subject: "Billing SMTP Test" });
  const [smtpResult, setSmtpResult] = useState(null);
  const [smtpLoading, setSmtpLoading] = useState(false);
  const [smtpError, setSmtpError] = useState(null);

  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState(null);
  const [previewTemplate, setPreviewTemplate] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [previewVariables, setPreviewVariables] = useState("{}");

  const [numberingDiag, setNumberingDiag] = useState(null);
  const [numberingDiagLoading, setNumberingDiagLoading] = useState(false);

  const [taxDiag, setTaxDiag] = useState(null);
  const [taxDiagLoading, setTaxDiagLoading] = useState(false);

  const [exchangeDiag, setExchangeDiag] = useState(null);
  const [exchangeDiagLoading, setExchangeDiagLoading] = useState(false);

  const [enhancedValidation, setEnhancedValidation] = useState(null);
  const [enhancedValidationLoading, setEnhancedValidationLoading] = useState(false);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      const data = await settingsApi.getHealth();
      setHealth(data);
    } catch (err) {
      setHealthError(err.message || "Failed to load health status");
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError(null);
    try {
      const data = await settingsApi.listEmailTemplates();
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err) {
      setTemplatesError(err.message || "Failed to load templates");
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const loadNumberingDiag = useCallback(async () => {
    setNumberingDiagLoading(true);
    try {
      const data = await settingsApi.getNumberingDiagnostics();
      setNumberingDiag(Array.isArray(data) ? data : []);
    } catch (err) {
      setNumberingDiag({ error: err.message || "Failed to load numbering diagnostics" });
    } finally {
      setNumberingDiagLoading(false);
    }
  }, []);

  const loadTaxDiag = useCallback(async () => {
    setTaxDiagLoading(true);
    try {
      const data = await settingsApi.getTaxDiagnostics();
      setTaxDiag(Array.isArray(data) ? data : []);
    } catch (err) {
      setTaxDiag({ error: err.message || "Failed to load tax diagnostics" });
    } finally {
      setTaxDiagLoading(false);
    }
  }, []);

  const loadExchangeDiag = useCallback(async () => {
    setExchangeDiagLoading(true);
    try {
      const data = await settingsApi.getExchangeRateDiagnostics();
      setExchangeDiag(data);
    } catch (err) {
      setExchangeDiag({ error: err.message || "Failed to load exchange rate diagnostics" });
    } finally {
      setExchangeDiagLoading(false);
    }
  }, []);

  const handleTestSmtp = useCallback(async () => {
    if (!smtpForm.recipient_email) return;
    setSmtpLoading(true);
    setSmtpError(null);
    setSmtpResult(null);
    try {
      const data = await settingsApi.testSmtp(smtpForm);
      setSmtpResult(data);
    } catch (err) {
      setSmtpError(err.message || "SMTP test failed");
    } finally {
      setSmtpLoading(false);
    }
  }, [smtpForm]);

  const handlePreviewTemplate = useCallback(async (name) => {
    setPreviewTemplate(name);
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewData(null);
    try {
      let vars = {};
      try { vars = JSON.parse(previewVariables); } catch (err) { console.error("[Settings] Failed to parse preview vars:", err); }
      const data = await settingsApi.previewEmailTemplate(name, vars);
      setPreviewData(data);
    } catch (err) {
      setPreviewError(err.message || "Failed to load template preview");
    } finally {
      setPreviewLoading(false);
    }
  }, [previewVariables]);

  const handleEnhancedValidation = useCallback(async () => {
    setEnhancedValidationLoading(true);
    setEnhancedValidation(null);
    try {
      const data = await settingsApi.validateFull();
      setEnhancedValidation(data);
    } catch (err) {
      setEnhancedValidation({ error: err.message || "Enhanced validation failed" });
    } finally {
      setEnhancedValidationLoading(false);
    }
  }, []);

  React.useEffect(() => {
    loadHealth();
    loadTemplates();
  }, [loadHealth, loadTemplates]);

  const StatusLine = ({ label, status, detail }) => (
    <div className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
      <span className="text-sm text-slate-600">{label}</span>
      <div className="flex items-center gap-2">
        <HealthStatusBadge status={status} />
        {detail && <span className="text-xs text-slate-400">{detail}</span>}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Health Dashboard */}
      <AdminCard title="System Health" icon={Thermometer} action={
        <button onClick={loadHealth} disabled={healthLoading}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors">
          <RefreshCw size={12} className={healthLoading ? "animate-spin" : ""} />
          Refresh
        </button>
      }>
        {healthLoading && !health ? (
          <div className="animate-pulse space-y-3">
            <div className="h-4 bg-slate-200 rounded w-1/3" />
            <div className="h-4 bg-slate-200 rounded w-1/2" />
            <div className="h-4 bg-slate-200 rounded w-2/3" />
          </div>
        ) : healthError ? (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            <AlertCircle size={14} /> {healthError}
          </div>
        ) : health ? (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-slate-700">Overall Status:</span>
              <HealthStatusBadge status={health.overall_status} />
              {health.readiness_score !== undefined && (
                <span className="text-xs text-slate-500">
                  Readiness Score: <span className="font-semibold text-slate-700">{health.readiness_score}%</span>
                </span>
              )}
            </div>
            {health.components && health.components.length > 0 && (
              <div className="bg-slate-50 rounded-xl p-4">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Components</p>
                <div className="space-y-1">
                  {health.components.map((comp, i) => (
                    <StatusLine key={i}
                      label={comp.name || comp.component || `Component #${i + 1}`}
                      status={comp.status}
                      detail={comp.detail || comp.message} />
                  ))}
                </div>
              </div>
            )}
            <p className="text-xs text-slate-400">Checked at: {health.checked_at ? new Date(health.checked_at).toLocaleString() : "—"}</p>
          </div>
        ) : (
          <div className="flex items-center gap-2 p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-500">
            <Server size={14} /> Click refresh to check system health
          </div>
        )}
      </AdminCard>

      {/* SMTP Test */}
      <AdminCard title="SMTP Test" icon={Mail}>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Recipient Email</label>
              <input type="email" value={smtpForm.recipient_email} onChange={(e) => setSmtpForm((p) => ({ ...p, recipient_email: e.target.value }))}
                placeholder="test@example.com"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30/20" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Test Subject (optional)</label>
              <input type="text" value={smtpForm.test_subject} onChange={(e) => setSmtpForm((p) => ({ ...p, test_subject: e.target.value }))}
                placeholder="Billing SMTP Test"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30/20" />
            </div>
          </div>
          <button onClick={handleTestSmtp} disabled={smtpLoading || !smtpForm.recipient_email}
            className="inline-flex items-center gap-2 px-4 py-2 bg-slate-700 text-white text-sm font-medium rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {smtpLoading ? <RefreshCw size={14} className="animate-spin" /> : <Mail size={14} />}
            {smtpLoading ? "Testing..." : "Send Test Email"}
          </button>
          {smtpError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0" /> {smtpError}
            </div>
          )}
          {smtpResult && (
            <div className="space-y-3 p-4 bg-slate-50 rounded-xl border border-slate-100">
              <div className={`flex items-center gap-2 text-sm font-medium ${smtpResult.success ? "text-green-700" : "text-red-700"}`}>
                {smtpResult.success ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                {smtpResult.success ? "SMTP connection successful" : "SMTP connection failed"}
              </div>
              {smtpResult.message && <p className="text-xs text-slate-500">{smtpResult.message}</p>}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                <div className="p-2 bg-white rounded-lg border border-slate-100">
                  <span className="text-slate-400 block">Connection</span>
                  <HealthStatusBadge status={smtpResult.connection?.success ? "healthy" : "critical"} />
                  {smtpResult.connection?.details && <p className="text-slate-400 mt-1">{smtpResult.connection.details}</p>}
                </div>
                <div className="p-2 bg-white rounded-lg border border-slate-100">
                  <span className="text-slate-400 block">TLS</span>
                  <HealthStatusBadge status={smtpResult.tls?.success ? "healthy" : "critical"} />
                  {smtpResult.tls?.details && <p className="text-slate-400 mt-1">{smtpResult.tls.details}</p>}
                </div>
                <div className="p-2 bg-white rounded-lg border border-slate-100">
                  <span className="text-slate-400 block">Authentication</span>
                  <HealthStatusBadge status={smtpResult.authentication?.success ? "healthy" : "critical"} />
                  {smtpResult.authentication?.details && <p className="text-slate-400 mt-1">{smtpResult.authentication.details}</p>}
                </div>
                <div className="p-2 bg-white rounded-lg border border-slate-100">
                  <span className="text-slate-400 block">Test Email</span>
                  <HealthStatusBadge status={smtpResult.test_email_sent?.success ? "healthy" : "warning"} />
                  {smtpResult.test_email_sent?.details && <p className="text-slate-400 mt-1">{smtpResult.test_email_sent.details}</p>}
                </div>
              </div>
              {smtpResult.sender_identity && (
                <div className="p-2 bg-white rounded-lg border border-slate-100 text-xs">
                  <span className="text-slate-400 block">Sender Identity</span>
                  <HealthStatusBadge status={smtpResult.sender_identity?.success ? "healthy" : "warning"} />
                  {smtpResult.sender_identity?.details && <p className="text-slate-400 mt-1">{smtpResult.sender_identity.details}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      </AdminCard>

      {/* Email Templates */}
      <AdminCard title="Email Templates" icon={Eye} action={
        <button onClick={loadTemplates} disabled={templatesLoading}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors">
          <RefreshCw size={12} className={templatesLoading ? "animate-spin" : ""} />
          Refresh
        </button>
      }>
        {templatesLoading && templates.length === 0 ? (
          <div className="animate-pulse space-y-2">
            {[1,2,3].map((i) => <div key={i} className="h-10 bg-slate-100 rounded-lg" />)}
          </div>
        ) : templatesError ? (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            <AlertCircle size={14} /> {templatesError}
          </div>
        ) : templates.length === 0 ? (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-500 text-center">No email templates found</div>
        ) : (
          <div className="space-y-2">
            <div className="divide-y divide-slate-100">
              {templates.map((tpl, i) => (
                <div key={tpl.name || i} className="flex items-center justify-between py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800 truncate">{tpl.name}</p>
                    <p className="text-xs text-slate-400">
                      {tpl.size_bytes ? `${(tpl.size_bytes / 1024).toFixed(1)} KB` : ""}
                      {tpl.last_modified ? ` · ${new Date(tpl.last_modified).toLocaleDateString()}` : ""}
                    </p>
                  </div>
                  <button onClick={() => handlePreviewTemplate(tpl.name)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors shrink-0 ml-3">
                    <Eye size={12} /> Preview
                  </button>
                </div>
              ))}
            </div>

            {/* Template Preview Modal */}
            {previewTemplate && (
              <div className="mt-4 p-4 bg-slate-50 rounded-xl border border-slate-200">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-semibold text-slate-800">Preview: {previewTemplate}</h4>
                  <button onClick={() => { setPreviewTemplate(null); setPreviewData(null); setPreviewError(null); }}
                    className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
                </div>
                <div className="mb-3">
                  <label className="block text-xs font-medium text-slate-600 mb-1">Template Variables (JSON)</label>
                  <div className="flex gap-2">
                    <input type="text" value={previewVariables} onChange={(e) => setPreviewVariables(e.target.value)}
                      placeholder='{"customer_name": "John", "invoice_number": "INV-001"}'
                      className="flex-1 px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-brand/30/20" />
                    <button onClick={() => handlePreviewTemplate(previewTemplate)} disabled={previewLoading}
                      className="px-3 py-1.5 text-xs font-medium bg-slate-700 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors">
                      {previewLoading ? "Loading..." : "Apply"}
                    </button>
                  </div>
                </div>
                {previewLoading && <div className="animate-pulse h-32 bg-slate-200 rounded-lg" />}
                {previewError && <p className="text-xs text-red-600">{previewError}</p>}
                {previewData && !previewLoading && (
                  <div className="space-y-3">
                    <div className="flex gap-3 text-xs">
                      <div className="p-2 bg-white rounded border border-slate-100">
                        <span className="text-slate-400 block">Subject</span>
                        <span className="font-medium text-slate-700">{previewData.subject || "—"}</span>
                      </div>
                      {previewData.variables_found?.length > 0 && (
                        <div className="p-2 bg-white rounded border border-slate-100">
                          <span className="text-slate-400 block">Variables Found</span>
                          <span className="font-medium text-slate-700">{previewData.variables_found.join(", ")}</span>
                        </div>
                      )}
                      {previewData.variables_missing?.length > 0 && (
                        <div className="p-2 bg-amber-50 rounded border border-amber-200">
                          <span className="text-amber-600 block">Missing Variables</span>
                          <span className="font-medium text-amber-700">{previewData.variables_missing.join(", ")}</span>
                        </div>
                      )}
                    </div>
                    {previewData.rendered_html && (
                      <div className="border border-slate-200 rounded-lg overflow-hidden">
                        <div className="px-3 py-1.5 bg-slate-100 border-b border-slate-200 flex items-center gap-2">
                          <FileText size={12} className="text-slate-400" />
                          <span className="text-xs text-slate-500">Rendered HTML Preview</span>
                        </div>
                        <div className="p-3 bg-white max-h-64 overflow-auto text-xs"
                          dangerouslySetInnerHTML={{ __html: previewData.rendered_html }} />
                      </div>
                    )}
                    {previewData.html_content && !previewData.rendered_html && (
                      <div className="border border-slate-200 rounded-lg overflow-hidden">
                        <div className="px-3 py-1.5 bg-slate-100 border-b border-slate-200 flex items-center gap-2">
                          <FileText size={12} className="text-slate-400" />
                          <span className="text-xs text-slate-500">HTML Content</span>
                        </div>
                        <pre className="p-3 bg-white max-h-48 overflow-auto text-xs text-slate-600 font-mono whitespace-pre-wrap">{previewData.html_content}</pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </AdminCard>

      {/* Numbering Diagnostics */}
      <AdminCard title="Numbering Diagnostics" icon={Hash} action={
        <button onClick={loadNumberingDiag} disabled={numberingDiagLoading}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors">
          <RefreshCw size={12} className={numberingDiagLoading ? "animate-spin" : ""} />
          Load
        </button>
      }>
        {numberingDiagLoading ? (
          <div className="animate-pulse space-y-2">
            {[1,2,3].map((i) => <div key={i} className="h-10 bg-slate-100 rounded-lg" />)}
          </div>
        ) : numberingDiag?.error ? (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"><AlertCircle size={14} /> {numberingDiag.error}</div>
        ) : numberingDiag && numberingDiag.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50">
                  <th className="text-left px-3 py-2 font-semibold text-slate-500">Entity</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500">Prefix</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500">Format</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500">Reset</th>
                  <th className="text-center px-3 py-2 font-semibold text-slate-500">Valid</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500">Next #</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500">Warnings</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {numberingDiag.map((item, i) => (
                  <tr key={item.entity || i} className="hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium text-slate-800 capitalize">{item.entity}</td>
                    <td className="px-3 py-2 text-slate-600 font-mono">{item.prefix}</td>
                    <td className="px-3 py-2 text-slate-600 font-mono text-[11px]">{item.format}</td>
                    <td className="px-3 py-2 text-slate-600">{item.sequence_reset}</td>
                    <td className="px-3 py-2 text-center">
                      {item.valid ? (
                        <CheckCircle size={14} className="text-green-500 inline" />
                      ) : (
                        <AlertCircle size={14} className="text-red-500 inline" />
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600 font-mono">{item.next_number ?? "—"}</td>
                    <td className="px-3 py-2">
                      {item.warnings?.length > 0 ? (
                        <span className="text-amber-600 text-[11px]">{item.warnings.join("; ")}</span>
                      ) : item.suggestion ? (
                        <span className="text-blue-600 text-[11px]">{item.suggestion}</span>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-500 text-center">Click "Load" to check numbering configuration</div>
        )}
      </AdminCard>

      {/* Tax Diagnostics */}
      <AdminCard title="Tax Diagnostics" icon={Receipt} action={
        <button onClick={loadTaxDiag} disabled={taxDiagLoading}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors">
          <RefreshCw size={12} className={taxDiagLoading ? "animate-spin" : ""} />
          Load
        </button>
      }>
        {taxDiagLoading ? (
          <div className="animate-pulse space-y-2">
            {[1,2,3].map((i) => <div key={i} className="h-10 bg-slate-100 rounded-lg" />)}
          </div>
        ) : taxDiag?.error ? (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"><AlertCircle size={14} /> {taxDiag.error}</div>
        ) : taxDiag && taxDiag.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50">
                  <th className="text-left px-3 py-2 font-semibold text-slate-500">Field</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500">Value</th>
                  <th className="text-center px-3 py-2 font-semibold text-slate-500">Valid</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500">Suggestion</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500">Warnings</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {taxDiag.map((item, i) => (
                  <tr key={item.field || i} className="hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium text-slate-800">{item.field}</td>
                    <td className="px-3 py-2 text-slate-600 font-mono max-w-[120px] truncate" title={String(item.value ?? "")}>{String(item.value ?? "—")}</td>
                    <td className="px-3 py-2 text-center">
                      {item.valid ? (
                        <CheckCircle size={14} className="text-green-500 inline" />
                      ) : (
                        <AlertCircle size={14} className="text-red-500 inline" />
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600 text-[11px] max-w-[160px]">{item.suggestion || "—"}</td>
                    <td className="px-3 py-2">
                      {item.warnings?.length > 0 ? (
                        <span className="text-amber-600 text-[11px]">{item.warnings.join("; ")}</span>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-500 text-center">Click "Load" to check tax configuration</div>
        )}
      </AdminCard>

      {/* Exchange Rate Diagnostics */}
      <AdminCard title="Exchange Rate Diagnostics" icon={DollarSign} action={
        <button onClick={loadExchangeDiag} disabled={exchangeDiagLoading}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors">
          <RefreshCw size={12} className={exchangeDiagLoading ? "animate-spin" : ""} />
          Load
        </button>
      }>
        {exchangeDiagLoading ? (
          <div className="animate-pulse space-y-3">
            <div className="h-4 bg-slate-200 rounded w-1/3" />
            <div className="h-4 bg-slate-200 rounded w-1/2" />
            <div className="h-4 bg-slate-200 rounded w-2/3" />
          </div>
        ) : exchangeDiag?.error ? (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"><AlertCircle size={14} /> {exchangeDiag.error}</div>
        ) : exchangeDiag ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
              <div className="p-3 bg-slate-50 rounded-lg">
                <span className="text-slate-400 block">Provider</span>
                <span className="font-medium text-slate-800">{exchangeDiag.provider || "—"}</span>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg">
                <span className="text-slate-400 block">Base Currency</span>
                <span className="font-medium text-slate-800">{exchangeDiag.base_currency || "—"}</span>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg">
                <span className="text-slate-400 block">Last Refreshed</span>
                <span className="font-medium text-slate-800">
                  {exchangeDiag.last_refreshed ? new Date(exchangeDiag.last_refreshed).toLocaleDateString() : "—"}
                </span>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg">
                <span className="text-slate-400 block">Staleness</span>
                <span className="font-medium text-slate-800">
                  {exchangeDiag.staleness_hours != null ? `${exchangeDiag.staleness_hours}h` : "—"}
                </span>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg">
                <span className="text-slate-400 block">Cached Rates</span>
                <span className="font-medium text-slate-800">{exchangeDiag.cached_rates_count ?? "—"}</span>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg">
                <span className="text-slate-400 block">Status</span>
                <HealthStatusBadge status={exchangeDiag.valid ? "healthy" : "warning"} />
              </div>
            </div>
            {exchangeDiag.cached_rates && Object.keys(exchangeDiag.cached_rates).length > 0 && (
              <div>
                <p className="text-xs font-semibold text-slate-500 mb-2">Cached Rates</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(exchangeDiag.cached_rates).slice(0, 20).map(([code, rate]) => (
                    <span key={code} className="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-slate-100 rounded text-xs font-mono text-slate-700">
                      {code}: {rate}
                    </span>
                  ))}
                  {Object.keys(exchangeDiag.cached_rates).length > 20 && (
                    <span className="text-xs text-slate-400">+{Object.keys(exchangeDiag.cached_rates).length - 20} more</span>
                  )}
                </div>
              </div>
            )}
            {exchangeDiag.rate_warnings?.length > 0 && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                <p className="font-medium mb-1">Warnings:</p>
                <ul className="list-disc pl-4 space-y-1">
                  {exchangeDiag.rate_warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
            {exchangeDiag.inactive_currencies?.length > 0 && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-700">
                <span className="font-medium">Inactive Currencies: </span>
                {exchangeDiag.inactive_currencies.join(", ")}
              </div>
            )}
          </div>
        ) : (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-500 text-center">Click "Load" to check exchange rate health</div>
        )}
      </AdminCard>

      {/* Enhanced Validation */}
      <AdminCard title="Enhanced Validation" icon={FileJson} action={
        <button onClick={handleEnhancedValidation} disabled={enhancedValidationLoading}
          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-slate-700 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors">
          {enhancedValidationLoading ? <RefreshCw size={12} className="animate-spin" /> : <FileJson size={12} />}
          {enhancedValidationLoading ? "Running..." : "Run Full Validation"}
        </button>
      }>
        {enhancedValidationLoading ? (
          <div className="animate-pulse space-y-2">
            <div className="h-4 bg-slate-200 rounded w-1/2" />
            <div className="h-4 bg-slate-200 rounded w-1/3" />
          </div>
        ) : enhancedValidation?.error ? (
          <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"><AlertCircle size={14} /> {enhancedValidation.error}</div>
        ) : enhancedValidation ? (
          <div className="space-y-4">
            <div className={`flex items-center gap-2 text-sm font-medium ${enhancedValidation.valid ? "text-green-700" : "text-amber-700"}`}>
              {enhancedValidation.valid ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
              {enhancedValidation.valid ? "All checks passed" : "Configuration needs attention"}
            </div>
            {enhancedValidation.readiness_score !== undefined && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Readiness Score:</span>
                <span className={`text-sm font-bold ${enhancedValidation.readiness_score >= 80 ? "text-green-600" : enhancedValidation.readiness_score >= 50 ? "text-amber-600" : "text-red-600"}`}>
                  {enhancedValidation.readiness_score}%
                </span>
              </div>
            )}
            <div className="flex gap-4 text-xs">
              <span className="text-green-600">{(enhancedValidation.passed_count ?? enhancedValidation.passed ?? 0)} passed</span>
              {(enhancedValidation.warning_count ?? enhancedValidation.warnings ?? 0) > 0 && <span className="text-amber-600">{(enhancedValidation.warning_count ?? enhancedValidation.warnings)} warnings</span>}
              {(enhancedValidation.error_count ?? enhancedValidation.errors ?? 0) > 0 && <span className="text-red-600">{(enhancedValidation.error_count ?? enhancedValidation.errors)} errors</span>}
              {enhancedValidation.field_count && <span className="text-slate-500">{enhancedValidation.field_count} fields</span>}
            </div>
            {enhancedValidation.diagnostics && (
              <div className="bg-slate-50 rounded-xl p-4">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Diagnostic Breakdown</p>
                <pre className="text-xs text-slate-600 font-mono whitespace-pre-wrap max-h-48 overflow-auto">
                  {JSON.stringify(enhancedValidation.diagnostics, null, 2)}
                </pre>
              </div>
            )}
            {enhancedValidation.passed?.length > 0 && Array.isArray(enhancedValidation.passed) && (
              <div>
                <p className="text-xs font-medium text-green-700 mb-1">Passed Checks:</p>
                <div className="flex flex-wrap gap-1.5">
                  {enhancedValidation.passed.map((p, i) => (
                    <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-green-100 text-green-700">
                      <CheckCircle size={10} /> {p.field || p.label || p}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {enhancedValidation.warnings?.length > 0 && Array.isArray(enhancedValidation.warnings) && (
              <div>
                <p className="text-xs font-medium text-amber-700 mb-1">Warnings:</p>
                <ul className="list-disc pl-4 text-xs text-amber-600 space-y-0.5">
                  {enhancedValidation.warnings.map((w, i) => (
                    <li key={i}>{w.message || (typeof w === "string" ? w : `${w.field}: ${w.message}`)}</li>
                  ))}
                </ul>
              </div>
            )}
            {enhancedValidation.errors?.length > 0 && Array.isArray(enhancedValidation.errors) && (
              <div>
                <p className="text-xs font-medium text-red-700 mb-1">Errors:</p>
                <ul className="list-disc pl-4 text-xs text-red-600 space-y-0.5">
                  {enhancedValidation.errors.map((e, i) => (
                    <li key={i}>{e.message || (typeof e === "string" ? e : `${e.field}: ${e.message}`)}</li>
                  ))}
                </ul>
              </div>
            )}
            {enhancedValidation.validated_at && (
              <p className="text-xs text-slate-400">Validated at: {new Date(enhancedValidation.validated_at).toLocaleString()}</p>
            )}
          </div>
        ) : (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-500 text-center flex items-center justify-center gap-2">
            <FileJson size={14} /> Click "Run Full Validation" for a comprehensive configuration check
          </div>
        )}
      </AdminCard>
    </div>
  );
}
