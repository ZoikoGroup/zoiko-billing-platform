import React, { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { getOrganizationDashboardStats, getOrganizationDetails } from "../../service/orgAdminService";
import { getCurrencySymbol, getCurrencyInfo } from "../../utils/currency";
import { loadGlobalCurrency, getOrgBaseCurrency, isOrgCurrencyUnavailable } from "../billing/utils/CurrencyContext";
import {
  Users,
  FileText,
  AlertTriangle,
  Wallet,
  TrendingUp,
  Repeat,
  ArrowRight,
  UserPlus,
  Plus,
  RefreshCw,
  Shield,
} from "lucide-react";

const INK = "#0F172A";
const INK_SOFT = "#374151";
const INK_FAINT = "#9CA3AF";
const PRIMARY = "#2563EB";
const PRIMARY_DEEP = "#1D4ED8";
const PRIMARY_LIGHT = "#60A5FA";
const SUCCESS = "#059669";
const DANGER = "#DC2626";
const WARNING = "#D97706";
const LINE = "#E5E7EB";

const AVATAR_GRADIENTS = [
  `linear-gradient(135deg,${PRIMARY},${PRIMARY_DEEP})`,
  `linear-gradient(135deg,${PRIMARY_LIGHT},${PRIMARY})`,
  `linear-gradient(135deg,#0F172A,#1E293B)`,
  `linear-gradient(135deg,#6366F1,#4F46E5)`,
];

function todayLabel() {
  const d = new Date();
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `${dayNames[d.getDay()]}, ${d.getDate()} ${monthNames[d.getMonth()]} ${d.getFullYear()}`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function SkeletonCard({ className = "" }) {
  return (
    <div className={`rounded-xl border p-5 animate-pulse ${className}`} style={{ background: "#fff", borderColor: LINE }}>
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-slate-100" />
      </div>
      <div className="h-3 w-24 bg-slate-100 rounded mb-2" />
      <div className="h-7 w-16 bg-slate-100 rounded" />
    </div>
  );
}

function SkeletonTable() {
  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: "#fff", borderColor: LINE }}>
      <div className="px-5 py-4 border-b" style={{ borderColor: LINE }}>
        <div className="h-4 w-32 bg-slate-100 rounded" />
      </div>
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-3.5 border-b last:border-b-0 animate-pulse" style={{ borderColor: LINE }}>
          <div className="w-9 h-9 rounded-lg bg-slate-100" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 w-28 bg-slate-100 rounded" />
            <div className="h-3 w-20 bg-slate-50 rounded" />
          </div>
          <div className="h-5 w-16 bg-slate-100 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="rounded-xl border p-8 text-center" style={{ background: "#FEF2F2", borderColor: "#FECACA" }}>
      <AlertTriangle className="w-8 h-8 mx-auto mb-3" style={{ color: DANGER }} />
      <p className="text-sm font-semibold" style={{ color: DANGER }}>{message || "Something went wrong"}</p>
      <p className="text-xs mt-1" style={{ color: INK_FAINT }}>Please try again or contact support if the issue persists.</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:-translate-y-0.5"
          style={{ background: DANGER }}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Retry
        </button>
      )}
    </div>
  );
}

const statusColors = {
  teal: { bg: SUCCESS, shadow: "#D1FAE5" },
  amber: { bg: WARNING, shadow: "#FEF3C7" },
  off: { bg: INK_FAINT, shadow: "#F1F5F9" },
};

