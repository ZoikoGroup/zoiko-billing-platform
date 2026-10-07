import { useCallback, useEffect, useState } from "react";
import {
  CreditCard, Link2, Unlink, RefreshCw, CheckCircle, AlertCircle,
  AlertTriangle, Clock, Globe, ShieldCheck, Loader2, ExternalLink,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { stripeConnectApi } from "../../../service/billingService";

// Mirrors backend IntegrationConnectionStatus (app/modules/billing/models.py)
// — normalized Zoiko-level status derived from Stripe's own account fields.
const STATUS_META = {
  pending_onboarding: { label: "Not Connected", tone: "slate", icon: Link2 },
  onboarding_incomplete: { label: "Onboarding Incomplete", tone: "amber", icon: Clock },
  action_required: { label: "Action Required", tone: "amber", icon: AlertTriangle },
  active: { label: "Connected", tone: "green", icon: CheckCircle },
  restricted: { label: "Restricted", tone: "red", icon: AlertTriangle },
  disabled: { label: "Disabled", tone: "red", icon: AlertCircle },
  disconnected: { label: "Disconnected", tone: "slate", icon: Unlink },
};

const TONE_CLASSES = {
  slate: "bg-slate-100 text-slate-600 border-slate-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  green: "bg-emerald-50 text-emerald-700 border-emerald-200",
  red: "bg-red-50 text-red-700 border-red-200",
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status || "Unknown", tone: "slate", icon: AlertCircle };
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold border ${TONE_CLASSES[meta.tone]}`}>
      <Icon className="h-4 w-4" />
      {meta.label}
    </span>
  );
}

function DetailRow({ label, value, mono }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-slate-100 last:border-b-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className={`text-sm font-medium text-slate-800 ${mono ? "font-mono" : ""}`}>{value ?? "—"}</span>
    </div>
  );
}

function BoolChip({ value }) {
  return value ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
      <CheckCircle className="h-3 w-3" /> Yes
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-red-50 text-red-600 border border-red-200">
      <AlertCircle className="h-3 w-3" /> No
    </span>
  );
}

function fmtDateTime(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const CALLBACK_PATH = "/billing/payments/stripe-connect/callback";

export default function StripeConnectSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [saved, setSaved] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await stripeConnectApi.getStatus();
      setStatus(data);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load Stripe Connect status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  async function handleConnect() {
    try {
      setConnecting(true);
      setError(null);
      const redirectUri = `${window.location.origin}${CALLBACK_PATH}`;
      const result = await stripeConnectApi.getOnboardingUrl(redirectUri);
      if (result?.url) {
        window.location.href = result.url;
        return;
      }
      setError("Stripe did not return an onboarding URL. Please try again.");
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to start Stripe onboarding");
    } finally {
      setConnecting(false);
    }
  }

  async function handleSync() {
    try {
      setSyncing(true);
      setError(null);
      const data = await stripeConnectApi.sync();
      setStatus(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to sync Stripe status");
    } finally {
      setSyncing(false);
    }
  }

  async function handleDisconnect() {
    const confirmed = window.confirm(
      "Disconnect this Stripe account? Zoiko will stop routing payments through it immediately. You can reconnect (the same or a different account) at any time."
    );
    if (!confirmed) return;
    try {
      setDisconnecting(true);
      setError(null);
      const data = await stripeConnectApi.disconnect();
      setStatus(data);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to disconnect Stripe account");
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <HRPage title="Stripe Connect" subtitle="Connect your Stripe account to accept card payments from customers">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      </HRPage>
    );
  }

  const isActive = status?.status === "active";
  // Platform-level setting: when Connect isn't enabled, onboarding can't start.
  const connectUnavailable = status?.connect_configured === false;
  const isConnected = Boolean(status?.connected) || (status?.status && status.status !== "pending_onboarding" && status.status !== "disconnected");
  const requirements = Array.isArray(status?.requirements_currently_due) ? status.requirements_currently_due : [];

  return (
    <HRPage title="Stripe Connect" subtitle="Connect your Stripe account to accept card payments from customers">
      <div className="flex items-center justify-between mb-6">
        <div />
        <div className="flex items-center gap-2">
          {saved && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 bg-emerald-50 rounded-lg">
              <CheckCircle className="h-4 w-4" /> Status synced
            </span>
          )}
          <button onClick={fetchStatus} disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="space-y-6">
        <div className="bg-white border border-slate-200 rounded-3xl p-6">
          <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-gradient-to-r from-brand to-brand-hover text-white flex items-center justify-center">
                <CreditCard size={20} />
              </div>
              <div>
                <h3 className="text-base font-semibold text-slate-800">Connection Status</h3>
                <p className="text-xs text-slate-500 mt-0.5">Your organization's Stripe Connect account</p>
              </div>
            </div>
            <StatusBadge status={status?.status} />
          </div>

          {status?.disabled_reason && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <span>Stripe has disabled this account: {status.disabled_reason}</span>
            </div>
          )}

          {requirements.length > 0 && (
            <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
              <div className="flex items-center gap-2 font-semibold mb-1.5">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                Stripe needs more information
              </div>
              <ul className="list-disc list-inside space-y-0.5 text-xs">
                {requirements.map((req) => <li key={req}>{req.replace(/_/g, " ")}</li>)}
              </ul>
            </div>
          )}

          {isConnected ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8">
              <div>
                <DetailRow label="Connected Account" value={status?.connected_account_id} mono />
                <DetailRow label="Country" value={status?.country} />
                <DetailRow label="Default Currency" value={status?.default_currency?.toUpperCase()} />
              </div>
              <div>
                <div className="flex items-center justify-between py-2.5 border-b border-slate-100">
                  <span className="text-sm text-slate-500">Charges Enabled</span>
                  <BoolChip value={status?.charges_enabled} />
                </div>
                <div className="flex items-center justify-between py-2.5 border-b border-slate-100">
                  <span className="text-sm text-slate-500">Payouts Enabled</span>
                  <BoolChip value={status?.payouts_enabled} />
                </div>
                <DetailRow label="Connected On" value={fmtDateTime(status?.connected_at) || "—"} />
                <DetailRow label="Last Synced" value={fmtDateTime(status?.last_synced_at) || "Never"} />
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 p-4 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-600">
              <Globe className="h-5 w-5 flex-shrink-0 text-slate-400" />
              <p>
                No Stripe account is connected yet. Connect one so customers can pay invoices online — payments
                will be routed directly to your connected Stripe account.
              </p>
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-3xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-r from-brand to-brand-hover text-white flex items-center justify-center">
              <ShieldCheck size={20} />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-800">Actions</h3>
              <p className="text-xs text-slate-500 mt-0.5">Manage this organization's Stripe connection</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {!isActive && (
              <button onClick={handleConnect} disabled={connecting || connectUnavailable}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
                {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                {isConnected ? "Continue Connecting Stripe" : "Connect Stripe"}
              </button>
            )}

            {isConnected && (
              <button onClick={handleSync} disabled={syncing}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-50 transition-colors">
                <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "Syncing…" : "Sync Status"}
              </button>
            )}

            {isConnected && (
              <button onClick={handleDisconnect} disabled={disconnecting}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-red-600 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-50 transition-colors ml-auto">
                {disconnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
                Disconnect
              </button>
            )}
          </div>

          {connectUnavailable && !isConnected && (
            <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-4" role="note">
              Stripe Connect isn't available on this platform yet. Please contact Zoiko support to enable online card payments.
            </p>
          )}

          <p className="text-xs text-slate-500 mt-4">
            Disconnecting stops Zoiko from routing new payments through this Stripe account. It does not remove
            Zoiko's access from your Stripe Dashboard — do that separately in Stripe if needed.
          </p>
        </div>
      </div>
    </HRPage>
  );
}
