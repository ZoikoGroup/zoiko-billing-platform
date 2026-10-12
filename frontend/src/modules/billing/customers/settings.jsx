import { useState, useEffect, useRef, Children, cloneElement, isValidElement, useId } from "react";
import { Save, RefreshCw, AlertCircle, CheckCircle, Users, Hash, Bell, FileText, CreditCard } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { settingsApi, invalidateConfigCache } from "../../../service/billingService";
import { invalidateGlobalBillingConfig } from "../../../service/billingConfigCache";
import { ErrorState } from "../../../components/billing-shared";
import ConfirmDialog from "../../../components/ConfirmDialog";

const FRONTEND_TO_BACKEND = {
  default_customer_type: "default_customer_type",
  customer_numbering_prefix: "customer_numbering_prefix",
  customer_numbering_format: "customer_numbering_format",
  default_payment_terms: "default_payment_terms",
  credit_limit: "credit_limit",
  customer_notification: "notify_customer_created",
  auto_suspend_days: "grace_period_days",
  require_billing_address: "require_billing_address",
  require_tax_id: "require_tax_id",
};

// Canonical values from the backend enums (CustomerType, NumberFormat).
export const CUSTOMER_TYPE_OPTIONS = [
  { value: "business", label: "Business" },
  { value: "individual", label: "Individual" },
  { value: "non_profit", label: "Non-Profit" },
  { value: "government", label: "Government" },
];
// The document-numbering grammar the server renders (render_document_number):
// the prefix carries its own separator, {SEQ} is a 5-digit counter.
export const NUMBER_FORMAT_OPTIONS = [
  { value: "PREFIX-{SEQ}", label: "Prefix + number", example: (p) => `${p}00001` },
  { value: "PREFIX-{YYYY}-{SEQ}", label: "Prefix + year + number", example: (p, d) => `${p}${d.y}-00001` },
  { value: "PREFIX-{YYYYMM}-{SEQ}", label: "Prefix + year-month + number", example: (p, d) => `${p}${d.y}${d.m}-00001` },
  { value: "PREFIX-{YYYY}-{MM}-{SEQ}", label: "Prefix + year + month + number", example: (p, d) => `${p}${d.y}-${d.m}-00001` },
  { value: "PREFIX-{MM}-{YYYY}-{SEQ}", label: "Prefix + month + year + number", example: (p, d) => `${p}${d.m}-${d.y}-00001` },
];
// Same rule as the server (validate_customer_prefix): optional, <= 10 chars.
export function prefixError(prefix) {
  if (!prefix) return null;
  if (prefix.length > 10) return "Use 10 characters or fewer.";
  if (!/^[A-Za-z0-9\-_]+$/.test(prefix)) return "Use only letters, numbers, hyphens and underscores.";
  return null;
}

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
    if (frontKey === "customer_notification" || frontKey === "require_billing_address" || frontKey === "require_tax_id") {
      val = val === "yes";
    }
    payload[backKey] = val;
  }
  return payload;
}

// BUG-13: these five settings are stored server-side (BillingConfiguration
// columns). Fallbacks apply only when a key is absent from the response.
function toForm(settings) {
  return {
    default_customer_type: settings.default_customer_type || "business",
    customer_numbering_prefix: settings.customer_numbering_prefix ?? "CUST-",
    customer_numbering_format: settings.customer_numbering_format || "PREFIX-{SEQ}",
    default_payment_terms: settings.default_payment_terms || "net_30",
    credit_limit: settings.credit_limit != null ? String(settings.credit_limit) : "",
    customer_notification: settings.notify_customer_created ? "yes" : "no",
    auto_suspend_days: settings.grace_period_days != null ? String(settings.grace_period_days) : "",
    require_billing_address: settings.require_billing_address ? "yes" : "no",
    require_tax_id: settings.require_tax_id ? "yes" : "no",
  };
}

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
    <div role={controlId ? undefined : "group"} aria-labelledby={controlId ? undefined : labelId} className="bg-white border border-slate-200 rounded-2xl p-6">
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

const DEFAULTS = {
  default_customer_type: "business",
  customer_numbering_prefix: "CUST-",
  customer_numbering_format: "PREFIX-{SEQ}",
  default_payment_terms: "net_30",
  credit_limit: "",
  customer_notification: "yes",
  auto_suspend_days: "",
  require_billing_address: "no",
  require_tax_id: "no",
};

