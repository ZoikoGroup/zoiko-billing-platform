import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ScrollText, Search, Filter, X, ChevronDown, ArrowUpDown, RefreshCw, Download,
  Plus, AlertCircle, FileText, Ban, Eye, Send,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { writeOffApi, customerApi, invoiceApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { Pagination } from "../../../components/billing-shared";
import { useCurrency } from "../utils/CurrencyContext";
import { useTerminology } from "../utils/TerminologyContext";

const ITEMS_PER_PAGE = 10;

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending Approval" },
  { value: "approved", label: "Approved" },
  { value: "executed", label: "Executed" },
  { value: "reversed", label: "Reversed" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_STYLES = {
  draft: "bg-slate-100 text-slate-700",
  pending_approval: "bg-amber-100 text-amber-700",
  approved: "bg-indigo-100 text-indigo-700",
  executed: "bg-emerald-100 text-emerald-700",
  reversed: "bg-orange-100 text-orange-700",
  cancelled: "bg-slate-200 text-slate-600",
};

const TYPE_OPTIONS = [
  { value: "bad_debt", label: "Bad Debt" },
  { value: "customer_bankruptcy", label: "Customer Bankruptcy" },
  { value: "small_balance", label: "Small Balance" },
  { value: "duplicate_balance", label: "Duplicate Balance" },
  { value: "accounting_adjustment", label: "Accounting Adjustment" },
  { value: "manual_adjustment", label: "Manual Adjustment" },
  { value: "goodwill_adjustment", label: "Goodwill Adjustment" },
];

const ADJUSTMENT_TYPE_OPTIONS = [
  { value: "debit_adjustment", label: "Debit Adjustment" },
  { value: "credit_adjustment", label: "Credit Adjustment" },
  { value: "tax_adjustment", label: "Tax Adjustment" },
  { value: "discount_adjustment", label: "Discount Adjustment" },
  { value: "service_adjustment", label: "Service Adjustment" },
  { value: "currency_adjustment", label: "Currency Adjustment" },
];

const SOURCE_OPTIONS = [
  { value: "invoice", label: "Invoice" },
  { value: "customer_outstanding_balance", label: "Customer Outstanding Balance" },
  { value: "receivable", label: "Receivable" },
  { value: "adjustment_only", label: "Adjustment Only" },
];

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_STYLES[status] || "bg-slate-100 text-slate-700"}`}>
      {status?.replace(/_/g, " ") || "unknown"}
    </span>
  );
}

const emptyCreateForm = (currency) => ({
  customer_id: "", write_off_source: "invoice", invoice_id: "",
  write_off_type: "bad_debt", adjustment_type: "", amount: "", currency, reason: "", notes: "",
});

export default function WriteOffsPage() {
  const { singular, getLabel } = useTerminology();
  const navigate = useNavigate();
  const { baseCurrency } = useCurrency();
  const [searchParams] = useSearchParams();

  const [writeOffs, setWriteOffs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(searchParams.get("status") || "");
  const [typeFilter, setTypeFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreateForm(baseCurrency));
  const [customers, setCustomers] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [formError, setFormError] = useState(null);

  const [sortField, setSortField] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setCurrentPage(1); }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchWriteOffs = useCallback(async () => {
    try {
      setError(null);
      if (!loading) setRefreshing(true);
      const data = await writeOffApi.list({
        page: safePage, per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        status: statusFilter || undefined,
        write_off_type: typeFilter || undefined,
        sort_by: sortField, sort_order: sortDir,
      });
      setWriteOffs(extractArray(data));
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.message || "Failed to load write-offs");
      setWriteOffs([]); setTotal(0);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter, typeFilter, sortField, sortDir]);

  useEffect(() => { fetchWriteOffs(); }, [fetchWriteOffs]);
  useEffect(() => { if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages); }, [totalPages, currentPage]);

  const fetchCustomers = useCallback(async () => {
    try { const data = await customerApi.list({ per_page: 100 }); setCustomers(extractArray(data)); }
    catch (e) { /* silent */ }
  }, []);

  useEffect(() => { if (showCreateModal) fetchCustomers(); }, [showCreateModal, fetchCustomers]);

  const handleRefresh = () => { setRefreshing(true); fetchWriteOffs(); };
  const toggleSort = (field) => { setSortField(field); setSortDir((d) => d === "asc" ? "desc" : "asc"); };

  const openCreateModal = () => {
    setCreateForm(emptyCreateForm(baseCurrency));
    setSelectedCustomer(null);
    setInvoices([]);
    setFormError(null); setShowCreateModal(true);
  };

  const handleCustomerChange = async (customerId) => {
    setCreateForm((p) => ({ ...p, customer_id: customerId, invoice_id: "" }));
    if (!customerId) { setSelectedCustomer(null); return; }
    try {
      const customer = await customerApi.get(customerId);
      setSelectedCustomer(customer);
      setCreateForm((p) => ({ ...p, currency: customer.currency || p.currency }));
    } catch (e) { setSelectedCustomer(null); }
    try {
      const invRes = await invoiceApi.list({ customer_id: customerId, per_page: 50, status: "sent,overdue,partially_paid" }).catch(() => null);
      setInvoices(invRes ? extractArray(invRes) : []);
    } catch (e) { /* silent */ }
  };

  const handleSourceChange = (source) => {
    setCreateForm((p) => ({ ...p, write_off_source: source, invoice_id: "" }));
  };

  const handleCreate = async () => {
    try {
      setSaving(true); setFormError(null);
      const body = {
        customer_id: Number(createForm.customer_id),
        write_off_number: "auto",
        write_off_type: createForm.write_off_type,
        write_off_source: createForm.write_off_source,
        adjustment_type: createForm.adjustment_type || undefined,
        amount: Number(createForm.amount),
        currency: createForm.currency || undefined,
        reason: createForm.reason || undefined,
        notes: createForm.notes || undefined,
      };
      if (createForm.write_off_source === "invoice") body.invoice_id = Number(createForm.invoice_id);
      await writeOffApi.create(body);
      setShowCreateModal(false);
      fetchWriteOffs();
    } catch (err) {
      setFormError(err?.detail || err?.message || "Failed to create write-off");
    } finally { setSaving(false); }
  };

  const handleAction = async (action, actionFn) => {
    setActionLoading(action);
    try { await actionFn(); fetchWriteOffs(); }
    catch (err) { setError(err?.detail || err?.message || `Failed to ${action} write-off`); }
    finally { setActionLoading(null); }
  };

  const handleExportJSON = () => {
    const blob = new Blob([JSON.stringify(writeOffs, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "write-offs.json"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCSV = () => {
    const headers = ["ID", "Number", "Type", "Source", "Status", `${singular} ID`, "Amount", "Currency", "Created"];
    const rows = writeOffs.map((w) => [w.id, w.write_off_number, w.write_off_type, w.write_off_source, w.status, w.customer_id, w.amount, w.currency, w.created_at]);
    const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "write-offs.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const canSubmitAmount = createForm.customer_id && createForm.amount &&
    (createForm.write_off_source !== "invoice" || createForm.invoice_id);

  if (loading) {
    return (
      <HRPage title="Write-offs" subtitle="Manage write-offs and financial adjustments">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-slate-200 border-t-brand-600" />
        </div>
      </HRPage>
    );
  }

  if (error && writeOffs.length === 0) {
    return (
      <HRPage title="Write-offs" subtitle="Manage write-offs and financial adjustments">
        <div className="flex flex-col items-center justify-center py-20">
          <AlertCircle className="h-12 w-12 text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-slate-800 mb-2">Something went wrong</h3>
          <p className="text-slate-600 mb-6 text-center max-w-md">{error}</p>
          <button onClick={handleRefresh} className="inline-flex items-center gap-2 px-6 py-3 bg-brand-600 text-white rounded-xl font-medium hover:bg-brand-700">
            <RefreshCw size={18} /> Try Again
          </button>
        </div>
      </HRPage>
    );
  }

  return (
    <HRPage title="Write-offs" subtitle="Write off bad debt, adjust balances, and record financial adjustments">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3 flex-1">
          <div className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input type="text" placeholder="Search write-offs..." value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={16} /></button>}
          </div>
          <button onClick={() => setShowFilters(!showFilters)}
            className={`p-2.5 rounded-xl border transition-colors ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}>
            <Filter size={18} />
          </button>
          <button onClick={handleRefresh} disabled={refreshing} aria-label="Refresh" className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExportJSON} className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" title="Export JSON"><Download size={18} /></button>
          <button onClick={handleExportCSV} className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" title="Export CSV"><FileText size={18} /></button>
          <button onClick={() => navigate("/billing/write-offs/dashboard")} className="px-4 py-2.5 text-sm font-medium text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50">
            Dashboard
          </button>
          <button onClick={openCreateModal} className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-xl hover:bg-brand-700 transition-colors">
            <Plus size={16} /> New Write-off
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}

      {showFilters && (
        <div className="flex flex-wrap items-center gap-3 mb-4 p-4 bg-slate-50 rounded-xl border border-slate-200">
          <div className="relative">
            <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
              className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
              <option value="">All Statuses</option>
              {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          </div>
          <div className="relative">
            <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setCurrentPage(1); }}
              className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
              <option value="">All Types</option>
              {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer select-none" onClick={() => toggleSort("write_off_number")}>
                  <span className="inline-flex items-center gap-1">Number <ArrowUpDown size={12} /></span>
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{singular}</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Type</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Source</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer select-none" onClick={() => toggleSort("amount")}>
                  <span className="inline-flex items-center gap-1">Amount <ArrowUpDown size={12} /></span>
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer select-none" onClick={() => toggleSort("created_at")}>
                  <span className="inline-flex items-center gap-1">Date <ArrowUpDown size={12} /></span>
                </th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {writeOffs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center">
                      <ScrollText size={40} className="text-slate-300 mb-3" />
                      <p className="text-slate-500 font-medium">No write-offs found</p>
                      <p className="text-slate-400 text-sm mt-1">{search || statusFilter || typeFilter ? "Try adjusting your search or filters" : "Create your first write-off"}</p>
                    </div>
                  </td>
                </tr>
              ) : writeOffs.map((w) => (
                <tr key={w.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-4 font-medium text-slate-800">{w.write_off_number || `#${w.id}`}</td>
                  <td className="px-4 py-4 text-slate-600">{w.customer_name || `#${w.customer_id}`}</td>
                  <td className="px-4 py-4"><span className="capitalize text-slate-600">{w.write_off_type?.replace(/_/g, " ")}</span></td>
                  <td className="px-4 py-4"><span className="capitalize text-slate-600">{w.write_off_source?.replace(/_/g, " ") || "—"}</span></td>
                  <td className="px-4 py-4"><StatusBadge status={w.status} /></td>
                  <td className="px-4 py-4 text-right font-medium text-slate-800 whitespace-nowrap">{formatDisplayCurrency(w.amount, w.currency)}</td>
                  <td className="px-4 py-4 text-slate-500 whitespace-nowrap">{formatDisplayDate(w.created_at)}</td>
                  <td className="px-4 py-4 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button onClick={() => navigate(`/billing/write-offs/${w.id}`)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition-colors" title="View"><Eye size={15} /></button>
                      {w.status === "draft" && (
                        <button onClick={() => handleAction("submit", () => writeOffApi.submit(w.id))} disabled={actionLoading === "submit"}
                          className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-amber-600 transition-colors disabled:opacity-40" title="Submit for Approval"><Send size={15} /></button>
                      )}
                      {["draft", "pending_approval", "approved"].includes(w.status) && (
                        <button onClick={() => handleAction("cancel", () => writeOffApi.cancel(w.id, "Cancelled by user"))} disabled={actionLoading === "cancel"}
                          className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-red-600 transition-colors disabled:opacity-40" title="Cancel"><Ban size={15} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
          {total} total write-off(s)
        </Pagination>
      </div>

      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowCreateModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-800">Create Write-off</h3>
              <button onClick={() => setShowCreateModal(false)} className="p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <div className="p-6 space-y-4">
              {formError && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2"><AlertCircle className="h-4 w-4 flex-shrink-0" /> {formError}</div>}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">{singular} *</label>
                <select value={createForm.customer_id} onChange={(e) => handleCustomerChange(e.target.value)}
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">Select {getLabel("singularLower")}</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.display_name || c.company_name || `#${c.id}`}</option>)}
                </select>
                {selectedCustomer && (
                  <p className="mt-1 text-xs text-slate-400">Outstanding balance: {formatDisplayCurrency(selectedCustomer.outstanding_balance || 0, "—", selectedCustomer.currency)}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Source *</label>
                  <select value={createForm.write_off_source} onChange={(e) => handleSourceChange(e.target.value)}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                    {SOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Type *</label>
                  <select value={createForm.write_off_type} onChange={(e) => setCreateForm((p) => ({ ...p, write_off_type: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                    {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>

              {createForm.write_off_source === "invoice" && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Invoice *</label>
                  <select value={createForm.invoice_id} onChange={(e) => setCreateForm((p) => ({ ...p, invoice_id: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                    <option value="">Select invoice</option>
                    {invoices.map((inv) => <option key={inv.id} value={inv.id}>{inv.invoice_number || `#${inv.id}`} — balance {formatDisplayCurrency(inv.balance_due, inv.currency)}</option>)}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Amount *</label>
                  <input type="number" min="0" step="0.01" value={createForm.amount} onChange={(e) => setCreateForm((p) => ({ ...p, amount: e.target.value }))}
                    placeholder="0.00"
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Adjustment Type</label>
                  <select value={createForm.adjustment_type} onChange={(e) => setCreateForm((p) => ({ ...p, adjustment_type: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                    <option value="">None</option>
                    {ADJUSTMENT_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Reason</label>
                <textarea value={createForm.reason} onChange={(e) => setCreateForm((p) => ({ ...p, reason: e.target.value }))}
                  rows={2} placeholder="Reason for write-off"
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Notes</label>
                <textarea value={createForm.notes} onChange={(e) => setCreateForm((p) => ({ ...p, notes: e.target.value }))}
                  rows={2} placeholder="Additional internal notes"
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200">
              <button onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">Cancel</button>
              <button onClick={handleCreate} disabled={saving || !canSubmitAmount}
                className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5">
                {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Plus size={16} />} Create
              </button>
            </div>
          </div>
        </div>
      )}
    </HRPage>
  );
}
