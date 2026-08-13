import { useState, useEffect, useCallback } from "react";
import {
  Search, Filter, X, RefreshCw, Download, ChevronDown, FileText, DollarSign, CreditCard,
  AlertCircle, CheckCircle, Clock
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { invoiceApi, paymentApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate } from "../../../utils/billing-helpers";
import { Pagination } from "../../../components/billing-shared";

const ITEMS_PER_PAGE = 10;

const INVOICE_STATUS_OPTIONS = [
  { value: "paid", label: "Paid" },
  { value: "unpaid", label: "Unpaid" },
  { value: "overdue", label: "Overdue" },
  { value: "draft", label: "Draft" },
];

const PAYMENT_STATUS_OPTIONS = [
  { value: "completed", label: "Completed" },
  { value: "pending", label: "Pending" },
  { value: "failed", label: "Failed" },
  { value: "refunded", label: "Refunded" },
];

const InvoiceStatusBadge = ({ status }) => {
  const styles = {
    paid: "bg-green-100 text-green-700",
    unpaid: "bg-amber-100 text-amber-700",
    overdue: "bg-red-100 text-red-700",
    draft: "bg-slate-100 text-slate-700",
  };
  const icons = {
    paid: <CheckCircle size={12} />,
    unpaid: <Clock size={12} />,
    overdue: <AlertCircle size={12} />,
    draft: <FileText size={12} />,
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${styles[status] || "bg-gray-100 text-gray-700"}`}>
      {icons[status] || null}
      {status || "unknown"}
    </span>
  );
};

const PaymentStatusBadge = ({ status }) => {
  const styles = {
    completed: "bg-green-100 text-green-700",
    pending: "bg-amber-100 text-amber-700",
    failed: "bg-red-100 text-red-700",
    refunded: "bg-blue-100 text-blue-700",
  };
  const icons = {
    completed: <CheckCircle size={12} />,
    pending: <Clock size={12} />,
    failed: <AlertCircle size={12} />,
    refunded: <DollarSign size={12} />,
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${styles[status] || "bg-gray-100 text-gray-700"}`}>
      {icons[status] || null}
      {status || "unknown"}
    </span>
  );
};

