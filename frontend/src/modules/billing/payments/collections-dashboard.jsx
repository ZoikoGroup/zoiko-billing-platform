import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell, BarChart3, CheckCircle, AlertCircle, RefreshCw, Wallet,
  PieChart as PieChartIcon, Users, TrendingUp, HandCoins, AlertTriangle,
  Layers, PlusCircle,
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { dunningApi, collectionApi, promiseToPayApi } from "../../../service/billingService";
import { extractArray, formatDisplayCurrency } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import {
  DashboardHeader, DashboardStatCard as EnterpriseStatCard, DashboardChartCard as ChartCard,
  DashboardEmptyPanel as EmptyStateWidget, DashboardStatCardSkeleton as SkeletonCard,
  DashboardChartCardSkeleton as SkeletonChart, DashboardChartErrorBoundary as ChartErrorBoundary,
  DASHBOARD_KPI_GRID, DASHBOARD_CHART_GRID, exportDashboardToCsv, exportDashboardToJson,
  BusinessInsights, QuickActions, ActionCenter,
} from "../../../components/billing-shared";
import { Button, StatGroup } from "../../../components/billing-ui";

const CHART_COLORS = ["var(--color-accent-collections)", "#10b981", "#f59e0b", "#ef4444", "#3b82f6", "#ec4899", "#06b6d4"];
const CARD_GRADIENTS = [
  "from-brand to-brand-hover",
  "from-emerald-500 to-green-500",
  "from-amber-500 to-orange-500",
  "from-red-500 to-rose-500",
  "from-sky-500 to-blue-500",
];

const DUNNING_STATUS_COLORS = { active: "#f59e0b", resolved: "#10b981", escalated: "#ef4444", closed: "#94a3b8" };
const COLLECTIONS_STATUS_COLORS = { open: "#3b82f6", in_progress: "#f59e0b", resolved: "#10b981", closed: "#94a3b8", escalated: "#ef4444" };

const COLLECTIONS_CRUMBS = [
  { label: "Billing", href: "/billing" },
  { label: "Payments", href: "/billing/payments" },
  { label: "Collections" },
];

