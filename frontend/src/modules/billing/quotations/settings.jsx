import { useState, useEffect } from "react";
import {
  Save, RefreshCw, AlertCircle, CheckCircle, Hash, DollarSign, FileText, Image, Loader2,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { settingsApi } from "../../../service/billingService";
import { getCurrencySelectOptions } from "../../../utils/currency";
import { useTerminology } from "../utils/TerminologyContext";

function SettingsField({ label, icon: Icon, children, description }) {
  return (
    <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
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

export default function QuotationSettingsPage() {
  const { singular } = useTerminology();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const [form, setForm] = useState({
    quote_prefix: "QOT-",
    default_currency: "USD",
    default_terms_and_conditions: "",
    quote_logo_url: "",
  });

  const [original, setOriginal] = useState({});
  const hasChanges = Object.keys(form).some((key) => form[key] !== original[key]);

  useEffect(() => { fetchSettings(); }, []);

  async function fetchSettings() {
    try {
      setLoading(true);
      setError(null);
      setSaved(false);
      const settingsRes = await settingsApi.get();
      const settings = settingsRes || {};

      const values = {
        quote_prefix: settings.default_quote_prefix || "QOT-",
        default_currency: settings.default_currency || "USD",
        default_terms_and_conditions: settings.terms_and_conditions || "",
        quote_logo_url: settings.logo_url || "",
      };
      setForm(values);
      setOriginal({ ...values });
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load settings");
    } finally { setLoading(false); }
  }

  async function saveSettings() {
    if (!hasChanges && !saving) return;
    try {
      setSaving(true);
      setError(null);
      const payload = {
        default_quote_prefix: form.quote_prefix,
        default_currency: form.default_currency,
        terms_and_conditions: form.default_terms_and_conditions || undefined,
        logo_url: form.quote_logo_url || undefined,
      };
      await settingsApi.update(payload);
      setOriginal({ ...form });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to save settings");
    } finally { setSaving(false); }
  }

  function updateField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  if (loading) {
    return (
      <HRPage title="Quotation Settings" subtitle="Loading settings...">
        <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-brand-600" /></div>
      </HRPage>
    );
  }

  return (
    <HRPage title="Quotation Settings" subtitle="Configure quotation defaults and behavior">

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
          <button onClick={saveSettings} disabled={!hasChanges || saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
            {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Save className="h-4 w-4" />}
            Save Changes
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2" role="alert">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="space-y-6">
        <SettingsField
          label="Quote Number Prefix"
          icon={Hash}
          description="Prefix for auto-generated quotation numbers"
        >
          <input
            type="text"
            value={form.quote_prefix}
            onChange={(e) => updateField("quote_prefix", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </SettingsField>

        <SettingsField
          label="Default Currency"
          icon={DollarSign}
          description="Default currency for new quotations"
        >
          <select value={form.default_currency} onChange={(e) => updateField("default_currency", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            {getCurrencySelectOptions().map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </SettingsField>

        <SettingsField
          label="Default Terms & Conditions"
          icon={FileText}
          description="Standard terms shown on all quotations"
        >
          <textarea
            value={form.default_terms_and_conditions}
            onChange={(e) => updateField("default_terms_and_conditions", e.target.value)}
            rows={4}
            placeholder="Payment terms, delivery terms, validity..."
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </SettingsField>

        <SettingsField
          label="Quotation Logo"
          icon={Image}
          description="Logo URL displayed on quotation documents (optional)"
        >
          <input
            type="url"
            value={form.quote_logo_url}
            onChange={(e) => updateField("quote_logo_url", e.target.value)}
            placeholder="https://example.com/logo.png"
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </SettingsField>

        <div className="bg-slate-50 border border-slate-200 rounded-3xl p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-xl bg-amber-100 text-amber-600 flex items-center justify-center">
              <AlertCircle size={20} />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-800">Advanced Settings (Not Yet Implemented)</h3>
              <p className="text-xs text-slate-500 mt-0.5">The following settings require backend support and are currently disabled:</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-slate-500">
            <div className="bg-white p-3 rounded-lg border border-slate-200">
              <p className="font-medium text-slate-600">Auto-Approval Workflow</p>
              <p className="mt-1">Require approval before sending quotations</p>
            </div>
            <div className="bg-white p-3 rounded-lg border border-slate-200">
              <p className="font-medium text-slate-600">Discount Approval Threshold</p>
              <p className="mt-1">Require approval for discounts above X%</p>
            </div>
            <div className="bg-white p-3 rounded-lg border border-slate-200">
              <p className="font-medium text-slate-600">{singular} Approval Required</p>
              <p className="mt-1">Require {singular.toLowerCase()} acceptance before conversion</p>
            </div>
            <div className="bg-white p-3 rounded-lg border border-slate-200">
              <p className="font-medium text-slate-600">Version History</p>
              <p className="mt-1">Track quotation revisions automatically</p>
            </div>
            <div className="bg-white p-3 rounded-lg border border-slate-200">
              <p className="font-medium text-slate-600">Expiry Reminder Days</p>
              <p className="mt-1">Days before expiry to send reminders</p>
            </div>
            <div className="bg-white p-3 rounded-lg border border-slate-200">
              <p className="font-medium text-slate-600">Quote Number Format</p>
              <p className="mt-1">{'Custom format like QT-{YEAR}-{NUMBER}'}</p>
            </div>
          </div>
        </div>

      </div>
    </HRPage>
  );
}