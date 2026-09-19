import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Gauge,
  Info,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { platformSelfServiceApi } from "../../service/platformSelfServiceApi";

const STATUS_BADGE = {
  active: "bg-emerald-50 text-emerald-700 border-emerald-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  past_due: "bg-red-50 text-red-700 border-red-200",
  restricted: "bg-red-50 text-red-700 border-red-200",
  suspended: "bg-red-50 text-red-700 border-red-200",
  cancelled: "bg-slate-100 text-slate-600 border-slate-200",
  expired: "bg-slate-100 text-slate-600 border-slate-200",
  trialing: "bg-blue-50 text-[#1A56DB] border-blue-100",
  trial_recovery: "bg-amber-50 text-amber-700 border-amber-200",
  converted: "bg-emerald-50 text-emerald-700 border-emerald-200",
};

function StatusBadge({ status }) {
  const s = (status || "").toLowerCase();
  return (
    <span className={`px-2.5 py-0.5 text-xs font-semibold rounded-full border ${STATUS_BADGE[s] || "bg-slate-100 text-slate-600 border-slate-200"}`}>
      {(s || "unknown").replace(/_/g, " ")}
    </span>
  );
}

function FlagPill({ tone, children }) {
  const cls = {
    red: "bg-red-50 text-red-700 border-red-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    ok: "bg-emerald-50 text-emerald-700 border-emerald-200",
    neutral: "bg-slate-100 text-slate-600 border-slate-200",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 text-xs font-semibold rounded-full border ${cls}`}>
      {children}
    </span>
  );
}

function rowFlag(row) {
  const { count, limit } = row;
  if (limit == null) {
    return { tone: "neutral", label: "Limit not resolved" };
  }
  if (count > limit) return { tone: "red", label: "Over limit" };
  if (count >= limit * 0.75) return { tone: "amber", label: "Approaching limit" };
  return { tone: "ok", label: "Within limit" };
}

function formatNumber(value) {
  if (value == null) return "—";
  return Number(value).toLocaleString();
}

// Plane 1 org-facing usage diagnostics (GET /billing/workspace/usage): real
// UsageCounter rows for this organization, joined with the resolved
// entitlement limit. Honest by construction — a budget key with no row has
// simply not been exercised, and an unresolved limit is shown as unknown,
// never invented.
export default function WorkspaceUsagePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = () => {
    setLoading(true);
    setError(null);
    platformSelfServiceApi
      .getWorkspaceUsage()
      .then((res) => setData(res))
      .catch((err) => setError(err?.message || "Unable to load usage."))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  if (loading) {
    return (
      <div className="min-h-[calc(100vh-4rem)] bg-[#F8FAFC] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-slate-200 border-t-[#1A56DB] rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-[calc(100vh-4rem)] bg-[#F8FAFC]">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
        </div>
      </div>
    );
  }

  const { subscription, plan_code, plan_name, counters = [] } = data || {};

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#F8FAFC] text-[#1E293B]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <div className="bg-[#1A56DB]/10 rounded-2xl p-6 border border-[#1A56DB]/20 shadow-xs">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="w-14 h-14 rounded-2xl bg-[#1A56DB]/15 text-[#1A56DB] flex items-center justify-center shrink-0">
              <Gauge className="w-7 h-7" />
            </div>
            <div className="min-w-0">
              <span className="text-xs font-bold tracking-wider text-[#1A56DB] uppercase">
                Your organization's usage
              </span>
              <h1 className="text-2xl font-bold text-[#0B192C] mt-0.5 truncate">
                {plan_name || "Plan"} {plan_code ? <span className="font-mono text-sm text-slate-400">({plan_code})</span> : null}
              </h1>
              <p className="text-sm text-slate-500 mt-1 flex items-center gap-1.5">
                <TrendingUp className="w-4 h-4 text-slate-400" />
                How much of your plan's budgeted capacity has been exercised
                {subscription ? <StatusBadge status={subscription.status} /> : null}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-800 flex items-start gap-2">
          <Info className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Only entitlement keys that route through the platform's usage metering ever produce a row here — a key with
            no row simply hasn't been exercised, not necessarily unused. Limits are resolved live against your plan;
            an unresolved limit is shown as unknown rather than guessed.
          </span>
        </div>

        {subscription == null ? (
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-10 text-center">
            <h3 className="text-lg font-bold text-[#0B192C] mb-2">No Active Zoiko Subscription</h3>
            <p className="text-sm text-slate-500">Usage appears here once your organization has a Zoiko subscription.</p>
          </div>
        ) : counters.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-10 text-center">
            <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-400 mb-3 mx-auto">
              <Gauge className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-semibold text-slate-700">No tracked usage yet</h3>
            <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
              No budgeted entitlement key with a numeric limit has been exercised so far. As your team uses Billing,
              exercised capacity appears here with its resolved limit.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50/70 border-b border-slate-100 text-[11px] uppercase tracking-wider font-bold text-slate-500">
                    <th className="py-3 px-5">Entitlement</th>
                    <th className="py-3 px-5">Window</th>
                    <th className="py-3 px-5 text-right">Count</th>
                    <th className="py-3 px-5 text-right">Limit</th>
                    <th className="py-3 px-5 text-right">Used</th>
                    <th className="py-3 px-5">Flag</th>
                    <th className="py-3 px-5">Enforcement</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {counters.map((row) => {
                    const flag = rowFlag(row);
                    const pct = row.limit != null ? Math.round((row.count / row.limit) * 100) : null;
                    return (
                      <tr key={row.id} className="hover:bg-slate-50/50 transition">
                        <td className="py-3.5 px-5">
                          <span className="font-mono text-xs font-semibold text-[#1A56DB]">{row.entitlement_key}</span>
                        </td>
                        <td className="py-3.5 px-5 text-xs text-slate-500">{row.window_key}</td>
                        <td className="py-3.5 px-5 text-right font-bold text-slate-900">{formatNumber(row.count)}</td>
                        <td className="py-3.5 px-5 text-right">
                          <span className={row.limit == null ? "text-slate-400" : "font-semibold text-slate-800"}>
                            {row.limit == null ? "Unknown" : formatNumber(row.limit)}
                          </span>
                        </td>
                        <td className="py-3.5 px-5 text-right text-xs font-semibold text-slate-600">{pct == null ? "—" : `${pct}%`}</td>
                        <td className="py-3.5 px-5">
                          <FlagPill tone={flag.tone}>
                            {flag.tone === "red" ? <AlertTriangle className="w-3 h-3" /> : flag.tone === "ok" ? <ShieldCheck className="w-3 h-3" /> : null}
                            {flag.label}
                          </FlagPill>
                        </td>
                        <td className="py-3.5 px-5 text-xs text-slate-500 capitalize">{(row.enforcement_type || "—").replace(/_/g, " ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}