import { useState, useEffect, useCallback, useMemo } from "react";
import { Download, RefreshCw, TrendingUp, PieChart as PieChartIcon,
  BarChart3, FileText } from "lucide-react"
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
} from "recharts";
import HRPage from "../../../components/HRPage";
import { subscriptionApi } from "../../../service/billingService";
import { formatCurrency } from "../../../utils/locale";
import { extractArray } from "../../../utils/billing-helpers";
import { Spinner, ErrorState, EmptyState, DateRangeFilter, useDateRange, ExportMenu } from "../../../components/billing-shared";
import { filterByDateRange, downloadExcel, downloadJSON, downloadCSV } from "../../../utils/export-helpers";
import { useTerminology } from "../utils/TerminologyContext";
import { sumByCurrency } from "../../../utils/currency-conversion";
import { useCurrency } from "../utils/CurrencyContext";

const TABS = [
  { key: "overview", label: "Overview", icon: FileText },
  { key: "status", label: "Status Analysis", icon: PieChartIcon },
  { key: "mrr", label: "MRR / LTV", icon: TrendingUp },
  { key: "trends", label: "Trends", icon: BarChart3 },
];

export default function SubscriptionReportsPage() {
  const { singular } = useTerminology();
  const { range, setRange, customStart, setCustomStart, customEnd, setCustomEnd } = useDateRange();
  const [activeTab, setActiveTab] = useState("overview");
  const [refreshing, setRefreshing] = useState(false);

  const [subscriptions, setSubscriptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { baseCurrency: orgCurrency } = useCurrency();
  const [reporting, setReporting] = useState(null);

  const fetchSubscriptions = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await subscriptionApi.list({ per_page: 100 });
      setSubscriptions(extractArray(data));
      try {
        const rpt = await subscriptionApi.getReporting();
        setReporting(rpt);
      } catch { setReporting(null); }
    } catch (err) {
      setError(err.message || "Failed to load subscriptions");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await fetchSubscriptions();
    setRefreshing(false);
  }, [fetchSubscriptions]);

  useEffect(() => { fetchSubscriptions(); }, [fetchSubscriptions]);

  const fSubscriptions = useMemo(() => filterByDateRange(subscriptions, "created_at", range, customStart, customEnd), [subscriptions, range, customStart, customEnd]);

  const active = fSubscriptions.filter((s) => s.status === "active");
  const paused = fSubscriptions.filter((s) => s.status === "paused");
  const cancelled = fSubscriptions.filter((s) => s.status === "cancelled" || s.status === "expired");
  const pastDue = fSubscriptions.filter((s) => s.status === "past_due");

  const totalMRR = reporting?.mrr != null ? parseFloat(reporting.mrr) : 0;
  const totalARR = reporting?.arr != null ? parseFloat(reporting.arr) : 0;
  const reportingCurrency = reporting?.reporting_currency || orgCurrency;
  const churnedCount = fSubscriptions.filter((s) => s.status === "cancelled").length;
  const churnRate = fSubscriptions.length > 0 ? (churnedCount / fSubscriptions.length) * 100 : 0;
  const avgRevenuePerSub = active.length > 0 ? totalMRR / active.length : 0;
  const estimatedLTV = avgRevenuePerSub * 24;

  const currencyBreakdown = reporting?.currency_breakdown || [];
  const totalValue = fSubscriptions.reduce((s, sub) => s + parseFloat(sub.unit_price || 0) * (sub.quantity || 1), 0);
  const currencyGrouped = sumByCurrency(
    active.map((s) => ({ amount: parseFloat(s.unit_price || 0) * (s.quantity || 1), currency: s.currency || reportingCurrency })),
  );

  const statusData = [
    { name: "Active", value: active.length, color: "#10b981" },
    { name: "Paused", value: paused.length, color: "#f59e0b" },
    { name: "Past Due", value: pastDue.length, color: "#ef4444" },
    { name: "Cancelled", value: cancelled.length, color: "#6b7280" },
  ].filter((d) => d.value > 0);

  const mrrData = [
    { name: "Active MRR", value: totalMRR, color: "#10b981" },
    { name: "Past Due", value: pastDue.reduce((s, sub) => {
        const p = parseFloat(sub.unit_price || 0) * (sub.quantity || 1);
        const period = sub.plan_billing_period || sub.billing_period || "monthly";
        const div = { monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 }[period] || 12;
        return s + p / div;
      }, 0), color: "#ef4444" },
  ].filter((d) => d.value > 0);

  const monthlyData = fSubscriptions.reduce((acc, s) => {
    const dt = new Date(s.start_date || s.created_at);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
    if (!acc[key]) acc[key] = { month: key, count: 0, value: 0, mrr: 0 };
    acc[key].count += 1;
    acc[key].value += parseFloat(s.unit_price || 0) * (s.quantity || 1);
    if (s.status === "active") acc[key].mrr += parseFloat(s.unit_price || 0) * (s.quantity || 1);
    return acc;
  }, {});
  const monthlyChartData = Object.values(monthlyData).sort((a, b) => a.month.localeCompare(b.month));

  const [exportLoading, setExportLoading] = useState(null);
  const handleExcelExport = async () => {
    setExportLoading('excel');
    try {
      const rows = fSubscriptions.map((s) => [s.id, s.customer_name, s.plan_name, s.status, s.unit_price, s.start_date]);
      await downloadExcel(rows, ['id','customer_name','plan_name','status','unit_price','start_date'], 'subscriptions-report.xlsx');
    }
    catch (e) { /* Excel export failed */ } finally { setExportLoading(null); }
  };
  const handleAllExport = async (format) => {
    setExportLoading(format);
    try {
      if (format === 'json') await downloadJSON(fSubscriptions, 'subscriptions-data.json');
      else if (format === 'csv') {
        const rows = fSubscriptions.map((s) => [s.id, s.customer_name, s.status, s.unit_price]);
        await downloadCSV(rows, ['id','customer_name','status','unit_price'], 'subscriptions.csv');
      }
      else if (format === 'excel') await handleExcelExport();
    } catch (e) { /* Export failed */ } finally { setExportLoading(null); }
  };

  const renderTabNav = () => (
    <nav className="flex gap-0 border-b border-slate-200 overflow-x-auto">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        return (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
              activeTab === tab.key ? "border-brand-600 text-brand-600" : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
            }`}>
            <Icon className="h-4 w-4" /> {tab.label}
          </button>
        );
      })}
    </nav>
  );

  return (
    <HRPage title="Subscription Reports" subtitle="Subscription analytics and reporting">
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
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {activeTab === "overview" && (
        <div className="space-y-6">
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchSubscriptions} /> : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Subscriptions</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{fSubscriptions.length}</p>
                  <p className="text-xs text-slate-400 mt-1">{active.length} active</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">MRR</p>
                  <p className="text-2xl font-bold text-emerald-600 mt-1 whitespace-nowrap">{formatCurrency(totalMRR, orgCurrency)}</p>
                  <p className="text-xs text-slate-400 mt-1 whitespace-nowrap">{formatCurrency(totalARR, orgCurrency)} ARR</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Churn Rate</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{churnRate.toFixed(1)}%</p>
                  <p className="text-xs text-slate-400 mt-1">{churnedCount} cancelled</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Est. LTV</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(estimatedLTV, orgCurrency)}</p>
                  <p className="text-xs text-slate-400 mt-1">Per subscriber</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white rounded-3xl border border-slate-200 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Subscription Status Distribution</h3>
                    <button onClick={() => downloadJSON(statusData, "subscription-status-distribution.json")}
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" title="Export"><Download size={15} /></button>
                  </div>
                  {statusData.length === 0 ? <EmptyState icon={PieChartIcon} title="No subscription data" /> : (
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie data={statusData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value"
                          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                          {statusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Pie>
                        <Tooltip formatter={(v) => [v, "Count"]} />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">MRR Distribution</h3>
                    <button onClick={() => downloadJSON(mrrData, "subscription-mrr-distribution.json")}
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" title="Export"><Download size={15} /></button>
                  </div>
                  {mrrData.length === 0 ? <EmptyState icon={BarChart3} title="No MRR data" /> : (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={mrrData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v, reportingCurrency)} />
                        <Tooltip formatter={(v) => [formatCurrency(v, orgCurrency)]} />
                        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                          {mrrData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              {Object.keys(currencyGrouped).length > 1 && (
                <div className="bg-white rounded-3xl border border-slate-200 p-6">
                  <h3 className="text-sm font-semibold text-slate-900 mb-4">
                    Subscription Value by Original Currency
                    <span className="ml-2 text-xs font-normal text-slate-400">
                      (MRR expressed in {formatCurrency(0, reportingCurrency).replace(/[\d.]/g, "").trim() || reportingCurrency})
                    </span>
                  </h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {Object.entries(currencyGrouped).map(([curr, amt]) => (
                      <div key={curr} className="bg-slate-50 rounded-lg p-3 text-center">
                        <p className="text-lg font-bold text-slate-900">{formatCurrency(amt, curr)}</p>
                        <p className="text-xs text-slate-500">{curr}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {monthlyChartData.length > 0 && (
                <div className="bg-white rounded-3xl border border-slate-200 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Monthly Subscriptions Started</h3>
                    <button onClick={() => downloadCSV(monthlyChartData.map((d) => [d.month, d.count, d.value.toFixed(2)]), ["Month", "Count", "Value"], "monthly-subscriptions.csv")}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200"><Download className="h-3.5 w-3.5" /> CSV</button>
                  </div>
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={monthlyChartData}>
                      <defs>
                        <linearGradient id="colorSubValue" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#FF7A00" stopOpacity={0.3} /><stop offset="95%" stopColor="#FF7A00" stopOpacity={0} /></linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v, reportingCurrency)} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Area yAxisId="left" type="monotone" dataKey="value" stroke="#FF7A00" fill="url(#colorSubValue)" strokeWidth={2} name="Value" />
                      <Line yAxisId="right" type="monotone" dataKey="count" stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }} name="Count" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "status" && (
        <div className="space-y-6">
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchSubscriptions} /> : fSubscriptions.length === 0 ? (
            <EmptyState icon={FileText} title="No subscription data" />
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {statusData.map((s) => (
                  <div key={s.name} className="bg-white rounded-3xl border border-slate-200 p-4 text-center">
                    <div className="w-3 h-3 rounded-full mx-auto mb-1.5" style={{ backgroundColor: s.color }} />
                    <p className="text-lg font-bold text-slate-900">{s.value}</p>
                    <p className="text-xs text-slate-500">{s.name}</p>
                  </div>
                ))}
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-slate-900">All Subscriptions by Status</h3>
                  <button onClick={() => downloadJSON(fSubscriptions, "all-subscriptions.json")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200"><Download className="h-3.5 w-3.5" /> Export</button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Subscription</th>
                        <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">{singular}</th>
                        <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Plan</th>
                        <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Status</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Amount</th>
                        <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Start Date</th>
                        <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Next Billing</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fSubscriptions.slice(0, 20).map((s) => (
                        <tr key={s.id} className="border-b border-slate-50 hover:bg-slate-50">
                          <td className="py-3 px-3 font-medium text-slate-900">{s.subscription_number || `#${s.id}`}</td>
                          <td className="py-3 px-3 text-slate-600">{s.customer_name || s.customer?.name || (s.customer_id ? `${singular} #${s.customer_id}` : `Unassigned ${singular}`)}</td>
                          <td className="py-3 px-3 text-slate-600">{s.plan?.plan_name || s.plan_name || (s.plan_id ? `Plan #${s.plan_id}` : "Unassigned Plan")}</td>
                          <td className="py-3 px-3">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                              s.status === "active" ? "bg-emerald-100 text-emerald-700" :
                              s.status === "paused" ? "bg-amber-100 text-amber-700" :
                              s.status === "past_due" ? "bg-red-100 text-red-700" :
                              s.status === "cancelled" || s.status === "expired" ? "bg-slate-100 text-slate-600" :
                              "bg-slate-100 text-slate-500"
                            }`}>{s.status}</span>
                          </td>
                          <td className="py-3 px-3 text-right font-medium text-slate-900">
                            {formatCurrency(s.unit_price, orgCurrency)}
                            {s.quantity > 1 && <span className="text-xs text-slate-400 ml-1">x{s.quantity}</span>}
                          </td>
                          <td className="py-3 px-3 text-slate-500 whitespace-nowrap">{s.start_date ? new Date(s.start_date).toLocaleDateString() : "—"}</td>
                          <td className="py-3 px-3 text-slate-500 whitespace-nowrap">{s.next_billing_at ? new Date(s.next_billing_at).toLocaleDateString() : "—"}</td>
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

      {activeTab === "mrr" && (
        <div className="space-y-6">
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchSubscriptions} /> : fSubscriptions.length === 0 ? (
            <EmptyState icon={TrendingUp} title="No MRR data" />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Monthly Recurring Revenue</p>
                  <p className="text-2xl font-bold text-emerald-600 mt-1 whitespace-nowrap">{formatCurrency(totalMRR, orgCurrency)}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Annual Recurring Revenue</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(totalARR, orgCurrency)}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Avg Revenue/Sub</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(avgRevenuePerSub, orgCurrency)}</p>
                  <p className="text-xs text-slate-400 mt-1">Monthly</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Estimated LTV</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(estimatedLTV, orgCurrency)}</p>
                  <p className="text-xs text-slate-400 mt-1">24-month estimate</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white rounded-3xl border border-slate-200 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">MRR by Status</h3>
                    <button onClick={() => downloadJSON(mrrData, "mrr-by-status.json")}
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" title="Export"><Download size={15} /></button>
                  </div>
                  {mrrData.length === 0 ? <EmptyState icon={PieChartIcon} title="No MRR data" /> : (
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie data={mrrData} cx="50%" cy="50%" outerRadius={100} paddingAngle={3} dataKey="value"
                          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                          {mrrData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Pie>
                        <Tooltip formatter={(v) => [formatCurrency(v, orgCurrency)]} />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Churn Overview</h3>
                    <button onClick={() => downloadJSON([{ metric: "Churn Rate", value: churnRate.toFixed(1) }, { metric: "Churned", value: churnedCount }, { metric: "Total", value: fSubscriptions.length }], "churn-overview.json")}
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" title="Export"><Download size={15} /></button>
                  </div>
                  <div className="space-y-4">
                    <div>
                      <div className="flex items-center justify-between text-sm mb-1">
                        <span className="text-slate-600">Churn Rate</span>
                        <span className="font-semibold text-slate-900">{churnRate.toFixed(1)}%</span>
                      </div>
                      <div className="w-full bg-slate-100 rounded-full h-2">
                        <div className="bg-red-400 rounded-full h-2" style={{ width: `${Math.min(churnRate, 100)}%` }} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-slate-50 rounded-lg p-3 text-center">
                        <p className="text-lg font-bold text-slate-900">{active.length}</p>
                        <p className="text-xs text-slate-500">Active</p>
                      </div>
                      <div className="bg-slate-50 rounded-lg p-3 text-center">
                        <p className="text-lg font-bold text-red-600">{churnedCount}</p>
                        <p className="text-xs text-slate-500">Churned</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-slate-50 rounded-lg p-3 text-center">
                        <p className="text-lg font-bold text-slate-900">{formatCurrency(totalMRR, orgCurrency)}</p>
                        <p className="text-xs text-slate-500">Current MRR</p>
                      </div>
                      <div className="bg-slate-50 rounded-lg p-3 text-center">
                        <p className="text-lg font-bold text-slate-900">{formatCurrency(estimatedLTV, orgCurrency)}</p>
                        <p className="text-xs text-slate-500">Avg LTV</p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {monthlyChartData.length > 0 && (
                <div className="bg-white rounded-3xl border border-slate-200 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">MRR Trend</h3>
                    <button onClick={() => downloadCSV(monthlyChartData.map((d) => [d.month, d.mrr.toFixed(2)]), ["Month", "MRR"], "mrr-trend.csv")}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200"><Download className="h-3.5 w-3.5" /> CSV</button>
                  </div>
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={monthlyChartData}>
                      <defs>
                        <linearGradient id="colorMRR" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10b981" stopOpacity={0.3} /><stop offset="95%" stopColor="#10b981" stopOpacity={0} /></linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v, reportingCurrency)} />
                      <Tooltip formatter={(v) => [formatCurrency(v, orgCurrency)]} />
                      <Area type="monotone" dataKey="mrr" stroke="#10b981" fill="url(#colorMRR)" strokeWidth={2} name="MRR" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "trends" && (
        <div className="space-y-6">
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchSubscriptions} /> : monthlyChartData.length === 0 ? (
            <EmptyState icon={TrendingUp} title="No trend data" />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Months Tracked</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{monthlyChartData.length}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Avg Monthly Growth</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{formatCurrency(totalValue / Math.max(monthlyChartData.length, 1), orgCurrency)}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Avg Subs/Month</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{(fSubscriptions.length / Math.max(monthlyChartData.length, 1)).toFixed(1)}</p>
                </div>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 p-6">
                <h3 className="text-sm font-semibold text-slate-900 mb-4">Monthly Subscription Value</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={monthlyChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v, reportingCurrency)} />
                    <Tooltip formatter={(v) => [formatCurrency(v, orgCurrency)]} />
                    <Bar dataKey="value" fill="#FF7A00" radius={[4, 4, 0, 0]} name="Value" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 p-6">
                <h3 className="text-sm font-semibold text-slate-900 mb-4">Monthly Subscription Count</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={monthlyChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="count" stroke="#FF7A00" strokeWidth={2} dot={{ r: 3 }} name="Count" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </div>
      )}
    </HRPage>
  );
}
