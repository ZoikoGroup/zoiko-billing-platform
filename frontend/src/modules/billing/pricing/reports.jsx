import { useState, useEffect, useCallback, useMemo } from "react";
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import { Tag, Layers, DollarSign, BarChart3, TrendingUp, Package, AlertCircle, RefreshCw } from "lucide-react";
import { pricingApi, productApi } from "../../../service/billingService";
import { extractArray, formatDisplayCurrency } from "../../../utils/billing-helpers";
import { DashboardHeader, useDateRange, DashboardEmptyPanel } from "../../../components/billing-shared";
import { filterByDateRange, downloadExcel, downloadCSV, downloadJSON } from "../../../utils/export-helpers";
import { useCurrency } from "../utils/CurrencyContext";

const COLORS = ["#FF7A00", "#FF9B4D", "#FFC9A6", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4899", "#14b8a6", "#f97316"];

const TABS = [
  { key: "summary", label: "Pricing Summary", icon: BarChart3 },
  { key: "revenue", label: "Revenue by Plan", icon: DollarSign },
  { key: "adoption", label: "Plan Adoption", icon: TrendingUp },
  { key: "utilization", label: "Tier Utilization", icon: Layers },
  { key: "product", label: "Product Pricing", icon: Package },
];

function ReportSection({ title, icon: Icon, children }) {
  return (
    <div className="bg-white border border-slate-200 rounded-3xl p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)] min-w-0">
      <div className="flex items-center gap-3 mb-6">
        <div className="h-10 w-10 rounded-xl bg-gradient-to-r from-brand to-brand-hover text-white flex items-center justify-center shrink-0">
          <Icon size={22} />
        </div>
        <h2 className="text-xl font-bold text-slate-800">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function StatBox({ label, value }) {
  return (
    <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 min-w-0">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider truncate">{label}</p>
      <p className="text-2xl font-extrabold text-slate-800 mt-1 whitespace-nowrap overflow-hidden text-ellipsis">{value}</p>
    </div>
  );
}

export default function PricingReportsPage() {
  const { baseCurrency } = useCurrency();
  const { range, setRange, customStart, setCustomStart, customEnd, setCustomEnd } = useDateRange();
  const [activeTab, setActiveTab] = useState("summary");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [plans, setPlans] = useState([]);
  const [products, setProducts] = useState([]);
  const [planTiers, setPlanTiers] = useState({});

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      if (!loading) setRefreshing(true);
      const [planRes, prodRes] = await Promise.allSettled([
        pricingApi.list({ per_page: 100 }),
        productApi.list({ per_page: 100 }),
      ]);
      const plansData = planRes.status === "fulfilled" ? extractArray(planRes.value) : [];
      setPlans(plansData);
      if (prodRes.status === "fulfilled") setProducts(extractArray(prodRes.value));

      const tierResults = await Promise.allSettled(plansData.slice(0, 30).map((p) => pricingApi.listTiers(p.id)));
      const tierMap = {};
      plansData.slice(0, 30).forEach((p, i) => {
        if (tierResults[i]?.status === "fulfilled") {
          tierMap[p.id] = extractArray(tierResults[i].value);
        }
      });
      setPlanTiers(tierMap);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message || "Failed to load data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loading]);

  useEffect(() => { fetchData(); }, []);

  const handleRefresh = () => { setRefreshing(true); fetchData(); };

  const fPlans = useMemo(() => filterByDateRange(plans, "created_at", range, customStart, customEnd), [plans, range, customStart, customEnd]);
  const fProducts = useMemo(() => filterByDateRange(products, "created_at", range, customStart, customEnd), [products, range, customStart, customEnd]);

  const activePlans = fPlans.filter((p) => p.is_active ?? p.status === "active");
  const totalTiers = Object.values(planTiers).reduce((s, t) => s + t.length, 0);
  const avgTiersPerPlan = fPlans.length ? (totalTiers / fPlans.length).toFixed(1) : 0;

  const revenueData = activePlans
    .map((p) => ({ name: p.name, revenue: parseFloat(p.unit_price ?? p.price ?? 0), fill: COLORS[activePlans.indexOf(p) % COLORS.length] }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 15);

  const productPlanData = fProducts.map((p) => ({
    name: p.name,
    count: fPlans.filter((pl) => pl.product_id === p.id || pl.product?.id === p.id).length,
    fill: COLORS[products.indexOf(p) % COLORS.length],
  })).filter((p) => p.count > 0).sort((a, b) => b.count - a.count);

  const freqData = [
    { name: "One-Time", value: fPlans.filter((p) => (p.billing_period || p.billing_frequency) === "one_time").length },
    { name: "Monthly", value: fPlans.filter((p) => (p.billing_period || p.billing_frequency) === "monthly").length },
    { name: "Quarterly", value: fPlans.filter((p) => (p.billing_period || p.billing_frequency) === "quarterly").length },
    { name: "Annual", value: fPlans.filter((p) => (p.billing_period || p.billing_frequency) === "annual").length },
  ].filter((d) => d.value > 0);

  const statusPieData = [
    { name: "Active", value: activePlans.length, fill: "#10b981" },
    { name: "Inactive", value: fPlans.filter((p) => !(p.is_active ?? p.status === "active")).length, fill: "#6b7280" },
  ].filter((d) => d.value > 0);

  const tierTypeCount = {};
  Object.values(planTiers).forEach((tiers) => {
    tiers.forEach((t) => {
      const type = t.type || "flat";
      tierTypeCount[type] = (tierTypeCount[type] || 0) + 1;
    });
  });
  const tierTypeData = Object.entries(tierTypeCount).map(([name, value], i) => ({
    name: name.charAt(0).toUpperCase() + name.slice(1),
    value,
    fill: COLORS[i % COLORS.length],
  }));

  const activeTabData = useMemo(() => {
    switch (activeTab) {
      case "revenue": return revenueData;
      case "adoption": return { frequency: freqData, status: statusPieData };
      case "utilization": return tierTypeData;
      case "product": return productPlanData;
      default: return fPlans;
    }
  }, [activeTab, revenueData, freqData, statusPieData, tierTypeData, productPlanData, fPlans]);

  const [exportLoading, setExportLoading] = useState(null);
  const handleExportJSON = async () => {
    setExportLoading("json");
    try { await downloadJSON({ report: activeTab, data: activeTabData, date_from: customStart, date_to: customEnd }, `pricing-${activeTab}-report.json`); }
    catch { /* Export failed */ } finally { setExportLoading(null); }
  };
  const handleExportCSV = async () => {
    setExportLoading("csv");
    try {
      const rows = fPlans.map((p) => [p.id, p.name, p.unit_price, p.is_active, p.billing_period]);
      await downloadCSV(rows, ["id", "name", "unit_price", "is_active", "billing_period"], `pricing-${activeTab}-report.csv`);
    }
    catch { /* Export failed */ } finally { setExportLoading(null); }
  };
  const handleExportExcel = async () => {
    setExportLoading("excel");
    try {
      const rows = fPlans.map((p) => [p.id, p.name, p.unit_price, p.is_active, p.billing_period]);
      await downloadExcel(rows, ["id", "name", "unit_price", "is_active", "billing_period"], `pricing-${activeTab}-report.xlsx`);
    }
    catch { /* Export failed */ } finally { setExportLoading(null); }
  };

  const headerProps = {
    title: "Pricing Reports",
    subtitle: "Analytics and insights for pricing plans, tiers and product coverage",
    icon: BarChart3,
    iconGradient: "from-[#FF7A00] to-[#FF5500]",
    lastUpdated,
    refreshing,
    onRefresh: handleRefresh,
    onExportCSV: handleExportCSV,
    onExportJSON: handleExportJSON,
    onExportExcel: handleExportExcel,
    dateRange: range,
    onDateRangeChange: setRange,
    customStart,
    customEnd,
    onApplyCustomRange: (start, end) => { setCustomStart(start); setCustomEnd(end); },
    onResetDateRange: () => { setCustomStart(""); setCustomEnd(""); },
  };

  if (loading) {
    return (
      <div className="space-y-8">
        <DashboardHeader {...headerProps} />
        <div className="flex flex-col items-center justify-center py-20">
          <div className="h-12 w-12 rounded-full border-4 border-slate-200 border-t-[#FF7A00] animate-spin" />
          <p className="mt-4 text-slate-500 text-sm font-medium">Loading pricing reports...</p>
        </div>
      </div>
    );
  }

  if (error && fPlans.length === 0) {
    return (
      <div className="space-y-8">
        <DashboardHeader {...headerProps} />
        <div className="flex flex-col items-center justify-center py-20">
          <div className="h-14 w-14 rounded-full bg-red-50 text-red-500 flex items-center justify-center mb-3">
            <AlertCircle size={28} />
          </div>
          <h3 className="text-lg font-bold text-slate-800 mb-1">Unable to load pricing reports</h3>
          <p className="text-slate-500 text-sm mb-6 text-center max-w-md">{error}</p>
          <button onClick={handleRefresh}
            className="px-5 py-2.5 bg-gradient-to-r from-[#FF7A00] to-[#FF5500] text-white rounded-xl text-xs font-semibold hover:shadow-md transition-all flex items-center gap-2">
            <RefreshCw size={14} /> Try Again
          </button>
        </div>
      </div>
    );
  }

  const renderTabContent = () => {
    switch (activeTab) {
      case "summary":
        return (
          <div className="space-y-6">
            <ReportSection title="Pricing Summary" icon={BarChart3}>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <StatBox label="Total Plans" value={fPlans.length} />
                <StatBox label="Active Plans" value={activePlans.length} />
                <StatBox label="Total Tiers" value={totalTiers} />
                <StatBox label="Avg Tiers/Plan" value={avgTiersPerPlan} />
              </div>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-3">Plans by Frequency</h3>
                  {freqData.length === 0 ? <DashboardEmptyPanel message="No frequency data available" icon={Tag} /> : (
                    <ResponsiveContainer width="100%" height={280}>
                      <PieChart>
                        <Pie data={freqData} cx="50%" cy="50%" outerRadius={90} paddingAngle={3} dataKey="value" label={({ name, value }) => `${name}: ${value}`}>
                          {freqData.map((entry, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-3">Tier Types</h3>
                  {tierTypeData.length === 0 ? <DashboardEmptyPanel message="No tier data available" icon={Layers} /> : (
                    <ResponsiveContainer width="100%" height={280}>
                      <PieChart>
                        <Pie data={tierTypeData} cx="50%" cy="50%" innerRadius={50} outerRadius={90} paddingAngle={3} dataKey="value" label={({ name, value }) => `${name}: ${value}`}>
                          {tierTypeData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>
            </ReportSection>

            <ReportSection title="Pricing Plans Overview" icon={Tag}>
              <div className="overflow-x-auto -mx-2 px-2">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100">
                      <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Name</th>
                      <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                      <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Price</th>
                      <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Frequency</th>
                      <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Product</th>
                      <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Tiers</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {fPlans.length === 0 ? (
                      <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-500">No plans found</td></tr>
                    ) : fPlans.slice(0, 20).map((p) => (
                      <tr key={p.id} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-medium text-slate-800">{p.name}</td>
                        <td className="px-4 py-3">{(() => { const active = p.is_active ?? p.status === "active"; return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{active ? "active" : "inactive"}</span>; })()}</td>
                        <td className="px-4 py-3 text-right font-medium whitespace-nowrap">{formatDisplayCurrency(p.unit_price ?? p.price, p.currency || baseCurrency)}</td>
                        <td className="px-4 py-3 text-slate-600 capitalize">{(p.billing_period || p.billing_frequency)?.replace(/_/g, " ") || "—"}</td>
                        <td className="px-4 py-3 text-slate-600">{p.product_name || p.product?.name || "—"}</td>
                        <td className="px-4 py-3 text-right text-slate-600">{(planTiers[p.id] || []).length}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ReportSection>
          </div>
        );

      case "revenue":
        return (
          <ReportSection title="Revenue by Plan (Active Plans Price)" icon={DollarSign}>
            {revenueData.length === 0 ? (
              <DashboardEmptyPanel title="No active plans with pricing" message="Active pricing plans with a set price will appear here." icon={DollarSign} />
            ) : (
              <ResponsiveContainer width="100%" height={420}>
                <BarChart data={revenueData} layout="vertical" margin={{ top: 10, right: 40, left: 100, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => formatDisplayCurrency(v, baseCurrency)} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={90} tickFormatter={(val) => (val && val.length > 16 ? `${val.substring(0, 14)}...` : val)} />
                  <Tooltip formatter={(v) => formatDisplayCurrency(v, baseCurrency)} />
                  <Bar dataKey="revenue" radius={[0, 4, 4, 0]}>
                    {revenueData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </ReportSection>
        );

      case "adoption":
        return (
          <ReportSection title="Plan Adoption" icon={TrendingUp}>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div>
                <h3 className="text-sm font-semibold text-slate-700 mb-3">Plans by Frequency</h3>
                {freqData.length === 0 ? <DashboardEmptyPanel message="No frequency data available" icon={Tag} /> : (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={freqData} cx="50%" cy="50%" outerRadius={100} paddingAngle={3} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                        {freqData.map((entry, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip />
                      <Legend formatter={(value) => <span className="text-xs text-slate-600 font-medium">{value}</span>} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
              <div>
                <h3 className="text-sm font-semibold text-slate-700 mb-3">Plans by Status</h3>
                {statusPieData.length === 0 ? <DashboardEmptyPanel message="No status data available" icon={Tag} /> : (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={statusPieData} cx="50%" cy="50%" outerRadius={100} paddingAngle={3} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                        {statusPieData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                      </Pie>
                      <Tooltip />
                      <Legend formatter={(value) => <span className="text-xs text-slate-600 font-medium">{value}</span>} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </ReportSection>
        );

      case "utilization":
        return (
          <ReportSection title="Tier Types Distribution" icon={Layers}>
            {tierTypeData.length === 0 ? (
              <DashboardEmptyPanel title="No tier data" message="Tier type usage across pricing plans will appear here." icon={Layers} />
            ) : (
              <ResponsiveContainer width="100%" height={350}>
                <BarChart data={tierTypeData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                    {tierTypeData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </ReportSection>
        );

      case "product":
        return (
          <ReportSection title="Plans per Product" icon={Package}>
            {productPlanData.length === 0 ? (
              <DashboardEmptyPanel title="No product-plan associations" message="Pricing plans linked to products will appear here." icon={Package} />
            ) : (
              <ResponsiveContainer width="100%" height={350}>
                <BarChart data={productPlanData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={60} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {productPlanData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </ReportSection>
        );

      default:
        return null;
    }
  };

  return (
    <div className="space-y-8">
      <DashboardHeader {...headerProps} />

      <div className="flex flex-wrap items-center gap-2 bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
        {TABS.map((tab) => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A00]/50 ${
              activeTab === tab.key ? "bg-gradient-to-r from-[#FF7A00] to-[#FF5500] text-white shadow-sm" : "bg-slate-50 text-slate-600 hover:bg-slate-100"
            }`}
            aria-pressed={activeTab === tab.key}>
            <tab.icon size={15} />
            {tab.label}
          </button>
        ))}
      </div>

      {renderTabContent()}
    </div>
  );
}
