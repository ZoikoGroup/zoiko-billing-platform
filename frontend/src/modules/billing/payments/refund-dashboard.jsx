import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Undo2, CheckCircle, AlertCircle, RefreshCw, Wallet, CreditCard, PlusCircle,
  BarChart3, PieChart as PieChartIcon, Ban, Clock, Send } from "lucide-react"
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { refundApi } from "../../../service/billingService";
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

const REFUND_CRUMBS = [{ label: "Billing", href: "/billing" }, { label: "Payments", href: "/billing/payments" }, { label: "Refunds" }];

const CHART_COLORS = ["#0EA5E9", "#10b981", "#f59e0b", "#ef4444", "#3b82f6", "#ec4899", "#FF9B4D", "#06b6d4"];
const CARD_GRADIENTS = [
  "from-sky-500 to-blue-500",
  "from-emerald-500 to-green-500",
  "from-amber-500 to-orange-500",
  "from-brand to-brand-hover",
  "from-red-500 to-rose-500",
  "from-indigo-500 to-blue-500",
];

const STATUS_COLORS = {
  draft: "#6b7280",
  pending_approval: "#f59e0b",
  approved: "#6366f1",
  processing: "#3b82f6",
  completed: "#10b981",
  failed: "#ef4444",
  rejected: "#dc2626",
  cancelled: "#94a3b8",
};

