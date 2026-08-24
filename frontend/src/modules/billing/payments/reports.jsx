import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Download, RefreshCw, AlertCircle, TrendingUp, PieChart as PieChartIcon,
  BarChart3, DollarSign,
} from "lucide-react";
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
} from "recharts";
import HRPage from "../../../components/HRPage";
import { paymentApi, refundApi, invoiceApi, creditNoteApi, writeOffApi, dunningApi, collectionApi } from "../../../service/billingService";
import { formatCurrency } from "../../../utils/locale";
import { useCurrency } from "../utils/CurrencyContext";
import { sumInBaseCurrency, convertToBaseCurrency } from "../../../utils/currency-conversion";
import { extractArray } from "../../../utils/billing-helpers";
import { Spinner, ErrorState, EmptyState, DateRangeFilter, useDateRange, ExportMenu } from "../../../components/billing-shared";
import { filterByDateRange, downloadExcel, downloadJSON, downloadCSV } from "../../../utils/export-helpers";

const TABS = [
  { key: "overview", label: "Overview", icon: DollarSign },
  { key: "collection", label: "Collections", icon: TrendingUp },
  { key: "aging", label: "Aging", icon: BarChart3 },
  { key: "outstanding", label: "Outstanding", icon: AlertCircle },
  { key: "credit", label: "Credits, Refunds & Write-offs", icon: PieChartIcon },
  { key: "recovery", label: "Recovery", icon: TrendingUp },
  { key: "cashflow", label: "Cashflow Trends", icon: BarChart3 },
];