export default function CustomerSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const timerRef = useRef(null);

  const [form, setForm] = useState(DEFAULTS);
  const [original, setOriginal] = useState(DEFAULTS);

  const hasChanges = Object.keys(form).some((key) => form[key] !== original[key]);
  const [confirmRefresh, setConfirmRefresh] = useState(false);

  // Refresh replaces the form with the saved values, so unsaved edits must
  // be confirmed before they are thrown away (same as pricing/quotation settings).
  const handleRefresh = () => {
    if (hasChanges) setConfirmRefresh(true);
    else fetchSettings();
  };

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
      setLoadFailed(false);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load settings");
      setLoadFailed(true);
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
      // The customer create form (and other config readers) must see the new
      // default type / numbering / requirements on their next read, not a
      // cached snapshot (same as Product Settings).
      invalidateConfigCache();
      invalidateGlobalBillingConfig();
      setOriginal({ ...form });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  const prefixProblem = prefixError(form.customer_numbering_prefix);
  const now = new Date();
  const dateParts = { y: String(now.getFullYear()), m: String(now.getMonth() + 1).padStart(2, "0") };
  const formatOption = NUMBER_FORMAT_OPTIONS.find((o) => o.value === form.customer_numbering_format) || NUMBER_FORMAT_OPTIONS[0];
  const exampleCode = formatOption.example(form.customer_numbering_prefix || "", dateParts);

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

  // A failed load must not render editable defaults: Save would overwrite the
  // real payment terms / credit limit / notification settings with them.
  if (loadFailed) {
    return (
      <HRPage title="Customer Settings" subtitle="Customer configuration and preferences">
        <ErrorState title="Couldn't load customer settings" message={error} onRetry={fetchSettings} />
      </HRPage>
    );
  }

  return (
    <HRPage title="Customer Settings" subtitle="Customer configuration and preferences">

      <div className="flex flex-wrap items-center justify-end gap-2 mb-6">
          {saved && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 bg-emerald-50 rounded-lg">
              <CheckCircle className="h-4 w-4" /> Saved
            </span>
          )}
          <button onClick={handleRefresh}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button onClick={handleSave} disabled={!hasChanges || saving || Boolean(prefixProblem)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
            {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Save className="h-4 w-4" />}
            Save Changes
          </button>
      </div>

      {confirmRefresh && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message="Refreshing reloads the saved customer settings and discards your unsaved edits."
          confirmLabel="Discard & refresh"
          onConfirm={() => { setConfirmRefresh(false); fetchSettings(); }}
          onClose={() => setConfirmRefresh(false)}
        />
      )}

      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="space-y-6">
        <SettingsField label="Default Customer Type" icon={Users} description="Type pre-selected for new customers (used when none is chosen)">
          <select aria-label="Default customer type" value={form.default_customer_type} onChange={(e) => updateField("default_customer_type", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            {CUSTOMER_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </SettingsField>

        <SettingsField label="Customer Numbering Prefix" icon={Hash} description="Start of customer codes the server assigns when a code is left blank">
          <input type="text" aria-label="Customer numbering prefix" maxLength={10} value={form.customer_numbering_prefix}
            onChange={(e) => updateField("customer_numbering_prefix", e.target.value)}
            aria-invalid={prefixProblem ? "true" : undefined} aria-describedby="customer-prefix-hint"
            className={`block w-full max-w-xs rounded-lg border px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 ${prefixProblem ? "border-red-400 focus:ring-red-200" : "border-slate-300 focus:border-brand-300 focus:ring-brand/30"}`} />
          <p id="customer-prefix-hint" role={prefixProblem ? "alert" : undefined} className={`mt-1 text-xs ${prefixProblem ? "text-red-600" : "text-slate-500"}`}>
            {prefixProblem || "Up to 10 letters, numbers, hyphens or underscores. Include your own separator, e.g. CUST-."}
          </p>
        </SettingsField>

        <SettingsField label="Customer Numbering Format" icon={Hash} description="How server-assigned customer codes are built">
          <select aria-label="Customer numbering format" value={form.customer_numbering_format} onChange={(e) => updateField("customer_numbering_format", e.target.value)}
            aria-describedby="customer-format-example"
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            {NUMBER_FORMAT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p id="customer-format-example" className="mt-1 text-xs text-slate-500">
            Example: <span className="font-mono text-slate-700">{exampleCode}</span>. Existing customer codes never change; a code typed on the create form is kept as entered.
          </p>
        </SettingsField>

        <SettingsField label="Default Payment Terms" icon={CreditCard} description="Default payment terms assigned to new customers">
          <select aria-label="Default payment terms" value={form.default_payment_terms} onChange={(e) => updateField("default_payment_terms", e.target.value)}
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
          <input type="number" aria-label="Default credit limit" min="0" step="0.01" value={form.credit_limit} onChange={(e) => updateField("credit_limit", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Auto-Suspend After (Days)" icon={Bell} description="Automatically suspend customer after N days of payment overdue (leave empty to disable)">
          <input type="number" aria-label="Auto-suspend after days" min="1" value={form.auto_suspend_days} onChange={(e) => updateField("auto_suspend_days", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField label="Customer Notifications" icon={Bell} description="Send billing notifications to customers">
          <select aria-label="Customer notifications" value={form.customer_notification} onChange={(e) => updateField("customer_notification", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="yes">Enabled</option>
            <option value="no">Disabled</option>
          </select>
        </SettingsField>

        <SettingsField label="Require Billing Address" icon={FileText} description="When required, new customers can't be created without a billing address. Existing customers are not affected.">
          <select aria-label="Require billing address" value={form.require_billing_address} onChange={(e) => updateField("require_billing_address", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="no">Optional</option>
            <option value="yes">Required for new customers</option>
          </select>
        </SettingsField>

        <SettingsField label="Require Tax ID" icon={FileText} description="When required, new customers need at least one tax identifier (GST, VAT, PAN, TIN or other tax ID). Existing customers are not affected.">
          <select aria-label="Require tax ID" value={form.require_tax_id} onChange={(e) => updateField("require_tax_id", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="no">Optional</option>
            <option value="yes">Required for new customers</option>
          </select>
        </SettingsField>
      </div>
    </HRPage>
  );
}
