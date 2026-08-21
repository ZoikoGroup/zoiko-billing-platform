import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Receipt, DollarSign, Landmark, FileText, Globe, CheckCircle, TrendingUp, AlertTriangle, Settings,
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { taxApi } from "../../../service/billingService";
import { extractArray, formatDisplayCurrency } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { useBillingDateRange } from "../utils/DateRangeContext";
import {
  DashboardHeader, DashboardStatCard, DashboardStatCardSkeleton, DashboardChartCard,
  DashboardChartCardSkeleton, DashboardChartErrorBoundary, DashboardEmptyPanel,
  DASHBOARD_KPI_GRID, DASHBOARD_CHART_GRID,
  exportDashboardToCsv, exportDashboardToJson,
  BusinessInsights, QuickActions, ActionCenter,
} from "../../../components/billing-shared";
import { Button, DataTable, StatGroup } from "../../../components/billing-ui";

// Tax.tax_type is an enum on the backend (see TaxType in models.py); these are
// the only values getSummary()'s breakdown_by_type can key on.
const TAX_TYPE_META = {
  sales_tax: { label: "Sales Tax", color: "#FF7A00" },
  vat: { label: "VAT", color: "#FF9B4D" },
  gst: { label: "GST", color: "#f59e0b" },
  service_tax: { label: "Service Tax", color: "#10b981" },
  withholding: { label: "Withholding", color: "#ef4444" },
  customs: { label: "Customs", color: "#3b82f6" },
};

