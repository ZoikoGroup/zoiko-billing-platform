import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  FileText, Clock, AlertCircle,
  CheckCircle, RefreshCw, DollarSign, Activity,
  BarChart3, Wallet, ChevronRight, Send, Ban, Calendar, TrendingUp, TrendingDown,
  PieChart as PieChartIcon, Users, Receipt, PlusCircle, Settings, FileClock
} from "lucide-react";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area
} from "recharts";
import { invoiceApi } from "../../../service/billingService";
import { extractArray, formatDisplayCurrency, formatDisplayDate, formatCompactCurrency } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { useBillingDateRange } from "../utils/DateRangeContext";
import {
  DashboardHeader, DashboardStatCard as EnterpriseStatCard, DashboardChartCard as ChartCard,
  DashboardEmptyPanel as EmptyStateWidget, DashboardStatCardSkeleton as SkeletonCard,
  DashboardChartCardSkeleton as SkeletonChart, DashboardChartErrorBoundary as ChartErrorBoundary,
  DASHBOARD_KPI_GRID, DASHBOARD_CHART_GRID, DASHBOARD_CHART_GRID_3, exportDashboardToCsv, exportDashboardToJson,
  BusinessInsights, QuickActions, ActionCenter,
} from "../../../components/billing-shared";
import { Button, StatGroup } from "../../../components/billing-ui";

