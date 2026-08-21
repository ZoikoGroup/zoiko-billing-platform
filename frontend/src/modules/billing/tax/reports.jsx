import { useState, useEffect, useCallback, useMemo } from "react";
import { Download, RefreshCw, DollarSign, TrendingUp, PieChart as PieChartIcon, BarChart3, Globe, Receipt } from "lucide-react";
import { BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import HRPage from "../../../components/HRPage";
import { taxApi, invoiceApi } from "../../../service/billingService";
import { formatCurrency } from "../../../utils/locale";
import { useCurrency } from "../utils/CurrencyContext";
import { extractArray } from "../../../utils/billing-helpers";
import { Spinner, ErrorState, EmptyState, DateRangeFilter, useDateRange, ExportMenu } from "../../../components/billing-shared";
import { filterByDateRange, downloadExcel, downloadJSON, downloadCSV } from "../../../utils/export-helpers";

const COLORS = ["#FF7A00", "#FF9B4D", "#FFC9A6", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4898", "#14b8a6", "#f97316"];

const TABS = [
  { key: "overview", label: "Overview", icon: BarChart3 },
  { key: "collection", label: "Collection", icon: DollarSign },
  { key: "jurisdiction", label: "By Jurisdiction", icon: Globe },
  { key: "filing", label: "Filing", icon: Receipt },
];

export default function TaxReportsPage() {
  const { baseCurrency } = useCurrency();
  const { range, setRange, customStart, setCustomStart, customEnd, setCustomEnd } = useDateRange();
  const [activeTab, setActiveTab] = useState("overview");
  const [refreshing, setRefreshing] = useState(false);

  const [taxRates, setTaxRates] = useState([]);
  const [loadingTax, setLoadingTax] = useState(true);
  const [errorTax, setErrorTax] = useState(null);

  const [invoices, setInvoices] = useState([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [errorInvoices, setErrorInvoices] = useState(null);

  const [settings, setSettings] = useState({});
  const [loadingSettings, setLoadingSettings] = useState(false);

  const fetchTaxRates = useCallback(async () => {
    try { setLoadingTax(true); setErrorTax(null); const data = await taxApi.list({ per_page: 100 }); setTaxRates(extractArray(data)); }
    catch (err) { setErrorTax(err.message || "Failed to load tax rates"); }
    finally { setLoadingTax(false); }
  }, []);

  const fetchInvoices = useCallback(async () => {
    try { setLoadingInvoices(true); setErrorInvoices(null); const data = await invoiceApi.list({ per_page: 100 }); setInvoices(extractArray(data)); }
    catch (err) { setErrorInvoices(err.message || "Failed to load invoices"); }
    finally { setLoadingInvoices(false); }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await Promise.allSettled([fetchTaxRates(), fetchInvoices()]);
    setRefreshing(false);
  }, [fetchTaxRates, fetchInvoices]);

  useEffect(() => { fetchTaxRates(); }, [fetchTaxRates]);
  useEffect(() => { if (activeTab === "overview" || activeTab === "collection") { fetchInvoices(); } }, [activeTab, fetchInvoices]);

  const fTaxRates = useMemo(() => filterByDateRange(taxRates, "created_at", range, customStart, customEnd), [taxRates, range, customStart, customEnd]);
  const fInvoices = useMemo(() => filterByDateRange(invoices, "created_at", range, customStart, customEnd), [invoices, range, customStart, customEnd]);

  const activeRates = fTaxRates.filter((r) => r.is_active === true || r.status === "active");
  const totalTaxCollected = fInvoices.reduce((sum, inv) => sum + parseFloat(inv.tax_amount || inv.tax_total || 0), 0);

  const jurisdictionData = fTaxRates.reduce((acc, r) => {
    const juris = r.jurisdiction || "Unknown";
    if (!acc[juris]) acc[juris] = { name: juris, count: 0, totalRate: 0 };
    acc[juris].count += 1;
    acc[juris].totalRate += parseFloat(r.rate || 0);
    return acc;
  }, {});
  const jurisdictionChartData = Object.values(jurisdictionData).map((j, i) => ({
    ...j,
    avgRate: j.totalRate / j.count,
    color: COLORS[i % COLORS.length],
  }));

  const typeData = [
    { name: "Sales Tax", value: fTaxRates.filter((r) => r.tax_type === "sales_tax").length, color: "#FF7A00" },
    { name: "VAT", value: fTaxRates.filter((r) => r.tax_type === "vat").length, color: "#FF9B4D" },
    { name: "GST", value: fTaxRates.filter((r) => r.tax_type === "gst").length, color: "#f59e0b" },
    { name: "Withholding", value: fTaxRates.filter((r) => r.tax_type === "withholding").length, color: "#ef4444" },
    { name: "Other", value: fTaxRates.filter((r) => !["sales_tax", "vat", "gst", "withholding"].includes(r.tax_type)).length, color: "#10b981" },
  ].filter((d) => d.value > 0);

  const statusData = [
    { name: "Active", value: activeRates.length, color: "#10b981" },
    { name: "Inactive", value: fTaxRates.filter((r) => r.is_active === false || r.status === "inactive").length, color: "#6b7280" },
  ].filter((d) => d.value > 0);

  const jurisdictionCount = new Set(fTaxRates.map((r) => r.jurisdiction).filter(Boolean)).size;

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
      const rows = fTaxRates.map((r) => [r.id, r.name, r.rate, r.tax_type, r.jurisdiction, r.status]);
      await downloadExcel(rows, ['id','name','rate','tax_type','jurisdiction','status'], 'tax-rates-report.xlsx');
    }
    catch (e) { /* Excel export failed */ } finally { setExportLoading(null); }
  };
  const handleAllExport = async (format) => {
    setExportLoading(format);
    try {
      if (format === 'json') await downloadJSON({ taxRates: fTaxRates, invoices: fInvoices }, 'tax-data.json');
      else if (format === 'csv') {
        const rows = fTaxRates.map((r) => [r.name, r.rate, r.tax_type, r.jurisdiction]);
        await downloadCSV(rows, ['name','rate','tax_type','jurisdiction'], 'tax-rates.csv');
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
    <HRPage title="Tax Reports" subtitle="Tax analytics and reporting">

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
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {activeTab === "overview" && (
        <div className="space-y-6">
          {loadingTax ? <Spinner /> : errorTax ? <ErrorState message={errorTax} onRetry={fetchTaxRates} /> : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Tax Rates</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{fTaxRates.length}</p>
                  <p className="text-xs text-slate-400 mt-1">{activeRates.length} active</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Tax Collected</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(totalTaxCollected, baseCurrency)}</p>
                  <p className="text-xs text-slate-400 mt-1">From {fInvoices.length} invoices</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Jurisdictions</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{jurisdictionCount}</p>
                  <p className="text-xs text-slate-400 mt-1">Countries / regions</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Avg Rate</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{fTaxRates.length ? `${(activeRates.reduce((s, r) => s + parseFloat(r.rate || 0), 0) / Math.max(activeRates.length, 1)).toFixed(1)}%` : "—"}</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white rounded-3xl border border-slate-200 p-6">
                  <h3 className="text-sm font-semibold text-slate-900 mb-4">Tax Type Distribution</h3>
                  {typeData.length === 0 ? <EmptyState icon={PieChartIcon} title="No tax data" /> : (
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie data={typeData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                          {typeData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-6">
                  <h3 className="text-sm font-semibold text-slate-900 mb-4">Rate Status</h3>
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
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "collection" && (
        <div className="space-y-6">
          {loadingInvoices ? <Spinner /> : errorInvoices ? <ErrorState message={errorInvoices} onRetry={fetchInvoices} /> : fInvoices.length === 0 ? (
            <EmptyState icon={DollarSign} title="No collection data" message="Invoice data will appear here once available." />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Tax Collected</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(totalTaxCollected, baseCurrency)}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Taxed Invoices</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{fInvoices.filter((i) => parseFloat(i.tax_amount || i.tax_total || 0) > 0).length}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Avg Tax Per Invoice</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{fInvoices.length ? formatCurrency(totalTaxCollected / fInvoices.length, baseCurrency) : "—"}</p>
                </div>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-slate-900">Recent Invoices with Tax</h3>
                    <button onClick={() => downloadJSON(fInvoices.filter((i) => parseFloat(i.tax_amount || i.tax_total || 0) > 0).slice(0, 20), "tax-collection.json")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200">
                    <Download className="h-3.5 w-3.5" /> Export
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Invoice</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Total</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Tax Amount</th>
                        <th scope="col" className="text-center py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fInvoices.filter((i) => parseFloat(i.tax_amount || i.tax_total || 0) > 0).slice(0, 20).map((inv) => (
                        <tr key={inv.id} className="border-b border-slate-50 hover:bg-slate-50">
                          <td className="py-3 px-3 font-medium text-slate-900">{inv.invoice_number || `#${inv.id}`}</td>
                          <td className="py-3 px-3 text-right text-slate-900 font-medium">{formatCurrency(inv.total || inv.total_amount || 0, inv.currency)}</td>
                          <td className="py-3 px-3 text-right text-emerald-600 font-medium">{formatCurrency(inv.tax_amount || inv.tax_total || 0, inv.currency)}</td>
                          <td className="py-3 px-3 text-center">
                            <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              inv.status === "paid" ? "bg-emerald-100 text-emerald-700" :
                              inv.status === "overdue" ? "bg-red-100 text-red-700" :
                              inv.status === "sent" ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"
                            }`}>{inv.status}</span>
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

      {activeTab === "jurisdiction" && (
        <div className="space-y-6">
          {loadingTax ? <Spinner /> : errorTax ? <ErrorState message={errorTax} onRetry={fetchTaxRates} /> : jurisdictionChartData.length === 0 ? (
            <EmptyState icon={Globe} title="No jurisdiction data" message="Tax rates with jurisdictions will appear here." />
          ) : (
            <>
              <div className="bg-white rounded-3xl border border-slate-200 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-slate-900">Tax Rates by Jurisdiction</h3>
                  <button onClick={() => downloadJSON(jurisdictionChartData, "tax-by-jurisdiction.json")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200">
                    <Download className="h-3.5 w-3.5" /> Export
                  </button>
                </div>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={jurisdictionChartData} layout="vertical" margin={{ left: 100 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `${v.toFixed(0)}%`} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={90} />
                    <Tooltip formatter={(v) => `${v.toFixed(1)}%`} />
                    <Bar dataKey="avgRate" radius={[0, 4, 4, 0]}>
                      {jurisdictionChartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 p-6">
                <h3 className="text-sm font-semibold text-slate-900 mb-4">Jurisdiction Details</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
<thead>
                       <tr className="border-b border-slate-100">
                         <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Jurisdiction</th>
                         <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Tax Rates</th>
                         <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Avg Rate</th>
                       </tr>
                     </thead>
                    <tbody>
                      {jurisdictionChartData.map((j, i) => (
                        <tr key={i} className="border-b border-slate-50 hover:bg-slate-50">
                          <td className="py-3 px-3 font-medium text-slate-900">{j.name}</td>
                          <td className="py-3 px-3 text-right text-slate-500">{j.count}</td>
                          <td className="py-3 px-3 text-right font-medium text-slate-900">{j.avgRate.toFixed(1)}%</td>
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

      {activeTab === "filing" && (
        <div className="space-y-6">
          {loadingTax ? <Spinner /> : errorTax ? <ErrorState message={errorTax} onRetry={fetchTaxRates} /> : (
            <>
              {(() => {
                const invoicesWithTax = fInvoices.filter((inv) => Number(inv.tax_amount || inv.tax || 0) > 0);
                const totalTaxCollected = invoicesWithTax.reduce((s, inv) => s + Number(inv.tax_amount || inv.tax || 0), 0);
                const now = new Date();
                const currentMonth = now.getMonth();
                const currentYear = now.getFullYear();
                const nextFilingDate = new Date(currentYear, currentMonth + 1, 15);
                const daysUntilFiling = Math.ceil((nextFilingDate - now) / 86400000);
                const nonRecoverable = fTaxRates.filter((r) => r.is_recoverable === false);
                const pendingReturns = invoicesWithTax.filter((inv) => {
                  const invDate = new Date(inv.issue_date || inv.created_at || inv.date);
                  return invDate.getMonth() < currentMonth || invDate.getFullYear() < currentYear;
                }).length;
                return (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      <div className="bg-white rounded-3xl border border-slate-200 p-5">
                        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Next Filing Due</p>
                        <p className="text-2xl font-bold text-slate-900 mt-1">{nextFilingDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</p>
                        <p className="text-xs text-slate-400 mt-1">{daysUntilFiling > 0 ? `${daysUntilFiling} days remaining` : "Overdue"}</p>
                      </div>
                      <div className="bg-white rounded-3xl border border-slate-200 p-5">
                        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Tax Collected</p>
                        <p className="text-2xl font-bold text-slate-900 mt-1">{formatCurrency(totalTaxCollected, baseCurrency)}</p>
                        <p className="text-xs text-slate-400 mt-1">{invoicesWithTax.length} invoices with tax</p>
                      </div>
                      <div className="bg-white rounded-3xl border border-slate-200 p-5">
                        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Pending Returns</p>
                        <p className="text-2xl font-bold text-slate-900 mt-1">{pendingReturns}</p>
                        <p className="text-xs text-slate-400 mt-1">Prior period returns</p>
                      </div>
                      <div className="bg-white rounded-3xl border border-slate-200 p-5">
                        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Non-Recoverable Rates</p>
                        <p className="text-2xl font-bold text-slate-900 mt-1">{nonRecoverable.length || "—"}</p>
                        <p className="text-xs text-slate-400 mt-1">Exemption categories</p>
                      </div>
                    </div>
                    <div className="bg-white rounded-3xl border border-slate-200 p-6">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-semibold text-slate-900">Tax Filing Summary by Jurisdiction</h3>
                        <ExportMenu
                          onExportCSV={() => {
                            const headers = ["Jurisdiction", "Tax Rate", "Tax Collected", "Invoices", "Status"];
                            const rows = jurisdictionChartData.map((j) => [j.name, `${j.avgRate.toFixed(2)}%`, j.totalCollected || 0, j.count, "Filed"]);
                            downloadCSV(rows, headers, `tax-filing-${new Date().toISOString().slice(0, 10)}.csv`);
                          }}
                          onExportExcel={() => {
                            const headers = ["Jurisdiction", "Tax Rate", "Tax Collected", "Invoices", "Status"];
                            const rows = jurisdictionChartData.map((j) => [j.name, `${j.avgRate.toFixed(2)}%`, j.totalCollected || 0, j.count, "Filed"]);
                            downloadExcel(rows, headers, `tax-filing-${new Date().toISOString().slice(0, 10)}.xlsx`, "Tax Filing");
                          }}
                          filename="tax-filing"
                        />
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-slate-100">
                              <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Jurisdiction</th>
                              <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Tax Rate</th>
                              <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Tax Collected</th>
                              <th scope="col" className="text-center py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Invoices</th>
                              <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Filing Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {jurisdictionChartData.length === 0 ? (
                              <tr><td colSpan={5} className="py-8 text-center text-slate-400 text-sm">No jurisdiction data available</td></tr>
                            ) : jurisdictionChartData.map((j, idx) => (
                              <tr key={idx} className="border-b border-slate-50 hover:bg-slate-50">
                                <td className="py-3 px-3 font-medium text-slate-900">{j.name}</td>
                                <td className="py-3 px-3 text-slate-500">{j.avgRate?.toFixed(2)}%</td>
                                <td className="py-3 px-3 text-right font-medium text-slate-900">{formatCurrency(j.totalCollected || 0, baseCurrency)}</td>
                                <td className="py-3 px-3 text-center text-slate-500">{j.count}</td>
                                <td className="py-3 px-3">
                                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">Current</span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                );
              })()}
            </>
          )}
        </div>
      )}
    </HRPage>
  );
}
