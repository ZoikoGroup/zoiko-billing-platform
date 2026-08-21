import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Receipt, Search, Filter, X, RefreshCw,
  CheckCircle, XCircle, Clock, FileText, Loader2, Send } from "lucide-react"
import HRPage from "../../../components/HRPage";
import { creditNoteApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { sumInBaseCurrency } from "../../../utils/currency-conversion";
import { useCurrency } from "../utils/CurrencyContext";
import { ErrorState } from "../../../components/billing-shared";

const ITEMS_PER_PAGE = 10;

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "draft", label: "Draft" },
  { value: "approved", label: "Approved" },
  { value: "issued", label: "Issued" },
  { value: "partially_applied", label: "Partially Applied" },
  { value: "fully_applied", label: "Fully Applied" },
  { value: "voided", label: "Voided" },
];

const TYPE_OPTIONS = [
  { value: "", label: "All Types" },
  { value: "full_credit", label: "Full Credit" },
  { value: "partial_credit", label: "Partial Credit" },
  { value: "item_credit", label: "Item Credit" },
  { value: "service_credit", label: "Service Credit" },
  { value: "pricing_adjustment", label: "Pricing Adjustment" },
  { value: "tax_adjustment", label: "Tax Adjustment" },
  { value: "goodwill", label: "Goodwill" },
  { value: "refund", label: "Refund (legacy)" },
  { value: "write_off", label: "Write Off (legacy)" },
  { value: "adjustment", label: "Adjustment (legacy)" },
  { value: "promotional", label: "Promotional (legacy)" },
  { value: "cancellation", label: "Cancellation (legacy)" },
];

function getStatusStyle(status) {
  const map = {
    draft: "bg-slate-100 text-slate-600",
    approved: "bg-indigo-100 text-indigo-700",
    issued: "bg-blue-100 text-blue-700",
    partially_applied: "bg-amber-100 text-amber-700",
    fully_applied: "bg-emerald-100 text-emerald-700",
    voided: "bg-red-100 text-red-700",
  };
  return map[status] || "bg-slate-100 text-slate-600";
}