const CHART_COLORS = ["#FF7A00", "#FB923C", "#FDBA74", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4899"];
const CARD_GRADIENTS = [
  "from-brand to-brand-hover",
  "from-emerald-500 to-green-500",
  "from-amber-500 to-orange-500",
  "from-blue-500 to-cyan-500",
  "from-red-500 to-rose-500",
  "from-pink-500 to-rose-500",
  "from-indigo-500 to-blue-500",
  "from-teal-500 to-green-500",
];

export default function InvoiceDashboard() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const {
    range: dateRangeValue, setRange: setDateRangeValue,
    customStart, customEnd, applyCustomRange, reset: resetDateRange,
    dateRange,
  } = useBillingDateRange();
  const { baseCurrency, currencySymbol } = useCurrency();
  const mountedRef = useRef(true);
  const loadingRef = useRef(true);

  const [dashboard, setDashboard] = useState({
    stats: null,
    invoiceTrend: [],
    revenueTrend: [],
    collectionTrend: [],
    statusDist: [],
    monthlyRevenue: [],
    recentActivity: [],
    overdueInvoices: [],
    invoicesForCustomers: [],
  });

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      if (!loadingRef.current) setRefreshing(true);

      const results = await Promise.allSettled([
        invoiceApi.getEnterpriseDashboard(dateRange),
        invoiceApi.getInvoiceTrend(12),
        invoiceApi.getRevenueTrend(12),
        invoiceApi.getPaymentCollectionTrend(12),
        invoiceApi.getStatusDistribution(),
        invoiceApi.getMonthlyRevenue(12),
        invoiceApi.getRecentActivity(10),
        invoiceApi.list({ per_page: 5, status: "overdue", date_from: dateRange.date_from, date_to: dateRange.date_to }),
        // No dedicated "top customers" endpoint exists on invoiceApi — the Top
        // Customers panel below is aggregated client-side from this list call
        // (same data source invoice-list.jsx already uses) rather than inventing
        // a new backend endpoint.
        invoiceApi.list({ per_page: 200, date_from: dateRange.date_from, date_to: dateRange.date_to, sort_by: "total_amount", sort_order: "desc" }),
      ]);

      const [statsRes, trendRes, revRes, collRes, distRes, monthlyRes, activityRes, overdueRes, customersRes] = results;
      const safeVal = (r, transform) => r.status === "fulfilled" ? (transform ? transform(r.value) : r.value) : null;

      if (mountedRef.current) {
        setDashboard({
          stats: safeVal(statsRes),
          invoiceTrend: safeVal(trendRes, extractArray) || [],
          revenueTrend: safeVal(revRes, extractArray) || [],
          collectionTrend: safeVal(collRes, extractArray) || [],
          statusDist: safeVal(distRes, extractArray) || [],
          monthlyRevenue: safeVal(monthlyRes, extractArray) || [],
          recentActivity: safeVal(activityRes, extractArray) || [],
          overdueInvoices: safeVal(overdueRes, (v) => v?.items || extractArray(v)) || [],
          invoicesForCustomers: safeVal(customersRes, extractArray) || [],
        });
        setLastUpdated(new Date());
      }
    } catch (err) {
      if (mountedRef.current) setError("Failed to load invoice dashboard data.");
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
        loadingRef.current = false;
      }
    }
  }, [dateRange.date_from, dateRange.date_to]);

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
    const prefix = `invoice-dashboard-${new Date().toISOString().split("T")[0]}`;
    if (format === "csv") {
      exportDashboardToCsv({ ...(dashboard.stats || {}), date_from: dateRange.date_from, date_to: dateRange.date_to }, prefix);
    } else if (format === "json") {
      exportDashboardToJson({ ...dashboard, dateRange }, prefix);
    }
  }, [dashboard, dateRange]);

  const d = dashboard;
  const stats = d.stats || {};

  const kpis = useMemo(() => ({
    totalInvoices: stats.total_invoices || 0,
    draft: stats.status_counts?.draft || 0,
    sent: stats.status_counts?.sent || 0,
    paid: stats.status_counts?.paid || 0,
    overdue: stats.status_counts?.overdue || 0,
    cancelled: stats.status_counts?.cancelled || 0,
    partiallyPaid: stats.status_counts?.partially_paid || 0,
    refunded: stats.status_counts?.refunded || 0,
    totalRevenue: stats.total_amount || 0,
    outstandingAmount: stats.outstanding_amount || 0,
    collectedAmount: stats.collected_amount || 0,
    overdueAmount: stats.overdue_amount || 0,
    thisMonthRevenue: stats.this_month_revenue || 0,
    avgPaymentDays: stats.average_payment_days || 0,
    avgInvoiceValue: stats.total_invoices > 0 ? (stats.total_amount || 0) / stats.total_invoices : 0,
    collectionRate: stats.collection_rate || 0,
    totalTaxCollected: stats.total_tax_collected || 0,
  }), [stats]);

  // Top Customers — no dedicated backend endpoint for this exists yet, so it's
  // derived client-side from the same invoice list data invoice-list.jsx uses,
  // grouped by customer and sorted by total billed amount.
  const topCustomers = useMemo(() => {
    const grouped = new Map();
    for (const inv of d.invoicesForCustomers) {
      const key = inv.customer_id ?? inv.customer_name ?? "unknown";
      const name = inv.customer_name || inv.customer?.name || (inv.customer_id ? `Customer #${inv.customer_id}` : "Unknown");
      const amount = Number(inv.total_amount ?? inv.total ?? inv.amount ?? 0);
      const existing = grouped.get(key);
      if (existing) {
        existing.total += amount;
        existing.count += 1;
      } else {
        grouped.set(key, { id: key, name, total: amount, count: 1 });
      }
    }
    return Array.from(grouped.values()).sort((a, b) => b.total - a.total).slice(0, 5);
  }, [d.invoicesForCustomers]);

  const invoiceQuickActions = useMemo(() => [
    { label: "Create Invoice", hint: "Bill a customer", href: "/billing/invoices/create", icon: PlusCircle },
    { label: "Invoice Schedules", hint: "Manage recurring billing", href: "/billing/invoice-schedules", icon: Calendar },
    { label: "Reports", hint: "Invoicing analytics", href: "/billing/invoicing/reports", icon: BarChart3 },
    { label: "Settings", hint: "Invoicing preferences", href: "/billing/invoices/settings", icon: Settings },
  ], []);

  const insightItems = useMemo(() => {
    const items = [];
    if (kpis.overdue > 0) {
      items.push({
        tone: "down", icon: AlertCircle,
        text: `${kpis.overdue.toLocaleString()} invoice${kpis.overdue === 1 ? "" : "s"} overdue — ${formatDisplayCurrency(kpis.overdueAmount, "—", baseCurrency)}`,
      });
    }
    if (kpis.draft > 0) {
      items.push({ tone: "warning", icon: FileClock, text: `${kpis.draft.toLocaleString()} invoice${kpis.draft === 1 ? "" : "s"} still in draft` });
    }
    if (kpis.collectionRate > 0) {
      items.push({
        tone: kpis.collectionRate >= 80 ? "up" : "neutral",
        icon: Activity,
        text: `${kpis.collectionRate}% collection rate`,
      });
    }
    if (!items.length) {
      items.push({ tone: "up", icon: CheckCircle, text: "All invoices current — nothing overdue or in draft" });
    }
    return items;
  }, [kpis.overdue, kpis.overdueAmount, kpis.draft, kpis.collectionRate, baseCurrency]);

  // stats.status_counts.overdue reflects the full org-wide overdue count,
  // whereas d.overdueInvoices only holds the 5 records fetched for the panel
  // below — use the full count here so the Action Center row doesn't undercount.
  const actionItems = useMemo(() => {
    const items = [];
    if (kpis.overdue > 0) {
      items.push({
        icon: AlertCircle, tone: "danger", priority: "high",
        title: `${kpis.overdue.toLocaleString()} invoice${kpis.overdue === 1 ? "" : "s"} overdue`,
        description: formatDisplayCurrency(kpis.overdueAmount, "—", baseCurrency),
        href: "/billing/invoices?status=overdue",
      });
    }
    if (kpis.partiallyPaid > 0) {
      items.push({
        icon: Activity, tone: "warning", priority: "medium",
        title: `${kpis.partiallyPaid.toLocaleString()} invoice${kpis.partiallyPaid === 1 ? "" : "s"} partially paid`,
        description: "Balance remains on each invoice",
        href: "/billing/invoices?status=partially_paid",
      });
    }
    if (kpis.draft > 0) {
      items.push({
        icon: Clock, tone: "neutral", priority: "low",
        title: `${kpis.draft.toLocaleString()} draft invoice${kpis.draft === 1 ? "" : "s"}`,
        description: "Created but not yet sent",
        href: "/billing/invoices?status=draft",
      });
    }
    return items;
  }, [kpis.overdue, kpis.overdueAmount, kpis.partiallyPaid, kpis.draft, baseCurrency]);

  if (loading) {
    return (
      <div className="space-y-8 px-4 py-6 sm:px-6" aria-label="Loading invoice dashboard">
        <DashboardHeader title="Invoice Dashboard" subtitle="Enterprise invoicing overview" icon={FileText} iconGradient="from-[#FF7A00] to-[#FF5500]" crumbs={[{ label: "Billing", href: "/billing" }, { label: "Invoicing" }]} />
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
        <div className={DASHBOARD_CHART_GRID}>
          <SkeletonChart />
          <SkeletonChart />
        </div>
        <div className={DASHBOARD_CHART_GRID}>
          <SkeletonChart />
          <SkeletonChart />
        </div>
      </div>
    );
  }

  if (error && !d.stats) {
    return (
      <div className="space-y-8 px-4 py-6 sm:px-6">
        <DashboardHeader title="Invoice Dashboard" subtitle="Enterprise invoicing overview" icon={FileText} iconGradient="from-[#FF7A00] to-[#FF5500]" crumbs={[{ label: "Billing", href: "/billing" }, { label: "Invoicing" }]} />
        <div className="flex flex-col items-center justify-center py-20">
          <div className="h-16 w-16 rounded-full bg-red-100 text-red-600 flex items-center justify-center mb-4">
            <AlertCircle size={32} />
          </div>
          <h3 className="text-xl font-bold text-slate-800 mb-2">Something went wrong</h3>
          <p className="text-slate-600 mb-6 text-center max-w-md">{error}</p>
          <button onClick={handleRefresh}
            className="px-6 py-3 bg-gradient-to-r from-[#FF7A00] to-[#FF5500] text-white rounded-xl font-medium hover:shadow-lg transition-all flex items-center gap-2">
            <RefreshCw size={18} /> Try Again
          </button>
        </div>
      </div>
    );
  }

  const statusData = d.statusDist.length > 0 ? d.statusDist : [
    { name: "Draft", value: kpis.draft, color: "#6b7280" },
    { name: "Sent", value: kpis.sent, color: "#3b82f6" },
    { name: "Paid", value: kpis.paid, color: "#10b981" },
    { name: "Overdue", value: kpis.overdue, color: "#ef4444" },
  ].filter((s) => s.value > 0);

  return (
    <div className="space-y-8 px-4 py-6 sm:px-6">
      <DashboardHeader
        title="Invoice Dashboard"
        subtitle="Track invoices, payments, and collections in real-time."
        icon={FileText}
        iconGradient="from-[#FF7A00] to-[#FF5500]"
        crumbs={[{ label: "Billing", href: "/billing" }, { label: "Invoicing" }]}
        lastUpdated={lastUpdated}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        onExportCSV={() => handleExport("csv")}
        onExportJSON={() => handleExport("json")}
        dateRange={dateRangeValue}
        onDateRangeChange={setDateRangeValue}
        customStart={customStart}
        customEnd={customEnd}
        onApplyCustomRange={applyCustomRange}
        onResetDateRange={resetDateRange}
        primaryAction={<Button variant="primary" icon={PlusCircle} onClick={() => navigate("/billing/invoices/create")}>Create Invoice</Button>}
      />

      <BusinessInsights items={insightItems} />

      <ActionCenter items={actionItems} />

      {/* Headline financials \u2014 mirrors the Revenue / Outstanding / Paid / Overdue
          set required across every Billing dashboard. */}
      <div className={DASHBOARD_KPI_GRID}>
        <EnterpriseStatCard title="Revenue" value={Number(kpis.totalRevenue)} currency={baseCurrency} icon={DollarSign} color={CARD_GRADIENTS[0]} href="/billing/invoicing/reports" sparkline={d.revenueTrend.map((r) => r.revenue ?? r.amount ?? 0)} />
        <EnterpriseStatCard title="Outstanding" value={Number(kpis.outstandingAmount)} currency={baseCurrency} icon={Wallet} color={CARD_GRADIENTS[4]} href="/billing/invoices" />
        <EnterpriseStatCard title="Paid" value={Number(kpis.collectedAmount)} currency={baseCurrency} icon={CheckCircle} color={CARD_GRADIENTS[1]} href="/billing/invoices?status=paid" />
        <EnterpriseStatCard title="Overdue" value={Number(kpis.overdueAmount)} currency={baseCurrency} icon={AlertCircle} color={CARD_GRADIENTS[4]} href="/billing/invoices?status=overdue" />
      </div>

      <StatGroup title="Invoice Counts">
        <EnterpriseStatCard title="Total Invoices" value={kpis.totalInvoices.toLocaleString()} icon={FileText} color={CARD_GRADIENTS[0]} href="/billing/invoices" />
        <EnterpriseStatCard title="Draft" value={kpis.draft.toLocaleString()} icon={Clock} color={CARD_GRADIENTS[7]} href="/billing/invoices?status=draft" />
        <EnterpriseStatCard title="Sent" value={kpis.sent.toLocaleString()} icon={Send} color={CARD_GRADIENTS[3]} href="/billing/invoices?status=sent" />
        <EnterpriseStatCard title="Paid Count" value={kpis.paid.toLocaleString()} icon={CheckCircle} color={CARD_GRADIENTS[1]} href="/billing/invoices?status=paid" />
        <EnterpriseStatCard title="Overdue Count" value={kpis.overdue.toLocaleString()} icon={AlertCircle} color={CARD_GRADIENTS[4]} href="/billing/invoices?status=overdue" />
        <EnterpriseStatCard title="Cancelled" value={kpis.cancelled.toLocaleString()} icon={Ban} color={CARD_GRADIENTS[5]} />
        <EnterpriseStatCard title="Partially Paid" value={kpis.partiallyPaid.toLocaleString()} icon={Activity} color={CARD_GRADIENTS[6]} />
        <EnterpriseStatCard title="Refunded" value={kpis.refunded.toLocaleString()} icon={TrendingDown} color={CARD_GRADIENTS[2]} />
      </StatGroup>

      <StatGroup title="More Metrics">
        <EnterpriseStatCard title="This Month Revenue" value={Number(kpis.thisMonthRevenue)} currency={baseCurrency} icon={TrendingUp} color={CARD_GRADIENTS[0]} />
        <EnterpriseStatCard title="Avg Payment Days" value={`${kpis.avgPaymentDays} days`} icon={Calendar} color={CARD_GRADIENTS[3]} />
        <EnterpriseStatCard title="Average Invoice" value={Number(kpis.avgInvoiceValue)} currency={baseCurrency} icon={Receipt} color={CARD_GRADIENTS[6]} href="/billing/invoices" />
        <EnterpriseStatCard title="Collection Rate" value={`${kpis.collectionRate}%`} icon={Activity} color={CARD_GRADIENTS[1]} />
        <EnterpriseStatCard title="Tax Collected" value={Number(kpis.totalTaxCollected)} currency={baseCurrency} icon={DollarSign} color={CARD_GRADIENTS[2]} />
      </StatGroup>

      <QuickActions actions={invoiceQuickActions} />

      <div className={DASHBOARD_CHART_GRID}>
        <ChartCard title="Invoice Trend">
          <ChartErrorBoundary aria-live="polite">
            {d.invoiceTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={d.invoiceTrend}>
                  <defs>
                    <linearGradient id="invTrendGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#FF7A00" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#FF7A00" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="count" name="Invoices" stroke="#FF7A00" strokeWidth={2} fill="url(#invTrendGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyStateWidget message="No invoice trend data" icon={BarChart3} />
            )}
          </ChartErrorBoundary>
        </ChartCard>

        <ChartCard title="Revenue Trend">
          <ChartErrorBoundary aria-live="polite">
            {d.revenueTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={d.revenueTrend}>
                  <defs>
                    <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(v) => formatDisplayCurrency(v, "\u2014", baseCurrency)} />
                  <Area type="monotone" dataKey="revenue" name="Collected" stroke="#10b981" strokeWidth={2} fill="url(#revGrad)" />
                  <Line type="monotone" dataKey="invoiced" name="Invoiced" stroke="#FF7A00" strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyStateWidget message="No revenue trend data" icon={TrendingUp} />
            )}
          </ChartErrorBoundary>
        </ChartCard>
      </div>

      <div className={DASHBOARD_CHART_GRID}>
        <ChartCard title="Status Distribution">
          <ChartErrorBoundary aria-live="polite">
            {statusData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={statusData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={5} dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(1)}%`}>
                    {statusData.map((entry, idx) => (
                      <Cell key={idx} fill={entry.color || CHART_COLORS[idx % CHART_COLORS.length]} />
                    ))}
                    <Tooltip formatter={(v) => [v, "Invoices"]} />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <EmptyStateWidget message="No status data" icon={PieChartIcon} />
            )}
          </ChartErrorBoundary>
        </ChartCard>

        <ChartCard title="Payment Collection Trend">
          <ChartErrorBoundary aria-live="polite">
            {d.collectionTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={d.collectionTrend} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v) => `${v}%`} />
                  <Line type="monotone" dataKey="rate" name="Collection Rate" stroke="#10b981" strokeWidth={3} dot={{ fill: "#10b981", strokeWidth: 2, r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <EmptyStateWidget message="No collection data" icon={Activity} />
            )}
          </ChartErrorBoundary>
        </ChartCard>
      </div>

      <ChartCard title="Monthly Revenue">
        <ChartErrorBoundary aria-live="polite">
          {d.monthlyRevenue.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={d.monthlyRevenue} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tickFormatter={(v) => formatCompactCurrency(v, baseCurrency)} tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v) => formatDisplayCurrency(v, "\u2014", baseCurrency)} />
                <Bar dataKey="total" name="Invoiced" fill="#FF7A00" radius={[4, 4, 0, 0]} />
                <Bar dataKey="collected" name="Collected" fill="#10b981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyStateWidget message="No monthly revenue data" icon={DollarSign} />
          )}
        </ChartErrorBoundary>
      </ChartCard>

      <div className={DASHBOARD_CHART_GRID_3}>
        <ChartCard title="Recent Activity" action={
          <button onClick={() => navigate("/billing/invoicing/reports")} className="text-sm font-medium text-brand-600 hover:text-brand-700 flex items-center gap-1">
            View All <ChevronRight size={14} />
          </button>
        }>
          {d.recentActivity.length > 0 ? (
            <div className="space-y-3">
              {d.recentActivity.map((act) => (
                <div key={act.id} className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl">
                  <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${
                    act.to_status === "paid" ? "bg-green-100 text-green-600" :
                    act.to_status === "sent" ? "bg-blue-100 text-blue-600" :
                    act.to_status === "overdue" ? "bg-red-100 text-red-600" :
                    "bg-slate-100 text-slate-600"
                  }`}>
                    {act.to_status === "paid" ? <CheckCircle size={16} /> :
                     act.to_status === "sent" ? <Send size={16} /> :
                     <Clock size={16} />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-700 truncate">{act.action}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Invoice #{act.invoice_id} &middot; {act.created_at ? new Date(act.created_at).toLocaleDateString() : "—"}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyStateWidget message="No recent activity" icon={Activity} ctaText="Create Invoice" onCtaClick={() => navigate("/billing/invoices/create")} />
          )}
        </ChartCard>

        <ChartCard title="Overdue Invoices" action={
          <button onClick={() => navigate("/billing/invoices?status=overdue")} className="text-sm font-medium text-brand-600 hover:text-brand-700 flex items-center gap-1">
            View All <ChevronRight size={14} />
          </button>
        }>
          {d.overdueInvoices.length > 0 ? (
            <div className="space-y-3">
              {d.overdueInvoices.map((inv) => (
                <button key={inv.id} onClick={() => navigate(`/billing/invoices/${inv.id}`)}
                  className="w-full flex items-center justify-between p-3 bg-red-50 rounded-xl hover:bg-red-100 transition-colors text-left">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-800 truncate">{inv.invoice_number || `#${inv.id}`}</p>
                    <p className="text-xs text-slate-500 mt-0.5">Due {formatDisplayDate(inv.due_date)}</p>
                  </div>
                  <span className="text-sm font-bold text-red-600 shrink-0 whitespace-nowrap">{formatDisplayCurrency(inv.total_amount || inv.balance_due, "—", inv.currency)}</span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyStateWidget message="No overdue invoices" icon={CheckCircle} />
          )}
        </ChartCard>

        <ChartCard title="Top Customers" action={
          <button onClick={() => navigate("/billing/customers")} className="text-sm font-medium text-brand-600 hover:text-brand-700 flex items-center gap-1">
            View All <ChevronRight size={14} />
          </button>
        }>
          {topCustomers.length > 0 ? (
            <div className="space-y-3">
              {topCustomers.map((c, idx) => (
                <div key={c.id} className="flex items-center justify-between gap-3 p-3 bg-slate-50 rounded-xl">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-8 w-8 rounded-lg bg-brand-100 text-brand-700 flex items-center justify-center shrink-0 text-xs font-bold">
                      {idx + 1}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-800 truncate">{c.name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{c.count} invoice{c.count === 1 ? "" : "s"}</p>
                    </div>
                  </div>
                  <span className="text-sm font-bold text-slate-700 shrink-0 whitespace-nowrap">{formatDisplayCurrency(c.total, "—", baseCurrency)}</span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyStateWidget message="No customer billing data available" icon={Users} />
          )}
        </ChartCard>
      </div>
    </div>
  );
}
