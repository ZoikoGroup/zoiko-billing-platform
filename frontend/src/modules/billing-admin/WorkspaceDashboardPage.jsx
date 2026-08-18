import React, { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import {
  dashboardApi, settingsApi, subscriptionApi, productApi, invoiceApi, customerApi,
} from "../../service/billingService";
import { getOrganizationDetails } from "../../service/orgAdminService";
import WorkspaceHeader from "./WorkspaceHeader";
import { formatOrgMoney, normalizeOrgName } from "./workspace-format";
import {
  Users, Building2, FileText, AlertTriangle, Wallet, TrendingUp, Repeat,
  Package, CreditCard, BarChart3, ArrowRight, Loader2, Mail, ShieldCheck, Globe,
} from "lucide-react";

const VIOLET = "#5B3FE0";
const AMBER = "#F5A340";
const TEAL = "#0F9B8E";
const RED = "#D6473C";
const INK = "#181433";
const INK_SOFT = "#4A4566";
const VIOLET_100 = "#EDE9FE";
const AMBER_100 = "#FDECD6";
const TEAL_100 = "#DCF5F2";
const RED_100 = "#FBE6E4";
const LINE = "rgba(24,20,51,0.08)";

const AVATAR_COLORS = [
  `linear-gradient(135deg,${VIOLET},#7A5CF0)`,
  `linear-gradient(135deg,${AMBER},#E8862C)`,
  `linear-gradient(135deg,${TEAL},#0C7B70)`,
  `linear-gradient(135deg,#8B85AE,#5F5885)`,
];

function avatarBg(i) { return AVATAR_COLORS[i % AVATAR_COLORS.length]; }

function todayLabel() {
  const d = new Date();
  const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const da = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  return `${da[d.getDay()]}, ${d.getDate()} ${mo[d.getMonth()]} ${d.getFullYear()}`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function computeHealth(kpis) {
  if (!kpis) return null;
  const overdue = Number(kpis.overdue_amount) || 0;
  const outstanding = Number(kpis.outstanding_amount) || 0;
  if (overdue > 0 || outstanding > 5000) return { label: "Attention", tone: "attention" };
  if (outstanding > 0) return { label: "Good", tone: "good" };
  return { label: "Healthy", tone: "good" };
}

const StatCard = React.memo(({ icon: Icon, iconBg, iconColor, label, value, sub, onClick }) => (
  <div onClick={onClick} className="rounded-[14px] border bg-white p-5 shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)] hover:-translate-y-0.5 hover:shadow-[0_4px_10px_rgba(24,20,51,0.06),0_20px_40px_-20px_rgba(59,46,138,0.25)] hover:border-transparent transition-all duration-[180ms] cursor-pointer">
    <div className="w-[38px] h-[38px] rounded-[10px] flex items-center justify-center mb-4" style={{ background: iconBg, color: iconColor }}>
      <Icon className="w-[18px] h-[18px]" strokeWidth={2.5} />
    </div>
    <p className="text-[12.5px] font-medium" style={{ color: INK_SOFT }}>{label}</p>
    <p className="text-[29px] font-bold tracking-[-0.01em] leading-none mt-1.5" style={{ color: INK }}>{value}</p>
    {sub ? <p className="text-[11.5px] mt-1.5" style={{ color: INK_SOFT }}>{sub}</p> : null}
  </div>
));

function SkeletonCard() {
  return (
    <div className="rounded-[14px] border bg-white p-5 animate-pulse">
      <div className="w-[38px] h-[38px] rounded-[10px] bg-gray-100 mb-4" />
      <div className="h-3 w-20 bg-gray-100 rounded mb-2" />
      <div className="h-7 w-16 bg-gray-100 rounded" />
    </div>
  );
}

export default function WorkspaceDashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [kpis, setKpis] = useState(null);
  const [config, setConfig] = useState(null);
  const [org, setOrg] = useState(null);
  const [activeSubs, setActiveSubs] = useState([]);
  const [plans, setPlans] = useState([]);
  const [productCount, setProductCount] = useState(0);
  const [recentInvoices, setRecentInvoices] = useState([]);
  const [recentActivity, setRecentActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [k, c, o, subs, pl, prod, inv, act] = await Promise.allSettled([
          dashboardApi.getKPIs(),
          settingsApi.getConfig(),
          getOrganizationDetails(),
          subscriptionApi.listActive(),
          subscriptionApi.listPlans({ per_page: 200 }),
          productApi.list({ page: 1, per_page: 1 }),
          invoiceApi.list({ page: 1, per_page: 5 }),
          invoiceApi.getRecentActivity(6),
        ]);
        if (cancelled) return;
        if (k.status === "fulfilled") setKpis(k.value);
        if (c.status === "fulfilled") setConfig(c.value);
        if (o.status === "fulfilled") setOrg(o.value);
        if (subs.status === "fulfilled") setActiveSubs(Array.isArray(subs.value) ? subs.value : []);
        if (pl.status === "fulfilled") setPlans(pl.value?.items || []);
        if (prod.status === "fulfilled") setProductCount(prod.value?.total || 0);
        if (inv.status === "fulfilled") setRecentInvoices(inv.value?.items || []);
        if (act.status === "fulfilled") setRecentActivity(Array.isArray(act.value) ? act.value : []);
      } catch (err) {
        if (!cancelled) setError(err?.message || "Failed to load dashboard");
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

  const currency = config?.default_currency || config?.base_currency || org?.currency || "USD";
  const planName = primarySub ? (planMap[primarySub.plan_id] || primarySub.plan_name || "Active Plan") : null;
  const health = computeHealth(kpis);

  const kpiCards = useMemo(() => [
    { key: "active_customers", label: "Customers", icon: Users, iconBg: VIOLET_100, iconColor: VIOLET, path: "/billing/customers" },
    { key: "active_subscriptions", label: "Active Subscriptions", icon: Repeat, iconBg: TEAL_100, iconColor: TEAL, path: "/billing/subscriptions" },
    { key: "total_invoices", label: "Invoices", icon: FileText, iconBg: AMBER_100, iconColor: AMBER, path: "/billing/invoices" },
    { key: "overdue_amount", label: "Overdue", icon: AlertTriangle, iconBg: RED_100, iconColor: RED, path: "/billing/collections-receivables" },
    { key: "outstanding_amount", label: "Outstanding", icon: Wallet, iconBg: RED_100, iconColor: RED, path: "/billing/invoices", fmt: true },
    { key: "total_revenue", label: "Revenue", icon: TrendingUp, iconBg: TEAL_100, iconColor: TEAL, path: "/billing/reports", fmt: true },
  ], []);

  const quickActions = [
    { label: "Create Customer", icon: Users, path: "/billing/customers", color: VIOLET },
    { label: "Create Product", icon: Package, path: "/billing/products", color: TEAL },
    { label: "Create Quote", icon: FileText, path: "/billing/quotations/create", color: AMBER },
    { label: "Create Contract", icon: FileText, path: "/billing/contracts/create", color: VIOLET },
    { label: "Create Subscription", icon: Repeat, path: "/billing/subscriptions/create", color: TEAL },
    { label: "Create Invoice", icon: FileText, path: "/billing/invoices/create", color: AMBER },
    { label: "Record Payment", icon: CreditCard, path: "/billing/payments", color: TEAL },
  ];

  return (
    <div className="font-['Inter',system-ui,sans-serif] p-4 sm:p-6 lg:p-8" style={{ background: "#F8F7F4", color: INK, minHeight: "calc(100vh - 4rem)" }}>
      {error && (
        <div className="mb-4 rounded-[14px] border p-4 text-sm" style={{ background: RED_100, borderColor: RED, color: RED }}>
          {error}
        </div>
      )}

      <WorkspaceHeader
        title="My Organization"
        subtitle="Billing Overview"
        icon={Building2}
        organization={org || config}
        health={health}
        plan={planName}
        outstanding={kpis?.outstanding_amount}
        fiscalYear={config?.fiscal_year_start}
        currency={currency}
      />

      <div className="flex items-center justify-between gap-4 flex-wrap rounded-[16px] border bg-white px-5 py-4 mb-[22px]" style={{ borderColor: LINE }}>
        <div className="flex items-center gap-6 flex-wrap">
          {(config?.billing_email || org?.email) && (
            <div className="flex items-center gap-2 text-[13px]" style={{ color: INK_SOFT }}>
              <Mail className="w-3.5 h-3.5" />
              {config?.billing_email || org?.email}
            </div>
          )}
          {(config?.gst_number || config?.vat_number || config?.pan_number || config?.tin_number) && (
            <div className="flex items-center gap-2 text-[13px]" style={{ color: INK_SOFT }}>
              <ShieldCheck className="w-3.5 h-3.5" />
              Tax ID: {config?.gst_number || config?.vat_number || config?.pan_number || config?.tin_number}
            </div>
          )}
          {(config?.timezone || org?.timezone) && (
            <div className="flex items-center gap-2 text-[13px]" style={{ color: INK_SOFT }}>
              <Globe className="w-3.5 h-3.5" />
              {config?.timezone || org?.timezone}
            </div>
          )}
        </div>
        <button onClick={() => navigate("/billing/workspace/organization")} className="flex items-center gap-1.5 text-[12.5px] font-semibold cursor-pointer" style={{ color: VIOLET }}>
          View full profile <ArrowRight className="w-3 h-3" />
        </button>
      </div>

      <div className="flex items-center justify-between gap-4 flex-wrap rounded-[16px] border bg-white px-5 py-4 mb-[22px]" style={{ borderColor: LINE }}>
        <div className="flex items-center gap-4 flex-wrap">
          <div className="w-9 h-9 rounded-[10px] flex items-center justify-center" style={{ background: VIOLET_100, color: VIOLET }}>
            <Repeat className="w-[18px] h-[18px]" />
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.06em]" style={{ color: INK_SOFT }}>Current Billing Plan</p>
            {primarySub ? (
              <p className="text-[14px] font-semibold" style={{ color: INK }}>
                {planName} · {primarySub.status || "active"}
                {primarySub.next_billing_at && ` · Renews ${new Date(primarySub.next_billing_at).toLocaleDateString()}`}
              </p>
            ) : (
              <p className="text-[14px] font-medium" style={{ color: INK_SOFT }}>No active subscription plan</p>
            )}
          </div>
        </div>
        <button onClick={() => navigate("/billing/workspace/subscription")} className="flex items-center gap-1.5 text-[12.5px] font-semibold cursor-pointer" style={{ color: VIOLET }}>
          Manage Subscription <ArrowRight className="w-3 h-3" />
        </button>
      </div>

      <div
        className="relative flex justify-between items-center gap-6 mb-[22px] rounded-[20px] px-[34px] py-[30px] text-white overflow-hidden"
        style={{ background: "linear-gradient(120deg, #1E1447 0%, #3B2E8A 62%, #4C3AAE 100%)", boxShadow: "0 4px 10px rgba(24,20,51,0.06), 0 20px 40px -20px rgba(59,46,138,0.25)" }}
      >
        <div className="absolute rounded-full pointer-events-none" style={{ right: -60, top: -90, width: 280, height: 280, background: "radial-gradient(circle, rgba(245,163,64,0.35), transparent 70%)" }} />
        <div className="z-[1]">
          <p className="text-[11.5px] font-bold uppercase tracking-[0.12em]" style={{ color: "rgba(255,255,255,0.55)" }}>{todayLabel()}</p>
          <h1 className="font-['Sora',system-ui,sans-serif] text-[27px] font-bold tracking-[-0.01em] mt-2">{greeting()}, {user?.first_name || "there"}</h1>
          <p className="mt-1.5 text-[14px] max-w-[520px]" style={{ color: "rgba(255,255,255,0.68)" }}>
            {kpis?.active_customers ?? 0} customers · {formatOrgMoney(kpis?.outstanding_amount, config)} outstanding across {kpis?.total_invoices ?? 0} invoices.
          </p>
          <div className="flex gap-2.5 mt-[18px]">
            <button onClick={() => navigate("/billing/customers")} className="flex items-center gap-2 px-[18px] py-2.5 rounded-[11px] text-[13.5px] font-semibold border-none cursor-pointer whitespace-nowrap" style={{ background: `linear-gradient(135deg,${AMBER},#E8862C)`, color: "#241000", boxShadow: "0 8px 20px -8px rgba(232,134,44,0.7)" }}>
              Manage Customers
            </button>
            <button onClick={() => navigate("/billing/invoices")} className="flex items-center gap-2 px-[18px] py-2.5 rounded-[11px] text-[13.5px] font-semibold cursor-pointer whitespace-nowrap" style={{ background: "rgba(255,255,255,0.1)", color: "#fff", border: "1px solid rgba(255,255,255,0.22)" }}>
              View Invoices
            </button>
          </div>
        </div>
      </div>

      <div className="flex items-baseline justify-between mb-[14px]">
        <h2 className="font-['Sora',system-ui,sans-serif] text-[15.5px] font-bold tracking-[-0.01em]" style={{ color: INK }}>Key Metrics</h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
          : kpiCards.map((kpi) => (
            <StatCard
              key={kpi.key}
              icon={kpi.icon}
              iconBg={kpi.iconBg}
              iconColor={kpi.iconColor}
              label={kpi.label}
              value={kpis ? (kpi.fmt ? formatOrgMoney(kpis[kpi.key], config) : (kpis[kpi.key] ?? 0)) : "\u2014"}
              onClick={() => navigate(kpi.path)}
            />
          ))}
      </div>

      <div className="flex items-baseline justify-between mb-[14px] mt-[30px]">
        <h2 className="font-['Sora',system-ui,sans-serif] text-[15.5px] font-bold tracking-[-0.01em]" style={{ color: INK }}>Quick Actions</h2>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-[30px]">
        {quickActions.map((a) => (
          <button key={a.path} onClick={() => navigate(a.path)} className="flex items-center gap-3 p-4 rounded-[14px] border bg-white hover:-translate-y-0.5 hover:shadow-md transition-all cursor-pointer text-left">
            <div className="w-9 h-9 rounded-[10px] flex items-center justify-center" style={{ background: `${a.color}15`, color: a.color }}>
              <a.icon className="w-[18px] h-[18px]" />
            </div>
            <span className="text-[13px] font-semibold" style={{ color: INK }}>{a.label}</span>
          </button>
        ))}
      </div>

      <div className="flex items-baseline justify-between mb-[14px]">
        <h2 className="font-['Sora',system-ui,sans-serif] text-[15.5px] font-bold tracking-[-0.01em]" style={{ color: INK }}>Recent Invoices</h2>
        <button onClick={() => navigate("/billing/invoices")} className="text-[12.5px] font-semibold cursor-pointer flex items-center gap-1" style={{ color: VIOLET }}>
          View all <ArrowRight className="w-3 h-3" />
        </button>
      </div>
      <div className="rounded-[20px] border overflow-hidden shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)]" style={{ background: "#fff", borderColor: LINE }}>
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Invoice", "Status", "Amount"].map((h) => (
                  <th key={h} className="text-left text-[11px] font-bold uppercase tracking-[0.05em] px-[14px] py-[13px]" style={{ color: INK_SOFT, borderBottom: `2px solid ${LINE}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentInvoices.length === 0 ? (
                <tr><td colSpan={3} className="px-[14px] py-8 text-center text-[13px]" style={{ color: INK_SOFT }}>No invoices yet</td></tr>
              ) : recentInvoices.map((inv) => (
                <tr key={inv.id} onClick={() => navigate(`/billing/invoices/${inv.id}`)} className="cursor-pointer hover:bg-gray-50">
                  <td className="px-[14px] py-[13px] text-[13px] font-medium" style={{ borderBottom: `1px solid ${LINE}`, color: VIOLET }}>{inv.invoice_number || `INV-${inv.id}`}</td>
                  <td className="px-[14px] py-[13px] text-[13px]" style={{ borderBottom: `1px solid ${LINE}` }}>
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium ${
                      inv.status === "paid" ? "bg-emerald-50 text-emerald-700" :
                      inv.status === "overdue" ? "bg-red-50 text-red-700" :
                      inv.status === "sent" ? "bg-blue-50 text-blue-700" :
                      "bg-gray-50 text-gray-700"
                    }`}>{inv.status || "draft"}</span>
                  </td>
                  <td className="px-[14px] py-[13px] text-[13px] font-semibold" style={{ borderBottom: `1px solid ${LINE}` }}>{formatOrgMoney(inv.total_amount, config)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
