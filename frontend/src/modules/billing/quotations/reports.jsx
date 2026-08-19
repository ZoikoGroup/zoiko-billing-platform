import { useState, useEffect, useCallback, useMemo } from "react";
import { Download, RefreshCw, TrendingUp, PieChart as PieChartIcon,
  BarChart3, FileText, Clock } from "lucide-react"
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
} from "recharts";
import HRPage from "../../../components/HRPage";
import { quoteApi } from "../../../service/billingService";
import { formatCurrency } from "../../../utils/locale";
import { extractArray } from "../../../utils/billing-helpers";
import { Spinner, ErrorState, EmptyState, DateRangeFilter, useDateRange, ExportMenu } from "../../../components/billing-shared";
import { filterByDateRange, downloadExcel, downloadJSON, downloadCSV } from "../../../utils/export-helpers";
import { useCurrency } from "../utils/CurrencyContext";

const TABS = [
  { key: "overview", label: "Overview", icon: FileText },
  { key: "status", label: "Status Analysis", icon: Clock },
  { key: "conversion", label: "Conversion Funnel", icon: TrendingUp },
  { key: "trends", label: "Trends", icon: BarChart3 },
];

export default function QuotationReportsPage() {
  const { range, setRange, customStart, setCustomStart, customEnd, setCustomEnd } = useDateRange();
  const [activeTab, setActiveTab] = useState("overview");
  const [refreshing, setRefreshing] = useState(false);

  const [quotations, setQuotations] = useState([]);
  const { baseCurrency: defaultCurrency } = useCurrency();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchQuotations = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await quoteApi.list({ per_page: 100 });
      setQuotations(extractArray(data));
    } catch (err) {
      setError(err.message || "Failed to load quotations");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await fetchQuotations();
    setRefreshing(false);
  }, [fetchQuotations]);

  useEffect(() => { fetchQuotations(); }, [fetchQuotations]);

  const fQuotations = useMemo(() => filterByDateRange(quotations, "created_at", range, customStart, customEnd), [quotations, range, customStart, customEnd]);

  const displayCurrency = fQuotations.length > 0
    ? (fQuotations.find(q => q.currency)?.currency || defaultCurrency)
    : defaultCurrency;

  const draft = fQuotations.filter((q) => q.status === "draft");
  const sent = fQuotations.filter((q) => q.status === "sent");
  const accepted = fQuotations.filter((q) => q.status === "accepted");
  const rejected = fQuotations.filter((q) => q.status === "rejected");
  const converted = fQuotations.filter((q) => q.status === "converted");
  const cancelled = fQuotations.filter((q) => q.status === "cancelled" || q.status === "expired");

  const totalValue = fQuotations.reduce((s, q) => s + parseFloat(q.total_amount || 0), 0);
  const acceptedValue = accepted.reduce((s, q) => s + parseFloat(q.total_amount || 0), 0);
  const convertedValue = converted.reduce((s, q) => s + parseFloat(q.total_amount || 0), 0);
  const conversionRate = sent.length > 0 ? ((accepted.length + converted.length) / (sent.length + accepted.length + converted.length)) * 100 : 0;  const avgValue = fQuotations.length > 0 ? totalValue / fQuotations.length : 0;

  const statusData = [
    { name: "Draft", value: draft.length, color: "#6b7280" },
    { name: "Sent", value: sent.length, color: "#3b82f6" },
    { name: "Accepted", value: accepted.length, color: "#10b981" },
    { name: "Rejected", value: rejected.length, color: "#ef4444" },
    { name: "Converted", value: converted.length, color: "#FF7A00" },
    { name: "Cancelled", value: cancelled.length, color: "#f59e0b" },
  ].filter((d) => d.value > 0);

  const valueByStatus = [
    { name: "Draft", value: draft.reduce((s, q) => s + parseFloat(q.total_amount || 0), 0), color: "#6b7280" },
    { name: "Sent", value: sent.reduce((s, q) => s + parseFloat(q.total_amount || 0), 0), color: "#3b82f6" },
    { name: "Accepted", value: acceptedValue, color: "#10b981" },
    { name: "Rejected", value: rejected.reduce((s, q) => s + parseFloat(q.total_amount || 0), 0), color: "#ef4444" },
    { name: "Converted", value: convertedValue, color: "#FF7A00" },
    { name: "Cancelled", value: cancelled.reduce((s, q) => s + parseFloat(q.total_amount || 0), 0), color: "#f59e0b" },
  ].filter((d) => d.value > 0);

  const conversionFunnel = [
    { name: "Sent", value: sent.length, color: "#3b82f6" },
    { name: "Accepted", value: accepted.length, color: "#10b981" },
    { name: "Converted", value: converted.length, color: "#FF7A00" },
  ].filter((d) => d.value > 0);

  const monthlyData = fQuotations.reduce((acc, q) => {
    const date = new Date(q.created_at || q.updated_at || Date.now());
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    if (!acc[key]) acc[key] = { month: key, count: 0, value: 0, accepted: 0 };
    acc[key].count += 1;
    acc[key].value += parseFloat(q.total_amount || 0);
    if (q.status === "accepted" || q.status === "converted") acc[key].accepted += 1;
    return acc;
  }, {});
  const monthlyChartData = Object.values(monthlyData).sort((a, b) => a.month.localeCompare(b.month));

  const [exportLoading, setExportLoading] = useState(null);
  const handleExcelExport = async () => {
    setExportLoading('excel');
    try {
      const rows = fQuotations.map((q) => [q.id, q.quote_number, q.status, q.total_amount, q.created_at]);
      await downloadExcel(rows, ['id','quote_number','status','total_amount','created_at'], 'quotations-report.xlsx');
    }
    catch (e) { /* Excel export failed */ } finally { setExportLoading(null); }
  };
  const handleAllExport = async (format) => {
    setExportLoading(format);
    try {
      if (format === 'json') await downloadJSON(fQuotations, 'quotations-data.json');
      else if (format === 'csv') {
        const rows = fQuotations.map((q) => [q.id, q.quote_number, q.status, q.total_amount]);
        await downloadCSV(rows, ['id','quote_number','status','total_amount'], 'quotations.csv');
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
    <HRPage title="Quotation Reports" subtitle="Quotation analytics and reporting">
      <div className="flex items-center justify-between mb-6">
        {renderTabNav()}
        <div className="flex items-center gap-2">
          <DateRangeFilter value={range} onChange={setRange} customStart={customStart} customEnd={customEnd}
            onCustomStartChange={setCustomStart} onCustomEndChange={setCustomEnd} />
          <ExportMenu
            onExportExcel={() => handleAllExport("excel")}
            onExportCSV={() => handleAllExport("csv")}
            onExportJSON={() => handleAllExport("json")}
          />
          <button onClick={refreshAll} disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {activeTab === "overview" && (
        <div className="space-y-6">
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchQuotations} /> : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Quotations</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{fQuotations.length}</p>
                  <p className="text-xs text-slate-400 mt-1">{sent.length} sent</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Conversion Rate</p>
                  <p className="text-2xl font-bold text-emerald-600 mt-1">{conversionRate.toFixed(1)}%</p>
                  <p className="text-xs text-slate-400 mt-1">{accepted.length + converted.length} won</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Average Value</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(avgValue, displayCurrency)}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Value</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(totalValue, displayCurrency)}</p>
                  <p className="text-xs text-slate-400 mt-1 whitespace-nowrap">{formatCurrency(acceptedValue + convertedValue, displayCurrency)} won</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Status Distribution</h3>
                    <button onClick={() => downloadJSON(statusData, "quotation-status-distribution.json")}
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" aria-label="Export status distribution">
                      <Download size={15} />
                    </button>
                  </div>
                  {statusData.length === 0 ? <EmptyState icon={PieChartIcon} title="No quotation data" /> : (
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
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Value by Status</h3>
                    <button onClick={() => downloadJSON(valueByStatus, "quotation-value-by-status.json")}
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" aria-label="Export value by status">
                      <Download size={15} />
                    </button>
                  </div>
                  {valueByStatus.length === 0 ? <EmptyState icon={BarChart3} title="No value data" /> : (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={valueByStatus}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v, displayCurrency)} />
                        <Tooltip formatter={(v) => [formatCurrency(v, displayCurrency)]} />
                        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                          {valueByStatus.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              {monthlyChartData.length > 0 && (
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Monthly Quotations</h3>
                    <button onClick={() => downloadCSV(monthlyChartData.map((d) => [d.month, d.count, d.value.toFixed(2)]), ["Month", "Count", "Value"], "monthly-quotations.csv")}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200" aria-label="Export monthly quotations CSV"><Download className="h-3.5 w-3.5" /> CSV</button>
                  </div>
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={monthlyChartData}>
                      <defs>
                        <linearGradient id="colorQuoteValue" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#FF7A00" stopOpacity={0.3} /><stop offset="95%" stopColor="#FF7A00" stopOpacity={0} /></linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v, displayCurrency)} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Area yAxisId="left" type="monotone" dataKey="value" stroke="#FF7A00" fill="url(#colorQuoteValue)" strokeWidth={2} name="Value" />
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
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchQuotations} /> : fQuotations.length === 0 ? (
            <EmptyState icon={FileText} title="No quotation data" />
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                {statusData.map((s) => (
                  <div key={s.name} className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-4 text-center">
                    <div className="w-3 h-3 rounded-full mx-auto mb-1.5" style={{ backgroundColor: s.color }} />
                    <p className="text-lg font-bold text-slate-900">{s.value}</p>
                    <p className="text-xs text-slate-500">{s.name}</p>
                  </div>
                ))}
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-slate-900">All Quotations by Status</h3>
                  <button onClick={() => downloadJSON(fQuotations, "all-quotations.json")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200" aria-label="Export all quotations"><Download className="h-3.5 w-3.5" /> Export</button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
<thead>
                       <tr className="border-b border-slate-100">
                         <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Quotation</th>
                         <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Status</th>
                         <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Amount</th>
                         <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Valid Until</th>
                         <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Created</th>
                       </tr>
                     </thead>
                    <tbody>
                      {fQuotations.slice(0, 20).map((q) => (
                        <tr key={q.id} className="border-b border-slate-50 hover:bg-slate-50">
                          <td className="py-3 px-3 font-medium text-slate-900">{q.quote_number || `#${q.id}`}</td>
                          <td className="py-3 px-3">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                              q.status === "draft" ? "bg-slate-100 text-slate-600" :
                              q.status === "sent" ? "bg-blue-100 text-blue-700" :
                              q.status === "accepted" ? "bg-emerald-100 text-emerald-700" :
                              q.status === "rejected" ? "bg-red-100 text-red-700" :
                              q.status === "converted" ? "bg-brand-100 text-brand-700" :
                              q.status === "cancelled" || q.status === "expired" ? "bg-amber-100 text-amber-700" :
                              "bg-slate-100 text-slate-600"
                            }`}>{q.status}</span>
                          </td>
                          <td className="py-3 px-3 text-right font-medium text-slate-900">{formatCurrency(q.total_amount, q.currency || displayCurrency)}</td>
                          <td className="py-3 px-3 text-slate-500 whitespace-nowrap">{q.valid_until ? new Date(q.valid_until).toLocaleDateString() : "—"}</td>
                          <td className="py-3 px-3 text-slate-500 whitespace-nowrap">{q.created_at ? new Date(q.created_at).toLocaleDateString() : "—"}</td>
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

      {activeTab === "conversion" && (
        <div className="space-y-6">
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchQuotations} /> : fQuotations.length === 0 ? (
            <EmptyState icon={TrendingUp} title="No conversion data" />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Conversion Rate</p>
                  <p className="text-2xl font-bold text-emerald-600 mt-1 whitespace-nowrap">{conversionRate.toFixed(1)}%</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Accepted</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{accepted.length}</p>
                  <p className="text-xs text-slate-400 mt-1 whitespace-nowrap">{formatCurrency(acceptedValue, displayCurrency)}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Converted to Invoice</p>
                  <p className="text-2xl font-bold text-brand-600 mt-1 whitespace-nowrap">{converted.length}</p>
                  <p className="text-xs text-slate-400 mt-1 whitespace-nowrap">{formatCurrency(convertedValue, displayCurrency)}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Rejected</p>
                  <p className="text-2xl font-bold text-red-600 mt-1">{rejected.length}</p>
                  <p className="text-xs text-slate-400 mt-1">{rejected.length > 0 ? `${((rejected.length / fQuotations.length) * 100).toFixed(1)}% rate` : "—"}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Conversion Funnel</h3>
                    <button onClick={() => downloadJSON(conversionFunnel, "conversion-funnel.json")}
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" aria-label="Export conversion funnel" title="Export"><Download size={15} /></button>
                  </div>
                  {conversionFunnel.length === 0 ? <EmptyState icon={BarChart3} title="No funnel data" /> : (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={conversionFunnel} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis type="number" tick={{ fontSize: 11 }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={80} />
                        <Tooltip />
                        <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                          {conversionFunnel.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Conversion Overview</h3>
                    <button onClick={() => downloadJSON([{ metric: "Sent", value: sent.length }, { metric: "Accepted", value: accepted.length }, { metric: "Converted", value: converted.length }, { metric: "Rejected", value: rejected.length }], "conversion-overview.json")}
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" aria-label="Export conversion overview" title="Export"><Download size={15} /></button>
                  </div>
                  <div className="space-y-4">
                    {[
                      { label: "Sent to Accepted", pct: sent.length > 0 ? (accepted.length / sent.length) * 100 : 0, color: "bg-emerald-400" },
                      { label: "Accepted to Converted", pct: accepted.length > 0 ? (converted.length / accepted.length) * 100 : 0, color: "bg-brand-400" },
                      { label: "Overall Win Rate", pct: fQuotations.length > 0 ? ((accepted.length + converted.length) / fQuotations.length) * 100 : 0, color: "bg-blue-400" },
                    ].map((m) => (
                      <div key={m.label}>
                        <div className="flex items-center justify-between text-sm mb-1">
                          <span className="text-slate-600">{m.label}</span>
                          <span className="font-semibold text-slate-900">{m.pct.toFixed(1)}%</span>
                        </div>
                        <div className="w-full bg-slate-100 rounded-full h-2">
                          <div className={`rounded-full h-2 transition-all ${m.color}`} style={{ width: `${Math.min(m.pct, 100)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {monthlyChartData.length > 0 && (
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Monthly Accepted vs Total</h3>
                    <button onClick={() => downloadCSV(monthlyChartData.map((d) => [d.month, d.count, d.accepted]), ["Month", "Total", "Accepted"], "monthly-conversion.csv")}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200" aria-label="Export monthly conversion CSV"><Download className="h-3.5 w-3.5" /> CSV</button>
                  </div>
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart data={monthlyChartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Bar dataKey="count" stackId="a" fill="#FF9B4D" radius={[4, 4, 0, 0]} name="Total" />
                      <Bar dataKey="accepted" stackId="a" fill="#FF7A00" radius={[4, 4, 0, 0]} name="Accepted" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "trends" && (
        <div className="space-y-6">
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchQuotations} /> : monthlyChartData.length === 0 ? (
            <EmptyState icon={TrendingUp} title="No trend data" />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Months Tracked</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{monthlyChartData.length}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Avg Monthly Value</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(totalValue / Math.max(monthlyChartData.length, 1), displayCurrency)}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Avg Quotations/Month</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{(fQuotations.length / Math.max(monthlyChartData.length, 1)).toFixed(1)}</p>
                </div>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                <h3 className="text-sm font-semibold text-slate-900 mb-4">Monthly Quotation Value</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={monthlyChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v, displayCurrency)} />
                    <Tooltip formatter={(v) => [formatCurrency(v, displayCurrency)]} />
                    <Bar dataKey="value" fill="#FF7A00" radius={[4, 4, 0, 0]} name="Value" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                <h3 className="text-sm font-semibold text-slate-900 mb-4">Monthly Quotation Count</h3>
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
