import { useState, useEffect, useCallback, useMemo } from "react";
import { Download, RefreshCw, Users, DollarSign, TrendingUp, Clock, BarChart3 } from "lucide-react";
import { BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from "recharts"
import HRPage from "../../../components/HRPage";
import { customerApi, invoiceApi, collectionApi, dashboardApi } from "../../../service/billingService";
import { extractArray, formatDisplayDate } from "../../../utils/billing-helpers";
import { formatCurrency } from "../../../utils/locale";
import { useCurrency } from "../utils/CurrencyContext";
import { Spinner, ErrorState, EmptyState, DateRangeFilter, useDateRange, ExportMenu, DashboardStatCard } from "../../../components/billing-shared";
import { filterByDateRange, downloadExcel, downloadJSON, downloadCSV } from "../../../utils/export-helpers";

const COLORS = ["#FF7A00", "#FF9B4D", "#FFC9A6", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4898", "#14b8a6", "#f97316"];

function StatCard(props) {
  return <DashboardStatCard {...props} />;
}

const TABS = [
  { key: "overview", label: "Overview", icon: Users },
  { key: "revenue", label: "Revenue", icon: DollarSign },
  { key: "growth", label: "Growth", icon: TrendingUp },
  { key: "aging", label: "Aging", icon: Clock },
  { key: "top", label: "Top Customers", icon: BarChart3 },
];

export default function CustomerReportsPage() {
  const { baseCurrency } = useCurrency();
  const { range, setRange, customStart, setCustomStart, customEnd, setCustomEnd } = useDateRange();
  const [activeTab, setActiveTab] = useState("overview");
  const [refreshing, setRefreshing] = useState(false);

  const [customers, setCustomers] = useState([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [errorCustomers, setErrorCustomers] = useState(null);

  const [invoices, setInvoices] = useState([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [errorInvoices, setErrorInvoices] = useState(null);

  const [agingData, setAgingData] = useState([]);
  const [loadingAging, setLoadingAging] = useState(false);
  const [errorAging, setErrorAging] = useState(null);

  const [monthlyRevenue, setMonthlyRevenue] = useState([]);
  const [loadingRevenue, setLoadingRevenue] = useState(false);
  const [errorRevenue, setErrorRevenue] = useState(null);

  const fetchCustomers = useCallback(async () => {
    try {
      setLoadingCustomers(true);
      setErrorCustomers(null);
      const data = await customerApi.list({ per_page: 100 });
      const items = extractArray(data);
      setCustomers(items);
    } catch (err) {
      setErrorCustomers(err?.detail || err?.message || "Failed to load customers");
    } finally {
      setLoadingCustomers(false);
    }
  }, []);

  const fetchInvoices = useCallback(async () => {
    try {
      setLoadingInvoices(true);
      setErrorInvoices(null);
      const data = await invoiceApi.list({ per_page: 100 });
      setInvoices(extractArray(data));
    } catch (err) {
      setErrorInvoices(err?.detail || err?.message || "Failed to load invoices");
    } finally {
      setLoadingInvoices(false);
    }
  }, []);

  const fetchAging = useCallback(async () => {
    try {
      setLoadingAging(true);
      setErrorAging(null);
      const data = await collectionApi.getAgingBuckets();
      setAgingData(extractArray(data));
    } catch (err) {
      setErrorAging(err?.detail || err?.message || "Failed to load aging data");
    } finally {
      setLoadingAging(false);
    }
  }, []);

  const fetchRevenue = useCallback(async () => {
    try {
      setLoadingRevenue(true);
      setErrorRevenue(null);
      const data = await dashboardApi.getMonthlyRevenue(12);
      setMonthlyRevenue(extractArray(data));
    } catch (err) {
      setErrorRevenue(err?.detail || err?.message || "Failed to load revenue data");
    } finally {
      setLoadingRevenue(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await Promise.allSettled([fetchCustomers(), fetchInvoices(), fetchAging(), fetchRevenue()]);
    setRefreshing(false);
  }, [fetchCustomers, fetchInvoices, fetchAging, fetchRevenue]);

  useEffect(() => { fetchCustomers(); }, [fetchCustomers]);
  useEffect(() => { if (activeTab === "overview") { Promise.allSettled([fetchInvoices(), fetchRevenue()]); } }, [activeTab, fetchInvoices, fetchRevenue]);
  useEffect(() => { if (activeTab === "revenue") fetchInvoices(); }, [activeTab, fetchInvoices]);
  useEffect(() => { if (activeTab === "aging") fetchAging(); }, [activeTab, fetchAging]);
  useEffect(() => { if (activeTab === "growth") fetchRevenue(); }, [activeTab, fetchRevenue]);
  useEffect(() => { if (activeTab === "top") { Promise.allSettled([fetchInvoices(), fetchCustomers()]); } }, [activeTab, fetchInvoices, fetchCustomers]);

  const fCustomers = useMemo(() => filterByDateRange(customers, "created_at", range, customStart, customEnd), [customers, range, customStart, customEnd]);
  const fInvoices = useMemo(() => filterByDateRange(invoices, "created_at", range, customStart, customEnd), [invoices, range, customStart, customEnd]);

  const statusCounts = {
    active: fCustomers.filter((c) => c.status === "active").length,
    inactive: fCustomers.filter((c) => c.status === "inactive").length,
    suspended: fCustomers.filter((c) => c.status === "suspended").length,
    pending: fCustomers.filter((c) => c.status === "pending").length,
  };

  const statusChartData = [
    { name: "Active", value: statusCounts.active, color: "#10b981" },
    { name: "Inactive", value: statusCounts.inactive, color: "#6b7280" },
    { name: "Suspended", value: statusCounts.suspended, color: "#f59e0b" },
    { name: "Pending", value: statusCounts.pending, color: "#3b82f6" },
  ].filter((d) => d.value > 0);

  const paidInvoices = fInvoices.filter((i) => i.status === "paid");
  const unpaidInvoices = fInvoices.filter((i) => i.status === "unpaid" || i.status === "pending");
  const overdueInvoices = fInvoices.filter((i) => i.status === "overdue");
  const totalRevenue = paidInvoices.reduce((s, i) => s + parseFloat(i.total || i.amount || 0), 0);
  const totalOutstanding = unpaidInvoices.reduce((s, i) => s + parseFloat(i.total || i.amount || 0), 0) +
    overdueInvoices.reduce((s, i) => s + parseFloat(i.total || i.amount || 0), 0);

  const revenueByCustomer = fInvoices.reduce((acc, inv) => {
    const cid = inv.customer_id || inv.customerId;
    const cname = inv.customer_name || inv.customerName || `Customer #${cid}`;
    if (!cid) return acc;
    if (!acc[cid]) acc[cid] = { name: cname, revenue: 0, count: 0 };
    acc[cid].revenue += parseFloat(inv.total || inv.amount || 0);
    acc[cid].count += 1;
    return acc;
  }, {});
  const topRevenueCustomers = Object.values(revenueByCustomer)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  const customerMap = fCustomers.reduce((acc, c) => { acc[c.id] = c.display_name || c.company_name; return acc; }, {});
  const customerGrowthData = [...fCustomers]
    .sort((a, b) => new Date(a.created_at || a.createdAt || 0) - new Date(b.created_at || b.createdAt || 0))
    .reduce((acc, c) => {
      const date = (c.created_at || c.createdAt || "").slice(0, 7);
      if (!date) return acc;
      acc.push({ date, count: 1, cumulative: (acc.length > 0 ? acc[acc.length - 1].cumulative : 0) + 1 });
      if (acc.length > 1 && acc[acc.length - 2].date === date) {
        acc.pop();
        acc[acc.length - 1].count += 1;
      }
      return acc;
    }, []);

  const [exportLoading, setExportLoading] = useState(null);
  const handleExcelExport = async () => {
    setExportLoading('excel');
    try {
      const rows = fCustomers.map((c) => [c.id, c.display_name, c.company_name, c.email, c.status, c.created_at]);
      await downloadExcel(rows, ['id','display_name','company_name','email','status','created_at'], 'customers-report.xlsx');
    }
    catch (e) { /* Excel export failed */ } finally { setExportLoading(null); }
  };
  const handleAllExport = async (format) => {
    setExportLoading(format);
    try {
      if (format === 'json') await downloadJSON({ customers: fCustomers, invoices: fInvoices }, 'customers-data.json');
      else if (format === 'csv') {
        const rows = fCustomers.map((c) => [c.id, c.display_name, c.email, c.status]);
        await downloadCSV(rows, ['id','display_name','email','status'], 'customers.csv');
      }
      else if (format === 'excel') await handleExcelExport();
    } catch (e) { /* Export failed */ } finally { setExportLoading(null); }
  };

  const agingChartData = Array.isArray(agingData) ? agingData.map((b) => ({
    name: b.bucket || b.range || b.name || "Unknown",
    amount: parseFloat(b.amount || b.total || b.outstanding || 0),
    count: b.count || b.invoice_count || 0,
  })) : [];

  return (
    <HRPage title="Customer Reports" subtitle="Customer analytics and reporting">

      <div className="flex items-center justify-between mb-6">
        <nav className="flex gap-0 border-b border-gray-200 overflow-x-auto">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                  activeTab === tab.key
                    ? "border-brand-600 text-brand-600"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}
              >
                <Icon className="h-4 w-4" /> {tab.label}
              </button>
            );
          })}
        </nav>
        <div className="flex items-center gap-2">
          <DateRangeFilter value={range} onChange={setRange} customStart={customStart} customEnd={customEnd}
            onCustomStartChange={setCustomStart} onCustomEndChange={setCustomEnd} />
          <ExportMenu
            onExportExcel={() => handleAllExport('excel')}
            onExportCSV={() => handleAllExport('csv')}
            onExportJSON={() => handleAllExport('json')}
          />
          <button onClick={refreshAll} disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50 transition-colors">
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {activeTab === "overview" && (
        <div className="space-y-6">
          {loadingCustomers && fInvoices.length === 0 ? (
            <Spinner />
          ) : errorCustomers ? (
            <ErrorState message={errorCustomers} onRetry={fetchCustomers} />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard title="Total Customers" value={fCustomers.length} icon={Users} color="from-brand to-brand-hover" />
                <StatCard title="Active" value={statusCounts.active} subtitle={`${fCustomers.length ? ((statusCounts.active / fCustomers.length) * 100).toFixed(1) : 0}% of total`} icon={Users} color="from-emerald-500 to-emerald-600" />
                <StatCard title="Total Revenue" value={formatCurrency(totalRevenue, baseCurrency)} icon={DollarSign} color="from-blue-500 to-blue-600" />
                <StatCard title="Outstanding" value={formatCurrency(totalOutstanding, baseCurrency)} icon={DollarSign} color="from-amber-500 to-orange-500" />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white rounded-xl border border-gray-200 p-6">
                  <h3 className="text-sm font-semibold text-gray-900 mb-4">Customer Status Distribution</h3>
                  {statusChartData.length === 0 ? (
                    <EmptyState icon={Users} title="No status data" />
                  ) : (
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie data={statusChartData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value" label={({ name, value }) => `${name}: ${value}`}>
                          {statusChartData.map((entry, i) => (
                            <Cell key={i} fill={entry.color} />
                          ))}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>

                <div className="bg-white rounded-xl border border-gray-200 p-6">
                  <h3 className="text-sm font-semibold text-gray-900 mb-4">Customer Growth Trend</h3>
                  {customerGrowthData.length === 0 ? (
                    <EmptyState icon={TrendingUp} title="No growth data" />
                  ) : (
                    <ResponsiveContainer width="100%" height={300}>
                      <AreaChart data={customerGrowthData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip />
                        <Area type="monotone" dataKey="cumulative" stroke="#FF7A00" fill="#FFC9A6" strokeWidth={2} name="Total Customers" />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              {fInvoices.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-gray-900">Invoice Status Summary</h3>
                    <button onClick={() => downloadJSON({ total: totalRevenue, outstanding: totalOutstanding, paid: paidInvoices.length, unpaid: unpaidInvoices.length, overdue: overdueInvoices.length }, "customer-invoice-summary.json")}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors" aria-label="Export invoice status summary">
                      <Download className="h-3.5 w-3.5" /> Export
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-4 mb-4">
                    <div className="text-center p-3 bg-emerald-50 rounded-lg">
                      <p className="text-2xl font-bold text-emerald-700">{paidInvoices.length}</p>
                      <p className="text-xs text-emerald-600 font-medium">Paid</p>
                    </div>
                    <div className="text-center p-3 bg-amber-50 rounded-lg">
                      <p className="text-2xl font-bold text-amber-700">{unpaidInvoices.length}</p>
                      <p className="text-xs text-amber-600 font-medium">Unpaid</p>
                    </div>
                    <div className="text-center p-3 bg-red-50 rounded-lg">
                      <p className="text-2xl font-bold text-red-700">{overdueInvoices.length}</p>
                      <p className="text-xs text-red-600 font-medium">Overdue</p>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "revenue" && (
        <div className="space-y-6">
          {loadingInvoices ? (
            <Spinner />
          ) : errorInvoices ? (
            <ErrorState message={errorInvoices} onRetry={fetchInvoices} />
          ) : topRevenueCustomers.length === 0 ? (
            <EmptyState icon={DollarSign} title="No revenue data" message="Invoice data will appear here once available." />
          ) : (
            <>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-900">Top Customers by Revenue</h3>
                  <button onClick={() => downloadJSON(topRevenueCustomers, "top-customers-revenue.json")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
                    <Download className="h-3.5 w-3.5" /> Export
                  </button>
                </div>
                <ResponsiveContainer width="100%" height={350}>
                  <BarChart data={topRevenueCustomers} layout="vertical" margin={{ left: 120 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={110} />
                    <Tooltip formatter={(v) => formatCurrency(v, baseCurrency)} />
                    <Bar dataKey="revenue" fill="#FF7A00" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">Revenue Details</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Customer</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Revenue</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Invoices</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Avg Invoice</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topRevenueCustomers.map((c, i) => (
                        <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-3 px-3 font-medium text-gray-900">{c.name}</td>
                          <td className="py-3 px-3 text-right font-medium text-gray-900">{formatCurrency(c.revenue, baseCurrency)}</td>
                          <td className="py-3 px-3 text-right text-gray-500">{c.count}</td>
                          <td className="py-3 px-3 text-right text-gray-500">{formatCurrency(c.count ? c.revenue / c.count : 0, baseCurrency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "growth" && (
        <div className="space-y-6">
          {loadingRevenue && customerGrowthData.length === 0 ? (
            <Spinner />
          ) : errorRevenue ? (
            <ErrorState message={errorRevenue} onRetry={fetchRevenue} />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <StatCard title="Total Customers" value={fCustomers.length} icon={Users} color="from-brand to-brand-hover" />
                <StatCard title="Avg Revenue/Customer" value={formatCurrency(fCustomers.length ? totalRevenue / fCustomers.length : 0, baseCurrency)} icon={DollarSign} color="from-blue-500 to-blue-600" />
                <StatCard title="Growth Rate" value={customerGrowthData.length > 1 ? `${((customerGrowthData[customerGrowthData.length - 1].cumulative - customerGrowthData[0].cumulative) / Math.max(customerGrowthData[0].cumulative, 1) * 100).toFixed(1)}%` : "—"} icon={TrendingUp} color="from-emerald-500 to-emerald-600" />
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">Customer Growth</h3>
                {customerGrowthData.length === 0 ? (
                  <EmptyState icon={TrendingUp} title="No growth data" />
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <AreaChart data={customerGrowthData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Area type="monotone" dataKey="cumulative" stroke="#FF7A00" fill="#FFC9A6" strokeWidth={2} name="Total Customers" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">Monthly Revenue Trend</h3>
                {monthlyRevenue.length === 0 ? (
                  <EmptyState icon={DollarSign} title="No revenue data" />
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={monthlyRevenue}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(v) => formatCurrency(v, baseCurrency)} />
                      <Bar dataKey="revenue" fill="#FF7A00" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "aging" && (
        <div className="space-y-6">
          {loadingAging ? (
            <Spinner />
          ) : errorAging ? (
            <ErrorState message={errorAging} onRetry={fetchAging} />
          ) : agingChartData.length === 0 ? (
            <EmptyState icon={Clock} title="No aging data" message="Aging data will appear here once available." />
          ) : (
            <>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">Outstanding Aging</h3>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={agingChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v) => formatCurrency(v, baseCurrency)} />
                    <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                      {agingChartData.map((entry, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-900">Aging Details</h3>
                  <button onClick={() => downloadJSON(agingChartData, "customer-aging.json")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
                    <Download className="h-3.5 w-3.5" /> Export
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Bucket</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Amount</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agingChartData.map((b, i) => (
                        <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-3 px-3 font-medium text-gray-900">{b.name}</td>
                          <td className="py-3 px-3 text-right font-medium text-gray-900">{formatCurrency(b.amount, baseCurrency)}</td>
                          <td className="py-3 px-3 text-right text-gray-500">{b.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "top" && (
        <div className="space-y-6">
          {loadingCustomers && loadingInvoices ? (
            <Spinner />
          ) : errorCustomers ? (
            <ErrorState message={errorCustomers} onRetry={fetchCustomers} />
          ) : fCustomers.length === 0 ? (
            <EmptyState icon={Users} title="No customers" message="Customer data will appear here once available." />
          ) : (
            <>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-900">All Customers</h3>
                  <button onClick={() => downloadJSON(fCustomers.map((c) => ({ id: c.id, name: c.display_name || c.company_name, email: c.email, company: c.company_name, status: c.status, created_at: c.created_at })), "all-customers.json")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
                    <Download className="h-3.5 w-3.5" /> Export
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
<thead>
                       <tr className="border-b border-gray-100">
                         <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Name</th>
                         <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Email</th>
                         <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Company</th>
                         <th scope="col" className="text-center py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Status</th>
                         <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Created</th>
                       </tr>
                     </thead>
                    <tbody>
                      {fCustomers.map((c) => (
                        <tr key={c.id || c._id} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-3 px-3 font-medium text-gray-900">{c.display_name || c.company_name}</td>
                          <td className="py-3 px-3 text-gray-500">{c.email || "—"}</td>
                          <td className="py-3 px-3 text-gray-500">{c.company_name || "—"}</td>
                          <td className="py-3 px-3 text-center">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              c.status === "active" ? "bg-emerald-100 text-emerald-700" :
                              c.status === "suspended" ? "bg-amber-100 text-amber-700" :
                              c.status === "inactive" ? "bg-gray-100 text-gray-600" : "bg-blue-100 text-blue-700"
                            }`}>
                              {c.status ? c.status.charAt(0).toUpperCase() + c.status.slice(1) : "Unknown"}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-gray-500">{formatDisplayDate(c.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </HRPage>
  );
}
