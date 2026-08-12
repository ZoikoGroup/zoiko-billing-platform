import { useState, useEffect, useCallback } from "react";
import { Save, AlertCircle, CheckCircle, RefreshCw, DollarSign, Calendar, Hash, Percent, BarChart3 } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { settingsApi } from "../../../service/billingService";
import { getCurrencySelectOptions } from "../../../utils/currency";
import { Spinner, ErrorState } from "../../../components/billing-shared";

const CURRENCY_OPTIONS = getCurrencySelectOptions();

const FREQUENCY_OPTIONS = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "semi_annual", label: "Semi-Annual" },
  { value: "annual", label: "Annual" },
];

const STRATEGY_OPTIONS = [
  { value: "flat", label: "Flat" },
  { value: "volume", label: "Volume" },
  { value: "graduated", label: "Graduated" },
];

const ROUNDING_OPTIONS = [
  { value: "none", label: "No Rounding" },
  { value: "nearest_0.01", label: "Nearest $0.01" },
  { value: "nearest_0.10", label: "Nearest $0.10" },
  { value: "nearest_1.00", label: "Nearest $1.00" },
  { value: "ceil_1.00", label: "Ceil to $1.00" },
];

const SETTINGS_PREFIX = "pricing_";

const DEFAULT_SETTINGS = {
  default_currency: "USD",
  default_billing_frequency: "monthly",
  default_trial_days: "0",
  price_precision: "2",
  tax_inclusive: "no",
  default_pricing_strategy: "flat",
  rounding_rule: "none",
};

export default function PricingSettingsPage() {
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
  const [initial, setInitial] = useState({ ...DEFAULT_SETTINGS });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      const data = await settingsApi.get();
      const raw = data?.settings || data || {};
      const prefixed = {};
      Object.entries(DEFAULT_SETTINGS).forEach(([key, def]) => {
        const val = raw[`${SETTINGS_PREFIX}${key}`] ?? raw[key] ?? def;
        prefixed[key] = String(val);
      });
      setSettings(prefixed);
      setInitial(prefixed);
    } catch (err) {
      setError(err.message || "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const hasChanges = Object.keys(DEFAULT_SETTINGS).some((key) => settings[key] !== initial[key]);

  const handleSave = async () => {
    setSaving(true); setError(null); setSuccess(false);
    try {
      const payload = {};
      Object.entries(settings).forEach(([key, val]) => {
        payload[key] = val;
        payload[`${SETTINGS_PREFIX}${key}`] = val;
      });
      await settingsApi.update(payload);
      setInitial({ ...settings });
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleChange = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSuccess(false);
  };

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

  if (loading) {
    return (
      <HRPage title="Pricing Settings" subtitle="Configure pricing defaults and behavior">
        <Spinner />
      </HRPage>
    );
  }

  if (error && !settings.default_currency) {
    return (
      <HRPage title="Pricing Settings" subtitle="Configure pricing defaults and behavior">
        <ErrorState message={error} onRetry={fetchSettings} />
      </HRPage>
    );
  }

  return (
    <HRPage title="Pricing Settings" subtitle="Configure pricing defaults and behavior">

      <div className="flex items-center justify-between mb-6">
        <div />
        <div className="flex items-center gap-2">
          {success && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 bg-emerald-50 rounded-lg">
              <CheckCircle className="h-4 w-4" /> Saved
            </span>
          )}
          <button onClick={fetchSettings}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
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
        <SettingsField label="Default Currency" icon={DollarSign} description="Default currency for pricing">
          <select value={settings.default_currency} onChange={(e) => handleChange("default_currency", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            {CURRENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </SettingsField>

        <SettingsField label="Default Billing Frequency" icon={Calendar} description="Default billing cycle for pricing plans">
          <select value={settings.default_billing_frequency} onChange={(e) => handleChange("default_billing_frequency", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            {FREQUENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </SettingsField>

        <SettingsField label="Default Trial Days" icon={Hash} description="Default trial duration for new pricing plans">
          <input type="number" min="0" value={settings.default_trial_days} onChange={(e) => handleChange("default_trial_days", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Price Precision" icon={Hash} description="Number of decimal places for prices">
          <input type="number" min="0" max="6" value={settings.price_precision} onChange={(e) => handleChange("price_precision", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Tax Inclusive Pricing" icon={Percent} description="Whether prices include tax by default">
          <select value={settings.tax_inclusive} onChange={(e) => handleChange("tax_inclusive", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="yes">Yes (prices include tax)</option>
            <option value="no">No (tax added at checkout)</option>
          </select>
        </SettingsField>

        <SettingsField label="Default Pricing Strategy" icon={BarChart3} description="Default pricing model for new plans">
          <select value={settings.default_pricing_strategy} onChange={(e) => handleChange("default_pricing_strategy", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            {STRATEGY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </SettingsField>

        <SettingsField label="Rounding Rule" icon={DollarSign} description="How prices are rounded">
          <select value={settings.rounding_rule} onChange={(e) => handleChange("rounding_rule", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            {ROUNDING_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </SettingsField>
      </div>
    </HRPage>
  );
}
