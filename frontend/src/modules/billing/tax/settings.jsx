import { useState, useEffect } from "react";
import { Save, RefreshCw, AlertCircle, CheckCircle, Percent, DollarSign, Globe, Receipt, Calendar, ToggleLeft, Hash } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { settingsApi, taxApi } from "../../../service/billingService";

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

export default function TaxSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [taxRates, setTaxRates] = useState([]);

  const [form, setForm] = useState({
    default_tax_rate_id: "",
    default_tax_rate_value: "",
    auto_calculation: "enabled",
    rounding_rule: "nearest",
    default_jurisdiction: "",
    tax_number: "",
    fiscal_year_start: "",
    filing_frequency: "quarterly",
    late_filing_penalty: "",
    tax_inclusive_pricing: "exclusive",
    requires_tax_id: "no",
    exemption_certificate_required: "no",
    tax_on_shipping: "no",
  });

  const [original, setOriginal] = useState({});
  const hasChanges = Object.keys(form).some((key) => form[key] !== original[key]);

  useEffect(() => { fetchSettings(); }, []);

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

      // Extract unmapped preference fields from the tax_profiles JSON sentinel entry.
      const profiles = settings.tax_profiles || [];
      const savedPrefs = profiles.find((p) => p?.type === "preferences")?.data || {};

      // Map backend fields to form fields.
      // Direct columns: default_tax_rate_id, tax_number, fiscal_year_start
      // Enum columns: tax_rounding_method → rounding_rule, is_tax_inclusive_default → tax_inclusive_pricing
      // JSON column (preferences): auto_calculation, filing_frequency, late_filing_penalty,
      //                            requires_tax_id, exemption_certificate_required, tax_on_shipping
      const values = {
        default_tax_rate_id: settings.default_tax_rate_id || "",
        default_tax_rate_value: "",
        auto_calculation: savedPrefs.auto_calculation || "enabled",
        rounding_rule: settings.tax_rounding_method || savedPrefs.rounding_rule || "nearest",
        default_jurisdiction: savedPrefs.default_jurisdiction || "",
        tax_number: settings.tax_number || "",
        fiscal_year_start: settings.fiscal_year_start || "",
        filing_frequency: savedPrefs.filing_frequency || "quarterly",
        late_filing_penalty: savedPrefs.late_filing_penalty || "",
        tax_inclusive_pricing: settings.is_tax_inclusive_default ? "inclusive" : (savedPrefs.tax_inclusive_pricing || "exclusive"),
        requires_tax_id: savedPrefs.requires_tax_id || "no",
        exemption_certificate_required: savedPrefs.exemption_certificate_required || "no",
        tax_on_shipping: savedPrefs.tax_on_shipping || "no",
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

      // Map form fields to the correct BillingConfigurationUpdate schema fields.
      // Fields with direct DB columns go as top-level keys.
      // Unmapped frontend-only toggles go into tax_preferences (merged server-side into tax_profiles JSON).
      await settingsApi.update({
        default_tax_rate_id: form.default_tax_rate_id ? Number(form.default_tax_rate_id) : null,
        tax_rounding_method: form.rounding_rule || null,
        is_tax_inclusive_default: form.tax_inclusive_pricing === "inclusive",
        tax_number: form.tax_number || null,
        fiscal_year_start: form.fiscal_year_start || null,
        tax_preferences: {
          auto_calculation: form.auto_calculation,
          default_jurisdiction: form.default_jurisdiction,
          filing_frequency: form.filing_frequency,
          late_filing_penalty: form.late_filing_penalty,
          requires_tax_id: form.requires_tax_id,
          exemption_certificate_required: form.exemption_certificate_required,
          tax_on_shipping: form.tax_on_shipping,
        },
      });

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
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  if (loading) {
    return (
      <HRPage title="Tax Settings" subtitle="Configure tax module preferences">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      </HRPage>
    );
  }

  const selectedRate = taxRates.find((r) => String(r.id) === String(form.default_tax_rate_id));
  // Only offer active rates in the default-rate dropdown
  const activeRates = taxRates.filter((r) => r.is_active !== false);

  return (
    <HRPage title="Tax Settings" subtitle="Configure tax module preferences">

      <div className="flex items-center justify-between mb-6">
        <div />
        <div className="flex items-center gap-2">
          {saved && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 bg-emerald-50 rounded-lg">
              <CheckCircle className="h-4 w-4" /> Saved
            </span>
          )}
          <button onClick={fetchSettings}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button onClick={handleSave} disabled={!hasChanges || saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
            {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Save className="h-4 w-4" />}
            Save Changes
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="space-y-6">
        <SettingsField label="Default Tax Rate" icon={Percent} description="Default tax rate applied to invoices and products">
          <select value={form.default_tax_rate_id} onChange={(e) => {
            const rate = taxRates.find((r) => String(r.id) === e.target.value);
            updateField("default_tax_rate_id", e.target.value);
            updateField("default_tax_rate_value", rate ? rate.rate : "");
          }}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="">None</option>
            {activeRates.map((r) => {
              const rateVal = parseFloat(r.rate || 0);
              const displayRate = rateVal > 0 && rateVal <= 1 ? rateVal * 100 : rateVal;
              return <option key={r.id} value={r.id}>{r.name} ({displayRate.toFixed(2)}%)</option>;
            })}
          </select>
          {selectedRate && (() => {
            const rateVal = parseFloat(selectedRate.rate || 0);
            const displayRate = rateVal > 0 && rateVal <= 1 ? rateVal * 100 : rateVal;
            return <p className="mt-1 text-xs text-slate-400">Rate: {displayRate.toFixed(2)}% — {selectedRate.jurisdiction || "No jurisdiction"}</p>;
          })()}
        </SettingsField>

        <SettingsField label="Default Jurisdiction" icon={Globe} description="Default jurisdiction/region for tax calculations">
          <select value={form.default_jurisdiction} onChange={(e) => updateField("default_jurisdiction", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="">None</option>
            {[...new Set(taxRates.map((r) => r.jurisdiction).filter(Boolean))].map((j) => (
              <option key={j} value={j}>{j}</option>
            ))}
          </select>
        </SettingsField>

        <SettingsField label="Auto Calculation" icon={ToggleLeft} description="Automatically calculate tax on invoices and transactions">
          <select value={form.auto_calculation} onChange={(e) => updateField("auto_calculation", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Rounding Rule" icon={DollarSign} description="How tax amounts are rounded during calculation">
          <select value={form.rounding_rule} onChange={(e) => updateField("rounding_rule", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="nearest">Nearest Cent</option>
            <option value="up">Round Up</option>
            <option value="down">Round Down</option>
            <option value="half_up">Half Round Up</option>
            <option value="half_down">Half Round Down</option>
          </select>
        </SettingsField>

        <SettingsField label="Tax Inclusive Pricing" icon={DollarSign} description="Whether prices shown include tax by default">
          <select value={form.tax_inclusive_pricing} onChange={(e) => updateField("tax_inclusive_pricing", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="exclusive">Exclusive (tax added at checkout)</option>
            <option value="inclusive">Inclusive (tax included in price)</option>
          </select>
        </SettingsField>

        <SettingsField label="Tax on Shipping" icon={DollarSign} description="Apply tax to shipping charges">
          <select value={form.tax_on_shipping} onChange={(e) => updateField("tax_on_shipping", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="no">Do not tax shipping</option>
            <option value="yes">Tax shipping charges</option>
          </select>
        </SettingsField>

        <SettingsField label="Tax Number / VAT ID" icon={Receipt} description="Your business tax identification number">
          <input type="text" value={form.tax_number} onChange={(e) => updateField("tax_number", e.target.value)}
            placeholder="e.g. VAT-GB-123456789"
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Fiscal Year Start" icon={Calendar} description="Start month of your fiscal year for tax reporting">
          <select value={form.fiscal_year_start} onChange={(e) => updateField("fiscal_year_start", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="">Select month</option>
            {["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].map((m) => (
              <option key={m} value={m.toLowerCase()}>{m}</option>
            ))}
          </select>
        </SettingsField>

        <SettingsField label="Filing Frequency" icon={Calendar} description="How often tax returns are filed">
          <select value={form.filing_frequency} onChange={(e) => updateField("filing_frequency", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="semi_annually">Semi-Annually</option>
            <option value="annually">Annually</option>
          </select>
        </SettingsField>

        <SettingsField label="Late Filing Penalty" icon={Percent} description="Percentage penalty applied for late tax filings">
          <input type="number" min="0" max="100" step="0.1" value={form.late_filing_penalty} onChange={(e) => updateField("late_filing_penalty", e.target.value)}
            placeholder="e.g. 5 for 5%"
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Require Tax ID on Invoices" icon={Hash} description="Require customers to provide tax ID for invoicing">
          <select value={form.requires_tax_id} onChange={(e) => updateField("requires_tax_id", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="no">Optional</option>
            <option value="yes">Required</option>
          </select>
        </SettingsField>

        <SettingsField label="Exemption Certificate Required" icon={Receipt} description="Require exemption certificate for tax-exempt customers">
          <select value={form.exemption_certificate_required} onChange={(e) => updateField("exemption_certificate_required", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="no">Not required</option>
            <option value="yes">Required</option>
          </select>
        </SettingsField>
      </div>
    </HRPage>
  );
}
