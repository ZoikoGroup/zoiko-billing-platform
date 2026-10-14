import { useState, useEffect, Children, cloneElement, isValidElement, useId } from "react";
import {
  Save, RefreshCw, AlertCircle, CheckCircle, Hash, DollarSign, FileText, Image, Loader2,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { ErrorState } from "../../../components/billing-shared";
import ConfirmDialog from "../../../components/ConfirmDialog";
import { settingsApi } from "../../../service/billingService";
import { getCurrencySelectOptions } from "../../../utils/currency";
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
    <div role={controlId ? undefined : "group"} aria-labelledby={controlId ? undefined : labelId} className="bg-white border border-slate-200 rounded-3xl p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
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

export default function QuotationSettingsPage() {
  const { singular } = useTerminology();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmRefresh, setConfirmRefresh] = useState(false);

  const [form, setForm] = useState({
    quote_prefix: "QOT-",
    quote_number_format: "PREFIX-{YYYY}-{SEQ}",
    quote_sequence_reset: "annually",
    default_currency: "USD",
    default_terms_and_conditions: "",
    quote_logo_url: "",
    quotation_extra_settings: {
      require_customer_acceptance: true,
      discount_approval_threshold: "",
      expiry_reminder_days: "",
    },
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
        // BillingConfiguration's real fields are `quote_prefix` and
        // `quote_terms_and_conditions` -- this page previously read/wrote
        // `default_quote_prefix`/`terms_and_conditions`, neither of which
        // exists on the schema, so both silently never persisted.
        quote_prefix: settings.quote_prefix || "QOT-",
        quote_number_format: settings.quote_number_format || "PREFIX-{YYYY}-{SEQ}",
        quote_sequence_reset: settings.quote_sequence_reset || "annually",
        default_currency: settings.default_currency,
        default_terms_and_conditions: settings.quote_terms_and_conditions || "",
        quote_logo_url: settings.logo_url || "",
        quotation_extra_settings: {
          require_customer_acceptance: settings.quotation_extra_settings?.require_customer_acceptance ?? true,
          discount_approval_threshold: settings.quotation_extra_settings?.discount_approval_threshold ?? "",
          expiry_reminder_days: settings.quotation_extra_settings?.expiry_reminder_days ?? "",
        },
      };
      setForm(values);
      setOriginal({ ...values });
      setLoadFailed(false);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load settings");
      setLoadFailed(true);
    } finally { setLoading(false); }
  }

  async function saveSettings() {
    if (!hasChanges && !saving) return;
    try {
      setSaving(true);
      setError(null);
      const payload = {
        quote_prefix: form.quote_prefix,
        quote_number_format: form.quote_number_format,
        quote_sequence_reset: form.quote_sequence_reset,
        default_currency: form.default_currency,
        // Cleared fields are sent as null (the API applies explicit nulls).
        // `|| undefined` dropped them from the JSON, so clearing the terms or
        // logo showed "Saved" while the old value stayed on the server.
        quote_terms_and_conditions: form.default_terms_and_conditions?.trim() ? form.default_terms_and_conditions : null,
        logo_url: form.quote_logo_url?.trim() ? form.quote_logo_url.trim() : null,
        quotation_extra_settings: {
          require_customer_acceptance: form.quotation_extra_settings.require_customer_acceptance,
          discount_approval_threshold: form.quotation_extra_settings.discount_approval_threshold === ""
            ? null
            : Number(form.quotation_extra_settings.discount_approval_threshold),
          expiry_reminder_days: form.quotation_extra_settings.expiry_reminder_days === ""
            ? null
            : Number(form.quotation_extra_settings.expiry_reminder_days),
        },
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

  function updateQuotationPreference(key, value) {
    setForm((f) => ({
      ...f,
      quotation_extra_settings: { ...f.quotation_extra_settings, [key]: value },
    }));
  }

  // Refresh replaces the form with the saved values, so unsaved edits must
  // be confirmed before they are thrown away.
  function handleRefresh() {
    if (hasChanges) setConfirmRefresh(true);
    else fetchSettings();
  }

  if (loading) {
    return (
      <HRPage title="Quotation Settings" subtitle="Loading settings...">
        <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-brand-600" /></div>
      </HRPage>
    );
  }

  // Never render an editable form built from hard-coded defaults: if the
  // saved configuration could not be loaded, Save would write those
  // defaults over the organization's real settings (same guard as
  // invoicing/settings.jsx and tax/settings.jsx).
  if (loadFailed) {
    return (
      <HRPage title="Quotation Settings" subtitle="Configure quotation defaults and behavior">
        <ErrorState title="Couldn't load quotation settings" message={error} onRetry={fetchSettings} />
      </HRPage>
    );
  }

  return (
    <HRPage title="Quotation Settings" subtitle="Configure quotation defaults and behavior">

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
        <button onClick={saveSettings} disabled={!hasChanges || saving}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
          {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Save className="h-4 w-4" />}
          Save Changes
        </button>
      </div>

      {confirmRefresh && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message="Refreshing reloads the saved quotation settings and discards your unsaved edits."
          confirmLabel="Discard & refresh"
          onConfirm={() => { setConfirmRefresh(false); fetchSettings(); }}
          onClose={() => setConfirmRefresh(false)}
        />
      )}

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
            aria-label="Quote number prefix"
            value={form.quote_prefix}
            onChange={(e) => updateField("quote_prefix", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </SettingsField>

        <SettingsField
          label="Quote Number Format"
          icon={Hash}
          description="Number pattern used for automatically generated quotations"
        >
          <select aria-label="Quote number format" value={form.quote_number_format} onChange={(e) => updateField("quote_number_format", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="PREFIX-{SEQ}">Simple sequential</option>
            <option value="PREFIX-{YYYY}-{SEQ}">Year and sequence</option>
            <option value="PREFIX-{YYYYMM}-{SEQ}">Year-month and sequence</option>
            <option value="PREFIX-{YYYY}-{MM}-{SEQ}">Year-month sequence</option>
            <option value="PREFIX-{MM}-{YYYY}-{SEQ}">Month-year sequence</option>
          </select>
        </SettingsField>

        <SettingsField
          label="Quote Sequence Reset"
          icon={Hash}
          description="When the quotation number sequence resets"
        >
          <select aria-label="Quote sequence reset" value={form.quote_sequence_reset} onChange={(e) => updateField("quote_sequence_reset", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="never">Never</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="annually">Annually</option>
          </select>
        </SettingsField>

        <SettingsField
          label="Customer Acceptance Required"
          icon={CheckCircle}
          description={`Require ${singular.toLowerCase()} acceptance before converting a quotation to an invoice`}
        >
          <select aria-label="Customer acceptance required"
            value={String(form.quotation_extra_settings.require_customer_acceptance)}
            onChange={(e) => updateQuotationPreference("require_customer_acceptance", e.target.value === "true")}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="true">Required</option>
            <option value="false">Not required</option>
          </select>
        </SettingsField>

        <SettingsField
          label="Discount Approval Threshold"
          icon={DollarSign}
          description="Require an organization admin to send quotations with larger discounts; leave empty to disable"
        >
          <div className="flex max-w-xs items-center gap-2">
            <input type="number" min="0" max="100" step="0.01" aria-label="Discount approval threshold"
              value={form.quotation_extra_settings.discount_approval_threshold}
              onChange={(e) => updateQuotationPreference("discount_approval_threshold", e.target.value)}
              className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
            <span className="text-sm text-slate-500">%</span>
          </div>
        </SettingsField>

        <SettingsField
          label="Expiry Reminder Days"
          icon={AlertCircle}
          description="Send a reminder this many days before the quotation expires; leave empty to disable"
        >
          <input type="number" min="1" max="90" step="1" aria-label="Expiry reminder days"
            value={form.quotation_extra_settings.expiry_reminder_days}
            onChange={(e) => updateQuotationPreference("expiry_reminder_days", e.target.value)}
            className="block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>

        <SettingsField
          label="Default Currency"
          icon={DollarSign}
          description="Default currency for new quotations"
        >
          <select aria-label="Default quotation currency" value={form.default_currency} onChange={(e) => updateField("default_currency", e.target.value)}
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
            aria-label="Default terms and conditions"
            value={form.default_terms_and_conditions}
            onChange={(e) => updateField("default_terms_and_conditions", e.target.value)}
            rows={6}
            placeholder="Payment terms, delivery terms, validity..."
            className="block w-full max-w-2xl rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </SettingsField>

        <SettingsField
          label="Quotation Logo"
          icon={Image}
          description="Logo URL displayed on quotation documents (optional)"
        >
          <input
            type="url"
            aria-label="Quotation logo URL"
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
              <h3 className="text-base font-semibold text-slate-800">Planned Quotation Controls</h3>
              <p className="text-xs text-slate-500 mt-0.5">These controls are planned and are not available yet.</p>
            </div>
          </div>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-slate-500" aria-label="Planned quotation controls">
            {[
              { name: "Auto-Approval Workflow", desc: "Require approval before sending quotations" },
              { name: "Version History", desc: "Track quotation revisions automatically" },
            ].map((item) => (
              <li key={item.name} className="bg-white p-3 rounded-lg border border-slate-200">
                <p className="font-medium text-slate-600">{item.name}</p>
                <p className="mt-1">{item.desc}</p>
              </li>
            ))}
          </ul>
        </div>

      </div>
    </HRPage>
  );
}