import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  CreditCard, CheckCircle, Clock, XCircle, Wallet, TrendingUp, RefreshCw,
  AlertCircle, BarChart3, PieChart as PieChartIcon, Layers, Receipt, Eye,
  Landmark, AlertTriangle, PlusCircle,
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { paymentApi } from "../../../service/billingService";
import { extractArray, formatDisplayCurrency, formatDisplayDate } from "../../../utils/billing-helpers";
import { sumInBaseCurrency } from "../../../utils/currency-conversion";
import { useCurrency } from "../utils/CurrencyContext";
import {
  DashboardHeader, DashboardStatCard as StatCard, DashboardChartCard as ChartCard,
  DashboardEmptyPanel as EmptyStateWidget, DashboardStatCardSkeleton as SkeletonCard,
  DashboardChartCardSkeleton as SkeletonChart, DashboardChartErrorBoundary as ChartErrorBoundary,
  StatusBadge, DASHBOARD_KPI_GRID, DASHBOARD_CHART_GRID, exportDashboardToCsv, exportDashboardToJson,
  BusinessInsights, QuickActions, ActionCenter,
} from "../../../components/billing-shared";
import { Button, DataTable, StatGroup } from "../../../components/billing-ui";

// A single, wide fetch of recent payments doubles as the source for the
// status/method/monthly aggregates below — there is no dedicated payments
// stats endpoint (unlike refunds/write-offs/dunning/collections), so this
// dashboard aggregates client-side over the most recent window instead.
const AGGREGATION_WINDOW = 300;

const CARD_GRADIENTS = [
  "from-brand to-brand-hover",
  "from-emerald-500 to-green-500",
  "from-amber-500 to-orange-500",
  "from-red-500 to-rose-500",
  "from-blue-500 to-cyan-500",
  "from-indigo-500 to-blue-500",
];

const STATUS_OPTIONS = [
  { value: "cleared", label: "Cleared", color: "bg-emerald-100 text-emerald-700" },
  { value: "pending", label: "Pending", color: "bg-amber-100 text-amber-700" },
  { value: "processing", label: "Processing", color: "bg-sky-100 text-sky-700" },
  { value: "failed", label: "Failed", color: "bg-red-100 text-red-700" },
  { value: "refunded", label: "Refunded", color: "bg-blue-100 text-blue-700" },
  { value: "cancelled", label: "Cancelled", color: "bg-slate-100 text-slate-700" },
];

const STATUS_COLORS = {
  cleared: "#10b981",
  pending: "#f59e0b",
  processing: "#0ea5e9",
  failed: "#ef4444",
  refunded: "#3b82f6",
  cancelled: "#94a3b8",
};

