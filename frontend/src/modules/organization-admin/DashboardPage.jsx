import React, { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { getOrganizationDashboardStats, getOrganizationDetails } from "../../service/orgAdminService";
import { Users, Building2, FileText, AlertTriangle, Wallet, TrendingUp, Repeat } from "lucide-react";

// Palette matches the Login page: blue/navy primary, slate ink, emerald success,
// red danger. See src/pages/LoginPage.jsx.
const PRIMARY = "#2563EB";
const PRIMARY_DEEP = "#1D4ED8";
const PRIMARY_LIGHT = "#60A5FA";
const SUCCESS = "#059669";
const DANGER = "#DC2626";
const INK = "#0F172A";
const INK_SOFT = "#374151";
const INK_FAINT = "#9CA3AF";
const PRIMARY_100 = "#DBEAFE";
const SUCCESS_100 = "#D1FAE5";
const DANGER_100 = "#FEF2F2";
const LINE = "#E5E7EB";
const AVATAR_COLORS = [
  `linear-gradient(135deg,${PRIMARY},${PRIMARY_DEEP})`,
  `linear-gradient(135deg,${PRIMARY_LIGHT},${PRIMARY})`,
  `linear-gradient(135deg,#0F172A,#1E293B)`,
  `linear-gradient(135deg,#94A3B8,#64748B)`,
];

function avatarBg(index) {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

function fmtCurrency(amount) {
  if (amount == null) return "—";
  return `$${Number(amount).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

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

const statusColors = { teal: { bg: SUCCESS, shadow: SUCCESS_100 }, amber: { bg: PRIMARY, shadow: PRIMARY_100 }, off: { bg: INK_FAINT, shadow: "#F3F4F6" } };

const StatCard = React.memo(({ icon: Icon, iconBg, iconColor, label, value, sub, onClick }) => (
  <div onClick={onClick} className="rounded-[14px] border bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.10)] hover:-translate-y-0.5 hover:shadow-[0_4px_10px_rgba(15,23,42,0.06),0_20px_40px_-20px_rgba(37,99,235,0.25)] hover:border-transparent transition-all duration-[180ms] cursor-pointer" style={{ borderColor: LINE }}>
    <div className="w-[38px] h-[38px] rounded-[10px] flex items-center justify-center mb-4" style={{ background: iconBg, color: iconColor }}>
      <Icon className="w-[18px] h-[18px]" strokeWidth={2.5} />
    </div>
    <p className="text-[12.5px] font-medium" style={{ color: INK_SOFT }}>{label}</p>
    <p className="text-[29px] font-bold tracking-[-0.01em] leading-none mt-1.5" style={{ color: INK }}>{value}</p>
    {sub ? <p className="text-[11.5px] mt-1.5" style={{ color: INK_SOFT }}>{sub}</p> : null}
  </div>
));

export default function OrgAdminDashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getOrganizationDashboardStats().catch(() => null),
      getOrganizationDetails().catch(() => null),
    ])
      .then(([s, o]) => {
        if (cancelled) return;
        if (s) setStats(s);
        if (o) setOrg(o);
      })
      .catch(err => { if (!cancelled) setError(err?.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
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

  const kpis = useMemo(() => [
    { key: "total_customers", label: "Customers", icon: Users, iconBg: PRIMARY_100, iconColor: PRIMARY, path: "/billing/customers" },
    { key: "active_subscriptions", label: "Active Subscriptions", icon: Repeat, iconBg: SUCCESS_100, iconColor: SUCCESS, path: "/billing/subscriptions" },
    { key: "open_invoices", label: "Open Invoices", icon: FileText, iconBg: PRIMARY_100, iconColor: PRIMARY, path: "/billing/invoices" },
    { key: "overdue_invoices", label: "Overdue Invoices", icon: AlertTriangle, iconBg: DANGER_100, iconColor: DANGER, path: "/billing/collections" },
    { key: "outstanding_amount", label: "Outstanding Amount", icon: Wallet, iconBg: DANGER_100, iconColor: DANGER, path: "/billing/invoices", fmt: fmtCurrency },
    { key: "revenue_this_month", label: "Revenue This Month", icon: TrendingUp, iconBg: SUCCESS_100, iconColor: SUCCESS, path: "/billing/reports", fmt: fmtCurrency },
    { key: "billing_admins", label: "Billing Admins", icon: Building2, iconBg: PRIMARY_100, iconColor: PRIMARY, path: "/organization-admin/organization" },
  ], []);

  const recentCustomers = stats?.recent_customers || [];

  return (
    <div className="font-['Inter',system-ui,sans-serif] p-4 sm:p-6 lg:p-8" style={{ background: "#F8FAFC", color: INK, minHeight: "calc(100vh - 4rem)" }}>
      {error && (
        <div className="mb-4 rounded-[8px] border p-4 text-sm" style={{ background: DANGER_100, borderColor: "#FECACA", color: DANGER }}>
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 mb-4 pb-4" style={{ borderBottom: `1px solid ${LINE}` }}>
        <div className="w-10 h-10 rounded-[12px] overflow-hidden flex items-center justify-center flex-shrink-0">
          <img src="/zoiko-icon.png" alt="Zoiko Billing" className="w-full h-full object-cover" />
        </div>
        <div>
          <p className="text-lg font-extrabold" style={{ color: INK, letterSpacing: "-0.01em" }}>{orgName}</p>
          <p className="text-[12px] font-medium font-['JetBrains_Mono',monospace] uppercase tracking-[0.04em]" style={{ color: INK_FAINT }}>Organization ID · {orgCode}</p>
        </div>
      </div>

      <div
        className="relative flex justify-between items-center gap-6 mb-[22px] rounded-[20px] px-[34px] py-[30px] text-white overflow-hidden"
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
          <h1 className="text-[27px] font-extrabold tracking-[-0.01em] mt-2">{greeting()}, {displayName}</h1>
          <p className="mt-1.5 text-[14px] max-w-[520px]" style={{ color: "rgba(255,255,255,0.68)" }}>
            {totalCustomers} customers · {fmtCurrency(stats?.outstanding_amount)} outstanding across {stats?.open_invoices ?? 0} open invoices.
          </p>
          <div className="flex gap-2.5 mt-[18px]">
            <button onClick={() => navigate("/billing/customers")} className="flex items-center gap-2 px-[20px] py-2.5 rounded-[50px] text-[13.5px] font-semibold border-none cursor-pointer whitespace-nowrap" style={{ background: `linear-gradient(135deg, ${PRIMARY}, ${PRIMARY_DEEP})`, color: "#fff", boxShadow: "0 4px 16px rgba(37,99,235,0.35)" }}>
              ＋ Add Customer
            </button>
            <button onClick={() => navigate("/billing/invoices")} className="flex items-center gap-2 px-[20px] py-2.5 rounded-[50px] text-[13.5px] font-semibold cursor-pointer whitespace-nowrap" style={{ background: "rgba(255,255,255,0.1)", color: "#fff", border: "1px solid rgba(255,255,255,0.22)" }}>
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
            <p className="text-[14.5px] font-bold">Active Customer Rate</p>
            <p className="text-[11px] font-semibold tracking-[0.04em]" style={{ color: "rgba(255,255,255,0.6)" }}>Active vs. total customers</p>
          </div>
        </div>
      </div>

      <div className="flex items-baseline justify-between mb-[14px]">
        <h2 className="text-[15.5px] font-bold tracking-[-0.01em]" style={{ color: INK }}>Key Metrics</h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((kpi) => (
          <StatCard
            key={kpi.key}
            icon={kpi.icon}
            iconBg={kpi.iconBg}
            iconColor={kpi.iconColor}
            label={kpi.label}
            value={loading ? "—" : stats ? (kpi.fmt ? kpi.fmt(stats[kpi.key]) : (stats[kpi.key] ?? 0)) : "—"}
            onClick={() => navigate(kpi.path)}
          />
        ))}
      </div>

      <div className="flex items-baseline justify-between mb-[14px] mt-[30px]">
        <h2 className="text-[15.5px] font-bold tracking-[-0.01em]" style={{ color: INK }}>Recent Customers</h2>
        <button onClick={() => navigate("/billing/customers")} className="text-[12.5px] font-semibold cursor-pointer" style={{ color: PRIMARY }}>View all {totalCustomers} →</button>
      </div>
      <div className="rounded-[14px] border overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.10)]" style={{ background: "#fff", borderColor: LINE }}>
        <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {["Customer", "Status"].map((h) => (
                  <th key={h} className="text-left text-[11px] font-bold uppercase tracking-[0.05em] px-[14px] py-[13px]" style={{ color: INK_SOFT, borderBottom: `2px solid ${LINE}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentCustomers.length === 0 ? (
                <tr><td colSpan={2} className="px-[14px] py-8 text-center text-[13px]" style={{ color: INK_SOFT }}>No customers yet</td></tr>
              ) : recentCustomers.map((c, idx) => {
                const dot = statusColors[c.statusColor] || statusColors.off;
                return (
                  <tr key={c.name || idx}>
                    <td className="px-[14px] py-[13px] text-[13px]" style={{ borderBottom: `1px solid ${LINE}` }}>
                      <div className="flex items-center gap-2.5">
                        <div className="w-[30px] h-[30px] rounded-[8px] flex items-center justify-center font-bold text-[11.5px] text-white flex-shrink-0" style={{ background: avatarBg(idx) }}>
                          {c.initials}
                        </div>
                        <span>{c.name}</span>
                      </div>
                    </td>
                    <td className="px-[14px] py-[13px] text-[13px]" style={{ borderBottom: `1px solid ${LINE}` }}>
                      <div className="flex items-center gap-1.5">
                        <span className="w-[7px] h-[7px] rounded-full flex-shrink-0" style={{ background: dot.bg, boxShadow: `0 0 0 3px ${dot.shadow}` }} />
                        <span className="capitalize">{c.status}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
