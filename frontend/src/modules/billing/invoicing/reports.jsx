import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Download, RefreshCw, AlertCircle, TrendingUp, PieChart as PieChartIcon,
  BarChart3, Receipt, Clock, CheckCircle,
} from "lucide-react";
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, LineChart, Line, AreaChart, Area,
} from "recharts";
import HRPage from "../../../components/HRPage";
import { invoiceApi, creditNoteApi } from "../../../service/billingService";
import { formatCurrency } from "../../../utils/locale";
import { extractArray } from "../../../utils/billing-helpers";
import { Spinner, ErrorState, EmptyState, DateRangeFilter, useDateRange, ExportMenu } from "../../../components/billing-shared";
import { filterByDateRange, downloadExcel, downloadJSON, downloadCSV } from "../../../utils/export-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { useTerminology } from "../utils/TerminologyContext";
import { sumInBaseCurrency, convertToBaseCurrency } from "../../../utils/currency-conversion";

const TABS = [
  { key: "overview", label: "Overview", icon: Receipt },
  { key: "status", label: "Status Analysis", icon: PieChartIcon },
  { key: "aging", label: "Aging Analysis", icon: Clock },
  { key: "trends", label: "Trends", icon: BarChart3 },
];

export default function InvoiceReportsPage() {
  const { singular } = useTerminology();
  const navigate = useNavigate();
  const { baseCurrency, currencySymbol } = useCurrency();
  const { range, setRange, customStart, setCustomStart, customEnd, setCustomEnd } = useDateRange();
  const [activeTab, setActiveTab] = useState("overview");
  const [refreshing, setRefreshing] = useState(false);

  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [creditNotes, setCreditNotes] = useState([]);
  const [loadingCN, setLoadingCN] = useState(false);

  const [dashboardStats, setDashboardStats] = useState(null);
  const [loadingDS, setLoadingDS] = useState(false);

  const fetchInvoices = useCallback(async () => {
    try { setLoading(true); setError(null); const data = await invoiceApi.list({ per_page: 100 }); setInvoices(extractArray(data)); }
    catch (err) { setError(err.message || "Failed to load invoices"); }
    finally { setLoading(false); }
  }, []);

  const fetchCreditNotes = useCallback(async () => {
    try { setLoadingCN(true); const data = await creditNoteApi.list({ per_page: 100 }); setCreditNotes(extractArray(data)); }
    catch (e) { /* silent */ }
    finally { setLoadingCN(false); }
  }, []);

  const fetchDashboardStats = useCallback(async () => {
    try { setLoadingDS(true); const data = await invoiceApi.getDashboardStats(); setDashboardStats(data); }
    catch (e) { /* silent */ }
    finally { setLoadingDS(false); }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await Promise.allSettled([fetchInvoices(), fetchCreditNotes(), fetchDashboardStats()]);
    setRefreshing(false);
  }, [fetchInvoices, fetchCreditNotes, fetchDashboardStats]);

  useEffect(() => { fetchInvoices(); fetchCreditNotes(); fetchDashboardStats(); }, [fetchInvoices, fetchCreditNotes, fetchDashboardStats]);

  const fInvoices = useMemo(() => filterByDateRange(invoices, "created_at", range, customStart, customEnd), [invoices, range, customStart, customEnd]);
  const fCreditNotes = useMemo(() => filterByDateRange(creditNotes, "created_at", range, customStart, customEnd), [creditNotes, range, customStart, customEnd]);

  const totalAmount = sumInBaseCurrency(fInvoices, baseCurrency).total;
  const totalPaid = sumInBaseCurrency(fInvoices.filter((inv) => inv.status === "paid"), baseCurrency).total;
  const totalOutstanding = sumInBaseCurrency(
    fInvoices.filter((inv) => inv.status === "sent" || inv.status === "overdue" || inv.status === "partially_paid")
      .map(inv => ({ ...inv, amount: inv.balance_due || inv.total_amount || inv.total })),
    baseCurrency
  ).total;
  const totalCN = sumInBaseCurrency(fCreditNotes, baseCurrency).total;

  const statusData = [
    { name: "Paid", value: fInvoices.filter((i) => i.status === "paid").length, color: "#10b981" },
    { name: "Sent", value: fInvoices.filter((i) => i.status === "sent").length, color: "#3b82f6" },
    { name: "Overdue", value: fInvoices.filter((i) => i.status === "overdue").length, color: "#ef4444" },
    { name: "Draft", value: fInvoices.filter((i) => i.status === "draft").length, color: "#6b7280" },
    { name: "Partially Paid", value: fInvoices.filter((i) => i.status === "partially_paid").length, color: "#f59e0b" },
    { name: "Cancelled", value: fInvoices.filter((i) => i.status === "cancelled").length, color: "#ec4898" },
    { name: "Refunded", value: fInvoices.filter((i) => i.status === "refunded").length, color: "#d946ef" },
    { name: "Written Off", value: fInvoices.filter((i) => i.status === "written_off").length, color: "#9ca3af" },
  ].filter((d) => d.value > 0);

  const cnStatusData = [
    { name: "Draft", value: fCreditNotes.filter((cn) => cn.status === "draft").length, color: "#6b7280" },
    { name: "Approved", value: fCreditNotes.filter((cn) => cn.status === "approved").length, color: "#6366f1" },
    { name: "Issued", value: fCreditNotes.filter((cn) => cn.status === "issued").length, color: "#3b82f6" },
    { name: "Partially Applied", value: fCreditNotes.filter((cn) => cn.status === "partially_applied").length, color: "#f59e0b" },
    { name: "Fully Applied", value: fCreditNotes.filter((cn) => cn.status === "fully_applied").length, color: "#10b981" },
    { name: "Voided", value: fCreditNotes.filter((cn) => cn.status === "voided").length, color: "#ef4444" },
  ].filter((d) => d.value > 0);

  const overdueInvoices = fInvoices.filter((i) => i.status === "overdue");
  const agingBuckets = [
    { name: "1–30 days", value: sumInBaseCurrency(overdueInvoices.filter((i) => { const d = (new Date() - new Date(i.due_date)) / (1000 * 60 * 60 * 24); return d >= 1 && d <= 30; }).map(i => ({ amount: i.balance_due || i.total_amount || i.total, currency: i.currency, exchange_rate: i.exchange_rate })), baseCurrency).total, color: "#f59e0b" },
    { name: "31–60 days", value: sumInBaseCurrency(overdueInvoices.filter((i) => { const d = (new Date() - new Date(i.due_date)) / (1000 * 60 * 60 * 24); return d >= 31 && d <= 60; }).map(i => ({ amount: i.balance_due || i.total_amount || i.total, currency: i.currency, exchange_rate: i.exchange_rate })), baseCurrency).total, color: "#ef4444" },
    { name: "61–90 days", value: sumInBaseCurrency(overdueInvoices.filter((i) => { const d = (new Date() - new Date(i.due_date)) / (1000 * 60 * 60 * 24); return d >= 61 && d <= 90; }).map(i => ({ amount: i.balance_due || i.total_amount || i.total, currency: i.currency, exchange_rate: i.exchange_rate })), baseCurrency).total, color: "#dc2626" },
    { name: "90+ days", value: sumInBaseCurrency(overdueInvoices.filter((i) => { const d = (new Date() - new Date(i.due_date)) / (1000 * 60 * 60 * 24); return d > 90; }).map(i => ({ amount: i.balance_due || i.total_amount || i.total, currency: i.currency, exchange_rate: i.exchange_rate })), baseCurrency).total, color: "#991b1b" },
  ];

  const monthlyData = fInvoices.reduce((acc, inv) => {
    const date = new Date(inv.issue_date || inv.created_at);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    if (!acc[key]) acc[key] = { month: key, total: 0, paid: 0, count: 0 };
    acc[key].total += convertToBaseCurrency(
      parseFloat(inv.total_amount || inv.total || inv.amount || 0),
      inv.currency || baseCurrency,
      baseCurrency,
      inv.exchange_rate
    ).convertedAmount;
    if (inv.status === "paid") acc[key].paid += convertToBaseCurrency(
      parseFloat(inv.total_amount || inv.total || inv.amount || 0),
      inv.currency || baseCurrency,
      baseCurrency,
      inv.exchange_rate
    ).convertedAmount;
    acc[key].count += 1;
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
      const rows = fInvoices.map((inv) => [inv.id, inv.invoice_number, inv.customer_name, inv.total, inv.status, inv.due_date, inv.created_at]);
      await downloadExcel(rows, ['id','invoice_number','customer_name','total','status','due_date','created_at'], 'invoices-report.xlsx');
    }
    catch (e) { /* Excel export failed */ } finally { setExportLoading(null); }
  };
  const handleAllExport = async (format) => {
    setExportLoading(format);
    try {
      if (format === 'json') await downloadJSON({ invoices: fInvoices, creditNotes: fCreditNotes }, 'invoices-data.json');
      else if (format === 'csv') {
        const rows = fInvoices.map((inv) => [inv.id, inv.invoice_number, inv.total, inv.status]);
        await downloadCSV(rows, ['id','invoice_number','total','status'], 'invoices.csv');
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
    <HRPage title="Invoice Reports" subtitle="Invoice analytics and reporting">
      <div className="rounded-3xl bg-white border border-slate-200 p-4 md:p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)] mb-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          {renderTabNav()}
          <div className="flex flex-wrap items-center gap-2">
            <DateRangeFilter {...dateRangeProps} />
            <ExportMenu
              onExportCSV={() => handleAllExport("csv")}
              onExportJSON={() => handleAllExport("json")}
              onExportExcel={() => handleAllExport("excel")}
            />
            <button onClick={() => navigate("/billing/invoices")}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-brand-700 bg-brand-50 rounded-lg hover:bg-brand-100 transition-colors">
              <Receipt className="h-4 w-4" /> Invoice List
            </button>
            <button onClick={refreshAll} disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-50 transition-colors"
              aria-label="Refresh reports">
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
            </button>
          </div>
        </div>
      </div>

      {activeTab === "overview" && (
        <div className="space-y-6">
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchInvoices} /> : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Invoices</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{fInvoices.length}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Amount</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(totalAmount, baseCurrency)}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Outstanding</p>
                  <p className="text-2xl font-bold text-amber-600 mt-1 whitespace-nowrap">{formatCurrency(totalOutstanding, baseCurrency)}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Credit Notes</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(totalCN, baseCurrency)}</p>
                  <p className="text-xs text-slate-400 mt-1">{fCreditNotes.length} notes</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Invoice Status Distribution</h3>
                    <button onClick={() => downloadJSON(statusData, "invoice-status-distribution.json")}
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" title="Export"><Download size={15} /></button>
                  </div>
                  {statusData.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Receipt className="h-10 w-10 text-slate-300 mb-3" />
                      <p className="text-slate-800 text-base font-bold mb-1">No invoices found</p>
                      <p className="text-slate-500 text-xs font-normal max-w-xs leading-relaxed mb-4">There are no invoices for the selected period.</p>
                      <button onClick={() => navigate("/billing/invoices/create")} className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#FF7A00] hover:bg-[#FF5500] text-white text-xs font-semibold rounded-xl transition-colors shadow-xs">
                        Create Invoice
                      </button>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie
                          data={statusData}
                          cx="50%"
                          cy="45%"
                          innerRadius={55}
                          outerRadius={85}
                          paddingAngle={4}
                          dataKey="value"
                          label={({ percent }) => (percent >= 0.05 ? `${(percent * 100).toFixed(0)}%` : "")}
                        >
                          {statusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Pie>
                        <Tooltip formatter={(v, name) => [v, `Invoices (${name})`]} />
                        <Legend verticalAlign="bottom" height={36} formatter={(value) => <span className="text-xs text-slate-600 font-medium">{value}</span>} />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Credit Note Status</h3>
                    <button onClick={() => downloadJSON(cnStatusData, "credit-note-status-distribution.json")}
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" title="Export"><Download size={15} /></button>
                  </div>
                  {cnStatusData.length === 0 ? <EmptyState icon={Receipt} title="No credit note data" /> : (
                    <ResponsiveContainer width="100%" height={300}>
                      <PieChart>
                        <Pie data={cnStatusData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value"
                          label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                          {cnStatusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                        </Pie>
                        <Tooltip formatter={(v) => [v, "Count"]} />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              {monthlyChartData.length > 0 && (
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">Monthly Invoice Amount</h3>
                    <button onClick={() => downloadCSV(monthlyChartData.map((d) => [d.month, d.total, d.paid, d.count]), ["Month", "Total", "Paid", "Count"], "monthly-invoice-data.csv")}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200"><Download className="h-3.5 w-3.5" /> CSV</button>
                  </div>
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={monthlyChartData}>
                      <defs>
                        <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#FF7A00" stopOpacity={0.3} /><stop offset="95%" stopColor="#FF7A00" stopOpacity={0} /></linearGradient>
                        <linearGradient id="colorPaid" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10b981" stopOpacity={0.3} /><stop offset="95%" stopColor="#10b981" stopOpacity={0} /></linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${currencySymbol}${Number(v).toLocaleString()}`} />
                      <Tooltip formatter={(v) => [formatCurrency(v, baseCurrency)]} />
                      <Area type="monotone" dataKey="total" stroke="#FF7A00" fill="url(#colorTotal)" strokeWidth={2} name="Total" />
                      <Area type="monotone" dataKey="paid" stroke="#10b981" fill="url(#colorPaid)" strokeWidth={2} name="Paid" />
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
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchInvoices} /> : fInvoices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-8">
              <Receipt className="h-10 w-10 text-slate-300 mb-3" />
              <p className="text-slate-800 text-base font-bold mb-1">No invoices found</p>
              <p className="text-slate-500 text-xs font-normal max-w-xs leading-relaxed mb-4">There are no invoices for the selected period.</p>
              <button onClick={() => navigate("/billing/invoices/create")} className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#FF7A00] hover:bg-[#FF5500] text-white text-xs font-semibold rounded-xl transition-colors shadow-xs">
                Create Invoice
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                {statusData.map((s) => (
                  <button key={s.name} onClick={() => navigate(`/billing/invoices?status=${s.name.toLowerCase().replace(/\s+/g, "_")}`)}
                    className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-4 text-center transition-colors hover:border-brand-200 hover:bg-brand-50/40">
                    <div className="w-3 h-3 rounded-full mx-auto mb-1.5" style={{ backgroundColor: s.color }} />
                    <p className="text-lg font-bold text-slate-900">{s.value}</p>
                    <p className="text-xs text-slate-500">{s.name}</p>
                  </button>
                ))}
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-slate-900">Invoices by Status</h3>
                  <button onClick={() => downloadJSON(statusData, "invoices-by-status.json")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200"><Download className="h-3.5 w-3.5" /> Export</button>
                </div>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={statusData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {statusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                <h3 className="text-sm font-semibold text-slate-900 mb-4">Invoice List by Status</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Invoice</th>
                        <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Status</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Amount</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Balance</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Due Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fInvoices.slice(0, 20).map((inv) => (
                        <tr key={inv.id} onClick={() => navigate(`/billing/invoices/${inv.id}`)} className="cursor-pointer border-b border-slate-50 hover:bg-brand-50/50">
                          <td className="py-3 px-3 font-medium text-slate-900">{inv.invoice_number || `#${inv.id}`}</td>
                          <td className="py-3 px-3">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                              inv.status === "paid" ? "bg-emerald-100 text-emerald-700" :
                              inv.status === "overdue" ? "bg-red-100 text-red-700" :
                              inv.status === "sent" ? "bg-blue-100 text-blue-700" :
                              inv.status === "draft" ? "bg-slate-100 text-slate-600" :
                              inv.status === "partially_paid" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"
                            }`}>
                              {inv.status === "paid" ? <CheckCircle size={10} /> : inv.status === "overdue" ? <AlertCircle size={10} /> : <Clock size={10} />}
                              {inv.status?.replace(/_/g, " ")}
                            </span>
                          </td>
                          <td className="py-3 px-3 text-right font-medium text-slate-900">{formatCurrency(inv.total_amount || inv.total, inv.currency)}</td>
                          <td className="py-3 px-3 text-right text-slate-600">{formatCurrency(inv.balance_due || 0, inv.currency)}</td>
                          <td className="py-3 px-3 text-right text-slate-500 whitespace-nowrap">{inv.due_date ? new Date(inv.due_date).toLocaleDateString() : "—"}</td>
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

      {activeTab === "aging" && (
        <div className="space-y-6">
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchInvoices} /> : overdueInvoices.length === 0 ? (
            <EmptyState icon={Clock} title="No overdue invoices" message="No outstanding invoices to show in aging report." />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {agingBuckets.map((b) => (
                  <div key={b.name} className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">{b.name}</p>
                    <p className="text-2xl font-bold mt-1" style={{ color: b.color }}>{formatCurrency(b.value, baseCurrency)}</p>
                    <p className="text-xs text-slate-400 mt-1">{overdueInvoices.filter((i) => { const d = (new Date() - new Date(i.due_date)) / (1000 * 60 * 60 * 24); return d >= agingBuckets.indexOf(b) * 30 + 1 && d <= (agingBuckets.indexOf(b) + 1) * 30; }).length} invoices</p>
                  </div>
                ))}
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-slate-900">Aging Analysis</h3>
                  <button onClick={() => downloadCSV(agingBuckets.map((b) => [b.name, b.value, b.color]), ["Bucket", "Amount", "Color"], "aging-analysis.csv")}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200"><Download className="h-3.5 w-3.5" /> CSV</button>
                </div>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={agingBuckets}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${currencySymbol}${Number(v).toLocaleString()}`} />
                    <Tooltip formatter={(v) => [formatCurrency(v, baseCurrency)]} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {agingBuckets.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                <h3 className="text-sm font-semibold text-slate-900 mb-4">Overdue Invoices</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100">
                        <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Invoice</th>
                        <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">{singular}</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Amount</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Due Date</th>
                        <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Days Overdue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overdueInvoices.sort((a, b) => new Date(a.due_date) - new Date(b.due_date)).slice(0, 20).map((inv) => {
                        const daysOverdue = Math.floor((new Date() - new Date(inv.due_date)) / (1000 * 60 * 60 * 24));
                        return (
                          <tr key={inv.id} onClick={() => navigate(`/billing/invoices/${inv.id}`)} className="cursor-pointer border-b border-slate-50 hover:bg-brand-50/50">
                            <td className="py-3 px-3 font-medium text-slate-900">{inv.invoice_number || `#${inv.id}`}</td>
                            <td className="py-3 px-3 text-slate-600">{inv.customer_name || `#${inv.customer_id}`}</td>
                            <td className="py-3 px-3 text-right font-medium text-slate-900">{formatCurrency(inv.balance_due || inv.total_amount || inv.total, inv.currency)}</td>
                            <td className="py-3 px-3 text-right text-slate-500 whitespace-nowrap">{new Date(inv.due_date).toLocaleDateString()}</td>
                            <td className="py-3 px-3 text-right"><span className={`font-medium ${daysOverdue > 90 ? "text-red-700" : daysOverdue > 60 ? "text-red-600" : daysOverdue > 30 ? "text-amber-600" : "text-amber-500"}`}>{daysOverdue}d</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "trends" && (
        <div className="space-y-6">
          {loading ? <Spinner /> : error ? <ErrorState message={error} onRetry={fetchInvoices} /> : monthlyChartData.length === 0 ? (
            <EmptyState icon={TrendingUp} title="No trend data" message="Monthly invoice trends will appear here." />
          ) : (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Months Tracked</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1">{monthlyChartData.length}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Avg Monthly</p>
                  <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(totalAmount / Math.max(monthlyChartData.length, 1), baseCurrency)}</p>
                </div>
                <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Collection Rate</p>
                  <p className="text-2xl font-bold text-emerald-600 mt-1">{totalAmount ? `${((totalPaid / totalAmount) * 100).toFixed(1)}%` : "—"}</p>
                </div>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-slate-900">Monthly Trends</h3>
                  <div className="flex items-center gap-2">
                    <button onClick={() => downloadJSON(monthlyChartData, "monthly-trends.json")}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200"><Download className="h-3.5 w-3.5" /> Export</button>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={350}>
                  <BarChart data={monthlyChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${currencySymbol}${Number(v).toLocaleString()}`} />
                    <Tooltip formatter={(v) => [formatCurrency(v, baseCurrency)]} />
                    <Legend />
                    <Bar dataKey="total" fill="#FF7A00" radius={[4, 4, 0, 0]} name="Total" />
                    <Bar dataKey="paid" fill="#10b981" radius={[4, 4, 0, 0]} name="Paid" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
                <h3 className="text-sm font-semibold text-slate-900 mb-4">Monthly Invoice Count</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <LineChart data={monthlyChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Line type="monotone" dataKey="count" stroke="#FF7A00" strokeWidth={2} dot={{ r: 3 }} name="Invoice Count" />
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