export default function RefundDashboard() {
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
    methodDist: [],
    monthlyTrend: [],
  });

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      if (!loadingRef.current) setRefreshing(true);

      const results = await Promise.allSettled([
        refundApi.getDashboardStats(),
        refundApi.getStatusDistribution(),
        refundApi.getTypeDistribution(),
        refundApi.getMethodDistribution(),
        refundApi.getMonthlyTrend(12),
      ]);
      const [statsRes, statusRes, typeRes, methodRes, trendRes] = results;
      const safeVal = (r, transform) => (r.status === "fulfilled" ? (transform ? transform(r.value) : r.value) : null);

      if (mountedRef.current) {
        setDashboard({
          stats: safeVal(statsRes),
          statusDist: safeVal(statusRes, extractArray) || [],
          typeDist: safeVal(typeRes, extractArray) || [],
          methodDist: safeVal(methodRes, extractArray) || [],
          monthlyTrend: safeVal(trendRes, extractArray) || [],
        });
        setLastUpdated(new Date());
      }
    } catch (err) {
      if (mountedRef.current) setError("Failed to load refund dashboard data.");
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
    const prefix = `refund-dashboard-${new Date().toISOString().split("T")[0]}`;
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
    completedValue: stats.completed_value || 0,
    outstandingValue: stats.outstanding_value || 0,
    pendingApprovalCount: stats.pending_approval_count || 0,
    approvedCount: stats.approved_count || 0,
    processingCount: stats.processing_count || 0,
    completedCount: stats.completed_count || 0,
    failedCount: stats.failed_count || 0,
    cancelledCount: stats.cancelled_count || 0,
  }), [stats]);

  const refundQuickActions = useMemo(() => [
    { label: "Refunds", hint: "Review and manage all refund requests", href: "/billing/refunds", icon: Undo2 },
    { label: "Pending Approvals", hint: "Refunds awaiting review", href: "/billing/refunds?status=pending_approval", icon: Clock },
    { label: "Payments", hint: "View incoming payments", href: "/billing/payments", icon: Wallet },
    { label: "Credits", hint: "Manage customer credit notes", href: "/billing/credits", icon: CreditCard },
  ], []);

  // Action Center — built only from the refund stats endpoint already fetched.
  const refundActionItems = useMemo(() => {
    const items = [];
    if (kpis.pendingApprovalCount > 0) {
      items.push({
        icon: Clock, tone: "warning", priority: "high",
        title: `${kpis.pendingApprovalCount} refund${kpis.pendingApprovalCount === 1 ? "" : "s"} awaiting approval`,
        description: "Needs review before processing",
        href: "/billing/refunds?status=pending_approval",
      });
    }
    if (kpis.processingCount > 0) {
      items.push({
        icon: Send, tone: "neutral", priority: "medium",
        title: `${kpis.processingCount} refund${kpis.processingCount === 1 ? "" : "s"} currently processing`,
        description: "In flight with the payment provider",
        href: "/billing/refunds?status=processing",
      });
    }
    if (kpis.failedCount + kpis.cancelledCount > 0) {
      items.push({
        icon: Ban, tone: "danger", priority: "low",
        title: `${kpis.failedCount + kpis.cancelledCount} refund${kpis.failedCount + kpis.cancelledCount === 1 ? "" : "s"} failed or cancelled`,
        description: "Needs follow-up or a re-issue",
        href: "/billing/refunds?status=failed",
      });
    }
    return items;
  }, [kpis.pendingApprovalCount, kpis.processingCount, kpis.failedCount, kpis.cancelledCount]);

  const insightItems = useMemo(() => {
    const items = [];
    if (kpis.pendingApprovalCount > 0) {
      items.push({ tone: "warning", icon: Clock, text: `${kpis.pendingApprovalCount} refund${kpis.pendingApprovalCount === 1 ? "" : "s"} awaiting approval` });
    }
    if (kpis.processingCount > 0) {
      items.push({ tone: "neutral", icon: Send, text: `${kpis.processingCount} refund${kpis.processingCount === 1 ? "" : "s"} currently processing` });
    }
    if (kpis.failedCount + kpis.cancelledCount > 0) {
      items.push({ tone: "down", icon: Ban, text: `${kpis.failedCount + kpis.cancelledCount} refund${kpis.failedCount + kpis.cancelledCount === 1 ? "" : "s"} failed or cancelled` });
    }
    if (kpis.outstandingValue > 0) {
      items.push({ tone: "neutral", icon: Wallet, text: `${formatDisplayCurrency(kpis.outstandingValue, "—", baseCurrency)} still in flight` });
    }
    if (!items.length) {
      items.push({ tone: "up", icon: CheckCircle, text: "All refunds are processed and up to date" });
    }
    return items;
  }, [kpis.pendingApprovalCount, kpis.processingCount, kpis.failedCount, kpis.cancelledCount, kpis.outstandingValue, baseCurrency]);

  if (loading) {
    return (
      <div className="space-y-8" aria-label="Loading refund dashboard">
        <DashboardHeader title="Refund Dashboard" subtitle="Refund requests, approvals, and processing status" icon={Undo2} iconGradient="from-sky-500 to-cyan-500" crumbs={REFUND_CRUMBS} />
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
        <DashboardHeader title="Refund Dashboard" subtitle="Refund requests, approvals, and processing status" icon={Undo2} iconGradient="from-sky-500 to-cyan-500" crumbs={REFUND_CRUMBS} />
        <div className="flex flex-col items-center justify-center py-20">
          <div className="h-16 w-16 rounded-full bg-red-100 text-red-600 flex items-center justify-center mb-4">
            <AlertCircle size={32} />
          </div>
          <h3 className="text-xl font-bold text-slate-800 mb-2">Something went wrong</h3>
          <p className="text-slate-600 mb-6 text-center max-w-md">{error}</p>
          <button onClick={handleRefresh}
            className="px-6 py-3 bg-gradient-to-r from-sky-600 to-blue-600 text-white rounded-xl font-medium hover:shadow-lg transition-all flex items-center gap-2">
            <RefreshCw size={18} /> Try Again
          </button>
        </div>
      </div>
    );
  }

  const statusData = (dashboard.statusDist.length > 0
    ? dashboard.statusDist.map((s) => ({ name: (s.status || "").replace(/_/g, " "), value: s.count, color: STATUS_COLORS[s.status] || "#0EA5E9" }))
    : []
  ).filter((s) => s.value > 0);

  const typeData = dashboard.typeDist.map((t) => ({
    name: (t.refund_type || "").replace(/_/g, " "),
    count: t.count,
    value: t.total_amount,
  }));

  const methodData = (dashboard.methodDist || [])
    .map((m) => ({ name: (m.refund_method || "unspecified").replace(/_/g, " "), value: m.count }))
    .filter((m) => m.value > 0);

  return (
    <div className="space-y-8">
      <DashboardHeader
        title="Refund Dashboard"
        subtitle="Refund requests, approvals, and processing status across every source."
        icon={Undo2}
        iconGradient="from-sky-500 to-cyan-500"
        crumbs={REFUND_CRUMBS}
        lastUpdated={lastUpdated}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        onExportCSV={() => handleExport("csv")}
        onExportJSON={() => handleExport("json")}
        primaryAction={<Button variant="primary" icon={PlusCircle} onClick={() => navigate("/billing/refunds")}>New Refund</Button>}
      />

      <BusinessInsights items={insightItems} />

      <ActionCenter items={refundActionItems} />

      <div className={DASHBOARD_KPI_GRID}>
        <EnterpriseStatCard title="Total Refunds" value={kpis.totalCount.toLocaleString()} icon={Undo2} color={CARD_GRADIENTS[0]} href="/billing/refunds" />
        <EnterpriseStatCard title="Pending Approval" value={kpis.pendingApprovalCount.toLocaleString()} icon={Clock} color={CARD_GRADIENTS[2]} href="/billing/refunds?status=pending_approval" />
        <EnterpriseStatCard title="Processing" value={kpis.processingCount.toLocaleString()} icon={Send} color={CARD_GRADIENTS[3]} href="/billing/refunds?status=processing" />
        <EnterpriseStatCard title="Completed" value={kpis.completedCount.toLocaleString()} icon={CheckCircle} color={CARD_GRADIENTS[1]} href="/billing/refunds?status=completed" />
      </div>

      <StatGroup title="More Metrics">
        <EnterpriseStatCard title="Total Value" value={Number(kpis.totalValue)} currency={baseCurrency} icon={Wallet} color={CARD_GRADIENTS[0]} sparkline={dashboard.monthlyTrend.map((m) => m.total_amount)} />
        <EnterpriseStatCard title="Completed Value" value={Number(kpis.completedValue)} currency={baseCurrency} icon={CheckCircle} color={CARD_GRADIENTS[1]} />
        <EnterpriseStatCard title="Outstanding (In Flight)" value={Number(kpis.outstandingValue)} currency={baseCurrency} icon={Clock} color={CARD_GRADIENTS[2]} />
        <EnterpriseStatCard title="Failed / Cancelled" value={(kpis.failedCount + kpis.cancelledCount).toLocaleString()} icon={Ban} color={CARD_GRADIENTS[4]} href="/billing/refunds?status=failed" />
      </StatGroup>

      <QuickActions actions={refundQuickActions} />

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
              <EmptyStateWidget message="No status distribution data" icon={PieChartIcon} ctaText="New Refund" onCtaClick={() => navigate("/billing/refunds")} />
            )}
          </ChartErrorBoundary>
        </ChartCard>

        <ChartCard title="Refund Type Distribution">
          <ChartErrorBoundary aria-live="polite">
            {typeData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={typeData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Bar dataKey="count" name="Count" fill="#0EA5E9" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyStateWidget message="No type distribution data" icon={BarChart3} />
            )}
          </ChartErrorBoundary>
        </ChartCard>
      </div>

      <div className={DASHBOARD_CHART_GRID}>
        <ChartCard title="Refund Method Distribution">
          <ChartErrorBoundary aria-live="polite">
            {methodData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={methodData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label>
                    {methodData.map((entry, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyStateWidget message="No method distribution data" icon={PieChartIcon} />
            )}
          </ChartErrorBoundary>
        </ChartCard>

        <ChartCard title="Monthly Trend">
          <ChartErrorBoundary aria-live="polite">
            {dashboard.monthlyTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={dashboard.monthlyTrend}>
                  <defs>
                    <linearGradient id="refundTrendGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0EA5E9" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#0EA5E9" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="total_amount" name="Total Amount" stroke="#0EA5E9" strokeWidth={2} fill="url(#refundTrendGrad)" />
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
