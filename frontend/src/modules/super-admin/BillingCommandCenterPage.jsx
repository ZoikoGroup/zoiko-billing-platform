import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertCircle,
  AlertTriangle,
  BarChart3,
  Bell,
  Calendar,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  HelpCircle,
  RotateCcw,
  RefreshCcw,
  Users,
} from "lucide-react";

import CommandCenterContextBar from "../../components/CommandCenterContextBar";
import { Button } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";
import { useCommandCenter } from "../../context/CommandCenterContext";
import {
  getBillingCommandOverview,
  getBillingCommandTrend,
  listBillingOverdueInvoices,
  listBillingCollectionsRisk,
  listBillingRecentActivity,
} from "../../service/commandCenterService";

const POLL_INTERVAL_MS = 60000;

const CHART_BLUE = "#2563eb";
const CHART_GREEN = "#10b981";
const CHART_ORANGE = "#f97316";
const CHART_VIOLET = "#8b5cf6";

const AGING_STYLES = {
  current: { dot: "bg-emerald-500", bar: "bg-emerald-500", icon: CheckCircle2, iconColor: "text-emerald-500" },
  "1-30": { dot: "bg-orange-400", bar: "bg-orange-400", icon: Clock, iconColor: "text-orange-400" },
  "31-60": { dot: "bg-orange-500", bar: "bg-orange-500", icon: Clock, iconColor: "text-orange-500" },
  "61-90": { dot: "bg-red-500", bar: "bg-red-500", icon: AlertTriangle, iconColor: "text-red-500" },
  "90+": { dot: "bg-red-600", bar: "bg-red-600", icon: AlertTriangle, iconColor: "text-red-600" },
};

const ACTIVITY_STYLES = {
  payment_received: { icon: CheckCircle2, color: "text-emerald-600", bg: "bg-emerald-50" },
  payment_failed: { icon: AlertTriangle, color: "text-red-600", bg: "bg-red-50" },
  invoice_sent: { icon: FileText, color: "text-slate-500", bg: "bg-slate-100" },
  subscription_changed: { icon: RefreshCcw, color: "text-slate-500", bg: "bg-slate-100" },
};

function money(value, opts = {}) {
  const n = typeof value === "number" ? value : parseFloat(value || "0");
  if (!isFinite(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "decimal",
    minimumFractionDigits: opts.decimals ?? 2,
    maximumFractionDigits: opts.decimals ?? 2,
  }).format(n);
}