const CHART_COLORS = ["var(--color-accent-payments)", "#0EA5E9", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#6366f1"];

export default function PaymentDashboardPage() {
  const navigate = useNavigate();
  const { baseCurrency } = useCurrency();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const mountedRef = useRef(true);
  const loadingRef = useRef(true);

  const [dashboard, setDashboard] = useState({
    totalCollected: null,
    payments: [],
    paymentsTotal: 0,
    unallocated: [],
    unallocatedTotal: 0,
  });

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      if (!loadingRef.current) setRefreshing(true);

      const results = await Promise.allSettled([
        paymentApi.getTotalCollected(),
        paymentApi.list({ per_page: AGGREGATION_WINDOW, sort_by: "payment_date", sort_order: "desc" }),
        paymentApi.listUnallocated({ per_page: 50 }),
      ]);
      const [totalCollectedRes, listRes, unallocatedRes] = results;
      const safeVal = (r, transform) => (r.status === "fulfilled" ? (transform ? transform(r.value) : r.value) : null);

      const listData = safeVal(listRes);
      const unallocatedData = safeVal(unallocatedRes);

      if (mountedRef.current) {
        setDashboard({
          totalCollected: safeVal(totalCollectedRes),
          payments: extractArray(listData) || [],
          paymentsTotal: listData?.total ?? extractArray(listData).length,
          unallocated: extractArray(unallocatedData) || [],
          unallocatedTotal: unallocatedData?.total ?? extractArray(unallocatedData).length,
        });
        setLastUpdated(new Date());
      }
    } catch (err) {
      if (mountedRef.current) setError("Failed to load payment dashboard data.");
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
    const prefix = `payment-dashboard-${new Date().toISOString().split("T")[0]}`;
    if (format === "csv") {
      exportDashboardToCsv({
        total_collected: dashboard.totalCollected?.total_collected,
        payments_total: dashboard.paymentsTotal,
        unallocated_total: dashboard.unallocatedTotal,
      }, prefix);
    } else if (format === "json") {
      exportDashboardToJson(dashboard, prefix);
    }
  }, [dashboard]);

  const payments = dashboard.payments;

  const kpis = useMemo(() => {
    const byStatus = (status) => payments.filter((p) => p.status === status);
    const cleared = byStatus("cleared");
    const pending = byStatus("pending");
    const failed = byStatus("failed");
    const clearedAmount = sumInBaseCurrency(cleared, baseCurrency).total;
    const pendingAmount = sumInBaseCurrency(pending, baseCurrency).total;
    const unallocatedAmount = sumInBaseCurrency(dashboard.unallocated, baseCurrency).total;
    return {
      totalCollected: dashboard.totalCollected?.total_collected ?? clearedAmount,
      totalCount: dashboard.paymentsTotal,
      clearedCount: cleared.length,
      pendingCount: pending.length,
      failedCount: failed.length,
      clearedAmount,
      pendingAmount,
      unallocatedAmount,
      unallocatedCount: dashboard.unallocatedTotal,
      avgPaymentValue: payments.length > 0 ? clearedAmount / Math.max(cleared.length, 1) : 0,
    };
  }, [payments, dashboard.totalCollected, dashboard.paymentsTotal, dashboard.unallocated, dashboard.unallocatedTotal, baseCurrency]);

  const statusData = useMemo(() => {
    const counts = {};
    payments.forEach((p) => { counts[p.status] = (counts[p.status] || 0) + 1; });
    return Object.entries(counts)
      .map(([status, value]) => ({ name: STATUS_OPTIONS.find((o) => o.value === status)?.label || status, value, color: STATUS_COLORS[status] || "var(--color-accent-payments)" }))
      .filter((d) => d.value > 0);
  }, [payments]);

  const methodData = useMemo(() => {
    const counts = {};
    payments.forEach((p) => {
      const key = (p.payment_type || p.payment_method || "other").replace(/_/g, " ");
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts).map(([name, value]) => ({ name, value }));
  }, [payments]);

  const monthlyTrend = useMemo(() => {
    const groups = {};
    payments.forEach((p) => {
      if (!p.payment_date) return;
      const d = new Date(p.payment_date);
      if (Number.isNaN(d.getTime())) return;
      const key = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      const sortKey = `${d.getFullYear()}${String(d.getMonth()).padStart(2, "0")}`;
      if (!groups[key]) groups[key] = { month: key, sortKey, amount: 0, count: 0 };
      groups[key].amount += parseFloat(p.amount || 0);
      groups[key].count += 1;
    });
    return Object.values(groups).sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }, [payments]);

  const recentPayments = useMemo(() => payments.slice(0, 10), [payments]);

  // Action Center — what needs attention right now, built only from the
  // status aggregates already computed above (pending/failed/unallocated).
  const paymentActionItems = useMemo(() => {
    const items = [];
    if (kpis.failedCount > 0) {
      items.push({
        icon: XCircle, tone: "danger", priority: "high",
        title: `${kpis.failedCount} failed payment${kpis.failedCount === 1 ? "" : "s"}`,
        description: "Needs review or a retry",
        href: "/billing/payments?status=failed",
      });
    }
    if (kpis.pendingCount > 0) {
      items.push({
        icon: Clock, tone: "warning", priority: "medium",
        title: `${kpis.pendingCount} pending payment${kpis.pendingCount === 1 ? "" : "s"}`,
        description: formatDisplayCurrency(kpis.pendingAmount, baseCurrency),
        href: "/billing/payments?status=pending",
      });
    }
    if (kpis.unallocatedCount > 0) {
      items.push({
        icon: Layers, tone: "neutral", priority: "low",
        title: `${kpis.unallocatedCount} payment${kpis.unallocatedCount === 1 ? "" : "s"} awaiting allocation`,
        description: formatDisplayCurrency(kpis.unallocatedAmount, baseCurrency),
        href: "/billing/payments",
      });
    }
    return items;
  }, [kpis.failedCount, kpis.pendingCount, kpis.pendingAmount, kpis.unallocatedCount, kpis.unallocatedAmount, baseCurrency]);

  const paymentQuickActions = useMemo(() => [
    { label: "Record Payment", hint: "Log an incoming payment", href: "/billing/payments", icon: Wallet },
    { label: "Collections", hint: "Chase overdue balances", href: "/billing/collections/dashboard", icon: Landmark },
    { label: "Refunds", hint: "Issue or review refunds", href: "/billing/refunds", icon: RefreshCw },
    { label: "Write-offs", hint: "Manage uncollectible balances", href: "/billing/write-offs", icon: AlertTriangle },
  ], []);

  const insightItems = useMemo(() => {
    const items = [];
    if (kpis.pendingCount > 0) {
      items.push({ tone: "warning", icon: Clock, text: `${kpis.pendingCount} payment${kpis.pendingCount === 1 ? "" : "s"} pending clearance` });
    }
    if (kpis.failedCount > 0) {
      items.push({ tone: "down", icon: XCircle, text: `${kpis.failedCount} payment${kpis.failedCount === 1 ? "" : "s"} failed` });
    }
    if (kpis.unallocatedCount > 0) {
      items.push({ tone: "neutral", icon: Layers, text: `${kpis.unallocatedCount} payment${kpis.unallocatedCount === 1 ? "" : "s"} awaiting allocation` });
    }
    if (!items.length) {
      items.push({ tone: "up", icon: CheckCircle, text: "All payments cleared and fully allocated" });
    }
    return items;
  }, [kpis.pendingCount, kpis.failedCount, kpis.unallocatedCount]);

  const recentPaymentColumns = useMemo(() => [
    { key: "payment_number", label: "Payment", render: (p) => (
      <span className="flex items-center gap-2 font-medium text-slate-700"><Receipt size={14} className="text-slate-500" />{p.payment_number || `#${p.id}`}</span>
    ) },
    { key: "customer", label: "Customer", render: (p) => p.customer_name || p.customer?.name || `Customer #${p.customer_id}` },
    { key: "amount", label: "Amount", render: (p) => <span className="font-medium text-slate-800">{formatDisplayCurrency(p.amount, p.currency)}</span> },
    { key: "method", label: "Method", render: (p) => <span className="text-xs capitalize">{(p.payment_type || p.payment_method || "—").replace(/_/g, " ")}</span> },
    { key: "status", label: "Status", render: (p) => <StatusBadge status={p.status} options={STATUS_OPTIONS} /> },
    { key: "payment_date", label: "Date", render: (p) => <span className="text-xs text-slate-500">{formatDisplayDate(p.payment_date)}</span> },
    { key: "view", label: "", align: "right", render: (p) => (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/billing/payments/${p.id}`); }}
        className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-brand-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
        aria-label={`View payment ${p.payment_number || p.id}`}>
        <Eye size={16} />
      </button>
    ) },
  ], [navigate]);

  const unallocatedColumns = useMemo(() => [
    { key: "payment_number", label: "Payment", render: (p) => <span className="font-medium text-slate-700">{p.payment_number || `#${p.id}`}</span> },
    { key: "customer", label: "Customer", render: (p) => <span className="truncate">{p.customer_name || p.customer?.name || `Customer #${p.customer_id}`}</span> },
    { key: "unallocated_amount", label: "Unallocated", align: "right", render: (p) => (
      <span className="font-medium text-amber-600">{formatDisplayCurrency(p.unallocated_amount ?? p.amount, p.currency)}</span>
    ) },
  ], []);

  if (loading) {
    return (
      <div className="space-y-8" aria-label="Loading payment dashboard">
        <DashboardHeader title="Payment Dashboard" subtitle="Collections, allocation health, and payment activity at a glance" icon={CreditCard} iconGradient="from-brand to-brand-hover" crumbs={[{ label: "Billing", href: "/billing" }, { label: "Payments" }]} />
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={`b-${i}`} />)}
        </div>
        <div className={DASHBOARD_CHART_GRID}>
          <SkeletonChart />
          <SkeletonChart />
        </div>
      </div>
    );
  }

  if (error && !dashboard.totalCollected && payments.length === 0) {
    return (
      <div className="space-y-8">
        <DashboardHeader title="Payment Dashboard" subtitle="Collections, allocation health, and payment activity at a glance" icon={CreditCard} iconGradient="from-brand to-brand-hover" crumbs={[{ label: "Billing", href: "/billing" }, { label: "Payments" }]} />
        <div className="flex flex-col items-center justify-center py-20">
          <div className="h-16 w-16 rounded-full bg-red-100 text-red-600 flex items-center justify-center mb-4">
            <AlertCircle size={32} />
          </div>
          <h3 className="text-xl font-bold text-slate-800 mb-2">Something went wrong</h3>
          <p className="text-slate-600 mb-6 text-center max-w-md">{error}</p>
          <button onClick={handleRefresh}
            className="px-6 py-3 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl font-medium hover:shadow-lg transition-all flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
            <RefreshCw size={18} /> Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <DashboardHeader
        title="Payment Dashboard"
        subtitle="Collections, allocation health, and payment activity at a glance."
        icon={CreditCard}
        iconGradient="from-brand to-brand-hover"
        crumbs={[{ label: "Billing", href: "/billing" }, { label: "Payments" }]}
        lastUpdated={lastUpdated}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        onExportCSV={() => handleExport("csv")}
        onExportJSON={() => handleExport("json")}
        primaryAction={<Button variant="primary" icon={PlusCircle} onClick={() => navigate("/billing/payments")}>Record Payment</Button>}
      />

      <BusinessInsights items={insightItems} />

      <ActionCenter items={paymentActionItems} />

      <div className={DASHBOARD_KPI_GRID}>
        <StatCard title="Total Collected" value={Number(kpis.totalCollected)} currency={baseCurrency} icon={Wallet} color={CARD_GRADIENTS[0]} href="/billing/payments" sparkline={monthlyTrend.map((m) => m.amount)} />
        <StatCard title="Total Payments" value={kpis.totalCount.toLocaleString()} icon={CreditCard} color={CARD_GRADIENTS[1]} href="/billing/payments" />
        <StatCard title="Pending" value={kpis.pendingCount.toLocaleString()} icon={Clock} color={CARD_GRADIENTS[2]} subtitle={formatDisplayCurrency(kpis.pendingAmount, baseCurrency)} href="/billing/payments?status=pending" />
        <StatCard title="Failed" value={kpis.failedCount.toLocaleString()} icon={XCircle} color={CARD_GRADIENTS[3]} href="/billing/payments?status=failed" />
      </div>
      <p className="-mt-4 text-xs text-slate-400">
        Aggregated from the {AGGREGATION_WINDOW} most recent payments.
      </p>

      <StatGroup title="More Metrics">
        <StatCard title="Cleared Amount" value={Number(kpis.clearedAmount)} currency={baseCurrency} icon={CheckCircle} color={CARD_GRADIENTS[1]} />
        <StatCard title="Avg Payment Value" value={Number(kpis.avgPaymentValue)} currency={baseCurrency} icon={TrendingUp} color={CARD_GRADIENTS[4]} />
        <StatCard title="Unallocated Amount" value={Number(kpis.unallocatedAmount)} currency={baseCurrency} icon={Layers} color={CARD_GRADIENTS[2]} subtitle={`${kpis.unallocatedCount} payment(s)`} href="/billing/payments" />
        <StatCard title="Unallocated Count" value={kpis.unallocatedCount.toLocaleString()} icon={AlertCircle} color={CARD_GRADIENTS[5]} href="/billing/payments" />
      </StatGroup>

      <QuickActions actions={paymentQuickActions} />

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
              <EmptyStateWidget message="No status distribution data" icon={PieChartIcon} />
            )}
          </ChartErrorBoundary>
        </ChartCard>

        <ChartCard title="Monthly Trend">
          <ChartErrorBoundary aria-live="polite">
            {monthlyTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={monthlyTrend}>
                  <defs>
                    <linearGradient id="paymentTrendGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--color-accent-payments)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--color-accent-payments)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(v) => formatDisplayCurrency(v, baseCurrency)} />
                  <Area type="monotone" dataKey="amount" name="Payment Volume" stroke="var(--color-accent-payments)" strokeWidth={2} fill="url(#paymentTrendGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyStateWidget message="No monthly trend data" icon={BarChart3} />
            )}
          </ChartErrorBoundary>
        </ChartCard>
      </div>

      <div className={DASHBOARD_CHART_GRID}>
        <ChartCard title="Payment Method Distribution">
          <ChartErrorBoundary aria-live="polite">
            {methodData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={methodData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} angle={-20} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="value" name="Payments" radius={[4, 4, 0, 0]}>
                    {methodData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <EmptyStateWidget message="No payment method data" icon={BarChart3} />
            )}
          </ChartErrorBoundary>
        </ChartCard>

        <ChartCard title="Unallocated Payments" action={<button onClick={() => navigate("/billing/payments")} className="text-sm font-medium text-brand hover:text-brand-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 rounded">View All</button>}>
          <DataTable
            columns={unallocatedColumns}
            data={dashboard.unallocated.slice(0, 8)}
            rowKey={(row, idx) => row.id ?? idx}
            onRowClick={(row) => navigate(`/billing/payments/${row.id}`)}
            stickyHeader={false}
            emptyTitle="Fully allocated"
            emptyMessage="Every payment is fully allocated to invoices right now."
            emptyIcon={CheckCircle}
          />
        </ChartCard>
      </div>

      <ChartCard title="Recent Activity" action={<button onClick={() => navigate("/billing/payments")} className="text-sm font-medium text-brand hover:text-brand-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 rounded">View All</button>}>
        <DataTable
          columns={recentPaymentColumns}
          data={recentPayments}
          rowKey={(row) => row.id}
          onRowClick={(row) => navigate(`/billing/payments/${row.id}`)}
          stickyHeader={false}
          emptyTitle="No payments yet"
          emptyMessage="Recorded payments will show up here."
          emptyIcon={CreditCard}
          emptyAction={<Button variant="primary" icon={PlusCircle} onClick={() => navigate("/billing/payments")}>Record Payment</Button>}
        />
      </ChartCard>
    </div>
  );
}
