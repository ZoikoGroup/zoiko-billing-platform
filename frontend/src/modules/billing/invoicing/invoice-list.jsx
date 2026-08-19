import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Receipt, Filter, X, RefreshCw,
  AlertCircle, CheckCircle, Clock, Plus,
  Calendar, DollarSign, Send, Ban, Download,
  Wallet, BarChart3
} from "lucide-react";
import { invoiceApi } from "../../../service/billingService";
import { getCurrencySelectOptions } from "../../../utils/currency";
import { formatDisplayDate, formatDisplayCurrency } from "../../../utils/billing-helpers";
import { PageSkeleton, ErrorState, StatusBadge as SharedStatusBadge, Pagination } from "../../../components/billing-shared";
import { useTerminology } from "../utils/TerminologyContext";
import { PageHeader, Button, DataTable, SearchInput, Select } from "../../../components/billing-ui";


const ITEMS_PER_PAGE = 15;

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft", color: "bg-slate-100 text-slate-700" },
  { value: "sent", label: "Sent", color: "bg-blue-100 text-blue-700" },
  { value: "paid", label: "Paid", color: "bg-green-100 text-green-700" },
  { value: "overdue", label: "Overdue", color: "bg-red-100 text-red-700" },
  { value: "cancelled", label: "Cancelled", color: "bg-amber-100 text-amber-700" },
  { value: "partially_paid", label: "Partially Paid", color: "bg-brand-100 text-brand-700" },
  { value: "refunded", label: "Refunded", color: "bg-pink-100 text-pink-700" },
  { value: "written_off", label: "Written Off", color: "bg-slate-100 text-slate-600" },
];

const CURRENCY_OPTIONS = getCurrencySelectOptions();

const STATUS_ICONS = {
  draft: Clock, sent: Send, paid: CheckCircle, overdue: AlertCircle,
  cancelled: Ban, partially_paid: Wallet, refunded: Receipt,
};

