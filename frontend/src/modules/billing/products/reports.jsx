import { useState, useEffect, useCallback, useMemo } from "react";
import { Download, RefreshCw, DollarSign, TrendingUp, PieChart as PieChartIcon, BarChart3, Box, UserMinus, UserPlus, CalendarClock } from "lucide-react";
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area,
} from "recharts";
import HRPage from "../../../components/HRPage";
import { productApi, invoiceApi, subscriptionApi, dashboardApi } from "../../../service/billingService";
import { useCurrency } from "../utils/CurrencyContext";
import { extractArray } from "../../../utils/billing-helpers";
import { Spinner, ErrorState, EmptyState, DateRangeFilter, useDateRange, ExportMenu } from "../../../components/billing-shared";
import { filterByDateRange, downloadExcel, downloadJSON, downloadCSV } from "../../../utils/export-helpers";

const COLORS = ["#FF7A00", "#FF9B4D", "#FFC9A6", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4898", "#14b8a6", "#f97316"];

const PRESETS = [
  { id: "this_month", label: "This Month" },
  { id: "this_quarter", label: "Last Quarter" },
  { id: "custom", label: "Custom" },
];

const TABS = [
  { key: "revenue", label: "Revenue", icon: DollarSign },
  { key: "performance", label: "Performance", icon: TrendingUp },
  { key: "utilization", label: "Utilization", icon: BarChart3 },
  { key: "category", label: "Category", icon: PieChartIcon },
  { key: "usage", label: "Usage", icon: Box },
];

export default function ProductReportsPage() {
  const { formatCurrency, baseCurrency } = useCurrency();
  const { range, setRange, customStart, setCustomStart, customEnd, setCustomEnd } = useDateRange();
  const [activeTab, setActiveTab] = useState("revenue");
  const [refreshing, setRefreshing] = useState(false);

  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [errorProducts, setErrorProducts] = useState(null);

  const [invoices, setInvoices] = useState([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [errorInvoices, setErrorInvoices] = useState(null);

  const [subscriptions, setSubscriptions] = useState([]);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const [errorSubs, setErrorSubs] = useState(null);

  const [categories, setCategories] = useState([]);
  const [loadingCats, setLoadingCats] = useState(false);
  const [errorCats, setErrorCats] = useState(null);

  const [usageProducts, setUsageProducts] = useState([]);
  const [loadingUsage, setLoadingUsage] = useState(false);
  const [errorUsage, setErrorUsage] = useState(null);

  const [revenueData, setRevenueData] = useState([]);
  const [loadingRevenue, setLoadingRevenue] = useState(false);
  const [errorRevenue, setErrorRevenue] = useState(null);

  const fetchProducts = useCallback(async () => {
    try { setLoadingProducts(true); setErrorProducts(null); const data = await productApi.list({ per_page: 100 }); setProducts(extractArray(data)); }
    catch (err) { setErrorProducts(err.message || "Failed to load products"); }
    finally { setLoadingProducts(false); }
  }, []);

  const fetchInvoices = useCallback(async () => {
    try { setLoadingInvoices(true); setErrorInvoices(null); const data = await invoiceApi.list({ per_page: 100 }); setInvoices(extractArray(data)); }
    catch (err) { setErrorInvoices(err.message || "Failed to load invoices"); }
    finally { setLoadingInvoices(false); }
  }, []);

  const fetchSubscriptions = useCallback(async () => {
    try { setLoadingSubs(true); setErrorSubs(null); const data = await subscriptionApi.list({ per_page: 100 }); setSubscriptions(extractArray(data)); }
    catch (err) { setErrorSubs(err.message || "Failed to load subscriptions"); }
    finally { setLoadingSubs(false); }
  }, []);

  const fetchCategories = useCallback(async () => {
    try { setLoadingCats(true); setErrorCats(null); const data = await productApi.listCategories({ per_page: 100 }); setCategories(extractArray(data)); }
    catch (err) { setErrorCats(err.message || "Failed to load categories"); }
    finally { setLoadingCats(false); }
  }, []);

  const fetchUsage = useCallback(async () => {
    try { setLoadingUsage(true); setErrorUsage(null); const data = await productApi.listUsageBillable(); setUsageProducts(extractArray(data)); }
    catch (err) { setErrorUsage(err.message || "Failed to load usage products"); }
    finally { setLoadingUsage(false); }
  }, []);

  const fetchRevenue = useCallback(async () => {
    try { setLoadingRevenue(true); setErrorRevenue(null); const data = await dashboardApi.getMonthlyRevenue(12);
      const raw = Array.isArray(data) ? data : data?.monthly_revenue || data?.data || data?.items || [];
      const mapped = raw.map((r) => ({
        month: r.month || r.label || "",
        revenue: parseFloat(r.revenue || r.amount || r.total || 0),
      })).filter((r) => r.month);
      setRevenueData(mapped);
    }
    catch (err) { setErrorRevenue(err.message || "Failed to load revenue data"); }
    finally { setLoadingRevenue(false); }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await Promise.allSettled([fetchProducts(), fetchInvoices(), fetchSubscriptions(), fetchCategories(), fetchUsage(), fetchRevenue()]);
    setRefreshing(false);
  }, [fetchProducts, fetchInvoices, fetchSubscriptions, fetchCategories, fetchUsage, fetchRevenue]);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);
  useEffect(() => { if (activeTab === "revenue") { fetchRevenue(); } }, [activeTab, fetchRevenue]);
  useEffect(() => { if (activeTab === "performance") { fetchInvoices(); } }, [activeTab, fetchInvoices]);
  useEffect(() => { if (activeTab === "utilization") { Promise.allSettled([fetchSubscriptions(), fetchInvoices()]); } }, [activeTab, fetchSubscriptions, fetchInvoices]);
  useEffect(() => { if (activeTab === "category") { Promise.allSettled([fetchCategories(), fetchProducts()]); } }, [activeTab, fetchCategories]);
  useEffect(() => { if (activeTab === "usage") { fetchUsage(); } }, [activeTab, fetchUsage]);

  const fProducts = useMemo(() => filterByDateRange(products, "created_at", range, customStart, customEnd), [products, range, customStart, customEnd]);
  const fInvoices = useMemo(() => filterByDateRange(invoices, "created_at", range, customStart, customEnd), [invoices, range, customStart, customEnd]);
  const fSubscriptions = useMemo(() => filterByDateRange(subscriptions, "created_at", range, customStart, customEnd), [subscriptions, range, customStart, customEnd]);

  const totalProductPrice = fProducts.reduce((sum, p) => sum + parseFloat(p.default_price || 0), 0);
  const averageProductPrice = fProducts.length ? totalProductPrice / fProducts.length : 0;
  const usageProductCount = fProducts.filter((p) => p.product_type === "usage").length;

  const statusData = [
    { name: "Active", value: fProducts.filter((p) => p.status === "active").length, color: "#10b981" },
    { name: "Inactive", value: fProducts.filter((p) => p.status === "inactive").length, color: "#6b7280" },
    { name: "Archived", value: fProducts.filter((p) => p.status === "archived").length, color: "#94a3b8" },
  ].filter((d) => d.value > 0);

  const typeData = [
    { name: "Service", value: fProducts.filter((p) => p.product_type === "service").length, color: "#FF7A00" },
    { name: "Good", value: fProducts.filter((p) => p.product_type === "good").length, color: "#FF9B4D" },
    { name: "Subscription", value: fProducts.filter((p) => p.product_type === "subscription").length, color: "#10b981" },
    { name: "Usage", value: fProducts.filter((p) => p.product_type === "usage").length, color: "#f59e0b" },
    { name: "Retainer", value: fProducts.filter((p) => p.product_type === "retainer").length, color: "#f97316" },
    { name: "Other", value: fProducts.filter((p) => p.product_type === "other").length, color: "#6b7280" },
  ].filter((d) => d.value > 0);

  const categoryProductCount = categories.map((c) => ({
    name: c.name,
    count: c.product_count || c.products_count || 0,
    color: COLORS[categories.indexOf(c) % COLORS.length],
  })).filter((c) => c.count > 0);

  const productTypeCatalogCount = typeData.map((d) => ({ name: d.name, count: d.value }));
  const subscriptionStatusData = [
    { name: "Active", value: fSubscriptions.filter((s) => s.status === "active").length, color: "#10b981" },
    { name: "Paused", value: fSubscriptions.filter((s) => s.status === "paused").length, color: "#f59e0b" },
    { name: "Past Due", value: fSubscriptions.filter((s) => s.status === "past_due").length, color: "#f97316" },
    { name: "Cancelled", value: fSubscriptions.filter((s) => s.status === "cancelled").length, color: "#ef4444" },
    { name: "Expired", value: fSubscriptions.filter((s) => s.status === "expired").length, color: "#94a3b8" },
  ].filter((d) => d.value > 0);

  const subChurn = useMemo(() => {
    const total = fSubscriptions.length;
    const cancelled = fSubscriptions.filter((s) => s.status === "cancelled" || s.status === "expired").length;
    const active = fSubscriptions.filter((s) => s.status === "active").length;
    const churnRate = total ? (cancelled / total) * 100 : 0;
    const retentionRate = total ? ((total - cancelled) / total) * 100 : 0;
    return { total, cancelled, active, churnRate, retentionRate };
  }, [fSubscriptions]);

  const subTrend = useMemo(() => {
    const months = {};
    const key = (d) => { const dt = new Date(d); return isNaN(dt) ? "" : `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`; };
    fSubscriptions.forEach((s) => { const k = key(s.created_at); if (k) { months[k] = months[k] || { month: k, added: 0, churned: 0 }; months[k].added += 1; } });
    fSubscriptions.forEach((s) => {
      if (s.status === "cancelled" || s.status === "expired") {
        const k = key(s.cancelled_at || s.cancelled_date || s.end_date);
        if (k) { months[k] = months[k] || { month: k, added: 0, churned: 0 }; months[k].churned += 1; }
      }
    });
    const order = Object.keys(months).sort().slice(-12);
    return order.map((k) => ({ month: k, added: months[k].added, churned: months[k].churned }));
  }, [fSubscriptions]);

  const [exportLoading, setExportLoading] = useState(null);
  const handleExcelExport = async () => {
    setExportLoading('excel');
    try {
      const rows = fProducts.map((p) => [p.id, p.name, p.default_price, p.status, p.product_type]);
      await downloadExcel(rows, ['id','name','default_price','status','product_type'], 'products-report.xlsx');
    }
    catch (e) { /* Excel export failed */ } finally { setExportLoading(null); }
  };
  const handleAllExport = async (format) => {
    setExportLoading(format);
    try {
      if (format === 'json') await downloadJSON({ products: fProducts, invoices: fInvoices, subscriptions: fSubscriptions }, 'products-data.json');
      else if (format === 'csv') {
        const rows = fProducts.map((p) => [p.id, p.name, p.default_price, p.status]);
        await downloadCSV(rows, ['id','name','default_price','status'], 'products.csv');
      }
      else if (format === 'excel') await handleExcelExport();
    } catch (e) { /* Export failed */ } finally { setExportLoading(null); }
  };

  const renderTabNav = () => (
    <nav className="flex gap-0 border-b border-gray-200 overflow-x-auto">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        return (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
              activeTab === tab.key ? "border-brand-600 text-brand-600" : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}>
            <Icon className="h-4 w-4" /> {tab.label}
          </button>
        );
      })}
    </nav>
  );

  return (
    <HRPage title="Product Reports" subtitle="Product analytics and reporting">

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider mr-1">
          <CalendarClock size={14} /> Quick ranges
        </span>
        {PRESETS.map((preset) => (
          <button key={preset.id} onClick={() => setRange(preset.id)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              range === preset.id ? "bg-brand-600 text-white border-brand-600 shadow-sm" : "bg-white text-slate-600 border-slate-200 hover:bg-brand-50 hover:text-brand-700"
            }`}>
            {preset.label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between mb-6">
        {renderTabNav()}
        <div className="flex items-center gap-2">
          <DateRangeFilter value={range} onChange={setRange} customStart={customStart} customEnd={customEnd}
            onCustomStartChange={setCustomStart} onCustomEndChange={setCustomEnd} />
          <ExportMenu
            onExportExcel={() => handleAllExport('excel')}
            onExportCSV={() => handleAllExport('csv')}
            onExportJSON={() => handleAllExport('json')}
          />
          <button onClick={refreshAll} disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {activeTab === "revenue" && (
        <div className="space-y-6">
          {loadingRevenue ? <Spinner /> : errorRevenue && revenueData.length === 0 ? (
            <ErrorState message={errorRevenue} onRetry={fetchRevenue} />
          ) : revenueData.length === 0 ? (
            <EmptyState icon={DollarSign} title="No revenue data" message="Invoice and dashboard data will appear here once available." />
          ) : (
            <>
              {revenueData.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 p-6">
                  <h3 className="text-sm font-semibold text-gray-900 mb-4">Revenue Trend (12 months)</h3>
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={revenueData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                      <Tooltip formatter={(v) => formatCurrency(v, baseCurrency)} />
                      <Area type="monotone" dataKey="revenue" stroke="#FF7A00" fill="#FFC9A6" strokeWidth={2} name="Revenue" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "performance" && (
        <div className="space-y-6">
          {loadingProducts ? <Spinner /> : errorProducts ? <ErrorState message={errorProducts} onRetry={fetchProducts} /> : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Products</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{fProducts.length}</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Active</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{fProducts.filter((p) => p.status === "active").length}</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Usage Products</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{usageProductCount}</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Avg Price/Product</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1 whitespace-nowrap">{formatCurrency(averageProductPrice, baseCurrency)}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white rounded-xl border border-gray-200 p-6">
                  <h3 className="text-sm font-semibold text-gray-900 mb-4">Product Status Distribution</h3>
                  {statusData.length === 0 ? <EmptyState icon={TrendingUp} title="No data" /> : (
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie data={statusData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value" label={({ name, value }) => `${name}: ${value}`}>
                          {statusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-6">
                  <h3 className="text-sm font-semibold text-gray-900 mb-4">Product Type Breakdown</h3>
                  {typeData.length === 0 ? <EmptyState icon={PieChartIcon} title="No data" /> : (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={typeData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                        <Tooltip />
                        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                          {typeData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "utilization" && (
        <div className="space-y-6">
          {loadingInvoices || loadingSubs ? <Spinner /> : (errorInvoices || errorSubs) ? <ErrorState message={errorInvoices || errorSubs} onRetry={() => { fetchInvoices(); fetchSubscriptions(); }} /> : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Subscriptions</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{fSubscriptions.length}</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Invoices</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{fInvoices.length}</p>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">Product Catalog by Type</h3>
                {productTypeCatalogCount.length === 0 ? (
                  <EmptyState icon={BarChart3} title="No product type data" />
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={productTypeCatalogCount}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip />
                      <Bar dataKey="count" fill="#FF7A00" radius={[4, 4, 0, 0]} name="Products" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">Subscription Status Breakdown</h3>
                {subscriptionStatusData.length === 0 ? (
                  <EmptyState icon={Box} title="No subscriptions" />
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={subscriptionStatusData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value" label={({ name, value }) => `${name}: ${value}`}>
                        {subscriptionStatusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <div className="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <UserPlus size={14} className="text-brand-600" /> Active Subs
                  </div>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{subChurn.active}</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <div className="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <UserMinus size={14} className="text-red-500" /> Churned
                  </div>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{subChurn.cancelled}</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Churn Rate</p>
                  <p className={`text-2xl font-bold mt-1 ${subChurn.churnRate > 10 ? "text-red-600" : "text-emerald-600"}`}>{subChurn.churnRate.toFixed(1)}%</p>
                  <p className="text-xs text-gray-400 mt-0.5">{subChurn.cancelled} of {subChurn.total} subscriptions</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Retention Rate</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{subChurn.retentionRate.toFixed(1)}%</p>
                  <p className="text-xs text-gray-400 mt-0.5">Expansion health</p>
                </div>
              </div>

              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-1">Subscription Growth & Churn</h3>
                <p className="text-xs text-gray-400 mb-4">Monthly additions vs churned subscriptions</p>
                {subTrend.length === 0 ? (
                  <EmptyState icon={TrendingUp} title="No subscription history" />
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={subTrend}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip />
                      <Area type="monotone" dataKey="added" stroke="#10b981" fill="#a7f3d0" strokeWidth={2} name="Added" />
                      <Area type="monotone" dataKey="churned" stroke="#ef4444" fill="#fecaca" strokeWidth={2} name="Churned" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "category" && (
        <div className="space-y-6">
          {loadingCats ? <Spinner /> : errorCats ? <ErrorState message={errorCats} onRetry={fetchCategories} /> : categoryProductCount.length === 0 ? (
            <EmptyState icon={PieChartIcon} title="No category data" message="Categories with products will appear here." />
          ) : (
            <>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-900">Products by Category</h3>
                  <button onClick={() => downloadJSON(categoryProductCount, "products-by-category.json")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">
                    <Download className="h-3.5 w-3.5" /> Export
                  </button>
                </div>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={categoryProductCount}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {categoryProductCount.map((entry, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">Category Details</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Category</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Products</th>
                      </tr>
                    </thead>
                    <tbody>
                      {categoryProductCount.map((c, i) => (
                        <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-3 px-3 font-medium text-gray-900">{c.name}</td>
                          <td className="py-3 px-3 text-right text-gray-500">{c.count}</td>
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

      {activeTab === "usage" && (
        <div className="space-y-6">
          {loadingUsage ? <Spinner /> : errorUsage ? <ErrorState message={errorUsage} onRetry={fetchUsage} /> : usageProducts.length === 0 ? (
            <EmptyState icon={Box} title="No usage products" message="Usage-based products will appear here once created." />
          ) : (
            <>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-900">Usage-Based Products</h3>
                  <button onClick={() => downloadJSON(usageProducts, "usage-products.json")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200">
                    <Download className="h-3.5 w-3.5" /> Export
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Product</th>
                        <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Unit</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Price</th>
                        <th scope="col" className="text-center py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usageProducts.map((p) => (
                        <tr key={p.id} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-3 px-3 font-medium text-gray-900">{p.name}</td>
                          <td className="py-3 px-3 text-gray-500">{p.unit_label || "—"}</td>
                          <td className="py-3 px-3 text-right font-medium text-gray-900">{formatCurrency(p.default_price || 0, p.currency || baseCurrency)}</td>
                          <td className="py-3 px-3 text-center">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              p.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-600"
                            }`}>{p.status}</span>
                          </td>
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
