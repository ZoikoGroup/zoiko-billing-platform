import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { DollarSign, TrendingUp, Package, Box, Boxes, Layers, Award, Flame, AlertCircle, RefreshCw, PlusCircle, Gauge, PauseCircle, CheckCircle } from "lucide-react";
import { PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area } from "recharts";
import { productApi, invoiceApi, dashboardApi } from "../../../service/billingService";
import {
  DashboardHeader, DashboardStatCard, DashboardStatCardSkeleton, DashboardChartCard,
  DashboardChartCardSkeleton, DashboardChartErrorBoundary, DashboardEmptyPanel,
  DASHBOARD_KPI_GRID, DASHBOARD_CHART_GRID,
  exportDashboardToCsv, exportDashboardToJson,
  BusinessInsights, QuickActions, ActionCenter,
} from "../../../components/billing-shared";
import { Button, StatGroup } from "../../../components/billing-ui";
import { extractArray, formatDisplayCurrency, formatCompactCurrency } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { useBillingDateRange } from "../utils/DateRangeContext";

// Recent-paid-invoices sample used to derive real (not invented) per-product
// revenue/frequency signals for the "Top Products" and "Most Used" panels —
// there is no dedicated product-analytics endpoint, and aggregating invoice
// items across the *entire* catalog would mean one request per invoice, so
// this is capped to a bounded, recent sample via the existing
// invoiceApi.list / invoiceApi.listItems endpoints.
const TOP_PRODUCTS_INVOICE_SAMPLE_SIZE = 15;
const CHART_COLORS = ["#FF7A00", "#FF9B4D", "#FFC9A6", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4899", "#14b8a6", "#f97316"];

function filterByCreatedAt(items, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return items;
  return items.filter((item) => {
    if (!item?.created_at) return true;
    const created = String(item.created_at).slice(0, 10);
    if (dateFrom && created < dateFrom) return false;
    if (dateTo && created > dateTo) return false;
    return true;
  });
}

function monthKey(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

export default function ProductsDashboard() {
  const navigate = useNavigate();
  const { formatCurrency, baseCurrency } = useCurrency();
  const {
    range: dateRangeValue, setRange: setDateRangeValue,
    customStart, customEnd, applyCustomRange, reset: resetDateRange,
    dateRange,
  } = useBillingDateRange();
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const [products, setProducts] = useState([]);
  const [productsTotal, setProductsTotal] = useState(0);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [errorProducts, setErrorProducts] = useState(null);

  const [categories, setCategories] = useState([]);
  const [errorCategories, setErrorCategories] = useState(null);

  const [usageProducts, setUsageProducts] = useState([]);

  const [revenueData, setRevenueData] = useState([]);
  const [errorRevenue, setErrorRevenue] = useState(null);

  const [revenueGranularity, setRevenueGranularity] = useState("monthly");

  const [productLineItems, setProductLineItems] = useState([]); // flattened invoice line items, recent paid-invoice sample
  const [errorLineItems, setErrorLineItems] = useState(null);

  const fetchDashboardData = useCallback(async () => {
    try {
      setRefreshing(true);
      setErrorProducts(null); setErrorCategories(null); setErrorRevenue(null); setErrorLineItems(null);

      const [productsData, categoriesData, revenueRes, recentPaidInvoices, usageRes] = await Promise.allSettled([
        productApi.list({ per_page: 200 }),
        productApi.listCategories({ per_page: 100 }),
        dashboardApi.getMonthlyRevenue(12),
        invoiceApi.list({ per_page: TOP_PRODUCTS_INVOICE_SAMPLE_SIZE, status: "paid" }),
        productApi.listUsageBillable(),
      ]);

      let productItems = [];
      if (productsData.status === "fulfilled") {
        productItems = extractArray(productsData.value);
        setProducts(productItems);
        setProductsTotal(Number(productsData.value?.total ?? productItems.length));
      } else {
        setErrorProducts(productsData.reason?.message || "Failed to load products");
      }

      if (categoriesData.status === "fulfilled") {
        setCategories(extractArray(categoriesData.value));
      } else {
        setErrorCategories(categoriesData.reason?.message || "Failed to load categories");
      }

      if (usageRes.status === "fulfilled") {
        setUsageProducts(extractArray(usageRes.value));
      }

      if (revenueRes.status === "fulfilled" && revenueRes.value) {
        const raw = Array.isArray(revenueRes.value) ? revenueRes.value : revenueRes.value?.monthly_revenue || revenueRes.value?.data || revenueRes.value?.items || [];
        const mapped = raw.map((r) => ({
          month: r.month || r.label || "",
          revenue: parseFloat(r.revenue || r.amount || r.total || 0),
        })).filter((r) => r.month);
        setRevenueData(mapped);
      } else if (revenueRes.status === "rejected") {
        setErrorRevenue(revenueRes.reason?.message || "Failed to load revenue data");
      }

      if (recentPaidInvoices.status === "fulfilled") {
        const invoices = extractArray(recentPaidInvoices.value);
        const itemResults = await Promise.allSettled(
          invoices.map((inv) => invoiceApi.listItems(inv.id))
        );
        const flattened = itemResults
          .filter((r) => r.status === "fulfilled")
          .flatMap((r) => extractArray(r.value))
          .filter((item) => item?.product_id != null);
        setProductLineItems(flattened);
      } else {
        setErrorLineItems(recentPaidInvoices.reason?.message || "Failed to load recent invoice activity");
      }

      setLastUpdated(new Date());
    } catch (err) {
      setErrorProducts(`Dashboard error: ${err?.message || "Unknown"}`);
    } finally {
      setRefreshing(false);
      setLoadingProducts(false);
    }
  }, []);

  useEffect(() => { fetchDashboardData(); }, [fetchDashboardData]);

  const filteredProducts = useMemo(
    () => filterByCreatedAt(products, dateRange.date_from, dateRange.date_to),
    [products, dateRange.date_from, dateRange.date_to]
  );
  const filteredCategories = useMemo(
    () => filterByCreatedAt(categories, dateRange.date_from, dateRange.date_to),
    [categories, dateRange.date_from, dateRange.date_to]
  );

  const activeProducts = useMemo(() => filteredProducts.filter((p) => p.status === "active"), [filteredProducts]);
  const inventoryProducts = useMemo(() => filteredProducts.filter((p) => p.product_type === "good" && p.status === "active"), [filteredProducts]);

  const totalRevenue = useMemo(() => revenueData.reduce((sum, r) => sum + r.revenue, 0), [revenueData]);

  const revenueTrend = useMemo(() => {
    const series = revenueData.filter((r) => r.revenue > 0);
    if (series.length < 2) return null;
    const last = series[series.length - 1].revenue;
    const prev = series[series.length - 2].revenue;
    if (prev <= 0) return null;
    const pct = ((last - prev) / prev) * 100;
    return {
      trend: pct >= 0 ? "up" : "down",
      trendValue: `${Math.abs(pct).toFixed(1)}% MoM`,
    };
  }, [revenueData]);

  // Revenue series re-bucketed by granularity — aggregates the trailing 12
  // monthly points into coarser buckets (no synthetic sub-month data).
  const revenueChartData = useMemo(() => {
    if (!revenueData.length) return [];
    const buckets = revenueGranularity === "monthly" ? 12 : revenueGranularity === "weekly" ? 6 : 4;
    const size = Math.max(1, Math.ceil(revenueData.length / buckets));
    const out = [];
    for (let i = 0; i < revenueData.length; i += size) {
      const slice = revenueData.slice(i, i + size);
      out.push({
        label: slice.length === 1 ? slice[0].month : `${slice[0].month} – ${slice[slice.length - 1].month}`,
        revenue: slice.reduce((s, r) => s + r.revenue, 0),
      });
    }
    return out;
  }, [revenueData, revenueGranularity]);

  const activeMetersCount = useMemo(
    () => usageProducts.filter((p) => p.status === "active").length,
    [usageProducts]
  );

  const categoryChartData = useMemo(() =>
    filteredCategories.map((cat, i) => ({
      name: cat.name || cat.category_name || `Category ${i + 1}`,
      value: cat.product_count ?? cat.products_count ?? 0,
      color: CHART_COLORS[i % CHART_COLORS.length],
    })).filter((c) => c.value > 0),
    [filteredCategories]
  );

  // Product Growth: how many products were added to the catalog per month,
  // over the last 6 calendar months — computed client-side from created_at
  // since there is no dedicated product-growth endpoint.
  const productGrowthData = useMemo(() => {
    const now = new Date();
    const buckets = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ key: d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }), count: 0 });
    }
    const bucketIndex = new Map(buckets.map((b, idx) => [b.key, idx]));
    products.forEach((p) => {
      const key = monthKey(p.created_at);
      if (key != null && bucketIndex.has(key)) buckets[bucketIndex.get(key)].count += 1;
    });
    return buckets.map((b) => ({ month: b.key, products: b.count }));
  }, [products]);

  const productNameById = useMemo(() => {
    const map = new Map();
    products.forEach((p) => map.set(p.id, p.name || `Product #${p.id}`));
    return map;
  }, [products]);

  // Top Products (by revenue) and Most Used (by frequency) — both derived
  // from the same recent-paid-invoice line-item sample (see
  // TOP_PRODUCTS_INVOICE_SAMPLE_SIZE note above).
  const { topProductsByRevenue, mostUsedProducts } = useMemo(() => {
    const revenueMap = new Map();
    const countMap = new Map();
    productLineItems.forEach((item) => {
      const pid = item.product_id;
      const amount = parseFloat(item.total ?? item.amount ?? 0) || 0;
      revenueMap.set(pid, (revenueMap.get(pid) || 0) + amount);
      countMap.set(pid, (countMap.get(pid) || 0) + 1);
    });
    const nameFor = (pid) => productNameById.get(pid) || `Product #${pid}`;
    const byRevenue = Array.from(revenueMap.entries())
      .map(([pid, revenue]) => ({ id: pid, name: nameFor(pid), revenue }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);
    const byCount = Array.from(countMap.entries())
      .map(([pid, count]) => ({ id: pid, name: nameFor(pid), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    return { topProductsByRevenue: byRevenue, mostUsedProducts: byCount };
  }, [productLineItems, productNameById]);

  const topPerformer = useMemo(() => topProductsByRevenue[0] || null, [topProductsByRevenue]);

  const inactiveProductsCount = useMemo(
    () => Math.max(filteredProducts.length - activeProducts.length, 0),
    [filteredProducts.length, activeProducts.length]
  );

  const topCategory = useMemo(() => {
    if (!categoryChartData.length) return null;
    const totalCategorized = categoryChartData.reduce((sum, c) => sum + c.value, 0);
    if (totalCategorized <= 0) return null;
    const top = categoryChartData.reduce((max, c) => (c.value > max.value ? c : max), categoryChartData[0]);
    return { name: top.name, share: (top.value / totalCategorized) * 100 };
  }, [categoryChartData]);

  const insightItems = useMemo(() => {
    const items = [];
    if (topProductsByRevenue.length > 0) {
      const top = topProductsByRevenue[0];
      const denom = topProductsByRevenue.reduce((sum, p) => sum + p.revenue, 0) || top.revenue;
      const share = denom > 0 ? (top.revenue / denom) * 100 : 0;
      items.push({
        tone: "up",
        icon: Award,
        text: `${top.name} leads with ${share.toFixed(0)}% of top-product revenue`,
      });
    }
    if (topCategory) {
      items.push({
        tone: "neutral",
        icon: Layers,
        text: `${topCategory.name} is the largest category at ${topCategory.share.toFixed(0)}% of products`,
      });
    }
    if (inactiveProductsCount > 0) {
      items.push({
        tone: "warning",
        icon: PauseCircle,
        text: `${inactiveProductsCount} product${inactiveProductsCount === 1 ? "" : "s"} inactive and not sellable`,
      });
    }
    if (!items.length) {
      items.push({ tone: "up", icon: CheckCircle, text: "Catalog is healthy — all products active" });
    }
    return items;
  }, [topProductsByRevenue, topCategory, inactiveProductsCount]);

  // Active products that never showed up in the recent-paid-invoice line-item
  // sample (see TOP_PRODUCTS_INVOICE_SAMPLE_SIZE note above) — a lightweight,
  // real signal for "not selling lately", scoped to active products only so
  // it doesn't double-count products already flagged as inactive.
  const noRecentSalesCount = useMemo(() => {
    const soldProductIds = new Set(productLineItems.map((item) => item.product_id));
    return activeProducts.filter((p) => !soldProductIds.has(p.id)).length;
  }, [activeProducts, productLineItems]);

  const actionItems = useMemo(() => {
    const items = [];
    if (inactiveProductsCount > 0) {
      items.push({
        icon: PauseCircle,
        tone: "neutral",
        priority: "low",
        title: `${inactiveProductsCount} inactive product${inactiveProductsCount === 1 ? "" : "s"}`,
        description: "Not currently available for sale",
        href: "/billing/products",
      });
    }
    if (noRecentSalesCount > 0) {
      items.push({
        icon: AlertCircle,
        tone: "warning",
        priority: "medium",
        title: `${noRecentSalesCount} product${noRecentSalesCount === 1 ? "" : "s"} with no recent sales`,
        description: "No line-item activity in the recent invoice sample",
        href: "/billing/products",
      });
    }
    return items;
  }, [inactiveProductsCount, noRecentSalesCount]);

  const productQuickActions = useMemo(() => [
    { label: "Add Product", hint: "Create a new product or service", href: "/billing/products", icon: Package },
    { label: "Categories", hint: "Organize your catalog", href: "/billing/products/categories", icon: Layers },
    { label: "Pricing", hint: "Manage pricing plans", href: "/billing/pricing", icon: DollarSign },
    { label: "Usage Billing", hint: "Meter usage-based products", href: "/billing/usage-billing", icon: Gauge },
  ], []);

  const handleExport = useCallback((format) => {
    const payload = {
      products: filteredProducts,
      categories: filteredCategories,
      revenue_trend: revenueData,
      top_products_by_revenue: topProductsByRevenue,
      most_used_products: mostUsedProducts,
      product_growth: productGrowthData,
    };
    if (format === "csv") exportDashboardToCsv(payload, "products-dashboard");
    else exportDashboardToJson(payload, "products-dashboard");
  }, [filteredProducts, filteredCategories, revenueData, topProductsByRevenue, mostUsedProducts, productGrowthData]);

  const headerProps = {
    title: "Products Dashboard",
    subtitle: "Catalog health, category mix, and product performance at a glance",
    icon: Package,
    crumbs: [{ label: "Billing", href: "/billing" }, { label: "Products" }],
    primaryAction: (
      <Button variant="primary" icon={PlusCircle} onClick={() => navigate("/billing/products")}>
        Add Product
      </Button>
    ),
    lastUpdated,
    onRefresh: fetchDashboardData,
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

  if (loadingProducts && products.length === 0) {
    return (
      <div className="space-y-8 px-4 py-6 sm:px-6" aria-label="Loading products dashboard">
        <DashboardHeader {...headerProps} />
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 5 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)}
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

  return (
    <div className="space-y-8 px-4 py-6 sm:px-6">
      <DashboardHeader {...headerProps} />

      {errorProducts && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" /> {errorProducts}
          <button onClick={fetchDashboardData} className="ml-auto inline-flex items-center gap-1 px-3 py-1 text-xs font-medium text-red-700 bg-red-100 rounded-lg hover:bg-red-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400">
            <RefreshCw className="h-3 w-3" /> Retry
          </button>
        </div>
      )}

      <BusinessInsights items={insightItems} />

      <ActionCenter items={actionItems} />

      <div className={DASHBOARD_KPI_GRID}>
        <div className="h-full min-w-0"><DashboardStatCard title="Total Products" value={productsTotal || filteredProducts.length} subtitle="Full product catalog" icon={Package} color="from-brand to-brand-hover" href="/billing/products" /></div>
        <div className="h-full min-w-0"><DashboardStatCard title="Active Products" value={activeProducts.length} subtitle="Currently sellable" icon={Boxes} color="from-emerald-500 to-green-500" href="/billing/products?status=active" /></div>
        <div className="h-full min-w-0"><DashboardStatCard title="Inventory" value={inventoryProducts.length} subtitle="Active physical goods" icon={Box} color="from-amber-500 to-orange-500" href="/billing/products?type=good" /></div>
        <div className="h-full min-w-0"><DashboardStatCard title="Categories" value={filteredCategories.length} subtitle="Product categories" icon={Layers} color="from-blue-500 to-cyan-500" href="/billing/products/categories" /></div>
      </div>

      <StatGroup title="Performance">
        <div className="h-full min-w-0">
          <DashboardStatCard
            title="Revenue"
            value={Number(totalRevenue)}
            currency={baseCurrency}
            trend={revenueTrend?.trend}
            trendValue={revenueTrend?.trendValue}
            subtitle="Trailing 12 months"
            icon={DollarSign}
            color="from-brand to-brand-hover"
            href="/billing/products/reports"
            sparkline={revenueData.map((r) => r.revenue)}
          />
        </div>
        <div className="h-full min-w-0">
          <DashboardStatCard
            title="Active Meters"
            value={activeMetersCount}
            trend={activeMetersCount > 0 ? "up" : "flat"}
            trendValue={activeMetersCount > 0 ? `${usageProducts.length} total meters` : "No meters yet"}
            subtitle="Usage-based metered products"
            icon={Gauge}
            color="from-amber-500 to-orange-500"
            href="/billing/usage-billing"
          />
        </div>
        <div className="h-full min-w-0">
          <DashboardStatCard
            title="Top Performing Product"
            value={topPerformer ? topPerformer.name : "—"}
            subtitle={topPerformer ? `${formatDisplayCurrency(topPerformer.revenue, baseCurrency)} in recent paid invoices` : "No recent sales yet"}
            icon={Award}
            color="from-indigo-500 to-blue-500"
            href="/billing/products"
          />
        </div>
        <div className="h-full min-w-0">
          <DashboardStatCard
            title="Largest Category"
            value={topCategory ? `${topCategory.share.toFixed(0)}%` : "—"}
            subtitle={topCategory ? topCategory.name : "Of categorized products"}
            icon={Layers}
            color="from-emerald-500 to-green-500"
            href="/billing/products/categories"
          />
        </div>
      </StatGroup>

      <QuickActions actions={productQuickActions} />

      <div className={DASHBOARD_CHART_GRID}>
        <div className="xl:col-span-2">
          <DashboardChartCard
            title="Revenue Trend"
            action={
              <div className="inline-flex items-center rounded-xl border border-slate-200 bg-slate-50 p-0.5">
                {[
                  { id: "daily", label: "Daily" },
                  { id: "weekly", label: "Weekly" },
                  { id: "monthly", label: "Monthly" },
                ].map((g) => (
                  <button key={g.id} onClick={() => setRevenueGranularity(g.id)} aria-label={`${g.label} view`}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${revenueGranularity === g.id ? "bg-white text-brand-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>
                    {g.label}
                  </button>
                ))}
              </div>
            }
          >
            <DashboardChartErrorBoundary>
              {errorRevenue && revenueData.length === 0 ? (
                <DashboardEmptyPanel title={errorRevenue} message="Revenue data unavailable right now." icon={DollarSign} />
              ) : revenueChartData.length === 0 ? (
                <DashboardEmptyPanel title="No revenue data" message="Monthly revenue from invoices and dashboards will show up here." icon={DollarSign} />
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={revenueChartData}>
                    <defs>
                      <linearGradient id="revenueTrendGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#FF7A00" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#FF7A00" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCompactCurrency(v)} />
                    <Tooltip formatter={(v) => [formatDisplayCurrency(v, baseCurrency), "Revenue"]} />
                    <Area type="monotone" dataKey="revenue" stroke="#FF7A00" strokeWidth={2} fill="url(#revenueTrendGrad)" name="Revenue" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </DashboardChartErrorBoundary>
          </DashboardChartCard>
        </div>
      </div>

      <div className={DASHBOARD_CHART_GRID}>
        <DashboardChartCard title="Product Growth">
          <DashboardChartErrorBoundary>
            {productGrowthData.every((b) => b.products === 0) ? (
              <DashboardEmptyPanel title="No growth data" message="New products added to the catalog will show up here month over month." icon={TrendingUp} ctaText="Add Product" onCtaClick={() => navigate("/billing/products")} steps={[
                { label: "Categories", icon: Layers, onClick: () => navigate("/billing/products/categories") },
                { label: "Inventory", icon: Box, onClick: () => navigate("/billing/products") },
              ]} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={productGrowthData}>
                  <defs>
                    <linearGradient id="productGrowthGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#FF7A00" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#FF7A00" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip formatter={(v) => [`${v} product${v === 1 ? "" : "s"}`, "Added"]} />
                  <Area type="monotone" dataKey="products" stroke="#FF7A00" strokeWidth={2} fill="url(#productGrowthGrad)" name="New Products" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title="Category Distribution">
          <DashboardChartErrorBoundary>
            {categoryChartData.length === 0 ? (
              <DashboardEmptyPanel title={errorCategories || "No category data"} message="Products will be grouped by category here." icon={Layers} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={categoryChartData} cx="50%" cy="50%" outerRadius={100} innerRadius={60} paddingAngle={3} dataKey="value" label={({ name, percent }) => `${name} (${(percent * 100).toFixed(0)}%)`}>
                    {categoryChartData.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => [`${value} products`, "Products"]} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>
      </div>

      <div className={DASHBOARD_CHART_GRID}>
        <DashboardChartCard title="Top Products" action={<span className="text-xs text-slate-500 flex items-center gap-1"><Award size={12} /> By revenue</span>}>
          <DashboardChartErrorBoundary>
            {topProductsByRevenue.length === 0 ? (
              <DashboardEmptyPanel title={errorLineItems || "No revenue data yet"} message="Ranks products by revenue from recent paid invoices." icon={Award} />
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-slate-500 -mt-1 mb-1">Based on the {TOP_PRODUCTS_INVOICE_SAMPLE_SIZE} most recent paid invoices</p>
                {topProductsByRevenue.map((p, idx) => {
                  const max = topProductsByRevenue[0].revenue || 1;
                  return (
                    <div key={p.id} className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 w-4 shrink-0">{idx + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-sm font-medium text-slate-700 truncate">{p.name}</span>
                          <span className="text-sm font-semibold text-slate-800 shrink-0">{formatDisplayCurrency(p.revenue, baseCurrency)}</span>
                        </div>
                        <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-gradient-to-r from-brand to-brand-hover" style={{ width: `${Math.max(4, (p.revenue / max) * 100)}%` }} />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title="Most Used" action={<span className="text-xs text-slate-500 flex items-center gap-1"><Flame size={12} /> By frequency</span>}>
          <DashboardChartErrorBoundary>
            {mostUsedProducts.length === 0 ? (
              <DashboardEmptyPanel title={errorLineItems || "No usage data yet"} message="Ranks products by how often they appear on recent paid invoices." icon={Flame} />
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-slate-500 -mt-1 mb-1">Based on the {TOP_PRODUCTS_INVOICE_SAMPLE_SIZE} most recent paid invoices</p>
                {mostUsedProducts.map((p, idx) => {
                  const max = mostUsedProducts[0].count || 1;
                  return (
                    <div key={p.id} className="flex items-center gap-3">
                      <span className="text-xs font-semibold text-slate-500 w-4 shrink-0">{idx + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-sm font-medium text-slate-700 truncate">{p.name}</span>
                          <span className="text-sm font-semibold text-slate-800 shrink-0">{p.count}×</span>
                        </div>
                        <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-500" style={{ width: `${Math.max(4, (p.count / max) * 100)}%` }} />
                        </div>
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
