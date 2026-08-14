import { useState, useEffect, useCallback } from "react";
import {
  DollarSign, Tag, Layers, Package, TrendingUp, BarChart3, AlertTriangle, Calendar, Globe, BadgePercent, Gauge,
  CheckCircle, List, SlidersHorizontal, PlusCircle,
} from "lucide-react";
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList,
} from "recharts";
import { useNavigate } from "react-router-dom";
import { pricingApi, productApi, subscriptionApi, currencyPricingApi, discountApi } from "../../../service/billingService";
import { extractArray, formatDisplayCurrency } from "../../../utils/billing-helpers";
import {
  DashboardHeader, DashboardStatCard, DashboardStatCardSkeleton, DashboardChartCard,
  DashboardChartCardSkeleton, DashboardChartErrorBoundary, DashboardEmptyPanel,
  DASHBOARD_KPI_GRID, DASHBOARD_CHART_GRID, DASHBOARD_CHART_GRID_3,
  exportDashboardToCsv, exportDashboardToJson, ErrorState, BusinessInsights, QuickActions, ActionCenter,
} from "../../../components/billing-shared";
import { Button, StatGroup } from "../../../components/billing-ui";
import { useBillingDateRange } from "../utils/DateRangeContext";
import { useCurrency } from "../utils/CurrencyContext";

const COLORS = ["#FF7A00", "#FF9B4D", "#FFC9A6", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4898"];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function daysFromNow(dateStr) {
  const d = new Date(dateStr);
  const n = new Date();
  return Math.ceil((d - n) / (1000 * 60 * 60 * 24));
}

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

