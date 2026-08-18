import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import {
  settingsApi, subscriptionApi, dashboardApi, productApi, invoiceApi, paymentApi,
} from "../../service/billingService";
import WorkspaceHeader from "./WorkspaceHeader";
import { formatOrgMoney, resolveOrgCurrency, formatCurrencyChip } from "./workspace-format";
import { Repeat, Loader2, ArrowRight, Coins, Layers } from "lucide-react";

function Field({ label, value }) {
  return (
    <div className="py-3 border-b border-slate-100">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1">{label}</p>
      <p className="text-sm font-medium text-slate-700">{value || "—"}</p>
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    active: "bg-emerald-50 text-emerald-700",
    paused: "bg-amber-50 text-amber-700",
    cancelled: "bg-red-50 text-red-700",
    past_due: "bg-red-50 text-red-700",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium ${map[status] || "bg-gray-50 text-gray-600"}`}>
      {status || "unknown"}
    </span>
  );
}

function MiniTile({ label, value }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="text-lg font-bold text-slate-800 mt-0.5">{value}</p>
    </div>
  );
}

export default function WorkspaceSubscriptionPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [config, setConfig] = useState(null);
  const [activeSubs, setActiveSubs] = useState([]);
  const [reporting, setReporting] = useState(null);
  const [plans, setPlans] = useState([]);
  const [recentInvoices, setRecentInvoices] = useState([]);
  const [recentPayments, setRecentPayments] = useState([]);
  const [kpis, setKpis] = useState(null);
  const [productCount, setProductCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [c, s, r, pl, inv, pay, k, prod] = await Promise.allSettled([
          settingsApi.getConfig(),
          subscriptionApi.listActive(),
          subscriptionApi.getReporting(),
          subscriptionApi.listPlans({ per_page: 200 }),
          invoiceApi.list({ page: 1, per_page: 5 }),
          paymentApi.list({ page: 1, per_page: 5 }),
          dashboardApi.getKPIs(),
          productApi.list({ page: 1, per_page: 1 }),
        ]);
        if (cancelled) return;
        if (c.status === "fulfilled") setConfig(c.value);
        if (s.status === "fulfilled") setActiveSubs(Array.isArray(s.value) ? s.value : []);
        if (r.status === "fulfilled") setReporting(r.value);
        if (pl.status === "fulfilled") setPlans(pl.value?.items || []);
        if (inv.status === "fulfilled") setRecentInvoices(inv.value?.items || []);
        if (pay.status === "fulfilled") setRecentPayments(pay.value?.items || []);
        if (k.status === "fulfilled") setKpis(k.value);
        if (prod.status === "fulfilled") setProductCount(prod.value?.total ?? null);
      } catch (err) {
        if (!cancelled) setError(err?.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const planMap = useMemo(() => {
    const m = {};
    plans.forEach((p) => { m[p.id] = p.plan_name || p.name; });
    return m;
  }, [plans]);

  const primarySub = useMemo(() => {
    if (!activeSubs.length) return null;
    return [...activeSubs].sort((a, b) => (Number(b.unit_price) || 0) - (Number(a.unit_price) || 0))[0];
  }, [activeSubs]);

  const currency = reporting?.reporting_currency || config?.default_currency || "USD";

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#ffffff", minHeight: "calc(100vh - 4rem)" }}>
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-brand" /></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#ffffff", minHeight: "calc(100vh - 4rem)" }}>
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
      </div>
    );
  }

  const mrr = Number(reporting?.mrr) || 0;
  const arr = Number(reporting?.arr) || 0;
  const activeCount = reporting?.active_subscriptions ?? activeSubs.length;
  const memberSince = primarySub?.start_date || primarySub?.current_term_start || null;
  const currencyBreakdown = Array.isArray(reporting?.currency_breakdown) ? reporting.currency_breakdown : [];

  return (
    <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#ffffff", minHeight: "calc(100vh - 4rem)" }}>
      <WorkspaceHeader
        title="Billing Subscription"
        subtitle="Current plan and subscription overview"
        icon={Repeat}
        organization={config}
        plan={primarySub ? (planMap[primarySub.plan_id] || "Active Plan") : null}
        currency={currency}
        actions={
          <button
            onClick={() => navigate("/billing/subscriptions")}
            className="flex items-center gap-2 px-4 py-2 rounded-xl text-[13px] font-semibold text-white bg-brand hover:bg-brand-hover transition-colors cursor-pointer"
          >
            Manage in Billing
          </button>
        }
      />

      {!primarySub && activeCount === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-10 text-center shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
            <Repeat className="w-8 h-8 text-slate-400" />
          </div>
          <h3 className="text-lg font-bold text-slate-800 mb-2">No Active Subscriptions</h3>
          <p className="text-[13px] text-slate-500 mb-4">Your organization does not have any active billing subscriptions yet.</p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <button onClick={() => navigate("/billing/subscriptions/create")} className="px-4 py-2 rounded-xl text-[13px] font-semibold text-white bg-brand hover:bg-brand-hover transition-colors cursor-pointer">
              Upgrade / Add Subscription
            </button>
            <button onClick={() => navigate("/billing/pricing")} className="px-4 py-2 rounded-xl text-[13px] font-semibold text-slate-700 bg-white border border-slate-200 cursor-pointer">
              View Pricing Plans
            </button>
          </div>
        </div>
      ) : (
        <>
          {primarySub && (
            <div className="rounded-3xl border border-slate-200 bg-white mb-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
              <div className="grid lg:grid-cols-3">
                <div className="lg:col-span-2 p-6">
                  <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                    <div>
                      <h2 className="text-xl font-bold text-slate-800">{planMap[primarySub.plan_id] || primarySub.plan_name || "Subscription Plan"}</h2>
                      <div className="mt-1"><StatusPill status={primarySub.status} /></div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                    <MiniTile label="Next Renewal" value={primarySub.next_billing_at ? new Date(primarySub.next_billing_at).toLocaleDateString() : "—"} />
                    <MiniTile label="Active Subscriptions" value={activeCount} />
                    <MiniTile label="Member Since" value={memberSince ? new Date(memberSince).toLocaleDateString() : "—"} />
                    <MiniTile label="Unit Price" value={formatOrgMoney(primarySub.unit_price, { default_currency: currency })} />
                    <MiniTile label="Quantity" value={primarySub.quantity || 1} />
                  </div>
                  <div className="flex items-center gap-4 mt-4 pt-4 border-t border-slate-100">
                    <button onClick={() => navigate("/billing/subscriptions/create")} className="text-[12.5px] font-semibold cursor-pointer flex items-center gap-1 text-brand hover:text-brand-hover">
                      Upgrade / Add Subscription <ArrowRight className="w-3 h-3" />
                    </button>
                    <button onClick={() => navigate("/billing/pricing")} className="text-[12.5px] font-semibold cursor-pointer flex items-center gap-1 text-slate-500 hover:text-slate-700">
                      View Pricing Plans <ArrowRight className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <div className="p-6 border-t lg:border-t-0 lg:border-l border-slate-100">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-3">Recurring Revenue</p>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">MRR</p>
                    <p className="text-xl font-extrabold text-slate-800">{formatOrgMoney(mrr, { default_currency: currency })}</p>
                  </div>
                  <div className="mt-4 pt-4 border-t border-slate-100">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">ARR</p>
                    <p className="text-xl font-extrabold text-slate-800">{formatOrgMoney(arr, { default_currency: currency })}</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {currencyBreakdown.length > 0 && (
            <div className="rounded-3xl border border-slate-200 bg-white p-6 mb-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
              <div className="flex items-center gap-2.5 mb-4">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-linear-to-r from-brand to-brand-hover text-white shadow-sm">
                  <Coins className="w-4 h-4" />
                </div>
                <h3 className="text-lg font-bold text-slate-800">MRR by Currency</h3>
              </div>
              <div className="flex flex-wrap gap-3">
                {currencyBreakdown.map((b) => (
                  <div key={b.currency} className="rounded-2xl border border-slate-200 bg-slate-50/60 px-4 py-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{b.currency}</p>
                    <p className="text-[15px] font-bold text-slate-800">{formatOrgMoney(b.amount, { default_currency: b.currency })}</p>
                  </div>
                ))}
              </div>
              {reporting?.excluded_subscriptions > 0 && (
                <p className="text-[11px] text-slate-400 mt-3">
                  {reporting.excluded_subscriptions} subscription(s) excluded — currency could not be converted to the reporting currency.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div className="rounded-3xl border border-slate-200 bg-white shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
              <div className="flex items-center justify-between px-6 pt-6 pb-4">
                <h3 className="text-lg font-bold text-slate-800">Recent Invoices</h3>
                <button onClick={() => navigate("/billing/invoices")} className="text-[12px] font-semibold cursor-pointer flex items-center gap-1 text-brand hover:text-brand-hover">
                  View all <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              {recentInvoices.length === 0 ? (
                <p className="text-[13px] text-slate-500 pb-6 px-6 text-center">No invoices yet</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-y border-slate-100 bg-slate-50/60 text-xs uppercase tracking-wider text-slate-400">
                        <th className="px-6 py-3 font-semibold">Invoice</th>
                        <th className="px-6 py-3 font-semibold">Status</th>
                        <th className="px-6 py-3 font-semibold text-right">Amount</th>
                        <th className="px-6 py-3 font-semibold">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentInvoices.map((inv) => (
                        <tr key={inv.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 transition-colors">
                          <td className="px-6 py-3.5">
                            <button onClick={() => navigate(`/billing/invoices/${inv.id}`)} className="text-[13px] font-semibold text-brand hover:text-brand-hover cursor-pointer">
                              {inv.invoice_number || `INV-${inv.id}`}
                            </button>
                          </td>
                          <td className="px-6 py-3.5"><StatusPill status={inv.status} /></td>
                          <td className="px-6 py-3.5 text-right text-[13px] font-semibold text-slate-800">{formatOrgMoney(inv.total_amount, { default_currency: currency })}</td>
                          <td className="px-6 py-3.5 text-[13px] text-slate-500">{(inv.issue_date || inv.created_at) ? new Date(inv.issue_date || inv.created_at).toLocaleDateString() : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
              <div className="flex items-center justify-between px-6 pt-6 pb-4">
                <h3 className="text-lg font-bold text-slate-800">Recent Payments</h3>
                <button onClick={() => navigate("/billing/payments")} className="text-[12px] font-semibold cursor-pointer flex items-center gap-1 text-brand hover:text-brand-hover">
                  View all <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              {recentPayments.length === 0 ? (
                <p className="text-[13px] text-slate-500 pb-6 px-6 text-center">No payments yet</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-y border-slate-100 bg-slate-50/60 text-xs uppercase tracking-wider text-slate-400">
                        <th className="px-6 py-3 font-semibold">Payment</th>
                        <th className="px-6 py-3 font-semibold">Status</th>
                        <th className="px-6 py-3 font-semibold text-right">Amount</th>
                        <th className="px-6 py-3 font-semibold">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentPayments.map((pay) => (
                        <tr key={pay.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 transition-colors">
                          <td className="px-6 py-3.5 text-[13px] font-semibold text-slate-800">{pay.payment_number || `PAY-${pay.id}`}</td>
                          <td className="px-6 py-3.5"><StatusPill status={pay.status} /></td>
                          <td className="px-6 py-3.5 text-right text-[13px] font-semibold text-slate-800">{formatOrgMoney(pay.amount, { default_currency: currency })}</td>
                          <td className="px-6 py-3.5 text-[13px] text-slate-500">{(pay.payment_date || pay.created_at) ? new Date(pay.payment_date || pay.created_at).toLocaleDateString() : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden mb-6">
            <div className="flex items-center justify-between px-6 pt-6 pb-4">
              <h3 className="text-lg font-bold text-slate-800">Active Subscriptions</h3>
              <span className="text-xs text-slate-400">{activeSubs.length} total</span>
            </div>
            {activeSubs.length === 0 ? (
              <p className="text-[13px] text-slate-500 pb-6 px-6 text-center">No active subscriptions</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-y border-slate-100 bg-slate-50/60 text-xs uppercase tracking-wider text-slate-400">
                      <th className="px-6 py-3 font-semibold">Subscription</th>
                      <th className="px-6 py-3 font-semibold">Plan</th>
                      <th className="px-6 py-3 font-semibold">Status</th>
                      <th className="px-6 py-3 font-semibold text-right">Amount</th>
                      <th className="px-6 py-3 font-semibold">Renews</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeSubs.map((sub) => (
                      <tr key={sub.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 transition-colors">
                        <td className="px-6 py-4">
                          <button onClick={() => navigate(`/billing/subscriptions/${sub.id}`)} className="text-[13px] font-semibold text-brand hover:text-brand-hover cursor-pointer">
                            {sub.subscription_number || `#${sub.id}`}
                          </button>
                        </td>
                        <td className="px-6 py-4 text-[13px] text-slate-600">{planMap[sub.plan_id] || `Plan #${sub.plan_id}`}</td>
                        <td className="px-6 py-4"><StatusPill status={sub.status} /></td>
                        <td className="px-6 py-4 text-right text-[13px] font-semibold text-slate-800">
                          {formatOrgMoney(Number(sub.unit_price || 0) * Number(sub.quantity || 1), { default_currency: currency })}
                        </td>
                        <td className="px-6 py-4 text-[13px] text-slate-500">{sub.next_billing_at ? new Date(sub.next_billing_at).toLocaleDateString() : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 mb-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-linear-to-r from-brand to-brand-hover text-white shadow-sm">
                <Layers className="w-4 h-4" />
              </div>
              <h3 className="text-lg font-bold text-slate-800">Usage</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-3 text-center">
                <p className="text-xl font-bold text-slate-800">{kpis?.active_customers ?? "—"}</p>
                <p className="text-[11px] font-medium text-slate-500 mt-1">Customers</p>
              </div>
              <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-3 text-center">
                <p className="text-xl font-bold text-slate-800">{productCount ?? "—"}</p>
                <p className="text-[11px] font-medium text-slate-500 mt-1">Products</p>
              </div>
              <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-3 text-center">
                <p className="text-xl font-bold text-slate-800">{activeCount}</p>
                <p className="text-[11px] font-medium text-slate-500 mt-1">Subscriptions</p>
              </div>
              <div className="rounded-2xl border border-slate-100 bg-slate-50/60 p-3 text-center">
                <p className="text-xl font-bold text-slate-800">{kpis?.total_invoices ?? "—"}</p>
                <p className="text-[11px] font-medium text-slate-500 mt-1">Invoices</p>
              </div>
            </div>
            <p className="text-[11px] text-slate-400 mt-3">
              These reflect current operational usage. No plan limit is configured for this organization.
            </p>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <h3 className="text-lg font-bold text-slate-800 mb-4">Billing Configuration</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
              <Field label="Default Currency" value={formatCurrencyChip(config)} />
              <Field label="Payment Terms" value={config?.default_payment_terms || "—"} />
              <Field label="Invoice Prefix" value={config?.invoice_prefix || "INV-"} />
              <Field label="Credit Note Prefix" value={config?.credit_note_prefix || "CN-"} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
