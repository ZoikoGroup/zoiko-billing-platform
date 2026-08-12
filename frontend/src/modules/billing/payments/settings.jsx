import { useState, useEffect, useRef } from "react";
import {
  Save, RefreshCw, AlertCircle, CheckCircle, Hash, ToggleLeft,
  DollarSign, Percent, Clock, FileText, CreditCard, Ban, Repeat, Bell,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { settingsApi } from "../../../service/billingService";
import { getCurrencySelectOptions } from "../../../utils/currency";

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

export default function PaymentSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const timerRef = useRef(null);

  const [form, setForm] = useState({
    default_payment_prefix: "PAY-",
    payment_number_format: "{PREFIX}{NUMBER}",
    auto_generate_payment_number: true,
    default_payment_gateway: "stripe",
    payment_currency: "USD",
    auto_reconcile: true,
    reconciliation_threshold: "0.50",
    enable_partial_payments: true,
    partial_payment_min_percent: "10",
    payment_terms_days: "0",
    enable_dunning: true,
    dunning_max_attempts: "3",
    dunning_interval_days: "3",
    dunning_escalation_days: "15",
    enable_collections: true,
    collections_auto_assign: false,
    default_collection_priority: "normal",
    require_credit_card: true,
    payment_method_verification: true,
    refund_policy: "within_30_days",
    max_refund_days: "30",
    auto_refund_on_cancel: false,
    enable_receipts: true,
    receipt_email_subject: "Payment Receipt",
    payment_notes: "",
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
        default_payment_prefix: settings.default_payment_prefix || "PAY-",
        payment_number_format: settings.payment_number_format || "{PREFIX}{NUMBER}",
        auto_generate_payment_number: settings.auto_generate_payment_number ?? true,
        default_payment_gateway: settings.default_payment_gateway || "stripe",
        payment_currency: settings.payment_currency || "USD",
        auto_reconcile: settings.auto_reconcile ?? true,
        reconciliation_threshold: settings.reconciliation_threshold || "0.50",
        enable_partial_payments: settings.enable_partial_payments ?? true,
        partial_payment_min_percent: settings.partial_payment_min_percent || "10",
        payment_terms_days: settings.payment_terms_days || "0",
        enable_dunning: settings.enable_dunning ?? true,
        dunning_max_attempts: settings.dunning_max_attempts || "3",
        dunning_interval_days: settings.dunning_interval_days || "3",
        dunning_escalation_days: settings.dunning_escalation_days || "15",
        enable_collections: settings.enable_collections ?? true,
        collections_auto_assign: settings.collections_auto_assign ?? false,
        default_collection_priority: settings.default_collection_priority || "normal",
        require_credit_card: settings.require_credit_card ?? true,
        payment_method_verification: settings.payment_method_verification ?? true,
        refund_policy: settings.refund_policy || "within_30_days",
        max_refund_days: settings.max_refund_days || "30",
        auto_refund_on_cancel: settings.auto_refund_on_cancel ?? false,
        enable_receipts: settings.enable_receipts ?? true,
        receipt_email_subject: settings.receipt_email_subject || "Payment Receipt",
        payment_notes: settings.payment_notes || "",
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
      <HRPage title="Payment Settings" subtitle="Configure payment module preferences">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      </HRPage>
    );
  }

  const numberingPreview = form.payment_number_format
    .replace("{PREFIX}", form.default_payment_prefix)
    .replace("{NUMBER}", "0001");

  return (
    <HRPage title="Payment Settings" subtitle="Configure payment module preferences">
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
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SettingsField label="Payment Numbering Prefix" icon={Hash} description="Prefix used when auto-generating payment numbers">
            <input type="text" value={form.default_payment_prefix} onChange={(e) => updateField("default_payment_prefix", e.target.value)}
              className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </SettingsField>

          <SettingsField label="Payment Numbering Format" icon={Hash} description="Number format. Use {PREFIX} and {NUMBER} as placeholders">
            <input type="text" value={form.payment_number_format} onChange={(e) => updateField("payment_number_format", e.target.value)}
              className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
            <p className="mt-1 text-xs text-gray-400">Preview: {numberingPreview}</p>
          </SettingsField>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SettingsField label="Auto-Generate Payment Numbers" icon={ToggleLeft} description="Automatically generate payment numbers">
            <select value={String(form.auto_generate_payment_number)} onChange={(e) => updateField("auto_generate_payment_number", e.target.value === "true")}
              className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          </SettingsField>

          <SettingsField label="Default Payment Gateway" icon={CreditCard} description="Default payment gateway for processing payments">
            <select value={form.default_payment_gateway} onChange={(e) => updateField("default_payment_gateway", e.target.value)}
              className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
              <option value="stripe">Stripe</option>
              <option value="paypal">PayPal</option>
              <option value="square">Square</option>
              <option value="braintree">Braintree</option>
              <option value="authorize_net">Authorize.Net</option>
              <option value="manual">Manual / Offline</option>
            </select>
          </SettingsField>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SettingsField label="Payment Currency" icon={DollarSign} description="Default currency for processing payments">
            <select value={form.payment_currency} onChange={(e) => updateField("payment_currency", e.target.value)}
              className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
              {getCurrencySelectOptions().map((c) => (
                <option key={c.value} value={c.value}>{c.value} - {c.label}</option>
              ))}
            </select>
          </SettingsField>

          <SettingsField label="Payment Terms (Days)" icon={Clock} description="Default payment terms in days from invoice date">
            <input type="number" min="0" value={form.payment_terms_days} onChange={(e) => updateField("payment_terms_days", e.target.value)}
              className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </SettingsField>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SettingsField label="Auto-Reconcile Payments" icon={ToggleLeft} description="Automatically reconcile payments with invoices">
            <select value={String(form.auto_reconcile)} onChange={(e) => updateField("auto_reconcile", e.target.value === "true")}
              className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          </SettingsField>

          <SettingsField label="Reconciliation Threshold" icon={DollarSign} description="Maximum difference (in currency) allowed for auto-reconciliation">
            <input type="number" min="0" step="0.01" value={form.reconciliation_threshold} onChange={(e) => updateField("reconciliation_threshold", e.target.value)}
              className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </SettingsField>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SettingsField label="Enable Partial Payments" icon={Percent} description="Allow customers to make partial payments on invoices">
            <select value={String(form.enable_partial_payments)} onChange={(e) => updateField("enable_partial_payments", e.target.value === "true")}
              className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          </SettingsField>

          <SettingsField label="Partial Payment Min %" icon={Percent} description="Minimum percentage required for a partial payment">
            <input type="number" min="1" max="99" value={form.partial_payment_min_percent} onChange={(e) => updateField("partial_payment_min_percent", e.target.value)}
              className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </SettingsField>
        </div>

        <div className="border-t border-gray-200 pt-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Dunning Configuration</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <SettingsField label="Enable Dunning" icon={Bell} description="Automatically retry failed payments and send reminders">
              <select value={String(form.enable_dunning)} onChange={(e) => updateField("enable_dunning", e.target.value === "true")}
                className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </SettingsField>

            <SettingsField label="Max Dunning Attempts" icon={Repeat} description="Maximum number of dunning attempts before escalation">
              <input type="number" min="1" max="10" value={form.dunning_max_attempts} onChange={(e) => updateField("dunning_max_attempts", e.target.value)}
                className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </SettingsField>

            <SettingsField label="Dunning Interval (Days)" icon={Clock} description="Days between dunning attempts">
              <input type="number" min="1" value={form.dunning_interval_days} onChange={(e) => updateField("dunning_interval_days", e.target.value)}
                className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </SettingsField>

            <SettingsField label="Escalation Days" icon={Clock} description="Days after first attempt before escalating to collections">
              <input type="number" min="1" value={form.dunning_escalation_days} onChange={(e) => updateField("dunning_escalation_days", e.target.value)}
                className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </SettingsField>
          </div>
        </div>

        <div className="border-t border-gray-200 pt-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Collections Configuration</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <SettingsField label="Enable Collections" icon={Bell} description="Enable collections case management">
              <select value={String(form.enable_collections)} onChange={(e) => updateField("enable_collections", e.target.value === "true")}
                className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </SettingsField>

            <SettingsField label="Auto-Assign Cases" icon={ToggleLeft} description="Automatically assign new collections cases to team members">
              <select value={String(form.collections_auto_assign)} onChange={(e) => updateField("collections_auto_assign", e.target.value === "true")}
                className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </SettingsField>

            <SettingsField label="Default Collection Priority" icon={ToggleLeft} description="Default priority for new collections cases">
              <select value={form.default_collection_priority} onChange={(e) => updateField("default_collection_priority", e.target.value)}
                className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </SettingsField>
          </div>
        </div>

        <div className="border-t border-gray-200 pt-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Refund & Receipt Configuration</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <SettingsField label="Refund Policy" icon={FileText} description="Default refund policy for processing refunds">
              <select value={form.refund_policy} onChange={(e) => updateField("refund_policy", e.target.value)}
                className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="no_refunds">No Refunds</option>
                <option value="within_7_days">Within 7 Days</option>
                <option value="within_14_days">Within 14 Days</option>
                <option value="within_30_days">Within 30 Days</option>
                <option value="within_90_days">Within 90 Days</option>
                <option value="anytime">Anytime</option>
              </select>
            </SettingsField>

            <SettingsField label="Max Refund Period (Days)" icon={Clock} description="Maximum days from payment date to process a refund">
              <input type="number" min="0" value={form.max_refund_days} onChange={(e) => updateField("max_refund_days", e.target.value)}
                className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </SettingsField>

            <SettingsField label="Auto-Refund on Cancel" icon={Ban} description="Automatically issue refund when a payment is cancelled">
              <select value={String(form.auto_refund_on_cancel)} onChange={(e) => updateField("auto_refund_on_cancel", e.target.value === "true")}
                className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </SettingsField>

            <SettingsField label="Enable Receipts" icon={FileText} description="Send payment receipts to customers">
              <select value={String(form.enable_receipts)} onChange={(e) => updateField("enable_receipts", e.target.value === "true")}
                className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </SettingsField>

            <SettingsField label="Receipt Email Subject" icon={FileText} description="Subject line for payment receipt emails">
              <input type="text" value={form.receipt_email_subject} onChange={(e) => updateField("receipt_email_subject", e.target.value)}
                className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </SettingsField>

            <SettingsField label="Require Credit Card" icon={CreditCard} description="Require a credit card for payment processing">
              <select value={String(form.require_credit_card)} onChange={(e) => updateField("require_credit_card", e.target.value === "true")}
                className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                <option value="true">Required</option>
                <option value="false">Not Required</option>
              </select>
            </SettingsField>
          </div>
        </div>

        <SettingsField label="Payment Notes" icon={FileText} description="Default notes displayed on payment pages">
          <textarea value={form.payment_notes} onChange={(e) => updateField("payment_notes", e.target.value)}
            rows={3} placeholder="Standard payment notes..."
            className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </SettingsField>
      </div>
    </HRPage>
  );
}