export default function PricingDashboardPage() {
  const navigate = useNavigate();
  const { baseCurrency } = useCurrency();
  const {
    range: dateRangeValue, setRange: setDateRangeValue,
    customStart, customEnd, applyCustomRange, reset: resetDateRange,
    dateRange,
  } = useBillingDateRange();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const [plans, setPlans] = useState([]);
  const [products, setProducts] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [tierCount, setTierCount] = useState(0);
  const [currencyItems, setCurrencyItems] = useState([]);
  const [discountItems, setDiscountItems] = useState([]);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      const [planRes, prodRes, subRes, currencyRes, discountRes] = await Promise.allSettled([
        pricingApi.list({ per_page: 200 }),
        productApi.list({ per_page: 200 }),
        subscriptionApi.list({ per_page: 100 }),
        currencyPricingApi.list({ per_page: 200 }),
        discountApi.list({ per_page: 200 }),
      ]);
      const plansData = planRes.status === "fulfilled" ? extractArray(planRes.value) : [];
      setPlans(plansData);
      if (prodRes.status === "fulfilled") setProducts(extractArray(prodRes.value));
      if (subRes.status === "fulfilled") setSubscriptions(extractArray(subRes.value));
      setCurrencyItems(currencyRes.status === "fulfilled" ? extractArray(currencyRes.value) : []);
      setDiscountItems(discountRes.status === "fulfilled" ? extractArray(discountRes.value) : []);

      let totalTiers = 0;
      const tierResults = await Promise.allSettled(plansData.slice(0, 20).map((p) => pricingApi.listTiers(p.id)));
      tierResults.forEach((r) => {
        if (r.status === "fulfilled") {
          const tiers = extractArray(r.value);
          totalTiers += tiers.length;
        }
      });
      setTierCount(totalTiers);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message || "Failed to load data");
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filteredPlans = filterByCreatedAt(plans, dateRange.date_from, dateRange.date_to);

  const activePlans = filteredPlans.filter((p) => p.is_active);
  const today = todayStr();
  const expiredPlans = filteredPlans.filter((p) => p.effective_to && p.effective_to < today);
  const upcomingExpirations = filteredPlans.filter((p) => p.effective_to && p.effective_to >= today && daysFromNow(p.effective_to) <= 30 && daysFromNow(p.effective_to) >= 0);
  const productsWithPlans = new Set(filteredPlans.map((p) => p.product_id));
  const productsWithoutPlans = products.filter((p) => !productsWithPlans.has(p.id) || !productsWithPlans.has(String(p.id)));

  const avgPrice = activePlans.length ? activePlans.reduce((s, p) => s + parseFloat(p.unit_price || 0), 0) / activePlans.length : 0;
  const subRevenue = subscriptions.reduce((s, sub) => s + parseFloat(sub.amount || sub.price || 0), 0);
  const revenueCoveragePct = products.length ? ((productsWithPlans.size / products.length) * 100).toFixed(1) : "0.0";

  const statusData = [
    { name: "Active", value: activePlans.length, color: "#10b981" },
    { name: "Inactive", value: filteredPlans.filter((p) => !p.is_active).length, color: "#6b7280" },
  ].filter((d) => d.value > 0);

  const freqData = [
    { name: "One-Time", value: filteredPlans.filter((p) => p.billing_period === "one_time").length, color: "#FF7A00" },
    { name: "Monthly", value: filteredPlans.filter((p) => p.billing_period === "monthly").length, color: "#FF9B4D" },
    { name: "Quarterly", value: filteredPlans.filter((p) => p.billing_period === "quarterly").length, color: "#f59e0b" },
    { name: "Semi-Annual", value: filteredPlans.filter((p) => p.billing_period === "semi_annual").length, color: "#06b6d4" },
    { name: "Annual", value: filteredPlans.filter((p) => p.billing_period === "annual").length, color: "#10b981" },
  ].filter((d) => d.value > 0);

  const priceDistribution = filteredPlans.filter((p) => p.unit_price != null).map((p) => ({
    name: p.name,
    price: parseFloat(p.unit_price) || 0,
    fill: COLORS[filteredPlans.indexOf(p) % COLORS.length],
  })).sort((a, b) => b.price - a.price).slice(0, 10);

  const recentPlans = [...filteredPlans].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).slice(0, 5);
  const updatedPlans = [...filteredPlans].sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0)).slice(0, 5);

  const productPlanCount = products.map((p) => ({
    name: p.name,
    count: filteredPlans.filter((pl) => pl.product_id === p.id || pl.product?.id === p.id).length,
    color: COLORS[products.indexOf(p) % COLORS.length],
  })).filter((p) => p.count > 0).sort((a, b) => b.count - a.count).slice(0, 10);

  // Distinct currencies with an active price override — sourced from
  // currencyPricingApi since pricing plans themselves only carry a single
  // base currency each.
  const activeCurrencyItems = currencyItems.filter((c) => c.is_active !== false);
  const currencyCount = new Set(activeCurrencyItems.map((c) => c.currency)).size;

  const activeDiscounts = discountItems.filter((d) => (d.is_active ?? d.status === "active"));

  // "Usage Pricing" = plans priced on a non-flat (consumption-driven) model:
  // per-unit, tiered, volume or graduated — as opposed to a flat recurring fee.
  const usagePricingPlans = filteredPlans.filter((p) => {
    const model = p.pricing_model || p.plan_type;
    return model && model !== "flat";
  });

  // Revenue tied to pricing plans via active subscriptions (no dedicated
  // pricing-revenue endpoint exists yet, so this is computed client-side
  // the same way the reference Billing dashboard derives its KPIs).
  const revenue = subRevenue;

  const modelDistribution = [
    { name: "Flat Rate", value: filteredPlans.filter((p) => !(p.pricing_model || p.plan_type) || (p.pricing_model || p.plan_type) === "flat").length, color: "#FF7A00" },
    { name: "Per Unit", value: filteredPlans.filter((p) => (p.pricing_model || p.plan_type) === "per_unit").length, color: "#3b82f6" },
    { name: "Tiered", value: filteredPlans.filter((p) => (p.pricing_model || p.plan_type) === "tiered").length, color: "#f59e0b" },
    { name: "Volume", value: filteredPlans.filter((p) => (p.pricing_model || p.plan_type) === "volume").length, color: "#06b6d4" },
    { name: "Graduated", value: filteredPlans.filter((p) => (p.pricing_model || p.plan_type) === "graduated").length, color: "#ef4444" },
  ].filter((d) => d.value > 0);

  const handleExport = useCallback((format) => {
    const payload = {
      plans: filteredPlans,
      products: products,
      subscriptions: subscriptions,
      total_tiers: tierCount,
      currency_pricing: currencyItems,
      discounts: discountItems,
    };
    if (format === "csv") exportDashboardToCsv(payload, "pricing-dashboard");
    else exportDashboardToJson(payload, "pricing-dashboard");
  }, [filteredPlans, products, subscriptions, tierCount, currencyItems, discountItems]);

  const headerProps = {
    title: "Pricing Dashboard",
    subtitle: "Pricing overview and KPIs",
    icon: Tag,
    iconGradient: "from-pink-500 to-rose-500",
    crumbs: [{ label: "Billing", href: "/billing" }, { label: "Pricing" }],
    primaryAction: <Button variant="primary" icon={PlusCircle} onClick={() => navigate("/billing/pricing")}>New Pricing Plan</Button>,
    lastUpdated,
    onRefresh: () => { setRefreshing(true); fetchData(); },
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

  // Business insights — derived entirely from data already fetched above
  // (plans/products/discounts), no extra API calls.
  const insightItems = [];
  if (upcomingExpirations.length > 0) {
    insightItems.push({ tone: "warning", icon: Calendar, text: `${upcomingExpirations.length} pricing plan${upcomingExpirations.length === 1 ? "" : "s"} expiring within 30 days` });
  }
  if (expiredPlans.length > 0) {
    insightItems.push({ tone: "down", icon: AlertTriangle, text: `${expiredPlans.length} pricing plan${expiredPlans.length === 1 ? "" : "s"} past their effective end date` });
  }
  if (productsWithoutPlans.length > 0) {
    insightItems.push({ tone: "neutral", icon: Package, text: `${productsWithoutPlans.length} product${productsWithoutPlans.length === 1 ? "" : "s"} without a pricing plan` });
  }
  if (activeDiscounts.length > 0) {
    insightItems.push({ tone: "up", icon: BadgePercent, text: `${activeDiscounts.length} active discount${activeDiscounts.length === 1 ? "" : "s"} in effect` });
  }
  if (!insightItems.length) {
    insightItems.push({ tone: "up", icon: CheckCircle, text: "All plans active and every product has pricing coverage" });
  }

  // Action Center — reuses the same expiredPlans/upcomingExpirations/productsWithoutPlans
  // arrays already derived above, just surfaced as actionable rows instead of narrative text.
  const actionItems = [];
  if (expiredPlans.length > 0) {
    actionItems.push({
      icon: AlertTriangle, tone: "danger", priority: "high",
      title: `${expiredPlans.length} pricing plan${expiredPlans.length === 1 ? "" : "s"} expired`,
      description: "Still marked active but past their effective end date",
      href: "/billing/pricing",
    });
  }
  if (upcomingExpirations.length > 0) {
    actionItems.push({
      icon: Calendar, tone: "warning", priority: "medium",
      title: `${upcomingExpirations.length} plan${upcomingExpirations.length === 1 ? "" : "s"} expiring soon`,
      description: "Within the next 30 days",
      href: "/billing/pricing",
    });
  }
  if (productsWithoutPlans.length > 0) {
    actionItems.push({
      icon: Package, tone: "warning", priority: "medium",
      title: `${productsWithoutPlans.length} product${productsWithoutPlans.length === 1 ? "" : "s"} have no pricing plan`,
      description: "Can't be billed until priced",
      href: "/billing/products",
    });
  }

  const pricingQuickActions = [
    { label: "Tier Management", hint: "Manage volume & tiered pricing", href: "/billing/pricing/tier-management", icon: Layers },
    { label: "Price Lists", hint: "Region or customer-specific pricing", href: "/billing/pricing/price-lists", icon: List },
    { label: "Pricing Rules", hint: "Automate pricing logic", href: "/billing/pricing/pricing-rules", icon: SlidersHorizontal },
    { label: "Discount Engine", hint: "Manage active discounts", href: "/billing/pricing/discounts", icon: BadgePercent },
  ];

  if (loading) {
    return (
      <div className="space-y-8 px-4 py-6 sm:px-6" aria-label="Loading pricing dashboard">
        <DashboardHeader {...headerProps} />
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 4 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)}
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 4 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)}
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 4 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)}
        </div>
        <div className={DASHBOARD_CHART_GRID_3}>
          <DashboardChartCardSkeleton />
          <DashboardChartCardSkeleton />
          <DashboardChartCardSkeleton />
        </div>
      </div>
    );
  }

  if (error && plans.length === 0) {
    return (
      <div className="space-y-8 px-4 py-6 sm:px-6">
        <DashboardHeader {...headerProps} />
        <ErrorState message={error} onRetry={fetchData} />
      </div>
    );
  }

  return (
    <div className="space-y-8 px-4 py-6 sm:px-6">
      <DashboardHeader {...headerProps} />

      <BusinessInsights items={insightItems} />

      <ActionCenter items={actionItems} />

      <div className={DASHBOARD_KPI_GRID}>
        <DashboardStatCard title="Pricing Plans" value={filteredPlans.length} icon={Tag} color="from-brand to-brand-hover" subtitle="All pricing plans" href="/billing/pricing" />
        <DashboardStatCard title="Currencies" value={currencyCount} icon={Globe} color="from-blue-500 to-indigo-500"
          subtitle={currencyCount > 0 ? `${activeCurrencyItems.length} active price override(s)` : "No multi-currency pricing yet"} href="/billing/pricing/currency-pricing" />
        <DashboardStatCard title="Discounts" value={activeDiscounts.length} icon={BadgePercent} color="from-pink-500 to-rose-500"
          subtitle={`${discountItems.length} total discount(s)`} href="/billing/pricing/discounts" />
        <DashboardStatCard title="Usage Pricing" value={usagePricingPlans.length} icon={Gauge} color="from-cyan-500 to-teal-500"
          subtitle="Plans on per-unit, tiered, volume or graduated models" href="/billing/pricing" />
      </div>

      <StatGroup title="More Metrics">
        <DashboardStatCard title="Revenue" value={Number(revenue)} currency={baseCurrency} icon={DollarSign} color="from-emerald-500 to-green-600" subtitle="From active subscriptions on these plans" href="/billing/subscriptions" />
        <DashboardStatCard title="Avg Plan Price" value={Number(avgPrice)} currency={baseCurrency} icon={TrendingUp} color="from-teal-500 to-cyan-600" subtitle="Active plans only" />
        <DashboardStatCard title="Revenue Coverage" value={`${revenueCoveragePct}%`} icon={BarChart3} color="from-amber-500 to-orange-500"
          subtitle={`${productsWithPlans.size} of ${products.length} products have pricing`} />
        <DashboardStatCard title="Total Tiers" value={tierCount} icon={Layers} color="from-indigo-500 to-blue-600" subtitle="Across all tiered plans" href="/billing/pricing/tier-management" />
        <DashboardStatCard title="Active Plans" value={activePlans.length} icon={Layers} color="from-emerald-500 to-emerald-600"
          subtitle={`${filteredPlans.length ? ((activePlans.length / filteredPlans.length) * 100).toFixed(1) : 0}% of ${filteredPlans.length} total`} href="/billing/pricing" />
        <DashboardStatCard title="Expired Plans" value={expiredPlans.length} icon={AlertTriangle} color="from-red-500 to-rose-500"
          subtitle={expiredPlans.length > 0 ? "Past effective_to date" : "No expired plans"} href="/billing/pricing" />
        <DashboardStatCard title="Upcoming Expirations" value={upcomingExpirations.length} icon={Calendar} color="from-amber-500 to-orange-500"
          subtitle={upcomingExpirations.length > 0 ? "Expiring within 30 days" : "No upcoming expirations"} onClick={() => navigate("/billing/pricing")} />
        <DashboardStatCard title="Products w/o Plans" value={productsWithoutPlans.length} icon={Package} color="from-orange-500 to-orange-600"
          subtitle={`${products.length ? ((productsWithoutPlans.length / products.length) * 100).toFixed(0) : 0}% of products`} href="/billing/products" />
      </StatGroup>

      <QuickActions actions={pricingQuickActions} />

      <div className={DASHBOARD_CHART_GRID_3}>
        <DashboardChartCard title="Plan Distribution">
          <DashboardChartErrorBoundary>
            {modelDistribution.length === 0 ? (
              <DashboardEmptyPanel title="No data" message="Pricing plans by pricing model will appear here" icon={BarChart3} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={modelDistribution} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value" label={({ name, value }) => `${name}: ${value}`}>
                    {modelDistribution.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title="Plans by Status">
          <DashboardChartErrorBoundary>
            {statusData.length === 0 ? (
              <DashboardEmptyPanel title="No data" message="Pricing plans by status will appear here" icon={Tag} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={statusData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value" label={({ name, value }) => `${name}: ${value}`}>
                    {statusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title="Plans by Frequency">
          <DashboardChartErrorBoundary>
            {freqData.length === 0 ? (
              <DashboardEmptyPanel title="No data" message="Pricing plans by billing frequency will appear here" icon={Layers} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={freqData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {freqData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>
      </div>

      {priceDistribution.length > 0 && (
        <DashboardChartCard title="Top 10 Plans by Price">
          <DashboardChartErrorBoundary>
            <ResponsiveContainer width="100%" height={420}>
              <BarChart data={priceDistribution} layout="vertical" margin={{ top: 10, right: 60, left: 140, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => formatDisplayCurrency(v)} />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 11 }}
                  width={130}
                  tickFormatter={(val) => (val && val.length > 18 ? `${val.substring(0, 16)}...` : val)}
                />
                <Tooltip
                  formatter={(v) => [formatDisplayCurrency(v), "Price"]}
                  labelFormatter={(label) => `Plan: ${label}`}
                />
                <Bar dataKey="price" radius={[0, 4, 4, 0]}>
                  {priceDistribution.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                  <LabelList
                    dataKey="price"
                    position="right"
                    formatter={(v) => formatDisplayCurrency(v)}
                    style={{ fontSize: "11px", fontWeight: "600", fill: "#475569" }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </DashboardChartErrorBoundary>
        </DashboardChartCard>
      )}

      {productPlanCount.length > 0 && (
        <DashboardChartCard title="Plans by Product">
          <DashboardChartErrorBoundary>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={productPlanCount}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {productPlanCount.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </DashboardChartErrorBoundary>
        </DashboardChartCard>
      )}

      <div className={DASHBOARD_CHART_GRID}>
        <DashboardChartCard title="Recent Plans">
          <DashboardChartErrorBoundary>
            {recentPlans.length === 0 ? (
              <DashboardEmptyPanel title="No plans" message="Plans will appear here once created." icon={Tag} ctaText="New Pricing Plan" onCtaClick={() => navigate("/billing/pricing")} steps={[
                { label: "Products", icon: Package, onClick: () => navigate("/billing/products") },
                { label: "Categories", icon: Layers, onClick: () => navigate("/billing/products/categories") },
              ]} />
            ) : (
              <div className="space-y-3">
                {recentPlans.map((p) => (
                  <div key={p.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{p.name}</p>
                      <p className="text-xs text-slate-400">{p.billing_period?.replace(/_/g, " ")}</p>
                    </div>
                    <span className="text-sm font-semibold text-slate-800 whitespace-nowrap">{formatDisplayCurrency(p.unit_price, p.currency)}</span>
                  </div>
                ))}
              </div>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title="Recently Updated Plans">
          <DashboardChartErrorBoundary>
            {updatedPlans.length === 0 ? (
              <DashboardEmptyPanel title="No updates" message="Recently updated plans will appear here" icon={Tag} />
            ) : (
              <div className="space-y-3">
                {updatedPlans.map((p) => (
                  <div key={p.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-slate-800">{p.name}</p>
                      <p className="text-xs text-slate-400">{p.updated_at ? new Date(p.updated_at).toLocaleDateString() : "—"}</p>
                    </div>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      p.is_active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"
                    }`}>{p.is_active ? "active" : "inactive"}</span>
                  </div>
                ))}
              </div>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>
      </div>
    </div>
  );
}