export default function BillingHistoryPage() {
  const [activeTab, setActiveTab] = useState("invoices");

  const [invoices, setInvoices] = useState([]);
  const [payments, setPayments] = useState([]);
  const [invoicesTotal, setInvoicesTotal] = useState(0);
  const [paymentsTotal, setPaymentsTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");

  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const total = activeTab === "invoices" ? invoicesTotal : paymentsTotal;
  const items = activeTab === "invoices" ? invoices : payments;
  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchData = useCallback(async () => {
    const api = activeTab === "invoices" ? invoiceApi : paymentApi;
    try {
      setError(null);
      if (!loading) setRefreshing(true);

      const params = {
        page: safePage,
        per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        status: statusFilter || undefined,
        date_from: dateStart || undefined,
        date_to: dateEnd || undefined,
      };

      const data = await api.list(params);
      const items = data.items || data.data || data || [];
      const arr = Array.isArray(items) ? items : [];

      if (activeTab === "invoices") {
        setInvoices(arr);
        setInvoicesTotal(data.total || arr.length || 0);
      } else {
        setPayments(arr);
        setPaymentsTotal(data.total || arr.length || 0);
      }
    } catch (err) {
      setError(err.message || "Failed to load billing data");
      if (activeTab === "invoices") { setInvoices([]); setInvoicesTotal(0); }
      else { setPayments([]); setPaymentsTotal(0); }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeTab, safePage, debouncedSearch, statusFilter, dateStart, dateEnd, loading]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages);
  }, [totalPages, currentPage]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  const handleExportCSV = () => {
    const rows = items;
    if (!rows.length) return;

    const isInvoices = activeTab === "invoices";
    const headers = isInvoices
      ? ["Invoice #", "Customer", "Amount", "Status", "Due Date", "Paid Date"]
      : ["Receipt #", "Customer", "Amount", "Method", "Status", "Date"];

    const csvRows = rows.map((r) => {
      if (isInvoices) {
        return [
          `"${(r.invoice_number || r.id || "").replace(/"/g, '""')}"`,
          `"${(r.customer_name || r.customer?.display_name || "").replace(/"/g, '""')}"`,
          r.total_amount ?? r.total ?? "",
          r.status || "",
          r.due_date || "",
          r.paid_at || "",
        ].join(",");
      }
      return [
        `"${(r.payment_number || r.id || "").replace(/"/g, '""')}"`,
        `"${(r.customer_name || r.customer?.display_name || `Customer #${r.customer_id ?? ""}`).replace(/"/g, '""')}"`,
        r.amount ?? "",
        r.payment_method || r.method || "",
        r.status || "",
        r.created_at || r.date || "",
      ].join(",");
    });

    const csv = [headers.join(","), ...csvRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeTab}-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const SortHeader = ({ label }) => (
    <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">
      <div className="flex items-center gap-1">{label}</div>
    </th>
  );

  if (loading) {
    return (
      <HRPage title="Billing History" subtitle="Customer invoices and payment transactions">
        <div className="flex flex-col items-center justify-center py-20">
          <div className="relative">
            <div className="h-16 w-16 rounded-full border-4 border-slate-200 border-t-brand-600 animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center"><RefreshCw size={24} className="text-brand-600" /></div>
          </div>
          <p className="mt-4 text-slate-600 font-medium">Loading billing data...</p>
        </div>
      </HRPage>
    );
  }

  if (error && items.length === 0) {
    return (
      <HRPage title="Billing History" subtitle="Customer invoices and payment transactions">
        <div className="flex flex-col items-center justify-center py-20">
          <div className="h-16 w-16 rounded-full bg-red-100 text-red-600 flex items-center justify-center mb-4"><AlertCircle size={32} /></div>
          <h3 className="text-xl font-bold text-slate-800 mb-2">Something went wrong</h3>
          <p className="text-slate-600 mb-6 text-center max-w-md">{error}</p>
          <button onClick={handleRefresh} className="px-6 py-3 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl font-medium hover:shadow-lg flex items-center gap-2">
            <RefreshCw size={18} /> Try Again
          </button>
        </div>
      </HRPage>
    );
  }

  return (
    <HRPage title="Billing History" subtitle="Customer invoices and payment transactions">

      <div className="bg-white border border-slate-200 rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
        <div className="p-6 border-b border-slate-100">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-1">
              <div className="relative flex-1 max-w-md">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search by invoice, receipt, customer..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search billing history"
                  className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
                {search && (
                  <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                    <X size={16} />
                  </button>
                )}
              </div>
              <button
                onClick={() => setShowFilters(!showFilters)}
                className={`p-2.5 rounded-xl border transition-colors ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
              >
                <Filter size={18} />
              </button>
              <button onClick={handleRefresh} disabled={refreshing} aria-label="Refresh" className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50">
                <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={handleExportCSV} className="flex items-center gap-2 px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50">
                <Download size={16} /> Export CSV
              </button>
            </div>
          </div>

          {showFilters && (
            <div className="flex flex-wrap items-center gap-3 mt-4 pt-4 border-t border-slate-100">
              <div className="relative">
                <select
                  value={statusFilter}
                  onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"
                >
                  <option value="">All Statuses</option>
                  {(activeTab === "invoices" ? INVOICE_STATUS_OPTIONS : PAYMENT_STATUS_OPTIONS).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
              <div>
                <input
                  type="date"
                  value={dateStart}
                  onChange={(e) => { setDateStart(e.target.value); setCurrentPage(1); }}
                  aria-label="Filter from date"
                  className="px-4 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
              </div>
              <span className="text-slate-400 text-sm">to</span>
              <div>
                <input
                  type="date"
                  value={dateEnd}
                  onChange={(e) => { setDateEnd(e.target.value); setCurrentPage(1); }}
                  aria-label="Filter to date"
                  className="px-4 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
              </div>
            </div>
          )}
        </div>

        <div className="border-b border-slate-100">
          <div className="flex">
            <button
              onClick={() => { setActiveTab("invoices"); setCurrentPage(1); setError(null); setShowFilters(false); }}
              className={`relative px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === "invoices"
                  ? "text-brand-600 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-brand-600"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <div className="flex items-center gap-2">
                <FileText size={16} />
                Invoices
              </div>
            </button>
            <button
              onClick={() => { setActiveTab("payments"); setCurrentPage(1); setError(null); setShowFilters(false); }}
              className={`relative px-6 py-3 text-sm font-medium transition-colors ${
                activeTab === "payments"
                  ? "text-brand-600 after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-brand-600"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              <div className="flex items-center gap-2">
                <CreditCard size={16} />
                Payments
              </div>
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          {activeTab === "invoices" ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <SortHeader label="Invoice #" />
                  <SortHeader label="Customer" />
                  <SortHeader label="Amount" />
                  <SortHeader label="Status" />
                  <SortHeader label="Due Date" />
                  <SortHeader label="Paid Date" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {invoices.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-16 text-center">
                      <div className="flex flex-col items-center">
                        <FileText size={40} className="text-slate-300 mb-3" />
                        <p className="text-slate-500 font-medium">No invoices found</p>
                        <p className="text-slate-400 text-sm mt-1">{search || statusFilter || dateStart || dateEnd ? "Try adjusting your search or filters" : "No invoices have been created yet"}</p>
                      </div>
                    </td>
                  </tr>
                ) : invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-4 font-medium text-slate-800 whitespace-nowrap">{inv.invoice_number || inv.id || "—"}</td>
                    <td className="px-4 py-4 text-slate-600">{inv.customer_name || inv.customer?.display_name || "—"}</td>
                    <td className="px-4 py-4 font-medium text-slate-800 whitespace-nowrap">{formatDisplayCurrency(inv.total_amount ?? inv.total)}</td>
                    <td className="px-4 py-4"><InvoiceStatusBadge status={inv.status} /></td>
                    <td className="px-4 py-4 text-slate-500">{formatDisplayDate(inv.due_date)}</td>
                    <td className="px-4 py-4 text-slate-500">{formatDisplayDate(inv.paid_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <SortHeader label="Receipt #" />
                  <SortHeader label="Customer" />
                  <SortHeader label="Amount" />
                  <SortHeader label="Method" />
                  <SortHeader label="Status" />
                  <SortHeader label="Date" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {payments.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-16 text-center">
                      <div className="flex flex-col items-center">
                        <CreditCard size={40} className="text-slate-300 mb-3" />
                        <p className="text-slate-500 font-medium">No payments found</p>
                        <p className="text-slate-400 text-sm mt-1">{search || statusFilter || dateStart || dateEnd ? "Try adjusting your search or filters" : "No payments have been recorded yet"}</p>
                      </div>
                    </td>
                  </tr>
                ) : payments.map((pmt) => (
                  <tr key={pmt.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-4 font-medium text-slate-800 whitespace-nowrap">{pmt.payment_number || pmt.id || "—"}</td>
                    <td className="px-4 py-4 text-slate-600">{pmt.customer_name || pmt.customer?.display_name || (pmt.customer_id ? `Customer #${pmt.customer_id}` : "—")}</td>
                    <td className="px-4 py-4 font-medium text-slate-800 whitespace-nowrap">{formatDisplayCurrency(pmt.amount)}</td>
                    <td className="px-4 py-4 text-slate-600 capitalize">{pmt.payment_method || pmt.method || "—"}</td>
                    <td className="px-4 py-4"><PaymentStatusBadge status={pmt.status} /></td>
                    <td className="px-4 py-4 text-slate-500">{formatDisplayDate(pmt.created_at || pmt.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
          {total} total record(s)
        </Pagination>
      </div>
    </HRPage>
  );
}