export default function CollectionsDashboard() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const { baseCurrency } = useCurrency();
  const mountedRef = useRef(true);
  const loadingRef = useRef(true);

  const [dashboard, setDashboard] = useState({
    dunningStats: null, collectionsStats: null, promiseStats: null,
    levelDist: [], collectionsPriorityDist: [], recoveryTrend: [],
    effectiveness: null, dunningPerformance: null, overdueByCustomer: [],
  });

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      if (!loadingRef.current) setRefreshing(true);

      const results = await Promise.allSettled([
        dunningApi.getDashboardStats(),
        collectionApi.getDashboardStats(),
        promiseToPayApi.getDashboardStats(),
        dunningApi.getLevelDistribution(),
        collectionApi.getPriorityDistribution(),
        collectionApi.getRecoveryTrend(12),
        collectionApi.getCollectionEffectiveness(),
        collectionApi.getDunningPerformance(),
        collectionApi.getOverdueByCustomer(10),
      ]);
      const [
        dunningStats, collectionsStats, promiseStats, levelDist,
        collectionsPriorityDist, recoveryTrend, effectiveness, dunningPerformance, overdueByCustomer,
      ] = results;
      const val = (r, transform) => (r.status === "fulfilled" ? (transform ? transform(r.value) : r.value) : null);

      if (mountedRef.current) {
        setDashboard({
          dunningStats: val(dunningStats),
          collectionsStats: val(collectionsStats),
          promiseStats: val(promiseStats),
          levelDist: val(levelDist, extractArray) || [],
          collectionsPriorityDist: val(collectionsPriorityDist, extractArray) || [],
          recoveryTrend: val(recoveryTrend, extractArray) || [],
          effectiveness: val(effectiveness),
          dunningPerformance: val(dunningPerformance),
          overdueByCustomer: val(overdueByCustomer, extractArray) || [],
        });
        setLastUpdated(new Date());
      }
    } catch (err) {
      if (mountedRef.current) setError("Failed to load collections dashboard data.");
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
        loadingRef.current = false;
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    loadingRef.current = true;
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => { mountedRef.current = false; clearInterval(interval); };
  }, [fetchData]);

  const handleRefresh = useCallback(() => { setRefreshing(true); fetchData(); }, [fetchData]);

  const handleExport = useCallback((format) => {
    const prefix = `collections-dashboard-${new Date().toISOString().split("T")[0]}`;
    if (format === "csv") exportDashboardToCsv({ ...(dashboard.dunningStats || {}), ...(dashboard.collectionsStats || {}) }, prefix);
    else if (format === "json") exportDashboardToJson(dashboard, prefix);
  }, [dashboard]);

  const dunningStats = dashboard.dunningStats || {};
  const collectionsStats = dashboard.collectionsStats || {};
  const promiseStats = dashboard.promiseStats || {};
  const promiseResolved = (promiseStats.fulfilled_count || 0) + (promiseStats.broken_count || 0);
  const promiseSuccessRate = promiseResolved > 0 ? ((promiseStats.fulfilled_count || 0) / promiseResolved * 100) : 0;

  if (loading) {
    return (
      <div className="space-y-8" aria-label="Loading collections dashboard">
        <DashboardHeader title="Collections Dashboard" subtitle="Dunning, collections, and promise-to-pay performance" icon={HandCoins} iconGradient="from-brand to-brand-hover" crumbs={COLLECTIONS_CRUMBS} />
        <div className={DASHBOARD_KPI_GRID}>{Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}</div>
        <div className={DASHBOARD_CHART_GRID}><SkeletonChart /><SkeletonChart /></div>
      </div>
    );
  }

  if (error && !dashboard.dunningStats && !dashboard.collectionsStats) {
    return (
      <div className="space-y-8">
        <DashboardHeader title="Collections Dashboard" subtitle="Dunning, collections, and promise-to-pay performance" icon={HandCoins} iconGradient="from-brand to-brand-hover" crumbs={COLLECTIONS_CRUMBS} />
        <div className="flex flex-col items-center justify-center py-20">
          <div className="h-16 w-16 rounded-full bg-red-100 text-red-600 flex items-center justify-center mb-4"><AlertCircle size={32} /></div>
          <h3 className="text-xl font-bold text-slate-800 mb-2">Something went wrong</h3>
          <p className="text-slate-600 mb-6 text-center max-w-md">{error}</p>
          <button onClick={handleRefresh} className="px-6 py-3 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl font-medium hover:shadow-lg transition-all flex items-center gap-2">
            <RefreshCw size={18} /> Try Again
          </button>
        </div>
      </div>
    );
  }

  const dunningLevelData = dashboard.levelDist.map((l) => ({ name: `Level ${l.level}`, count: l.count, value: l.total_amount }));
  const collectionsPriorityData = dashboard.collectionsPriorityDist
    .map((p) => ({ name: p.priority, value: p.count }))
    .filter((p) => p.value > 0);

  // Collection rate — recovered vs. total receivables currently tracked by
  // the collections module, derived from data already fetched above.
  const collectedAmt = collectionsStats.amount_collected || 0;
  const outstandingAmt = collectionsStats.total_outstanding || 0;
  const collectionRate = (collectedAmt + outstandingAmt) > 0 ? (collectedAmt / (collectedAmt + outstandingAmt)) * 100 : 0;
  const topPriority = [...collectionsPriorityData].sort((a, b) => b.value - a.value)[0];

  const insightItems = [];
  if (collectedAmt + outstandingAmt > 0) {
    insightItems.push({
      tone: collectionRate >= 50 ? "up" : "warning",
      icon: TrendingUp,
      text: `Collection rate improved to ${collectionRate.toFixed(1)}% of tracked receivables`,
    });
  }
  if (dunningStats.escalated_count > 0) {
    insightItems.push({ tone: "warning", icon: AlertTriangle, text: `${dunningStats.escalated_count} case${dunningStats.escalated_count === 1 ? "" : "s"} escalated to collections` });
  }
  if (topPriority) {
    insightItems.push({ tone: "neutral", icon: Users, text: `${topPriority.name} priority accounts for ${topPriority.value} open collections case${topPriority.value === 1 ? "" : "s"}` });
  }
  if ((dunningStats.active_count || 0) > 0) {
    insightItems.push({ tone: "warning", icon: Bell, text: `${dunningStats.active_count} active dunning case${dunningStats.active_count === 1 ? "" : "s"} in progress` });
  }
  if (!insightItems.length) {
    insightItems.push({ tone: "up", icon: CheckCircle, text: "No overdue balances — all accounts current" });
  }

  const collectionsQuickActions = [
    { label: "Collections Cases", hint: "Manage open receivables cases", href: "/billing/collections-receivables", icon: Users },
    { label: "Dunning", hint: "Review active dunning cases", href: "/billing/dunning", icon: Bell },
    { label: "Dunning Levels", hint: "Configure escalation levels", href: "/billing/dunning/levels", icon: Layers },
    { label: "Promise to Pay", hint: "Track payment commitments", href: "/billing/promise-to-pay", icon: HandCoins },
  ];

  // Action Center — built only from the dunning/collections/promise stats
  // already fetched above; each row links to an existing filtered view.
  const collectionActionItems = [
    ...((dunningStats.escalated_count || 0) > 0 ? [{
      icon: AlertTriangle, tone: "danger", priority: "high",
      title: `${dunningStats.escalated_count} case${dunningStats.escalated_count === 1 ? "" : "s"} escalated to collections`,
      description: "Needs a recovery decision",
      href: "/billing/collections-receivables?status=escalated",
    }] : []),
    ...((dunningStats.active_count || 0) > 0 ? [{
      icon: Bell, tone: "warning", priority: "medium",
      title: `${dunningStats.active_count} active dunning case${dunningStats.active_count === 1 ? "" : "s"}`,
      description: "In progress across escalation levels",
      href: "/billing/dunning",
    }] : []),
    ...(((collectionsStats.open_count || 0) + (collectionsStats.in_progress_count || 0)) > 0 ? [{
      icon: Users, tone: "neutral", priority: "medium",
      title: `${((collectionsStats.open_count || 0) + (collectionsStats.in_progress_count || 0)).toLocaleString()} open collections case${((collectionsStats.open_count || 0) + (collectionsStats.in_progress_count || 0)) === 1 ? "" : "s"}`,
      description: "Awaiting collection effort",
      href: "/billing/collections-receivables",
    }] : []),
    ...(((promiseStats.pending_count || 0) + (promiseStats.overdue_count || 0)) > 0 ? [{
      icon: HandCoins, tone: "warning", priority: "low",
      title: `${((promiseStats.pending_count || 0) + (promiseStats.overdue_count || 0)).toLocaleString()} promise${((promiseStats.pending_count || 0) + (promiseStats.overdue_count || 0)) === 1 ? "" : "s"} to pay pending`,
      description: "Tracked commitments not yet fulfilled",
      href: "/billing/promise-to-pay",
    }] : []),
  ];

  return (
    <div className="space-y-8">
      <DashboardHeader
        title="Collections Dashboard"
        subtitle="Dunning escalation, collections workload, and promise-to-pay performance across every customer."
        icon={HandCoins}
        iconGradient="from-brand to-brand-hover"
        crumbs={COLLECTIONS_CRUMBS}
        lastUpdated={lastUpdated}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        onExportCSV={() => handleExport("csv")}
        onExportJSON={() => handleExport("json")}
        primaryAction={<Button variant="primary" icon={PlusCircle} onClick={() => navigate("/billing/collections-receivables")}>New Collection Case</Button>}
      />

      <BusinessInsights items={insightItems} />

      <ActionCenter items={collectionActionItems} />

      <div className={DASHBOARD_KPI_GRID}>
        <EnterpriseStatCard title="Active Dunning Cases" value={(dunningStats.active_count || 0).toLocaleString()} icon={Bell} color={CARD_GRADIENTS[0]} href="/billing/dunning" />
        <EnterpriseStatCard title="Open Collections Cases" value={((collectionsStats.open_count || 0) + (collectionsStats.in_progress_count || 0)).toLocaleString()} icon={Users} color={CARD_GRADIENTS[1]} href="/billing/collections-receivables" />
        <EnterpriseStatCard title="Total Overdue" value={Number(dunningStats.total_overdue_amount || 0)} currency={baseCurrency} icon={Wallet} color={CARD_GRADIENTS[2]} />
        <EnterpriseStatCard title="Promise-to-Pay Success" value={`${promiseSuccessRate.toFixed?.(1) ?? promiseSuccessRate.toFixed(1)}%`} icon={HandCoins} color={CARD_GRADIENTS[3]} href="/billing/promise-to-pay" />
      </div>

      <StatGroup title="More Metrics">
        <EnterpriseStatCard title="Amount Collected" value={Number(collectionsStats.amount_collected || 0)} currency={baseCurrency} icon={CheckCircle} color={CARD_GRADIENTS[1]} sparkline={dashboard.recoveryTrend.map((m) => m.amount_collected)} />
        <EnterpriseStatCard title="Still Outstanding" value={Number(collectionsStats.total_outstanding || 0)} currency={baseCurrency} icon={Wallet} color={CARD_GRADIENTS[2]} />
        <EnterpriseStatCard title="Escalated to Collections" value={(dunningStats.escalated_count || 0).toLocaleString()} icon={TrendingUp} color={CARD_GRADIENTS[4]} href="/billing/collections-receivables?status=escalated" />
        <EnterpriseStatCard title="Pending Promises" value={((promiseStats.pending_count || 0) + (promiseStats.overdue_count || 0)).toLocaleString()} icon={HandCoins} color={CARD_GRADIENTS[3]} href="/billing/promise-to-pay" />
      </StatGroup>

      <QuickActions actions={collectionsQuickActions} />

      <div className={DASHBOARD_CHART_GRID}>
        <ChartCard title="Dunning Level Distribution">
          <ChartErrorBoundary aria-live="polite">
            {dunningLevelData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={dunningLevelData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Bar dataKey="count" name="Cases" fill="var(--color-accent-collections)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyStateWidget message="No active dunning cases" icon={BarChart3} />}
          </ChartErrorBoundary>
        </ChartCard>

        <ChartCard title="Collections Priority Distribution">
          <ChartErrorBoundary aria-live="polite">
            {collectionsPriorityData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={collectionsPriorityData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label>
                    {collectionsPriorityData.map((entry, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            ) : <EmptyStateWidget message="No collections cases" icon={PieChartIcon} ctaText="New Collection Case" onCtaClick={() => navigate("/billing/collections-receivables")} />}
          </ChartErrorBoundary>
        </ChartCard>
      </div>

      <div className={DASHBOARD_CHART_GRID}>
        <ChartCard title="Recovery Trend (Amount Collected / Month)">
          <ChartErrorBoundary aria-live="polite">
            {dashboard.recoveryTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={dashboard.recoveryTrend}>
                  <defs>
                    <linearGradient id="recoveryTrendGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--color-accent-collections)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--color-accent-collections)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="amount_collected" name="Amount Collected" stroke="var(--color-accent-collections)" strokeWidth={2} fill="url(#recoveryTrendGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : <EmptyStateWidget message="No recovery trend data" icon={BarChart3} />}
          </ChartErrorBoundary>
        </ChartCard>

        <ChartCard title="Top Customers by Overdue Balance">
          <ChartErrorBoundary aria-live="polite">
            {dashboard.overdueByCustomer.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={dashboard.overdueByCustomer} layout="vertical" margin={{ left: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="customer_name" tick={{ fontSize: 11 }} width={120} />
                  <Tooltip />
                  <Bar dataKey="total_overdue" name="Overdue" fill="#ef4444" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyStateWidget message="No overdue customers" icon={Users} />}
          </ChartErrorBoundary>
        </ChartCard>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 p-6">
        <h3 className="text-sm font-semibold text-slate-900 mb-4">Dunning Performance</h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div className="rounded-lg bg-slate-50 p-4">
            <p className="text-xs font-medium text-slate-500">Resolution Rate</p>
            <p className="mt-1 text-lg font-bold text-emerald-700">{(dashboard.dunningPerformance?.resolution_rate_percentage ?? 0)}%</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-4">
            <p className="text-xs font-medium text-slate-500">Escalation Rate</p>
            <p className="mt-1 text-lg font-bold text-red-700">{(dashboard.dunningPerformance?.escalation_rate_percentage ?? 0)}%</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-4">
            <p className="text-xs font-medium text-slate-500">Promise Fulfilled</p>
            <p className="mt-1 text-lg font-bold text-emerald-700">{promiseStats.fulfilled_count || 0}</p>
          </div>
          <div className="rounded-lg bg-slate-50 p-4">
            <p className="text-xs font-medium text-slate-500">Promise Broken</p>
            <p className="mt-1 text-lg font-bold text-red-700">{promiseStats.broken_count || 0}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
