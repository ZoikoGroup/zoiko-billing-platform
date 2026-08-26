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
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { platformSelfServiceApi } from "../../service/platformSelfServiceApi";
import { formatOrgMoney } from "./workspace-format";

// Covers both CommercialSubscription statuses (active/pending/past_due/
// restricted/suspended/cancelled/expired) and PlatformInvoice/CommercialQuote
// statuses (draft/issued/due/paid/sent/accepted/... — some keys, like
// "pending"/"cancelled", are shared by both and mean the same visual weight
// (amber = awaiting action, gray = terminal/inactive) either way.
const STATUS_BADGE = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
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

// Plane 1 (Zoiko-billing-the-org) self-service view: this organization's own
// billing relationship with Zoiko, not the org's own customers' Plane 2
// subscriptions (see WorkspaceSubscriptionPage.jsx for that).
export default function WorkspaceZoikoSubscriptionPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    platformSelfServiceApi.getZoikoSubscription()
      .then((res) => setData(res))
      .catch((err) => setError(err?.message || "Unable to load your Zoiko subscription."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const { account, subscription, invoices = [], payments = [], quotes = [] } = data || {};
  const currency = subscription?.currency || "USD";
  const unpaidInvoice = invoices.find((i) => Number(i.balance_due) > 0.005 && i.status !== "voided");
  const openQuote = quotes.find((q) => q.status === "sent");
  const isActive = subscription?.status === "active";
  const isSuspended = subscription?.status === "suspended";

  // Navigates to a dedicated checkout page (rather than calling the checkout
  // API inline) so clicking "Pay Now" always opens a real page immediately —
  // that page starts the Stripe session and forwards the browser there, or
  // shows a clear "not configured" state of its own.
  const handlePayNow = useCallback(() => {
    if (!unpaidInvoice?.public_token) return;
    navigate(`/platform-invoice/${unpaidInvoice.public_token}/checkout`);
  }, [unpaidInvoice, navigate]);

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
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  const displayName = user?.first_name || user?.full_name || (user?.email || "").split("@")[0] || "there";

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#F8FAFC] text-[#1E293B]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">

        {/* Welcome Banner */}
        <div className="bg-[#1A56DB]/10 rounded-2xl p-6 border border-[#1A56DB]/20 shadow-xs flex flex-col md:flex-row items-start md:items-center gap-5 justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-[#1A56DB]/15 text-[#1A56DB] flex items-center justify-center font-bold text-xl shrink-0">
              {displayName.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <span className="text-xs font-bold tracking-wider text-[#1A56DB] uppercase">
                Billing Administrator
              </span>
              <h1 className="text-2xl font-bold text-[#0B192C] mt-0.5">
                Welcome back, {displayName}
              </h1>
              <p className="text-sm text-slate-500 mt-1 flex items-center gap-1.5">
                <CreditCard className="w-4 h-4 text-slate-400" />
                Your organization's own billing relationship with Zoiko — not your customers' subscriptions
              </p>
            </div>
          </div>
        </div>

        {!account ? (
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-10 text-center">
            <p className="text-sm text-slate-500">No commercial account found for this organization yet.</p>
          </div>
        ) : !subscription ? (
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-10 text-center">
            <h3 className="text-lg font-bold text-[#0B192C] mb-2">No Active Zoiko Subscription</h3>
            <p className="text-sm text-slate-500">
              {account.intended_plan_code
                ? `You selected the ${account.intended_plan_code} plan at signup, but it hasn't been provisioned yet. Contact your Zoiko representative.`
                : "Contact your Zoiko representative to set up a subscription."}
            </p>
          </div>
        ) : (
          <>
            {/* Subscription Plan Overview */}
            <div className="bg-white rounded-2xl p-6 border border-slate-200/80 shadow-xs space-y-6">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <h2 className="text-xl font-bold text-[#0B192C]">{subscription.plan_name || "Zoiko Plan"}</h2>
                    <Badge
                      status={subscription.status}
                      labelOverride={
                        isActive ? "Active Subscription"
                        : isSuspended ? "Suspended"
                        : subscription.status === "pending" ? "Pending Activation"
                        : undefined
                      }
                    />
                  </div>
                  <p className="text-sm text-slate-500 mt-1">
                    {isActive
                      ? subscription.current_period_end
                        ? `Your next billing date is ${new Date(subscription.current_period_end).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}.`
                        : "Your subscription is active."
                      : isSuspended
                        ? "Your free trial ended without payment — access to Billing is suspended until you pay."
                        : subscription.trial_ends_at
                          ? `Free trial — pay by ${new Date(subscription.trial_ends_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })} to keep access.`
                          : "Complete payment to activate full access."}
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

              {!isActive && unpaidInvoice ? (
                <div className={`border rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 ${isSuspended ? "bg-red-50/70 border-red-200/80" : "bg-amber-50/70 border-amber-200/80"}`}>
                  <div className="flex items-center gap-3">
                    <AlertCircle className={`w-5 h-5 shrink-0 ${isSuspended ? "text-red-600" : "text-amber-600"}`} />
                    <div>
                      <p className={`text-sm font-semibold ${isSuspended ? "text-red-900" : "text-amber-900"}`}>
                        {isSuspended ? "Billing access suspended — pay to reinstate" : "Awaiting payment to activate subscription"}
                      </p>
                      <p className={`text-xs mt-0.5 ${isSuspended ? "text-red-700" : "text-amber-700"}`}>
                        Invoice {unpaidInvoice.invoice_number} is due for payment
                      </p>
                    </div>
                  </div>

                  <button
                    onClick={handlePayNow}
                    className="group relative inline-flex items-center justify-center gap-3 px-6 py-3 text-sm font-semibold text-white bg-gradient-to-r from-[#1A56DB] to-[#0F52BA] hover:from-[#1546B0] hover:to-[#0B419A] rounded-xl shadow-md shadow-blue-500/20 hover:shadow-lg hover:shadow-blue-500/35 hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200 shrink-0 cursor-pointer"
                  >
                    <ShieldCheck className="w-4 h-4 text-blue-200" />
                    <span>Pay {formatOrgMoney(unpaidInvoice.balance_due, { default_currency: unpaidInvoice.currency })} Now</span>
                    <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-1" />
                  </button>
                </div>
              ) : !isActive ? (
                <div className="bg-amber-50/70 border border-amber-200/80 rounded-xl p-4 flex items-center gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
                  <p className="text-sm text-amber-800">
                    No unpaid invoice yet for this subscription — one will appear here once generated.
                  </p>
                </div>
              ) : (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-3 text-emerald-800 text-sm font-medium">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
                  <span>Your subscription is active. Thank you.</span>
                </div>
              )}
            </div>

            {openQuote && (
              <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                  <FileSignature className="w-5 h-5 text-[#1A56DB] shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-blue-900">Quote {openQuote.quote_number} awaiting your decision</p>
                    <p className="text-xs text-blue-700 mt-0.5">{formatOrgMoney(openQuote.total_amount, { default_currency: openQuote.currency })}</p>
                  </div>
                </div>
                <a
                  href={`/platform-quote/${openQuote.public_token}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#1A56DB] hover:text-[#0F52BA]"
                >
                  Review Quote <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            )}

            {/* Data Grid: Invoices & Payments */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

              {/* Invoices */}
              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden flex flex-col justify-between">
                <div>
                  <div className="p-5 border-b border-slate-100 flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <Receipt className="w-5 h-5 text-[#1A56DB]" />
                      <h3 className="font-bold text-slate-900 text-base">Invoices from Zoiko</h3>
                    </div>
                    <span className="text-xs font-semibold text-slate-400">
                      {invoices.length === 0 ? "No invoices" : `Showing ${invoices.length} invoice${invoices.length === 1 ? "" : "s"}`}
                    </span>
                  </div>

                  {invoices.length === 0 ? (
                    <EmptyState icon={Receipt} title="No invoices yet" hint="Invoices from Zoiko will appear here." />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="bg-slate-50/70 border-b border-slate-100 text-[11px] uppercase tracking-wider font-bold text-slate-500">
                            <th className="py-3 px-5">Invoice</th>
                            <th className="py-3 px-5">Status</th>
                            <th className="py-3 px-5 text-right">Balance Due</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-sm">
                          {invoices.map((inv) => (
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
                              <td className="py-3.5 px-5"><Badge status={inv.status} /></td>
                              <td className="py-3.5 px-5 text-right font-bold text-slate-900">
                                {formatOrgMoney(inv.balance_due, { default_currency: inv.currency || currency })}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              {/* Payments */}
              <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs flex flex-col">
                <div className="p-5 border-b border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <Wallet className="w-5 h-5 text-[#1A56DB]" />
                    <h3 className="font-bold text-slate-900 text-base">Payments to Zoiko</h3>
                  </div>
                </div>

                {payments.length === 0 ? (
                  <EmptyState
                    icon={Wallet}
                    title="No payments yet"
                    hint="Transactions completed online will instantly display here."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50/70 border-b border-slate-100 text-[11px] uppercase tracking-wider font-bold text-slate-500">
                          <th className="py-3 px-5">Receipt</th>
                          <th className="py-3 px-5">Method</th>
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
