import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import {
  settingsApi, subscriptionApi, dashboardApi, productApi, invoiceApi, paymentApi,
} from "../../service/billingService";
import WorkspaceHeader from "./WorkspaceHeader";
import { formatOrgMoney, resolveOrgCurrency, formatCurrencyChip } from "./workspace-format";
import { Repeat, CreditCard, FileText, DollarSign, Calendar, Loader2, ArrowRight, AlertTriangle, Coins, Users, Package, Layers } from "lucide-react";

const INK = "#181433";
const INK_SOFT = "#4A4566";
const LINE = "rgba(24,20,51,0.08)";
const RED_100 = "#FBE6E4";
const RED = "#D6473C";
const TEAL = "#0F9B8E";
const TEAL_100 = "#DCF5F2";

function Field({ label, value }) {
  return (
    <div className="py-3" style={{ borderBottom: `1px solid ${LINE}` }}>
      <p className="text-[11px] font-bold uppercase tracking-[0.06em] mb-1" style={{ color: INK_SOFT }}>{label}</p>
      <p className="text-[14px] font-medium" style={{ color: INK }}>{value || "\u2014"}</p>
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
      <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#F8F7F4", minHeight: "calc(100vh - 4rem)" }}>
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-purple-600" /></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#F8F7F4", minHeight: "calc(100vh - 4rem)" }}>
        <div className="rounded-[14px] border p-4 text-sm" style={{ background: RED_100, borderColor: RED, color: RED }}>{error}</div>
      </div>
    );
  }

  const mrr = Number(reporting?.mrr) || 0;
  const arr = Number(reporting?.arr) || 0;
  const activeCount = reporting?.active_subscriptions ?? activeSubs.length;
  const memberSince = primarySub?.start_date || primarySub?.current_term_start || null;
  const currencyBreakdown = Array.isArray(reporting?.currency_breakdown) ? reporting.currency_breakdown : [];

  return (
    <div className="font-['Inter',system-ui,sans-serif] p-4 sm:p-6 lg:p-8" style={{ background: "#F8F7F4", color: INK, minHeight: "calc(100vh - 4rem)" }}>
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
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-semibold text-white cursor-pointer"
            style={{ background: "#7C3AED" }}
          >
            Manage in Billing
          </button>
        }
      />

      {!primarySub && activeCount === 0 ? (
        <div className="rounded-[20px] border bg-white p-10 text-center shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)]">
          <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mx-auto mb-4">
            <Repeat className="w-8 h-8 text-gray-400" />
          </div>
          <h3 className="text-lg font-bold mb-2" style={{ color: INK }}>No Active Subscriptions</h3>
          <p className="text-[13px] mb-4" style={{ color: INK_SOFT }}>Your organization does not have any active billing subscriptions yet.</p>
          <div className="flex items-center justify-center gap-3 flex-wrap">
            <button onClick={() => navigate("/billing/subscriptions/create")} className="px-4 py-2 rounded-lg text-[13px] font-semibold text-white cursor-pointer" style={{ background: "#7C3AED" }}>
              Upgrade / Add Subscription
            </button>
            <button onClick={() => navigate("/billing/pricing")} className="px-4 py-2 rounded-lg text-[13px] font-semibold cursor-pointer" style={{ background: "white", border: `1px solid ${LINE}`, color: INK }}>
              View Pricing Plans
            </button>
          </div>
        </div>
      ) : (
        <>
          {primarySub && (
            <div className="rounded-[20px] border bg-white p-6 mb-6 shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)]">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-xl font-bold" style={{ color: INK }}>{planMap[primarySub.plan_id] || primarySub.plan_name || "Subscription Plan"}</h2>
                  <StatusPill status={primarySub.status} />
                </div>
                {primarySub.next_billing_at && (
                  <div className="text-right">
                    <p className="text-[11px] font-bold uppercase tracking-[0.06em]" style={{ color: INK_SOFT }}>Next Billing</p>
                    <p className="text-[14px] font-semibold" style={{ color: INK }}>{new Date(primarySub.next_billing_at).toLocaleDateString()}</p>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
                <div className="rounded-lg p-3" style={{ background: TEAL_100 }}>
                  <p className="text-[11px] font-bold uppercase" style={{ color: TEAL }}>MRR</p>
                  <p className="text-lg font-bold" style={{ color: INK }}>{formatOrgMoney(mrr, { default_currency: currency })}</p>
                </div>
                <div className="rounded-lg p-3" style={{ background: TEAL_100 }}>
                  <p className="text-[11px] font-bold uppercase" style={{ color: TEAL }}>ARR</p>
                  <p className="text-lg font-bold" style={{ color: INK }}>{formatOrgMoney(arr, { default_currency: currency })}</p>
                </div>
                <div className="rounded-lg p-3 bg-purple-50">
                  <p className="text-[11px] font-bold uppercase text-purple-600">Active Subscriptions</p>
                  <p className="text-lg font-bold" style={{ color: INK }}>{activeCount}</p>
                </div>
                <div className="rounded-lg p-3 bg-purple-50">
                  <p className="text-[11px] font-bold uppercase text-purple-600">Member Since</p>
                  <p className="text-lg font-bold" style={{ color: INK }}>{memberSince ? new Date(memberSince).toLocaleDateString() : "—"}</p>
                </div>
                <div className="rounded-lg p-3 bg-purple-50">
                  <p className="text-[11px] font-bold uppercase text-purple-600">Unit Price</p>
                  <p className="text-lg font-bold" style={{ color: INK }}>{formatOrgMoney(primarySub.unit_price, { default_currency: currency })}</p>
                </div>
                <div className="rounded-lg p-3 bg-purple-50">
                  <p className="text-[11px] font-bold uppercase text-purple-600">Quantity</p>
                  <p className="text-lg font-bold" style={{ color: INK }}>{primarySub.quantity || 1}</p>
                </div>
              </div>
              <div className="flex items-center gap-4 mt-4 pt-4" style={{ borderTop: `1px solid ${LINE}` }}>
                <button onClick={() => navigate("/billing/subscriptions/create")} className="text-[12.5px] font-semibold cursor-pointer flex items-center gap-1" style={{ color: "#7C3AED" }}>
                  Upgrade / Add Subscription <ArrowRight className="w-3 h-3" />
                </button>
                <button onClick={() => navigate("/billing/pricing")} className="text-[12.5px] font-semibold cursor-pointer flex items-center gap-1" style={{ color: INK_SOFT }}>
                  View Pricing Plans <ArrowRight className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}

          {currencyBreakdown.length > 0 && (
            <div className="rounded-[20px] border bg-white p-6 mb-6 shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)]">
              <div className="flex items-center gap-2.5 mb-4">
                <Coins className="w-4 h-4" style={{ color: TEAL }} />
                <h3 className="text-[14px] font-bold" style={{ color: INK }}>MRR by Currency</h3>
              </div>
              <div className="flex flex-wrap gap-3">
                {currencyBreakdown.map((b) => (
                  <div key={b.currency} className="rounded-lg px-4 py-2.5" style={{ background: TEAL_100 }}>
                    <p className="text-[11px] font-bold uppercase" style={{ color: TEAL }}>{b.currency}</p>
                    <p className="text-[15px] font-bold" style={{ color: INK }}>{formatOrgMoney(b.amount, { default_currency: b.currency })}</p>
                  </div>
                ))}
              </div>
              {reporting?.excluded_subscriptions > 0 && (
                <p className="text-[11px] mt-3" style={{ color: INK_SOFT }}>
                  {reporting.excluded_subscriptions} subscription(s) excluded — currency could not be converted to the reporting currency.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            <div className="rounded-[20px] border bg-white p-6 shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)]">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[14px] font-bold" style={{ color: INK }}>Recent Invoices</h3>
                <button onClick={() => navigate("/billing/invoices")} className="text-[12px] font-semibold cursor-pointer flex items-center gap-1" style={{ color: TEAL }}>
                  View all invoices <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              {recentInvoices.length === 0 ? (
                <p className="text-[13px] py-4 text-center" style={{ color: INK_SOFT }}>No invoices yet</p>
              ) : (
                <div className="space-y-2">
                  {recentInvoices.map((inv) => (
                    <div key={inv.id} onClick={() => navigate(`/billing/invoices/${inv.id}`)} className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 cursor-pointer">
                      <div>
                        <p className="text-[13px] font-medium" style={{ color: INK }}>{inv.invoice_number || `INV-${inv.id}`}</p>
                        <StatusPill status={inv.status} />
                      </div>
                      <p className="text-[13px] font-semibold" style={{ color: INK }}>{formatOrgMoney(inv.total_amount, { default_currency: currency })}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-[20px] border bg-white p-6 shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)]">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[14px] font-bold" style={{ color: INK }}>Recent Payments</h3>
                <button onClick={() => navigate("/billing/payments")} className="text-[12px] font-semibold cursor-pointer flex items-center gap-1" style={{ color: TEAL }}>
                  View all payments <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              {recentPayments.length === 0 ? (
                <p className="text-[13px] py-4 text-center" style={{ color: INK_SOFT }}>No payments yet</p>
              ) : (
                <div className="space-y-2">
                  {recentPayments.map((pay) => (
                    <div key={pay.id} className="flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 cursor-pointer">
                      <div>
                        <p className="text-[13px] font-medium" style={{ color: INK }}>{pay.payment_number || `PAY-${pay.id}`}</p>
                        <StatusPill status={pay.status} />
                      </div>
                      <p className="text-[13px] font-semibold" style={{ color: INK }}>{formatOrgMoney(pay.amount, { default_currency: currency })}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="rounded-[20px] border bg-white p-6 mb-6 shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)]">
            <div className="flex items-center gap-2.5 mb-4">
              <Layers className="w-4 h-4" style={{ color: TEAL }} />
              <h3 className="text-[14px] font-bold" style={{ color: INK }}>Usage</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="rounded-lg border p-3 text-center" style={{ borderColor: LINE }}>
                <p className="text-[20px] font-bold" style={{ color: INK }}>{kpis?.active_customers ?? "—"}</p>
                <p className="text-[11px] font-medium mt-1" style={{ color: INK_SOFT }}>Customers</p>
              </div>
              <div className="rounded-lg border p-3 text-center" style={{ borderColor: LINE }}>
                <p className="text-[20px] font-bold" style={{ color: INK }}>{productCount ?? "—"}</p>
                <p className="text-[11px] font-medium mt-1" style={{ color: INK_SOFT }}>Products</p>
              </div>
              <div className="rounded-lg border p-3 text-center" style={{ borderColor: LINE }}>
                <p className="text-[20px] font-bold" style={{ color: INK }}>{activeCount}</p>
                <p className="text-[11px] font-medium mt-1" style={{ color: INK_SOFT }}>Subscriptions</p>
              </div>
              <div className="rounded-lg border p-3 text-center" style={{ borderColor: LINE }}>
                <p className="text-[20px] font-bold" style={{ color: INK }}>{kpis?.total_invoices ?? "—"}</p>
                <p className="text-[11px] font-medium mt-1" style={{ color: INK_SOFT }}>Invoices</p>
              </div>
            </div>
            <p className="text-[11px] mt-3" style={{ color: INK_SOFT }}>
              These reflect current operational usage. No plan limit is configured for this organization.
            </p>
          </div>

          <div className="rounded-[20px] border bg-white p-6 shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)]">
            <h3 className="text-[14px] font-bold mb-4" style={{ color: INK }}>Billing Configuration</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8">
              <Field label="Default Currency" value={formatCurrencyChip(config)} />
              <Field label="Payment Terms" value={config?.default_payment_terms || "\u2014"} />
              <Field label="Invoice Prefix" value={config?.invoice_prefix || "INV-"} />
              <Field label="Credit Note Prefix" value={config?.credit_note_prefix || "CN-"} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
