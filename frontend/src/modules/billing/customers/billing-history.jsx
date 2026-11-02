import { useState, useEffect, useCallback } from "react";
import {
  Search, Filter, X, RefreshCw, Download, ChevronDown, FileText, DollarSign, CreditCard,
  AlertCircle, CheckCircle, Clock
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { invoiceApi, paymentApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate } from "../../../utils/billing-helpers";
import { Pagination } from "../../../components/billing-shared";
import { DataTable } from "../../../components/billing-ui";
import useLatestRequest from "../utils/useLatestRequest";

const ITEMS_PER_PAGE = 10;

const INVOICE_STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "paid", label: "Paid" },
  { value: "overdue", label: "Overdue" },
  { value: "cancelled", label: "Cancelled" },
  { value: "partially_paid", label: "Partially Paid" },
  { value: "refunded", label: "Refunded" },
  { value: "written_off", label: "Written Off" },
];

const PAYMENT_STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "cleared", label: "Cleared" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "refunded", label: "Refunded" },
];

const InvoiceStatusBadge = ({ status }) => {
  const styles = {
    draft: "bg-slate-100 text-slate-700",
    sent: "bg-blue-100 text-blue-700",
    paid: "bg-green-100 text-green-700",
    overdue: "bg-red-100 text-red-700",
    cancelled: "bg-slate-100 text-slate-500",
    partially_paid: "bg-amber-100 text-amber-700",
    refunded: "bg-pink-100 text-pink-700",
    written_off: "bg-slate-100 text-slate-600",
  };
  const icons = {
    draft: <FileText size={12} />,
    sent: <Clock size={12} />,
    paid: <CheckCircle size={12} />,
    overdue: <AlertCircle size={12} />,
    cancelled: <FileText size={12} />,
    partially_paid: <Clock size={12} />,
    refunded: <CheckCircle size={12} />,
    written_off: <FileText size={12} />,
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${styles[status] || "bg-slate-100 text-slate-700"}`}>
      {icons[status] || null}
      {status || "unknown"}
    </span>
  );
};

const PaymentStatusBadge = ({ status }) => {
  const styles = {
    pending: "bg-amber-100 text-amber-700",
    processing: "bg-blue-100 text-blue-700",
    cleared: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700",
    cancelled: "bg-slate-100 text-slate-500",
    refunded: "bg-blue-100 text-blue-700",
  };
  const icons = {
    pending: <Clock size={12} />,
    processing: <Clock size={12} />,
    cleared: <CheckCircle size={12} />,
    failed: <AlertCircle size={12} />,
    cancelled: <FileText size={12} />,
    refunded: <DollarSign size={12} />,
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${styles[status] || "bg-slate-100 text-slate-700"}`}>
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

  const hasActiveFilters = Boolean(search || statusFilter || dateStart || dateEnd);
  // One reset for every filter on the page (search, status, dates) -- there
  // was no way to clear them except one by one.
  const clearFilters = () => {
    setSearch(""); setDebouncedSearch(""); setStatusFilter("");
    setDateStart(""); setDateEnd(""); setCurrentPage(1);
  };

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

  // Only the latest request may update the lists (stale responses are dropped).
  const beginRequest = useLatestRequest();
  const fetchData = useCallback(async () => {
    const api = activeTab === "invoices" ? invoiceApi : paymentApi;
    const isCurrent = beginRequest();
    try {
      setError(null);
      setRefreshing(true);

      const params = {
        page: safePage,
        per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        status: statusFilter || undefined,
        date_from: dateStart || undefined,
        date_to: dateEnd || undefined,
      };

      const data = await api.list(params);
      if (!isCurrent()) return;
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
      if (!isCurrent()) return;
      setError(err.message || "Failed to load billing data");
      if (activeTab === "invoices") { setInvoices([]); setInvoicesTotal(0); }
      else { setPayments([]); setPaymentsTotal(0); }
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [beginRequest, activeTab, safePage, debouncedSearch, statusFilter, dateStart, dateEnd]);

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
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  placeholder="Search by invoice, receipt, customer..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search billing history"
                  className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
                {search && (
                  <button onClick={() => setSearch("")} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-600">
                    <X size={16} />
                  </button>
                )}
              </div>
              <button
                onClick={() => setShowFilters(!showFilters)}
                aria-label="Toggle filters"
                aria-pressed={showFilters}
                className={`p-2.5 rounded-xl border transition-colors ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
              >
                <Filter size={18} />
              </button>
              <button onClick={handleRefresh} disabled={refreshing} aria-label="Refresh" className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50">
                <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
              </button>
              <button onClick={clearFilters} disabled={!hasActiveFilters}
                title={hasActiveFilters ? "Reset search, status and date filters" : "No filters applied"}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-xl border border-slate-200 px-3 py-2 text-xs font-medium text-brand-600 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent">
                <X size={14} />
                Clear filters
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
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
                  aria-label="Filter by status"
                  onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"
                >
                  <option value="">All Statuses</option>
                  {(activeTab === "invoices" ? INVOICE_STATUS_OPTIONS : PAYMENT_STATUS_OPTIONS).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
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
              <span className="text-slate-500 text-sm">to</span>
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
              onClick={() => { setActiveTab("invoices"); setStatusFilter(""); setCurrentPage(1); setError(null); setShowFilters(false); }}
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
              onClick={() => { setActiveTab("payments"); setStatusFilter(""); setCurrentPage(1); setError(null); setShowFilters(false); }}
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

        {/* Shared table: rows become cards on phones (6 columns). */}
        {activeTab === "invoices" ? (
          <DataTable
            stickyHeader={false}
            data={invoices}
            rowKey={(inv) => inv.id}
            emptyIcon={FileText}
            emptyTitle="No invoices found"
            emptyMessage={hasActiveFilters ? "No invoices match your filters" : "No invoices have been created yet"}
            emptyAction={hasActiveFilters ? (
              <button onClick={clearFilters} className="mt-3 text-sm font-medium text-brand-600 hover:text-brand-700">Clear filters</button>
            ) : null}
            columns={[
              { key: "invoice_number", label: "Invoice #", render: (inv) => <span className="font-medium text-slate-800 whitespace-nowrap">{inv.invoice_number || inv.id || "—"}</span> },
              { key: "customer", label: "Customer", render: (inv) => <span className="text-slate-600">{inv.customer_name || inv.customer?.display_name || "—"}</span> },
              { key: "amount", label: "Amount", mobileRole: "amount", render: (inv) => <span className="font-medium text-slate-800 whitespace-nowrap">{formatDisplayCurrency(inv.total_amount ?? inv.total)}</span> },
              { key: "status", label: "Status", render: (inv) => <InvoiceStatusBadge status={inv.status} /> },
              { key: "due_date", label: "Due Date", render: (inv) => <span className="text-slate-500">{formatDisplayDate(inv.due_date)}</span> },
              { key: "paid_at", label: "Paid Date", render: (inv) => <span className="text-slate-500">{formatDisplayDate(inv.paid_at)}</span> },
            ]}
          />
        ) : (
          <DataTable
            stickyHeader={false}
            data={payments}
            rowKey={(pmt) => pmt.id}
            emptyIcon={CreditCard}
            emptyTitle="No payments found"
            emptyMessage={hasActiveFilters ? "No payments match your filters" : "No payments have been recorded yet"}
            emptyAction={hasActiveFilters ? (
              <button onClick={clearFilters} className="mt-3 text-sm font-medium text-brand-600 hover:text-brand-700">Clear filters</button>
            ) : null}
            columns={[
              { key: "payment_number", label: "Receipt #", render: (pmt) => <span className="font-medium text-slate-800 whitespace-nowrap">{pmt.payment_number || pmt.id || "—"}</span> },
              { key: "customer", label: "Customer", render: (pmt) => <span className="text-slate-600">{pmt.customer_name || pmt.customer?.display_name || (pmt.customer_id ? `Customer #${pmt.customer_id}` : "—")}</span> },
              { key: "amount", label: "Amount", mobileRole: "amount", render: (pmt) => <span className="font-medium text-slate-800 whitespace-nowrap">{formatDisplayCurrency(pmt.amount)}</span> },
              { key: "method", label: "Method", render: (pmt) => <span className="text-slate-600 capitalize">{pmt.payment_method || pmt.method || "—"}</span> },
              { key: "status", label: "Status", render: (pmt) => <PaymentStatusBadge status={pmt.status} /> },
              { key: "date", label: "Date", render: (pmt) => <span className="text-slate-500">{formatDisplayDate(pmt.created_at || pmt.date)}</span> },
            ]}
          />
        )}

        <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
          {total} total record(s)
        </Pagination>
      </div>
    </HRPage>
  );
}
