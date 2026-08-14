import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  FileSignature, CheckCircle, XCircle, RotateCcw, Clock, DollarSign,
  TrendingUp, Percent, ChevronRight, PieChart as PieChartIcon,
  PlusCircle, List, Landmark, BarChart3, AlertCircle, RefreshCw,
} from "lucide-react";
import {
  PieChart, Pie, Cell, BarChart, Bar, AreaChart, Area, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { contractApi } from "../../../service/billingService";
import { extractArray, formatDisplayCurrency, formatCompactCurrency } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { useTerminology } from "../utils/TerminologyContext";
import { useBillingDateRange } from "../utils/DateRangeContext";
import {
  DashboardHeader, DashboardStatCard, DashboardStatCardSkeleton, DashboardChartCard,
  DashboardChartCardSkeleton, DashboardChartErrorBoundary, DashboardEmptyPanel,
  DASHBOARD_KPI_GRID, DASHBOARD_CHART_GRID, DASHBOARD_CHART_GRID_3,
  exportDashboardToCsv, exportDashboardToJson, ErrorState,
  BusinessInsights, QuickActions, ActionCenter,
} from "../../../components/billing-shared";
import { Button, DataTable, StatGroup } from "../../../components/billing-ui";

const STATUS_COLORS = {
  active: "#10b981",
  pending: "#3b82f6",
  draft: "#6b7280",
  expired: "#f59e0b",
  terminated: "#ef4444",
  cancelled: "#94a3b8",
};

const BILLING_PERIOD_COLORS = ["#FF7A00", "#FF9B4D", "#FFC9A6", "#f59e0b", "#10b981"];

// Converts a contract's face value to a monthly-equivalent figure so contracts on
// different billing cadences can be summed into one MRR/ARR-style figure. This is
// the exact normalization contract-list.jsx already uses for its own MRR/ARR cards,
// kept identical here so the two pages never disagree on the same underlying math.
function monthlyEquivalent(value, billingPeriod) {
  const val = parseFloat(value || 0);
  if (billingPeriod === "monthly") return val;
  if (billingPeriod === "quarterly") return val / 3;
  if (billingPeriod === "semi_annual") return val / 6;
  if (billingPeriod === "annual") return val / 12;
  return val / 12;
}

export default function ContractDashboardPage() {
  const navigate = useNavigate();
  const { baseCurrency, currencySymbol } = useCurrency();
  const { singular } = useTerminology();
  const {
    range: dateRangeValue, setRange: setDateRangeValue,
    customStart, customEnd, applyCustomRange, reset: resetDateRange,
    dateRange,
  } = useBillingDateRange();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const mountedRef = useRef(true);
  const loadingRef = useRef(true);

  // There is no dedicated /contracts/dashboard-stats endpoint yet, so this page
  // fetches a broad recent sample plus the two ready-made lifecycle endpoints
  // (active / expiring-soon) and derives everything else client-side.
  const [contracts, setContracts] = useState([]);
  const [contractsTotal, setContractsTotal] = useState(0);
  const [activeContracts, setActiveContracts] = useState([]);
  const [expiringContracts, setExpiringContracts] = useState([]);

  const fetchDashboardData = useCallback(async () => {
    try {
      setError(null);
      if (!loadingRef.current) setRefreshing(true);

      const results = await Promise.allSettled([
        contractApi.list({
          per_page: 100, sort_by: "created_at", sort_order: "desc",
          date_from: dateRange.date_from || undefined, date_to: dateRange.date_to || undefined,
        }),
        contractApi.listActive(),
        contractApi.listExpiring(30),
      ]);
      const [listResult, activeResult, expiringResult] = results;

      if (!mountedRef.current) return;

      if (listResult.status === "fulfilled") {
        const items = extractArray(listResult.value);
        setContracts(items);
        setContractsTotal(Number(listResult.value?.total ?? items.length));
      } else {
        setContracts([]); setContractsTotal(0);
      }
      setActiveContracts(activeResult.status === "fulfilled" ? extractArray(activeResult.value) : []);
      setExpiringContracts(expiringResult.status === "fulfilled" ? extractArray(expiringResult.value) : []);

      if (listResult.status === "rejected" && activeResult.status === "rejected" && expiringResult.status === "rejected") {
        setError("Failed to load contract dashboard data. Please try again.");
      }
      setLastUpdated(new Date());
    } catch (err) {
      if (mountedRef.current) setError(err?.message || "Failed to load contract dashboard data.");
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
        loadingRef.current = false;
      }
    }
  }, [dateRange.date_from, dateRange.date_to]);

  useEffect(() => {
    mountedRef.current = true;
    loadingRef.current = true;
    fetchDashboardData();
    return () => { mountedRef.current = false; };
  }, [fetchDashboardData]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchDashboardData();
  }, [fetchDashboardData]);

  const contractValue = (c) => parseFloat(c.total_value ?? c.value ?? 0);

  const kpis = useMemo(() => {
    const expiredCount = contracts.filter((c) => c.status === "expired").length;
    const activeCount = activeContracts.length;
    const renewals = activeContracts.filter((c) => c.auto_renew).length;
    const totalValue = contracts.reduce((s, c) => s + contractValue(c), 0);
    const mrr = activeContracts.reduce((s, c) => s + monthlyEquivalent(contractValue(c), c.billing_period), 0);
    const arr = mrr * 12;
    // Retention reads as: of the contracts that have actually reached a
    // resolution (stayed active vs. lapsed to expired), what share retained —
    // drafts/pending/terminated/cancelled are excluded because they haven't
    // reached (or didn't reach) natural term-end, so they'd distort the rate.
    const retentionDenominator = activeCount + expiredCount;
    const retentionRate = retentionDenominator > 0 ? (activeCount / retentionDenominator) * 100 : null;
    return { expiredCount, activeCount, renewals, totalValue, mrr, arr, retentionRate };
  }, [contracts, activeContracts]);

  const sampleCurrency = contracts.find((c) => c.currency)?.currency
    || activeContracts.find((c) => c.currency)?.currency
    || baseCurrency;

  const isSampled = contractsTotal > contracts.length;

  const monthlyTrend = useMemo(() => {
    const acc = {};
    contracts.forEach((c) => {
      const dateStr = c.start_date || c.created_at;
      if (!dateStr) return;
      const date = new Date(dateStr);
      if (Number.isNaN(date.getTime())) return;
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      if (!acc[key]) {
        acc[key] = { month: date.toLocaleString("en-US", { month: "short", year: "numeric" }), key, count: 0, value: 0 };
      }
      acc[key].count += 1;
      acc[key].value += contractValue(c);
    });
    return Object.values(acc).sort((a, b) => a.key.localeCompare(b.key)).slice(-12);
  }, [contracts]);

  const statusData = useMemo(() => {
    const counts = {};
    contracts.forEach((c) => {
      const s = c.status || "unknown";
      counts[s] = (counts[s] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value, color: STATUS_COLORS[name] || "#FF7A00" }))
      .filter((d) => d.value > 0);
  }, [contracts]);

  const valueByStatus = useMemo(() => {
    const groups = {};
    contracts.forEach((c) => {
      const s = c.status || "unknown";
      groups[s] = (groups[s] || 0) + contractValue(c);
    });
    return Object.entries(groups)
      .map(([name, value]) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value, color: STATUS_COLORS[name] || "#FF7A00" }))
      .filter((d) => d.value > 0);
  }, [contracts]);

  const billingPeriodData = useMemo(() => {
    const counts = {};
    contracts.forEach((c) => {
      const p = c.billing_period || "unspecified";
      counts[p] = (counts[p] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([name, value]) => ({ name: name.replace(/_/g, " "), value }))
      .filter((d) => d.value > 0);
  }, [contracts]);

  const insightItems = useMemo(() => {
    const items = [];
    if (expiringContracts.length > 0) {
      items.push({ tone: "warning", icon: Clock, text: `${expiringContracts.length} contract${expiringContracts.length === 1 ? "" : "s"} expire soon` });
    }
    if (kpis.retentionRate != null) {
      items.push({ tone: kpis.retentionRate >= 80 ? "up" : "neutral", icon: Percent, text: `${kpis.retentionRate.toFixed(1)}% retention rate` });
    }
    if (kpis.renewals > 0) {
      items.push({ tone: "neutral", icon: RotateCcw, text: `${kpis.renewals} active contract${kpis.renewals === 1 ? "" : "s"} set to auto-renew` });
    }
    if (!items.length) {
      items.push({ tone: "up", icon: CheckCircle, text: "No contracts need attention right now" });
    }
    return items;
  }, [expiringContracts.length, kpis.retentionRate, kpis.renewals]);

  const contractQuickActions = useMemo(() => [
    { label: "New Contract", hint: "Draft a contract for a customer", href: "/billing/contracts/create", icon: PlusCircle },
    { label: "All Contracts", hint: "Browse, renew, and manage contracts", href: "/billing/contracts", icon: List },
    { label: "Retainers", hint: "Manage retainer-based contracts", href: "/billing/retainers", icon: Landmark },
    { label: "Reports", hint: "Lifecycle and value reporting", href: "/billing/contracts/reports", icon: BarChart3 },
  ], []);

  // Action Center — built only from the lifecycle data already fetched
  // (expiring contracts, expired count, auto-renewing actives).
  const contractActionItems = useMemo(() => {
    const items = [];
    if (expiringContracts.length > 0) {
      items.push({
        icon: Clock, tone: "warning", priority: "high",
        title: `${expiringContracts.length} contract${expiringContracts.length === 1 ? "" : "s"} expiring within 30 days`,
        description: "Renews or lapses — review before term end",
        href: "/billing/contracts",
      });
    }
    if (kpis.expiredCount > 0) {
      items.push({
        icon: XCircle, tone: "danger", priority: "medium",
        title: `${kpis.expiredCount} contract${kpis.expiredCount === 1 ? "" : "s"} expired`,
        description: "Reached term end without renewal",
        href: "/billing/contracts?status=expired",
      });
    }
    if (kpis.renewals > 0) {
      items.push({
        icon: RotateCcw, tone: "neutral", priority: "low",
        title: `${kpis.renewals} active contract${kpis.renewals === 1 ? "" : "s"} set to auto-renew`,
        description: "Renewals handled automatically",
        href: "/billing/contracts?status=active",
      });
    }
    return items;
  }, [expiringContracts.length, kpis.expiredCount, kpis.renewals]);

  const expiringColumns = useMemo(() => [
    { key: "customer", label: singular, render: (c) => (
      <button onClick={(e) => { e.stopPropagation(); navigate(`/billing/contracts/${c.id}`); }}
        className="font-medium text-slate-700 hover:text-brand-600 transition-colors text-left focus:outline-none focus-visible:underline">
        {c.customer_name || c.customer?.name || `${singular} #${c.customer_id}`}
      </button>
    ) },
    { key: "end_date", label: "Expires", render: (c) => <span className="text-slate-500 whitespace-nowrap text-xs">{c.end_date ? new Date(c.end_date).toLocaleDateString() : "—"}</span> },
    { key: "value", label: "Value", align: "right", render: (c) => <span className="font-medium text-slate-800 whitespace-nowrap">{formatDisplayCurrency(contractValue(c), c.currency || sampleCurrency)}</span> },
  ], [navigate, singular, sampleCurrency]);

  const handleExport = useCallback((format) => {
    const prefix = `contracts-dashboard-${new Date().toISOString().split("T")[0]}`;
    const payload = {
      kpis: { ...kpis, total_contracts: contractsTotal, upcoming_expiry_30d: expiringContracts.length },
      contracts_sample: contracts,
      active_contracts: activeContracts,
      expiring_contracts: expiringContracts,
      date_from: dateRange.date_from,
      date_to: dateRange.date_to,
    };
    if (format === "csv") exportDashboardToCsv(payload, prefix);
    else exportDashboardToJson(payload, prefix);
  }, [kpis, contractsTotal, contracts, activeContracts, expiringContracts, dateRange]);

  const headerProps = {
    title: "Contracts Dashboard",
    subtitle: "Contract lifecycle, renewals, and value analytics",
    icon: FileSignature,
    crumbs: [{ label: "Billing", href: "/billing" }, { label: "Contracts" }],
    lastUpdated,
    onRefresh: handleRefresh,
    refreshing,
    onExportCSV: () => handleExport("csv"),
    onExportJSON: () => handleExport("json"),
    dateRange: dateRangeValue,
    onDateRangeChange: setDateRangeValue,
    customStart,
    customEnd,
    onApplyCustomRange: applyCustomRange,
    onResetDateRange: resetDateRange,
    primaryAction: <Button variant="primary" icon={PlusCircle} onClick={() => navigate("/billing/contracts/create")}>New Contract</Button>,
  };

  if (loading) {
    return (
      <div className="space-y-8 px-4 py-6 sm:px-6" aria-label="Loading contracts dashboard">
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
        <div className={DASHBOARD_CHART_GRID_3}>
          <DashboardChartCardSkeleton />
          <DashboardChartCardSkeleton />
          <DashboardChartCardSkeleton />
        </div>
      </div>
    );
  }

  if (error && contracts.length === 0 && activeContracts.length === 0 && expiringContracts.length === 0) {
    return (
      <div className="space-y-8 px-4 py-6 sm:px-6">
        <DashboardHeader {...headerProps} />
        <ErrorState message={error} onRetry={handleRefresh} title="Something went wrong" />
      </div>
    );
  }

  const hasAnyData = contractsTotal > 0 || activeContracts.length > 0 || expiringContracts.length > 0;

  return (
    <div className="space-y-8 px-4 py-6 sm:px-6">
      <DashboardHeader {...headerProps} />

      {hasAnyData && <BusinessInsights items={insightItems} />}

      {hasAnyData && <ActionCenter items={contractActionItems} />}

      {error && (
        <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <XCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {!hasAnyData ? (
        <DashboardEmptyPanel
          title="No contracts yet"
          message="Create your first contract to start tracking renewals, retention, and recurring value here."
          icon={FileSignature}
          ctaText="Create Contract"
          onCtaClick={() => navigate("/billing/contracts/create")}
          steps={[
            { label: "Pricing Plans", icon: List, onClick: () => navigate("/billing/pricing") },
            { label: "Products", icon: BarChart3, onClick: () => navigate("/billing/products") },
          ]}
        />
      ) : (
        <>
          <div className={DASHBOARD_KPI_GRID}>
            <DashboardStatCard title="Total Contracts" value={contractsTotal.toLocaleString()} icon={FileSignature} color="from-brand to-brand-hover" href="/billing/contracts" />
            <DashboardStatCard title="Active" value={kpis.activeCount.toLocaleString()} subtitle={contractsTotal ? `${Math.round((kpis.activeCount / contractsTotal) * 100)}% of total` : undefined} icon={CheckCircle} color="from-emerald-500 to-emerald-600" href="/billing/contracts?status=active" />
            <DashboardStatCard title="Expired" value={kpis.expiredCount.toLocaleString()} subtitle={isSampled ? "In most recent sample" : undefined} icon={XCircle} color="from-gray-500 to-slate-600" href="/billing/contracts?status=expired" />
            <DashboardStatCard title="Upcoming Expiry (30d)" value={expiringContracts.length.toLocaleString()} subtitle="Renewal window" icon={Clock} color="from-amber-500 to-orange-500" />
          </div>

          <StatGroup title="More Metrics">
            <DashboardStatCard title="Renewals" value={kpis.renewals.toLocaleString()} subtitle="Active with auto-renew enabled" icon={RotateCcw} color="from-blue-500 to-cyan-500" />
            <DashboardStatCard title="Contract Value" value={Number(kpis.totalValue)} currency={sampleCurrency} subtitle={isSampled ? `Sum of ${contracts.length.toLocaleString()} most recent` : "Sum of all contracts"} icon={DollarSign} color="from-brand to-brand-hover" sparkline={monthlyTrend.map((m) => m.value)} />
            <DashboardStatCard title="Revenue (ARR)" value={Number(kpis.arr)} currency={sampleCurrency} subtitle="Annualized, from active contracts" icon={TrendingUp} color="from-indigo-500 to-blue-500" href="/billing/contracts/reports" />
            <DashboardStatCard title="Retention Rate" value={kpis.retentionRate == null ? "—" : `${kpis.retentionRate.toFixed(1)}%`} subtitle="Active vs. Active + Expired" icon={Percent} color="from-teal-500 to-green-500" />
          </StatGroup>

          <QuickActions actions={contractQuickActions} />

          <div className={DASHBOARD_CHART_GRID}>
            <DashboardChartCard title="Monthly Trend">
              <DashboardChartErrorBoundary>
                {monthlyTrend.length === 0 ? (
                  <DashboardEmptyPanel title="No trend data" message="Contract value and count over time will appear here." icon={TrendingUp} />
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={monthlyTrend}>
                      <defs>
                        <linearGradient id="contractTrendGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#FF7A00" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#FF7A00" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={(v) => `${currencySymbol}${(v / 1000).toFixed(0)}k`} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip formatter={(v, name) => (name === "Value" ? formatDisplayCurrency(v, sampleCurrency) : v)} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area yAxisId="left" type="monotone" dataKey="value" name="Value" stroke="#FF7A00" strokeWidth={2} fill="url(#contractTrendGrad)" />
                      <Line yAxisId="right" type="monotone" dataKey="count" name="Count" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </DashboardChartErrorBoundary>
            </DashboardChartCard>

            <DashboardChartCard title="Status Distribution">
              <DashboardChartErrorBoundary>
                {statusData.length === 0 ? (
                  <DashboardEmptyPanel title="No status data" message="Contract status breakdown will appear here." icon={PieChartIcon} />
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <PieChart>
                      <Pie data={statusData} cx="50%" cy="50%" innerRadius={55} outerRadius={90} paddingAngle={3} dataKey="value"
                        label={({ percent }) => (percent >= 0.05 ? `${(percent * 100).toFixed(0)}%` : "")}>
                        {statusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                      </Pie>
                      <Tooltip formatter={(v, name) => [v, name]} />
                      <Legend verticalAlign="bottom" height={36} formatter={(value) => <span className="text-xs text-slate-600 font-medium">{value}</span>} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </DashboardChartErrorBoundary>
            </DashboardChartCard>
          </div>

          <div className={DASHBOARD_CHART_GRID_3}>
            <DashboardChartCard title="Value by Status">
              <DashboardChartErrorBoundary>
                {valueByStatus.length === 0 ? (
                  <DashboardEmptyPanel title="No value data" message="Contract value grouped by status will appear here." icon={DollarSign} />
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={valueByStatus}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCompactCurrency(v, sampleCurrency)} />
                      <Tooltip formatter={(v) => formatDisplayCurrency(v, sampleCurrency)} />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                        {valueByStatus.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </DashboardChartErrorBoundary>
            </DashboardChartCard>

            <DashboardChartCard title="Billing Period Mix">
              <DashboardChartErrorBoundary>
                {billingPeriodData.length === 0 ? (
                  <DashboardEmptyPanel title="No billing data" message="Distribution across billing periods will appear here." icon={Clock} />
                ) : (
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={billingPeriodData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} className="capitalize" />
                      <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                      <Tooltip formatter={(v) => [v, "Contracts"]} />
                      <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                        {billingPeriodData.map((_, i) => <Cell key={i} fill={BILLING_PERIOD_COLORS[i % BILLING_PERIOD_COLORS.length]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </DashboardChartErrorBoundary>
            </DashboardChartCard>

            <DashboardChartCard title="Upcoming Expiry" action={
              <button onClick={() => navigate("/billing/contracts")} className="text-xs font-medium text-[#FF7A00] hover:text-[#FF5500] flex items-center gap-1 shrink-0">
                View All <ChevronRight size={14} />
              </button>
            }>
              <DashboardChartErrorBoundary>
                <DataTable
                  columns={expiringColumns}
                  data={expiringContracts.slice(0, 8)}
                  rowKey={(row) => row.id}
                  onRowClick={(row) => navigate(`/billing/contracts/${row.id}`)}
                  stickyHeader={false}
                  emptyTitle="No upcoming expiries"
                  emptyMessage="Contracts expiring within 30 days will appear here."
                  emptyIcon={Clock}
                />
              </DashboardChartErrorBoundary>
            </DashboardChartCard>
          </div>
        </>
      )}
    </div>
  );
}