export default function OrgAdminDashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [stats, setStats] = useState(null);
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [orgCurrency, setOrgCurrency] = useState("");

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      getOrganizationDashboardStats().catch(() => null),
      getOrganizationDetails().catch(() => null),
      loadGlobalCurrency().catch(() => null),
    ])
      .then(([s, o]) => {
        if (s) setStats(s);
        if (o) setOrg(o);
        setOrgCurrency(s?.currency || getOrgBaseCurrency() || "");
      })
      .catch((err) => setError(err?.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchData();
    return () => { cancelled = true; };
  }, []);

  const displayName = user?.first_name || user?.name || "there";
  const orgName = org?.name || user?.organization_name || "Your Organization";
  const orgCode = org?.code || user?.organization_code || "—";

  const totalCustomers = stats?.total_customers ?? 0;
  const activeCustomers = stats?.active_customers ?? 0;
  const collectionRate = totalCustomers > 0
    ? Math.round((activeCustomers / totalCustomers) * 100)
    : 100;

  const effectiveCurrency = stats?.currency || orgCurrency;

  const formatMoney = useCallback((amount) => {
    if (amount == null) return "\u2014";
    if (!effectiveCurrency && isOrgCurrencyUnavailable()) return "Currency not configured";
    if (!effectiveCurrency) return "\u2014";
    const num = Number(amount);
    if (Number.isNaN(num)) return "\u2014";
    const info = getCurrencyInfo(effectiveCurrency);
    const symbol = getCurrencySymbol(effectiveCurrency);
    const precision = typeof info?.decimalDigits === "number" ? info.decimalDigits : 2;
    return `${symbol}${num.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision })}`;
  }, [effectiveCurrency]);

  const primaryKpis = useMemo(() => [
    {
      key: "outstanding_amount",
      label: "Outstanding Amount",
      icon: Wallet,
      iconBg: "#FEF2F2",
      iconColor: DANGER,
      path: "/billing/invoices",
      isCurrency: true,
      supporting: () => {
        const n = stats?.open_invoices ?? 0;
        return `Across ${n} open invoice${n !== 1 ? "s" : ""}`;
      },
    },
    {
      key: "revenue_this_month",
      label: "Revenue This Month",
      icon: TrendingUp,
      iconBg: "#D1FAE5",
      iconColor: SUCCESS,
      path: "/billing/reports",
      isCurrency: true,
      supporting: () => {
        const n = stats?.active_subscriptions ?? 0;
        return `${n} active subscription${n !== 1 ? "s" : ""}`;
      },
    },
  ], [stats]);

  const secondaryKpis = useMemo(() => [
    { key: "total_customers", label: "Customers", icon: Users, iconBg: "#EFF6FF", iconColor: PRIMARY, path: "/billing/customers", supporting: () => `${stats?.active_customers ?? 0} active` },
    { key: "active_subscriptions", label: "Active Subscriptions", icon: Repeat, iconBg: "#D1FAE5", iconColor: SUCCESS, path: "/billing/subscriptions", supporting: () => null },
    { key: "open_invoices", label: "Open Invoices", icon: FileText, iconBg: "#EFF6FF", iconColor: PRIMARY, path: "/billing/invoices", supporting: () => {
      const od = stats?.overdue_invoices ?? 0;
      return od > 0 ? `${od} overdue` : null;
    }},
    { key: "billing_admins", label: "Billing Admins", icon: Shield, iconBg: "#FEF3C7", iconColor: WARNING, path: "/organization-admin/users", supporting: () => null },
  ], [stats]);

  const recentCustomers = stats?.recent_customers || [];

  return (
    <div className="font-['Inter',system-ui,sans-serif]" style={{ color: INK }}>
      {error && (
        <ErrorState message={error} onRetry={fetchData} />
      )}

      <div className="flex items-center gap-3 mb-5 pb-4" style={{ borderBottom: `1px solid ${LINE}` }}>
        <div className="w-10 h-10 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0 bg-white shadow-sm border" style={{ borderColor: LINE }}>
          <img src="/zoiko-icon.png" alt="Zoiko Billing" className="w-full h-full object-cover" />
        </div>
        <div>
          <p className="text-lg font-extrabold" style={{ color: INK, letterSpacing: "-0.01em" }}>{orgName}</p>
          <p className="text-[11px] font-medium font-['JetBrains_Mono',monospace] uppercase tracking-wider" style={{ color: INK_FAINT }}>Organization ID &middot; {orgCode}</p>
        </div>
      </div>

      <div
        className="relative flex justify-between items-center gap-6 mb-6 rounded-2xl px-8 py-7 text-white overflow-hidden"
        style={{ background: "linear-gradient(164.56deg, #0B1220 0%, #101B33 60%, #0A0F1F 100%)", boxShadow: "0 4px 10px rgba(15,23,42,0.06), 0 20px 40px -20px rgba(37,99,235,0.25)" }}
      >
        <div
          className="absolute rounded-full pointer-events-none"
          style={{ right: -60, top: -90, width: 280, height: 280, background: "radial-gradient(circle, rgba(37,99,235,0.35), transparent 70%)" }}
        />
        <div className="z-[1]">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] font-['JetBrains_Mono',monospace]" style={{ color: PRIMARY_LIGHT }}>
            {todayLabel()}
          </p>
          <h1 className="text-[26px] font-extrabold tracking-tight mt-2">{greeting()}, {displayName}</h1>
          <p className="mt-1.5 text-[13.5px] max-w-[520px]" style={{ color: "rgba(255,255,255,0.65)" }}>
            {totalCustomers} customer{totalCustomers !== 1 ? "s" : ""} &middot; {formatMoney(stats?.outstanding_amount)} outstanding across {stats?.open_invoices ?? 0} open invoice{stats?.open_invoices !== 1 ? "s" : ""}.
          </p>
          <div className="flex gap-2.5 mt-5">
            <button onClick={() => navigate("/billing/customers")} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-semibold border-none cursor-pointer whitespace-nowrap transition-all hover:-translate-y-0.5" style={{ background: `linear-gradient(135deg, ${PRIMARY}, ${PRIMARY_DEEP})`, color: "#fff", boxShadow: "0 4px 16px rgba(37,99,235,0.35)" }}>
              <Plus className="w-4 h-4" strokeWidth={2.5} />
              Add Customer
            </button>
            <button onClick={() => navigate("/billing/invoices")} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-semibold cursor-pointer whitespace-nowrap transition-all hover:-translate-y-0.5" style={{ background: "rgba(255,255,255,0.1)", color: "#fff", border: "1px solid rgba(255,255,255,0.22)" }}>
              View Invoices
            </button>
          </div>
        </div>
        <div className="z-[1] hidden md:flex items-center gap-4">
          <div className="relative" style={{ width: 88, height: 88 }}>
            <svg width="88" height="88" viewBox="0 0 88 88">
              <circle cx="44" cy="44" r="37" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="10" />
              <circle cx="44" cy="44" r="37" fill="none" stroke={PRIMARY_LIGHT} strokeWidth="10"
                strokeDasharray={`${2 * Math.PI * 37 * collectionRate / 100} ${2 * Math.PI * 37 * (100 - collectionRate) / 100}`}
                strokeLinecap="round" transform="rotate(-90 44 44)" />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center font-extrabold text-[19px] pointer-events-none">{collectionRate}%</div>
          </div>
          <div>
            <p className="text-[14px] font-bold">Active Customer Rate</p>
            <p className="text-[11px] font-semibold tracking-wide" style={{ color: "rgba(255,255,255,0.55)" }}>Active vs. total customers</p>
          </div>
        </div>
      </div>

      <h2 className="text-[14px] font-bold tracking-tight mb-3" style={{ color: INK }}>Financial Overview</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        {loading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          primaryKpis.map((kpi) => (
            <button
              key={kpi.key}
              onClick={() => navigate(kpi.path)}
              className="rounded-xl border bg-white p-5 text-left shadow-sm hover:-translate-y-0.5 hover:shadow-md hover:border-transparent transition-all duration-200 cursor-pointer group"
              style={{ borderColor: LINE }}
            >
              <div className="flex items-center justify-between mb-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: kpi.iconBg, color: kpi.iconColor }}>
                  <kpi.icon className="w-5 h-5" strokeWidth={2.5} />
                </div>
                <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: INK_FAINT }} />
              </div>
              <p className="text-[12px] font-medium" style={{ color: INK_SOFT }}>{kpi.label}</p>
              <p className="text-[26px] font-bold tracking-tight leading-none mt-1.5" style={{ color: INK }}>
                {formatMoney(stats?.[kpi.key])}
              </p>
              {kpi.supporting && (() => {
                const txt = kpi.supporting();
                return txt ? <p className="text-[11px] mt-1.5 font-medium" style={{ color: INK_FAINT }}>{txt}</p> : null;
              })()}
            </button>
          ))
        )}
      </div>

      <h2 className="text-[14px] font-bold tracking-tight mb-3" style={{ color: INK }}>Key Metrics</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {loading ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          secondaryKpis.map((kpi) => (
            <button
              key={kpi.key}
              onClick={() => navigate(kpi.path)}
              className="rounded-xl border bg-white p-4 text-left shadow-sm hover:-translate-y-0.5 hover:shadow-md hover:border-transparent transition-all duration-200 cursor-pointer group"
              style={{ borderColor: LINE }}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: kpi.iconBg, color: kpi.iconColor }}>
                  <kpi.icon className="w-4 h-4" strokeWidth={2.5} />
                </div>
                <ArrowRight className="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: INK_FAINT }} />
              </div>
              <p className="text-[11.5px] font-medium" style={{ color: INK_SOFT }}>{kpi.label}</p>
              <p className="text-[22px] font-bold tracking-tight leading-none mt-1" style={{ color: INK }}>
                {stats?.[kpi.key] ?? 0}
              </p>
              {kpi.supporting && (() => {
                const txt = kpi.supporting();
                return txt ? <p className="text-[10.5px] mt-1 font-medium" style={{ color: INK_FAINT }}>{txt}</p> : null;
              })()}
            </button>
          ))
        )}
      </div>

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[14px] font-bold tracking-tight" style={{ color: INK }}>Recent Customers</h2>
        {totalCustomers > 0 && (
          <button
            onClick={() => navigate("/billing/customers")}
            className="inline-flex items-center gap-1 text-[12px] font-semibold transition-colors hover:underline"
            style={{ color: PRIMARY }}
          >
            View all {totalCustomers}
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {loading ? (
        <SkeletonTable />
      ) : recentCustomers.length === 0 ? (
        <div className="rounded-xl border overflow-hidden" style={{ background: "#fff", borderColor: LINE }}>
          <div className="px-5 py-16 text-center">
            <div className="w-12 h-12 rounded-xl mx-auto mb-3 flex items-center justify-center" style={{ background: "#EFF6FF" }}>
              <Users className="w-6 h-6" style={{ color: PRIMARY }} />
            </div>
            <p className="text-sm font-semibold" style={{ color: INK }}>No customers yet</p>
            <p className="text-xs mt-1 mb-4" style={{ color: INK_FAINT }}>Add your first customer to start billing.</p>
            <button
              onClick={() => navigate("/billing/customers")}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:-translate-y-0.5"
              style={{ background: PRIMARY }}
            >
              <UserPlus className="w-3.5 h-3.5" />
              Add Customer
            </button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden shadow-sm" style={{ background: "#fff", borderColor: LINE }}>
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Customer", "Company", "Status"].map((h) => (
                    <th key={h} className="text-left text-[11px] font-bold uppercase tracking-wider px-5 py-3" style={{ color: INK_SOFT, borderBottom: `2px solid ${LINE}` }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentCustomers.map((c, idx) => {
                  const dot = statusColors[c.statusColor] || statusColors.off;
                  return (
                    <tr
                      key={c.id || c.name || idx}
                      className="cursor-pointer transition-colors hover:bg-slate-50/60"
                      onClick={() => navigate(`/billing/customers/${c.id}`)}
                    >
                      <td className="px-5 py-3.5" style={{ borderBottom: `1px solid ${LINE}` }}>
                        <div className="flex items-center gap-3">
                          <div
                            className="w-9 h-9 rounded-lg flex items-center justify-center font-bold text-[11px] text-white flex-shrink-0"
                            style={{ background: AVATAR_GRADIENTS[idx % AVATAR_GRADIENTS.length] }}
                          >
                            {c.initials}
                          </div>
                          <span className="text-sm font-semibold" style={{ color: INK }}>{c.name}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-sm" style={{ borderBottom: `1px solid ${LINE}`, color: INK_SOFT }}>
                        {c.company_name || "\u2014"}
                      </td>
                      <td className="px-5 py-3.5" style={{ borderBottom: `1px solid ${LINE}` }}>
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dot.bg, boxShadow: `0 0 0 3px ${dot.shadow}` }} />
                          <span className="text-xs font-semibold capitalize" style={{ color: dot.bg === SUCCESS ? SUCCESS : dot.bg === WARNING ? WARNING : INK_SOFT }}>
                            {c.status}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
