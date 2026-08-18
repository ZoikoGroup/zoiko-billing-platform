import { useMemo } from "react";
import { useAuth } from "../../context/AuthContext";
import { resolveOrgCurrency, formatCurrencyChip, formatFiscalYearLabel, formatOrgMoney, normalizeOrgName } from "./workspace-format";

function Chip({ label, value, tone = "default" }) {
  const tones = {
    good: "bg-emerald-50 text-emerald-700 border-emerald-200",
    attention: "bg-amber-50 text-amber-700 border-amber-200",
    risk: "bg-red-50 text-red-700 border-red-200",
    default: "bg-gray-50 text-gray-700 border-gray-200",
    violet: "bg-purple-50 text-purple-700 border-purple-200",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border ${tones[tone] || tones.default}`}>
      <span className="text-[10px] uppercase tracking-wider opacity-70">{label}</span>
      <span className="font-semibold">{value}</span>
    </span>
  );
}

function initialsOf(user) {
  if (!user) return "?";
  const parts = [user.first_name, user.last_name, user.display_name, user.full_name, user.username, user.email].filter(Boolean);
  if (parts.length === 0) return "?";
  const name = parts[0];
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

export default function WorkspaceHeader({ title, subtitle, icon: Icon, actions, organization, health, plan, outstanding, fiscalYear, currency }) {
  const { user } = useAuth();

  const chips = useMemo(() => {
    const list = [];
    if (health) list.push({ label: "Health", value: health.label, tone: health.tone || "default" });
    if (plan) list.push({ label: "Plan", value: plan, tone: "violet" });
    if (outstanding != null && outstanding > 0) {
      list.push({ label: "Outstanding", value: formatOrgMoney(outstanding, { default_currency: currency }), tone: "attention" });
    }
    if (fiscalYear) list.push({ label: "FY", value: fiscalYear, tone: "default" });
    if (currency) list.push({ label: "Currency", value: formatCurrencyChip({ default_currency: currency }), tone: "default" });
    return list;
  }, [health, plan, outstanding, fiscalYear, currency]);

  const displayName = user?.first_name || user?.display_name || user?.full_name || user?.email || "User";
  const orgName = normalizeOrgName(organization?.company_name || organization?.name);

  return (
    <div className="mb-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#1a0933] to-purple-800 flex items-center justify-center text-white font-bold text-lg shrink-0">
            {Icon ? <Icon className="w-6 h-6" /> : initialsOf(user)}
          </div>
          <div>
            <p className="text-sm text-gray-500">Welcome back, {displayName}</p>
            <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
              {title || "My Organization"}
              {orgName && orgName !== "\u2014" && (
                <span className="text-sm font-normal text-gray-400">/ {orgName}</span>
              )}
            </h1>
            {subtitle && <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {chips.length > 0 && (
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          {chips.map((c, i) => (
            <Chip key={i} label={c.label} value={c.value} tone={c.tone} />
          ))}
        </div>
      )}
    </div>
  );
}