export default function InvoicingPage() {
  const { singular, plural, getLabel } = useTerminology();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [invoices, setInvoices] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [sortField, setSortField] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");
  const [selectedInvoices, setSelectedInvoices] = useState([]);

  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchInvoices = useCallback(async () => {
    try {
      setError(null);
      if (!loading) setRefreshing(true);
      const data = await invoiceApi.list({
        page: safePage,
        per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        status: statusFilter || undefined,
        currency: currencyFilter || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        min_amount: minAmount || undefined,
        max_amount: maxAmount || undefined,
        sort_by: sortField,
        sort_order: sortDir,
      });
      const items = data.items || data.data || data || [];
      setInvoices(Array.isArray(items) ? items : []);
      setTotal(data.total || items.length || 0);
    } catch (err) {
      setError(err.message || "Failed to load invoices");
      setInvoices([]);
      setTotal(0);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter, currencyFilter, dateFrom, dateTo, minAmount, maxAmount, sortField, sortDir, loading]);

  useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages);
  }, [totalPages, currentPage]);

  useEffect(() => {
    const requestedStatus = searchParams.get("status");
    if (requestedStatus) setStatusFilter(requestedStatus);
    if (searchParams.get("create") === "1") {
      const customerId = searchParams.get("customer_id");
      navigate(`/billing/invoices/create${customerId ? `?customer_id=${customerId}` : ""}`, { replace: true });
    }
  }, [searchParams]);

  const handleRefresh = () => { setRefreshing(true); fetchInvoices(); };

  const StatusBadge = ({ status }) => (
    <SharedStatusBadge status={status} options={STATUS_OPTIONS} icon={STATUS_ICONS[status] || Clock} />
  );

  const columns = [
    { key: "invoice_number", label: "Invoice", sortable: true, render: (r) => (
      <span className="font-semibold text-slate-800 hover:text-brand-600 transition-colors whitespace-nowrap cursor-pointer">{r.invoice_number || `#${r.id}`}</span>
    )},
    { key: "customer_name", label: singular, sortable: true, render: (r) => r.customer_name || r.customer?.name || "—" },
    { key: "issue_date", label: "Invoice Date", sortable: true, render: (r) => <span className="text-xs text-slate-500 whitespace-nowrap">{formatDisplayDate(r.issue_date)}</span> },
    { key: "due_date", label: "Due Date", sortable: true, render: (r) => <span className="text-xs text-slate-500 whitespace-nowrap">{formatDisplayDate(r.due_date)}</span> },
    { key: "total_amount", label: "Amount", sortable: true, align: "right", render: (r) => <span className="font-semibold text-slate-800 whitespace-nowrap">{formatDisplayCurrency(r.total || r.total_amount, "—", r.currency)}</span> },
    { key: "paid_amount", label: "Paid", align: "right", render: (r) => <span className="text-sm text-emerald-600 whitespace-nowrap">{formatDisplayCurrency(r.paid_amount, "—", r.currency)}</span> },
    { key: "balance_due", label: "Balance", align: "right", render: (r) => <span className="text-sm text-red-600 whitespace-nowrap">{formatDisplayCurrency(r.balance_due, "—", r.currency)}</span> },
    { key: "currency", label: "Currency", align: "center", render: (r) => <span className="text-xs font-medium text-slate-500 whitespace-nowrap">{r.currency || "USD"}</span> },
    { key: "status", label: "Status", sortable: true, render: (r) => <StatusBadge status={r.status} /> },
    { key: "updated_at", label: "Last Updated", render: (r) => <span className="text-xs text-slate-400">{r.updated_at ? new Date(r.updated_at).toLocaleDateString() : "—"}</span> },
  ];

  const toggleSort = (field) => {
    setSortField(field);
    setSortDir((d) => (field === sortField ? (d === "asc" ? "desc" : "asc") : "asc"));
  };

  const [recentInvoices, setRecentInvoices] = useState([]);
  useEffect(() => {
    invoiceApi.list({ page: 1, per_page: 3, sort_by: "created_at", sort_order: "desc" })
      .then((res) => setRecentInvoices(res.items || res.data || res || []))
      .catch((err) => console.error("Failed to load recent invoices:", err));
  }, []);

  const runBulkInvoiceAction = async (action) => {
    if (selectedInvoices.length === 0) return;
    try {
      setRefreshing(true);
      if (action === "export") {
        const selectedData = invoices.filter((inv) => selectedInvoices.includes(inv.id));
        const blob = new Blob([JSON.stringify(selectedData, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = `invoices-export-${new Date().toISOString().split("T")[0]}.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setSelectedInvoices([]);
        return;
      }
      if (action === "delete") {
        await invoiceApi.bulkDelete(selectedInvoices);
        setSelectedInvoices([]);
        await fetchInvoices();
        return;
      }
      
      const calls = selectedInvoices.map((id) => {
        if (action === "finalize") return invoiceApi.finalize(id);
        if (action === "send") return invoiceApi.markSent(id);
        if (action === "cancel") return invoiceApi.cancel(id, "Cancelled from invoice list");
        return Promise.resolve();
      });
      await Promise.allSettled(calls);
      setSelectedInvoices([]);
      await fetchInvoices();
    } catch (err) {
      setError(err?.detail || err?.message || "Bulk action failed");
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Invoices" }]}
          title="Invoices"
          description={`Manage, send, and track ${getLabel("singularLower")} invoices`}
          icon={Receipt}
        />
        <PageSkeleton rows={8} />
      </div>
    );
  }

  if (error && invoices.length === 0) {
    return (
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Invoices" }]}
          title="Invoices"
          description={`Manage, send, and track ${getLabel("singularLower")} invoices`}
          icon={Receipt}
        />
        <div role="alert" aria-live="assertive"><ErrorState message={error} onRetry={handleRefresh} /></div>
      </div>
    );
  }

  return (
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Invoices" }]}
          title="Invoices"
          description={`Manage, send, and track ${getLabel("singularLower")} invoices`}
          icon={Receipt}
          actions={
            <>
              <Button variant="secondary" icon={BarChart3} onClick={() => navigate("/billing/invoices/dashboard")}>
                Dashboard
              </Button>
              <Button variant="primary" icon={Plus} onClick={() => navigate("/billing/invoices/create")}>
                Create Invoice
              </Button>
            </>
          }
        />

        {recentInvoices.length > 0 && (
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Recently Created</p>
              <button onClick={() => { setStatusFilter(""); setCurrentPage(1); }} className="text-xs font-medium text-brand-600 hover:text-brand-hover" aria-label="View all invoices">View all</button>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              {recentInvoices.map((inv) => (
                <button key={inv.id} onClick={() => navigate(`/billing/invoices/${inv.id}`)}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-left transition-colors hover:border-brand-200 hover:bg-brand-50/40">
                  <span className="block text-sm font-semibold text-slate-800">{inv.invoice_number || `#${inv.id}`}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">{inv.customer_name || `${singular} #${inv.customer_id || "—"}`} · {formatDisplayCurrency(inv.total || inv.total_amount, "—", inv.currency)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

      <div className="bg-white border border-slate-200 rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
        <div className="p-6 border-b border-slate-100">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-1">
              <SearchInput
                value={search}
                onChange={setSearch}
                debounceMs={0}
                placeholder={`Search by invoice number, ${getLabel("singularLower")}, PO...`}
                className="flex-1 max-w-md"
                aria-label="Search invoices"
              />
              <button onClick={() => setShowFilters(!showFilters)}
                className={`p-2.5 rounded-xl border transition-colors ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
                aria-label="Toggle filters">
                <Filter size={18} />
              </button>
              <button onClick={handleRefresh} disabled={refreshing} className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50" aria-label="Refresh">
                <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
              </button>
            </div>
            <span className="text-xs font-medium text-slate-400">{total} invoice(s)</span>
          </div>

          {showFilters && (
            <div className="mt-4 pt-4 border-t border-slate-100 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <Select
                  value={statusFilter}
                  onChange={(v) => { setStatusFilter(v); setCurrentPage(1); }}
                  options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                  placeholder="All Statuses"
                  className="w-44"
                />
                <Select
                  value={currencyFilter}
                  onChange={(v) => { setCurrencyFilter(v); setCurrentPage(1); }}
                  options={CURRENCY_OPTIONS.map((c) => ({ value: c.value, label: c.value }))}
                  placeholder="All Currencies"
                  className="w-44"
                />
                <div className="flex items-center gap-2">
                  <Calendar size={14} className="text-slate-400" />
                  <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setCurrentPage(1); }}
                    className="px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand-300" aria-label="Date from" />
                  <span className="text-slate-400">to</span>
                  <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setCurrentPage(1); }}
                    className="px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand-300" aria-label="Date to" />
                </div>
                <div className="flex items-center gap-2">
                  <DollarSign size={14} className="text-slate-400" />
                  <input type="number" value={minAmount} onChange={(e) => { setMinAmount(e.target.value); setCurrentPage(1); }}
                    placeholder="Min" className="w-24 sm:w-20 px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand-300" aria-label="Minimum amount" />
                  <span className="text-slate-400">-</span>
                  <input type="number" value={maxAmount} onChange={(e) => { setMaxAmount(e.target.value); setCurrentPage(1); }}
                    placeholder="Max" className="w-24 sm:w-20 px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand-300" aria-label="Maximum amount" />
                </div>
                {(statusFilter || currencyFilter || dateFrom || dateTo || minAmount || maxAmount) && (
                  <button onClick={() => { setStatusFilter(""); setCurrencyFilter(""); setDateFrom(""); setDateTo(""); setMinAmount(""); setMaxAmount(""); setCurrentPage(1); }}
                    className="text-xs font-medium text-red-600 hover:text-red-700 flex items-center gap-1">
                    <X size={12} /> Clear all
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Quick filters</span>
            {[{ value: "", label: "All" }, ...STATUS_OPTIONS].map((o) => (
              <button key={o.value || "all"} onClick={() => { setStatusFilter(o.value); setCurrentPage(1); }}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${statusFilter === o.value ? "bg-brand text-white shadow-sm" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className="p-6">
          <DataTable
            columns={columns}
            data={invoices}
            rowKey={(row) => row.id}
            onRowClick={(row) => navigate(`/billing/invoices/${row.id}`)}
            selectedKeys={selectedInvoices}
            onSelectionChange={setSelectedInvoices}
            sortKey={sortField}
            sortDir={sortDir}
            onSort={toggleSort}
            bulkActions={[
              { label: "Finalize", icon: CheckCircle, onClick: () => runBulkInvoiceAction("finalize") },
              { label: "Send", icon: Send, onClick: () => runBulkInvoiceAction("send") },
              { label: "Cancel", icon: Ban, onClick: () => runBulkInvoiceAction("cancel") },
              { label: "Export (JSON)", icon: Download, onClick: () => runBulkInvoiceAction("export") },
              { label: "Delete", icon: Ban, onClick: () => runBulkInvoiceAction("delete") },
            ]}
            emptyTitle="No invoices found"
            emptyMessage={search || statusFilter || currencyFilter || dateFrom || dateTo ? "Try adjusting your search or filters" : "No invoices yet"}
            emptyIcon={Receipt}
            emptyAction={!search && !statusFilter && !currencyFilter ? (
              <Button variant="primary" icon={Plus} onClick={() => navigate("/billing/invoices/create")}>
                Create your first invoice
              </Button>
            ) : undefined}
            striped
          />
        </div>
        <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
          {total} total invoice(s)
        </Pagination>
      </div>
      </div>
  );
}
