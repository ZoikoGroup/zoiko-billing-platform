import { useMemo } from "react";
import { useAuth } from "../../context/AuthContext";
import { resolveOrgCurrency, formatCurrencyChip, formatFiscalYearLabel, formatOrgMoney, normalizeOrgName } from "./workspace-format";

const TONE_TEXT = {
  good: "text-emerald-700",
  attention: "text-amber-700",
  risk: "text-red-700",
  default: "text-slate-800",
  violet: "text-purple-700",
};

const TONE_DOT = {
  good: "bg-emerald-500",
  attention: "bg-amber-500",
  risk: "bg-red-500",
  default: "bg-slate-400",
  violet: "bg-purple-500",
};

function HeaderChip({ label, value, tone = "default", dot = false }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-600">{label}</span>
      <span className={`flex items-center gap-1.5 text-sm font-bold ${TONE_TEXT[tone] || TONE_TEXT.default}`}>
        {dot && <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[tone] || TONE_DOT.default}`} />}
        {value}
      </span>
    </div>
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
    if (health) list.push({ label: "Health", value: health.label, tone: health.tone || "default", dot: true });
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
  const hasOrgName = orgName && orgName !== "—";

  return (
    <div className="mb-6 rounded-3xl border border-slate-200 bg-white shadow-[0_4px_20px_rgba(0,0,0,0.03)] overflow-hidden">
      <div className="bg-linear-to-r from-brand/6 via-transparent to-transparent p-6 md:p-8">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-linear-to-br from-brand to-brand-hover flex items-center justify-center text-white font-bold text-lg shrink-0">
              {initialsOf(user)}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-brand">Billing Administrator</p>
              <h1 className="text-xl md:text-2xl font-extrabold tracking-tight text-slate-900">Welcome back, {displayName}</h1>
              {hasOrgName && (
                <p className="mt-0.5 truncate text-sm text-slate-500">
                  Managing <span className="font-semibold text-slate-700">{orgName}</span>
                </p>
              )}
              {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
        {chips.length > 0 && (
          <div className="mt-6 grid grid-cols-2 divide-x divide-y divide-slate-100 rounded-2xl border border-slate-100 bg-slate-50/50 sm:grid-cols-3 xl:grid-cols-5">
            {chips.map((c, i) => (
              <HeaderChip key={i} label={c.label} value={c.value} tone={c.tone} dot={c.dot} />
            ))}
          </div>
        )}
        {Icon && title && (
          <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
            <Icon size={14} />
            <span>{title}</span>
          </div>
        )}
      </div>
    </div>
  );
}