export default function PaymentReportsPage() {
  const { baseCurrency } = useCurrency();
  const { range, setRange, customStart, setCustomStart, customEnd, setCustomEnd } = useDateRange();
  const [activeTab, setActiveTab] = useState("overview");
  const [refreshing, setRefreshing] = useState(false);

  const [payments, setPayments] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [refunds, setRefunds] = useState([]);
  const [credits, setCredits] = useState([]);
  const [writeOffs, setWriteOffs] = useState([]);
  const [dunningCases, setDunningCases] = useState([]);
  const [collectionsCases, setCollectionsCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [payData, invData, refData, credData, woData, dunData, colData] = await Promise.all([
        paymentApi.list({ per_page: 200 }).catch(() => ({ items: [] })),
        invoiceApi.list({ per_page: 200 }).catch(() => ({ items: [] })),
        refundApi.list({ per_page: 200 }).catch(() => ({ items: [] })),
        creditNoteApi.list({ per_page: 200 }).catch(() => ({ items: [] })),
        writeOffApi.list({ per_page: 200 }).catch(() => ({ items: [] })),
        dunningApi.listCases({ per_page: 200 }).catch(() => ({ items: [] })),
        collectionApi.listCases({ per_page: 200 }).catch(() => ({ items: [] })),
      ]);
      setPayments(extractArray(payData));
      setInvoices(extractArray(invData));
      setRefunds(extractArray(refData));
      setCredits(extractArray(credData));
      setWriteOffs(extractArray(woData));
      setDunningCases(extractArray(dunData));
      setCollectionsCases(extractArray(colData));
    } catch (err) {
      setError(err.message || "Failed to load report data");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  }, [fetchAll]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const fPayments = useMemo(() => filterByDateRange(payments, "payment_date", range, customStart, customEnd), [payments, range, customStart, customEnd]);
  const fInvoices = useMemo(() => filterByDateRange(invoices, "created_at", range, customStart, customEnd), [invoices, range, customStart, customEnd]);
  const fRefunds = useMemo(() => filterByDateRange(refunds, "refund_date", range, customStart, customEnd), [refunds, range, customStart, customEnd]);
  const fCredits = useMemo(() => filterByDateRange(credits, "created_at", range, customStart, customEnd), [credits, range, customStart, customEnd]);
  const fWriteOffs = useMemo(() => filterByDateRange(writeOffs, "created_at", range, customStart, customEnd), [writeOffs, range, customStart, customEnd]);
  const fDunningCases = useMemo(() => filterByDateRange(dunningCases, "created_at", range, customStart, customEnd), [dunningCases, range, customStart, customEnd]);
  const fCollectionsCases = useMemo(() => filterByDateRange(collectionsCases, "created_at", range, customStart, customEnd), [collectionsCases, range, customStart, customEnd]);

  const completed = fPayments.filter((p) => p.status === "cleared");
  const failed = fPayments.filter((p) => p.status === "failed");
  const pending = fPayments.filter((p) => p.status === "pending");
  const refundedPayments = fPayments.filter((p) => p.status === "refunded");

  const totalCollected = sumInBaseCurrency(completed, baseCurrency).total;
  const totalRefunded = sumInBaseCurrency(fRefunds, baseCurrency).total;
  const totalOutstanding = sumInBaseCurrency(fInvoices, baseCurrency).total;
  const totalCredits = sumInBaseCurrency(fCredits, baseCurrency).total;
  const totalWrittenOff = sumInBaseCurrency(fWriteOffs.filter((w) => w.status === "executed"), baseCurrency).total;
  const netCashflow = totalCollected - totalRefunded;

  const paymentStatusData = [
    { name: "Cleared", value: completed.length, color: "#10b981" },
    { name: "Pending", value: pending.length, color: "#f59e0b" },
    { name: "Failed", value: failed.length, color: "#ef4444" },
    { name: "Refunded", value: refundedPayments.length, color: "#3b82f6" },
  ].filter((d) => d.value > 0);

  const paymentValueByStatus = [
    { name: "Cleared", value: sumInBaseCurrency(completed, baseCurrency).total, color: "#10b981" },
    { name: "Pending", value: sumInBaseCurrency(pending, baseCurrency).total, color: "#f59e0b" },
    { name: "Failed", value: sumInBaseCurrency(failed, baseCurrency).total, color: "#ef4444" },
    { name: "Refunded", value: sumInBaseCurrency(refundedPayments, baseCurrency).total, color: "#3b82f6" },
  ].filter((d) => d.value > 0);

  const monthlyPayments = fPayments.reduce((acc, p) => {
    const date = new Date(p.payment_date || p.created_at);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    if (!acc[key]) acc[key] = { month: key, count: 0, value: 0, refunds: 0, net: 0 };
    acc[key].count += 1;
    if (p.status === "cleared") acc[key].value += convertToBaseCurrency(parseFloat(p.amount || 0), p.currency || baseCurrency, baseCurrency, p.exchange_rate).convertedAmount;
    return acc;
  }, {});
  fRefunds.forEach((r) => {
    const date = new Date(r.refund_date || r.completed_at || r.created_at);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    if (!monthlyPayments[key]) monthlyPayments[key] = { month: key, count: 0, value: 0, refunds: 0, net: 0 };
    monthlyPayments[key].refunds += convertToBaseCurrency(parseFloat(r.amount || 0), r.currency || baseCurrency, baseCurrency, r.exchange_rate).convertedAmount;
  });
  Object.values(monthlyPayments).forEach((m) => { m.net = m.value - m.refunds; });
  const monthlyChartData = Object.values(monthlyPayments).sort((a, b) => a.month.localeCompare(b.month));

  const agingInvoices = fInvoices.filter((inv) => inv.status === "sent" || inv.status === "overdue");
  const agingBuckets = { current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  const now = new Date();
  agingInvoices.forEach((inv) => {
    const dueDate = inv.due_date ? new Date(inv.due_date) : null;
    const convertedAmount = convertToBaseCurrency(parseFloat(inv.total_amount || inv.amount || 0), inv.currency || baseCurrency, baseCurrency, inv.exchange_rate).convertedAmount;
    if (!dueDate) { agingBuckets.current += convertedAmount; return; }
    const diffDays = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) agingBuckets.current += convertedAmount;
    else if (diffDays <= 30) agingBuckets["1-30"] += convertedAmount;
    else if (diffDays <= 60) agingBuckets["31-60"] += convertedAmount;
    else if (diffDays <= 90) agingBuckets["61-90"] += convertedAmount;
    else agingBuckets["90+"] += convertedAmount;
  });
  const agingChartData = [
    { name: "Current", value: agingBuckets.current, color: "#10b981" },
    { name: "1-30 Days", value: agingBuckets["1-30"], color: "#eab308" },
    { name: "31-60 Days", value: agingBuckets["31-60"], color: "#f59e0b" },
    { name: "61-90 Days", value: agingBuckets["61-90"], color: "#f97316" },
    { name: "90+ Days", value: agingBuckets["90+"], color: "#ef4444" },
  ].filter((d) => d.value > 0);

  const colStatuses = ["open", "in_progress", "resolved", "closed", "escalated"];
  const colStatusData = colStatuses.map((s) => ({
    name: s.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
    value: fCollectionsCases.filter((c) => c.status === s).length,
  })).filter((d) => d.value > 0);

  const dunStatuses = ["active", "resolved", "closed"];
  const dunStatusData = dunStatuses.map((s) => ({
    name: s.charAt(0).toUpperCase() + s.slice(1),
    value: fDunningCases.filter((c) => c.status === s).length,
  })).filter((d) => d.value > 0);

  const CREDIT_STATUS_COLORS = { draft: "#6b7280", issued: "#3b82f6", applied: "#10b981", voided: "#ef4444" };
  const creditStatusData = ["draft", "issued", "applied", "voided"].map((s) => ({
    name: s.charAt(0).toUpperCase() + s.slice(1),
    value: fCredits.filter((c) => c.status === s).length,
    color: CREDIT_STATUS_COLORS[s] || "#6b7280",
  })).filter((d) => d.value > 0);

  const recoveryRate = fCollectionsCases.length > 0
    ? Math.round((fCollectionsCases.filter((c) => c.status === "resolved" || c.status === "closed").length / fCollectionsCases.length) * 100)
    : 0;

  const [exportLoading, setExportLoading] = useState(null);
  const handleExcelExport = async () => {
    setExportLoading('excel');
    try {
      const rows = fPayments.map((p) => [p.id, p.payment_date, p.amount, p.status, p.method, p.currency, p.invoice_id]);
      await downloadExcel(rows, ['id','payment_date','amount','status','method','currency','invoice_id'], 'payments-report.xlsx');
    }
    catch (e) { /* Excel export failed */ } finally { setExportLoading(null); }
  };
  const handleAllExport = async (format) => {
    setExportLoading(format);
    try {
      if (format === 'json') await downloadJSON({ payments: fPayments, invoices: fInvoices, refunds: fRefunds, writeOffs: fWriteOffs }, 'payments-data.json');
      else if (format === 'csv') {
        const rows = fPayments.map((p) => [p.id, p.payment_date, p.amount, p.status, p.method]);
        await downloadCSV(rows, ['id','payment_date','amount','status','method'], 'payments.csv');
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

  if (loading) {
    return (
      <HRPage title="Payment Reports" subtitle="Payment analytics and reporting">
        <Spinner />
      </HRPage>
    );
  }

  if (error) {
    return (
      <HRPage title="Payment Reports" subtitle="Error loading data">
        <ErrorState message={error} onRetry={fetchAll} />
      </HRPage>
    );
  }

  return (
    <HRPage title="Payment Reports" subtitle="Comprehensive payment and receivables analytics">
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
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Collected</p>
              <p className="text-2xl font-bold text-emerald-700 mt-1 whitespace-nowrap">{formatCurrency(totalCollected, baseCurrency)}</p>
              <p className="text-xs text-slate-500 mt-1">{completed.length} completed payments</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Refunded</p>
              <p className="text-2xl font-bold text-red-600 mt-1 whitespace-nowrap">{formatCurrency(totalRefunded, baseCurrency)}</p>
              <p className="text-xs text-slate-500 mt-1">{fRefunds.length} refunds</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Net Cash Flow</p>
              <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(netCashflow, baseCurrency)}</p>
              <p className="text-xs text-slate-500 mt-1">Collected minus refunds</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Outstanding</p>
              <p className="text-2xl font-bold text-amber-600 mt-1 whitespace-nowrap">{formatCurrency(totalOutstanding, baseCurrency)}</p>
              <p className="text-xs text-slate-500 mt-1">{fInvoices.length} invoices</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-3xl border border-slate-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-slate-900">Payment Status Distribution</h3>
                <button onClick={() => downloadJSON(paymentStatusData, "payment-status-distribution.json")}
                  className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-600" aria-label="Export payment status distribution" title="Export"><Download size={15} /></button>
              </div>
              {paymentStatusData.length === 0 ? <EmptyState icon={PieChartIcon} title="No payment data" /> : (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie data={paymentStatusData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value"
                      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                      {paymentStatusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Pie>
                    <Tooltip formatter={(v) => [v, "Count"]} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-slate-900">Payment Value by Status</h3>
                <button onClick={() => downloadJSON(paymentValueByStatus, "payment-value-by-status.json")}
                  className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-600" aria-label="Export payment value by status" title="Export"><Download size={15} /></button>
              </div>
              {paymentValueByStatus.length === 0 ? <EmptyState icon={BarChart3} title="No value data" /> : (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={paymentValueByStatus}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v, baseCurrency)} />
                    <Tooltip formatter={(v) => [formatCurrency(v, baseCurrency)]} />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                      {paymentValueByStatus.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {monthlyChartData.length > 0 && (
            <div className="bg-white rounded-3xl border border-slate-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-slate-900">Monthly Cash Flow</h3>
                <button onClick={() => downloadCSV(monthlyChartData.map((d) => [d.month, d.value.toFixed(2), d.refunds.toFixed(2), d.net.toFixed(2)]), ["Month", "Collected", "Refunds", "Net"], "monthly-cashflow.csv")}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200"><Download className="h-3.5 w-3.5" /> CSV</button>
              </div>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={monthlyChartData}>
                  <defs>
                    <linearGradient id="colorCollected" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10b981" stopOpacity={0.3} /><stop offset="95%" stopColor="#10b981" stopOpacity={0} /></linearGradient>
                    <linearGradient id="colorNet" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--color-accent-payments)" stopOpacity={0.3} /><stop offset="95%" stopColor="var(--color-accent-payments)" stopOpacity={0} /></linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v, baseCurrency)} />
                  <Tooltip formatter={(v) => [formatCurrency(v, baseCurrency)]} />
                  <Area type="monotone" dataKey="value" stroke="#10b981" fill="url(#colorCollected)" strokeWidth={2} name="Collected" />
                  <Area type="monotone" dataKey="net" stroke="var(--color-accent-payments)" fill="url(#colorNet)" strokeWidth={2} name="Net" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}

      {activeTab === "collection" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Cases</p>
              <p className="text-2xl font-bold text-slate-900 mt-1">{fCollectionsCases.length}</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Active Cases</p>
              <p className="text-2xl font-bold text-amber-600 mt-1">{fCollectionsCases.filter((c) => c.status === "open" || c.status === "in_progress").length}</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Escalated</p>
              <p className="text-2xl font-bold text-red-600 mt-1">{fCollectionsCases.filter((c) => c.status === "escalated").length}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-3xl border border-slate-200 p-6">
              <h3 className="text-sm font-semibold text-slate-900 mb-4">Collections Case Status</h3>
              {colStatusData.length === 0 ? <EmptyState icon={BarChart3} title="No case data" /> : (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={colStatusData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="value" fill="var(--color-accent-payments)" radius={[4, 4, 0, 0]} name="Cases" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-6">
              <h3 className="text-sm font-semibold text-slate-900 mb-4">Dunning Case Status</h3>
              {dunStatusData.length === 0 ? <EmptyState icon={BarChart3} title="No dunning data" /> : (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={dunStatusData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="value" fill="#f59e0b" radius={[4, 4, 0, 0]} name="Cases" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === "aging" && (
        <div className="space-y-6">
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-900">Aging Distribution</h3>
              <button onClick={() => downloadJSON(agingChartData, "aging-distribution.json")}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-600" aria-label="Export aging distribution" title="Export"><Download size={15} /></button>
            </div>
            {agingChartData.length === 0 ? <EmptyState icon={PieChartIcon} title="No aging data" /> : (
              <ResponsiveContainer width="100%" height={320}>
                <PieChart>
                  <Pie data={agingChartData} cx="50%" cy="50%" innerRadius={60} outerRadius={110} paddingAngle={3} dataKey="value"
                    label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                    {agingChartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                  </Pie>
                  <Tooltip formatter={(v) => [formatCurrency(v, baseCurrency)]} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {agingChartData.map((a) => (
              <div key={a.name} className="bg-white rounded-3xl border border-slate-200 p-4 text-center">
                <div className="w-3 h-3 rounded-full mx-auto mb-1.5" style={{ backgroundColor: a.color }} />
                <p className="text-lg font-bold text-slate-900">{formatCurrency(a.value, baseCurrency)}</p>
                <p className="text-xs text-slate-500">{a.name}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTab === "outstanding" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Outstanding</p>
              <p className="text-2xl font-bold text-amber-600 mt-1 whitespace-nowrap">{formatCurrency(totalOutstanding, baseCurrency)}</p>
              <p className="text-xs text-slate-500 mt-1">{fInvoices.length} invoices</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Available Credits</p>
              <p className="text-2xl font-bold text-blue-600 mt-1 whitespace-nowrap">{formatCurrency(totalCredits, baseCurrency)}</p>
              <p className="text-xs text-slate-500 mt-1">{fCredits.filter((c) => c.status === "issued").length} issued</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Net Receivable</p>
              <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(Math.max(0, totalOutstanding - totalCredits), baseCurrency)}</p>
              <p className="text-xs text-slate-500 mt-1">Outstanding minus credits</p>
            </div>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="text-sm font-semibold text-slate-900 mb-4">Outstanding Over Time</h3>
            {monthlyChartData.length === 0 ? <EmptyState icon={BarChart3} title="No trend data" /> : (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={monthlyChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v, baseCurrency)} />
                  <Tooltip formatter={(v) => [formatCurrency(v, baseCurrency)]} />
                  <Bar dataKey="value" fill="#f59e0b" radius={[4, 4, 0, 0]} name="Collected" />
                  <Bar dataKey="refunds" fill="#ef4444" radius={[4, 4, 0, 0]} name="Refunds" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}

      {activeTab === "credit" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Credits</p>
              <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{fCredits.length}</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Credit Value</p>
              <p className="text-2xl font-bold text-blue-600 mt-1 whitespace-nowrap">{formatCurrency(sumInBaseCurrency(fCredits, baseCurrency).total, baseCurrency)}</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Refunds</p>
              <p className="text-2xl font-bold text-red-600 mt-1 whitespace-nowrap">{fRefunds.length}</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Refund Value</p>
              <p className="text-2xl font-bold text-red-600 mt-1 whitespace-nowrap">{formatCurrency(totalRefunded, baseCurrency)}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Write-offs</p>
              <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{fWriteOffs.length}</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Written-off Value</p>
              <p className="text-2xl font-bold text-amber-600 mt-1 whitespace-nowrap">{formatCurrency(totalWrittenOff, baseCurrency)}</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Pending Approval</p>
              <p className="text-2xl font-bold text-amber-600 mt-1 whitespace-nowrap">{fWriteOffs.filter((w) => w.status === "pending_approval").length}</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Reversed</p>
              <p className="text-2xl font-bold text-orange-600 mt-1 whitespace-nowrap">{fWriteOffs.filter((w) => w.status === "reversed").length}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-3xl border border-slate-200 p-6">
              <h3 className="text-sm font-semibold text-slate-900 mb-4">Credit Status</h3>
              {creditStatusData.length === 0 ? <EmptyState icon={PieChartIcon} title="No credit data" /> : (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie data={creditStatusData} cx="50%" cy="50%" outerRadius={90} paddingAngle={3} dataKey="value"
                      label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}>
                      {creditStatusData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Pie>
                    <Tooltip formatter={(v) => [v, "Count"]} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-slate-900">Refund Summary</h3>
                <a href="/billing/refunds/dashboard" className="text-xs text-brand-600 hover:underline">Full Refund Dashboard →</a>
              </div>
              <div className="space-y-4">
                {[
                  { label: "Completed", value: fRefunds.filter((r) => r.status === "completed").length, total: fRefunds.length, color: "bg-emerald-400" },
                  { label: "In Flight (Draft/Approval/Processing)", value: fRefunds.filter((r) => ["draft", "pending_approval", "approved", "processing", "pending"].includes(r.status)).length, total: fRefunds.length, color: "bg-amber-400" },
                  { label: "Failed / Rejected / Cancelled", value: fRefunds.filter((r) => ["failed", "rejected", "cancelled"].includes(r.status)).length, total: fRefunds.length, color: "bg-red-400" },
                ].map((m) => (
                  <div key={m.label}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-slate-600">{m.label}</span>
                      <span className="font-semibold text-slate-900">{m.value}</span>
                    </div>
                    <div className="w-full bg-slate-100 rounded-full h-2">
                      <div className={`rounded-full h-2 transition-all ${m.color}`} style={{ width: `${m.total > 0 ? (m.value / m.total) * 100 : 0}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-900">Write-off Summary</h3>
              <a href="/billing/write-offs/dashboard" className="text-xs text-brand-600 hover:underline">Full Write-off Dashboard →</a>
            </div>
            <div className="space-y-4">
              {[
                { label: "Executed", value: fWriteOffs.filter((w) => w.status === "executed").length, total: fWriteOffs.length, color: "bg-emerald-400" },
                { label: "In Flight (Draft/Approval)", value: fWriteOffs.filter((w) => ["draft", "pending_approval", "approved"].includes(w.status)).length, total: fWriteOffs.length, color: "bg-amber-400" },
                { label: "Reversed / Cancelled", value: fWriteOffs.filter((w) => ["reversed", "cancelled"].includes(w.status)).length, total: fWriteOffs.length, color: "bg-orange-400" },
              ].map((m) => (
                <div key={m.label}>
                  <div className="flex items-center justify-between text-sm mb-1">
                    <span className="text-slate-600">{m.label}</span>
                    <span className="font-semibold text-slate-900">{m.value}</span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-2">
                    <div className={`rounded-full h-2 transition-all ${m.color}`} style={{ width: `${m.total > 0 ? (m.value / m.total) * 100 : 0}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === "recovery" && (
        <div className="space-y-6">
          <div className="flex items-center justify-end">
            <a href="/billing/collections/dashboard" className="text-xs text-brand-600 hover:underline">
              Full Collections Dashboard (dunning performance, effectiveness, promise-to-pay success rate) →
            </a>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Recovery Rate</p>
              <p className="text-2xl font-bold text-emerald-700 mt-1">{recoveryRate}%</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Resolved Cases</p>
              <p className="text-2xl font-bold text-slate-900 mt-1">{fCollectionsCases.filter((c) => c.status === "resolved" || c.status === "closed").length}</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Active Dunning</p>
              <p className="text-2xl font-bold text-amber-600 mt-1">{fDunningCases.filter((c) => c.status === "active").length}</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Resolved Dunning</p>
              <p className="text-2xl font-bold text-emerald-700 mt-1">{fDunningCases.filter((c) => c.status === "resolved").length}</p>
            </div>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white rounded-3xl border border-slate-200 p-6">
              <h3 className="text-sm font-semibold text-slate-900 mb-2">Case Resolution Overview</h3>
              <p className="text-xs text-slate-500 mb-4">Collections and dunning case resolution metrics</p>
              <div className="space-y-4">
                {[
                  { label: "Collection Resolved", pct: fCollectionsCases.length > 0 ? (fCollectionsCases.filter((c) => c.status === "resolved").length / fCollectionsCases.length) * 100 : 0, color: "bg-emerald-400" },
                  { label: "Collection Open", pct: fCollectionsCases.length > 0 ? (fCollectionsCases.filter((c) => c.status === "open" || c.status === "in_progress").length / fCollectionsCases.length) * 100 : 0, color: "bg-amber-400" },
                  { label: "Dunning Resolved", pct: fDunningCases.length > 0 ? (fDunningCases.filter((c) => c.status === "resolved").length / fDunningCases.length) * 100 : 0, color: "bg-emerald-400" },
                  { label: "Dunning Active", pct: fDunningCases.length > 0 ? (fDunningCases.filter((c) => c.status === "active").length / fDunningCases.length) * 100 : 0, color: "bg-blue-400" },
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
            <div className="bg-white rounded-3xl border border-slate-200 p-6">
              <h3 className="text-sm font-semibold text-slate-900 mb-4">Dunning Level Distribution</h3>
              {fDunningCases.length === 0 ? <EmptyState icon={BarChart3} title="No dunning data" /> : (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={[1, 2, 3, 4, 5].map((l) => ({
                    level: `Level ${l}`,
                    count: fDunningCases.filter((c) => c.current_level === l).length,
                  })).filter((d) => d.count > 0)}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="level" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#f59e0b" radius={[4, 4, 0, 0]} name="Cases" />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === "cashflow" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Collected</p>
              <p className="text-2xl font-bold text-emerald-700 mt-1 whitespace-nowrap">{formatCurrency(totalCollected, baseCurrency)}</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Refunded</p>
              <p className="text-2xl font-bold text-red-600 mt-1 whitespace-nowrap">{formatCurrency(totalRefunded, baseCurrency)}</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Net Cash Flow</p>
              <p className="text-2xl font-bold text-brand-600 mt-1 whitespace-nowrap">{formatCurrency(netCashflow, baseCurrency)}</p>
            </div>
            <div className="bg-white rounded-3xl border border-slate-200 p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Payment Count</p>
              <p className="text-2xl font-bold text-slate-900 mt-1">{fPayments.length}</p>
            </div>
          </div>
          {monthlyChartData.length > 0 && (
            <div className="bg-white rounded-3xl border border-slate-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-slate-900">Monthly Trend</h3>
                <button onClick={() => downloadCSV(monthlyChartData.map((d) => [d.month, d.count, d.value.toFixed(2)]), ["Month", "Count", "Value"], "monthly-payments.csv")}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200"><Download className="h-3.5 w-3.5" /> CSV</button>
              </div>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={monthlyChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11 }} tickFormatter={(v) => formatCurrency(v, baseCurrency)} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v, name) => [name === "count" ? v : formatCurrency(v, baseCurrency)]} />
                  <Line yAxisId="left" type="monotone" dataKey="value" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} name="Collected" />
                  <Line yAxisId="right" type="monotone" dataKey="count" stroke="var(--color-accent-payments)" strokeWidth={2} dot={{ r: 3 }} name="Count" />
                  <Line yAxisId="left" type="monotone" dataKey="net" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} name="Net" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="text-sm font-semibold text-slate-900 mb-4">Payment Summary</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th scope="col" className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Month</th>
                    <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Payments</th>
                    <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Collected</th>
                    <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Refunds</th>
                    <th scope="col" className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase tracking-wider">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyChartData.slice(-12).reverse().map((m) => (
                    <tr key={m.month} className="border-b border-slate-50 hover:bg-slate-50">
                      <td className="py-3 px-3 font-medium text-slate-900">{m.month}</td>
                      <td className="py-3 px-3 text-right text-slate-600">{m.count}</td>
                      <td className="py-3 px-3 text-right font-medium text-emerald-700">{formatCurrency(m.value, baseCurrency)}</td>
                      <td className="py-3 px-3 text-right font-medium text-red-600">{formatCurrency(m.refunds, baseCurrency)}</td>
                      <td className="py-3 px-3 text-right font-semibold text-slate-900">{formatCurrency(m.net, baseCurrency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </HRPage>
  );
}
