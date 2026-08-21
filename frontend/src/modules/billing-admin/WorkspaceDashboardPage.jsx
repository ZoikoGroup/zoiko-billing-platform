import React, { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import {
  dashboardApi, settingsApi, subscriptionApi, productApi, invoiceApi,
} from "../../service/billingService";
import { getOrganizationDetails } from "../../service/orgAdminService";
import WorkspaceHeader from "./WorkspaceHeader";
import { formatOrgMoney, normalizeOrgName, formatCurrencyChip, formatFiscalYearLabel } from "./workspace-format";
import {
  Users, Building2, FileText, AlertTriangle, Wallet, TrendingUp, Repeat,
  Package, CreditCard, ArrowRight, Mail, ShieldCheck, Globe,
  Phone, MapPin, CalendarClock, UserCheck, History, Settings, Megaphone, Bell,
} from "lucide-react";

const KPI_COLORS = {
  active_customers: "#7C3AED",
  active_subscriptions: "#2563EB",
  total_invoices: "#D97706",
  overdue_amount: "#DC2626",
  outstanding_amount: "#DC2626",
  total_revenue: "#059669",
};

function computeHealth(kpis) {
  if (!kpis) return null;
  const overdue = Number(kpis.overdue_amount) || 0;
  const outstanding = Number(kpis.outstanding_amount) || 0;
  if (overdue > 0 || outstanding > 5000) return { label: "Attention", tone: "attention" };
  if (outstanding > 0) return { label: "Good", tone: "good" };
  return { label: "Healthy", tone: "good" };
}

const HEALTH_STYLES = {
  good: { dot: "bg-emerald-500", text: "text-emerald-700", ring: "border-emerald-200 bg-emerald-50" },
  attention: { dot: "bg-amber-500", text: "text-amber-700", ring: "border-amber-200 bg-amber-50" },
  risk: { dot: "bg-red-500", text: "text-red-700", ring: "border-red-200 bg-red-50" },
};

function StatusPill({ status }) {
  const map = {
    active: "bg-emerald-50 text-emerald-700",
    paused: "bg-amber-50 text-amber-700",
    cancelled: "bg-red-50 text-red-700",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium ${map[status] || "bg-gray-50 text-gray-600"}`}>
      {status || "unknown"}
    </span>
  );
}

function IdentityChip({ icon: Icon, label, value }) {
  if (!value) return null;
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50/60 px-4 py-3 min-w-0">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        <Icon className="w-3 h-3 shrink-0" />
        {label}
      </div>
      <p className="text-[13px] font-semibold text-slate-800 mt-1 truncate">{value}</p>
    </div>
  );
}

const StatCard = React.memo(({ icon: Icon, color, label, value, subtitle, onClick }) => (
  <div onClick={onClick} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)] cursor-pointer transition-shadow hover:shadow-[0_4px_20px_rgba(0,0,0,0.06)]">
    <div className="flex items-start justify-between gap-2 mb-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${color}15`, color }}>
        <Icon className="w-[18px] h-[18px]" strokeWidth={2.5} />
      </div>
    </div>
    <p className="text-2xl font-extrabold tracking-[-0.01em] leading-none text-slate-800">{value}</p>
    {subtitle && <p className="text-[11px] text-slate-400 mt-1">{subtitle}</p>}
  </div>
));

function SkeletonCard() {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 animate-pulse">
      <div className="w-9 h-9 rounded-xl bg-slate-200/80 mb-4" />
      <div className="h-3 w-20 bg-slate-200/80 rounded mb-2" />
      <div className="h-7 w-16 bg-slate-200/80 rounded" />
    </div>
  );
}

