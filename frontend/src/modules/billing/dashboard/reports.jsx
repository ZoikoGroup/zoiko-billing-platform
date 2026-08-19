import React, { useState, useEffect, useCallback, useMemo } from "react";
import { BarChart3, Download, RefreshCw, AlertCircle, FileText, DollarSign, Receipt, TrendingUp, Calendar, Percent, Users } from "lucide-react";
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { dashboardApi, invoiceApi, paymentApi, taxApi, subscriptionApi } from "../../../service/billingService";
import { extractArray } from "../../../utils/billing-helpers";
import {
  DashboardHeader, useDateRange, DashboardStatCard, DASHBOARD_KPI_GRID,
  DashboardChartErrorBoundary as ChartErrorBoundary, DashboardEmptyPanel,
} from "../../../components/billing-shared";
import { filterByDateRange } from "../../../utils/export-helpers";
import { formatCurrency, formatCompactCurrency } from "../../../utils/locale";
import { useCurrency } from "../utils/CurrencyContext";
import { sumInBaseCurrency, convertToBaseCurrency } from "../../../utils/currency-conversion";

const CHART_COLORS = ["#2563EB", "#60A5FA", "#BFDBFE", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4899"];
const STAT_CARD_COLORS = [
  "from-blue-600 to-blue-700",
  "from-blue-500 to-cyan-500",
  "from-indigo-500 to-indigo-600",
  "from-green-500 to-emerald-500",
];

function ReportSection({ title, icon: Icon, children }) {
  return (
    <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <div className="flex items-center gap-3 mb-6">
        <div className="h-10 w-10 rounded-xl bg-gradient-to-r from-brand to-brand-hover text-white flex items-center justify-center">
          <Icon size={22} />
        </div>
        <h2 className="text-xl font-bold text-slate-800">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function DataTable({ columns, data, maxRows = 10 }) {
  if (!data || data.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 bg-slate-50/50 rounded-xl border border-slate-100">
        <FileText size={20} className="text-slate-300 mb-2" />
        <p className="text-slate-400 text-sm">No data available</p>
      </div>
    );
  }
  const sliced = data.slice(0, maxRows);
  return (
    <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50/80">
              {columns.map((col) => (
                <th key={col.key} scope="col" className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sliced.map((row, idx) => (
              <tr key={row.id ?? idx} className="hover:bg-slate-50/60 transition-colors">
                {columns.map((col) => (
                  <td key={col.key} className="px-4 py-3 text-sm text-slate-700 whitespace-nowrap">
                    {col.render ? col.render(row) : row[col.key] ?? "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.length > maxRows && (
        <div className="px-4 py-2 bg-slate-50/50 border-t border-slate-100 text-xs text-slate-400">
          Showing {maxRows} of {data.length} rows
        </div>
      )}
    </div>
  );
}

export default function ReportsPage() {
  const { baseCurrency, currencySymbol } = useCurrency();
  const { range, setRange, customStart, setCustomStart, customEnd, setCustomEnd } = useDateRange();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [activeReport, setActiveReport] = useState("revenue");

  const [revenueData, setRevenueData] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [payments, setPayments] = useState([]);
  const [taxData, setTaxData] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);

  const fetchReports = useCallback(async () => {
    try {
      setError(null);
      if (!loading) setRefreshing(true);

      const results = await Promise.allSettled([
        dashboardApi.getMonthlyRevenue(12),
        invoiceApi.list({ per_page: 100 }),
        paymentApi.list({ per_page: 100 }),
        taxApi.getSummary(),
        subscriptionApi.list({ per_page: 100 }),
      ]);

      const [revenueResult, invoiceResult, paymentResult, taxResult, subResult] = results;

      const safe = (result, transform) =>
        result.status === "fulfilled" ? (transform ? transform(result.value) : result.value) : null;

      const errors = results.filter((r) => r.status === "rejected");
      /* Some reports failed to load */

      setRevenueData(safe(revenueResult, extractArray) || []);
      setInvoices(safe(invoiceResult, extractArray) || []);
      setPayments(safe(paymentResult, extractArray) || []);
      setTaxData(safe(taxResult, extractArray) || []);
      setSubscriptions(safe(subResult, extractArray) || []);
      setLastUpdated(new Date());
    } catch (err) {
      /* Reports fetch error */
      setError("Failed to load reports data.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loading]);

  useEffect(() => {
    fetchReports();
  }, []);

  const fRevenue = useMemo(() => filterByDateRange(revenueData, "month", range, customStart, customEnd), [revenueData, range, customStart, customEnd]);
  const fInvoices = useMemo(() => filterByDateRange(invoices, "created_at", range, customStart, customEnd), [invoices, range, customStart, customEnd]);
  const fPayments = useMemo(() => filterByDateRange(payments, "payment_date", range, customStart, customEnd), [payments, range, customStart, customEnd]);
  const fTaxData = useMemo(() => filterByDateRange(taxData, "created_at", range, customStart, customEnd), [taxData, range, customStart, customEnd]);
  const fSubscriptions = useMemo(() => filterByDateRange(subscriptions, "created_at", range, customStart, customEnd), [subscriptions, range, customStart, customEnd]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchReports();
  };

  const handleExport = (section) => {
    const dataMap = { revenue: fRevenue, invoice: fInvoices, payment: fPayments, tax: fTaxData, subscription: fSubscriptions };
    const data = dataMap[section] || [];
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `billing-${section}-report-${new Date().toISOString().split("T")[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const headerProps = {
    title: "Billing Reports",
    subtitle: "Generate and export billing reports",
    icon: BarChart3,
    iconGradient: "from-[#2563EB] to-[#1D4ED8]",
    lastUpdated,
    refreshing,
    onRefresh: handleRefresh,
    dateRange: range,
    onDateRangeChange: setRange,
    customStart,
    customEnd,
    onApplyCustomRange: (start, end) => { setCustomStart(start); setCustomEnd(end); },
    onResetDateRange: () => { setCustomStart(""); setCustomEnd(""); },
  };

  const reportTabs = [
    { id: "revenue", label: "Revenue Report", icon: DollarSign },
    { id: "invoice", label: "Invoice Report", icon: FileText },
    { id: "payment", label: "Payment Report", icon: Receipt },
    { id: "tax", label: "Tax Report", icon: BarChart3 },
    { id: "subscription", label: "Subscription Report", icon: TrendingUp },
  ];

  const renderRevenueReport = () => (
    <ReportSection title="Revenue Report" icon={DollarSign}>
      <div className="mb-6">
        <div className="grid gap-5 grid-cols-1 sm:grid-cols-3 mb-6">
          <DashboardStatCard title="Total Revenue" icon={DollarSign} color={STAT_CARD_COLORS[0]}
            value={formatCurrency(sumInBaseCurrency(fRevenue.map(r => ({ amount: r.revenue, currency: r.currency, exchange_rate: r.exchange_rate })), baseCurrency).total, baseCurrency)} />
          <DashboardStatCard title="Periods" icon={Calendar} color={STAT_CARD_COLORS[1]} value={fRevenue.length} />
          <DashboardStatCard title="Average Monthly" icon={TrendingUp} color={STAT_CARD_COLORS[2]}
            value={fRevenue.length > 0 ? formatCurrency(sumInBaseCurrency(fRevenue.map(r => ({ amount: r.revenue, currency: r.currency, exchange_rate: r.exchange_rate })), baseCurrency).total / fRevenue.length, baseCurrency) : `${currencySymbol}0.00`} />
        </div>
        <ChartErrorBoundary aria-live="polite">
          {fRevenue.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={fRevenue} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey={fRevenue[0]?.month ? "month" : "period"} tick={{ fontSize: 11, fill: "#64748b" }} />
                <YAxis tickFormatter={(v) => formatCompactCurrency(v, baseCurrency)} tick={{ fontSize: 11, fill: "#64748b" }} />
                <Tooltip formatter={(v) => formatCurrency(v, baseCurrency)} />
                <Bar dataKey="revenue" fill="#2563EB" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <DashboardEmptyPanel message="No revenue data recorded" icon={BarChart3} />
          )}
        </ChartErrorBoundary>
      </div>
      <button onClick={() => handleExport("revenue")} className="flex items-center gap-2 px-4 py-2 bg-[#2563EB] text-white rounded-xl text-xs font-semibold hover:bg-[#1D4ED8] transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/50">
        <Download size={15} /> Export Revenue Report
      </button>
    </ReportSection>
  );

  const renderInvoiceReport = () => {
    const byStatus = fInvoices.reduce((acc, inv) => {
      const s = inv.status || "unassigned";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});
    const statusData = Object.entries(byStatus).map(([name, value]) => ({ name, value }));
    const totalAmount = sumInBaseCurrency(fInvoices, baseCurrency).total;
    const paidAmount = sumInBaseCurrency(fInvoices.filter((inv) => inv.status === "paid"), baseCurrency).total;

    const columns = [
      { key: "id", label: "Invoice" },
      { key: "customer_name", label: "Customer", render: (r) => r.customer_name || r.customer?.name || r.customer_display_name || (r.customer_id ? `Customer #${r.customer_id}` : "Unassigned Customer") },
      { key: "total", label: "Amount", render: (r) => <span className="whitespace-nowrap font-medium text-slate-900">{formatCurrency(r.total || r.amount, baseCurrency)}</span> },
      { key: "status", label: "Status", render: (r) => <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 capitalize">{r.status || "—"}</span> },
      { key: "created_at", label: "Date", render: (r) => r.created_at ? new Date(r.created_at).toLocaleDateString() : "—" },
    ];

    return (
      <ReportSection title="Invoice Report" icon={FileText}>
        <div className={`${DASHBOARD_KPI_GRID} mb-6`}>
          <DashboardStatCard title="Total Invoices" icon={FileText} color={STAT_CARD_COLORS[0]} value={fInvoices.length} />
          <DashboardStatCard title="Total Amount" icon={DollarSign} color={STAT_CARD_COLORS[1]} value={formatCurrency(totalAmount, baseCurrency)} />
          <DashboardStatCard title="Paid Amount" icon={Receipt} color={STAT_CARD_COLORS[2]} value={formatCurrency(paidAmount, baseCurrency)} />
          <DashboardStatCard title="Collection Rate" icon={Percent} color={STAT_CARD_COLORS[3]} value={totalAmount > 0 ? `${((paidAmount / totalAmount) * 100).toFixed(1)}%` : "0%"} />
        </div>
        <div className="grid xl:grid-cols-2 gap-6 mb-6 items-stretch">
          <ChartErrorBoundary aria-live="polite">
            {statusData.length > 0 ? (
              <ResponsiveContainer width="100%" height={320}>
                <PieChart>
                  <Pie
                    data={statusData}
                    cx="50%"
                    cy="45%"
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={4}
                    dataKey="value"
                    label={({ percent }) => (percent >= 0.05 ? `${(percent * 100).toFixed(0)}%` : "")}
                  >
                    {statusData.map((_, idx) => (
                      <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, name) => [v, `Invoices (${name})`]} />
                  <Legend verticalAlign="bottom" height={36} formatter={(value) => <span className="text-xs text-slate-600 font-medium">{value}</span>} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <DashboardEmptyPanel title="No invoices found" message="There are no invoices for the selected period." icon={FileText} />
            )}
          </ChartErrorBoundary>
          <DataTable columns={columns} data={fInvoices.slice(0, 10)} />
        </div>
        <button onClick={() => handleExport("invoice")} className="flex items-center gap-2 px-4 py-2 bg-[#2563EB] text-white rounded-xl text-xs font-semibold hover:bg-[#1D4ED8] transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/50">
          <Download size={15} /> Export Invoice Report
        </button>
      </ReportSection>
    );
  };

  const renderPaymentReport = () => {
    const totalAmount = sumInBaseCurrency(fPayments, baseCurrency).total;
    const byMethod = fPayments.reduce((acc, p) => {
      const m = p.method || p.payment_method || "Other";
      const { convertedAmount } = convertToBaseCurrency(p.amount || 0, p.currency || baseCurrency, baseCurrency, p.exchange_rate);
      acc[m] = (acc[m] || 0) + convertedAmount;
      return acc;
    }, {});
    const methodData = Object.entries(byMethod).map(([name, value]) => ({ name, value }));

    const columns = [
      { key: "id", label: "Payment" },
      { key: "customer_name", label: "Customer", render: (r) => r.customer_name || r.customer?.name || r.customer_display_name || (r.customer_id ? `Customer #${r.customer_id}` : "Unassigned Customer") },
      { key: "amount", label: "Amount", render: (r) => <span className="whitespace-nowrap font-medium text-slate-900">{formatCurrency(r.amount, baseCurrency)}</span> },
      { key: "method", label: "Method" },
      { key: "status", label: "Status", render: (r) => <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700 capitalize">{r.status || "Completed"}</span> },
    ];

    return (
      <ReportSection title="Payment Report" icon={Receipt}>
        <div className="grid gap-5 grid-cols-1 sm:grid-cols-3 mb-6">
          <DashboardStatCard title="Total Payments" icon={Receipt} color={STAT_CARD_COLORS[0]} value={fPayments.length} />
          <DashboardStatCard title="Total Amount" icon={DollarSign} color={STAT_CARD_COLORS[1]} value={formatCurrency(totalAmount, baseCurrency)} />
          <DashboardStatCard title="Payment Methods" icon={BarChart3} color={STAT_CARD_COLORS[2]} value={methodData.length} />
        </div>
        <div className="grid xl:grid-cols-2 gap-6 mb-6 items-stretch">
          <ChartErrorBoundary aria-live="polite">
            {methodData.length > 0 ? (
              <ResponsiveContainer width="100%" height={320}>
                <PieChart>
                  <Pie data={methodData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(1)}%`}>
                    {methodData.map((_, idx) => (
                      <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                    ))}
                    <Tooltip formatter={(v) => [formatCurrency(v, baseCurrency), "Payments"]} />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <DashboardEmptyPanel message="No payment method records" icon={Receipt} />
            )}
          </ChartErrorBoundary>
          <DataTable columns={columns} data={fPayments.slice(0, 10)} />
        </div>
        <button onClick={() => handleExport("payment")} className="flex items-center gap-2 px-4 py-2 bg-[#2563EB] text-white rounded-xl text-xs font-semibold hover:bg-[#1D4ED8] transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/50">
          <Download size={15} /> Export Payment Report
        </button>
      </ReportSection>
    );
  };

  const renderTaxReport = () => {
    const columns = [
      { key: "jurisdiction", label: "Jurisdiction" },
      { key: "rate", label: "Rate", render: (r) => r.rate ? `${r.rate}%` : "—" },
      { key: "collected", label: "Collected", render: (r) => <span className="whitespace-nowrap font-medium text-slate-900">{formatCurrency(r.collected || r.amount || 0, baseCurrency)}</span> },
    ];

    return (
      <ReportSection title="Tax Report" icon={BarChart3}>
        <div className="grid gap-5 grid-cols-1 sm:grid-cols-3 mb-6">
          <DashboardStatCard title="Tax Rates" icon={BarChart3} color={STAT_CARD_COLORS[0]} value={fTaxData.length} />
          <DashboardStatCard title="Total Collected" icon={DollarSign} color={STAT_CARD_COLORS[1]}
            value={formatCurrency(sumInBaseCurrency(fTaxData.map(t => ({ amount: t.collected || t.amount, currency: t.currency, exchange_rate: t.exchange_rate })), baseCurrency).total, baseCurrency)} />
          <DashboardStatCard title="Jurisdictions" icon={Users} color={STAT_CARD_COLORS[2]} value={new Set(fTaxData.map((t) => t.jurisdiction)).size} />
        </div>
        <ChartErrorBoundary aria-live="polite">
          {fTaxData.length > 0 ? (
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={fTaxData} margin={{ top: 10, right: 20, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="jurisdiction" tick={{ fontSize: 11, fill: "#64748b" }} />
                <YAxis tickFormatter={(v) => formatCompactCurrency(v, baseCurrency)} tick={{ fontSize: 11, fill: "#64748b" }} />
                <Tooltip formatter={(v) => formatCurrency(v, baseCurrency)} />
                <Bar dataKey="collected" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <DashboardEmptyPanel message="No tax data available" icon={Receipt} />
          )}
        </ChartErrorBoundary>
        <div className="mt-6">
          <DataTable columns={columns} data={fTaxData} />
        </div>
        <button onClick={() => handleExport("tax")} className="mt-4 flex items-center gap-2 px-4 py-2 bg-[#2563EB] text-white rounded-xl text-xs font-semibold hover:bg-[#1D4ED8] transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/50">
          <Download size={15} /> Export Tax Report
        </button>
      </ReportSection>
    );
  };

  const renderSubscriptionReport = () => {
    const byPlan = fSubscriptions.reduce((acc, sub) => {
      const plan = sub.plan_name || sub.plan?.name || sub.plan || (sub.plan_id ? `Plan #${sub.plan_id}` : "No Plan Assigned");
      acc[plan] = (acc[plan] || 0) + 1;
      return acc;
    }, {});
    const planData = Object.entries(byPlan).map(([name, value]) => ({ name, value }));

    const columns = [
      { key: "id", label: "Subscription" },
      { key: "customer_name", label: "Customer", render: (r) => r.customer_name || r.customer?.name || r.customer_display_name || (r.customer_id ? `Customer #${r.customer_id}` : "Unassigned Customer") },
      { key: "plan_name", label: "Plan", render: (r) => r.plan_name || r.plan?.name || r.plan || (r.plan_id ? `Plan #${r.plan_id}` : "Unassigned Plan") },
      { key: "status", label: "Status", render: (r) => <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-green-100 text-green-700 capitalize">{r.status || "Active"}</span> },
    ];

    return (
      <ReportSection title="Subscription Report" icon={TrendingUp}>
        <div className={`${DASHBOARD_KPI_GRID} mb-6`}>
          <DashboardStatCard title="Total Subscriptions" icon={TrendingUp} color={STAT_CARD_COLORS[0]} value={fSubscriptions.length} />
          <DashboardStatCard title="Unique Plans" icon={FileText} color={STAT_CARD_COLORS[1]} value={planData.length} />
        </div>
        <div className="grid xl:grid-cols-2 gap-6 mb-6">
          <ChartErrorBoundary aria-live="polite">
            {planData.length > 0 ? (
              <ResponsiveContainer width="100%" height={320}>
                <PieChart>
                  <Pie
                    data={planData}
                    cx="50%"
                    cy="45%"
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={4}
                    dataKey="value"
                    label={({ percent }) => (percent >= 0.05 ? `${(percent * 100).toFixed(0)}%` : "")}
                  >
                    {planData.map((_, idx) => (
                      <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, name) => [v, `Subscriptions (${name})`]} />
                  <Legend verticalAlign="bottom" height={36} formatter={(value) => <span className="text-xs text-slate-600 font-medium">{value}</span>} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <DashboardEmptyPanel title="No subscriptions" message="No subscription distribution data for the selected period." icon={TrendingUp} />
            )}
          </ChartErrorBoundary>
          <DataTable columns={columns} data={fSubscriptions.slice(0, 10)} />
        </div>
        <button onClick={() => handleExport("subscription")} className="flex items-center gap-2 px-4 py-2 bg-[#2563EB] text-white rounded-xl text-xs font-semibold hover:bg-[#1D4ED8] transition-colors shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/50">
          <Download size={15} /> Export Subscription Report
        </button>
      </ReportSection>
    );
  };

  if (loading) {
    return (
      <div className="space-y-8">
        <DashboardHeader {...headerProps} />
        <div className="flex flex-col items-center justify-center py-20">
          <div className="relative">
            <div className="h-12 w-12 rounded-full border-4 border-slate-200 border-t-[#2563EB] animate-spin" />
          </div>
          <p className="mt-4 text-slate-500 text-sm font-medium">Loading reports...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-8">
        <DashboardHeader {...headerProps} />
        <div className="flex flex-col items-center justify-center py-20">
          <div className="h-14 w-14 rounded-full bg-red-50 text-red-500 flex items-center justify-center mb-3">
            <AlertCircle size={28} />
          </div>
          <h3 className="text-lg font-bold text-slate-800 mb-1">Unable to load reports</h3>
          <p className="text-slate-500 text-sm mb-6 text-center max-w-md">{error}</p>
          <button onClick={handleRefresh}
            className="px-5 py-2.5 bg-gradient-to-r from-[#2563EB] to-[#1D4ED8] text-white rounded-xl text-xs font-semibold hover:shadow-md transition-all flex items-center gap-2">
            <RefreshCw size={14} /> Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <DashboardHeader {...headerProps} />
      <div className="space-y-6">
        <div className="flex justify-between items-center bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            {reportTabs.map((tab) => (
              <button key={tab.id} onClick={() => setActiveReport(tab.id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
                  activeReport === tab.id ? "bg-gradient-to-r from-[#2563EB] to-[#1D4ED8] text-white shadow-sm" : "bg-slate-50 text-slate-600 hover:bg-slate-100"
                }`}>
                <tab.icon size={15} />
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {activeReport === "revenue" && renderRevenueReport()}
        {activeReport === "invoice" && renderInvoiceReport()}
        {activeReport === "payment" && renderPaymentReport()}
        {activeReport === "tax" && renderTaxReport()}
        {activeReport === "subscription" && renderSubscriptionReport()}
      </div>
    </div>
  );
}
