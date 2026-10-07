import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Receipt,
  Wallet,
  AlertCircle,
  ArrowRight,
  ShieldCheck,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  FileSignature,
  RefreshCw,
  Rocket,
  Gauge,
  Clock,
  Calendar,
  AlertTriangle,
  Check,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import {
  platformSelfServiceApi,
  getZoikoSubscriptionCached,
  invalidateZoikoSubscriptionCache,
} from "../../service/platformSelfServiceApi";
import { formatOrgMoney } from "./workspace-format";

// Covers both CommercialSubscription statuses (active/pending/past_due/
// restricted/suspended/cancelled/expired/trialing/trial_recovery) and
// PlatformInvoice/CommercialQuote statuses.
const STATUS_BADGE = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  trialing: "bg-blue-50 text-blue-700 border-blue-200",
  trial_recovery: "bg-amber-50 text-amber-700 border-amber-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  past_due: "bg-red-50 text-red-700 border-red-200",
  restricted: "bg-red-50 text-red-700 border-red-200",
  suspended: "bg-red-50 text-red-700 border-red-200",
  cancelled: "bg-slate-100 text-slate-600 border-slate-200",
  expired: "bg-slate-100 text-slate-600 border-slate-200",
  draft: "bg-slate-100 text-slate-600 border-slate-200",
  issued: "bg-blue-50 text-[#1A56DB] border-blue-100",
  delivered: "bg-blue-50 text-[#1A56DB] border-blue-100",
  due: "bg-amber-50 text-amber-700 border-amber-200",
  partially_paid: "bg-amber-50 text-amber-700 border-amber-200",
  paid: "bg-emerald-50 text-emerald-700 border-emerald-200",
  cleared: "bg-emerald-50 text-emerald-700 border-emerald-200",
  overdue: "bg-red-50 text-red-700 border-red-200",
  voided: "bg-slate-100 text-slate-500 border-slate-200",
  failed: "bg-red-50 text-red-700 border-red-200",
  sent: "bg-blue-50 text-[#1A56DB] border-blue-100",
  accepted: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
};

function Badge({ status, labelOverride }) {
  const s = (status || "").toLowerCase();
  const cls = STATUS_BADGE[s] || "bg-slate-100 text-slate-600 border-slate-200";
  return (
    <span className={`px-2.5 py-0.5 text-xs font-semibold rounded-full border ${cls}`}>
      {labelOverride || s.replace(/_/g, " ") || "unknown"}
    </span>
  );
}

function EmptyState({ icon: Icon, title, hint }) {
  return (
    <div className="p-10 flex flex-col items-center justify-center text-center flex-1">
      <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
        <Icon className="w-6 h-6" />
      </div>
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {hint && <p className="text-xs text-slate-400 mt-1 max-w-xs">{hint}</p>}
    </div>
  );
}

