import { useState, useEffect, useCallback, useMemo } from "react";
import { Download, RefreshCw, TrendingUp, PieChart as PieChartIcon,
  BarChart3, FileText, Clock } from "lucide-react"
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
} from "recharts";
import HRPage from "../../../components/HRPage";
import { contractApi } from "../../../service/billingService";
import { formatDisplayCurrency } from "../../../utils/billing-helpers";
import { extractArray } from "../../../utils/billing-helpers";
import { Spinner, ErrorState, EmptyState, DateRangeFilter, useDateRange, ExportMenu } from "../../../components/billing-shared";
import { filterByDateRange, downloadExcel, downloadJSON, downloadCSV } from "../../../utils/export-helpers";
import { useTerminology } from "../utils/TerminologyContext";

const TABS = [
  { key: "overview", label: "Overview", icon: FileText },
  { key: "status", label: "Status Analysis", icon: Clock },
  { key: "expiring", label: "Expiring Soon", icon: Clock },
  { key: "trends", label: "Trends", icon: BarChart3 },
];

export default function ContractReportsPage() {
  const { singular } = useTerminology();
  const { range, setRange, customStart, setCustomStart, customEnd, setCustomEnd } = useDateRange();
  const [activeTab, setActiveTab] = useState("overview");
  const [refreshing, setRefreshing] = useState(false);

  const [contracts, setContracts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [expiring, setExpiring] = useState([]);
  const [loadingExpiring, setLoadingExpiring] = useState(false);

  const fetchContracts = useCallback(async () => {
    try { setLoading(true); setError(null); const data = await contractApi.list({ per_page: 100 }); setContracts(extractArray(data)); }
    catch (err) { setError(err.message || "Failed to load contracts"); }
    finally { setLoading(false); }
  }, []);

  const fetchExpiring = useCallback(async () => {
    try { setLoadingExpiring(true); const data = await contractApi.listExpiring(90); setExpiring(Array.isArray(data) ? data : []); }
    catch (e) { /* silent */ }
    finally { setLoadingExpiring(false); }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await Promise.allSettled([fetchContracts(), fetchExpiring()]);
    setRefreshing(false);
  }, [fetchContracts, fetchExpiring]);

  useEffect(() => { fetchContracts(); fetchExpiring(); }, [fetchContracts, fetchExpiring]);

  const fContracts = useMemo(() => filterByDateRange(contracts, "created_at", range, customStart, customEnd), [contracts, range, customStart, customEnd]);

  const active = fContracts.filter((c) => c.status === "active");
  const pending = fContracts.filter((c) => c.status === "pending" || c.status === "draft");
  const expired = fContracts.filter((c) => c.status === "expired");
  const terminated = fContracts.filter((c) => c.status === "terminated" || c.status === "cancelled");
  const totalValue = fContracts.reduce((s, c) => s + parseFloat(c.value || c.total_value || 0), 0);
  const activeValue = active.reduce((s, c) => s + parseFloat(c.value || c.total_value || 0), 0);
  const autoRenew = fContracts.filter((c) => c.auto_renew).length;

  const defaultCurrency = fContracts.length > 0
    ? (fContracts.find((c) => c.currency)?.currency || "")
    : "";

  const statusData = [
    { name: "Active", value: active.length, color: "#10b981" },
    { name: "Pending", value: pending.length, color: "#f59e0b" },
    { name: "Expired", value: expired.length, color: "#6b7280" },
    { name: "Terminated", value: terminated.length, color: "#ef4444" },
  ].filter((d) => d.value > 0);

  const valueByStatus = [
    { name: "Active", value: activeValue, color: "#10b981" },
    { name: "Pending", value: pending.reduce((s, c) => s + parseFloat(c.value || c.total_value || 0), 0), color: "#f59e0b" },
    { name: "Expired", value: expired.reduce((s, c) => s + parseFloat(c.value || c.total_value || 0), 0), color: "#6b7280" },
    { name: "Terminated", value: terminated.reduce((s, c) => s + parseFloat(c.value || c.total_value || 0), 0), color: "#ef4444" },
  ].filter((d) => d.value > 0);

  const monthlyData = fContracts.reduce((acc, c) => {
    const date = new Date(c.start_date || c.created_at);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    if (!acc[key]) acc[key] = { month: key, count: 0, value: 0 };
    acc[key].count += 1;
    acc[key].value += parseFloat(c.value || c.total_value || 0);
    return acc;
  }, {});
  const monthlyChartData = Object.values(monthlyData).sort((a, b) => a.month.localeCompare(b.month));

  const dateRangeProps = {
    value: range,
    onChange: setRange,
    customStart,
    customEnd,
    onCustomStartChange: setCustomStart,
    onCustomEndChange: setCustomEnd,
  };
  const [exportLoading, setExportLoading] = useState(null);
  const handleExcelExport = async () => {
    setExportLoading('excel');
    try {
      const rows = fContracts.map((c) => [c.id, c.contract_number, c.customer_name, c.status, c.value, c.start_date, c.end_date]);
      await downloadExcel(rows, ['id','contract_number','customer_name','status','value','start_date','end_date'], 'contracts-report.xlsx');
    }
    catch (e) { /* Excel export failed */ } finally { setExportLoading(null); }
  };
  const handleAllExport = async (format) => {
    setExportLoading(format);
    try {
      if (format === 'json') await downloadJSON(fContracts, 'contracts-data.json');
      else if (format === 'csv') {
        const rows = fContracts.map((c) => [c.id, c.contract_number, c.status, c.value]);
        await downloadCSV(rows, ['id','contract_number','status','value'], 'contracts.csv');
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
    <HRPage title="Contract Reports" subtitle="Contract analytics and reporting">
      <div className="flex items-center justify-between mb-6">
        {renderTabNav()}
        <div className="flex items-center gap-2">
          <DateRangeFilter {...dateRangeProps} />
          <ExportMenu
            onExportCSV={() => handleAllExport("csv")}
            onExportJSON={() => handleAllExport("json")}
            onExportExcel={() => handleAllExport("excel")}
          />
          <button onClick={refreshAll} disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {activeTab === "overview" && (
        <div className="space-y-6">
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchContracts} /> : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Contracts</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{fContracts.length}</p>
                  <p className="text-xs text-gray-400 mt-1">{active.length} active</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Value</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1 whitespace-nowrap">{formatDisplayCurrency(totalValue, defaultCurrency)}</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Active Value</p>
                  <p className="text-2xl font-bold text-emerald-600 mt-1 whitespace-nowrap">{formatDisplayCurrency(activeValue, defaultCurrency)}</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Auto-Renewal</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{autoRenew}</p>
                  <p className="text-xs text-gray-400 mt-1">{fContracts.length ? `${((autoRenew / fContracts.length) * 100).toFixed(0)}% of contracts` : "—"}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white rounded-xl border border-gray-200 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-gray-900">Contract Status Distribution</h3>
                    <button onClick={() => downloadJSON(statusData, "contract-status-distribution.json")}
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600" title="Export"><Download size={15} /></button>
                  </div>
                  {statusData.length === 0 ? <EmptyState icon={PieChartIcon} title="No contract data" /> : (
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
                <div className="bg-white rounded-xl border border-gray-200 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-gray-900">Value by Status</h3>
                    <button onClick={() => downloadJSON(valueByStatus, "contract-value-by-status.json")}
                      className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600" title="Export"><Download size={15} /></button>
                  </div>
                  {valueByStatus.length === 0 ? <EmptyState icon={BarChart3} title="No value data" /> : (
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={valueByStatus}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                        <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatDisplayCurrency(v, defaultCurrency)} />
                        <Tooltip formatter={(v) => [formatDisplayCurrency(v, defaultCurrency)]} />
                        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                          {valueByStatus.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              {monthlyChartData.length > 0 && (
                <div className="bg-white rounded-xl border border-gray-200 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-gray-900">Monthly Contracts Started</h3>
                    <button onClick={() => downloadCSV(monthlyChartData.map((d) => [d.month, d.count, d.value]), ["Month", "Count", "Value"], "monthly-contracts.csv")}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200"><Download className="h-3.5 w-3.5" /> CSV</button>
                  </div>
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={monthlyChartData}>
                      <defs>
                        <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#FF7A00" stopOpacity={0.3} /><stop offset="95%" stopColor="#FF7A00" stopOpacity={0} /></linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={(v) => formatDisplayCurrency(v, defaultCurrency)} />
                      <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                      <Tooltip />
                      <Area yAxisId="left" type="monotone" dataKey="value" stroke="#FF7A00" fill="url(#colorValue)" strokeWidth={2} name="Value" />
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
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchContracts} /> : fContracts.length === 0 ? (
            <EmptyState icon={FileText} title="No contract data" />
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {statusData.map((s) => (
                  <div key={s.name} className="bg-white rounded-xl border border-gray-200 p-4 text-center">
                    <div className="w-3 h-3 rounded-full mx-auto mb-1.5" style={{ backgroundColor: s.color }} />
                    <p className="text-lg font-bold text-gray-900">{s.value}</p>
                    <p className="text-xs text-gray-500">{s.name}</p>
                  </div>
                ))}
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">All Contracts by Status</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Contract</th>
                        <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">{singular}</th>
                        <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Status</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Value</th>
                        <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Period</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fContracts.slice(0, 20).map((c) => (
                        <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-3 px-3 font-medium text-gray-900">{c.contract_number || `#${c.id}`}</td>
                          <td className="py-3 px-3 text-gray-600">{c.customer_name || `#${c.customer_id}`}</td>
                          <td className="py-3 px-3">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                              c.status === "active" ? "bg-emerald-100 text-emerald-700" :
                              c.status === "pending" || c.status === "draft" ? "bg-amber-100 text-amber-700" :
                              c.status === "expired" ? "bg-gray-100 text-gray-600" : "bg-red-100 text-red-700"
                            }`}>{c.status}</span>
                          </td>
                          <td className="py-3 px-3 text-right font-medium text-gray-900">{formatDisplayCurrency(c.value || c.total_value, defaultCurrency)}</td>
                          <td className="py-3 px-3 text-gray-500 whitespace-nowrap">
                            {c.start_date ? new Date(c.start_date).toLocaleDateString() : "—"} — {c.end_date ? new Date(c.end_date).toLocaleDateString() : "—"}
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

      {activeTab === "expiring" && (
        <div className="space-y-6">
          {loadingExpiring ? <Spinner /> : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Expiring (90d)</p>
                  <p className="text-2xl font-bold text-amber-600 mt-1">{expiring.length}</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Expiring Value</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1 whitespace-nowrap">{formatDisplayCurrency(expiring.reduce((s, c) => s + parseFloat(c.value || c.total_value || 0), 0), defaultCurrency)}</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Auto-Renewal</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{expiring.filter((c) => c.auto_renew).length}</p>
                  <p className="text-xs text-gray-400 mt-1">Will auto-renew</p>
                </div>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-gray-900">Expiring Contracts (Next 90 Days)</h3>
                  <button onClick={() => downloadJSON(expiring, "expiring-contracts.json")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200"><Download className="h-3.5 w-3.5" /> Export</button>
                </div>
                {expiring.length === 0 ? (
                  <EmptyState icon={Clock} title="No contracts expiring" message="No contracts are expiring in the next 90 days." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Contract</th>
                          <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">{singular}</th>
                          <th scope="col" className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Value</th>
                          <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">End Date</th>
                          <th scope="col" className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Auto-Renew</th>
                        </tr>
                      </thead>
                      <tbody>
                        {expiring.map((c) => (
                          <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50">
                            <td className="py-3 px-3 font-medium text-gray-900">{c.contract_number || `#${c.id}`}</td>
                            <td className="py-3 px-3 text-gray-600">{c.customer_name || `#${c.customer_id}`}</td>
                            <td className="py-3 px-3 text-right font-medium text-gray-900">{formatDisplayCurrency(c.value || c.total_value, defaultCurrency)}</td>
                            <td className="py-3 px-3 text-gray-500 whitespace-nowrap">{c.end_date ? new Date(c.end_date).toLocaleDateString() : "—"}</td>
                            <td className="py-3 px-3">
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${c.auto_renew ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
                                {c.auto_renew ? "Yes" : "No"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "trends" && (
        <div className="space-y-6">
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchContracts} /> : monthlyChartData.length === 0 ? (
            <EmptyState icon={TrendingUp} title="No trend data" />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Months Tracked</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{monthlyChartData.length}</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Avg Monthly Value</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1 whitespace-nowrap">{formatDisplayCurrency(totalValue / Math.max(monthlyChartData.length, 1), defaultCurrency)}</p>
                </div>
                <div className="bg-white rounded-xl border border-gray-200 p-5">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Avg Contracts/Month</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{(fContracts.length / Math.max(monthlyChartData.length, 1)).toFixed(1)}</p>
                </div>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">Monthly Contract Value</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={monthlyChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatDisplayCurrency(v, defaultCurrency)} />
                    <Tooltip formatter={(v) => [formatDisplayCurrency(v, defaultCurrency)]} />
                    <Bar dataKey="value" fill="#FF7A00" radius={[4, 4, 0, 0]} name="Value" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-xl border border-gray-200 p-6">
                <h3 className="text-sm font-semibold text-gray-900 mb-4">Monthly Contract Count</h3>
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
