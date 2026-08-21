import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  HandCoins, Search, Filter, X, AlertCircle, Plus,
  CheckCircle, XCircle, Ban, Loader2, History,
} from "lucide-react";
import { promiseToPayApi, customerApi, invoiceApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { Pagination, DashboardHeader, exportDashboardToCsv, exportDashboardToJson } from "../../../components/billing-shared";

const ITEMS_PER_PAGE = 10;

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "pending", label: "Pending" },
  { value: "overdue", label: "Overdue" },
  { value: "fulfilled", label: "Fulfilled" },
  { value: "broken", label: "Broken" },
  { value: "cancelled", label: "Cancelled" },
];

const STATUS_STYLES = {
  pending: "bg-blue-100 text-blue-700",
  overdue: "bg-amber-100 text-amber-700",
  fulfilled: "bg-emerald-100 text-emerald-700",
  broken: "bg-red-100 text-red-700",
  cancelled: "bg-slate-200 text-slate-600",
};

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_STYLES[status] || "bg-slate-100 text-slate-700"}`}>
      {status || "unknown"}
    </span>
  );
}

export default function PromiseToPayPage() {
  const navigate = useNavigate();

  const [promises, setPromises] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [actionLoading, setActionLoading] = useState(null);
  const [confirmModal, setConfirmModal] = useState({ open: false, id: null, action: null, notes: "" });

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState({ customer_id: "", invoice_id: "", promise_amount: "", promise_date: "", notes: "" });
  const [customers, setCustomers] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const [timelinePromise, setTimelinePromise] = useState(null);
  const [timelineEntries, setTimelineEntries] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState(null);

  const openTimeline = async (p) => {
    setTimelinePromise(p);
    setTimelineEntries([]);
    setTimelineError(null);
    setTimelineLoading(true);
    try {
      const data = await promiseToPayApi.getTimeline(p.id);
      setTimelineEntries(Array.isArray(data?.entries) ? data.entries : []);
    } catch (err) {
      setTimelineError(err?.detail || err?.message || "Failed to load promise history");
    } finally {
      setTimelineLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setCurrentPage(1); }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchPromises = useCallback(async () => {
    try {
      setError(null);
      if (!loading) setRefreshing(true);
      const data = await promiseToPayApi.list({
        page: safePage, per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        status: statusFilter || undefined,
      });
      setPromises(extractArray(data));
      setTotal(data.total || 0);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message || "Failed to load promises to pay");
      setPromises([]); setTotal(0);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter]);

  useEffect(() => { fetchPromises(); }, [fetchPromises]);
  useEffect(() => { if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages); }, [totalPages, currentPage]);

  const fetchCustomers = useCallback(async () => {
    try { const data = await customerApi.list({ per_page: 100 }); setCustomers(extractArray(data)); }
    catch (e) { /* silent */ }
  }, []);

  useEffect(() => { if (showCreateModal) fetchCustomers(); }, [showCreateModal, fetchCustomers]);

  const handleRefresh = () => { setRefreshing(true); fetchPromises(); };

  const handleCustomerChange = async (customerId) => {
    setCreateForm((p) => ({ ...p, customer_id: customerId, invoice_id: "" }));
    if (!customerId) { setInvoices([]); return; }
    try {
      const invRes = await invoiceApi.list({ customer_id: customerId, per_page: 50, status: "sent,overdue,partially_paid" }).catch(() => null);
      setInvoices(invRes ? extractArray(invRes) : []);
    } catch (e) { /* silent */ }
  };

  const handleCreate = async () => {
    try {
      setSaving(true); setFormError(null);
      await promiseToPayApi.create({
        customer_id: Number(createForm.customer_id),
        invoice_id: createForm.invoice_id ? Number(createForm.invoice_id) : undefined,
        promise_amount: Number(createForm.promise_amount),
        promise_date: createForm.promise_date,
        notes: createForm.notes || undefined,
      });
      setShowCreateModal(false);
      setCreateForm({ customer_id: "", invoice_id: "", promise_amount: "", promise_date: "", notes: "" });
      fetchPromises();
    } catch (err) {
      setFormError(err?.detail || err?.message || "Failed to create promise to pay");
    } finally { setSaving(false); }
  };

  const handleAction = async (id, action, actionFn) => {
    setActionLoading(`${action}-${id}`);
    try { await actionFn(); fetchPromises(); }
    catch (err) { setError(err?.detail || err?.message || `Failed to ${action}`); }
    finally { setActionLoading(null); }
  };

  const CONFIRM_ACTIONS = {
    fulfil: { label: "Mark this promise as fulfilled?", api: promiseToPayApi.markFulfilled },
    break: { label: "Mark this promise as broken?", api: promiseToPayApi.markBroken },
    cancel: { label: "Cancel this promise to pay?", api: promiseToPayApi.cancel },
  };

  const runConfirmedAction = async () => {
    const { id, action, notes } = confirmModal;
    setConfirmModal({ open: false, id: null, action: null, notes: "" });
    await handleAction(id, action, () => CONFIRM_ACTIONS[action].api(id, notes || undefined));
  };

  const canSubmit = createForm.customer_id && createForm.promise_amount && createForm.promise_date;

  const handleExport = useCallback((format) => {
    const payload = { promises: promises };
    if (format === "csv") exportDashboardToCsv(payload, "promise-to-pay");
    else exportDashboardToJson(payload, "promise-to-pay");
  }, [promises]);

  const headerProps = {
    title: "Promise to Pay",
    subtitle: "Track customer payment promises and their fulfillment status",
    icon: HandCoins,
    iconGradient: "from-emerald-500 to-teal-500",
    lastUpdated,
    onRefresh: handleRefresh,
    refreshing,
    onExportCSV: () => handleExport("csv"),
    onExportJSON: () => handleExport("json"),
  };

  return (
    <div className="space-y-8">
      <DashboardHeader {...headerProps} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1">
          <div className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input type="text" placeholder="Search promises..." value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={16} /></button>}
          </div>
          <button onClick={() => setShowFilters(!showFilters)}
            className={`p-2.5 rounded-xl border transition-colors ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}>
            <Filter size={18} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => navigate("/billing/collections/dashboard")} className="px-4 py-2.5 text-sm font-medium text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50">
            Dashboard
          </button>
          <button onClick={() => setShowCreateModal(true)} className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-xl hover:bg-brand-700 transition-colors">
            <Plus size={16} /> New Promise
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
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
            className="appearance-none px-4 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Customer</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Promise Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Notes</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-16 text-center"><div className="animate-spin rounded-full h-8 w-8 border-4 border-slate-200 border-t-brand-600 mx-auto" /></td></tr>
              ) : promises.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center">
                      <HandCoins size={40} className="text-slate-300 mb-3" />
                      <p className="text-slate-500 font-medium">No promises to pay found</p>
                    </div>
                  </td>
                </tr>
              ) : promises.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-4 text-slate-600">{p.customer_name || `#${p.customer_id}`}</td>
                  <td className="px-4 py-4 text-right font-medium text-slate-800 whitespace-nowrap">{formatDisplayCurrency(p.promise_amount, "—")}</td>
                  <td className="px-4 py-4 text-slate-500 whitespace-nowrap">{formatDisplayDate(p.promise_date)}</td>
                  <td className="px-4 py-4"><StatusBadge status={p.status} /></td>
                  <td className="px-4 py-4 text-slate-500 max-w-xs truncate">{p.notes || "—"}</td>
                  <td className="px-4 py-4 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button onClick={() => openTimeline(p)} disabled={!!actionLoading}
                        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-brand-600 transition-colors disabled:opacity-40" title="View History">
                        <History size={15} />
                      </button>
                      {["pending", "overdue"].includes(p.status) && (
                        <>
                          <button onClick={() => setConfirmModal({ open: true, id: p.id, action: "fulfil", notes: "" })} disabled={!!actionLoading}
                            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-emerald-600 transition-colors disabled:opacity-40" title="Mark Fulfilled">
                            {actionLoading === `fulfil-${p.id}` ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
                          </button>
                          <button onClick={() => setConfirmModal({ open: true, id: p.id, action: "break", notes: "" })} disabled={!!actionLoading}
                            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-red-600 transition-colors disabled:opacity-40" title="Mark Broken">
                            {actionLoading === `break-${p.id}` ? <Loader2 size={15} className="animate-spin" /> : <XCircle size={15} />}
                          </button>
                          <button onClick={() => setConfirmModal({ open: true, id: p.id, action: "cancel", notes: "" })} disabled={!!actionLoading}
                            className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors disabled:opacity-40" title="Cancel">
                            {actionLoading === `cancel-${p.id}` ? <Loader2 size={15} className="animate-spin" /> : <Ban size={15} />}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
          {total} total promise(s)
        </Pagination>
      </div>

      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowCreateModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-800">Log a Promise to Pay</h3>
              <button onClick={() => setShowCreateModal(false)} className="p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <div className="p-6 space-y-4">
              {formError && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2"><AlertCircle className="h-4 w-4 flex-shrink-0" /> {formError}</div>}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Customer *</label>
                <select value={createForm.customer_id} onChange={(e) => handleCustomerChange(e.target.value)}
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">Select customer</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.display_name || c.company_name || `#${c.id}`}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Invoice (optional)</label>
                <select value={createForm.invoice_id} onChange={(e) => setCreateForm((p) => ({ ...p, invoice_id: e.target.value }))}
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">None</option>
                  {invoices.map((inv) => <option key={inv.id} value={inv.id}>{inv.invoice_number || `#${inv.id}`} — balance {formatDisplayCurrency(inv.balance_due, "—")}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Amount *</label>
                  <input type="number" min="0" step="0.01" value={createForm.promise_amount} onChange={(e) => setCreateForm((p) => ({ ...p, promise_amount: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Promise Date *</label>
                  <input type="date" value={createForm.promise_date} onChange={(e) => setCreateForm((p) => ({ ...p, promise_date: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Notes</label>
                <textarea value={createForm.notes} onChange={(e) => setCreateForm((p) => ({ ...p, notes: e.target.value }))} rows={2}
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200">
              <button onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">Cancel</button>
              <button onClick={handleCreate} disabled={saving || !canSubmit}
                className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5">
                {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Plus size={16} />} Create
              </button>
            </div>
          </div>
        </div>
      )}

      {timelinePromise && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setTimelinePromise(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <div>
                <h3 className="text-lg font-semibold text-slate-800">Promise History</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {timelinePromise.customer_name || `Customer #${timelinePromise.customer_id}`} · {formatDisplayCurrency(timelinePromise.promise_amount, "—")}
                </p>
              </div>
              <button onClick={() => setTimelinePromise(null)} className="p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <div className="p-6">
              {timelineError && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2"><AlertCircle className="h-4 w-4 flex-shrink-0" /> {timelineError}</div>}
              {timelineLoading ? (
                <div className="flex items-center justify-center py-10 text-slate-400"><Loader2 size={20} className="animate-spin" /></div>
              ) : timelineEntries.length === 0 ? (
                <p className="text-sm text-slate-500 text-center py-8">No history yet for this promise.</p>
              ) : (
                <ol className="relative border-l-2 border-brand-100 ml-2 space-y-5">
                  {timelineEntries.map((e, i) => (
                    <li key={e.metadata?.audit_id || e.metadata?.communication_id || i} className="ml-4">
                      <span className={`absolute -left-[7px] mt-1 h-3 w-3 rounded-full border-2 border-white ${e.event_type?.includes("fulfilled") ? "bg-emerald-500" : e.event_type?.includes("broken") ? "bg-red-500" : e.event_type?.includes("reminder") ? "bg-sky-500" : "bg-brand-400"}`} />
                      <div className="text-sm font-medium text-slate-800">{e.title}</div>
                      {e.description && <div className="text-xs text-slate-500 mt-0.5">{e.description}</div>}
                      <div className="text-[11px] text-slate-400 mt-0.5">{formatDisplayDate(e.timestamp)}</div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        </div>
      )}

      {confirmModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setConfirmModal({ open: false, id: null, action: null, notes: "" })}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-slate-900 mb-4">{CONFIRM_ACTIONS[confirmModal.action]?.label}</h2>
            <textarea value={confirmModal.notes} onChange={(e) => setConfirmModal((p) => ({ ...p, notes: e.target.value }))} rows={3}
              placeholder="Notes (optional)"
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 mb-4" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirmModal({ open: false, id: null, action: null, notes: "" })} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
              <button onClick={runConfirmedAction} className="px-6 py-2 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 inline-flex items-center gap-2">
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
