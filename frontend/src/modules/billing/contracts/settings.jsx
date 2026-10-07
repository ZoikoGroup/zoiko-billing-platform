import { useState, useEffect, Children, cloneElement, isValidElement, useId } from "react";
import { Save, RefreshCw, AlertCircle, CheckCircle, Hash, ToggleLeft, Calendar, DollarSign, FileText, Image, Users } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { ErrorState } from "../../../components/billing-shared";
import { settingsApi } from "../../../service/billingService";
import { useTerminology } from "../utils/TerminologyContext";

function SettingsField({ label, icon: Icon, children, description }) {
  // Programmatically associate the visible label with the card's control:
  // give the first native input/select/textarea child an id and point a
  // <label htmlFor> at it. Cards wrapping a composite control fall back to
  // a labelled group so the controls still get the card title as context.
  const uid = useId();
  const labelId = `${uid}-label`;
  let controlId = null;
  const content = Children.map(children, (child) => {
    if (controlId || !isValidElement(child) || !["input", "select", "textarea"].includes(child.type)) return child;
    controlId = child.props.id || `${uid}-control`;
    return child.props.id ? child : cloneElement(child, { id: controlId });
  });
  return (
    <div role={controlId ? undefined : "group"} aria-labelledby={controlId ? undefined : labelId} className="bg-white border border-slate-200 rounded-3xl p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="h-10 w-10 rounded-xl bg-gradient-to-r from-brand to-brand-hover text-white flex items-center justify-center">
          <Icon size={20} />
        </div>
        <div>
          <h3 className="text-base font-semibold text-slate-800"><label id={labelId} htmlFor={controlId || undefined}>{label}</label></h3>
          {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
        </div>
      </div>
      {content}
    </div>
  );
}

// Fields BillingConfigurationUpdate actually accepts. enable_auto_renewal and
// contract_logo_url have no backend column: they were sent, silently dropped,
// and the page still said "Saved" -- they are now shown read-only.
const PERSISTED_KEYS = [
  "default_contract_prefix", "contract_number_format", "auto_generate_contract_number",
  "default_notice_period_days", "default_contract_term_days", "auto_renew_default",
  "default_renewal_term_days", "enable_retainers", "default_terms_and_conditions",
  "require_customer_signature", "require_org_signature",
];
const DAY_FIELDS = {
  default_notice_period_days: "Default notice period",
  default_contract_term_days: "Default contract term",
  default_renewal_term_days: "Default renewal term",
};

// Day fields are Optional[int] in the API: an emptied input used to be sent as
// "" and rejected with a raw 422. Validate here and send real integers.
export function validateContractSettings(form) {
  for (const [key, label] of Object.entries(DAY_FIELDS)) {
    const raw = String(form[key] ?? "").trim();
    if (!/^\d+$/.test(raw) || Number(raw) < 1) return `${label} must be a whole number of days (1 or more).`;
  }
  return null;
}

export function buildContractSettingsPayload(form) {
  const payload = {};
  for (const key of PERSISTED_KEYS) payload[key] = form[key];
  for (const key of Object.keys(DAY_FIELDS)) payload[key] = Number(String(form[key]).trim());
  return payload;
}

export default function ContractSettingsPage() {
  const { singular } = useTerminology();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
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
      setLoadFailed(false);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load settings");
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    const invalid = validateContractSettings(form);
    if (invalid) { setError(invalid); setSaved(false); return; }
    try {
      setSaving(true);
      setError(null);
      setSaved(false);
      await settingsApi.update(buildContractSettingsPayload(form));
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

  // Never render an editable form built from hard-coded defaults: if the
  // saved configuration could not be loaded, Save would write those
  // defaults over the organization's real settings (same guard as
  // invoicing/settings.jsx and tax/settings.jsx).
  if (loadFailed) {
    return (
      <HRPage title="Contract Settings" subtitle="Configure contract module preferences">
        <ErrorState title="Couldn't load contract settings" message={error} onRetry={fetchSettings} />
      </HRPage>
    );
  }

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
        <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2" role="alert">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="space-y-6">
        <SettingsField label="Contract Numbering Prefix" icon={Hash} description="Prefix used when auto-generating contract numbers">
          <input type="text" aria-label="Contract numbering prefix" value={form.default_contract_prefix} onChange={(e) => updateField("default_contract_prefix", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Contract Numbering Format" icon={Hash} description="Contract number format. Use {PREFIX} and {NUMBER} as placeholders">
          <input type="text" aria-label="Contract numbering format" value={form.contract_number_format} onChange={(e) => updateField("contract_number_format", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          <p className="mt-1 text-xs text-slate-500">Preview: {numberingPreview}</p>
        </SettingsField>

        <SettingsField label="Auto-Generate Contract Numbers" icon={ToggleLeft} description="Automatically generate contract numbers using the configured prefix/format">
          <select aria-label="Auto-generate contract numbers" value={String(form.auto_generate_contract_number)} onChange={(e) => updateField("auto_generate_contract_number", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Notice Period (Days)" icon={Calendar} description="Default notice period required for contract termination">
          <input type="number" min="1" step="1" aria-label="Default notice period days" value={form.default_notice_period_days} onChange={(e) => updateField("default_notice_period_days", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Default Contract Term (Days)" icon={Calendar} description="Default duration for new contracts in days">
          <input type="number" min="1" step="1" aria-label="Default contract term days" value={form.default_contract_term_days} onChange={(e) => updateField("default_contract_term_days", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Default Auto-Renewal" icon={ToggleLeft} description="Whether new contracts should auto-renew by default">
          <select aria-label="Default auto-renewal" value={String(form.auto_renew_default)} onChange={(e) => updateField("auto_renew_default", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Renewal Term (Days)" icon={Calendar} description="Default renewal period when contracts auto-renew">
          <input type="number" min="1" step="1" aria-label="Default renewal term days" value={form.default_renewal_term_days} onChange={(e) => updateField("default_renewal_term_days", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Enable Auto-Renewal" icon={ToggleLeft} description="Not configurable yet — this setting is not saved. Use Default Auto-Renewal above.">
          <select aria-label="Enable auto-renewal" disabled value={String(form.enable_auto_renewal)} onChange={(e) => updateField("enable_auto_renewal", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm bg-slate-50 text-slate-500 cursor-not-allowed">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Enable Retainers" icon={DollarSign} description="Allow retainer-based products and contracts">
          <select aria-label="Enable retainers" value={String(form.enable_retainers)} onChange={(e) => updateField("enable_retainers", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label={`Require ${singular} Signature`} icon={Users} description={`Require ${singular.toLowerCase()} signature for contract finalization`}>
          <select aria-label="Require customer signature" value={String(form.require_customer_signature)} onChange={(e) => updateField("require_customer_signature", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Required</option>
            <option value="false">Not Required</option>
          </select>
        </SettingsField>

        <SettingsField label="Require Organization Signature" icon={Users} description="Require organization signature for contract finalization">
          <select aria-label="Require organization signature" value={String(form.require_org_signature)} onChange={(e) => updateField("require_org_signature", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Required</option>
            <option value="false">Not Required</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Terms & Conditions" icon={FileText} description="Default terms and conditions for new contracts">
          <textarea aria-label="Default terms and conditions" value={form.default_terms_and_conditions} onChange={(e) => updateField("default_terms_and_conditions", e.target.value)}
            rows={3} placeholder="Standard contract terms..."
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Contract Logo URL" icon={Image} description="Not configurable yet — this setting is not saved.">
          <input type="url" aria-label="Contract logo URL" disabled value={form.contract_logo_url} onChange={(e) => updateField("contract_logo_url", e.target.value)}
            placeholder="https://example.com/logo.png"
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm bg-slate-50 text-slate-500 cursor-not-allowed" />
        </SettingsField>
      </div>
    </HRPage>
  );
}