function relTime(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

function Sparkline({ data, color }) {
  const points = (data || []).map((v, i) => ({ x: i, v }));
  if (points.length === 0) {
    return (
      <div className="flex h-12 items-center justify-center text-[10px] font-medium uppercase tracking-wider text-slate-300">
        No trend data yet
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={48}>
      <LineChart data={points} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <Line type="monotone" dataKey="v" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function SeverityBadge({ level }) {
  const styles =
    level === "HIGH"
      ? "bg-red-50 text-red-600"
      : level === "MED"
        ? "bg-orange-50 text-orange-600"
        : "bg-emerald-50 text-emerald-600";
  return <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${styles}`}>{level}</span>;
}

function RiskBadge({ level }) {
  const styles =
    level === "High" ? "bg-red-50 text-red-600" : level === "Medium" ? "bg-orange-50 text-orange-600" : "bg-slate-100 text-slate-600";
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${styles}`}>{level}</span>;
}

function StatCard({ icon: Icon, iconBg, iconColor, label, value, sub, subNode, sparkData, sparkColor }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${iconBg}`}>
          <Icon size={16} className={iconColor} />
        </div>
        <span className="text-xs font-medium text-slate-500">{label}</span>
      </div>
      <div className="mb-0.5 text-xl font-bold text-slate-900">{value}</div>
      <div className="mb-2 text-[11px] text-slate-400">{subNode || sub}</div>
      <Sparkline data={sparkData} color={sparkColor} />
    </div>
  );
}

function PanelLink({ to, children }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:underline"
    >
      {children} <ChevronRight size={12} />
    </Link>
  );
}

export default function BillingCommandCenterPage() {
  const navigate = useNavigate();
  const { requestRefresh, refreshTick } = useCommandCenter();

  const [overview, setOverview] = useState(null);
  const [trend, setTrend] = useState(null);
  const [overdue, setOverdue] = useState(null);
  const [risk, setRisk] = useState(null);
  const [activity, setActivity] = useState(null);

  const [granularity, setGranularity] = useState("daily");
  const [sourceErrors, setSourceErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const loadedOnceRef = useRef(false);
  const loadAllRef = useRef(() => {});
  const firstTickRef = useRef(true);
  const granularityRef = useRef(granularity);

  const loadAll = useCallback(() => {
    if (!loadedOnceRef.current) setLoading(true);
    const nextErrors = {};

    const overviewPromise = getBillingCommandOverview().catch((e) => {
      nextErrors.overview = e?.message || "Overview unavailable";
      return null;
    });

    const trendPromise = getBillingCommandTrend(granularityRef.current).catch((e) => {
      nextErrors.trend = e?.message || "Trend unavailable";
      return null;
    });

    const overduePromise = listBillingOverdueInvoices(8).catch((e) => {
      nextErrors.overdue = e?.message || "Overdue invoices unavailable";
      return null;
    });

    const riskPromise = listBillingCollectionsRisk(8).catch((e) => {
      nextErrors.risk = e?.message || "Collections risk unavailable";
      return null;
    });

    const activityPromise = listBillingRecentActivity(6).catch((e) => {
      nextErrors.activity = e?.message || "Activity unavailable";
      return null;
    });

    Promise.all([overviewPromise, trendPromise, overduePromise, riskPromise, activityPromise]).then(
      ([overviewRes, trendRes, overdueRes, riskRes, activityRes]) => {
        setOverview(overviewRes);
        setTrend(trendRes);
        setOverdue(overdueRes);
        setRisk(riskRes);
        setActivity(activityRes);
        setSourceErrors(nextErrors);
        loadedOnceRef.current = true;
        setLoading(false);
      }
    );
  }, []);

  useEffect(() => {
    granularityRef.current = granularity;
  }, [granularity]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    loadAllRef.current = loadAll;
  }, [loadAll]);

  useEffect(() => {
    const id = setInterval(requestRefresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [requestRefresh]);

  useEffect(() => {
    if (firstTickRef.current) {
      firstTickRef.current = false;
      return;
    }
    loadAllRef.current();
  }, [refreshTick]);

  const loadTrend = useCallback(
    (g) => {
      setGranularity(g);
      granularityRef.current = g;
      getBillingCommandTrend(g)
        .then((res) => setTrend(res))
        .catch(() => {});
    },
    []
  );

  if (loading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="p-4 sm:p-6">
        <ErrorState
          message={sourceErrors.overview || "Failed to load billing command center."}
          title="Unable to load billing command center"
          onRetry={() => {
            setLoading(true);
            loadedOnceRef.current = false;
            loadAll();
          }}
        />
      </div>
    );
  }

  const kpis = overview.kpis || {};
  const sparks = overview.sparklines || {};
  const action = overview.action_center || {};
  const aging = overview.aging || [];
  const next7 = overview.next_seven_days || {};
  const multiCurrency = kpis.currency_state === "multi_currency";
  const unknownCurrency = kpis.currency_state === "unknown";
  const currencyLabel = kpis.primary_currency || "";

  const trendPoints = trend?.points || [];
  const labelStep = Math.max(1, Math.ceil(trendPoints.length / 7));

  const sourceErrorCount = Object.keys(sourceErrors).length;

  const actionCards = [
    {
      severity: action.overdue_30d_count > 0 ? "HIGH" : "CLEAR",
      message:
        action.overdue_30d_count > 0
          ? `${action.overdue_30d_count} invoice${action.overdue_30d_count > 1 ? "s" : ""} overdue more than 30 days`
          : "No invoices overdue beyond 30 days",
      amount: action.overdue_30d_count > 0 ? money(action.overdue_30d_amount) : null,
      actionText: "Review",
      onAction: () => navigate("/super-admin/financial/invoice-engine"),
    },
    {
      severity: action.failed_payments_count > 0 ? "HIGH" : "CLEAR",
      message:
        action.failed_payments_count > 0
          ? `${action.failed_payments_count} payment failure${action.failed_payments_count > 1 ? "s" : ""} require action`
          : "No payment failures awaiting recovery",
      amount: action.failed_payments_count > 0 ? money(action.failed_payments_amount) : null,
      actionText: "Resolve",
      onAction: () => navigate("/super-admin/financial/payments"),
    },
    {
      severity: action.draft_invoices_count > 0 ? "MED" : "CLEAR",
      message:
        action.draft_invoices_count > 0
          ? `${action.draft_invoices_count} invoice${action.draft_invoices_count > 1 ? "s" : ""} still in draft`
          : "No draft invoices pending issuance",
      amount: action.draft_invoices_count > 0 ? money(action.draft_invoices_amount) : null,
      actionText: "Review",
      onAction: () => navigate("/super-admin/financial/invoice-engine"),
    },
    {
      severity: action.active_dunning_cases_count > 0 ? "MED" : "CLEAR",
      message:
        action.active_dunning_cases_count > 0
          ? `${action.active_dunning_cases_count} active dunning case${action.active_dunning_cases_count > 1 ? "s" : ""}`
          : "No active dunning cases",
      detail:
        action.active_credit_notes_count > 0
          ? `${action.active_credit_notes_count} credit notes outstanding`
          : null,
      actionText: "Contact",
      onAction: () => navigate("/super-admin/financial/payments"),
    },
  ];

  return (
    <div className="p-4 space-y-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-bold text-slate-900 sm:text-lg">Billing Command Center</h1>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Zoiko Billing · Cross-tenant financial operations and collections
            {!unknownCurrency && currencyLabel ? ` · figures in ${currencyLabel}` : ""}
          </p>
        </div>
        <div className="text-right text-[11px] text-slate-400">
          Refreshed{" "}
          {overview.generated_at ? new Date(overview.generated_at).toLocaleTimeString() : "—"}
          {" · auto-refreshes every minute"}
        </div>
      </div>

      {/* Filter pills */}
      <CommandCenterContextBar />

      {(multiCurrency || unknownCurrency) && (
        <div className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-[11px] text-blue-800">
          <HelpCircle size={13} className="mt-0.5 shrink-0" />
          <span>
            {unknownCurrency
              ? "No invoice data yet — monetary totals are UNKNOWN until the first invoice exists."
              : `Multi-currency platform (${kpis.currencies?.length || 0} currencies). Amounts are shown per currency and never summed across currencies; charts use ${currencyLabel}, the largest bucket.`}
          </span>
        </div>
      )}

      {sourceErrorCount > 0 && (
        <p className="flex items-center gap-1.5 text-[11px] text-amber-700">
          <AlertTriangle size={12} /> {sourceErrorCount} data source{sourceErrorCount > 1 ? "s" : ""} unreachable — affected panels may be stale or empty.
        </p>
      )}

      {/* Action Center */}
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {actionCards.some((c) => c.severity !== "CLEAR") ? (
              <AlertTriangle size={15} className="text-orange-500" />
            ) : (
              <CheckCircle2 size={15} className="text-emerald-500" />
            )}
            <h2 className="text-xs font-bold text-slate-800">Action Center</h2>
          </div>
          <span className="text-[10px] text-slate-400">Live · real billing signals</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {actionCards.map((card, i) => (
            <div key={i} className="rounded-lg border border-slate-200 p-3.5">
              <SeverityBadge level={card.severity} />
              <p className="mt-2 mb-2 text-xs leading-snug text-slate-600">{card.message}</p>
              {card.amount && <div className="mb-2 text-base font-bold text-slate-900">{card.amount}</div>}
              {card.detail && <p className="mb-2 text-[10px] text-slate-400">{card.detail}</p>}
              <button
                type="button"
                onClick={card.onAction}
                className="text-[11px] font-medium text-brand-600 hover:underline"
              >
                {card.actionText} →
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* KPI stat cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={FileText}
          iconBg="bg-brand-50"
          iconColor="text-brand-600"
          label={`Billed${currencyLabel ? ` (${currencyLabel})` : ""}`}
          value={unknownCurrency ? "UNKNOWN" : money(kpis.display_invoiced_amount)}
          sub={`${(kpis.total_invoices ?? 0).toLocaleString()} invoices issued platform-wide`}
          sparkData={sparks.billed}
          sparkColor={CHART_BLUE}
        />
        <StatCard
          icon={CheckCircle2}
          iconBg="bg-emerald-50"
          iconColor="text-emerald-600"
          label={`Collected${currencyLabel ? ` (${currencyLabel})` : ""}`}
          value={unknownCurrency ? "UNKNOWN" : money(kpis.display_collected_amount)}
          sub="Paid invoices · allocated to customers"
          sparkData={sparks.collected}
          sparkColor={CHART_GREEN}
        />
        <StatCard
          icon={Clock}
          iconBg="bg-orange-50"
          iconColor="text-orange-500"
          label={`Outstanding${currencyLabel ? ` (${currencyLabel})` : ""}`}
          value={unknownCurrency ? "UNKNOWN" : money(kpis.display_outstanding_amount)}
          subNode={
            <>
              {money(kpis.display_current_amount)} current ·{" "}
              <span className="font-medium text-orange-600">{money(kpis.display_overdue_amount)} overdue</span>{" "}
              ({kpis.overdue_count ?? 0})
            </>
          }
          sparkData={sparks.newly_overdue}
          sparkColor={CHART_ORANGE}
        />
        <StatCard
          icon={BarChart3}
          iconBg="bg-violet-50"
          iconColor="text-violet-600"
          label={`Collection Rate${currencyLabel ? ` (${currencyLabel})` : ""}`}
          value={
            kpis.display_collection_rate_pct != null
              ? `${kpis.display_collection_rate_pct}%`
              : unknownCurrency
                ? "UNKNOWN"
                : "—"
          }
          sub="Collected ÷ invoiced, per currency"
          sparkData={sparks.rate}
          sparkColor={CHART_VIOLET}
        />
      </div>

      {/* Billings & Collections + Collections Health */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4 lg:col-span-2">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="text-xs font-bold text-slate-800">Billings &amp; Collections</h3>
              <div className="flex items-center gap-3 text-[10px] text-slate-500">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full" style={{ background: CHART_BLUE }} /> Billed
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full" style={{ background: CHART_GREEN }} /> Collected
                </span>
              </div>
            </div>
            <div className="flex items-center overflow-hidden rounded-lg border border-slate-200">
              {["daily", "weekly", "monthly"].map((g) => (
                <button
                  key={g}
                  type="button"
                  onClick={() => loadTrend(g)}
                  className={`px-3 py-1 text-[11px] font-medium capitalize transition-colors ${
                    granularity === g ? "bg-brand-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {g}
                </button>
              ))}
            </div>
          </div>
          {trendPoints.length === 0 ? (
            <div className="flex h-64 items-center justify-center text-xs text-slate-400">
              No billing trend data{trend?.currency ? ` in ${trend.currency}` : ""} for this window.
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={trendPoints} margin={{ top: 16, right: 8, left: -8, bottom: 0 }}>
                  <XAxis dataKey="label" hide />
                  <YAxis hide />
                  <Tooltip
                    formatter={(value, name) => [money(value), name === "billed" ? "Billed" : "Collected"]}
                    labelStyle={{ fontSize: 11 }}
                    contentStyle={{ fontSize: 11, borderRadius: 8, borderColor: "#e2e8f0" }}
                  />
                  <Line
                    type="monotone"
                    dataKey="billed"
                    stroke={CHART_BLUE}
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: CHART_BLUE }}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="collected"
                    stroke={CHART_GREEN}
                    strokeWidth={2.5}
                    dot={{ r: 3, fill: CHART_GREEN }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
              <div className="-mt-1 flex justify-between px-1 text-[10px] text-slate-400">
                {trendPoints.map(
                  (d, i) =>
                    (i % labelStep === 0 || i === trendPoints.length - 1) && <span key={d.label + i}>{d.label}</span>
                )}
              </div>
              {trend?.currency && !unknownCurrency && (
                <p className="mt-1 text-[10px] text-slate-400">
                  Series scoped to {trend.currency}
                  {multiCurrency ? " — other currencies are tracked separately and never combined." : "."}
                </p>
              )}
            </>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-bold text-slate-800">Collections Health</h3>
          {aging.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-400">
              No open receivables{currencyLabel ? ` in ${currencyLabel}` : ""}.
            </p>
          ) : (
            <div className="mb-4 space-y-2.5">
              {aging.map((row) => {
                const style = AGING_STYLES[row.key] || AGING_STYLES["current"];
                const Icon = style.icon;
                return (
                  <div key={row.key} className="flex items-center gap-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
                    <span className="flex-1 truncate text-[11px] text-slate-600">{row.label}</span>
                    <span className="w-14 text-right text-[11px] font-semibold text-slate-800">
                      {money(row.amount, { decimals: 0 })}
                    </span>
                    <div className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-slate-100">
                      <div className={`h-full rounded-full ${style.bar}`} style={{ width: `${Math.min(row.pct * 3, 100)}%` }} />
                    </div>
                    <span className="w-9 text-right text-[10px] text-slate-400">{row.pct}%</span>
                    <Icon size={12} className={`shrink-0 ${style.iconColor}`} />
                  </div>
                );
              })}
            </div>
          )}
          {overview.aging_basis?.note && (
            <p className="mb-3 text-[10px] leading-snug text-slate-400">{overview.aging_basis.note}</p>
          )}
          <div className="space-y-2.5 border-t border-slate-100 pt-3">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-600">
                <AlertTriangle size={13} className="text-orange-400" /> Payment failures
              </span>
              <span className="font-semibold text-slate-800">{action.failed_payments_count}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-600">
                <Bell size={13} className="text-slate-400" /> Dunning cases
              </span>
              <span className="font-semibold text-slate-800">{action.active_dunning_cases_count}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-600">
                <Users size={13} className="text-slate-400" /> Customers at risk
              </span>
              <span className="font-semibold text-slate-800">{overview.customers_at_risk}</span>
            </div>
          </div>
          <div className="mt-3 border-t border-slate-100 pt-2 text-right">
            <PanelLink to="/super-admin/financial/payments">Recovery &amp; collections</PanelLink>
          </div>
        </div>
      </div>

      {/* Overdue Invoices + Next 7 Days */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-bold text-slate-800">Overdue Invoices</h3>
            {overdue?.total > 0 && <span className="text-[10px] text-slate-400">{overdue.total} total</span>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-400">
                  <th scope="col" className="pb-2 pr-3 font-medium">Invoice</th>
                  <th scope="col" className="pb-2 pr-3 font-medium">Customer</th>
                  <th scope="col" className="pb-2 pr-3 font-medium">Due</th>
                  <th scope="col" className="pb-2 pr-3 font-medium">Age</th>
                  <th scope="col" className="pb-2 pr-3 font-medium">Amount</th>
                  <th scope="col" className="pb-2 pr-3 font-medium">Status</th>
                  <th scope="col" className="pb-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {(overdue?.invoices || []).length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-xs text-slate-500">
                      <CheckCircle2 size={18} className="mx-auto mb-1 text-emerald-500" />
                      Nothing is overdue. All open invoices are within terms.
                    </td>
                  </tr>
                ) : (
                  overdue.invoices.map((row) => (
                    <tr key={row.invoice_id} className="border-t border-slate-100">
                      <td className="py-2.5 pr-3 font-semibold text-brand-600">{row.invoice_number}</td>
                      <td className="max-w-[160px] truncate py-2.5 pr-3 text-slate-700" title={row.customer_name}>
                        {row.customer_name}
                        <span className="block truncate text-[10px] font-normal text-slate-400">{row.organization_name}</span>
                      </td>
                      <td className="py-2.5 pr-3 text-slate-500">
                        {new Date(row.due_date).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
                      </td>
                      <td className="py-2.5 pr-3 font-medium text-red-500">{row.days_overdue}d</td>
                      <td className="whitespace-nowrap py-2.5 pr-3 font-semibold text-slate-800">
                        {money(row.amount)} <span className="text-[10px] font-normal text-slate-400">{row.currency}</span>
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className="text-[11px] font-semibold text-red-500">Overdue</span>
                      </td>
                      <td className="py-2.5">
                        <button
                          type="button"
                          onClick={() => navigate("/super-admin/financial/invoice-engine")}
                          className="text-[11px] font-medium text-brand-600 hover:underline"
                        >
                          Review
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3">
            <PanelLink to="/super-admin/financial/invoice-engine">View all overdue invoices</PanelLink>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-bold text-slate-800">Next 7 Days</h3>
          <div className="space-y-3.5">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-600">
                <Calendar size={13} className="text-slate-400" /> Invoices scheduled
              </span>
              <span className="font-semibold text-slate-800">{next7.invoices_scheduled ?? 0}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-600">
                <Clock size={13} className="text-slate-400" /> Expected billing
              </span>
              <span className="font-semibold text-slate-800">
                {next7.expected_billing_amount != null ? money(next7.expected_billing_amount, { decimals: 0 }) : "—"}
                {next7.expected_billing_currency ? (
                  <span className="ml-1 text-[10px] font-normal text-slate-400">{next7.expected_billing_currency}</span>
                ) : null}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-600">
                <RefreshCcw size={13} className="text-slate-400" /> Renewals due
              </span>
              <span className="font-semibold text-slate-800">{next7.renewals ?? 0}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-600">
                <RotateCcw size={13} className="text-slate-400" /> Payment retries
              </span>
              <span className="font-semibold text-slate-800">{next7.payment_retries ?? 0}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-2 text-slate-600">
                <AlertCircle size={13} className="text-slate-400" /> Quotes expiring
              </span>
              <span className="font-semibold text-slate-800">{next7.quotes_expiring ?? 0}</span>
            </div>
          </div>
          <div className="mt-4 border-t border-slate-100 pt-2 text-right">
            <PanelLink to="/super-admin/financial/invoice-engine">Open invoice engine</PanelLink>
          </div>
        </div>
      </div>

      {/* Collections Risk + Recent Activity */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4 lg:col-span-2">
          <h3 className="mb-3 text-xs font-bold text-slate-800">Collections Risk</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-400">
                  <th scope="col" className="pb-2 pr-3 font-medium">Customer</th>
                  <th scope="col" className="pb-2 pr-3 font-medium">Outstanding</th>
                  <th scope="col" className="pb-2 pr-3 font-medium">Risk</th>
                  <th scope="col" className="pb-2 pr-3 font-medium">Last payment</th>
                  <th scope="col" className="pb-2 font-medium">Risk note</th>
                </tr>
              </thead>
              <tbody>
                {(risk?.rows || []).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-xs text-slate-500">
                      <CheckCircle2 size={18} className="mx-auto mb-1 text-emerald-500" />
                      No customers carry an overdue balance right now.
                    </td>
                  </tr>
                ) : (
                  risk.rows.map((row) => (
                    <tr key={row.customer_id} className="border-t border-slate-100">
                      <td className="py-2.5 pr-3">
                        <span className="font-semibold text-brand-600">{row.customer_name}</span>
                        <span className="block truncate text-[10px] font-normal text-slate-400">{row.organization_name}</span>
                      </td>
                      <td className="whitespace-nowrap py-2.5 pr-3 font-semibold text-slate-800">
                        {money(row.outstanding)} <span className="text-[10px] font-normal text-slate-400">{row.currency}</span>
                      </td>
                      <td className="py-2.5 pr-3">
                        <RiskBadge level={row.risk} />
                      </td>
                      <td className="py-2.5 pr-3 text-slate-500">
                        {row.last_activity
                          ? new Date(row.last_activity).toLocaleDateString([], { month: "short", day: "numeric" })
                          : "Never"}
                      </td>
                      <td className="py-2.5 text-slate-500 capitalize">{row.note}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-3">
            <PanelLink to="/super-admin/financial/payments">View all customers at risk</PanelLink>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 text-xs font-bold text-slate-800">Recent Activity</h3>
          <div className="space-y-3.5">
            {(activity?.items || []).length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-500">No billing activity recorded yet.</p>
            ) : (
              activity.items.map((item, i) => {
                const style = ACTIVITY_STYLES[item.kind] || ACTIVITY_STYLES.invoice_sent;
                const Icon = style.icon;
                return (
                  <div key={`${item.kind}-${item.occurred_at}-${i}`} className="flex items-start gap-2.5">
                    <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${style.bg}`}>
                      <Icon size={13} className={style.color} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold text-slate-800">{item.title}</div>
                      <div className="truncate text-[10px] text-slate-400">{item.meta}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[10px] text-slate-400">{relTime(item.occurred_at)}</div>
                      {item.actor && <div className="max-w-[90px] truncate text-[10px] text-slate-400">{item.actor}</div>}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="mt-4 border-t border-slate-100 pt-2 text-right">
            <PanelLink to="/super-admin/audit-logs">View all activity</PanelLink>
          </div>
        </div>
      </div>
    </div>
  );
}