export default function CreditsPage() {
  const navigate = useNavigate();
  const { baseCurrency } = useCurrency();

  const [credits, setCredits] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);
  const [actionLoading, setActionLoading] = useState(null);
  const [voidModal, setVoidModal] = useState({ open: false, creditId: null, reason: "" });

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchCredits = useCallback(async (pageOverride) => {
    try {
      setLoading(true);
      setError(null);
      const page = pageOverride ?? safePage;
      const params = { page, per_page: ITEMS_PER_PAGE };
      if (debouncedSearch) params.search_term = debouncedSearch;
      if (statusFilter) params.status = statusFilter;
      if (typeFilter) params.credit_note_type = typeFilter;
      const data = await creditNoteApi.list(params);
      const items = extractArray(data);
      setCredits(items);
      setTotal(data?.total || data?.total_count || items.length);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load credits");
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, statusFilter, typeFilter]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await fetchCredits();
    setRefreshing(false);
  }, [fetchCredits]);

  useEffect(() => { fetchCredits(); }, [fetchCredits]);

  const handleApprove = async (creditId) => {
    setActionLoading(`approve-${creditId}`);
    try {
      await creditNoteApi.approve(creditId);
      await fetchCredits();
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to approve credit note");
    } finally { setActionLoading(null); }
  };

  const handleIssue = async (creditId) => {
    setActionLoading(`issue-${creditId}`);
    try {
      await creditNoteApi.issue(creditId);
      await fetchCredits();
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to issue credit note");
    } finally { setActionLoading(null); }
  };

  const handleVoid = async () => {
    if (!voidModal.creditId) return;
    setActionLoading("void");
    try {
      await creditNoteApi.void(voidModal.creditId, voidModal.reason || undefined);
      setVoidModal({ open: false, creditId: null, reason: "" });
      await fetchCredits();
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to void credit note");
    } finally { setActionLoading(null); }
  };

  const availableCredits = credits.filter((c) => c.status === "issued" || c.status === "partially_applied" || c.status === "draft" || c.status === "approved");
  const availableTotal = sumInBaseCurrency(availableCredits, baseCurrency).total;
  const issuedMtd = credits.filter((c) => c.status === "issued" || c.status === "partially_applied" || c.status === "fully_applied");
  const issuedMtdTotal = sumInBaseCurrency(issuedMtd, baseCurrency).total;
  const appliedMtd = credits.filter((c) => c.status === "partially_applied" || c.status === "fully_applied");
  const appliedMtdTotal = sumInBaseCurrency(appliedMtd, baseCurrency).total;

  function clearFilters() {
    setSearch("");
    setStatusFilter("");
    setTypeFilter("");
    setCurrentPage(1);
  }

  const hasActiveFilters = debouncedSearch || statusFilter || typeFilter;

  return (
    <>
    <HRPage title="Credits" subtitle="Manage customer credits and credit notes">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
            <input type="text" placeholder="Search credits..." value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-3 py-2 rounded-lg border border-slate-300 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 w-64" />
          </div>
          <button onClick={() => setShowFilters(!showFilters)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg border transition-colors ${
              showFilters || hasActiveFilters
                ? "border-brand-200 bg-brand-50 text-brand-700"
                : "border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}>
            <Filter className="h-4 w-4" /> Filters {hasActiveFilters && <span className="w-2 h-2 rounded-full bg-brand-500" />}
          </button>
          {hasActiveFilters && (
            <button onClick={clearFilters}
              className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium text-slate-600 hover:text-slate-800">
              <X className="h-4 w-4" /> Clear
            </button>
          )}
        </div>
        <button onClick={refreshAll} disabled={refreshing}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {showFilters && (
        <div className="mb-6 p-4 bg-white rounded-3xl border border-slate-200 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Status</label>
              <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Type</label>
              <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setCurrentPage(1); }}
                className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <Receipt className="h-5 w-5 text-brand-500" />
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Available Credits</p>
          </div>
          <p className="text-2xl font-bold text-slate-900">{formatDisplayCurrency(availableTotal, baseCurrency)}</p>
          <p className="text-xs text-slate-500 mt-1">{availableCredits.length} credit(s) available</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle className="h-5 w-5 text-blue-500" />
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Issued (MTD)</p>
          </div>
          <p className="text-2xl font-bold text-blue-600">{formatDisplayCurrency(issuedMtdTotal, baseCurrency)}</p>
          <p className="text-xs text-slate-500 mt-1">{issuedMtd.length} credit(s)</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-5 w-5 text-amber-500" />
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Applied (MTD)</p>
          </div>
          <p className="text-2xl font-bold text-amber-600">{formatDisplayCurrency(appliedMtdTotal, baseCurrency)}</p>
          <p className="text-xs text-slate-500 mt-1">{appliedMtd.length} credit(s)</p>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={fetchCredits} />
        ) : credits.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Receipt className="h-10 w-10 text-slate-300 mb-3" />
            <p className="text-sm font-medium text-slate-500 mb-1">No credits found</p>
            <p className="text-xs text-slate-500">{hasActiveFilters ? "Try adjusting your filters." : "No credit notes have been issued yet."}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Credit Note</th>
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Customer</th>
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Type</th>
                  <th scope="col" className="text-right py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Total</th>
                  <th scope="col" className="text-right py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Remaining</th>
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Status</th>
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Date</th>
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {credits.map((c) => (
                  <tr key={c.id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-3 px-4 font-medium text-slate-900">{c.credit_note_number || `#${c.id}`}</td>
                    <td className="py-3 px-4 text-slate-600">{c.customer_name || `Customer #${c.customer_id}`}</td>
                    <td className="py-3 px-4">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
                        {c.credit_note_type ? c.credit_note_type.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()) : "—"}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-medium text-slate-900">{formatDisplayCurrency(c.total_amount, c.currency)}</td>
                    <td className="py-3 px-4 text-right font-medium text-slate-900">{formatDisplayCurrency(c.remaining_amount || 0, c.currency)}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${getStatusStyle(c.status)}`}>
                        {c.status === "issued" ? <CheckCircle size={10} /> : c.status === "voided" ? <XCircle size={10} /> : <Clock size={10} />}
                        {c.status ? c.status.charAt(0).toUpperCase() + c.status.slice(1) : "Unknown"}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-500 whitespace-nowrap">{formatDisplayDate(c.issue_date || c.created_at)}</td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1">
                        <button onClick={() => navigate(`/billing/credit-notes/${c.id}`)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-brand-600 bg-brand-50 rounded-lg hover:bg-brand-100">
                          <FileText className="h-3.5 w-3.5" /> View
                        </button>
                        {c.status === "draft" && (
                          <button onClick={() => handleApprove(c.id)} disabled={!!actionLoading}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 rounded-lg hover:bg-indigo-100 disabled:opacity-50">
                            {actionLoading === `approve-${c.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />} Approve
                          </button>
                        )}
                        {c.status === "approved" && (
                          <button onClick={() => handleIssue(c.id)} disabled={!!actionLoading}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100 disabled:opacity-50">
                            {actionLoading === `issue-${c.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} Issue
                          </button>
                        )}
                        {(c.status === "issued" || c.status === "partially_applied") && (
                          <button onClick={() => setVoidModal({ open: true, creditId: c.id, reason: "" })} disabled={!!actionLoading}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-50">
                            <XCircle className="h-3 w-3" /> Void
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && !error && totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100">
            <p className="text-xs text-slate-500">
              Showing {Math.min((safePage - 1) * ITEMS_PER_PAGE + 1, total)}–{Math.min(safePage * ITEMS_PER_PAGE, total)} of {total}
            </p>
            <div className="flex items-center gap-1">
              <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}
                className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-40">
                Previous
              </button>
              {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                const start = Math.max(1, Math.min(safePage - 2, totalPages - 4));
                const page = start + i;
                if (page > totalPages) return null;
                return (
                  <button key={page} onClick={() => setCurrentPage(page)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
                      page === safePage ? "bg-brand-600 text-white" : "text-slate-600 bg-slate-100 hover:bg-slate-200"
                    }`}>
                    {page}
                  </button>
                );
              })}
              <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}
                className="px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-40">
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </HRPage>
    {voidModal.open && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (actionLoading !== "void") setVoidModal({ open: false, creditId: null, reason: "" }); }}>
        <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl mx-4" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-lg font-bold text-slate-900 mb-4">Void Credit Note</h3>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Reason (optional)</label>
            <textarea value={voidModal.reason} onChange={(e) => setVoidModal((p) => ({ ...p, reason: e.target.value }))} rows={3}
              placeholder="Enter reason for voiding..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button onClick={() => setVoidModal({ open: false, creditId: null, reason: "" })} disabled={actionLoading === "void"}
              className="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-lg">Cancel</button>
            <button onClick={handleVoid} disabled={actionLoading === "void"}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50">
              {actionLoading === "void" ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
              Void
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
