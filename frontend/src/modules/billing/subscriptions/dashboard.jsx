import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Repeat, CheckCircle, PauseCircle, XCircle, DollarSign, TrendingUp, RotateCcw,
  AlertCircle, AlertTriangle, Percent, Wallet, Layers, BarChart3, PieChart as PieChartIcon,
  PlusCircle, ArrowUpCircle, CalendarClock, FileBarChart2,
} from "lucide-react";
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { subscriptionApi } from "../../../service/billingService";
import {
  DashboardHeader, DashboardStatCard, DashboardStatCardSkeleton, DashboardChartCard,
  DashboardChartCardSkeleton, DashboardChartErrorBoundary, DashboardEmptyPanel, ErrorState,
  DASHBOARD_KPI_GRID, DASHBOARD_CHART_GRID,
  exportDashboardToCsv, exportDashboardToJson,
  BusinessInsights, QuickActions, ActionCenter,
} from "../../../components/billing-shared";
import { Button, StatGroup } from "../../../components/billing-ui";
import { extractArray, formatDisplayCurrency } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { useBillingDateRange } from "../utils/DateRangeContext";

const CARD_COLORS = [
  "from-brand to-brand-hover",
  "from-emerald-500 to-emerald-600",
  "from-amber-500 to-orange-500",
  "from-slate-500 to-slate-600",
  "from-blue-500 to-blue-600",
  "from-brand to-brand-hover",
  "from-indigo-500 to-blue-500",
  "from-red-500 to-rose-500",
  "from-teal-500 to-emerald-500",
  "from-cyan-500 to-teal-500",
  "from-amber-500 to-yellow-500",
  "from-rose-500 to-red-600",
];

// Categorical hues for the Plan Distribution bars — capped at 4 slots because
// that's the largest run of this app's brand hues that clears the data-viz
// accessibility validator (CVD-safe + normal-vision-safe adjacent pairs).
// Plans beyond the 4th fold into "Other" rather than cycling the palette.
const PLAN_CHART_COLORS = ["#FF7A00", "#f59e0b", "#10b981", "#3b82f6"];
const MAX_PLAN_SLICES = 4;

// Status colors are semantic (good/warning/critical), matching the exact
// mapping already used across the Subscriptions module (subscription-list.jsx,
// subscription-detail.jsx, reports.jsx) rather than a generic categorical set.
const STATUS_CHART_COLORS = { active: "#10b981", paused: "#f59e0b", past_due: "#ef4444", cancelled: "#6b7280" };

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const diff = (new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24);
  return diff;
}

// Filters a list of subscriptions down to those created within the selected
// billing date range — mirrors the same client-side `created_at` filter used
// by the Products module dashboard (products/dashboard.jsx), since
// subscriptionApi.getReporting() has no date-range parameters of its own.
function filterByCreatedAt(items, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return items;
  return items.filter((item) => {
    if (!item?.created_at) return true;
    const created = String(item.created_at).slice(0, 10);
    if (dateFrom && created < dateFrom) return false;
    if (dateTo && created > dateTo) return false;
    return true;
  });
}

