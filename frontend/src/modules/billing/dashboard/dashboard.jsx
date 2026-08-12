import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { DollarSign, TrendingUp, Receipt, Users, FileSignature, UserCheck, FileText, Clock,
  BarChart3, RefreshCw, Download, AlertCircle, CheckCircle, Activity,
  Wallet, ChevronRight, Settings2, ArrowUpRight, ArrowDownRight,
  UserPlus, Package, CreditCard, PlusCircle } from "lucide-react"
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area
} from "recharts";
import {
  dashboardApi, invoiceApi, paymentApi, customerApi, subscriptionApi, contractApi, collectionApi, auditApi, productApi, settingsApi
} from "../../../service/billingService";
import CatalogOnboarding from "../products/catalog-onboarding";
import { extractArray, formatDisplayCurrency, formatCompactMoney } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { useBillingDateRange } from "../utils/DateRangeContext";
import {
  DashboardStatCard as StatCard, DashboardChartCard as ChartCard, DashboardEmptyPanel as EmptyStateWidget,
  DashboardStatCardSkeleton as SkeletonCard, DashboardChartCardSkeleton as SkeletonChart,
  DashboardChartErrorBoundary as ChartErrorBoundary, DASHBOARD_KPI_GRID, DASHBOARD_CHART_GRID, DASHBOARD_CHART_GRID_3,
  DashboardDateRangeFilter, BusinessInsights, QuickActions, ActionCenter,
  exportDashboardToCsv as exportToCsv, exportDashboardToJson as exportToJson,
} from "../../../components/billing-shared";
import {
  Button, PageHeader, StatGroup, DataTable,
} from "../../../components/billing-ui";

class WidgetErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch() {
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]" role="region">
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <Activity className="h-8 w-8 text-slate-300 mb-2" />
            <p className="text-slate-600 text-sm font-medium">{this.props.title || "Section"} Summary</p>
            <p className="text-slate-400 text-xs mt-1">No updates recorded for this period</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const formatNumber = (value) => {
  if (value === null || value === undefined) return "0";
  const num = typeof value === "string" ? Number(value) : value;
  if (isNaN(num)) return "0";
  if (Number.isInteger(num)) return num.toLocaleString();
  return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
};

// Percentages read naturally: 43 → "43%", 43.1 → "43.1%" (never "43.10%").
const formatPercent = (value) => {
  const num = Number(value);
  if (Number.isNaN(num)) return "\u2014";
  const rounded = Math.round(num * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
};

// Signed percent for growth figures: "+12.3%", "-0.5%", "0%".
const formatGrowth = (value) => {
  const num = Number(value);
  if (Number.isNaN(num)) return "\u2014";
  if (num === 0) return "0%";
  return `${num > 0 ? "+" : "-"}${formatPercent(Math.abs(num))}`;
};

const formatUpdatedAgo = (date) => {
  const diffMs = Math.max(0, new Date() - new Date(date));
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Updated just now";
  if (diffMins === 1) return "Updated 1 minute ago";
  if (diffMins < 60) return `Updated ${diffMins} minutes ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `Updated ${diffHrs} hour${diffHrs > 1 ? "s" : ""} ago`;
  return `Updated ${new Date(date).toLocaleDateString()}`;
};

const CHART_COLORS = ["#FF7A00", "#FB923C", "#FDBA74", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4899"];

function SkeletonTable({ className }) {
  return (
    <div className={`bg-white border border-slate-200 rounded-3xl p-6 animate-pulse ${className}`} aria-hidden="true">
      <div className="h-5 bg-slate-200 rounded w-40 mb-6" />
      <div className="space-y-3">
        <div className="h-8 bg-slate-100 rounded" />
        <div className="h-8 bg-slate-100 rounded" />
        <div className="h-8 bg-slate-100 rounded" />
        <div className="h-8 bg-slate-100 rounded" />
        <div className="h-8 bg-slate-100 rounded" />
      </div>
    </div>
  );
}

function ChartTooltip({ active, payload, label, format }) {
  if (!active || !payload?.length) return null;
  const fmt = format || ((v) => (typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v));
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 shadow-xl">
      {label != null && label !== "" && <p className="mb-1.5 text-xs font-semibold text-slate-500">{label}</p>}
      {payload.map((entry, idx) => (
        <p key={idx} className="flex items-center gap-2 text-sm font-bold text-slate-800">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: entry.color || entry.fill || "#FF7A00" }} />
          {fmt(entry.value)}
        </p>
      ))}
    </div>
  );
}

const SecondaryStatCard = React.memo(function SecondaryStatCard({ title, value, fullValue, icon: Icon, color = "bg-brand-100 text-brand-600", href, onClick, trend, trendValue, currency }) {
  const navigate = useNavigate();
  const handleClick = onClick || (href ? () => navigate(href) : undefined);
  const displayValue = typeof value === "number" && Number.isFinite(value) ? formatCompactMoney(value, currency) : value;
  return (
    <button
      type="button"
      onClick={handleClick}
      title={fullValue}
      className="group flex w-full items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-[0_6px_18px_rgba(0,0,0,0.07)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 min-w-0"
    >
      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${color}`}>
        <Icon size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[10px] font-bold uppercase tracking-wider text-slate-400">{title}</span>
        <span className="block truncate text-sm font-bold text-slate-800">{displayValue}</span>
        {trend && (
          <span className={`block text-[10px] font-semibold ${trend === "up" ? "text-emerald-600" : "text-red-600"}`}>{trendValue}</span>
        )}
      </span>
    </button>
  );
});

