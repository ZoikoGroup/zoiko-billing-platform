import { useState, useEffect, useRef } from "react";
import { Save, RefreshCw, AlertCircle, CheckCircle, Users, Hash, Bell, FileText, CreditCard } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { settingsApi } from "../../../service/billingService";

const FRONTEND_TO_BACKEND = {
  default_customer_type: null,
  customer_numbering_prefix: null,
  customer_numbering_format: null,
  default_payment_terms: "default_payment_terms",
  credit_limit: "credit_limit",
  customer_notification: "notify_customer_created",
  auto_suspend_days: "grace_period_days",
  require_billing_address: null,
  require_tax_id: null,
};

const BACKEND_TO_FRONTEND = Object.fromEntries(
  Object.entries(FRONTEND_TO_BACKEND)
    .filter(([, v]) => v)
    .map(([k, v]) => [v, k]),
);

function toPayload(form) {
  const payload = {};
  for (const [frontKey, backKey] of Object.entries(FRONTEND_TO_BACKEND)) {
    if (!backKey) continue;
    let val = form[frontKey];
    if (frontKey === "credit_limit") {
      val = val === "" || val === undefined || val === null ? null : Number(val);
      if (isNaN(val)) val = null;
    }
    if (frontKey === "auto_suspend_days") {
      val = val === "" || val === undefined || val === null ? null : Number(val);
      if (isNaN(val)) val = null;
    }
    if (frontKey === "customer_notification") {
      val = val === "yes";
    }
    payload[backKey] = val;
  }
  return payload;
}

function toForm(settings) {
  return {
    default_customer_type: "individual",
    customer_numbering_prefix: "CUST-",
    customer_numbering_format: "{PREFIX}{NUMBER}",
    default_payment_terms: settings.default_payment_terms || "net_30",
    credit_limit: settings.credit_limit != null ? String(settings.credit_limit) : "",
    customer_notification: settings.notify_customer_created ? "yes" : "no",
    auto_suspend_days: settings.grace_period_days != null ? String(settings.grace_period_days) : "",
    require_billing_address: "yes",
    require_tax_id: "no",
  };
}

function SettingsField({ label, icon: Icon, children, description }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-6">
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

const DEFAULTS = {
  default_customer_type: "individual",
  customer_numbering_prefix: "CUST-",
  customer_numbering_format: "{PREFIX}{NUMBER}",
  default_payment_terms: "net_30",
  credit_limit: "",
  customer_notification: "yes",
  auto_suspend_days: "",
  require_billing_address: "yes",
  require_tax_id: "no",
};

export default function CustomerSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const timerRef = useRef(null);

  const [form, setForm] = useState(DEFAULTS);
  const [original, setOriginal] = useState(DEFAULTS);

  const hasChanges = Object.keys(form).some((key) => form[key] !== original[key]);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    try {
      setLoading(true);
      setError(null);
      setSaved(false);
      const data = await settingsApi.get();
      const values = toForm(data || {});
      setForm(values);
      setOriginal(values);
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
      await settingsApi.update(toPayload(form));
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
      <HRPage title="Customer Settings" subtitle="Customer configuration and preferences">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      </HRPage>
    );
  }

  return (
    <HRPage title="Customer Settings" subtitle="Customer configuration and preferences">

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
        <SettingsField label="Default Customer Type" icon={Users} description="Not yet available — this preference is not persisted or enforced yet">
          <select value={form.default_customer_type} onChange={(e) => updateField("default_customer_type", e.target.value)} disabled
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm bg-slate-50 text-slate-400 cursor-not-allowed">
            <option value="individual">Individual</option>
            <option value="business">Business</option>
            <option value="non_profit">Non-Profit</option>
            <option value="government">Government</option>
          </select>
        </SettingsField>

        <SettingsField label="Customer Numbering Prefix" icon={Hash} description="Not yet available — this preference is not persisted or enforced yet">
          <input type="text" value={form.customer_numbering_prefix} onChange={(e) => updateField("customer_numbering_prefix", e.target.value)} disabled
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm bg-slate-50 text-slate-400 cursor-not-allowed" />
        </SettingsField>

        <SettingsField label="Customer Numbering Format" icon={Hash} description="Not yet available — this preference is not persisted or enforced yet">
          <input type="text" value={form.customer_numbering_format} onChange={(e) => updateField("customer_numbering_format", e.target.value)} disabled
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm bg-slate-50 text-slate-400 cursor-not-allowed" />
          <p className="mt-1 text-xs text-slate-400">Preview: {form.customer_numbering_format.replace("{PREFIX}", form.customer_numbering_prefix).replace("{NUMBER}", "0001")}</p>
        </SettingsField>

        <SettingsField label="Default Payment Terms" icon={CreditCard} description="Default payment terms assigned to new customers">
          <select value={form.default_payment_terms} onChange={(e) => updateField("default_payment_terms", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="due_on_receipt">Due on Receipt</option>
            <option value="net_15">Net 15</option>
            <option value="net_30">Net 30</option>
            <option value="net_45">Net 45</option>
            <option value="net_60">Net 60</option>
            <option value="net_90">Net 90</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Credit Limit" icon={CreditCard} description="Default credit limit assigned to new customers (leave empty for no limit)">
          <input type="number" min="0" step="0.01" value={form.credit_limit} onChange={(e) => updateField("credit_limit", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Auto-Suspend After (Days)" icon={Bell} description="Automatically suspend customer after N days of payment overdue (leave empty to disable)">
          <input type="number" min="1" value={form.auto_suspend_days} onChange={(e) => updateField("auto_suspend_days", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Customer Notifications" icon={Bell} description="Send billing notifications to customers">
          <select value={form.customer_notification} onChange={(e) => updateField("customer_notification", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="yes">Enabled</option>
            <option value="no">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Require Billing Address" icon={FileText} description="Not yet available — this preference is not persisted or enforced yet">
          <select value={form.require_billing_address} onChange={(e) => updateField("require_billing_address", e.target.value)} disabled
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm bg-slate-50 text-slate-400 cursor-not-allowed">
            <option value="yes">Required</option>
            <option value="no">Optional</option>
          </select>
        </SettingsField>

        <SettingsField label="Require Tax ID" icon={FileText} description="Not yet available — this preference is not persisted or enforced yet">
          <select value={form.require_tax_id} onChange={(e) => updateField("require_tax_id", e.target.value)} disabled
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm bg-slate-50 text-slate-400 cursor-not-allowed">
            <option value="yes">Required</option>
            <option value="no">Optional</option>
          </select>
        </SettingsField>
      </div>
    </HRPage>
  );
}
