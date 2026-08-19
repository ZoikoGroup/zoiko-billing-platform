import { useState, useEffect } from "react";
import { Save, RefreshCw, AlertCircle, CheckCircle, Hash, ToggleLeft, Calendar, DollarSign, FileText, Image, Users } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { settingsApi } from "../../../service/billingService";
import { useTerminology } from "../utils/TerminologyContext";

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

export default function ContractSettingsPage() {
  const { singular } = useTerminology();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const [form, setForm] = useState({
    default_contract_prefix: "CTR-",
    contract_number_format: "{PREFIX}{NUMBER}",
    auto_generate_contract_number: true,
    default_notice_period_days: "30",
    default_contract_term_days: "365",
    auto_renew_default: false,
    default_renewal_term_days: "365",
    enable_auto_renewal: true,
    enable_retainers: false,
    default_terms_and_conditions: "",
    require_customer_signature: false,
    require_org_signature: true,
    contract_logo_url: "",
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
        default_contract_prefix: settings.default_contract_prefix || "CTR-",
        contract_number_format: settings.contract_number_format || "{PREFIX}{NUMBER}",
        auto_generate_contract_number: settings.auto_generate_contract_number ?? true,
        default_notice_period_days: settings.default_notice_period_days || "30",
        default_contract_term_days: settings.default_contract_term_days || "365",
        auto_renew_default: settings.auto_renew_default ?? false,
        default_renewal_term_days: settings.default_renewal_term_days || "365",
        enable_auto_renewal: settings.enable_auto_renewal ?? true,
        enable_retainers: settings.enable_retainers ?? false,
        default_terms_and_conditions: settings.default_terms_and_conditions || "",
        require_customer_signature: settings.require_customer_signature ?? false,
        require_org_signature: settings.require_org_signature ?? true,
        contract_logo_url: settings.contract_logo_url || "",
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
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }

  if (loading) {
    return (
      <HRPage title="Contract Settings" subtitle="Configure contract module preferences">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      </HRPage>
    );
  }

  const numberingPreview = form.contract_number_format
    .replace("{PREFIX}", form.default_contract_prefix)
    .replace("{NUMBER}", "0001");

  return (
    <HRPage title="Contract Settings" subtitle="Configure contract module preferences">
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
        <SettingsField label="Contract Numbering Prefix" icon={Hash} description="Prefix used when auto-generating contract numbers">
          <input type="text" value={form.default_contract_prefix} onChange={(e) => updateField("default_contract_prefix", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Contract Numbering Format" icon={Hash} description="Contract number format. Use {PREFIX} and {NUMBER} as placeholders">
          <input type="text" value={form.contract_number_format} onChange={(e) => updateField("contract_number_format", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          <p className="mt-1 text-xs text-slate-400">Preview: {numberingPreview}</p>
        </SettingsField>

        <SettingsField label="Auto-Generate Contract Numbers" icon={ToggleLeft} description="Automatically generate contract numbers using the configured prefix/format">
          <select value={String(form.auto_generate_contract_number)} onChange={(e) => updateField("auto_generate_contract_number", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Notice Period (Days)" icon={Calendar} description="Default notice period required for contract termination">
          <input type="number" min="1" value={form.default_notice_period_days} onChange={(e) => updateField("default_notice_period_days", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Default Contract Term (Days)" icon={Calendar} description="Default duration for new contracts in days">
          <input type="number" min="1" value={form.default_contract_term_days} onChange={(e) => updateField("default_contract_term_days", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Default Auto-Renewal" icon={ToggleLeft} description="Whether new contracts should auto-renew by default">
          <select value={String(form.auto_renew_default)} onChange={(e) => updateField("auto_renew_default", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Renewal Term (Days)" icon={Calendar} description="Default renewal period when contracts auto-renew">
          <input type="number" min="1" value={form.default_renewal_term_days} onChange={(e) => updateField("default_renewal_term_days", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Enable Auto-Renewal" icon={ToggleLeft} description="Allow contracts to auto-renew at expiration">
          <select value={String(form.enable_auto_renewal)} onChange={(e) => updateField("enable_auto_renewal", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Enable Retainers" icon={DollarSign} description="Allow retainer-based products and contracts">
          <select value={String(form.enable_retainers)} onChange={(e) => updateField("enable_retainers", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label={`Require ${singular} Signature`} icon={Users} description={`Require ${singular.toLowerCase()} signature for contract finalization`}>
          <select value={String(form.require_customer_signature)} onChange={(e) => updateField("require_customer_signature", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Required</option>
            <option value="false">Not Required</option>
          </select>
        </SettingsField>

        <SettingsField label="Require Organization Signature" icon={Users} description="Require organization signature for contract finalization">
          <select value={String(form.require_org_signature)} onChange={(e) => updateField("require_org_signature", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Required</option>
            <option value="false">Not Required</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Terms & Conditions" icon={FileText} description="Default terms and conditions for new contracts">
          <textarea value={form.default_terms_and_conditions} onChange={(e) => updateField("default_terms_and_conditions", e.target.value)}
            rows={3} placeholder="Standard contract terms..."
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Contract Logo URL" icon={Image} description="URL to company logo displayed on contracts">
          <input type="url" value={form.contract_logo_url} onChange={(e) => updateField("contract_logo_url", e.target.value)}
            placeholder="https://example.com/logo.png"
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          {form.contract_logo_url && <p className="mt-1 text-xs text-slate-400 truncate max-w-xs">{form.contract_logo_url}</p>}
        </SettingsField>
      </div>
    </HRPage>
  );
}