export default function SubscriptionDashboardPage() {
  const navigate = useNavigate();
  const { baseCurrency } = useCurrency();
  const {
    range: dateRangeValue, setRange: setDateRangeValue,
    customStart, customEnd, applyCustomRange, reset: resetDateRange,
    dateRange,
  } = useBillingDateRange();

  const [subscriptions, setSubscriptions] = useState([]);
  const [plans, setPlans] = useState([]);
  const [reporting, setReporting] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const fetchDashboardData = useCallback(async () => {
    try {
      setError(null);
      const [subsResult, plansResult, reportingResult] = await Promise.allSettled([
        subscriptionApi.list({ per_page: 200 }),
        subscriptionApi.listPlans({ per_page: 100 }),
        subscriptionApi.getReporting(),
      ]);

      if (subsResult.status === "fulfilled") {
        setSubscriptions(extractArray(subsResult.value));
      } else {
        setSubscriptions([]);
        setError(subsResult.reason?.message || "Failed to load subscriptions");
      }

      setPlans(plansResult.status === "fulfilled" ? extractArray(plansResult.value) : []);
      setReporting(reportingResult.status === "fulfilled" ? reportingResult.value : null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err?.message || "Failed to load subscription dashboard data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchDashboardData(); }, [fetchDashboardData]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDashboardData();
  }, [fetchDashboardData]);

  const filteredSubscriptions = useMemo(
    () => filterByCreatedAt(subscriptions, dateRange.date_from, dateRange.date_to),
    [subscriptions, dateRange.date_from, dateRange.date_to]
  );

  const active = useMemo(() => filteredSubscriptions.filter((s) => s.status === "active"), [filteredSubscriptions]);
  const paused = useMemo(() => filteredSubscriptions.filter((s) => s.status === "paused"), [filteredSubscriptions]);
  const cancelled = useMemo(() => filteredSubscriptions.filter((s) => s.status === "cancelled"), [filteredSubscriptions]);
  const pastDue = useMemo(() => filteredSubscriptions.filter((s) => s.status === "past_due"), [filteredSubscriptions]);

  // Renewals due soon: active/paused subscriptions whose current term ends in
  // the next 30 days — the same "expiring" window subscription-list.jsx and
  // invoice-schedules.jsx already use for their renewal reminders.
  const renewalsDueSoon = useMemo(() => filteredSubscriptions.filter((s) => {
    if (s.status !== "active" && s.status !== "paused") return false;
    const diff = daysUntil(s.current_term_end);
    return diff !== null && diff > 0 && diff <= 30;
  }), [filteredSubscriptions]);

  // Churn: prefer a churn-rate field from the reporting endpoint if the
  // backend supplies one; otherwise fall back to cancelled/total, identical
  // to the definition already used on the Subscription Reports page.
  const churnRate = useMemo(() => {
    if (reporting?.churn_rate != null) return parseFloat(reporting.churn_rate);
    if (filteredSubscriptions.length === 0) return 0;
    return (cancelled.length / filteredSubscriptions.length) * 100;
  }, [reporting, cancelled.length, filteredSubscriptions.length]);

  const reportingCurrency = reporting?.reporting_currency || baseCurrency;
  const mrr = reporting?.mrr != null ? parseFloat(reporting.mrr) : 0;
  const arr = reporting?.arr != null ? parseFloat(reporting.arr) : 0;

  const activeValue = useMemo(
    () => active.reduce((sum, s) => sum + parseFloat(s.unit_price || s.amount || 0) * (parseInt(s.quantity, 10) || 1), 0),
    [active]
  );
  const avgRevenuePerSub = active.length > 0 ? activeValue / active.length : 0;

  const distinctPlanIds = useMemo(() => {
    const ids = new Set();
    filteredSubscriptions.forEach((s) => { if (s.plan_id != null) ids.add(s.plan_id); });
    return ids;
  }, [filteredSubscriptions]);
  const distinctPlanCount = distinctPlanIds.size || plans.length;

  // Plan Distribution — mirrors the "Subscription Distribution" chart on the
  // main Billing Dashboard (dashboard.jsx): group subscriptions by plan and
  // count them. Capped to the top 4 plans by subscriber count (the palette's
  // validated slot limit); the remainder folds into "Other" instead of an
  // endlessly repeating/cycled color.
  const planChartData = useMemo(() => {
    const grouped = filteredSubscriptions.reduce((acc, sub) => {
      const key = sub.plan_name || (sub.plan_id != null ? `Plan #${sub.plan_id}` : "Unassigned");
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const entries = Object.entries(grouped)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
    if (entries.length <= MAX_PLAN_SLICES) return entries;
    const top = entries.slice(0, MAX_PLAN_SLICES - 1);
    const otherTotal = entries.slice(MAX_PLAN_SLICES - 1).reduce((s, e) => s + e.value, 0);
    return [...top, { name: "Other", value: otherTotal }];
  }, [filteredSubscriptions]);

  const statusChartData = useMemo(() => ([
    { name: "Active", value: active.length, color: STATUS_CHART_COLORS.active },
    { name: "Paused", value: paused.length, color: STATUS_CHART_COLORS.paused },
    { name: "Past Due", value: pastDue.length, color: STATUS_CHART_COLORS.past_due },
    { name: "Cancelled", value: cancelled.length, color: STATUS_CHART_COLORS.cancelled },
  ].filter((d) => d.value > 0)), [active.length, paused.length, pastDue.length, cancelled.length]);

  const handleExport = useCallback((format) => {
    const prefix = `subscriptions-dashboard-${new Date().toISOString().split("T")[0]}`;
    const payload = {
      total_subscriptions: filteredSubscriptions.length,
      active: active.length,
      paused: paused.length,
      cancelled: cancelled.length,
      past_due: pastDue.length,
      mrr, arr, reporting_currency: reportingCurrency,
      renewals_due_30d: renewalsDueSoon.length,
      churn_rate: churnRate,
      active_subscription_value: activeValue,
      distinct_plans: distinctPlanCount,
      plan_distribution: planChartData,
      status_distribution: statusChartData,
      date_from: dateRange.date_from,
      date_to: dateRange.date_to,
    };
    if (format === "csv") exportDashboardToCsv(payload, prefix);
    else exportDashboardToJson(payload, prefix);
  }, [filteredSubscriptions.length, active.length, paused.length, cancelled.length, pastDue.length, mrr, arr,
      reportingCurrency, renewalsDueSoon.length, churnRate, activeValue, distinctPlanCount, planChartData,
      statusChartData, dateRange]);

  // Business Insights — derived entirely from data already fetched above
  // (churnRate/renewalsDueSoon/pastDue/paused), no new API calls. Renewal
  // health is called out first since it's the headline signal for this
  // dashboard, mirroring how Payments leads with clearance/allocation health.
  const insightItems = useMemo(() => {
    const items = [];
    const retentionRate = 100 - churnRate;
    if (churnRate <= 5) {
      items.push({ tone: "up", icon: TrendingUp, text: `Renewal rate strong at ${retentionRate.toFixed(1)}%` });
    } else {
      items.push({ tone: "down", icon: AlertCircle, text: `Churn rate elevated at ${churnRate.toFixed(1)}%` });
    }
    if (renewalsDueSoon.length > 0) {
      items.push({ tone: "warning", icon: RotateCcw, text: `${renewalsDueSoon.length} renewal${renewalsDueSoon.length === 1 ? "" : "s"} due within 30 days` });
    }
    if (pastDue.length > 0) {
      items.push({ tone: "down", icon: AlertTriangle, text: `${pastDue.length} subscription${pastDue.length === 1 ? "" : "s"} past due` });
    }
    if (paused.length > 0) {
      items.push({ tone: "neutral", icon: PauseCircle, text: `${paused.length} subscription${paused.length === 1 ? "" : "s"} paused` });
    }
    if (items.length === 1) {
      items.push({ tone: "up", icon: CheckCircle, text: "All subscriptions active and in good standing" });
    }
    return items;
  }, [churnRate, renewalsDueSoon.length, pastDue.length, paused.length]);

  // Quick Actions — every href below is an existing route (see App.jsx).
  // There is no standalone "upgrade" route: plan changes happen via the
  // "Change Plan" action inside subscription-detail.jsx, so this tile points
  // at the subscription list rather than inventing a dedicated URL.
  const subscriptionQuickActions = useMemo(() => [
    { label: "Create Subscription", hint: "Start a new recurring plan", href: "/billing/subscriptions/create", icon: PlusCircle },
    { label: "Upgrade / Change Plan", hint: "Manage plans from the subscription list", href: "/billing/subscriptions", icon: ArrowUpCircle },
    { label: "Invoice Schedules", hint: "Review upcoming renewal invoices", href: "/billing/invoice-schedules", icon: CalendarClock },
    { label: "Reports", hint: "MRR, ARR, and churn trends", href: "/billing/subscriptions/reports", icon: FileBarChart2 },
  ], []);

  // Action Center — built only from subscription data already fetched above
  // (renewals due soon / past due / paused / churn), no new API calls.
  const subscriptionActionItems = useMemo(() => {
    const items = [];
    if (renewalsDueSoon.length > 0) {
      items.push({
        icon: RotateCcw, tone: "warning", priority: "medium",
        title: `${renewalsDueSoon.length} renewal${renewalsDueSoon.length === 1 ? "" : "s"} due within 30 days`,
        description: "Current term ends in the next month",
        href: "/billing/invoice-schedules",
      });
    }
    if (pastDue.length > 0) {
      items.push({
        icon: AlertTriangle, tone: "danger", priority: "high",
        title: `${pastDue.length} subscription${pastDue.length === 1 ? "" : "s"} past due`,
        description: "Payment failed or overdue",
        href: "/billing/subscriptions",
      });
    }
    if (paused.length > 0) {
      items.push({
        icon: PauseCircle, tone: "neutral", priority: "low",
        title: `${paused.length} subscription${paused.length === 1 ? "" : "s"} paused`,
        description: "Hold — decide to resume or cancel",
        href: "/billing/subscriptions",
      });
    }
    if (churnRate > 5) {
      items.push({
        icon: AlertCircle, tone: "warning", priority: "medium",
        title: `Churn rate elevated at ${churnRate.toFixed(1)}%`,
        description: "Above the 5% healthy threshold",
        href: "/billing/subscriptions/reports",
      });
    }
    return items;
  }, [renewalsDueSoon.length, pastDue.length, paused.length, churnRate]);

  const headerProps = {
    title: "Subscription Dashboard",
    subtitle: "Recurring billing health, MRR/ARR, renewals, and plan mix",
    icon: Repeat,
    crumbs: [{ label: "Billing", href: "/billing" }, { label: "Subscriptions" }],
    primaryAction: (
      <Button variant="primary" icon={PlusCircle} onClick={() => navigate("/billing/subscriptions/create")}>
        Create Subscription
      </Button>
    ),
    lastUpdated,
    refreshing,
    onRefresh: handleRefresh,
    onExportCSV: () => handleExport("csv"),
    onExportJSON: () => handleExport("json"),
    dateRange: dateRangeValue,
    onDateRangeChange: setDateRangeValue,
    customStart,
    customEnd,
    onApplyCustomRange: applyCustomRange,
    onResetDateRange: resetDateRange,
  };

  if (loading) {
    return (
      <div className="space-y-8" aria-label="Loading subscription dashboard">
        <DashboardHeader {...headerProps} />
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 4 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)}
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 4 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)}
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 4 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)}
        </div>
        <div className={DASHBOARD_CHART_GRID}>
          <DashboardChartCardSkeleton />
          <DashboardChartCardSkeleton />
        </div>
      </div>
    );
  }

  if (error && filteredSubscriptions.length === 0) {
    return (
      <div className="space-y-8">
        <DashboardHeader {...headerProps} />
        <ErrorState message={error} onRetry={fetchDashboardData} title="Couldn't load subscription data" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <DashboardHeader {...headerProps} />

      {error && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      <BusinessInsights items={insightItems} />

      <ActionCenter items={subscriptionActionItems} />

      <div className={DASHBOARD_KPI_GRID}>
        <DashboardStatCard title="Total Subscriptions" value={filteredSubscriptions.length} icon={Repeat} color={CARD_COLORS[0]} href="/billing/subscriptions" />
        <DashboardStatCard title="Active" value={active.length} icon={CheckCircle} color={CARD_COLORS[1]} href="/billing/subscriptions" />
        <DashboardStatCard title="Paused" value={paused.length} icon={PauseCircle} color={CARD_COLORS[2]} href="/billing/subscriptions" />
        <DashboardStatCard title="Cancelled" value={cancelled.length} icon={XCircle} color={CARD_COLORS[3]} href="/billing/subscriptions" />
      </div>

      <StatGroup title="Revenue & Renewals">
        <DashboardStatCard title="MRR (Monthly Recurring Revenue)" value={Number(mrr)} currency={reportingCurrency} icon={DollarSign} color={CARD_COLORS[4]} href="/billing/subscriptions/reports" />
        <DashboardStatCard title="ARR (Annual Recurring Revenue)" value={Number(arr)} currency={reportingCurrency} icon={TrendingUp} color={CARD_COLORS[5]} href="/billing/subscriptions/reports" />
        <DashboardStatCard title="Renewals Due Soon" value={renewalsDueSoon.length} subtitle="Term ends within 30 days" icon={RotateCcw} color={CARD_COLORS[6]} href="/billing/invoice-schedules" />
        <DashboardStatCard title="Churn Rate" value={`${churnRate.toFixed(1)}%`} subtitle={`${cancelled.length} cancelled`} icon={AlertCircle} color={CARD_COLORS[7]} href="/billing/subscriptions/reports" />
      </StatGroup>

      <StatGroup title="More Metrics">
        <DashboardStatCard title="Revenue" value={Number(activeValue)} currency={reportingCurrency} subtitle="Active subscription value" icon={Wallet} color={CARD_COLORS[8]} href="/billing/subscriptions/reports" />
        <DashboardStatCard title="Avg Revenue / Sub" value={Number(avgRevenuePerSub)} currency={reportingCurrency} subtitle="Per active subscription" icon={Percent} color={CARD_COLORS[9]} />
        <DashboardStatCard title="Plans in Use" value={distinctPlanCount} icon={Layers} color={CARD_COLORS[10]} href="/billing/subscriptions/create" />
        <DashboardStatCard title="Past Due" value={pastDue.length} icon={AlertTriangle} color={CARD_COLORS[11]} href="/billing/subscriptions" />
      </StatGroup>

      <QuickActions actions={subscriptionQuickActions} />

      <div className={DASHBOARD_CHART_GRID}>
        <DashboardChartCard title="Plan Distribution">
          <DashboardChartErrorBoundary>
            {planChartData.length === 0 ? (
              <DashboardEmptyPanel title="No plan data" message="Subscriptions will be grouped by plan here once created." icon={BarChart3} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={planChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} interval={0} angle={planChartData.length > 4 ? -20 : 0} textAnchor={planChartData.length > 4 ? "end" : "middle"} height={planChartData.length > 4 ? 50 : 30} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(v) => [v, "Subscriptions"]} />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]} name="Subscriptions">
                    {planChartData.map((entry, idx) => (
                      <Cell key={entry.name} fill={entry.name === "Other" ? "#94a3b8" : PLAN_CHART_COLORS[idx % PLAN_CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title="Status Distribution">
          <DashboardChartErrorBoundary>
            {statusChartData.length === 0 ? (
              <DashboardEmptyPanel title="No subscription data" message="Subscription statuses will be summarized here once created." icon={PieChartIcon} ctaText="Create Subscription" onCtaClick={() => navigate("/billing/subscriptions/create")} steps={[
                { label: "Pricing Plans", icon: Layers, onClick: () => navigate("/billing/pricing") },
                { label: "Products", icon: BarChart3, onClick: () => navigate("/billing/products") },
              ]} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={statusChartData}
                    cx="50%" cy="45%"
                    innerRadius={55} outerRadius={85}
                    paddingAngle={4}
                    dataKey="value"
                    label={({ percent }) => (percent >= 0.05 ? `${(percent * 100).toFixed(0)}%` : "")}
                  >
                    {statusChartData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                  </Pie>
                  <Tooltip formatter={(v, name) => [v, `Subscriptions (${name})`]} />
                  <Legend verticalAlign="bottom" height={36} formatter={(value) => <span className="text-xs text-slate-600 font-medium">{value}</span>} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>
      </div>
    </div>
  );
}
