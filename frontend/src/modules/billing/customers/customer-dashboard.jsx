import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Users, DollarSign, FileText, TrendingUp, Clock, CheckCircle, AlertCircle, RefreshCw, CreditCard, UserPlus, Target, Inbox, Globe, Sparkles, ChevronRight, Activity, Upload } from "lucide-react";
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area } from "recharts";
import { customerApi } from "../../../service/billingService";
import { extractArray } from "../../../utils/billing-helpers";
import { formatDisplayCurrency } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { useTerminology } from "../utils/TerminologyContext";
import { useBillingDateRange, DASHBOARD_DATE_RANGE_OPTIONS } from "../utils/DateRangeContext";
import {
  DashboardHeader, DashboardStatCard, DashboardStatCardSkeleton, DashboardChartCard,
  DashboardChartCardSkeleton, DashboardChartErrorBoundary, DashboardEmptyPanel,
  DASHBOARD_KPI_GRID, DASHBOARD_CHART_GRID, DASHBOARD_CHART_GRID_3,
  exportDashboardToCsv, exportDashboardToJson, ErrorState, BusinessInsights, QuickActions, ActionCenter,
} from "../../../components/billing-shared";
import { Button, StatGroup } from "../../../components/billing-ui";

const COLORS = ["#FF7A00", "#FF9B4D", "#FFC9A6", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4898", "#14b8a6", "#f97316"];

function formatRelativeTime(dateStr) {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "—";
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHrs < 24) return `${diffHrs}h ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function CustomerDashboard() {
  const navigate = useNavigate();
  const { baseCurrency } = useCurrency();
  const { singular, plural } = useTerminology();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [kpiData, setKpiData] = useState(null);
  const [customerSample, setCustomerSample] = useState([]);
  const {
    range: dateRangeValue, setRange: setDateRangeValue,
    customStart, customEnd, applyCustomRange, reset: resetDateRange,
    dateRange,
  } = useBillingDateRange();

  const hasLoadedOnce = useRef(false);

  const fetchData = async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      const [data, customersResp] = await Promise.all([
        customerApi.getKPI(undefined, dateRange),
        customerApi.list({ per_page: 200, sort_by: "created_at", sort_order: "desc" }).catch(() => null),
      ]);
      setKpiData(data);
      if (customersResp) setCustomerSample(extractArray(customersResp));
      setLastUpdated(new Date());
    } catch (err) {
      setError(err?.message || "Failed to load customer dashboard data");
    } finally {
      setLoading(false);
      setRefreshing(false);
      hasLoadedOnce.current = true;
    }
  };

  useEffect(() => {
    fetchData(hasLoadedOnce.current);
  }, [dateRange.date_from, dateRange.date_to]);

  const d = kpiData || {};
  const revenueByCustomer = Array.isArray(d.revenue_by_customer) ? d.revenue_by_customer : [];
  const outstandingByCustomer = Array.isArray(d.outstanding_by_customer) ? d.outstanding_by_customer : [];

  // Derived from the actual customer sample (real created_at/customer_type
  // values) rather than a synthetic percentage of total_customers — the KPI
  // endpoint doesn't return a per-month or per-type breakdown, so this reads
  // it straight from the customer list already fetched for the dashboard.
  const customerGrowthData = useMemo(() => {
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
        month: date.toLocaleString("en-US", { month: "short", year: "numeric" }),
        new: 0,
      });
    }
    const byKey = Object.fromEntries(months.map((m) => [m.key, m]));
    customerSample.forEach((c) => {
      if (!c.created_at) return;
      const created = new Date(c.created_at);
      const key = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, "0")}`;
      if (byKey[key]) byKey[key].new += 1;
    });
    let running = Math.max((d.total_customers || 0) - months.reduce((s, m) => s + byKey[m.key].new, 0), 0);
    return months.map((m) => {
      running += byKey[m.key].new;
      return { month: m.month, new: byKey[m.key].new, cumulative: running };
    });
  }, [customerSample, d.total_customers]);

  const statusData = [
    { name: "Active", value: d.active_customers || 0, color: "#10b981" },
    { name: "Inactive", value: d.inactive_customers || 0, color: "#6b7280" },
  ].filter((x) => x.value > 0);

  const categoryData = useMemo(() => {
    const labels = { business: "Business", individual: "Individual", government: "Government", non_profit: "Non-Profit" };
    const colors = { business: "#FF7A00", individual: "#FF9B4D", government: "#FFC9A6", non_profit: "#f59e0b" };
    const counts = {};
    customerSample.forEach((c) => {
      const type = c.customer_type || "business";
      counts[type] = (counts[type] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([type, value]) => ({ name: labels[type] || type, value, color: colors[type] || "#6b7280" }))
      .filter((x) => x.value > 0);
  }, [customerSample]);

  // Country breakdown isn't returned by the KPI endpoint, so — same pattern
  // as customerGrowthData/categoryData above — it's aggregated client-side
  // from the already-fetched customer sample's billing_country field.
  const countryData = useMemo(() => {
    const counts = {};
    customerSample.forEach((c) => {
      const country = c.billing_country || c.shipping_country || "Unknown";
      counts[country] = (counts[country] || 0) + 1;
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 7).map(([name, value], i) => ({ name, value, color: COLORS[i % COLORS.length] }));
    const restTotal = sorted.slice(7).reduce((sum, [, v]) => sum + v, 0);
    if (restTotal > 0) top.push({ name: "Other", value: restTotal, color: "#94a3b8" });
    return top;
  }, [customerSample]);

  // Number of customers created within the current calendar month — read
  // straight off the last bucket of customerGrowthData (which already walks
  // the real customer sample month-by-month) rather than duplicating that
  // aggregation here.
  const newThisMonth = customerGrowthData.length > 0 ? customerGrowthData[customerGrowthData.length - 1].new : 0;

  const customerNameMap = useMemo(() => {
    const map = {};
    customerSample.forEach((c) => {
      map[c.id] = c.display_name || c.company_name || `Customer #${c.id}`;
    });
    return map;
  }, [customerSample]);
  const getCustomerName = useCallback((id) => customerNameMap[id] || `Customer #${id}`, [customerNameMap]);

  const revenueChartData = revenueByCustomer.slice(0, 8).map((r) => ({
    name: getCustomerName(r.customer_id),
    revenue: r.revenue,
  }));

  const outstandingChartData = outstandingByCustomer.slice(0, 8).map((r) => ({
    name: getCustomerName(r.customer_id),
    outstanding: r.outstanding,
  }));

  const topCustomersChartData = useMemo(
    () => revenueByCustomer.slice(0, 5).map((r) => ({ ...r, name: getCustomerName(r.customer_id) })),
    [revenueByCustomer, getCustomerName]
  );

  // Recent Activity: the customer module has no cross-customer activity/audit
  // feed endpoint (customerApi.getActivity(id) is per-customer only), so the
  // most truthful proxy available is the newest customer records themselves —
  // customerSample is already fetched sorted by created_at desc.
  const recentCustomers = useMemo(() => customerSample.slice(0, 5), [customerSample]);

  const periodLabel = DASHBOARD_DATE_RANGE_OPTIONS.find((o) => o.value === dateRangeValue)?.label || "Custom Range";

  // Built entirely from KPI/customer-sample data already fetched above —
  // no additional requests.
  const insightItems = useMemo(() => {
    const items = [];
    if (newThisMonth > 0) {
      items.push({ tone: "up", icon: Sparkles, text: `${newThisMonth} ${(newThisMonth === 1 ? singular : plural).toLowerCase()} joined this month` });
    }
    if (d.customers_with_outstanding_balance > 0) {
      items.push({ tone: "warning", icon: AlertCircle, text: `${d.customers_with_outstanding_balance} ${plural.toLowerCase()} with an outstanding balance` });
    }
    if (d.customers_over_credit_limit > 0) {
      items.push({ tone: "down", icon: Target, text: `${d.customers_over_credit_limit} ${plural.toLowerCase()} over their credit limit — review before further credit` });
    }
    if (!items.length) {
      items.push({ tone: "up", icon: CheckCircle, text: `All ${plural.toLowerCase()} are current with no outstanding balances` });
    }
    return items;
  }, [newThisMonth, d.customers_with_outstanding_balance, d.customers_over_credit_limit, singular, plural]);

  // Built entirely from KPI/customer-sample data already fetched above —
  // no additional requests.
  const actionItems = useMemo(() => {
    const items = [];
    if (d.customers_over_credit_limit > 0) {
      items.push({
        icon: Target, tone: "danger", priority: "high",
        title: `${d.customers_over_credit_limit} ${(d.customers_over_credit_limit === 1 ? singular : plural).toLowerCase()} over credit limit`,
        description: "May need a credit hold or follow-up",
        href: "/billing/customers",
      });
    }
    if (outstandingByCustomer.length > 0) {
      const totalOutstanding = outstandingByCustomer.reduce((sum, r) => sum + (r.outstanding || 0), 0);
      items.push({
        icon: AlertCircle, tone: "warning", priority: "medium",
        title: `${outstandingByCustomer.length} ${(outstandingByCustomer.length === 1 ? singular : plural).toLowerCase()} with an outstanding balance`,
        description: `${formatDisplayCurrency(totalOutstanding, baseCurrency)} total outstanding`,
        href: "/billing/customers",
      });
    }
    return items.slice(0, 4);
  }, [d.customers_over_credit_limit, outstandingByCustomer, singular, plural, baseCurrency]);

  const customerQuickActions = useMemo(() => [
    { label: "Add Customer", hint: `Create a new ${singular.toLowerCase()} record`, href: "/billing/customers", icon: UserPlus },
    { label: "Import Customers", hint: `Bulk import ${plural.toLowerCase()} from a file`, href: "/billing/customers", icon: Upload },
    { label: "Create Invoice", hint: "Start a new invoice", href: "/billing/invoices/create", icon: FileText },
  ], [singular, plural]);

  const handleExport = useCallback((format) => {
    const payload = {
      kpi_summary: d,
      revenue_by_customer: revenueByCustomer,
      outstanding_by_customer: outstandingByCustomer,
      recent_customers: customerSample,
    };
    if (format === "csv") exportDashboardToCsv(payload, "customer-dashboard");
    else exportDashboardToJson(payload, "customer-dashboard");
  }, [d, revenueByCustomer, outstandingByCustomer, customerSample]);

  const headerProps = {
    title: `${plural} Dashboard`,
    subtitle: `${plural} analytics, KPIs, and performance metrics`,
    icon: Users,
    iconGradient: "from-brand to-brand-hover",
    crumbs: [{ label: "Billing", href: "/billing" }, { label: plural }],
    primaryAction: <Button variant="primary" icon={UserPlus} onClick={() => navigate("/billing/customers")}>Add {singular}</Button>,
    lastUpdated,
    onRefresh: () => fetchData(true),
    refreshing,
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
      <div className="space-y-8" aria-label={`Loading ${plural.toLowerCase()} dashboard`}>
        <DashboardHeader {...headerProps} />
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 5 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)}
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 5 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)}
        </div>
        <div className={DASHBOARD_CHART_GRID_3}>
          <DashboardChartCardSkeleton />
          <DashboardChartCardSkeleton />
          <DashboardChartCardSkeleton />
        </div>
      </div>
    );
  }

  if (error && !kpiData) {
    return (
      <div className="space-y-8">
        <DashboardHeader {...headerProps} />
        <ErrorState message={error} onRetry={() => fetchData(true)} title="Something went wrong" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <DashboardHeader {...headerProps} />

      {error && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2"><AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}</span>
          <button onClick={() => fetchData(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-100 hover:bg-red-200 text-red-700 text-xs font-semibold transition-colors shrink-0">
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      )}

      <BusinessInsights items={insightItems} />

      <ActionCenter items={actionItems} />

      <div className={DASHBOARD_KPI_GRID}>
        <DashboardStatCard title={`${periodLabel} Revenue`} value={Number(d.period_revenue || 0)} currency={baseCurrency} subtitle="Revenue in period" icon={DollarSign} color="from-emerald-500 to-emerald-600" />
        <DashboardStatCard title={`${periodLabel} Invoices`} value={d.period_total_invoices || 0} subtitle={`${d.period_paid_invoices || 0} paid`} icon={FileText} color="from-blue-500 to-blue-600" href="/billing/invoices" />
        <DashboardStatCard title={`${periodLabel} Avg Invoice`} value={Number(d.period_avg_invoice_value || 0)} currency={baseCurrency} subtitle="Average invoice value" icon={TrendingUp} color="from-brand to-brand-hover" />
        <DashboardStatCard title={`New ${plural} (${periodLabel})`} value={d.period_new_customers || 0} subtitle="Joined in period" icon={UserPlus} color="from-cyan-500 to-cyan-600" href="/billing/customers" />
      </div>

      <StatGroup title="More Metrics">
        <DashboardStatCard title={`Total ${plural}`} value={d.total_customers || 0} subtitle="All registered (lifetime)" icon={Users} color="from-brand to-brand-hover" href="/billing/customers" />
        <DashboardStatCard title="Active" value={d.active_customers || 0} subtitle={`${d.total_customers ? Math.round((d.active_customers / d.total_customers) * 100) : 0}% of total`} icon={CheckCircle} color="from-green-500 to-emerald-500" href="/billing/customers?status=active" />
        <DashboardStatCard title="Inactive" value={d.inactive_customers || 0} subtitle={`${d.total_customers ? Math.round((d.inactive_customers / d.total_customers) * 100) : 0}% of total`} icon={Clock} color="from-gray-500 to-slate-600" href="/billing/customers?status=inactive" />
        <DashboardStatCard title="New This Month" value={newThisMonth} subtitle="Joined in the current calendar month" icon={Sparkles} color="from-cyan-500 to-blue-500" href="/billing/customers" />
        <DashboardStatCard title="Avg Revenue/Customer" value={Number(d.avg_revenue_per_customer || 0)} currency={baseCurrency} subtitle="Average per customer (lifetime)" icon={DollarSign} color="from-emerald-500 to-emerald-600" />
      </StatGroup>

      <StatGroup title="Revenue & Collections">
        <DashboardStatCard title="Total Revenue" value={Number(d.total_revenue || 0)} currency={baseCurrency} subtitle="All time" icon={TrendingUp} color="from-blue-500 to-blue-600" />
        <DashboardStatCard title="Outstanding Balance" value={Number(d.outstanding_balance || 0)} currency={baseCurrency} subtitle="Unpaid invoices" icon={CreditCard} color="from-orange-500 to-orange-600" href="/billing/invoices" />
        <DashboardStatCard title="Avg Collection Period" value={`${d.avg_collection_time_days || 0} days`} subtitle="Days to collect" icon={Clock} color="from-cyan-500 to-cyan-600" />
        <DashboardStatCard title="w/ Outstanding" value={d.customers_with_outstanding_balance || 0} subtitle="Have unpaid balance" icon={AlertCircle} color="from-amber-500 to-orange-500" href="/billing/invoices" />
        <DashboardStatCard title="Over Credit Limit" value={d.customers_over_credit_limit || 0} subtitle="Exceeded limit" icon={Target} color="from-red-500 to-rose-500" />
      </StatGroup>

      <QuickActions actions={customerQuickActions} />

      <div className={DASHBOARD_CHART_GRID_3}>
        <DashboardChartCard title={`${singular} Status`}>
          <DashboardChartErrorBoundary>
            {statusData.length === 0 ? (
              <DashboardEmptyPanel title="No status data" message={`${singular} status will appear here`} icon={Inbox} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={statusData} cx="50%" cy="50%" outerRadius={90} innerRadius={50} paddingAngle={3} dataKey="value">
                    {statusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title={`${singular} Growth`}>
          <DashboardChartErrorBoundary>
            {customerGrowthData.length === 0 ? (
              <DashboardEmptyPanel title="No growth data" message={`${singular} growth trends will appear here`} icon={Inbox} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={customerGrowthData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="cumulative" stroke="#FF7A00" fill="#FFC9A6" strokeWidth={2} name={plural} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title={`${singular} Type`}>
          <DashboardChartErrorBoundary>
            {categoryData.length === 0 ? (
              <DashboardEmptyPanel title="No type data" message={`${singular} types will appear here`} icon={Inbox} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={categoryData} cx="50%" cy="50%" outerRadius={90} innerRadius={50} paddingAngle={3} dataKey="value">
                    {categoryData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title="Country Distribution">
          <DashboardChartErrorBoundary>
            {countryData.length === 0 ? (
              <DashboardEmptyPanel title="No country data" message={`${singular} countries will appear here`} icon={Globe} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={countryData} cx="50%" cy="50%" outerRadius={90} innerRadius={50} paddingAngle={3} dataKey="value"
                    label={({ percent }) => (percent >= 0.08 ? `${(percent * 100).toFixed(0)}%` : "")}>
                    {countryData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip formatter={(v, name) => [v, name]} />
                  <Legend formatter={(value) => <span className="text-xs text-slate-600 font-medium">{value}</span>} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>
      </div>

      <div className={DASHBOARD_CHART_GRID}>
        <DashboardChartCard title={`Revenue by ${singular}`}>
          <DashboardChartErrorBoundary>
            {revenueChartData.length === 0 ? (
              <DashboardEmptyPanel title="No revenue data" message={`Revenue by ${singular.toLowerCase()} will appear here`} icon={Inbox} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={revenueChartData} margin={{ bottom: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={50}
                    tickFormatter={(v) => (v.length > 12 ? `${v.slice(0, 12)}…` : v)} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatDisplayCurrency(v, baseCurrency)} />
                  <Tooltip formatter={(v) => formatDisplayCurrency(v, baseCurrency)} />
                  <Bar dataKey="revenue" fill="#FF7A00" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title={`Outstanding by ${singular}`}>
          <DashboardChartErrorBoundary>
            {outstandingChartData.length === 0 ? (
              <DashboardEmptyPanel title="No outstanding data" message="Outstanding balances will appear here" icon={Inbox} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={outstandingChartData} margin={{ bottom: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-20} textAnchor="end" height={50}
                    tickFormatter={(v) => (v.length > 12 ? `${v.slice(0, 12)}…` : v)} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatDisplayCurrency(v, baseCurrency)} />
                  <Tooltip formatter={(v) => formatDisplayCurrency(v, baseCurrency)} />
                  <Bar dataKey="outstanding" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>
      </div>

      <div className={DASHBOARD_CHART_GRID_3}>
        <DashboardChartCard title="Payment Trends">
          <DashboardChartErrorBoundary>
            <div className="flex flex-col items-center justify-center h-64 text-gray-400">
              <div className="grid grid-cols-2 gap-6 text-center">
                <div>
                  <p className="text-2xl font-bold text-brand-600 whitespace-nowrap">{d.paid_invoices || 0}</p>
                  <p className="text-xs text-gray-500 mt-1">Paid Invoices</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-amber-600 whitespace-nowrap">{d.total_invoices - d.paid_invoices || 0}</p>
                  <p className="text-xs text-gray-500 mt-1">Unpaid</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-emerald-600 whitespace-nowrap">{d.open_quotations || 0}</p>
                  <p className="text-xs text-gray-500 mt-1">Open Quotations</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-blue-600 whitespace-nowrap">{d.active_subscriptions || 0}</p>
                  <p className="text-xs text-gray-500 mt-1">Active Subscriptions</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4 mt-6 w-full max-w-sm">
                <div className="text-center p-2 bg-green-50 rounded-lg">
                  <p className="text-lg font-bold text-green-700">{d.active_contracts || 0}</p>
                  <p className="text-xs text-green-600">Contracts</p>
                </div>
                <div className="text-center p-2 bg-blue-50 rounded-lg">
                  <p className="text-lg font-bold text-blue-700 whitespace-nowrap">{formatDisplayCurrency(d.credit_notes_total || 0, baseCurrency)}</p>
                  <p className="text-xs text-blue-600">Credit Notes</p>
                </div>
                <div className="text-center p-2 bg-red-50 rounded-lg">
                  <p className="text-lg font-bold text-red-700 whitespace-nowrap">{formatDisplayCurrency(d.refunds_total || 0, baseCurrency)}</p>
                  <p className="text-xs text-red-600">Refunds</p>
                </div>
              </div>
            </div>
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title={`Top ${plural} by Revenue`}
          action={<button onClick={() => navigate("/billing/customers")} className="text-sm font-medium text-[#FF7A00] hover:text-[#FF5500] flex items-center gap-1">View All <ChevronRight size={14} /></button>}>
          <DashboardChartErrorBoundary>
            {topCustomersChartData.length === 0 ? (
              <DashboardEmptyPanel title={`No top ${plural.toLowerCase()} data`} message={`Top ${plural.toLowerCase()} by revenue will appear here`} icon={Inbox} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={topCustomersChartData} layout="vertical" margin={{ left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => formatDisplayCurrency(v, baseCurrency)} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={90}
                    tickFormatter={(v) => (v.length > 14 ? `${v.slice(0, 14)}…` : v)} />
                  <Tooltip formatter={(v) => formatDisplayCurrency(v, baseCurrency)} />
                  <Bar dataKey="revenue" fill="#FF7A00" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title="Recent Activity"
          action={<button onClick={() => navigate("/billing/customers")} className="text-sm font-medium text-[#FF7A00] hover:text-[#FF5500] flex items-center gap-1">View All <ChevronRight size={14} /></button>}>
          <DashboardChartErrorBoundary>
            {recentCustomers.length === 0 ? (
              <DashboardEmptyPanel title="No recent activity" message={`Newly added ${plural.toLowerCase()} will appear here`} icon={Activity} ctaText="Add Customer" onCtaClick={() => navigate("/billing/customers")} />
            ) : (
              <div className="space-y-3">
                {recentCustomers.map((c) => {
                  const name = c.display_name || c.company_name || `${singular} #${c.id}`;
                  const status = c.status ? c.status.charAt(0).toUpperCase() + c.status.slice(1) : "Active";
                  return (
                    <div key={c.id}
                      className="flex items-center gap-3 p-2 rounded-lg hover:bg-slate-50 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
                      role="button" tabIndex={0}
                      onClick={() => navigate(`/billing/customers/${c.id}`)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); navigate(`/billing/customers/${c.id}`); } }}>
                      <div className="h-8 w-8 rounded-full bg-gradient-to-br from-brand to-brand-hover text-white flex items-center justify-center text-xs font-bold shrink-0">
                        {name.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{name}</p>
                        <p className="text-xs text-gray-400 truncate">{status} {singular.toLowerCase()} · joined {formatRelativeTime(c.created_at)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>
      </div>
    </div>
  );
}
