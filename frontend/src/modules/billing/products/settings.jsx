import { useState, useEffect, useRef, useMemo } from "react";
import { Save, RefreshCw, AlertCircle, CheckCircle, Hash, Folder, DollarSign, BarChart3, Eye, Tag, Percent, Globe } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { settingsApi, productApi } from "../../../service/billingService";
import { getCurrencySelectOptions, getCurrencySymbol } from "../../../utils/currency";
import { useCurrency } from "../utils/CurrencyContext";

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

const CURRENCY_OPTIONS = getCurrencySelectOptions();

export default function ProductSettingsPage() {
  const { baseCurrency } = useCurrency();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const timerRef = useRef(null);
  const [categories, setCategories] = useState([]);

  const [form, setForm] = useState({
    product_numbering_prefix: "PROD-",
    product_numbering_format: "{PREFIX}{NUMBER}",
    default_category_id: "",
    default_tax_rate: "",
    default_product_currency: baseCurrency,
    max_discount_percentage: "",
    usage_billing_unit: "unit",
    usage_billing_rounding: "nearest",
    auto_archive_days: "",
    product_visibility: "visible",
    require_sku: "no",
  });

  const [original, setOriginal] = useState({});
  const hasChanges = useMemo(() => Object.keys(form).some((key) => form[key] != original[key]), [form, original]);

  useEffect(() => { fetchSettings(); }, []);

  async function fetchSettings() {
    try {
      setLoading(true);
      setError(null);
      setSaved(false);
      const [settingsRes, catRes] = await Promise.allSettled([
        settingsApi.getConfig(),
        productApi.listCategories({ per_page: 100 }),
      ]);
      if (settingsRes.status === "rejected") {
        setError(settingsRes.reason?.detail || settingsRes.reason?.message || "Failed to load settings");
        setLoading(false);
        return;
      }
      const settings = settingsRes.value || {};
      if (catRes.status === "fulfilled") {
        const catData = catRes.value;
        setCategories(Array.isArray(catData) ? catData : catData?.items || catData?.categories || catData?.data || []);
      }

      const values = {
        product_numbering_prefix: String(settings.product_numbering_prefix ?? "PROD-"),
        product_numbering_format: String(settings.product_numbering_format ?? "{PREFIX}{NUMBER}"),
        default_category_id: String(settings.default_category_id ?? ""),
        default_tax_rate: String(settings.default_tax_rate ?? ""),
        default_product_currency: String(settings.default_product_currency ?? baseCurrency),
        max_discount_percentage: String(settings.max_discount_percentage ?? ""),
        usage_billing_unit: String(settings.usage_billing_unit ?? "unit"),
        usage_billing_rounding: String(settings.usage_billing_rounding ?? "nearest"),
        auto_archive_days: String(settings.auto_archive_days ?? ""),
        product_visibility: String(settings.product_visibility ?? "visible"),
        require_sku: String(settings.require_sku ?? "no"),
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
      const payload = { ...form };
      const numericFields = ["default_category_id", "default_tax_rate", "max_discount_percentage", "auto_archive_days"];
      for (const key of numericFields) {
        if (payload[key] === "" || payload[key] == null) payload[key] = null;
      }
      await settingsApi.updateConfig(payload);
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
      <HRPage title="Product Settings" subtitle="Product configuration and preferences">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      </HRPage>
    );
  }

  const numberingPreview = form.product_numbering_format
    .replace("{PREFIX}", form.product_numbering_prefix)
    .replace("{NUMBER}", "0001");

  return (
    <HRPage title="Product Settings" subtitle="Product configuration and preferences">

      <div className="flex items-center justify-between mb-6">
        <div />
        <div className="flex items-center gap-2">
          {saved && (
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
        <SettingsField label="Product Numbering Prefix" icon={Hash} description="Prefix used when auto-generating product codes">
          <input type="text" value={form.product_numbering_prefix} onChange={(e) => updateField("product_numbering_prefix", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Product Numbering Format" icon={Hash} description="Product code format. Use {PREFIX} and {NUMBER} as placeholders">
          <input type="text" value={form.product_numbering_format} onChange={(e) => updateField("product_numbering_format", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          <p className="mt-1 text-xs text-gray-400">Preview: {numberingPreview}</p>
        </SettingsField>

        <SettingsField label="Default Currency" icon={Globe} description="Default currency for new products and pricing">
          <select value={form.default_product_currency} onChange={(e) => updateField("default_product_currency", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            {CURRENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p className="mt-1 text-xs text-gray-400">Current: {getCurrencySymbol(form.default_product_currency)} {form.default_product_currency}</p>
        </SettingsField>

        <SettingsField label="Default Category" icon={Folder} description="Default category assigned to new products">
          <select value={form.default_category_id} onChange={(e) => updateField("default_category_id", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="">None</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </SettingsField>

        <SettingsField label="Default Tax Rate" icon={Tag} description="Default tax rate applied to new products">
          <input type="text" value={form.default_tax_rate} onChange={(e) => updateField("default_tax_rate", e.target.value)}
            placeholder="e.g. 0.08 for 8%"
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Max Discount Percentage" icon={Percent} description="Maximum discount allowed per product (leave empty for no limit)">
          <input type="number" min="0" max="100" step="0.1" value={form.max_discount_percentage} onChange={(e) => updateField("max_discount_percentage", e.target.value)}
            placeholder="e.g. 50 for 50%"
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Usage Billing Default Unit" icon={BarChart3} description="Default metering unit for usage-based products">
          <select value={form.usage_billing_unit} onChange={(e) => updateField("usage_billing_unit", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="unit">Per Unit</option>
            <option value="hour">Per Hour</option>
            <option value="day">Per Day</option>
            <option value="mb">Per MB</option>
            <option value="gb">Per GB</option>
            <option value="api_call">Per API Call</option>
            <option value="user">Per User</option>
            <option value="license">Per License</option>
          </select>
        </SettingsField>

        <SettingsField label="Usage Billing Rounding" icon={BarChart3} description="How partial usage units are rounded for billing">
          <select value={form.usage_billing_rounding} onChange={(e) => updateField("usage_billing_rounding", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="nearest">Nearest Unit</option>
            <option value="up">Round Up</option>
            <option value="down">Round Down</option>
          </select>
        </SettingsField>

        <SettingsField label="Auto-Archive After (Days)" icon={DollarSign} description="Automatically archive inactive products after N days (leave empty to disable)">
          <input type="number" min="1" value={form.auto_archive_days} onChange={(e) => updateField("auto_archive_days", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Product Visibility" icon={Eye} description="Default visibility for new products in catalogs and listings">
          <select value={form.product_visibility} onChange={(e) => updateField("product_visibility", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="visible">Visible</option>
            <option value="hidden">Hidden</option>
          </select>
        </SettingsField>

        <SettingsField label="Require SKU" icon={Tag} description="Require SKU when creating new products">
          <select value={form.require_sku} onChange={(e) => updateField("require_sku", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="yes">Required</option>
            <option value="no">Optional</option>
          </select>
        </SettingsField>
      </div>
    </HRPage>
  );
}