export default function ZoikoBillingModule() {
  const navigate = useNavigate();
  const { baseCurrency, currencySymbol, formatCurrency: ctxFormatCurrency } = useCurrency();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const {
    range: dateRangeValue, setRange: setDateRangeValue,
    customStart, customEnd, applyCustomRange, reset: resetDateRange,
    dateRange,
  } = useBillingDateRange();
  const [showExportMenu, setShowExportMenu] = useState(false);
  const mountedRef = useRef(true);
  const loadingRef = useRef(true);
  const dateRangeRef = useRef(dateRange);
  const dateRangeValueRef = useRef(dateRangeValue);
  const requestIdRef = useRef(0);

  const isCustomRangeReady = dateRangeValue !== "custom" || (!!dateRange.date_from && !!dateRange.date_to);

  useEffect(() => { dateRangeRef.current = dateRange; }, [dateRange]);
  useEffect(() => { dateRangeValueRef.current = dateRangeValue; }, [dateRangeValue]);

  const [productCount, setProductCount] = useState(null);
  const [subscriptionReporting, setSubscriptionReporting] = useState(null);
  const [healthSummary, setHealthSummary] = useState(null);

  const [dashboardData, setDashboardData] = useState({
    full: null,
    kpis: null,
    revenue: [],
    invoices: [],
    payments: [],
    customers: [],
    activeSubscriptions: [],
    activeContracts: [],
    expiringContracts: [],
    agingBuckets: [],
    auditLogs: [],
    invoiceStats: null,
    outstandingTotal: null,
    totalCollected: null,
    paymentTrend: [],
  });

  const fetchDashboardData = useCallback(async () => {
    const currentRequestId = ++requestIdRef.current;
    try {
      setError(null);
      if (!loadingRef.current) setRefreshing(true);

      const range = dateRangeRef.current;
      if (dateRangeValueRef.current === "custom" && (!range.date_from || !range.date_to)) {
        // Custom Date Range selected but not fully chosen yet — hold the
        // previous data on screen instead of silently falling back to all-time.
        setLoading(false);
        setRefreshing(false);
        loadingRef.current = false;
        return;
      }

      const results = await Promise.allSettled([
        dashboardApi.getFull(undefined, range),
        dashboardApi.getKPIs(undefined, range),
        dashboardApi.getMonthlyRevenue(12, undefined, range),
        dashboardApi.getPaymentTrend(undefined, range),
        invoiceApi.list({ per_page: 5, date_from: range.date_from, date_to: range.date_to }),
        paymentApi.list({ per_page: 5, date_from: range.date_from, date_to: range.date_to }),
        customerApi.list({ per_page: 5, date_from: range.date_from, date_to: range.date_to }),
        subscriptionApi.listActive(),
        contractApi.listActive(),
        invoiceApi.getDashboardStats(undefined),
        invoiceApi.getOutstandingTotal(),
        paymentApi.getTotalCollected(),
        collectionApi.getAgingBuckets(),
        contractApi.listExpiring(30),
        auditApi.list({ per_page: 10 }),
        productApi.list({ per_page: 1 }),
        subscriptionApi.getReporting(),
        settingsApi.getHealth(),
      ]);

      if (currentRequestId !== requestIdRef.current) return;

      const [fullResult, kpisResult, revenueResult, paymentTrendResult, invoicesResult, paymentsResult, customersResult,
        subscriptionsResult, contractsResult, invoiceStatsResult, outstandingResult,
        totalCollectedResult, agingResult, expiringResult, auditResult, productResult, reportingResult, healthResult] = results;

      const safeValue = (result, transform = (v) => v) =>
        result.status === "fulfilled" ? transform(result.value) : null;

      const prodData = safeValue(productResult);
      if (prodData) {
        const count = prodData.total ?? prodData.items?.length ?? 0;
        setProductCount(count);
      }

      setSubscriptionReporting(safeValue(reportingResult));
      setHealthSummary(safeValue(healthResult));

      const kpisData = safeValue(kpisResult);
      const revData = safeValue(revenueResult, extractArray) || [];
      const ptData = safeValue(paymentTrendResult, v => v?.payment_trend) || [];
      if (mountedRef.current) {
        setDashboardData({
          full: safeValue(fullResult),
          kpis: kpisData,
          revenue: revData,
          paymentTrend: ptData,
          invoices: safeValue(invoicesResult, extractArray) || [],
          payments: safeValue(paymentsResult, extractArray) || [],
          customers: safeValue(customersResult, extractArray) || [],
          activeSubscriptions: safeValue(subscriptionsResult, extractArray) || [],
          activeContracts: safeValue(contractsResult, extractArray) || [],
          invoiceStats: safeValue(invoiceStatsResult),
          outstandingTotal: safeValue(outstandingResult),
          totalCollected: safeValue(totalCollectedResult),
          agingBuckets: safeValue(agingResult, extractArray) || [],
          expiringContracts: safeValue(expiringResult, extractArray) || [],
          auditLogs: safeValue(auditResult, extractArray) || [],
        });
        setLastUpdated(new Date());
      }
    } catch (err) {
      if (mountedRef.current) setError("Failed to load dashboard data. Please try again.");
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
    fetchDashboardData();
    const interval = setInterval(() => { fetchDashboardData(); }, 60000);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [fetchDashboardData]);

  useEffect(() => {
    if (!loadingRef.current) {
      setRefreshing(true);
      fetchDashboardData();
    }
  }, [dateRangeValue, dateRange.date_from, dateRange.date_to, fetchDashboardData]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDashboardData();
  }, [fetchDashboardData]);

  const handleExport = useCallback((format) => {
    const prefix = `billing-dashboard-${new Date().toISOString().split("T")[0]}`;
    if (format === "csv") {
      exportToCsv({
        kpis: dashboardData.kpis,
        invoiceStats: dashboardData.invoiceStats,
        outstandingTotal: dashboardData.outstandingTotal,
        totalCollected: dashboardData.totalCollected,
        date_from: dateRange.date_from,
        date_to: dateRange.date_to,
      }, prefix);
    } else if (format === "json") {
      exportToJson({ ...dashboardData, dateRange }, prefix);
    } else if (format === "pdf") {
      window.print();
    }
    setShowExportMenu(false);
  }, [dashboardData, dateRange]);

  const d = dashboardData;

  const reportingCurrency = subscriptionReporting?.reporting_currency || baseCurrency;

  const customerMap = useMemo(() => {
    const map = {};
    d.customers.forEach((c) => {
      const name = c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.company_name || `Customer #${c.id}`;
      map[c.id] = name;
    });
    return map;
  }, [d.customers]);

  const getCustomerName = useCallback((customerId) => {
    return customerMap[customerId] || `Customer #${customerId}`;
  }, [customerMap]);

  const kpis = useMemo(() => {
    const full = d.full || {};
    const kpi = d.kpis || {};
    const stats = d.invoiceStats || {};
    const totalRev = kpi.total_revenue ?? full.total_revenue ?? 0;
    const totalInv = kpi.total_invoices ?? stats.total_invoices ?? full.total_invoices ?? d.invoices.length;
    const collections = kpi.collections ?? 0;
    const revData = d.revenue;
    let monthlyGrowth = kpi.monthly_growth ?? full.monthly_growth ?? 0;
    if (monthlyGrowth === 0 && revData.length >= 2) {
      const last = revData[revData.length - 1]?.revenue ?? 0;
      const prev = revData[revData.length - 2]?.revenue ?? 0;
      if (prev > 0) monthlyGrowth = ((last - prev) / prev) * 100;
    }
    return {
      totalRevenue: totalRev,
      monthlyRevenue: kpi.monthly_revenue ?? full.monthly_revenue ?? 0,
      outstandingAmount: kpi.outstanding_amount ?? d.outstandingTotal?.total_outstanding ?? full.outstanding_amount ?? 0,
      paidAmount: kpi.paid_amount ?? stats.paid_amount ?? full.paid_amount ?? 0,
      overdueAmount: kpi.overdue_amount ?? stats.overdue_amount ?? full.overdue_amount ?? 0,
      activeCustomers: kpi.active_customers ?? full.total_customers ?? d.customers.length,
      activeContracts: d.activeContracts.length,
      activeSubscriptions: kpi.active_subscriptions ?? full.active_subscriptions ?? d.activeSubscriptions.length,
      totalInvoices: totalInv,
      pendingPayments: kpi.pending_payments ?? 0,
      avgInvoiceValue: totalInv > 0 ? totalRev / totalInv : 0,
      collectionRate: totalRev > 0 ? Math.min(100, (collections / totalRev) * 100) : totalRev === 0 && collections > 0 ? 100 : 0,
      monthlyGrowth: monthlyGrowth,
      // No revenue-recognition schedule data feeds this dashboard yet (that
      // engine is a separate, later-phase concern) — this is total billed
      // revenue, labeled as such below rather than as "recognized" revenue.
      revenueRecognition: kpi.revenue_recognition ?? totalRev,
    };
  }, [d]);

  const renderSkeletonLoading = () => (
    <div className="space-y-8" aria-label="Loading dashboard">
      <div className="flex justify-between items-center bg-white border border-slate-200 rounded-2xl p-4 animate-pulse">
        <div className="h-10 bg-slate-200 rounded-lg w-48" />
        <div className="h-10 bg-slate-200 rounded-lg w-64" />
      </div>
      <div className={DASHBOARD_KPI_GRID}>
        {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-14 rounded-xl bg-slate-200/70" />)}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-24 rounded-2xl bg-slate-200/70" />)}
      </div>
      <div className={DASHBOARD_CHART_GRID}>
        <SkeletonChart />
        <SkeletonChart />
      </div>
      <div className={DASHBOARD_CHART_GRID_3}>
        <SkeletonChart />
        <SkeletonChart />
        <SkeletonChart />
      </div>
      <div className={DASHBOARD_CHART_GRID}>
        <SkeletonChart />
        <SkeletonChart />
      </div>
      <div className={DASHBOARD_CHART_GRID}>
        <SkeletonTable />
        <SkeletonTable />
      </div>
      <div className={DASHBOARD_CHART_GRID_3}>
        <SkeletonTable />
        <SkeletonTable />
        <SkeletonTable />
      </div>
    </div>
  );

  const renderErrorState = () => (
    <div className="flex flex-col items-center justify-center py-20">
      <div className="h-16 w-16 rounded-full bg-red-100 text-red-600 flex items-center justify-center mb-4">
        <AlertCircle size={32} />
      </div>
      <h3 className="text-xl font-bold text-slate-800 mb-2">Something went wrong</h3>
      <p className="text-slate-600 mb-6 text-center max-w-md">{error}</p>
      <button onClick={handleRefresh}
        className="px-6 py-3 bg-gradient-to-r from-[#FF7A00] to-[#FF5500] text-white rounded-xl font-medium hover:shadow-lg transition-all flex items-center gap-2">
        <RefreshCw size={18} />
        Try Again
      </button>
    </div>
  );

  const renderEmptyState = () => (
    <div className="flex flex-col items-center justify-center py-20">
      <div className="h-16 w-16 rounded-full bg-slate-100 text-slate-400 flex items-center justify-center mb-4">
        <FileText size={32} />
      </div>
      <h3 className="text-xl font-bold text-slate-800 mb-2">No billing data yet</h3>
      <p className="text-slate-600 mb-6 text-center max-w-md">Create an invoice to start billing customers — your revenue, collections, and activity analytics will appear here.</p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <button onClick={() => navigate("/billing/invoices/create")}
          className="px-6 py-3 bg-gradient-to-r from-[#FF7A00] to-[#FF5500] text-white rounded-xl font-medium hover:shadow-lg transition-all flex items-center gap-2">
          <PlusCircle size={18} />
          Create Invoice
        </button>
        <button onClick={() => navigate("/billing/customers")}
          className="px-5 py-3 bg-white border border-slate-200 text-slate-700 rounded-xl font-medium hover:bg-slate-50 transition-all flex items-center gap-2">
          <Users size={18} />
          Add Customer
        </button>
        <button onClick={() => navigate("/billing/products")}
          className="px-5 py-3 bg-white border border-slate-200 text-slate-700 rounded-xl font-medium hover:bg-slate-50 transition-all flex items-center gap-2">
          <Package size={18} />
          Add Product
        </button>
        <button onClick={handleRefresh}
          className="px-5 py-3 bg-white border border-slate-200 text-slate-500 rounded-xl font-medium hover:bg-slate-50 transition-all flex items-center gap-2">
          <RefreshCw size={18} />
          Refresh Data
        </button>
      </div>
    </div>
  );

  const revenueChartData = useMemo(() => {
    const raw = d.revenue.length > 0 ? d.revenue : [];
    if (d.full?.revenue_trend && d.full.revenue_trend.length > 0) return d.full.revenue_trend;
    return raw;
  }, [d]);

  const invoiceStatusData = useMemo(() => {
    const stats = d.invoiceStats || {};
    const summary = d.full?.invoice_summary || {};
    const totalPaid = summary.paid_count ?? stats.paid_count ?? stats.paid ?? 0;
    const totalSent = summary.sent_count ?? stats.sent_count ?? 0;
    const totalOverdue = summary.overdue_count ?? stats.overdue_count ?? stats.overdue ?? 0;
    const totalDraft = summary.draft_count ?? stats.draft_count ?? stats.draft ?? 0;
    return [
      { name: "Paid", value: totalPaid, color: "#10b981" },
      { name: "Sent", value: totalSent, color: "#f59e0b" },
      { name: "Overdue", value: totalOverdue, color: "#ef4444" },
      { name: "Draft", value: totalDraft, color: "#6b7280" },
    ].filter((d) => d.value > 0);
  }, [d]);

  const subscriptionChartData = useMemo(() => {
    const data = d.activeSubscriptions.length > 0 ? d.activeSubscriptions : [];
    const grouped = data.reduce((acc, sub) => {
      const key = sub.plan_name || `Plan #${sub.plan_id}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return Object.entries(grouped).map(([name, value]) => ({ name, value }));
  }, [d]);

  const agingData = useMemo(() => {
    const data = d.agingBuckets.length > 0 ? d.agingBuckets : [];
    if (d.full?.aging_summary) return d.full.aging_summary;
    return data;
  }, [d]);

  const quickActions = useMemo(() => [
    { label: "Create Invoice", hint: "Bill a customer", href: "/billing/invoices/create", icon: Receipt },
    { label: "Add Customer", hint: "Add a new customer", href: "/billing/customers", icon: UserPlus },
    { label: "New Subscription", hint: "Start a recurring plan", href: "/billing/subscriptions/create", icon: CreditCard },
    { label: "New Contract", hint: "Draft a contract", href: "/billing/contracts/create", icon: FileText },
    { label: "Add Product", hint: "Add a product or service", href: "/billing/products", icon: Package },
    { label: "Record Payment", hint: "Log an incoming payment", href: "/billing/payments", icon: Wallet },
    { label: "Send Quote", hint: "Create a quotation", href: "/billing/quotations/create", icon: FileSignature },
    { label: "View Reports", hint: "Revenue and collections", href: "/billing/reports", icon: BarChart3 },
  ], []);

  const insightItems = useMemo(() => {
    const items = [];
    if (kpis.monthlyGrowth !== 0) {
      const positive = kpis.monthlyGrowth > 0;
      items.push({
        icon: positive ? ArrowUpRight : ArrowDownRight,
        tone: positive ? "up" : "down",
        text: `Revenue ${positive ? "grew" : "declined"} ${Math.abs(kpis.monthlyGrowth).toFixed(1)}% versus last month`,
      });
    }
    if (kpis.collectionRate >= 80) {
      items.push({ icon: CheckCircle, tone: "up", text: `Collection is strong at ${kpis.collectionRate.toFixed(0)}% of billed revenue` });
    } else if (kpis.collectionRate > 0) {
      items.push({ icon: Activity, tone: "warning", text: `Collection rate of ${kpis.collectionRate.toFixed(0)}% needs attention` });
    }
    if (kpis.overdueAmount > 0) {
      items.push({ icon: AlertCircle, tone: "warning", text: `${formatDisplayCurrency(kpis.overdueAmount, baseCurrency)} is overdue and awaiting payment` });
    }
    if (d.expiringContracts.length > 0) {
      items.push({ icon: Clock, tone: "neutral", text: `${d.expiringContracts.length} contract${d.expiringContracts.length > 1 ? "s" : ""} renew${d.expiringContracts.length > 1 ? "" : "s"} within the next 30 days` });
    }
    if (kpis.activeSubscriptions > 0) {
      items.push({ icon: UserCheck, tone: "neutral", text: `${formatNumber(kpis.activeSubscriptions)} active subscription${kpis.activeSubscriptions > 1 ? "s" : ""} running` });
    }
    return items.slice(0, 4);
  }, [kpis, d.expiringContracts, baseCurrency]);

  const actionItems = useMemo(() => {
    const items = [];
    const overdueInvoices = d.invoices.filter((r) => r.status === "overdue");
    if (overdueInvoices.length > 0) {
      items.push({
        icon: AlertCircle, tone: "danger", priority: "high",
        title: `${overdueInvoices.length} invoice${overdueInvoices.length > 1 ? "s" : ""} overdue`,
        description: `${formatDisplayCurrency(kpis.overdueAmount, baseCurrency)} total outstanding past due`,
        href: "/billing/invoices?status=overdue",
      });
    }
    if (d.expiringContracts.length > 0) {
      items.push({
        icon: Clock, tone: "warning", priority: "medium",
        title: `${d.expiringContracts.length} contract${d.expiringContracts.length > 1 ? "s" : ""} expiring soon`,
        description: "Renews or lapses within the next 30 days",
        href: "/billing/contracts",
      });
    }
    const failedPayments = d.payments.filter((r) => r.status === "failed");
    if (failedPayments.length > 0) {
      items.push({
        icon: AlertCircle, tone: "danger", priority: "high",
        title: `${failedPayments.length} payment${failedPayments.length > 1 ? "s" : ""} failed`,
        description: "Needs review or a retry",
        href: "/billing/payments?status=failed",
      });
    }
    const unhealthyComponents = healthSummary?.components?.filter((c) => c.status !== "healthy") || [];
    if (unhealthyComponents.length > 0) {
      items.push({
        icon: Activity, tone: "warning", priority: "medium",
        title: `${unhealthyComponents.length} system component${unhealthyComponents.length > 1 ? "s" : ""} need attention`,
        description: "Billing system health check flagged an issue",
        href: "/billing/settings",
      });
    }
    return items.slice(0, 4);
  }, [d.invoices, d.payments, d.expiringContracts, kpis.overdueAmount, baseCurrency, healthSummary]);

  const invoiceColumns = useMemo(() => [
    { key: "id", label: "Invoice", render: (r) => r.invoice_number || `#${r.id}` },
    { key: "customer_name", label: "Customer", render: (r) => getCustomerName(r.customer_id) },
    { key: "total", label: "Amount", render: (r) => formatDisplayCurrency(r.total_amount || r.total || r.amount, baseCurrency) },
    { key: "status", label: "Status", render: (r) => (
      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
        r.status === "paid" || r.status === "cleared" ? "bg-green-100 text-green-700" :
        r.status === "overdue" ? "bg-red-100 text-red-700" :
        r.status === "pending" || r.status === "draft" ? "bg-amber-100 text-amber-700" :
        "bg-slate-100 text-slate-700"
      }`}>{r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : "\u2014"}</span>
    )},
  ], [baseCurrency, getCustomerName]);

  const paymentColumns = useMemo(() => [
    { key: "id", label: "Transaction", render: (r) => r.payment_number || `#${r.id}` },
    { key: "customer_name", label: "Customer", render: (r) => getCustomerName(r.customer_id) },
    { key: "amount", label: "Amount", render: (r) => formatDisplayCurrency(r.amount, baseCurrency) },
    { key: "method", label: "Method", render: (r) => r.method || r.payment_method || "—" },
    { key: "status", label: "Status", render: (r) => (
      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
        r.status === "completed" || r.status === "cleared" ? "bg-green-100 text-green-700" :
        r.status === "pending" ? "bg-amber-100 text-amber-700" :
        r.status === "failed" ? "bg-red-100 text-red-700" :
        "bg-slate-100 text-slate-700"
      }`}>{r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : "\u2014"}</span>
    )},
  ], [baseCurrency, getCustomerName]);

  const customerColumns = useMemo(() => [
    { key: "name", label: "Name", render: (r) => r.display_name || [r.first_name, r.last_name].filter(Boolean).join(" ") || r.company_name || "—" },
    { key: "email", label: "Email", render: (r) => r.email || "—" },
    { key: "status", label: "Status", render: (r) => {
      const s = r.status || "active";
      return (
      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
        s === "active" ? "bg-green-100 text-green-700" :
        s === "suspended" ? "bg-amber-100 text-amber-700" :
        "bg-slate-100 text-slate-700"
      }`}>{s.charAt(0).toUpperCase() + s.slice(1)}</span>
    ); }},
  ], []);

  const activityColumns = useMemo(() => [
    { key: "action", label: "Activity", render: (r) => {
      const raw = r.action || r.event || r.description || "\u2014";
      if (raw === "\u2014") return raw;
      const entity = (r.entity_type || r.resource_type || "").replace(/BillingConfiguration/i, "Billing Configuration");
      const entityId = r.entity_id || r.resource_id || "";
      let text = raw.replace(/_/g, " ");

      if (/^(approve|create|send|update|cancel|delete|pay|void)\s+/i.test(text)) {
        const parts = text.split(/\s+/);
        const verb = parts[0].toLowerCase();
        let pastVerb = verb + "d";
        if (verb === "approve") pastVerb = "Approved";
        else if (verb === "create") pastVerb = "Created";
        else if (verb === "send") pastVerb = "Sent";
        else if (verb === "update") pastVerb = "Updated";
        else if (verb === "cancel") pastVerb = "Cancelled";
        else if (verb === "delete") pastVerb = "Deleted";
        else if (verb === "pay") pastVerb = "Paid";
        else if (verb === "void") pastVerb = "Voided";

        const targetEntity = entity ? entity : parts.slice(1).join(" ");
        const idStr = entityId ? ` #${entityId}` : "";
        return (
          <span className="font-medium text-slate-800">
            {targetEntity}{idStr} <span className="text-slate-500 font-normal">{pastVerb}</span>
          </span>
        );
      }

      return <span className="font-medium text-slate-800">{text.charAt(0).toUpperCase() + text.slice(1)}</span>;
    }},
    { key: "user", label: "Actor", render: (r) => {
      const name = r.changed_by || r.user || r.actor || "System";
      return <span className="text-xs font-semibold px-2 py-0.5 rounded-md bg-slate-100 text-slate-600">{name}</span>;
    }},
    { key: "created_at", label: "Time", render: (r) => {
      if (!r.created_at) return <span className="text-slate-400 text-xs">Today</span>;
      const date = new Date(r.created_at);
      if (isNaN(date.getTime())) return <span className="text-slate-400 text-xs">Today</span>;
      const now = new Date();
      const diffMs = now - date;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHrs = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);
      let relative;
      if (diffMins < 1) relative = "Just now";
      else if (diffMins < 60) relative = `${diffMins} min ago`;
      else if (diffHrs < 24) relative = `${diffHrs}h ago`;
      else if (diffDays === 1) relative = "Yesterday";
      else if (diffDays < 7) relative = `${diffDays} days ago`;
      else relative = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      return <span title={date.toLocaleString()} className="text-slate-500 text-xs font-medium whitespace-nowrap">{relative}</span>;
    }},
  ], []);

  const renewalColumns = useMemo(() => [
    { key: "customer_name", label: "Customer", render: (r) => getCustomerName(r.customer_id) },
    { key: "end_date", label: "Expires", render: (r) => r.end_date ? new Date(r.end_date).toLocaleDateString() : "—" },
    { key: "value", label: "Value", render: (r) => formatDisplayCurrency(r.value || r.amount || r.total, baseCurrency) },
  ], [baseCurrency]);


  if (loading) {
    return (
      <div className="bg-transparent text-slate-800 p-6 font-sans min-h-screen">
        <div className="mb-6">
          <PageHeader
            crumbs={[{ label: "Billing", href: "/billing" }, { label: "Dashboard" }]}
            title="Billing Dashboard"
            description="Loading your billing metrics\u2026"
            icon={BarChart3}
          />
        </div>
        {renderSkeletonLoading()}
      </div>
    );
  }

  if (error && !d.full && !d.kpis) {
    return (
      <div className="bg-transparent text-slate-800 p-6 font-sans min-h-screen">
        <div className="mb-6">
          <PageHeader
            crumbs={[{ label: "Billing", href: "/billing" }, { label: "Dashboard" }]}
            title="Billing Dashboard"
            description="Live billing overview"
            icon={BarChart3}
          />
        </div>
        {renderErrorState()}
      </div>
    );
  }

  const hasData = d.full || d.kpis || d.invoices.length > 0 || d.payments.length > 0;

  return (
    <div className="bg-transparent text-slate-800 p-6 font-sans min-h-screen">
      <style>{`@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print { display: none !important; } }`}</style>

      {productCount === 0 && (
        <CatalogOnboarding
          onAddManually={() => navigate("/billing/products")}
          onImported={() => {
            fetchDashboardData();
          }}
        />
      )}

      <div className="mb-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Dashboard" }]}
          title="Billing Dashboard"
          description="Monitor invoices, revenue, payments and subscriptions in real-time."
          icon={BarChart3}
          meta={
            <span className="whitespace-nowrap">
              <span className="font-medium text-slate-500">{formatUpdatedAgo(lastUpdated)}</span>
            </span>
          }
          actions={
            <div className="flex flex-wrap items-center gap-3 no-print xl:flex-nowrap xl:justify-end">
              <DashboardDateRangeFilter
                range={dateRangeValue}
                onRangeChange={setDateRangeValue}
                customStart={customStart}
                customEnd={customEnd}
                onApplyCustom={applyCustomRange}
                onResetCustom={resetDateRange}
                className="shrink-0 xl:min-w-40"
              />

              <Button variant="secondary" icon={RefreshCw} onClick={handleRefresh} disabled={refreshing} loading={refreshing} aria-label="Refresh dashboard" className="shrink-0">
                Refresh
              </Button>

              <div className="relative shrink-0">
                <Button variant="secondary" icon={Download} onClick={() => setShowExportMenu(!showExportMenu)} aria-label="Export data">
                  Export
                </Button>
                {showExportMenu && (
                  <div className="absolute top-12 right-0 bg-white border border-slate-200 rounded-2xl p-3 shadow-xl z-50 w-44">
                    <p className="text-xs font-semibold text-slate-400 px-2 py-1 uppercase tracking-wider">Export Format</p>
                    <div className="space-y-1 mt-1">
                      <button onClick={() => handleExport("json")} className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-slate-50 transition-colors text-xs font-medium text-slate-700">Export as JSON</button>
                      <button onClick={() => handleExport("csv")} className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-slate-50 transition-colors text-xs font-medium text-slate-700">Export as CSV</button>
                      <button onClick={() => handleExport("pdf")} className="w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-slate-50 transition-colors text-xs font-medium text-slate-700">Print / PDF Report</button>
                    </div>
                  </div>
                )}
              </div>

              <Button variant="primary" icon={Receipt} onClick={() => navigate("/billing/invoices/create")} aria-label="Create invoice" className="shrink-0 whitespace-nowrap">
                Create Invoice
              </Button>
            </div>
          }
        />
      </div>

      {dateRangeValue === "custom" && !isCustomRangeReady && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-3 mb-6 no-print text-xs text-amber-700">
          Pick a start and end date above, then click Apply to load the custom range.
        </div>
      )}

      {!hasData ? renderEmptyState() : (
        <div className="space-y-8">
          <BusinessInsights items={insightItems} />

          <ActionCenter items={actionItems} />

          <StatGroup title="Revenue & Collections" icon={DollarSign}>
            <StatCard title="Total Revenue" value={kpis.totalRevenue} currency={baseCurrency} icon={DollarSign} trend={kpis.monthlyGrowth >= 0 ? "up" : "down"} trendValue={formatGrowth(kpis.monthlyGrowth)} href="/billing/reports" sparkline={revenueChartData.map((r) => r.revenue)} />
            <StatCard title="Outstanding" value={kpis.outstandingAmount} currency={baseCurrency} icon={Wallet} href="/billing/invoices" />
            <StatCard title="Paid Amount" value={kpis.paidAmount} currency={baseCurrency} icon={CheckCircle} href="/billing/payments" />
            <StatCard title="Collection Rate" value={formatPercent(kpis.collectionRate)} icon={Activity} subtitle="Share of billed revenue collected" href="/billing/payments" />
          </StatGroup>

          <section aria-label="Secondary metrics" className="space-y-3">
            <div className="flex items-center gap-2 px-1">
              <Users size={15} className="text-brand-500" />
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Customer & Subscription Metrics</h2>
              <span className="h-px flex-1 bg-slate-200/70" />
            </div>
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-4 xl:grid-cols-8">
              <SecondaryStatCard
                title="MRR" value={formatCompactMoney(subscriptionReporting?.mrr, reportingCurrency)}
                fullValue={subscriptionReporting?.mrr != null ? formatDisplayCurrency(subscriptionReporting.mrr, reportingCurrency) : undefined}
                icon={RefreshCw} href="/billing/subscriptions/reports"
                trend={subscriptionReporting?.mrr_trend != null ? (subscriptionReporting.mrr_trend >= 0 ? "up" : "down") : kpis.monthlyGrowth >= 0 ? "up" : "down"}
                trendValue={subscriptionReporting?.mrr_trend != null ? formatGrowth(subscriptionReporting.mrr_trend) : formatGrowth(kpis.monthlyGrowth)}
              />
              <SecondaryStatCard
                title="ARR" value={formatCompactMoney(subscriptionReporting?.arr, reportingCurrency)}
                fullValue={subscriptionReporting?.arr != null ? formatDisplayCurrency(subscriptionReporting.arr, reportingCurrency) : undefined}
                icon={TrendingUp} href="/billing/subscriptions/reports"
                trend={subscriptionReporting?.arr_trend != null ? (subscriptionReporting.arr_trend >= 0 ? "up" : "down") : kpis.monthlyGrowth >= 0 ? "up" : "down"}
                trendValue={subscriptionReporting?.arr_trend != null ? formatGrowth(subscriptionReporting.arr_trend) : formatGrowth(kpis.monthlyGrowth * 12)}
              />
              <SecondaryStatCard title="Active Customers" value={formatNumber(kpis.activeCustomers)} icon={Users} href="/billing/customers" />
              <SecondaryStatCard title="Active Contracts" value={formatNumber(kpis.activeContracts)} icon={FileSignature} href="/billing/contracts" />
              <SecondaryStatCard title="Subscriptions" value={formatNumber(kpis.activeSubscriptions)} icon={UserCheck} href="/billing/subscriptions" />
              <SecondaryStatCard title="Pending Payments" value={formatNumber(kpis.pendingPayments)} icon={Clock} href="/billing/payments" />
              <SecondaryStatCard title="Avg Invoice" value={kpis.avgInvoiceValue} currency={baseCurrency} fullValue={formatDisplayCurrency(kpis.avgInvoiceValue, baseCurrency)} icon={FileText} href="/billing/invoices" />
              <SecondaryStatCard title="Monthly Growth" value={formatGrowth(kpis.monthlyGrowth)} icon={TrendingUp} href="/billing/reports" />
            </div>
          </section>

          <QuickActions actions={quickActions} />

          {healthSummary && (
            <div className="bg-white border border-slate-200 rounded-2xl px-5 py-3 flex flex-wrap items-center gap-4 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
              <div className="flex items-center gap-2">
                <Activity size={16} className="text-slate-400" />
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">System Health</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${
                  healthSummary.overall_status === "healthy" ? "bg-green-100 text-green-700" :
                  healthSummary.overall_status === "warning" ? "bg-amber-100 text-amber-700" :
                  "bg-red-100 text-red-700"
                }`}>
                  {healthSummary.overall_status === "healthy" ? <CheckCircle size={12} /> : <AlertCircle size={12} />}
                  {healthSummary.overall_status ? healthSummary.overall_status.charAt(0).toUpperCase() + healthSummary.overall_status.slice(1) : "Unknown"}
                </span>
              </div>
              {healthSummary.readiness_score !== undefined && (
                <>
                  <div className="h-4 w-px bg-slate-200" />
                  <span className="text-xs text-slate-500">
                    Readiness: <span className="font-semibold text-slate-700">{healthSummary.readiness_score}%</span>
                  </span>
                  <div className="w-24 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${
                      healthSummary.readiness_score >= 80 ? "bg-green-500" :
                      healthSummary.readiness_score >= 50 ? "bg-amber-500" : "bg-red-500"
                    }`} style={{ width: `${healthSummary.readiness_score}%` }} />
                  </div>
                </>
              )}
              {healthSummary.components && (
                <>
                  <div className="h-4 w-px bg-slate-200" />
                  <span className="text-xs text-slate-500">
                    {healthSummary.components.filter((c) => c.status === "healthy").length}/{healthSummary.components.length} components healthy
                  </span>
                </>
              )}
              <div className="ml-auto">
                <button onClick={() => navigate("/billing/settings")}
                  className="text-xs font-medium text-[#FF7A00] hover:text-[#FF5500] flex items-center gap-1 transition-colors">
                  <Settings2 size={12} /> Configure
                </button>
              </div>
            </div>
          )}

          <div className={DASHBOARD_CHART_GRID}>
            <WidgetErrorBoundary title="Revenue Trend">
              <ChartCard title="Revenue Trend">
                <ChartErrorBoundary aria-live="polite">
                  {revenueChartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                      <AreaChart data={revenueChartData}>
                        <defs>
                          <linearGradient id="revenueGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#FF7A00" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#FF7A00" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey={revenueChartData[0]?.month ? "month" : "period"} tick={{ fontSize: 12 }} />
                        <YAxis tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 12 }} />
                        <Tooltip content={<ChartTooltip format={(v) => formatDisplayCurrency(v, baseCurrency)} />} />
                        <Area type="monotone" dataKey="revenue" stroke="#FF7A00" strokeWidth={3} fill="url(#revenueGrad)" dot={{ fill: "#FF7A00", strokeWidth: 2, r: 4 }} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyStateWidget message="No revenue data available" icon={BarChart3} />
                  )}
                </ChartErrorBoundary>
              </ChartCard>
            </WidgetErrorBoundary>

            <WidgetErrorBoundary title="Payment Trend">
              <ChartCard title="Payment Trend">
                <ChartErrorBoundary aria-live="polite">
                  {d.paymentTrend.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={d.paymentTrend}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey={d.paymentTrend[0]?.month ? "month" : "period"} tick={{ fontSize: 11 }} />
                        <YAxis tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 12 }} />
                        <Tooltip content={<ChartTooltip format={(v) => formatDisplayCurrency(v, baseCurrency)} />} />
                        <Bar dataKey="amount" fill="#10b981" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : d.payments.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={d.payments.slice(0, 12).reverse()}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="payment_number" tick={{ fontSize: 11 }} />
                        <YAxis tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 12 }} />
                        <Tooltip content={<ChartTooltip format={(v) => formatDisplayCurrency(v, baseCurrency)} />} />
                        <Bar dataKey="amount" fill="#10b981" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyStateWidget message="No payment data available" icon={Receipt} />
                  )}
                </ChartErrorBoundary>
              </ChartCard>
            </WidgetErrorBoundary>
          </div>

          <div className={DASHBOARD_CHART_GRID_3}>
            <WidgetErrorBoundary title="Invoice Status">
              <ChartCard title="Invoice Status">
                <ChartErrorBoundary aria-live="polite">
                  {invoiceStatusData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie
                          data={invoiceStatusData}
                          cx="50%"
                          cy="45%"
                          innerRadius={55}
                          outerRadius={85}
                          paddingAngle={4}
                          dataKey="value"
                          label={({ percent }) => (percent >= 0.05 ? `${(percent * 100).toFixed(0)}%` : "")}
                        >
                          {invoiceStatusData.map((entry, idx) => (
                            <Cell key={idx} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v, name) => [v, `Invoices (${name})`]} />
                        <Legend verticalAlign="bottom" height={36} formatter={(value) => <span className="text-xs text-slate-600 font-medium">{value}</span>} />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyStateWidget
                      title="No invoices found"
                      message="There are no invoices for the selected period."
                      icon={FileText}
                      ctaText="Create Invoice"
                      ctaHref="/billing/invoices/create"
                    />
                  )}
                </ChartErrorBoundary>
              </ChartCard>
            </WidgetErrorBoundary>

            <WidgetErrorBoundary title="Subscription Distribution">
              <ChartCard title="Subscription Distribution">
                <ChartErrorBoundary aria-live="polite">
                  {subscriptionChartData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={subscriptionChartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} />
                        <Tooltip content={<ChartTooltip format={(v) => v.toLocaleString("en-US")} />} />
                        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                          {subscriptionChartData.map((_, idx) => (
                            <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyStateWidget message="No subscription data available" icon={UserCheck} />
                  )}
                </ChartErrorBoundary>
              </ChartCard>
            </WidgetErrorBoundary>

            <WidgetErrorBoundary title="Outstanding Aging">
              <ChartCard title="Outstanding Aging">
                <ChartErrorBoundary aria-live="polite">
                  {agingData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={agingData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey={agingData[0]?.bucket ? "bucket" : "name"} tick={{ fontSize: 12 }} />
                        <YAxis tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 12 }} />
                        <Tooltip content={<ChartTooltip format={(v) => formatDisplayCurrency(v, baseCurrency)} />} />
                        <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                          {agingData.map((_, idx) => (
                            <Cell key={idx} fill={idx === 0 ? "#10b981" : idx === 1 ? "#f59e0b" : idx === 2 ? "#ef4444" : "#FF7A00"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyStateWidget message="No aging data available" icon={Clock} />
                  )}
                </ChartErrorBoundary>
              </ChartCard>
            </WidgetErrorBoundary>
          </div>

          <div className={DASHBOARD_CHART_GRID}>
            <WidgetErrorBoundary title="Recent Invoices">
              <ChartCard title="Recent Invoices" action={<button onClick={() => navigate("/billing/invoices")} className="text-sm font-medium text-[#FF7A00] hover:text-[#FF5500] flex items-center gap-1">View All <ChevronRight size={14} /></button>}>
                <DataTable columns={invoiceColumns} data={d.invoices.slice(0, 5)} emptyTitle="No invoices yet" emptyMessage={null} emptyIcon={FileText} />
              </ChartCard>
            </WidgetErrorBoundary>

            <WidgetErrorBoundary title="Recent Payments">
              <ChartCard title="Recent Payments" action={<button onClick={() => navigate("/billing/payments")} className="text-sm font-medium text-[#FF7A00] hover:text-[#FF5500] flex items-center gap-1">View All <ChevronRight size={14} /></button>}>
                <DataTable columns={paymentColumns} data={d.payments.slice(0, 5)} emptyTitle="No payments yet" emptyMessage={null} emptyIcon={Receipt} />
              </ChartCard>
            </WidgetErrorBoundary>
          </div>

          <div className={DASHBOARD_CHART_GRID}>
            <WidgetErrorBoundary title="Recent Customers">
              <ChartCard title="Recent Customers" action={<button onClick={() => navigate("/billing/customers")} className="text-sm font-medium text-[#FF7A00] hover:text-[#FF5500] flex items-center gap-1">View All <ChevronRight size={14} /></button>}>
                <DataTable columns={customerColumns} data={d.customers.slice(0, 5)} emptyTitle="No customers yet" emptyMessage={null} emptyIcon={Users} />
              </ChartCard>
            </WidgetErrorBoundary>

            <WidgetErrorBoundary title="Upcoming Renewals">
              <ChartCard title="Upcoming Renewals" action={<button onClick={() => navigate("/billing/contracts")} className="text-sm font-medium text-[#FF7A00] hover:text-[#FF5500] flex items-center gap-1">View All <ChevronRight size={14} /></button>}>
                <DataTable columns={renewalColumns} data={d.expiringContracts.slice(0, 5)} emptyTitle="No upcoming renewals" emptyMessage={null} emptyIcon={Clock} />
              </ChartCard>
            </WidgetErrorBoundary>
          </div>

          <WidgetErrorBoundary title="Recent Activities">
            <ChartCard title="Recent Activities">
              <DataTable columns={activityColumns} data={d.auditLogs.slice(0, 10)} emptyTitle="No recent activity" emptyMessage={null} emptyIcon={FileText} />
            </ChartCard>
          </WidgetErrorBoundary>
        </div>
      )}
    </div>
  );
}
