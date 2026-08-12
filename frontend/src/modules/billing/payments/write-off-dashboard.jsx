import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ScrollText, CheckCircle, AlertCircle, RefreshCw, Wallet,
  BarChart3, PieChart as PieChartIcon, Ban, Clock, Undo2, PlusCircle, Landmark } from "lucide-react"
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { writeOffApi } from "../../../service/billingService";
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

const CHART_COLORS = ["#B45309", "#10b981", "#f59e0b", "#ef4444", "#3b82f6", "#ec4899", "#FF9B4D", "#06b6d4"];
const CARD_GRADIENTS = [
  "from-amber-500 to-orange-500",
  "from-emerald-500 to-green-500",
  "from-indigo-500 to-blue-500",
  "from-brand to-brand-hover",
  "from-red-500 to-rose-500",
  "from-sky-500 to-blue-500",
];

const STATUS_COLORS = {
  draft: "#6b7280",
  pending_approval: "#f59e0b",
  approved: "#6366f1",
  executed: "#10b981",
  reversed: "#f97316",
  cancelled: "#94a3b8",
};

export default function WriteOffDashboard() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const { baseCurrency } = useCurrency();
  const mountedRef = useRef(true);
  const loadingRef = useRef(true);

  const [dashboard, setDashboard] = useState({
    stats: null,
    statusDist: [],
    typeDist: [],
    sourceDist: [],
    monthlyTrend: [],
  });

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      if (!loadingRef.current) setRefreshing(true);

      const results = await Promise.allSettled([
        writeOffApi.getDashboardStats(),
        writeOffApi.getStatusDistribution(),
        writeOffApi.getTypeDistribution(),
        writeOffApi.getSourceDistribution(),
        writeOffApi.getMonthlyTrend(12),
      ]);
      const [statsRes, statusRes, typeRes, sourceRes, trendRes] = results;
      const safeVal = (r, transform) => (r.status === "fulfilled" ? (transform ? transform(r.value) : r.value) : null);

      if (mountedRef.current) {
        setDashboard({
          stats: safeVal(statsRes),
          statusDist: safeVal(statusRes, extractArray) || [],
          typeDist: safeVal(typeRes, extractArray) || [],
          sourceDist: safeVal(sourceRes, extractArray) || [],
          monthlyTrend: safeVal(trendRes, extractArray) || [],
        });
        setLastUpdated(new Date());
      }
    } catch (err) {
      if (mountedRef.current) setError("Failed to load write-off dashboard data.");
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

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchData();
  }, [fetchData]);

  const handleExport = useCallback((format) => {
    const prefix = `write-off-dashboard-${new Date().toISOString().split("T")[0]}`;
    if (format === "csv") {
      exportDashboardToCsv({ ...(dashboard.stats || {}) }, prefix);
    } else if (format === "json") {
      exportDashboardToJson(dashboard, prefix);
    }
  }, [dashboard]);

  const stats = dashboard.stats || {};
  const kpis = useMemo(() => ({
    totalCount: stats.total_count || 0,
    totalValue: stats.total_value || 0,
    executedValue: stats.executed_value || 0,
    reversedValue: stats.reversed_value || 0,
    outstandingValue: stats.outstanding_value || 0,
    draftCount: stats.draft_count || 0,
    pendingApprovalCount: stats.pending_approval_count || 0,
    approvedCount: stats.approved_count || 0,
    executedCount: stats.executed_count || 0,
    reversedCount: stats.reversed_count || 0,
    cancelledCount: stats.cancelled_count || 0,
  }), [stats]);

  const WRITE_OFF_CRUMBS = useMemo(() => [
    { label: "Billing", href: "/billing" },
    { label: "Payments", href: "/billing/payments" },
    { label: "Write-offs" },
  ], []);

  const insightItems = useMemo(() => {
    const items = [];
    if (kpis.pendingApprovalCount > 0) {
      items.push({ tone: "warning", icon: Clock, text: `${kpis.pendingApprovalCount} write-off${kpis.pendingApprovalCount === 1 ? "" : "s"} awaiting approval` });
    }
    if (kpis.totalValue > 0) {
      items.push({ tone: "neutral", icon: Wallet, text: `${formatDisplayCurrency(kpis.totalValue, baseCurrency)} written off in total` });
    }
    const topType = (dashboard.typeDist || [])
      .slice()
      .sort((a, b) => (b.total_amount || 0) - (a.total_amount || 0))[0];
    if (topType) {
      items.push({ tone: "neutral", icon: ScrollText, text: `Largest category: ${(topType.write_off_type || "unspecified").replace(/_/g, " ")} (${topType.count || 0})` });
    }
    if (kpis.reversedCount > 0) {
      items.push({ tone: "down", icon: Undo2, text: `${kpis.reversedCount} write-off${kpis.reversedCount === 1 ? "" : "s"} reversed` });
    }
    if (!items.length) {
      items.push({ tone: "up", icon: CheckCircle, text: "No write-offs pending approval" });
    }
    return items;
  }, [kpis.pendingApprovalCount, kpis.totalValue, kpis.reversedCount, dashboard.typeDist, baseCurrency]);

  const writeOffQuickActions = useMemo(() => [
    { label: "Write-offs", hint: "Review and manage all write-offs", href: "/billing/write-offs", icon: ScrollText },
    { label: "Payments", hint: "View recorded payments", href: "/billing/payments", icon: Wallet },
    { label: "Collections & Receivables", hint: "Track outstanding customer balances", href: "/billing/collections-receivables", icon: Landmark },
    { label: "Collections Dashboard", hint: "Monitor collection performance", href: "/billing/collections/dashboard", icon: BarChart3 },
  ], []);

  // Action Center — built only from the write-off stats endpoint already fetched.
  const writeOffActionItems = useMemo(() => {
    const items = [];
    if (kpis.pendingApprovalCount > 0) {
      items.push({
        icon: Clock, tone: "warning", priority: "high",
        title: `${kpis.pendingApprovalCount} write-off${kpis.pendingApprovalCount === 1 ? "" : "s"} awaiting approval`,
        description: "Needs review before execution",
        href: "/billing/write-offs?status=pending_approval",
      });
    }
    if (kpis.approvedCount > 0) {
      items.push({
        icon: CheckCircle, tone: "neutral", priority: "medium",
        title: `${kpis.approvedCount} approved write-off${kpis.approvedCount === 1 ? "" : "s"} ready to execute`,
        description: "Approved but not yet posted",
        href: "/billing/write-offs?status=approved",
      });
    }
    if (kpis.reversedCount > 0) {
      items.push({
        icon: Undo2, tone: "danger", priority: "low",
        title: `${kpis.reversedCount} write-off${kpis.reversedCount === 1 ? "" : "s"} reversed`,
        description: "Balance reinstated — needs review",
        href: "/billing/write-offs?status=reversed",
      });
    }
    return items;
  }, [kpis.pendingApprovalCount, kpis.approvedCount, kpis.reversedCount]);

  if (loading) {
    return (
      <div className="space-y-8" aria-label="Loading write-off dashboard">
        <DashboardHeader title="Write-off Dashboard" subtitle="Write-offs, approvals, and financial adjustment status" icon={ScrollText} iconGradient="from-amber-500 to-orange-500" crumbs={WRITE_OFF_CRUMBS} />
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
        <div className={DASHBOARD_CHART_GRID}>
          <SkeletonChart />
          <SkeletonChart />
        </div>
      </div>
    );
  }

  if (error && !dashboard.stats) {
    return (
      <div className="space-y-8">
        <DashboardHeader title="Write-off Dashboard" subtitle="Write-offs, approvals, and financial adjustment status" icon={ScrollText} iconGradient="from-amber-500 to-orange-500" crumbs={WRITE_OFF_CRUMBS} />
        <div className="flex flex-col items-center justify-center py-20">
          <div className="h-16 w-16 rounded-full bg-red-100 text-red-600 flex items-center justify-center mb-4">
            <AlertCircle size={32} />
          </div>
          <h3 className="text-xl font-bold text-slate-800 mb-2">Something went wrong</h3>
          <p className="text-slate-600 mb-6 text-center max-w-md">{error}</p>
          <button onClick={handleRefresh}
            className="px-6 py-3 bg-gradient-to-r from-amber-600 to-orange-600 text-white rounded-xl font-medium hover:shadow-lg transition-all flex items-center gap-2">
            <RefreshCw size={18} /> Try Again
          </button>
        </div>
      </div>
    );
  }

  const statusData = (dashboard.statusDist.length > 0
    ? dashboard.statusDist.map((s) => ({ name: (s.status || "").replace(/_/g, " "), value: s.count, color: STATUS_COLORS[s.status] || "#B45309" }))
    : []
  ).filter((s) => s.value > 0);

  const typeData = dashboard.typeDist.map((t) => ({
    name: (t.write_off_type || "").replace(/_/g, " "),
    count: t.count,
    value: t.total_amount,
  }));

  const sourceData = (dashboard.sourceDist || [])
    .map((s) => ({ name: (s.write_off_source || "unspecified").replace(/_/g, " "), value: s.count }))
    .filter((s) => s.value > 0);

  return (
    <div className="space-y-8">
      <DashboardHeader
        title="Write-off Dashboard"
        subtitle="Write-offs, approvals, and financial adjustment status across every source."
        icon={ScrollText}
        iconGradient="from-amber-500 to-orange-500"
        crumbs={WRITE_OFF_CRUMBS}
        lastUpdated={lastUpdated}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        onExportCSV={() => handleExport("csv")}
        onExportJSON={() => handleExport("json")}
        primaryAction={<Button variant="primary" icon={PlusCircle} onClick={() => navigate("/billing/write-offs")}>New Write-off</Button>}
      />

      <BusinessInsights items={insightItems} />

      <ActionCenter items={writeOffActionItems} />

      <div className={DASHBOARD_KPI_GRID}>
        <EnterpriseStatCard title="Total Write-offs" value={kpis.totalCount.toLocaleString()} icon={ScrollText} color={CARD_GRADIENTS[0]} href="/billing/write-offs" />
        <EnterpriseStatCard title="Pending Approval" value={kpis.pendingApprovalCount.toLocaleString()} icon={Clock} color={CARD_GRADIENTS[2]} href="/billing/write-offs?status=pending_approval" />
        <EnterpriseStatCard title="Executed" value={kpis.executedCount.toLocaleString()} icon={CheckCircle} color={CARD_GRADIENTS[1]} href="/billing/write-offs?status=executed" />
        <EnterpriseStatCard title="Reversed" value={kpis.reversedCount.toLocaleString()} icon={Undo2} color={CARD_GRADIENTS[4]} href="/billing/write-offs?status=reversed" />
      </div>

      <StatGroup title="More Metrics">
        <EnterpriseStatCard title="Total Value" value={Number(kpis.totalValue)} currency={baseCurrency} icon={Wallet} color={CARD_GRADIENTS[0]} sparkline={dashboard.monthlyTrend.map((m) => m.total_amount)} />
        <EnterpriseStatCard title="Executed Value" value={Number(kpis.executedValue)} currency={baseCurrency} icon={CheckCircle} color={CARD_GRADIENTS[1]} />
        <EnterpriseStatCard title="Outstanding (In Flight)" value={Number(kpis.outstandingValue)} currency={baseCurrency} icon={Clock} color={CARD_GRADIENTS[2]} />
        <EnterpriseStatCard title="Cancelled" value={kpis.cancelledCount.toLocaleString()} icon={Ban} color={CARD_GRADIENTS[4]} href="/billing/write-offs?status=cancelled" />
      </StatGroup>

      <QuickActions actions={writeOffQuickActions} />

      <div className={DASHBOARD_CHART_GRID}>
        <ChartCard title="Status Distribution">
          <ChartErrorBoundary aria-live="polite">
            {statusData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label>
                    {statusData.map((entry, i) => <Cell key={i} fill={entry.color || CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyStateWidget message="No status distribution data" icon={PieChartIcon} ctaText="New Write-off" onCtaClick={() => navigate("/billing/write-offs")} />
            )}
          </ChartErrorBoundary>
        </ChartCard>

        <ChartCard title="Write-off Type Distribution">
          <ChartErrorBoundary aria-live="polite">
            {typeData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={typeData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Bar dataKey="count" name="Count" fill="#B45309" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyStateWidget message="No type distribution data" icon={BarChart3} />
            )}
          </ChartErrorBoundary>
        </ChartCard>
      </div>

      <div className={DASHBOARD_CHART_GRID}>
        <ChartCard title="Write-off Source Distribution">
          <ChartErrorBoundary aria-live="polite">
            {sourceData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={sourceData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label>
                    {sourceData.map((entry, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyStateWidget message="No source distribution data" icon={PieChartIcon} />
            )}
          </ChartErrorBoundary>
        </ChartCard>

        <ChartCard title="Monthly Trend">
          <ChartErrorBoundary aria-live="polite">
            {dashboard.monthlyTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={dashboard.monthlyTrend}>
                  <defs>
                    <linearGradient id="writeOffTrendGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#B45309" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#B45309" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="total_amount" name="Total Amount" stroke="#B45309" strokeWidth={2} fill="url(#writeOffTrendGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyStateWidget message="No monthly trend data" icon={BarChart3} />
            )}
          </ChartErrorBoundary>
        </ChartCard>
      </div>
    </div>
  );
}
