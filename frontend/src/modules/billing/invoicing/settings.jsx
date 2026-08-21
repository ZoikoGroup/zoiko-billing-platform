import { useState, useEffect, useRef } from "react";
import { Save, RefreshCw, AlertCircle, CheckCircle, Hash, DollarSign, Percent, Mail, Phone, FileText, ToggleLeft, Calendar, Globe, Image, Settings } from "lucide-react";
import { PageHeader, Button } from "../../../components/billing-ui";

const inputClass =
  "block w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30";
import { settingsApi, taxApi } from "../../../service/billingService";
import { getCurrencySelectOptions } from "../../../utils/currency";
import { useTerminology } from "../utils/TerminologyContext";

const TERMINOLOGY_OPTIONS = [
  { value: "customer", label: "Customer" },
  { value: "client", label: "Client" },
  { value: "patient", label: "Patient" },
  { value: "member", label: "Member" },
  { value: "tenant", label: "Tenant" },
  { value: "subscriber", label: "Subscriber" },
];

// DEPRECATED: This component uses settingsApi which aliases to BillingConfiguration.
// Prefer the master settings at billing/dashboard/settings.jsx for all billing config.
// This page is retained for backward compatibility with existing invoice-specific routing.

function SettingsField({ label, icon: Icon, children, description }) {
  return (
    <div className="bg-white border border-slate-200 rounded-3xl p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="h-10 w-10 rounded-xl bg-gradient-to-r from-brand to-brand-hover text-white flex items-center justify-center">
          <Icon size={20} />
        </div>
        <div>
          <h3 className="text-base font-semibold text-slate-800">{label}</h3>
          {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

const CURRENCY_OPTIONS = getCurrencySelectOptions();

export default function InvoiceSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const timerRef = useRef(null);
  const [taxRates, setTaxRates] = useState([]);
  const { singular: entityLabel, pluralLower: entityPluralLower } = useTerminology();

  const [form, setForm] = useState({
    relationship_terminology: "customer",
    default_currency: "USD",
    fiscal_year_start: "january",
    default_payment_terms: "net_30",
    invoice_prefix: "INV-",
    quote_prefix: "QTE-",
    auto_generate_invoice_number: true,
    invoice_number_format: "{PREFIX}{NUMBER}",
    default_tax_rate_id: "",
    auto_apply_credits: true,
    auto_send_invoices: false,
    auto_send_receipts: false,
    auto_dunning: false,
    dunning_level_count: "3",
    payment_reminder_days_before: "7",
    late_payment_fee_percentage: "",
    late_payment_fee_flat: "",
    enable_revenue_recognition: false,
    enable_multi_currency: false,
    billing_email: "",
    billing_phone: "",
    terms_and_conditions: "",
    logo_url: "",
    // Exchange Rates (Phase 1)
    exchange_rate_usd: "",
    exchange_rate_inr: "",
    exchange_rate_gbp: "",
    exchange_rate_eur: "",
    exchange_rate_aed: "",
  });

const [original, setOriginal] = useState({});
  
  const hasChanges = Object.keys(form).some((key) => form[key] !== original[key]);
  
  const validationError = form.invoice_number_format.includes("{NUMBER}")
    ? ""
    : "Invoice number format must include {NUMBER}.";
  
  useEffect(() => { 
    fetchSettings(); 
  }, []);

  async function fetchSettings() {
    try {
      setLoading(true);
      setError(null);
      setSaved(false);
      const [settingsRes, taxRes] = await Promise.allSettled([
        settingsApi.get(),
        taxApi.list({ per_page: 100 }),
      ]);
      let settings = {};
      if (settingsRes.status === "fulfilled") settings = settingsRes.value || {};
      if (taxRes.status === "fulfilled") {
        const data = taxRes.value;
        setTaxRates(Array.isArray(data) ? data : data?.items || data?.data || []);
      }

      const values = {
        relationship_terminology: settings.relationship_terminology || "customer",
        default_currency: settings.default_currency,
        fiscal_year_start: settings.fiscal_year_start || "january",
        default_payment_terms: settings.default_payment_terms || "net_30",
        invoice_prefix: settings.invoice_prefix || "INV-",
        quote_prefix: settings.quote_prefix || "QTE-",
        auto_generate_invoice_number: settings.auto_generate_invoice_number ?? true,
        invoice_number_format: settings.invoice_number_format || "{PREFIX}{NUMBER}",
        default_tax_rate_id: settings.default_tax_rate_id || "",
        auto_apply_credits: settings.auto_apply_credits ?? true,
        auto_send_invoices: settings.auto_send_invoices ?? false,
        auto_send_receipts: settings.auto_send_receipts ?? false,
        auto_dunning: settings.auto_dunning ?? false,
        dunning_level_count: settings.dunning_level_count || "3",
        payment_reminder_days_before: settings.payment_reminder_days_before || "7",
        late_payment_fee_percentage: settings.late_payment_fee_percentage || "",
        late_payment_fee_flat: settings.late_payment_fee_flat || "",
        enable_revenue_recognition: settings.enable_revenue_recognition ?? false,
        enable_multi_currency: settings.enable_multi_currency ?? false,
        billing_email: settings.billing_email || "",
        billing_phone: settings.billing_phone || "",
        terms_and_conditions: settings.terms_and_conditions || "",
        logo_url: settings.logo_url || "",
        // Exchange Rates (Phase 1)
        exchange_rate_usd: settings.exchange_rate_usd || "",
        exchange_rate_inr: settings.exchange_rate_inr || "",
        exchange_rate_gbp: settings.exchange_rate_gbp || "",
        exchange_rate_eur: settings.exchange_rate_eur || "",
        exchange_rate_aed: settings.exchange_rate_aed || "",
      };
      setForm(values);
      setOriginal({ ...values });
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    try {
      setSaving(true);
      setError(null);
      setSaved(false);
      await settingsApi.update(form);
      setOriginal({ ...form });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  function updateField(key, value) {
    setForm((prev) => {
      const updated = { ...prev, [key]: value };
      return updated;
    });
    setSaved(false);
  }

  if (loading) {
    return (
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          icon={Settings}
          title="Invoice Settings"
          description="Configure invoice module preferences"
          crumbs={[{ label: "Billing" }, { label: "Settings" }]}
        />
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-500" />
        </div>
      </div>
    );
  }

  const numberingPreview = form.invoice_number_format
    .replace("{PREFIX}", form.invoice_prefix)
    .replace("{NUMBER}", "0001");

  return (
    <div className="px-4 py-6 sm:px-6">
      <PageHeader
        icon={Settings}
        title="Invoice Settings"
        description="Configure invoice module preferences"
        crumbs={[{ label: "Billing" }, { label: "Settings" }]}
        actions={[
          saved && (
            <span key="saved" className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 bg-emerald-50 rounded-lg">
              <CheckCircle className="h-4 w-4" /> Saved
            </span>
          ),
          <Button key="refresh" variant="secondary" size="md" onClick={fetchSettings} icon={RefreshCw}>
            Refresh
          </Button>,
          <Button key="save" variant="primary" size="md" onClick={handleSave} disabled={!hasChanges || saving || Boolean(validationError)} loading={saving} icon={Save}>
            Save Changes
          </Button>,
        ]}
      />

      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}
      {validationError && (
        <div className="mb-6 p-4 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {validationError}
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:grid-cols-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Number Preview</p>
          <p className="mt-1 text-lg font-bold text-slate-900">{numberingPreview}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Currency</p>
          <p className="mt-1 text-lg font-bold text-slate-900">{form.default_currency}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Payment Terms</p>
          <p className="mt-1 text-lg font-bold capitalize text-slate-900">{form.default_payment_terms.replace(/_/g, " ")}</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Automation</p>
          <p className="mt-1 text-lg font-bold text-slate-900">{form.auto_generate_invoice_number ? "Numbering on" : "Manual numbers"}</p>
        </div>
      </div>

      <div className="space-y-6">
        <SettingsField label="Entity Terminology" icon={Globe} description={`Customize what ${entityLabel}s are called throughout the system`}>
          <select value={form.relationship_terminology} onChange={(e) => updateField("relationship_terminology", e.target.value)}
            className={`${inputClass} max-w-xs`}>
            {TERMINOLOGY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </SettingsField>

        <SettingsField label="Default Currency" icon={Globe} description="Default currency for invoices and transactions">
          <select value={form.default_currency} onChange={(e) => updateField("default_currency", e.target.value)}
            className={`${inputClass} max-w-xs`}>
            {CURRENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </SettingsField>

        <SettingsField label="Invoice Numbering Prefix" icon={Hash} description="Prefix used when auto-generating invoice numbers">
          <input type="text" value={form.invoice_prefix} onChange={(e) => updateField("invoice_prefix", e.target.value)}
            className={`${inputClass} max-w-xs`} />
        </SettingsField>

        <SettingsField label="Invoice Numbering Format" icon={Hash} description="Invoice number format. Use {PREFIX} and {NUMBER} as placeholders">
          <input type="text" value={form.invoice_number_format} onChange={(e) => updateField("invoice_number_format", e.target.value)}
            className={`${inputClass} max-w-xs`} />
          <p className="mt-1 text-xs text-slate-400">Preview: {numberingPreview}</p>
        </SettingsField>

        <SettingsField label="Auto-Generate Invoice Numbers" icon={ToggleLeft} description="Automatically generate invoice numbers using the configured prefix/format">
          <select value={String(form.auto_generate_invoice_number)} onChange={(e) => updateField("auto_generate_invoice_number", e.target.value === "true")}
            className={`${inputClass} max-w-xs`}>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Payment Terms" icon={DollarSign} description="Default payment terms assigned to new invoices">
          <select value={form.default_payment_terms} onChange={(e) => updateField("default_payment_terms", e.target.value)}
            className={`${inputClass} max-w-xs`}>
            <option value="due_on_receipt">Due on Receipt</option>
            <option value="net_15">Net 15</option>
            <option value="net_30">Net 30</option>
            <option value="net_45">Net 45</option>
            <option value="net_60">Net 60</option>
            <option value="net_90">Net 90</option>
            <option value="custom">Custom</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Tax Rate" icon={Percent} description="Default tax rate applied to invoices">
          <select value={form.default_tax_rate_id} onChange={(e) => updateField("default_tax_rate_id", e.target.value)}
            className={`${inputClass} max-w-xs`}>
            <option value="">None</option>
            {taxRates.filter((r) => r.status === "active").map((r) => (
              <option key={r.id} value={r.id}>{r.name} ({(parseFloat(r.rate || 0) * 100).toFixed(2)}%)</option>
            ))}
          </select>
        </SettingsField>

        <SettingsField label="Auto-Apply Credits" icon={ToggleLeft} description="Automatically apply available credit notes to new invoices">
          <select value={String(form.auto_apply_credits)} onChange={(e) => updateField("auto_apply_credits", e.target.value === "true")}
            className={`${inputClass} max-w-xs`}>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Auto-Send Invoices" icon={ToggleLeft} description={`Automatically send invoices to ${entityPluralLower} when finalized`}>
          <select value={String(form.auto_send_invoices)} onChange={(e) => updateField("auto_send_invoices", e.target.value === "true")}
            className={`${inputClass} max-w-xs`}>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Auto-Send Receipts" icon={ToggleLeft} description={`Automatically send payment receipts to ${entityPluralLower}`}>
          <select value={String(form.auto_send_receipts)} onChange={(e) => updateField("auto_send_receipts", e.target.value === "true")}
            className={`${inputClass} max-w-xs`}>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Payment Reminder Days Before Due" icon={Calendar} description="Number of days before due date to send payment reminders">
          <input type="number" min="1" value={form.payment_reminder_days_before} onChange={(e) => updateField("payment_reminder_days_before", e.target.value)}
            className={`${inputClass} max-w-xs`} />
        </SettingsField>

        <SettingsField label="Late Payment Fee (%)" icon={Percent} description="Percentage fee applied to overdue invoices">
          <input type="number" min="0" max="100" step="0.1" value={form.late_payment_fee_percentage} onChange={(e) => updateField("late_payment_fee_percentage", e.target.value)}
            placeholder="e.g. 1.5"
            className={`${inputClass} max-w-xs`} />
        </SettingsField>

        <SettingsField label="Late Payment Flat Fee" icon={DollarSign} description="Flat fee applied to overdue invoices">
          <input type="number" min="0" step="0.01" value={form.late_payment_fee_flat} onChange={(e) => updateField("late_payment_fee_flat", e.target.value)}
            placeholder="e.g. 25.00"
            className={`${inputClass} max-w-xs`} />
        </SettingsField>

        <SettingsField label="Auto Dunning" icon={ToggleLeft} description="Automatically escalate dunning process for overdue invoices">
          <select value={String(form.auto_dunning)} onChange={(e) => updateField("auto_dunning", e.target.value === "true")}
            className={`${inputClass} max-w-xs`}>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Dunning Level Count" icon={Hash} description="Number of dunning levels before escalation">
          <input type="number" min="1" max="10" value={form.dunning_level_count} onChange={(e) => updateField("dunning_level_count", e.target.value)}
            className={`${inputClass} max-w-xs`} />
        </SettingsField>

        <SettingsField label="Enable Revenue Recognition" icon={ToggleLeft} description="Enable ASC 606 revenue recognition schedules">
          <select value={String(form.enable_revenue_recognition)} onChange={(e) => updateField("enable_revenue_recognition", e.target.value === "true")}
            className={`${inputClass} max-w-xs`}>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Enable Multi-Currency" icon={Globe} description="Allow invoices and transactions in multiple currencies">
          <select value={String(form.enable_multi_currency)} onChange={(e) => updateField("enable_multi_currency", e.target.value === "true")}
            className={`${inputClass} max-w-xs`}>
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        {form.enable_multi_currency && (
          <>
            <SettingsField label="Exchange Rate: USD" icon={DollarSign} description="1 USD = X home currency (e.g., 1 USD = 83 INR)">
              <input type="number" min="0" step="0.000001" value={form.exchange_rate_usd} onChange={(e) => updateField("exchange_rate_usd", e.target.value)}
                placeholder="e.g. 1.000000"
                className={`${inputClass} max-w-xs`} />
            </SettingsField>

            <SettingsField label="Exchange Rate: INR" icon={DollarSign} description="1 INR = X home currency (e.g., 1 INR = 0.012 USD)">
              <input type="number" min="0" step="0.000001" value={form.exchange_rate_inr} onChange={(e) => updateField("exchange_rate_inr", e.target.value)}
                placeholder="e.g. 0.012000"
                className={`${inputClass} max-w-xs`} />
            </SettingsField>

            <SettingsField label="Exchange Rate: GBP" icon={DollarSign} description="1 GBP = X home currency (e.g., 1 GBP = 1.25 USD)">
              <input type="number" min="0" step="0.000001" value={form.exchange_rate_gbp} onChange={(e) => updateField("exchange_rate_gbp", e.target.value)}
                placeholder="e.g. 1.250000"
                className={`${inputClass} max-w-xs`} />
            </SettingsField>

            <SettingsField label="Exchange Rate: EUR" icon={DollarSign} description="1 EUR = X home currency (e.g., 1 EUR = 1.08 USD)">
              <input type="number" min="0" step="0.000001" value={form.exchange_rate_eur} onChange={(e) => updateField("exchange_rate_eur", e.target.value)}
                placeholder="e.g. 1.080000"
                className={`${inputClass} max-w-xs`} />
            </SettingsField>

            <SettingsField label="Exchange Rate: AED" icon={DollarSign} description="1 AED = X home currency (e.g., 1 AED = 0.27 USD)">
              <input type="number" min="0" step="0.000001" value={form.exchange_rate_aed} onChange={(e) => updateField("exchange_rate_aed", e.target.value)}
                placeholder="e.g. 0.270000"
                className={`${inputClass} max-w-xs`} />
            </SettingsField>
          </>
        )}

        <SettingsField label="Fiscal Year Start" icon={Calendar} description="Start month of your fiscal year for revenue recognition">
          <select value={form.fiscal_year_start} onChange={(e) => updateField("fiscal_year_start", e.target.value)}
            className={`${inputClass} max-w-xs`}>
            {["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].map((m) => (
              <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>
            ))}
          </select>
        </SettingsField>

        <SettingsField label="Billing Email" icon={Mail} description="Email address displayed on invoices for billing inquiries">
          <input type="email" value={form.billing_email} onChange={(e) => updateField("billing_email", e.target.value)}
            placeholder="billing@example.com"
            className={`${inputClass} max-w-xs`} />
        </SettingsField>

        <SettingsField label="Billing Phone" icon={Phone} description="Phone number displayed on invoices for billing inquiries">
          <input type="text" value={form.billing_phone} onChange={(e) => updateField("billing_phone", e.target.value)}
            placeholder="+1 (555) 000-0000"
            className={`${inputClass} max-w-xs`} />
        </SettingsField>

        <SettingsField label="Terms & Conditions" icon={FileText} description="Default terms and conditions printed on invoices">
          <textarea value={form.terms_and_conditions} onChange={(e) => updateField("terms_and_conditions", e.target.value)}
            rows={3} placeholder="Payment is due within 30 days..."
            className={inputClass} />
        </SettingsField>

        <SettingsField label="Logo URL" icon={Image} description="URL to company logo displayed on invoices">
          <input type="url" value={form.logo_url} onChange={(e) => updateField("logo_url", e.target.value)}
            placeholder="https://example.com/logo.png"
            className={`${inputClass} max-w-xs`} />
          {form.logo_url && <p className="mt-1 text-xs text-slate-400 truncate max-w-xs">{form.logo_url}</p>}
        </SettingsField>
      </div>
    </div>
  );
}