function daysUntil(isoDate) {
  if (!isoDate) return null;
  const ms = Date.parse(isoDate) - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

function fmtDate(isoDate) {
  if (!isoDate) return "—";
  try {
    return new Date(isoDate).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return isoDate;
  }
}

function formatEntitlementKey(key = "") {
  const map = {
    seats: "Team Members / Seats",
    storage_gb: "Storage Capacity (GB)",
    invoices_per_month: "Invoices per Month",
    api_calls_per_month: "Monthly API Calls",
    organizations: "Connected Workspaces",
    customer_accounts: "Customer Accounts",
  };
  if (map[key]) return map[key];
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const NON_PAYABLE_PLATFORM_INVOICE_STATUSES = new Set(["draft", "paid", "voided", "credited"]);

export function pickPayableInvoice(invoices = []) {
  const payable = invoices.filter(
    (i) =>
      Number(i.balance_due) > 0.005 &&
      !NON_PAYABLE_PLATFORM_INVOICE_STATUSES.has(String(i.status || "").toLowerCase()),
  );
  return payable.find((i) => i.public_token) || payable[0] || null;
}

export default function WorkspaceZoikoSubscriptionPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [usageData, setUsageData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  // Conversion action state
  const [convertingTrial, setConvertingTrial] = useState(false);
  const [convertError, setConvertError] = useState(null);
  const [convertNotice, setConvertNotice] = useState(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
      invalidateZoikoSubscriptionCache();
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      // Shared cache with TrialBanner (rendered by BillingShell on this same
      // screen), so the slow zoiko-subscription GET runs once on mount. An
      // explicit refresh invalidates the cache above, forcing a fresh fetch
      // that also refills it.
      const [subRes, usageRes] = await Promise.allSettled([
        getZoikoSubscriptionCached(),
        platformSelfServiceApi.getWorkspaceUsage(),
      ]);

      if (subRes.status === "fulfilled") {
        setData(subRes.value);
      } else {
        throw new Error(subRes.reason?.message || "Unable to load your Zoiko subscription.");
      }

      if (usageRes.status === "fulfilled") {
        setUsageData(usageRes.value);
      }
    } catch (err) {
      setError(err?.message || "Unable to load your Zoiko subscription.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const { account, subscription, invoices = [], payments = [], quotes = [] } = data || {};
  const currency = subscription?.currency || "USD";
  const unpaidInvoice = pickPayableInvoice(invoices);
  const payLinkMissing = Boolean(unpaidInvoice && !unpaidInvoice.public_token);
  const openQuote = quotes.find((q) => q.status === "sent");

  const status = (subscription?.status || "").toLowerCase();
  const isActive = status === "active";
  const isTrial = status === "trialing" || status === "trial_recovery";
  const isTrialRecovery = status === "trial_recovery";
  const isSuspended = status === "suspended";
  const isPastDue = status === "past_due";
  const isPending = status === "pending";

  const trialDaysRemaining = isTrialRecovery
    ? daysUntil(subscription?.recovery_ends_at)
    : daysUntil(subscription?.trial_ends_at);

  const handlePayInvoice = useCallback(
    (inv) => {
      if (!inv?.public_token) return;
      navigate(`/platform-invoice/${inv.public_token}/checkout`);
    },
    [navigate],
  );

  const handleConvertTrial = useCallback(async () => {
    if (!subscription) return;
    setConvertingTrial(true);
    setConvertError(null);
    setConvertNotice(null);

    try {
      const route = await platformSelfServiceApi.convertTrialToPaid({ payment_method: "card" });
      invalidateZoikoSubscriptionCache();

      if (route?.mode === "checkout" && route.checkout_url) {
        window.location.href = route.checkout_url;
        return;
      }
      if (route?.mode === "assisted_quote" && route.quote_url) {
        window.location.href = route.quote_url;
        return;
      }
      if (route?.mode === "invoice_due") {
        if (route.public_token) {
          navigate(`/platform-invoice/${route.public_token}`);
        } else {
          setConvertNotice("Your conversion invoice has been created. Complete payment to activate your plan.");
          load(true);
        }
        return;
      }

      setConvertNotice("Subscription conversion initiated. Refreshing your status.");
      load(true);
    } catch (err) {
      setConvertError(err?.message || "Could not complete trial conversion. Please try again.");
    } finally {
      setConvertingTrial(false);
    }
  }, [subscription, navigate, load]);

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 min-h-[calc(100vh-4rem)] bg-white flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-slate-200 border-t-[#1A56DB] rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 sm:p-6 lg:p-8 min-h-[calc(100vh-4rem)] bg-white">
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <p className="font-semibold text-red-900">Failed to load subscription</p>
            <p className="mt-1 text-red-700">{error}</p>
          </div>
          <button
            onClick={() => load(true)}
            className="px-4 py-2 bg-white border border-red-200 text-red-700 rounded-xl font-medium hover:bg-red-100/50 cursor-pointer text-xs"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const displayName = user?.first_name || user?.full_name || (user?.email || "").split("@")[0] || "there";
  const usageCounters = usageData?.counters || [];

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#F8FAFC] text-[#1E293B]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">

        {/* Header Banner */}
        <div className="bg-[#1A56DB]/10 rounded-2xl p-6 border border-[#1A56DB]/20 shadow-xs flex flex-col md:flex-row items-start md:items-center gap-5 justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-[#1A56DB]/15 text-[#1A56DB] flex items-center justify-center font-bold text-xl shrink-0">
              {displayName.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold tracking-wider text-[#1A56DB] uppercase">
                  Organisation Admin
                </span>
                <span className="text-slate-300">•</span>
                <span className="text-xs text-slate-500 font-medium">Platform Subscription</span>
              </div>
              <h1 className="text-2xl font-bold text-[#0B192C] mt-0.5">
                Zoiko Subscription & Billing
              </h1>
              <p className="text-sm text-slate-500 mt-1 flex items-center gap-1.5">
                <CreditCard className="w-4 h-4 text-slate-400" />
                Your organization's own subscription to the Zoiko Billing platform
              </p>
            </div>
          </div>

          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="self-end md:self-auto inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white hover:bg-slate-50 border border-slate-200/90 rounded-xl shadow-2xs transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin text-[#1A56DB]" : "text-slate-500"}`} />
            <span>{refreshing ? "Refreshing…" : "Refresh"}</span>
          </button>
        </div>

        {convertError && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex items-center gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 text-red-600" />
            <p className="flex-1">{convertError}</p>
          </div>
        )}

        {convertNotice && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-600" />
            <p className="flex-1">{convertNotice}</p>
          </div>
        )}

        {!account ? (
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-10 text-center">
            <p className="text-sm text-slate-500">No commercial account found for this organization yet.</p>
          </div>
        ) : !subscription ? (
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-10 text-center">
            <h3 className="text-lg font-bold text-[#0B192C] mb-2">No Active Zoiko Subscription</h3>
            <p className="text-sm text-slate-500 max-w-md mx-auto">
              {account.intended_plan_code
                ? `You selected the "${account.intended_plan_code}" plan at signup, but it hasn't been provisioned yet. Contact Zoiko support to activate.`
                : "Your organization does not have an active subscription provisioned. Contact your Zoiko representative."}
            </p>
          </div>
        ) : (
          <>
            {/* Subscription Plan Overview Card */}
            <div className="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-xs space-y-6">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <h2 className="text-xl font-bold text-[#0B192C]">{subscription.plan_name || "Zoiko Billing Plan"}</h2>
                    <Badge
                      status={subscription.status}
                      labelOverride={
                        isActive ? "Active Subscription"
                        : isTrial ? (isTrialRecovery ? "Trial Recovery" : "Free Trial")
                        : isSuspended ? "Suspended"
                        : isPastDue ? "Past Due"
                        : isPending ? "Pending Activation"
                        : undefined
                      }
                    />
                    {subscription.plan_code && (
                      <span className="text-xs font-mono font-medium text-slate-500 bg-slate-100 px-2 py-0.5 rounded">
                        {subscription.plan_code}
                      </span>
                    )}
                  </div>

                  <p className="text-sm text-slate-500 mt-1.5">
                    {isActive ? (
                      subscription.current_period_end ? (
                        <>Next renewal date is <strong>{fmtDate(subscription.current_period_end)}</strong>.</>
                      ) : (
                        "Your subscription is active."
                      )
                    ) : isTrial ? (
                      isTrialRecovery ? (
                        <>Your trial has ended. You are in the recovery window until <strong>{fmtDate(subscription.recovery_ends_at)}</strong>.</>
                      ) : (
                        <>Free trial active until <strong>{fmtDate(subscription.trial_ends_at)}</strong> ({trialDaysRemaining != null ? `${trialDaysRemaining} day${trialDaysRemaining === 1 ? "" : "s"} remaining` : "active"}).</>
                      )
                    ) : isSuspended ? (
                      "Access is suspended because your trial or invoice period passed without payment."
                    ) : isPastDue ? (
                      "Your subscription is past due. Please settle outstanding invoices to keep active access."
                    ) : (
                      "Complete payment to activate full platform features."
                    )}
                  </p>
                </div>

                {subscription.price_amount != null && (
                  <div className="text-right">
                    <div className="text-3xl font-extrabold text-[#0B192C]">
                      {formatOrgMoney(subscription.price_amount, { default_currency: currency })}
                    </div>
                    <div className="text-xs text-slate-400 font-medium mt-0.5">
                      per {subscription.billing_interval === "annual" ? "year" : "month"}
                    </div>
                  </div>
                )}
              </div>

              {/* Trial Conversion Banner & CTA */}
              {isTrial && (
                <div className={`rounded-xl p-5 border flex flex-col md:flex-row items-start md:items-center justify-between gap-4 ${isTrialRecovery ? "bg-amber-50/80 border-amber-200" : "bg-gradient-to-r from-blue-50/90 to-indigo-50/90 border-blue-200"}`}>
                  <div className="flex items-start gap-3.5">
                    <div className={`p-2 rounded-xl shrink-0 ${isTrialRecovery ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-[#1A56DB]"}`}>
                      <Rocket className="w-5 h-5" />
                    </div>
                    <div>
                      <h4 className={`text-sm font-bold ${isTrialRecovery ? "text-amber-900" : "text-blue-950"}`}>
                        {isTrialRecovery
                          ? "Activate your plan before access is revoked"
                          : "Ready to unlock unlimited platform access?"}
                      </h4>
                      <p className={`text-xs mt-1 ${isTrialRecovery ? "text-amber-800" : "text-blue-700"}`}>
                        {isTrialRecovery
                          ? `Your evaluation has ended. Convert to ${subscription.plan_name || "the paid plan"} now to retain all data and configurations.`
                          : `Keep uninterrupted access to your billing operations. Upgrade your trial to ${subscription.plan_name || "the standard plan"} with instant checkout.`}
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={handleConvertTrial}
                    disabled={convertingTrial}
                    className="cursor-pointer shrink-0 inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-[#1A56DB] to-[#0F52BA] hover:from-[#1546B0] hover:to-[#0B419A] rounded-xl shadow-sm transition-all hover:shadow hover:-translate-y-0.5 disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {convertingTrial ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        <span>Processing…</span>
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="w-4 h-4" />
                        <span>Activate Paid Plan</span>
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* Suspended Warning */}
              {isSuspended && (
                <div className="rounded-xl p-4 bg-red-50 border border-red-200 flex items-center gap-3">
                  <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
                  <div className="flex-1 text-sm text-red-800">
                    <strong>Billing access suspended:</strong> Settle the outstanding subscription invoice to immediately reinstate workspace features.
                  </div>
                </div>
              )}

              {/* Outstanding Invoice Alert */}
              {unpaidInvoice && (
                <div className={`border rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 ${isSuspended ? "bg-red-50/70 border-red-200/80" : "bg-amber-50/70 border-amber-200/80"}`}>
                  <div className="flex items-center gap-3">
                    <AlertCircle className={`w-5 h-5 shrink-0 ${isSuspended ? "text-red-600" : "text-amber-600"}`} />
                    <div>
                      <p className={`text-sm font-semibold ${isSuspended ? "text-red-900" : "text-amber-900"}`}>
                        {isSuspended ? "Payment required to reinstate access" : "Awaiting payment for subscription invoice"}
                      </p>
                      <p className={`text-xs mt-0.5 ${isSuspended ? "text-red-700" : "text-amber-700"}`}>
                        Invoice {unpaidInvoice.invoice_number || `#${unpaidInvoice.id}`} • Due {fmtDate(unpaidInvoice.due_date)}
                      </p>
                    </div>
                  </div>

                  {payLinkMissing && (
                    <p role="status" className="text-xs text-amber-800 sm:max-w-xs">
                      The payment link for this invoice is being processed.
                    </p>
                  )}

                  <button
                    onClick={() => handlePayInvoice(unpaidInvoice)}
                    disabled={payLinkMissing}
                    className="disabled:opacity-50 disabled:cursor-not-allowed group inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-[#1A56DB] to-[#0F52BA] hover:from-[#1546B0] hover:to-[#0B419A] rounded-xl shadow-xs transition cursor-pointer shrink-0"
                  >
                    <ShieldCheck className="w-4 h-4 text-blue-200" />
                    <span>Pay {formatOrgMoney(unpaidInvoice.balance_due, { default_currency: unpaidInvoice.currency || currency })} Now</span>
                    <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                  </button>
                </div>
              )}

              {/* Subscription Period Metadata */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-slate-100">
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Billing Cycle</span>
                  <p className="text-sm font-semibold text-slate-800 mt-0.5 capitalize">
                    {subscription.billing_interval || "Monthly"}
                  </p>
                </div>
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Current Period Start</span>
                  <p className="text-sm font-semibold text-slate-800 mt-0.5">
                    {fmtDate(subscription.current_period_start)}
                  </p>
                </div>
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Current Period End</span>
                  <p className="text-sm font-semibold text-slate-800 mt-0.5">
                    {fmtDate(subscription.current_period_end)}
                  </p>
                </div>
                <div>
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Status</span>
                  <p className="text-sm font-semibold text-slate-800 mt-0.5 capitalize">
                    {subscription.status ? subscription.status.replace(/_/g, " ") : "Active"}
                  </p>
                </div>
              </div>
            </div>

            {/* Resource Usage & Entitlements Section */}
            {usageCounters.length > 0 && (
              <div className="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-xs space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <Gauge className="w-5 h-5 text-[#1A56DB]" />
                    <h3 className="font-bold text-slate-900 text-base">Plan Limits & Resource Usage</h3>
                  </div>
                  <span className="text-xs text-slate-400 font-medium">Real-time entitlement counters</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
                  {usageCounters.map((cnt) => {
                    const hasLimit = cnt.limit != null && Number(cnt.limit) > 0;
                    const percent = hasLimit ? Math.min(100, Math.round((Number(cnt.count) / Number(cnt.limit)) * 100)) : 0;
                    const isNearLimit = hasLimit && percent >= 80;
                    const isExceeded = hasLimit && percent >= 100;

                    return (
                      <div
                        key={cnt.id || cnt.entitlement_key}
                        className="rounded-xl border border-slate-200/70 p-4 bg-slate-50/50 flex flex-col justify-between"
                      >
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-slate-700">
                              {formatEntitlementKey(cnt.entitlement_key)}
                            </span>
                            {hasLimit && (
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${isExceeded ? "bg-red-100 text-red-700" : isNearLimit ? "bg-amber-100 text-amber-700" : "bg-slate-200/80 text-slate-600"}`}>
                                {percent}%
                              </span>
                            )}
                          </div>

                          <div className="mt-2 flex items-baseline gap-1.5">
                            <span className="text-2xl font-extrabold text-slate-900">{cnt.count}</span>
                            <span className="text-xs text-slate-500 font-medium">
                              {hasLimit ? `/ ${cnt.limit}` : "used (Unlimited)"}
                            </span>
                          </div>
                        </div>

                        {hasLimit && (
                          <div className="mt-3">
                            <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-300 ${
                                  isExceeded ? "bg-red-500" : isNearLimit ? "bg-amber-500" : "bg-[#1A56DB]"
                                }`}
                                style={{ width: `${percent}%` }}
                              />
                            </div>
                            <div className="flex items-center justify-between text-[10px] text-slate-400 mt-1">
                              <span>Window: {cnt.window_key || "Current"}</span>
                              {cnt.enforcement_type && (
                                <span className="capitalize">{cnt.enforcement_type.replace(/_/g, " ")}</span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Open Quote Alert */}
            {openQuote && (
              <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                  <FileSignature className="w-5 h-5 text-[#1A56DB] shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-blue-900">
                      Quote {openQuote.quote_number} awaiting your review
                    </p>
                    <p className="text-xs text-blue-700 mt-0.5">
                      Total: {formatOrgMoney(openQuote.total_amount, { default_currency: openQuote.currency || currency })}
                      {openQuote.valid_until && ` • Valid until ${fmtDate(openQuote.valid_until)}`}
                    </p>
                  </div>
                </div>
                <a
                  href={`/platform-quote/${openQuote.public_token}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#1A56DB] text-white text-xs font-semibold rounded-xl hover:bg-[#1546B0] transition"
                >
                  Review Quote <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            )}

            {/* Invoices & Payments Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

              {/* Invoices from Zoiko */}
              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden flex flex-col justify-between">
                <div>
                  <div className="p-5 border-b border-slate-100 flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <Receipt className="w-5 h-5 text-[#1A56DB]" />
                      <h3 className="font-bold text-slate-900 text-base">Invoices from Zoiko</h3>
                    </div>
                    <span className="text-xs font-semibold text-slate-400">
                      {invoices.length === 0 ? "No invoices" : `${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`}
                    </span>
                  </div>

                  {invoices.length === 0 ? (
                    <EmptyState icon={Receipt} title="No invoices yet" hint="Subscription and renewal invoices from Zoiko will appear here." />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="bg-slate-50/70 border-b border-slate-100 text-[11px] uppercase tracking-wider font-bold text-slate-500">
                            <th className="py-3 px-5">Invoice</th>
                            <th className="py-3 px-5">Date</th>
                            <th className="py-3 px-5">Status</th>
                            <th className="py-3 px-5 text-right">Balance Due</th>
                            <th className="py-3 px-5 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-sm">
                          {invoices.map((inv) => {
                            const isPayable =
                              Number(inv.balance_due) > 0.005 &&
                              !NON_PAYABLE_PLATFORM_INVOICE_STATUSES.has(String(inv.status || "").toLowerCase());

                            return (
                              <tr key={inv.id} className="hover:bg-slate-50/50 transition">
                                <td className="py-3.5 px-5">
                                  <a
                                    href={inv.public_token ? `/platform-invoice/${inv.public_token}` : undefined}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="font-semibold text-[#1A56DB] hover:underline cursor-pointer"
                                  >
                                    {inv.invoice_number || `#${inv.id}`}
                                  </a>
                                </td>
                                <td className="py-3.5 px-5 text-xs text-slate-500 font-medium">
                                  {fmtDate(inv.issue_date || inv.due_date)}
                                </td>
                                <td className="py-3.5 px-5">
                                  <Badge status={inv.status} />
                                </td>
                                <td className="py-3.5 px-5 text-right font-bold text-slate-900">
                                  {formatOrgMoney(inv.balance_due, { default_currency: inv.currency || currency })}
                                </td>
                                <td className="py-3.5 px-5 text-right">
                                  {isPayable && inv.public_token ? (
                                    <button
                                      onClick={() => handlePayInvoice(inv)}
                                      className="px-2.5 py-1 text-xs font-semibold text-white bg-[#1A56DB] hover:bg-[#1546B0] rounded-lg cursor-pointer"
                                    >
                                      Pay
                                    </button>
                                  ) : inv.public_token ? (
                                    <a
                                      href={`/platform-invoice/${inv.public_token}`}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-xs font-semibold text-slate-500 hover:text-slate-800"
                                    >
                                      View
                                    </a>
                                  ) : (
                                    <span className="text-xs text-slate-400">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              {/* Payments to Zoiko */}
              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs flex flex-col">
                <div className="p-5 border-b border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <Wallet className="w-5 h-5 text-[#1A56DB]" />
                    <h3 className="font-bold text-slate-900 text-base">Payments to Zoiko</h3>
                  </div>
                  <span className="text-xs font-semibold text-slate-400">
                    {payments.length === 0 ? "No receipts" : `${payments.length} payment${payments.length === 1 ? "" : "s"}`}
                  </span>
                </div>

                {payments.length === 0 ? (
                  <EmptyState
                    icon={Wallet}
                    title="No payments yet"
                    hint="Completed subscription and invoice transactions will display here."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50/70 border-b border-slate-100 text-[11px] uppercase tracking-wider font-bold text-slate-500">
                          <th className="py-3 px-5">Receipt</th>
                          <th className="py-3 px-5">Method</th>
                          <th className="py-3 px-5">Status</th>
                          <th className="py-3 px-5 text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-sm">
                        {payments.map((pay) => (
                          <tr key={pay.id} className="hover:bg-slate-50/50 transition">
                            <td className="py-3.5 px-5 font-semibold text-slate-900">
                              {pay.payment_number || `#${pay.id}`}
                            </td>
                            <td className="py-3.5 px-5 text-slate-500 text-xs font-medium capitalize">
                              {(pay.payment_method || "—").replace(/_/g, " ")}
                            </td>
                            <td className="py-3.5 px-5">
                              <Badge status={pay.status} />
                            </td>
                            <td className={`py-3.5 px-5 text-right font-bold ${pay.status === "cleared" ? "text-emerald-600" : "text-slate-900"}`}>
                              {formatOrgMoney(pay.amount, { default_currency: pay.currency || currency })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
