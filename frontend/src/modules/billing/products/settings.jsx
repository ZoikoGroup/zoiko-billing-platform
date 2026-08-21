import { useState, useEffect, useRef, useMemo } from "react";
import { Save, RefreshCw, AlertCircle, CheckCircle, Hash, Folder, DollarSign, BarChart3, Eye, Tag, Percent, Globe, SlidersHorizontal, Archive, ScrollText, Store, X } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { settingsApi, productApi } from "../../../service/billingService";
import { getCurrencySelectOptions, getCurrencySymbol } from "../../../utils/currency";
import { useCurrency } from "../utils/CurrencyContext";

const TABS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "tax_currency", label: "Tax & Currency", icon: DollarSign },
  { id: "auto_archive", label: "Auto-Archiving", icon: Archive },
  { id: "meter_logs", label: "Meter Event Logs", icon: ScrollText },
  { id: "portal", label: "Portal Display", icon: Store },
];

function ToggleSwitch({ checked, onChange, label, description }) {
  return (
    <div className="flex items-start justify-between gap-4 p-4 rounded-xl border border-slate-200 bg-white">
      <div>
        <p className="text-sm font-medium text-slate-800">{label}</p>
        {description && <p className="text-xs text-slate-500 mt-0.5">{description}</p>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-brand-600" : "bg-slate-300"}`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-6" : "translate-x-1"}`} />
      </button>
    </div>
  );
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

function Field({ label, children, hint }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

const inputCls = "w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2.5 text-sm bg-white transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30";

const CURRENCY_OPTIONS = getCurrencySelectOptions();

export default function ProductSettingsPage() {
  const { baseCurrency } = useCurrency();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const timerRef = useRef(null);
  const [categories, setCategories] = useState([]);
  const [usageProducts, setUsageProducts] = useState([]);
  const [activeTab, setActiveTab] = useState("general");

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
    auto_archive_enabled: false,
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
      const [settingsRes, catRes, usageRes] = await Promise.allSettled([
        settingsApi.getConfig(),
        productApi.listCategories({ per_page: 100 }),
        productApi.listUsageBillable(),
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
      if (usageRes.status === "fulfilled") {
        setUsageProducts(Array.isArray(usageRes.value) ? usageRes.value : usageRes.value?.items || usageRes.value?.data || []);
      }

      const autoArchiveEnabled = String(settings.auto_archive_days ?? "") !== "" && String(settings.auto_archive_days ?? "") !== "0";
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
        auto_archive_enabled: autoArchiveEnabled,
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
      if (!payload.auto_archive_enabled) payload.auto_archive_days = "";
      delete payload.auto_archive_enabled;
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

  function discardChanges() {
    setForm({ ...original });
    setError(null);
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

      {error && (
        <div className="mb-6 p-4 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
          <button onClick={() => setError(null)} aria-label="Dismiss" className="ml-auto text-red-400 hover:text-red-600"><X size={16} /></button>
        </div>
      )}

      {/* ── Tabs ── */}
      <div className="mb-6 flex flex-wrap gap-2 border-b border-slate-200 pb-0">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`inline-flex items-center gap-2 px-4 py-2.5 -mb-px text-sm font-medium rounded-t-xl border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-brand-600 text-brand-700 bg-brand-50/50"
                : "border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50"
            }`}
          >
            <tab.icon size={16} /> {tab.label}
          </button>
        ))}
      </div>

      <div className="space-y-6 pb-28">
        {/* ── General ── */}
        {activeTab === "general" && (
          <>
            <SettingsField label="Product Numbering Prefix" icon={Hash} description="Prefix used when auto-generating product codes">
              <input type="text" value={form.product_numbering_prefix} onChange={(e) => updateField("product_numbering_prefix", e.target.value)} className={inputCls} />
            </SettingsField>
            <SettingsField label="Product Numbering Format" icon={Hash} description="Product code format. Use {PREFIX} and {NUMBER} as placeholders">
              <input type="text" value={form.product_numbering_format} onChange={(e) => updateField("product_numbering_format", e.target.value)} className={inputCls} />
              <p className="mt-1 text-xs text-slate-500">Preview: <code className="font-mono text-brand-700 bg-brand-50 px-1.5 py-0.5 rounded">{numberingPreview}</code></p>
            </SettingsField>
            <SettingsField label="Default Category" icon={Folder} description="Default category assigned to new products">
              <select value={form.default_category_id} onChange={(e) => updateField("default_category_id", e.target.value)} className={inputCls}>
                <option value="">None</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </SettingsField>
          </>
        )}

        {/* ── Tax & Currency ── */}
        {activeTab === "tax_currency" && (
          <>
            <SettingsField label="Default Currency" icon={Globe} description="Default currency for new products and pricing">
              <Field label="Currency">
                <select value={form.default_product_currency} onChange={(e) => updateField("default_product_currency", e.target.value)} className={inputCls}>
                  {CURRENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <p className="mt-1 text-xs text-slate-500">Current: {getCurrencySymbol(form.default_product_currency)} {form.default_product_currency}</p>
              </Field>
            </SettingsField>
            <SettingsField label="Default Tax Rate" icon={Tag} description="Default tax rate applied to new products">
              <Field label="Tax rate">
                <input type="text" value={form.default_tax_rate} onChange={(e) => updateField("default_tax_rate", e.target.value)}
                  placeholder="e.g. 0.08 for 8%" className={inputCls} />
              </Field>
            </SettingsField>
            <SettingsField label="Max Discount Percentage" icon={Percent} description="Maximum discount allowed per product (leave empty for no limit)">
              <Field label="Discount cap">
                <input type="number" min="0" max="100" step="0.1" value={form.max_discount_percentage} onChange={(e) => updateField("max_discount_percentage", e.target.value)}
                  placeholder="e.g. 50 for 50%" className={inputCls} />
              </Field>
            </SettingsField>
          </>
        )}

        {/* ── Auto-Archiving ── */}
        {activeTab === "auto_archive" && (
          <SettingsField label="Auto-Archiving" icon={Archive} description="Automatically archive inactive products after a period of inactivity">
            <div className="space-y-4">
              <ToggleSwitch
                checked={form.auto_archive_enabled}
                onChange={(v) => updateField("auto_archive_enabled", v)}
                label="Enable auto-archiving"
                description="Inactive products older than the threshold are archived automatically"
              />
              <Field label="Archive after (days)">
                <input type="number" min="1" value={form.auto_archive_days} onChange={(e) => updateField("auto_archive_days", e.target.value)}
                  placeholder="e.g. 90" disabled={!form.auto_archive_enabled}
                  className={`${inputCls} disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed`} />
              </Field>
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-100 text-xs text-amber-700 flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                {form.auto_archive_enabled
                  ? `Inactive products will be archived after ${form.auto_archive_days || "—"} day(s) of inactivity.`
                  : "Auto-archiving is currently disabled."}
              </div>
            </div>
          </SettingsField>
        )}

        {/* ── Meter Event Logs ── */}
        {activeTab === "meter_logs" && (
          <>
            <SettingsField label="Usage Billing Default Unit" icon={BarChart3} description="Default metering unit for usage-based products">
              <Field label="Unit">
                <select value={form.usage_billing_unit} onChange={(e) => updateField("usage_billing_unit", e.target.value)} className={inputCls}>
                  <option value="unit">Per Unit</option>
                  <option value="hour">Per Hour</option>
                  <option value="day">Per Day</option>
                  <option value="mb">Per MB</option>
                  <option value="gb">Per GB</option>
                  <option value="api_call">Per API Call</option>
                  <option value="user">Per User</option>
                  <option value="license">Per License</option>
                </select>
              </Field>
            </SettingsField>
            <SettingsField label="Usage Billing Rounding" icon={BarChart3} description="How partial usage units are rounded for billing">
              <Field label="Rounding">
                <select value={form.usage_billing_rounding} onChange={(e) => updateField("usage_billing_rounding", e.target.value)} className={inputCls}>
                  <option value="nearest">Nearest Unit</option>
                  <option value="up">Round Up</option>
                  <option value="down">Round Down</option>
                </select>
              </Field>
            </SettingsField>
            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2">
                <ScrollText size={16} className="text-brand" />
                <h3 className="text-base font-semibold text-slate-800">Configured Meters</h3>
                <span className="text-xs text-slate-500 ml-auto">{usageProducts.length} meter(s) active</span>
              </div>
              <div className="divide-y divide-slate-50">
                {usageProducts.length === 0 && (
                  <p className="px-6 py-8 text-sm text-slate-500 text-center">No meters configured yet. Visit Usage Billing to create one.</p>
                )}
                {usageProducts.map((p) => (
                  <div key={p.id} className="px-6 py-3 flex items-center gap-3 hover:bg-slate-50/70 transition-colors">
                    <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center">
                      <BarChart3 size={14} className="text-white" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-slate-800 truncate">{p.name}</p>
                      {p.code && <p className="text-xs text-slate-500 font-mono">{p.code}</p>}
                    </div>
                    <span className="text-xs text-slate-500">{p.unit_label || "unit"}</span>
                    <span className="text-xs font-mono text-slate-500">{p.default_price || 0} {p.currency || baseCurrency}</span>
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${p.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${p.status === "active" ? "bg-emerald-500" : "bg-slate-400"}`} />
                      {p.status || "inactive"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── Portal Display ── */}
        {activeTab === "portal" && (
          <SettingsField label="Portal Display" icon={Store} description="How products are presented in customer-facing catalogs and listings">
            <div className="space-y-4">
              <Field label="Default visibility">
                <select value={form.product_visibility} onChange={(e) => updateField("product_visibility", e.target.value)} className={inputCls}>
                  <option value="visible">Visible</option>
                  <option value="hidden">Hidden</option>
                </select>
              </Field>
              <ToggleSwitch
                checked={form.require_sku === "yes"}
                onChange={(v) => updateField("require_sku", v ? "yes" : "no")}
                label="Require SKU on new products"
                description="SKU becomes mandatory when creating products"
              />
              <div className="p-4 rounded-xl bg-violet-50 border border-violet-100">
                <div className="flex items-center gap-2 text-sm font-medium text-violet-800">
                  <Eye size={16} /> Visibility preview
                </div>
                <p className="text-xs text-violet-600 mt-1.5">
                  New products will be <strong>{form.product_visibility === "visible" ? "visible" : "hidden"}</strong> in catalogs and listings
                  {form.require_sku === "yes" ? " and a SKU will be required" : " and SKU stays optional"}.
                </p>
              </div>
            </div>
          </SettingsField>
        )}
      </div>

      {/* ── Sticky Save Bar ── */}
      <div className="fixed bottom-0 left-0 right-0 lg:left-72 z-40 bg-white/90 backdrop-blur border-t border-slate-200 px-4 sm:px-6 py-3 shadow-[0_-4px_20px_rgba(0,0,0,0.04)]">
        <div className="flex flex-wrap items-center justify-between gap-3 max-w-6xl mx-auto">
          <div className="flex items-center gap-2 min-w-0">
            {hasChanges ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-amber-700">
                <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" /> You have unsaved changes
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm text-slate-500">All changes saved</span>
            )}
            {saved && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 bg-emerald-50 rounded-lg">
                <CheckCircle className="h-4 w-4" /> Saved
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={fetchSettings}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
            <button onClick={discardChanges} disabled={!hasChanges}
              className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Discard
            </button>
            <button onClick={handleSave} disabled={!hasChanges || saving}
              className="inline-flex items-center gap-1.5 px-5 py-2 text-sm font-medium text-white bg-gradient-to-r from-brand to-brand-hover rounded-xl hover:shadow-lg disabled:opacity-50 transition-all">
              {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Save className="h-4 w-4" />}
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </HRPage>
  );
}