export default function WorkspaceDashboardPage() {
  const { user, role } = useAuth();
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

  const currency = config?.default_currency || config?.base_currency || org?.currency;
  const planName = primarySub ? (planMap[primarySub.plan_id] || primarySub.plan_name || "Active Plan") : null;
  const health = computeHealth(kpis);
  const healthStyle = HEALTH_STYLES[health?.tone] || HEALTH_STYLES.good;
  const companyName = normalizeOrgName(config?.company_name || org?.name);
  const taxId = config?.gst_number || config?.vat_number || config?.pan_number || config?.tin_number;
  const address = [config?.city, config?.state, config?.country].filter(Boolean).join(", ");

  const kpiCards = useMemo(() => [
    { key: "active_customers", label: "Customers", icon: Users, path: "/billing/customers", subtitle: "Active customers" },
    { key: "active_subscriptions", label: "Active Subscriptions", icon: Repeat, path: "/billing/subscriptions", subtitle: "Active in Billing" },
    { key: "total_invoices", label: "Invoices", icon: FileText, path: "/billing/invoices", subtitle: "Total invoices" },
    { key: "overdue_amount", label: "Overdue", icon: AlertTriangle, path: "/billing/collections-receivables", fmt: true, subtitle: "Needs attention" },
    { key: "outstanding_amount", label: "Outstanding", icon: Wallet, path: "/billing/invoices", fmt: true, subtitle: "Outstanding balance" },
    { key: "total_revenue", label: "Revenue", icon: TrendingUp, path: "/billing/reports", fmt: true, subtitle: "Total revenue" },
  ], []);

  const quickActions = [
    { label: "Manage Customers", icon: Users, path: "/billing/customers" },
    { label: "Create Product", icon: Package, path: "/billing/products" },
    { label: "Create Quote", icon: FileText, path: "/billing/quotations/create" },
    { label: "Create Contract", icon: FileText, path: "/billing/contracts/create" },
    { label: "Create Subscription", icon: Repeat, path: "/billing/subscriptions/create" },
    { label: "View Invoices", icon: FileText, path: "/billing/invoices" },
    { label: "Record Payment", icon: CreditCard, path: "/billing/payments" },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8" style={{ background: "#ffffff", minHeight: "calc(100vh - 4rem)" }}>
      {error && (
        <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {role === "billing_admin" && (
        <div className="mb-6 flex items-center gap-3 rounded-3xl border border-amber-200/70 bg-amber-50 px-5 py-3.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-linear-to-r from-brand to-brand-hover text-white shrink-0">
            <UserCheck className="w-[18px] h-[18px]" />
          </span>
          <div>
            <p className="text-sm font-bold text-slate-800">Organization Workspace</p>
            <p className="text-xs text-slate-500">
              You are managing <span className="font-semibold text-slate-700">{companyName || "your organization"}</span>. The full Zoiko Billing product remains available underneath this workspace.
            </p>
          </div>
        </div>
      )}

      <WorkspaceHeader
        title="Organization Overview"
        icon={Building2}
        organization={org || config}
        health={health}
        plan={planName}
        outstanding={kpis?.outstanding_amount}
        fiscalYear={config?.fiscal_year_start ? formatFiscalYearLabel(config.fiscal_year_start) : null}
        currency={currency}
        actions={
          <button
            onClick={() => navigate("/billing/settings")}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-medium transition-colors cursor-pointer"
          >
            <Settings className="w-3.5 h-3.5" /> Billing Settings
          </button>
        }
      />

      <div className="rounded-3xl border border-slate-200 bg-white p-6 mb-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-linear-to-r from-brand to-brand-hover text-white shadow-sm">
              <Building2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">{companyName || "Organization"}</h2>
              {config?.company_name && <p className="text-[12px] text-slate-400">Legal Business Name · {config.company_name}</p>}
            </div>
          </div>
          <button onClick={() => navigate("/billing/workspace/organization")} className="flex items-center gap-1.5 text-[12.5px] font-semibold cursor-pointer text-brand hover:text-brand-hover">
            View Profile <ArrowRight className="w-3 h-3" />
          </button>
        </div>
        <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-7">
          <IdentityChip icon={Mail} label="Business Email" value={config?.billing_email || org?.email} />
          <IdentityChip icon={Phone} label="Phone" value={config?.billing_phone || org?.phone} />
          <IdentityChip icon={ShieldCheck} label="Tax ID" value={taxId} />
          <IdentityChip icon={Wallet} label="Default Currency" value={formatCurrencyChip(config)} />
          <IdentityChip icon={Globe} label="Timezone" value={config?.timezone || org?.timezone} />
          <IdentityChip icon={CalendarClock} label="Financial Year" value={formatFiscalYearLabel(config?.fiscal_year_start)} />
          <IdentityChip icon={MapPin} label="Address" value={address} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <div className="flex items-center gap-2.5 mb-5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-linear-to-r from-brand to-brand-hover text-white shadow-sm">
              <CreditCard className="w-[18px] h-[18px]" />
            </div>
            <h2 className="text-lg font-bold text-slate-800">Current Billing Plan</h2>
          </div>
          {primarySub ? (
            <>
              <p className="text-2xl font-extrabold text-slate-900">{planName}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <StatusPill status={primarySub.status} />
                <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                  <CalendarClock className="w-3.5 h-3.5" />
                  Renews {primarySub.next_billing_at ? new Date(primarySub.next_billing_at).toLocaleDateString() : "—"}
                </span>
              </div>
            </>
          ) : (
            <p className="text-sm font-medium text-slate-500">No active subscription plan</p>
          )}
          <button onClick={() => navigate("/billing/workspace/subscription")} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-brand hover:bg-brand-hover px-4 py-2.5 text-[13px] font-semibold text-white transition-colors cursor-pointer">
            Manage Subscription
          </button>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <div className="flex items-center gap-2.5 mb-5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-linear-to-r from-brand to-brand-hover text-white shadow-sm">
              <TrendingUp className="w-[18px] h-[18px]" />
            </div>
            <h2 className="text-lg font-bold text-slate-800">Billing Health</h2>
          </div>
          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-bold ${healthStyle.ring} ${healthStyle.text}`}>
            <span className={`h-2 w-2 rounded-full ${healthStyle.dot}`} />
            {health?.label || "—"}
          </span>
          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            {kpis?.active_customers ?? 0} customers · {formatOrgMoney(kpis?.outstanding_amount, config)} outstanding across {kpis?.total_invoices ?? 0} invoices.
          </p>
        </div>
      </div>

      <div className="flex items-baseline justify-between mb-3.5">
        <h2 className="text-base font-bold text-slate-800">Key Financial Information</h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
          : kpiCards.map((kpi) => (
            <StatCard
              key={kpi.key}
              icon={kpi.icon}
              color={KPI_COLORS[kpi.key]}
              label={kpi.label}
              value={kpis ? (kpi.fmt ? formatOrgMoney(kpis[kpi.key], config) : (kpis[kpi.key] ?? 0)) : "—"}
              subtitle={kpi.subtitle}
              onClick={() => navigate(kpi.path)}
            />
          ))}
      </div>

      <div className="flex items-baseline justify-between mb-3.5 mt-8">
        <h2 className="text-base font-bold text-slate-800">Quick Actions</h2>
        <span className="text-xs text-slate-400">Reuses the existing Billing pages</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-8">
        {quickActions.map((a) => (
          <button key={a.path} onClick={() => navigate(a.path)} className="flex items-center gap-3 p-4 rounded-2xl border border-slate-200 bg-slate-50/60 hover:bg-white hover:shadow-md transition-all cursor-pointer text-left">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-linear-to-r from-brand to-brand-hover text-white shadow-sm">
              <a.icon className="w-[18px] h-[18px]" />
            </div>
            <span className="text-[13px] font-semibold text-slate-800">{a.label}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-3 items-stretch mb-6">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-slate-800">Recent Activity</h2>
            <button onClick={() => navigate("/billing/workspace/activity")} className="text-xs font-semibold cursor-pointer text-brand hover:text-brand-hover">
              View all
            </button>
          </div>
          {recentActivity.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-8 text-center">
              <History className="w-6 h-6 text-slate-300 mx-auto mb-2" />
              <p className="text-[13px] text-slate-500">Billing activity will appear here as it happens.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {recentActivity.map((item, idx) => (
                <div key={item?.id ?? idx} className="flex items-start gap-3 border-b border-slate-100 pb-3 last:border-0 last:pb-0">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                    <FileText className="w-[15px] h-[15px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-700">
                      {item?.description || item?.event_type || item?.action || `Invoice #${item?.invoice_number || item?.invoice_id || ""}`}
                    </p>
                    <p className="text-xs text-slate-400">
                      {(item?.created_at || item?.timestamp || item?.date) ? new Date(item.created_at || item.timestamp || item.date).toLocaleDateString() : ""}
                    </p>
                  </div>
                  {item?.total_amount != null && (
                    <span className="text-sm font-semibold text-slate-700">{formatOrgMoney(item.total_amount, config)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-100 text-violet-700">
              <Megaphone className="w-[18px] h-[18px]" />
            </span>
            <h2 className="text-lg font-bold text-slate-800">Announcements</h2>
          </div>
          <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-8 text-center">
            <Megaphone className="w-6 h-6 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-700">No announcements</p>
            <p className="text-[13px] text-slate-500 mt-1">Platform announcements for your organization will appear here.</p>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <div className="flex items-center gap-2.5 mb-4">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-100 text-blue-700">
              <Bell className="w-[18px] h-[18px]" />
            </span>
            <h2 className="text-lg font-bold text-slate-800">Notifications</h2>
          </div>
          <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-8 text-center">
            <Bell className="w-6 h-6 text-slate-300 mx-auto mb-2" />
            <p className="text-sm font-semibold text-slate-700">No notifications</p>
            <p className="text-[13px] text-slate-500 mt-1">Alerts about renewals, overdue invoices and billing events will appear here.</p>
          </div>
        </div>
      </div>

      <div className="flex items-baseline justify-between mb-3.5">
        <h2 className="text-base font-bold text-slate-800">Recent Invoices</h2>
        <button onClick={() => navigate("/billing/invoices")} className="text-[12.5px] font-semibold cursor-pointer flex items-center gap-1 text-brand hover:text-brand-hover">
          View all <ArrowRight className="w-3 h-3" />
        </button>
      </div>
      <div className="rounded-3xl border border-slate-200 bg-white shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr className="border-y border-slate-100 bg-slate-50/60">
                {["Invoice", "Status", "Amount"].map((h) => (
                  <th key={h} className="text-left text-xs uppercase tracking-wider text-slate-400 font-semibold px-6 py-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentInvoices.length === 0 ? (
                <tr><td colSpan={3} className="px-6 py-8 text-center text-[13px] text-slate-500">No invoices yet</td></tr>
              ) : recentInvoices.map((inv) => (
                <tr key={inv.id} onClick={() => navigate(`/billing/invoices/${inv.id}`)} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50/60 transition-colors">
                  <td className="px-6 py-3.5 text-[13px] font-semibold text-brand hover:text-brand-hover">{inv.invoice_number || `INV-${inv.id}`}</td>
                  <td className="px-6 py-3.5 text-[13px]">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-medium ${
                      inv.status === "paid" ? "bg-emerald-50 text-emerald-700" :
                      inv.status === "overdue" ? "bg-red-50 text-red-700" :
                      inv.status === "sent" ? "bg-blue-50 text-blue-700" :
                      "bg-gray-50 text-gray-700"
                    }`}>{inv.status || "draft"}</span>
                  </td>
                  <td className="px-6 py-3.5 text-[13px] font-semibold text-slate-800">{formatOrgMoney(inv.total_amount, config)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
