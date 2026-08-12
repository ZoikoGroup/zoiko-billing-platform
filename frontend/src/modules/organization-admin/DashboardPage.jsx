import React, { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { getOrganizationDashboardStats, getOrganizationDetails } from "../../service/orgAdminService";
import { Users, Building2, FileText, AlertTriangle, Wallet, TrendingUp, Repeat } from "lucide-react";

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

const statusColors = { teal: { bg: TEAL, shadow: TEAL_100 }, amber: { bg: AMBER, shadow: AMBER_100 }, off: { bg: "#B9B4CC", shadow: "#EFEDF6" } };

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
    { key: "total_customers", label: "Customers", icon: Users, iconBg: VIOLET_100, iconColor: VIOLET, path: "/billing/customers" },
    { key: "active_subscriptions", label: "Active Subscriptions", icon: Repeat, iconBg: TEAL_100, iconColor: TEAL, path: "/billing/subscriptions" },
    { key: "open_invoices", label: "Open Invoices", icon: FileText, iconBg: AMBER_100, iconColor: AMBER, path: "/billing/invoices" },
    { key: "overdue_invoices", label: "Overdue Invoices", icon: AlertTriangle, iconBg: RED_100, iconColor: RED, path: "/billing/collections" },
    { key: "outstanding_amount", label: "Outstanding Amount", icon: Wallet, iconBg: RED_100, iconColor: RED, path: "/billing/invoices", fmt: fmtCurrency },
    { key: "revenue_this_month", label: "Revenue This Month", icon: TrendingUp, iconBg: TEAL_100, iconColor: TEAL, path: "/billing/reports", fmt: fmtCurrency },
    { key: "billing_admins", label: "Billing Admins", icon: Building2, iconBg: VIOLET_100, iconColor: VIOLET, path: "/organization-admin/organization" },
  ], []);

  const recentCustomers = stats?.recent_customers || [];

  return (
    <div className="font-['Inter',system-ui,sans-serif] -m-4 sm:-m-6 lg:-m-8 p-4 sm:p-6 lg:p-8" style={{ background: "#F6F5FA", color: INK, minHeight: "calc(100vh - 4rem)" }}>
      {error && (
        <div className="mb-4 rounded-[14px] border p-4 text-sm" style={{ background: RED_100, borderColor: RED, color: RED }}>
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 mb-4 pb-4" style={{ borderBottom: `1px solid ${LINE}` }}>
        <div className="w-10 h-10 rounded-[12px] flex items-center justify-center flex-shrink-0" style={{ background: "#270b87", color: "#fff", fontWeight: 800 }}>
          1
        </div>
        <div>
          <p className="font-['Sora',system-ui,sans-serif] text-lg font-bold" style={{ color: INK }}>{orgName}</p>
          <p className="text-[12px] font-medium" style={{ color: INK_SOFT }}>Organization ID · {orgCode}</p>
        </div>
      </div>

      <div
        className="relative flex justify-between items-center gap-6 mb-[22px] rounded-[20px] px-[34px] py-[30px] text-white overflow-hidden"
        style={{ background: `linear-gradient(120deg, #1E1447 0%, #3B2E8A 62%, #4C3AAE 100%)`, boxShadow: "0 4px 10px rgba(24,20,51,0.06), 0 20px 40px -20px rgba(59,46,138,0.25)" }}
      >
        <div
          className="absolute rounded-full pointer-events-none"
          style={{ right: -60, top: -90, width: 280, height: 280, background: "radial-gradient(circle, rgba(245,163,64,0.35), transparent 70%)" }}
        />
        <div className="z-[1]">
          <p className="text-[11.5px] font-bold uppercase tracking-[0.12em]" style={{ color: "rgba(255,255,255,0.55)" }}>
            {todayLabel()}
          </p>
          <h1 className="font-['Sora',system-ui,sans-serif] text-[27px] font-bold tracking-[-0.01em] mt-2">{greeting()}, {displayName}</h1>
          <p className="mt-1.5 text-[14px] max-w-[520px]" style={{ color: "rgba(255,255,255,0.68)" }}>
            {totalCustomers} customers · {fmtCurrency(stats?.outstanding_amount)} outstanding across {stats?.open_invoices ?? 0} open invoices.
          </p>
          <div className="flex gap-2.5 mt-[18px]">
            <button onClick={() => navigate("/billing/customers")} className="btn flex items-center gap-2 px-[18px] py-2.5 rounded-[11px] text-[13.5px] font-semibold border-none cursor-pointer whitespace-nowrap" style={{ background: `linear-gradient(135deg,${AMBER},#E8862C)`, color: "#241000", boxShadow: `0 8px 20px -8px rgba(232,134,44,0.7)` }}>
              ＋ Add Customer
            </button>
            <button onClick={() => navigate("/billing/invoices")} className="btn flex items-center gap-2 px-[18px] py-2.5 rounded-[11px] text-[13.5px] font-semibold cursor-pointer whitespace-nowrap" style={{ background: "rgba(255,255,255,0.1)", color: "#fff", border: "1px solid rgba(255,255,255,0.22)" }}>
              View Invoices
            </button>
          </div>
        </div>
        <div className="z-[1] hidden md:flex items-center gap-4">
          <div className="relative" style={{ width: 88, height: 88 }}>
            <svg width="88" height="88" viewBox="0 0 88 88">
              <circle cx="44" cy="44" r="37" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="10" />
              <circle cx="44" cy="44" r="37" fill="none" stroke={AMBER} strokeWidth="10"
                strokeDasharray={`${2 * Math.PI * 37 * collectionRate / 100} ${2 * Math.PI * 37 * (100 - collectionRate) / 100}`}
                strokeLinecap="round" transform="rotate(-90 44 44)" />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center font-['Sora',system-ui,sans-serif] font-extrabold text-[19px] pointer-events-none">{collectionRate}%</div>
          </div>
          <div>
            <p className="font-['Sora',system-ui,sans-serif] text-[14.5px] font-bold">Active Customer Rate</p>
            <p className="text-[11px] font-semibold tracking-[0.04em]" style={{ color: "rgba(255,255,255,0.6)" }}>Active vs. total customers</p>
          </div>
        </div>
      </div>

      <div className="flex items-baseline justify-between mb-[14px]">
        <h2 className="font-['Sora',system-ui,sans-serif] text-[15.5px] font-bold tracking-[-0.01em]" style={{ color: INK }}>Key Metrics</h2>
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
        <h2 className="font-['Sora',system-ui,sans-serif] text-[15.5px] font-bold tracking-[-0.01em]" style={{ color: INK }}>Recent Customers</h2>
        <button onClick={() => navigate("/billing/customers")} className="text-[12.5px] font-semibold cursor-pointer" style={{ color: VIOLET }}>View all {totalCustomers} →</button>
      </div>
      <div className="rounded-[20px] border overflow-hidden shadow-[0_1px_2px_rgba(24,20,51,0.04),0_8px_24px_-12px_rgba(24,20,51,0.10)]" style={{ background: "#fff", borderColor: LINE }}>
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
                        <div className="w-[30px] h-[30px] rounded-[8px] flex items-center justify-center font-['Sora',system-ui,sans-serif] font-bold text-[11.5px] text-white flex-shrink-0" style={{ background: avatarBg(idx) }}>
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
