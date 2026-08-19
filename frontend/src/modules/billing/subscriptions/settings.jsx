import { useState, useEffect } from "react";
import {
  Save, RefreshCw, AlertCircle, CheckCircle, Hash, ToggleLeft, Calendar,
  Percent, DollarSign, FileText, Image, Clock, Ban, Repeat,
} from "lucide-react";
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

export default function SubscriptionSettingsPage() {
  const { singular } = useTerminology();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const [form, setForm] = useState({
    default_subscription_prefix: "SUB-",
    subscription_number_format: "{PREFIX}{NUMBER}",
    auto_generate_subscription_number: true,
    default_billing_period: "monthly",
    default_trial_days: "0",
    enable_trials: true,
    enable_auto_renewal: true,
    default_cancellation_policy: "immediate",
    prorate_on_change: true,
    prorate_on_cancel: true,
    default_terms_and_conditions: "",
    subscription_logo_url: "",
    require_payment_method: true,
    grace_period_days: "0",
    billing_cycle_alignment: "calendar",
    enable_dunning: false,
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
        default_subscription_prefix: settings.default_subscription_prefix || "SUB-",
        subscription_number_format: settings.subscription_number_format || "{PREFIX}{NUMBER}",
        auto_generate_subscription_number: settings.auto_generate_subscription_number ?? true,
        default_billing_period: settings.default_billing_period || "monthly",
        default_trial_days: settings.default_trial_days || "0",
        enable_trials: settings.enable_trials ?? true,
        enable_auto_renewal: settings.enable_auto_renewal ?? true,
        default_cancellation_policy: settings.default_cancellation_policy || "immediate",
        prorate_on_change: settings.prorate_on_change ?? true,
        prorate_on_cancel: settings.prorate_on_cancel ?? true,
        default_terms_and_conditions: settings.default_terms_and_conditions || "",
        subscription_logo_url: settings.subscription_logo_url || "",
        require_payment_method: settings.require_payment_method ?? true,
        grace_period_days: settings.grace_period_days || "0",
        billing_cycle_alignment: settings.billing_cycle_alignment || "calendar",
        enable_dunning: settings.enable_dunning ?? false,
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
      <HRPage title="Subscription Settings" subtitle="Configure subscription module preferences">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      </HRPage>
    );
  }

  const numberingPreview = form.subscription_number_format
    .replace("{PREFIX}", form.default_subscription_prefix)
    .replace("{NUMBER}", "0001");

  return (
    <HRPage title="Subscription Settings" subtitle="Configure subscription module preferences">
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
        <SettingsField label="Subscription Numbering Prefix" icon={Hash} description="Prefix used when auto-generating subscription numbers">
          <input type="text" value={form.default_subscription_prefix} onChange={(e) => updateField("default_subscription_prefix", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Subscription Numbering Format" icon={Hash} description="Number format. Use {PREFIX} and {NUMBER} as placeholders">
          <input type="text" value={form.subscription_number_format} onChange={(e) => updateField("subscription_number_format", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          <p className="mt-1 text-xs text-slate-400">Preview: {numberingPreview}</p>
        </SettingsField>

        <SettingsField label="Auto-Generate Subscription Numbers" icon={ToggleLeft} description="Automatically generate subscription numbers using the configured prefix/format">
          <select value={String(form.auto_generate_subscription_number)} onChange={(e) => updateField("auto_generate_subscription_number", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Billing Period" icon={Calendar} description="Default billing cycle for new subscriptions">
          <select value={form.default_billing_period} onChange={(e) => updateField("default_billing_period", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="semi_annual">Semi-Annual</option>
            <option value="annual">Annual</option>
            <option value="one_time">One-Time</option>
          </select>
        </SettingsField>

        <SettingsField label="Enable Trials" icon={Clock} description="Allow free trial periods for new subscriptions">
          <select value={String(form.enable_trials)} onChange={(e) => updateField("enable_trials", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Trial Period (Days)" icon={Clock} description="Default trial duration for new subscriptions when trials are enabled">
          <input type="number" min="0" value={form.default_trial_days} onChange={(e) => updateField("default_trial_days", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Enable Auto-Renewal" icon={Repeat} description="Allow subscriptions to auto-renew at end of billing period">
          <select value={String(form.enable_auto_renewal)} onChange={(e) => updateField("enable_auto_renewal", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Cancellation Policy" icon={Ban} description="Default behaviour when a subscription is cancelled">
          <select value={form.default_cancellation_policy} onChange={(e) => updateField("default_cancellation_policy", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="immediate">Immediate</option>
            <option value="end_of_period">End of Current Period</option>
            <option value="notice_period">Notice Period</option>
          </select>
        </SettingsField>

        <SettingsField label="Prorate on Plan Change" icon={Percent} description="Prorate charges when a subscription changes plan mid-cycle">
          <select value={String(form.prorate_on_change)} onChange={(e) => updateField("prorate_on_change", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Prorate on Cancel" icon={Percent} description="Refund prorated amount when a subscription is cancelled mid-cycle">
          <select value={String(form.prorate_on_cancel)} onChange={(e) => updateField("prorate_on_cancel", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Grace Period (Days)" icon={Clock} description="Days after billing date before subscription is marked past due">
          <input type="number" min="0" value={form.grace_period_days} onChange={(e) => updateField("grace_period_days", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Billing Cycle Alignment" icon={Calendar} description="How billing cycles are aligned for subscriptions">
          <select value={form.billing_cycle_alignment} onChange={(e) => updateField("billing_cycle_alignment", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="calendar">Calendar Aligned</option>
            <option value="subscription">Subscription Start Date</option>
            <option value="customer">{singular} Sign-Up Date</option>
          </select>
        </SettingsField>

        <SettingsField label="Require Payment Method" icon={DollarSign} description="Require a payment method before activating a subscription">
          <select value={String(form.require_payment_method)} onChange={(e) => updateField("require_payment_method", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Required</option>
            <option value="false">Not Required</option>
          </select>
        </SettingsField>

        <SettingsField label="Enable Dunning" icon={Repeat} description="Automatically retry failed payments and send reminders">
          <select value={String(form.enable_dunning)} onChange={(e) => updateField("enable_dunning", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Enabled</option>
            <option value="false">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Terms & Conditions" icon={FileText} description="Default terms and conditions for new subscriptions">
          <textarea value={form.default_terms_and_conditions} onChange={(e) => updateField("default_terms_and_conditions", e.target.value)}
            rows={3} placeholder="Standard subscription terms..."
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Subscription Logo URL" icon={Image} description="URL to company logo displayed on subscription documents">
          <input type="url" value={form.subscription_logo_url} onChange={(e) => updateField("subscription_logo_url", e.target.value)}
            placeholder="https://example.com/logo.png"
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          {form.subscription_logo_url && <p className="mt-1 text-xs text-slate-400 truncate max-w-xs">{form.subscription_logo_url}</p>}
        </SettingsField>
      </div>
    </HRPage>
  );
}
