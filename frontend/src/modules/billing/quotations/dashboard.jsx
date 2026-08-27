import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  FileSignature, DollarSign, Clock, Send, CheckCircle, XCircle, RefreshCw,
  TrendingUp, Users, Inbox, AlertCircle, FileText, Ban, ChevronRight,
  PlusCircle, List, BarChart3, Settings, CalendarClock,
} from "lucide-react";
import { PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, Area, Line, ComposedChart } from "recharts"
import { quoteApi, customerApi } from "../../../service/billingService";
import { extractArray, formatDisplayCurrency } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { useBillingDateRange } from "../utils/DateRangeContext";
import {
  DashboardHeader, DashboardStatCard, DashboardStatCardSkeleton, DashboardChartCard,
  DashboardChartCardSkeleton, DashboardChartErrorBoundary, DashboardEmptyPanel,
  DASHBOARD_KPI_GRID, DASHBOARD_CHART_GRID,
  exportDashboardToCsv, exportDashboardToJson, ErrorState, StatusBadge,
  BusinessInsights, QuickActions, ActionCenter,
} from "../../../components/billing-shared";
import { Button, DataTable, StatGroup } from "../../../components/billing-ui";

// Generous single-page fetch for a client-side-aggregated summary view — there
// is no dedicated quotation dashboard-stats/KPI endpoint (unlike invoices or
// customers), so every KPI/chart here is derived from this one list call, the
// same approach customer-dashboard.jsx and products/dashboard.jsx use for
// data that doesn't have its own stats endpoint. "Total Quotations" uses the
// server-reported `total` (accurate even beyond this page); every other
// figure (status mix, revenue, top customers, trend) is computed over the
// quotations actually returned by this page, so orgs with more than
// PAGE_SIZE quotations in the selected range will see those breakdowns
// approximated from the most recent PAGE_SIZE records rather than the exact
// full set.
const PAGE_SIZE = 200;

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft", color: "bg-slate-100 text-slate-600" },
  { value: "sent", label: "Sent", color: "bg-blue-100 text-blue-700" },
  { value: "accepted", label: "Accepted", color: "bg-emerald-100 text-emerald-700" },
  { value: "rejected", label: "Rejected", color: "bg-red-100 text-red-700" },
  { value: "cancelled", label: "Cancelled", color: "bg-amber-100 text-amber-700" },
  { value: "converted", label: "Converted", color: "bg-brand-100 text-brand-700" },
  { value: "expired", label: "Expired", color: "bg-slate-100 text-slate-500" },
];
const STATUS_ICONS = { draft: Clock, sent: Send, accepted: CheckCircle, rejected: XCircle, cancelled: Ban, converted: RefreshCw, expired: Clock };
const STATUS_COLORS = { draft: "#6b7280", sent: "#3b82f6", accepted: "#10b981", rejected: "#ef4444", cancelled: "#f59e0b", converted: "var(--color-accent-invoicing)", expired: "#94a3b8" };