const CHART_COLORS = ["#FF7A00", "#FF9B4D", "#FFC9A6", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4899", "#14b8a6", "#f97316"];

function buildTrailingMonths(count) {
  const now = new Date();
  const toIso = (d) => d.toISOString().slice(0, 10);
  return Array.from({ length: count }, (_, i) => {
    const anchor = new Date(now.getFullYear(), now.getMonth() - (count - 1 - i), 1);
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return {
      label: anchor.toLocaleString("en-US", { month: "short", year: "2-digit" }),
      date_from: toIso(start),
      date_to: toIso(end),
    };
  });
}

export default function TaxDashboardPage() {
  const navigate = useNavigate();
  const { baseCurrency, currencySymbol } = useCurrency();
  const {
    range: dateRangeValue, setRange: setDateRangeValue,
    customStart, customEnd, applyCustomRange, reset: resetDateRange,
    dateRange,
  } = useBillingDateRange();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [summary, setSummary] = useState(null);
  const [errorSummary, setErrorSummary] = useState(null);

  const [taxRates, setTaxRates] = useState([]);
  const [errorRates, setErrorRates] = useState(null);

  const [monthlyTax, setMonthlyTax] = useState([]);
  const [errorMonthly, setErrorMonthly] = useState(null);

  const hasLoadedOnce = useRef(false);

  const fetchDashboardData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true); else setLoading(true);

      // getSummary() has no dedicated trend endpoint, so the monthly series
      // is built by calling it once per trailing month window — every point
      // is still a real, server-computed total (not client-side estimation).
      const months = buildTrailingMonths(6);

      const [summaryRes, ratesRes, ...monthlyRes] = await Promise.allSettled([
        taxApi.getSummary(dateRange.date_from, dateRange.date_to),
        taxApi.list({ per_page: 100 }),
        ...months.map((m) => taxApi.getSummary(m.date_from, m.date_to)),
      ]);

      if (summaryRes.status === "fulfilled") { setSummary(summaryRes.value); setErrorSummary(null); }
      else { setErrorSummary(summaryRes.reason?.message || "Failed to load tax summary"); }

      if (ratesRes.status === "fulfilled") { setTaxRates(extractArray(ratesRes.value)); setErrorRates(null); }
      else { setErrorRates(ratesRes.reason?.message || "Failed to load tax rates"); setTaxRates([]); }

      if (monthlyRes.some((r) => r.status === "fulfilled")) {
        setMonthlyTax(months.map((m, i) => ({
          month: m.label,
          tax: monthlyRes[i].status === "fulfilled" ? Number(monthlyRes[i].value?.total_tax || 0) : 0,
        })));
        setErrorMonthly(null);
      } else {
        setMonthlyTax([]);
        setErrorMonthly("Failed to load monthly tax trend");
      }

      setLastUpdated(new Date());
    } finally {
      setLoading(false);
      setRefreshing(false);
      hasLoadedOnce.current = true;
    }
  }, [dateRange.date_from, dateRange.date_to]);

  useEffect(() => {
    fetchDashboardData(hasLoadedOnce.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRange.date_from, dateRange.date_to]);

  const totalTax = Number(summary?.total_tax || 0);
  const totalRecords = Number(summary?.total_records || 0);
  const breakdown = summary?.breakdown_by_type || {};
  const gstAmount = Number(breakdown.gst || 0);
  const vatAmount = Number(breakdown.vat || 0);

  const activeRates = useMemo(() => taxRates.filter((r) => r.is_active !== false), [taxRates]);

  const jurisdictionCounts = useMemo(() => {
    return taxRates.reduce((acc, r) => {
      const key = r.jurisdiction || "Unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  }, [taxRates]);

  const countryChartData = useMemo(() =>
    Object.entries(jurisdictionCounts)
      .map(([name, value], i) => ({ name, value, color: CHART_COLORS[i % CHART_COLORS.length] }))
      .sort((a, b) => b.value - a.value),
    [jurisdictionCounts]
  );

  const breakdownChartData = useMemo(() =>
    Object.entries(breakdown)
      .map(([type, amount]) => ({
        type,
        name: TAX_TYPE_META[type]?.label || type,
        value: Number(amount) || 0,
        color: TAX_TYPE_META[type]?.color || "#94a3b8",
      }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value),
    [breakdown]
  );

  const insightItems = useMemo(() => {
    const items = [];
    if (totalTax > 0) {
      items.push({ tone: "up", icon: TrendingUp, text: `${formatDisplayCurrency(totalTax, baseCurrency)} tax collected this period` });
    }
    const inactiveCount = taxRates.length - activeRates.length;
    if (inactiveCount > 0) {
      items.push({ tone: "warning", icon: AlertTriangle, text: `${inactiveCount} inactive tax rate${inactiveCount === 1 ? "" : "s"} configured` });
    }
    const jurisdictionCount = Object.keys(jurisdictionCounts).length;
    if (jurisdictionCount > 0) {
      items.push({ tone: "neutral", icon: Globe, text: `${jurisdictionCount} jurisdiction${jurisdictionCount === 1 ? "" : "s"} covered by configured tax rates` });
    }
    if (!items.length) {
      items.push({ tone: "neutral", icon: CheckCircle, text: "No tax activity recorded for this period" });
    }
    return items;
  }, [totalTax, baseCurrency, taxRates.length, activeRates.length, jurisdictionCounts]);

  const taxQuickActions = useMemo(() => [
    { label: "Tax Rates", hint: "View and manage configured rates", href: "/billing/tax", icon: Receipt },
    { label: "Configuration", hint: "Jurisdictions, rules & exemptions", href: "/billing/tax/configuration", icon: Globe },
    { label: "Reports", hint: "Detailed tax reports", href: "/billing/tax/reports", icon: FileText },
    { label: "Settings", hint: "Tax calculation preferences", href: "/billing/tax/settings", icon: Settings },
  ], []);

  // Action Center — built only from tax data already fetched (rates + summary).
  const taxActionItems = useMemo(() => {
    const items = [];
    const inactiveCount = taxRates.length - activeRates.length;
    if (taxRates.length === 0) {
      items.push({
        icon: Globe, tone: "neutral", priority: "high",
        title: "No tax rates configured",
        description: "Add jurisdictions and rates to start collecting tax",
        href: "/billing/tax/configuration",
      });
    } else if (inactiveCount > 0) {
      items.push({
        icon: AlertTriangle, tone: "warning", priority: "medium",
        title: `${inactiveCount} inactive tax rate${inactiveCount === 1 ? "" : "s"} configured`,
        description: "Not applied to new transactions",
        href: "/billing/tax",
      });
    }
    if (totalRecords === 0) {
      items.push({
        icon: FileText, tone: "neutral", priority: "low",
        title: "No tax records this period",
        description: "Tax will be collected once invoices are raised",
        href: "/billing/tax/reports",
      });
    }
    return items;
  }, [taxRates.length, activeRates.length, totalRecords]);

  const taxSummaryColumns = useMemo(() => [
    { key: "type", label: "Tax Type", render: (row) => (
      <span className="inline-flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: row.color }} />
        {row.name}
      </span>
    ) },
    { key: "value", label: "Amount", align: "right", render: (row) => <span className="font-medium text-slate-800">{formatDisplayCurrency(row.value, baseCurrency)}</span> },
    { key: "percent", label: "% of Total", align: "right", render: (row) => <span className="text-slate-500">{totalTax > 0 ? `${((row.value / totalTax) * 100).toFixed(1)}%` : "—"}</span> },
  ], [baseCurrency, totalTax]);

  const handleExport = useCallback((format) => {
    const payload = {
      summary,
      tax_rates: taxRates,
      monthly_trend: monthlyTax,
      date_from: dateRange.date_from,
      date_to: dateRange.date_to,
    };
    const prefix = `tax-dashboard-${new Date().toISOString().split("T")[0]}`;
    if (format === "csv") exportDashboardToCsv(payload, prefix);
    else exportDashboardToJson(payload, prefix);
  }, [summary, taxRates, monthlyTax, dateRange]);

  const headerProps = {
    title: "Tax Dashboard",
    subtitle: "Tax collection, GST / VAT breakdown, and jurisdiction analytics",
    icon: Receipt,
    iconGradient: "from-amber-500 to-orange-600",
    crumbs: [{ label: "Billing", href: "/billing" }, { label: "Tax" }],
    primaryAction: <Button variant="primary" icon={Settings} onClick={() => navigate("/billing/tax/configuration")}>Configure Tax</Button>,
    lastUpdated,
    onRefresh: () => fetchDashboardData(true),
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

  if (loading && !summary && taxRates.length === 0) {
    return (
      <div className="space-y-8" aria-label="Loading tax dashboard">
        <DashboardHeader {...headerProps} />
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 4 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)}
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          {Array.from({ length: 3 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)}
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
    <div className="space-y-8">
      <DashboardHeader {...headerProps} />

      <BusinessInsights items={insightItems} />

      <ActionCenter items={taxActionItems} />

      {(errorSummary || errorRates || errorMonthly) && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <span className="flex-1">{errorSummary || errorRates || errorMonthly}</span>
          <button onClick={() => fetchDashboardData(true)} className="inline-flex items-center gap-1 px-3 py-1 text-xs font-medium text-red-700 bg-red-100 rounded-lg hover:bg-red-200 shrink-0">
            Retry
          </button>
        </div>
      )}

      <div className={DASHBOARD_KPI_GRID}>
        <DashboardStatCard
          title="Tax Collected"
          value={formatDisplayCurrency(totalTax, baseCurrency)}
          subtitle={`${totalRecords} tax record(s) in range`}
          icon={DollarSign}
          color="from-brand to-brand-hover"
          sparkline={monthlyTax.map((m) => m.tax)}
        />
        <DashboardStatCard
          title="GST Collected"
          value={formatDisplayCurrency(gstAmount, baseCurrency)}
          subtitle={breakdown.gst != null ? "From GST-type tax records" : "No GST records in range"}
          icon={Landmark}
          color="from-amber-500 to-orange-500"
        />
        <DashboardStatCard
          title="VAT Collected"
          value={formatDisplayCurrency(vatAmount, baseCurrency)}
          subtitle={breakdown.vat != null ? "From VAT-type tax records" : "No VAT records in range"}
          icon={Landmark}
          color="from-blue-500 to-cyan-500"
        />
        <DashboardStatCard
          title="Tax Records"
          value={totalRecords}
          subtitle="Applied tax entries in range"
          icon={FileText}
          color="from-emerald-500 to-green-500"
          href="/billing/tax/reports"
        />
      </div>

      <StatGroup title="More Metrics">
        <DashboardStatCard
          title="Configured Tax Rates"
          value={taxRates.length}
          subtitle={`${activeRates.length} active`}
          icon={Receipt}
          color="from-indigo-500 to-blue-500"
          href="/billing/tax"
        />
        <DashboardStatCard
          title="Active Tax Rates"
          value={activeRates.length}
          subtitle="Currently applicable"
          icon={CheckCircle}
          color="from-teal-500 to-green-500"
          href="/billing/tax"
        />
        <DashboardStatCard
          title="Countries Covered"
          value={Object.keys(jurisdictionCounts).length}
          subtitle="Distinct jurisdictions configured"
          icon={Globe}
          color="from-pink-500 to-rose-500"
        />
      </StatGroup>

      <QuickActions actions={taxQuickActions} />

      <div className={DASHBOARD_CHART_GRID}>
        <DashboardChartCard title="Monthly Tax Collected (6 months)">
          <DashboardChartErrorBoundary>
            {monthlyTax.every((m) => m.tax === 0) ? (
              <DashboardEmptyPanel title={errorMonthly || "No monthly tax data"} message="Monthly tax collected will appear here once tax records exist." icon={TrendingUp} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={monthlyTax}>
                  <defs>
                    <linearGradient id="taxTrendGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 12 }} />
                  <Tooltip formatter={(v) => formatDisplayCurrency(v, baseCurrency)} />
                  <Area type="monotone" dataKey="tax" name="Tax Collected" stroke="#f59e0b" strokeWidth={3} fill="url(#taxTrendGrad)" dot={{ fill: "#f59e0b", strokeWidth: 2, r: 4 }} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title="Country Distribution" action={<span className="text-[11px] text-slate-500 font-medium">By configured jurisdiction</span>}>
          <DashboardChartErrorBoundary>
            {countryChartData.length === 0 ? (
              <DashboardEmptyPanel title={errorRates || "No jurisdiction data"} message="Countries will appear here once tax rates with a jurisdiction are configured." icon={Globe} ctaText="Configure Tax" onCtaClick={() => navigate("/billing/tax/configuration")} steps={[
                { label: "Tax Rates", icon: Landmark, onClick: () => navigate("/billing/tax") },
                { label: "Settings", icon: Settings, onClick: () => navigate("/billing/tax/settings") },
              ]} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={countryChartData} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={90} />
                  <Tooltip formatter={(v) => [`${v} rate(s)`, "Configured"]} />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {countryChartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>
      </div>

      <div className={DASHBOARD_CHART_GRID}>
        <DashboardChartCard title="Tax Type Breakdown">
          <DashboardChartErrorBoundary>
            {breakdownChartData.length === 0 ? (
              <DashboardEmptyPanel title={errorSummary || "No tax breakdown data"} message="Tax collected will be broken out by type here." icon={Receipt} />
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={breakdownChartData} cx="50%" cy="45%" innerRadius={55} outerRadius={85} paddingAngle={4} dataKey="value"
                    label={({ percent }) => (percent >= 0.05 ? `${(percent * 100).toFixed(0)}%` : "")}>
                    {breakdownChartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip formatter={(v, name) => [formatDisplayCurrency(v, baseCurrency), name]} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </DashboardChartErrorBoundary>
        </DashboardChartCard>

        <DashboardChartCard title="Tax Summary">
          <DashboardChartErrorBoundary>
            <DataTable
              columns={taxSummaryColumns}
              data={breakdownChartData}
              rowKey={(row) => row.type}
              stickyHeader={false}
              emptyTitle={errorSummary || "No tax summary data"}
              emptyMessage="A breakdown of tax collected by type will appear here."
              emptyIcon={FileText}
            />
          </DashboardChartErrorBoundary>
        </DashboardChartCard>
      </div>
    </div>
  );
}