export default function QuotationDashboardPage() {
  const navigate = useNavigate();
  const { baseCurrency } = useCurrency();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [quotes, setQuotes] = useState([]);
  const [total, setTotal] = useState(0);
  const [customers, setCustomers] = useState([]);
  const {
    range: dateRangeValue, setRange: setDateRangeValue,
    customStart, customEnd, applyCustomRange, reset: resetDateRange,
    dateRange,
  } = useBillingDateRange();

  const hasLoadedOnce = useRef(false);

  const fetchData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      const [quotesResp, customersResp] = await Promise.all([
        quoteApi.list({
          per_page: PAGE_SIZE,
          sort_by: "created_at", sort_order: "desc",
          date_from: dateRange.date_from || undefined,
          date_to: dateRange.date_to || undefined,
        }),
        customerApi.list({ per_page: 200 }).catch(() => null),
      ]);
      const items = extractArray(quotesResp);
      setQuotes(items);
      setTotal(Number(quotesResp?.total ?? items.length));
      if (customersResp) setCustomers(extractArray(customersResp));
      setLastUpdated(new Date());
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load quotation dashboard data");
    } finally {
      setLoading(false);
      setRefreshing(false);
      hasLoadedOnce.current = true;
    }
  }, [dateRange.date_from, dateRange.date_to]);

  useEffect(() => { fetchData(hasLoadedOnce.current); }, [fetchData]);

  const customerMap = useMemo(() => {
    const map = {};
    customers.forEach((c) => {
      map[c.id] = c.display_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.company_name || `Customer #${c.id}`;
    });
    return map;
  }, [customers]);

  const getCustomerName = useCallback((q) => q.customer_name || q.customer?.name || customerMap[q.customer_id] || `Customer #${q.customer_id}`, [customerMap]);

  const byStatus = useMemo(() => {
    const groups = {};
    quotes.forEach((q) => {
      const s = q.status || "draft";
      (groups[s] = groups[s] || []).push(q);
    });
    return groups;
  }, [quotes]);

  const countOf = (status) => (byStatus[status] || []).length;
  const draftCount = countOf("draft");
  const sentCount = countOf("sent");
  const acceptedCount = countOf("accepted");
  const rejectedCount = countOf("rejected");
  const convertedCount = countOf("converted");
  const cancelledCount = countOf("cancelled") + countOf("expired");

  const revenue = useMemo(() => (
    [...(byStatus.accepted || []), ...(byStatus.converted || [])]
      .reduce((s, q) => s + parseFloat(q.total_amount || q.total || 0), 0)
  ), [byStatus]);

  const wonForRate = acceptedCount + convertedCount;
  const decidedForRate = wonForRate + rejectedCount + sentCount;
  const conversionRate = decidedForRate > 0 ? (wonForRate / decidedForRate) * 100 : 0;

  const statusChartData = useMemo(() => (
    STATUS_OPTIONS.filter((o) => o.value !== "expired")
      .map((o) => ({ name: o.label, value: o.value === "cancelled" ? cancelledCount : countOf(o.value), color: STATUS_COLORS[o.value] }))
      .filter((d) => d.value > 0)
  ), [byStatus, cancelledCount]);

  // Last 6 calendar months of quotation volume/value, read straight from the
  // fetched sample's created_at (same derivation pattern customer-dashboard.jsx
  // uses for customer growth, since there's no monthly-trend endpoint here).
  const monthlyTrend = useMemo(() => {
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, month: d.toLocaleString("en-US", { month: "short", year: "numeric" }), count: 0, value: 0 });
    }
    const byKey = Object.fromEntries(months.map((m) => [m.key, m]));
    quotes.forEach((q) => {
      if (!q.created_at) return;
      const created = new Date(q.created_at);
      const key = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, "0")}`;
      if (byKey[key]) {
        byKey[key].count += 1;
        byKey[key].value += parseFloat(q.total_amount || q.total || 0);
      }
    });
    return months;
  }, [quotes]);

  const topCustomers = useMemo(() => {
    const totals = {};
    quotes.forEach((q) => {
      if (!q.customer_id) return;
      const key = q.customer_id;
      if (!totals[key]) totals[key] = { customer_id: key, name: getCustomerName(q), value: 0, count: 0 };
      totals[key].value += parseFloat(q.total_amount || q.total || 0);
      totals[key].count += 1;
    });
    return Object.values(totals).sort((a, b) => b.value - a.value).slice(0, 8);
  }, [quotes, getCustomerName]);

  const recentQuotations = useMemo(() => (
    [...quotes].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).slice(0, 8)
  ), [quotes]);

  // Sent quotations whose valid_until falls within the next 7 days — a
  // "renew or lose the deal" signal derived from data already fetched.
  const expiringSoonCount = useMemo(() => {
    const now = Date.now();
    const soon = now + 7 * 86400000;
    return (byStatus.sent || []).filter((q) => {
      if (!q.valid_until) return false;
      const t = new Date(q.valid_until).getTime();
      return !Number.isNaN(t) && t >= now && t <= soon;
    }).length;
  }, [byStatus]);

  const insightItems = useMemo(() => {
    const items = [];
    if (sentCount > 0) {
      items.push({ tone: "neutral", icon: Send, text: `${sentCount} quotation${sentCount === 1 ? "" : "s"} awaiting customer response` });
    }
    if (expiringSoonCount > 0) {
      items.push({ tone: "warning", icon: CalendarClock, text: `${expiringSoonCount} quotation${expiringSoonCount === 1 ? "" : "s"} expiring within 7 days` });
    }
    if (decidedForRate > 0) {
      items.push({ tone: conversionRate >= 50 ? "up" : "neutral", icon: TrendingUp, text: `${conversionRate.toFixed(1)}% conversion rate` });
    }
    if (draftCount > 0) {
      items.push({ tone: "neutral", icon: Clock, text: `${draftCount} draft${draftCount === 1 ? "" : "s"} not yet sent` });
    }
    if (!items.length) {
      items.push({ tone: "up", icon: CheckCircle, text: "No quotations need attention right now" });
    }
    return items;
  }, [sentCount, expiringSoonCount, decidedForRate, conversionRate, draftCount]);

  // Aggregate, actionable follow-ups — one row per issue type, not one per
  // record. Both counts are derived from data already fetched for this page.
  const actionItems = useMemo(() => {
    const items = [];
    if (expiringSoonCount > 0) {
      items.push({
        icon: CalendarClock, tone: "warning", priority: "medium",
        title: `${expiringSoonCount} quotation${expiringSoonCount === 1 ? "" : "s"} expiring within 7 days`,
        description: "Follow up before they lapse",
        href: "/billing/quotations",
      });
    }
    const now = Date.now();
    const expiredUnansweredCount = quotes.filter((q) => {
      if (q.status !== "sent" || !q.valid_until) return false;
      const t = new Date(q.valid_until).getTime();
      return !Number.isNaN(t) && t < now;
    }).length;
    if (expiredUnansweredCount > 0) {
      items.push({
        icon: AlertCircle, tone: "danger", priority: "high",
        title: `${expiredUnansweredCount} sent quotation${expiredUnansweredCount === 1 ? "" : "s"} have expired unanswered`,
        description: "Customer never responded before the quote lapsed",
        href: "/billing/quotations",
      });
    }
    return items;
  }, [expiringSoonCount, quotes]);

  const quotationQuickActions = useMemo(() => [
    { label: "New Quotation", hint: "Create a quotation for a customer", href: "/billing/quotations/create", icon: PlusCircle },
    { label: "All Quotations", hint: "Browse and manage quotations", href: "/billing/quotations", icon: List },
    { label: "Reports", hint: "Pipeline and revenue reporting", href: "/billing/quotations/reports", icon: BarChart3 },
    { label: "Settings", hint: "Templates, numbering, and defaults", href: "/billing/quotations/settings", icon: Settings },
  ], []);

  const topCustomerColumns = useMemo(() => [
    { key: "name", label: "Customer", render: (c) => (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/billing/customers/${c.customer_id}`); }}
        className="font-medium text-slate-800 hover:text-brand-600 transition-colors text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 rounded">
        {c.name}
      </button>
    ) },
    { key: "count", label: "Quotations", align: "right", render: (c) => c.count },
    { key: "value", label: "Value", align: "right", render: (c) => <span className="font-semibold text-slate-800">{formatDisplayCurrency(c.value, baseCurrency)}</span> },
  ], [navigate, baseCurrency]);

  const recentQuotationColumns = useMemo(() => [
    { key: "quote_number", label: "Quotation", render: (q) => (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/billing/quotations/${q.id}`); }}
        className="font-medium text-slate-800 hover:text-brand-600 transition-colors whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 rounded">
        {q.quote_number || `#${q.id}`}
      </button>
    ) },
    { key: "customer", label: "Customer", render: (q) => getCustomerName(q) },
    { key: "amount", label: "Amount", align: "right", render: (q) => <span className="font-medium text-slate-800">{formatDisplayCurrency(q.total_amount || q.total, q.currency || baseCurrency)}</span> },
    { key: "status", label: "Status", render: (q) => <StatusBadge status={q.status} options={STATUS_OPTIONS} icon={STATUS_ICONS[q.status] || Clock} /> },
  ], [navigate, getCustomerName, baseCurrency]);

  const handleExport = useCallback((format) => {
    const payload = {
      summary: {
        total_quotations: total, draft: draftCount, sent: sentCount, accepted: acceptedCount,
        rejected: rejectedCount, converted: convertedCount, cancelled_or_expired: cancelledCount,
        revenue, conversion_rate: conversionRate,
      },
      monthly_trend: monthlyTrend,
      top_customers: topCustomers,
      recent_quotations: recentQuotations,
    };
    if (format === "csv") exportDashboardToCsv(payload, "quotation-dashboard");
    else exportDashboardToJson(payload, "quotation-dashboard");
  }, [total, draftCount, sentCount, acceptedCount, rejectedCount, convertedCount, cancelledCount, revenue, conversionRate, monthlyTrend, topCustomers, recentQuotations]);

  const headerProps = {
    title: "Quotations Dashboard",
    subtitle: "Quotation pipeline, conversion, and revenue analytics",
    icon: FileSignature,
    iconGradient: "from-brand to-brand-hover",
    crumbs: [{ label: "Billing", href: "/billing" }, { label: "Quotations" }],
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
    primaryAction: <Button variant="primary" icon={PlusCircle} onClick={() => navigate("/billing/quotations/create")}>New Quotation</Button>,
  };

  if (loading) {
    return (
      <div className="space-y-8" aria-label="Loading quotations dashboard">
        <DashboardHeader {...headerProps} />
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
        <div className={DASHBOARD_CHART_GRID}>
          <DashboardChartCardSkeleton />
          <DashboardChartCardSkeleton />
        </div>
      </div>
    );
  }

  if (error && quotes.length === 0 && total === 0) {
    return (
      <div className="space-y-8">
        <DashboardHeader {...headerProps} />
        <ErrorState message={error} onRetry={() => fetchData(true)} title="Something went wrong" />
      </div>
    );
  }

  const hasAnyData = total > 0 || quotes.length > 0;

  return (
    <div className="space-y-8">
      <DashboardHeader {...headerProps} />

      {error && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700 flex items-center justify-between gap-3" role="alert">
          <span className="flex items-center gap-2"><AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}</span>
          <button onClick={() => fetchData(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-100 hover:bg-red-200 text-red-700 text-xs font-semibold transition-colors shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400">
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      )}

      {!hasAnyData ? (
        <DashboardEmptyPanel
          title="No quotations yet"
          message="Create your first quotation to start seeing pipeline and revenue analytics here."
          icon={FileSignature}
          ctaText="New Quotation"
          onCtaClick={() => navigate("/billing/quotations/create")}
          steps={[
            { label: "Customers", icon: Users, onClick: () => navigate("/billing/customers") },
            { label: "Products", icon: List, onClick: () => navigate("/billing/products") },
          ]}
        />
      ) : (
        <>
          <BusinessInsights items={insightItems} />

          <ActionCenter items={actionItems} />

          <div className={DASHBOARD_KPI_GRID}>
            <DashboardStatCard title="Total Quotations" value={total} subtitle="In selected period" icon={FileSignature} color="from-slate-500 to-slate-600" href="/billing/quotations" />
            <DashboardStatCard title="Draft" value={draftCount} subtitle={total > 0 ? `${((draftCount / total) * 100).toFixed(0)}% of total` : "—"} icon={Clock} color="from-slate-500 to-slate-600" href="/billing/quotations?status=draft" />
            <DashboardStatCard title="Sent" value={sentCount} subtitle={total > 0 ? `${((sentCount / total) * 100).toFixed(0)}% of total` : "—"} icon={Send} color="from-blue-500 to-blue-600" href="/billing/quotations?status=sent" />
            <DashboardStatCard title="Accepted" value={acceptedCount} subtitle={total > 0 ? `${((acceptedCount / total) * 100).toFixed(0)}% of total` : "—"} icon={CheckCircle} color="from-emerald-500 to-emerald-600" href="/billing/quotations?status=accepted" />
          </div>

          <StatGroup title="More Metrics">
            <DashboardStatCard title="Rejected" value={rejectedCount} subtitle={total > 0 ? `${((rejectedCount / total) * 100).toFixed(0)}% of total` : "—"} icon={XCircle} color="from-red-500 to-rose-500" href="/billing/quotations?status=rejected" />
            <DashboardStatCard title="Converted" value={convertedCount} subtitle={total > 0 ? `${((convertedCount / total) * 100).toFixed(0)}% of total` : "—"} icon={RefreshCw} color="from-brand to-brand-hover" href="/billing/quotations?status=converted" />
            <DashboardStatCard title="Revenue" value={Number(revenue)} currency={baseCurrency} subtitle="Accepted + converted quotations" icon={DollarSign} color="from-green-500 to-emerald-600" href="/billing/quotations/reports" sparkline={monthlyTrend.map((m) => m.value)} />
            <DashboardStatCard title="Conversion Rate" value={`${conversionRate.toFixed(1)}%`} subtitle="Accepted + converted vs. decided" icon={TrendingUp} color="from-cyan-500 to-cyan-600" href="/billing/quotations/reports" />
          </StatGroup>

          <QuickActions actions={quotationQuickActions} />

          <div className={DASHBOARD_CHART_GRID}>
            <DashboardChartCard title="Monthly Trend">
              <DashboardChartErrorBoundary>
                {monthlyTrend.every((m) => m.count === 0) ? (
                  <DashboardEmptyPanel title="No trend data" message="Quotation volume and value over time will appear here" icon={Inbox} />
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <ComposedChart data={monthlyTrend}>
                      <defs>
                        <linearGradient id="quoteTrendValue" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-accent-invoicing)" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="var(--color-accent-invoicing)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={(v) => formatDisplayCurrency(v, baseCurrency)} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip formatter={(v, name) => name === "value" || name === "Value" ? [formatDisplayCurrency(v, baseCurrency), "Value"] : [v, "Count"]} />
                      <Area yAxisId="left" type="monotone" dataKey="value" name="Value" stroke="var(--color-accent-invoicing)" fill="url(#quoteTrendValue)" strokeWidth={2} />
                      <Line yAxisId="right" type="monotone" dataKey="count" name="Count" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </DashboardChartErrorBoundary>
            </DashboardChartCard>

            <DashboardChartCard title="Status Distribution">
              <DashboardChartErrorBoundary>
                {statusChartData.length === 0 ? (
                  <DashboardEmptyPanel title="No status data" message="Quotation status breakdown will appear here" icon={Inbox} />
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={statusChartData} cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={3} dataKey="value"
                        label={({ percent }) => (percent >= 0.05 ? `${(percent * 100).toFixed(0)}%` : "")}>
                        {statusChartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                      </Pie>
                      <Tooltip formatter={(v, name) => [v, name]} />
                      <Legend verticalAlign="bottom" height={36} formatter={(value) => <span className="text-xs text-slate-600 font-medium">{value}</span>} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </DashboardChartErrorBoundary>
            </DashboardChartCard>
          </div>

          <div className={DASHBOARD_CHART_GRID}>
            <DashboardChartCard title="Top Customers by Quotation Value" action={<button onClick={() => navigate("/billing/customers")} className="text-sm font-medium text-brand hover:text-brand-hover flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 rounded">View All <ChevronRight size={14} /></button>}>
              <DashboardChartErrorBoundary>
                <DataTable
                  columns={topCustomerColumns}
                  data={topCustomers}
                  rowKey={(row) => row.customer_id}
                  onRowClick={(row) => navigate(`/billing/customers/${row.customer_id}`)}
                  stickyHeader={false}
                  emptyTitle="No customer data"
                  emptyMessage="Top customers by quotation value will appear here."
                  emptyIcon={Users}
                />
              </DashboardChartErrorBoundary>
            </DashboardChartCard>

            <DashboardChartCard title="Recent Quotations" action={<button onClick={() => navigate("/billing/quotations")} className="text-sm font-medium text-brand hover:text-brand-hover flex items-center gap-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 rounded">View All <ChevronRight size={14} /></button>}>
              <DashboardChartErrorBoundary>
                <DataTable
                  columns={recentQuotationColumns}
                  data={recentQuotations}
                  rowKey={(row) => row.id}
                  onRowClick={(row) => navigate(`/billing/quotations/${row.id}`)}
                  stickyHeader={false}
                  emptyTitle="No quotations yet"
                  emptyMessage="Recently created quotations will appear here."
                  emptyIcon={FileText}
                />
              </DashboardChartErrorBoundary>
            </DashboardChartCard>
          </div>
        </>
      )}
    </div>
  );
}

