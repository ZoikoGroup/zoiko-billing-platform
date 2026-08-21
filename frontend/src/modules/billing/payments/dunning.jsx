import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell, Search, Filter, X, AlertCircle,
  ArrowUpCircle, FileText, Loader2, CheckCircle,
} from "lucide-react";
import { dunningApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import {
  ErrorState, DashboardHeader, DashboardStatCard, DASHBOARD_KPI_GRID,
  exportDashboardToCsv, exportDashboardToJson,
} from "../../../components/billing-shared";

const ITEMS_PER_PAGE = 10;

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "active", label: "Active" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
];

const LEVEL_OPTIONS = [
  { value: "", label: "All Levels" },
  { value: "1", label: "Level 1" },
  { value: "2", label: "Level 2" },
  { value: "3", label: "Level 3" },
  { value: "4", label: "Level 4" },
  { value: "5", label: "Level 5" },
];

function getStatusStyle(status) {
  const map = {
    active: "bg-amber-100 text-amber-700",
    resolved: "bg-emerald-100 text-emerald-700",
    closed: "bg-slate-100 text-slate-500",
  };
  return map[status] || "bg-slate-100 text-slate-600";
}

function getLevelStyle(level) {
  const map = {
    1: "bg-blue-100 text-blue-700",
    2: "bg-amber-100 text-amber-700",
    3: "bg-orange-100 text-orange-700",
    4: "bg-red-100 text-red-700",
    5: "bg-red-200 text-red-800",
  };
  return map[level] || map[1];
}

export default function DunningPage() {
  const navigate = useNavigate();

  const [cases, setCases] = useState([]);
  const [levels, setLevels] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);
  const [actionLoading, setActionLoading] = useState(null);
  const [resolveModal, setResolveModal] = useState({ open: false, caseId: null, note: "" });
  const [confirmModal, setConfirmModal] = useState({ open: false, caseId: null, action: null, title: "", message: "" });

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchData = useCallback(async (pageOverride) => {
    try {
      setLoading(true);
      setError(null);
      const page = pageOverride ?? safePage;
      const params = { page, per_page: ITEMS_PER_PAGE };
      if (debouncedSearch) params.search_term = debouncedSearch;
      if (statusFilter) params.status = statusFilter;
      if (levelFilter) params.current_level = levelFilter;
      const [caseData, levelData] = await Promise.all([
        dunningApi.listCases(params),
        dunningApi.listLevels().catch(() => []),
      ]);
      const items = extractArray(caseData);
      setCases(items);
      setTotal(caseData?.total || caseData?.total_count || items.length);
      setLevels(Array.isArray(levelData) ? levelData : []);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load dunning data");
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, statusFilter, levelFilter]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setLastUpdated(new Date());
    setRefreshing(false);
  }, [fetchData]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleEscalate = async (caseId) => {
    setActionLoading(`escalate-${caseId}`);
    try {
      await dunningApi.escalateCase(caseId);
      await fetchData();
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to escalate case");
    } finally { setActionLoading(null); }
  };

  const handleResolve = async () => {
    if (!resolveModal.caseId) return;
    setActionLoading("resolve");
    try {
      await dunningApi.resolveCase(resolveModal.caseId, resolveModal.note || null);
      setResolveModal({ open: false, caseId: null, note: "" });
      await fetchData();
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to resolve case");
    } finally { setActionLoading(null); }
  };

  const handleClose = async (caseId) => {
    setActionLoading(`close-${caseId}`);
    try {
      await dunningApi.closeCase(caseId);
      await fetchData();
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to close case");
    } finally { setActionLoading(null); }
  };

  const activeCases = cases.filter((c) => c.status === "active");
  const levelCounts = {};
  activeCases.forEach((c) => {
    const lvl = c.current_level || 1;
    levelCounts[lvl] = (levelCounts[lvl] || 0) + 1;
  });

  function clearFilters() {
    setSearch("");
    setStatusFilter("");
    setLevelFilter("");
    setCurrentPage(1);
  }

  const hasActiveFilters = debouncedSearch || statusFilter || levelFilter;

  const handleExport = useCallback((format) => {
    const payload = { cases: cases, levels: levels };
    if (format === "csv") exportDashboardToCsv(payload, "dunning-cases");
    else exportDashboardToJson(payload, "dunning-cases");
  }, [cases, levels]);

  const headerProps = {
    title: "Dunning",
    subtitle: "Manage automated dunning processes",
    icon: Bell,
    iconGradient: "from-amber-500 to-orange-500",
    lastUpdated,
    onRefresh: refreshAll,
    refreshing,
    onExportCSV: () => handleExport("csv"),
    onExportJSON: () => handleExport("json"),
  };

  return (
    <div className="space-y-8">
      <DashboardHeader {...headerProps} />
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
            <input type="text" placeholder="Search dunning cases..." value={search}
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
        <div className="flex items-center gap-2">
          <button onClick={() => navigate("/billing/dunning/levels")}
            className="px-3 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
            Dunning Levels
          </button>
          <button onClick={() => navigate("/billing/collections/dashboard")}
            className="px-3 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
            Dashboard
          </button>
        </div>
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
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Dunning Level</label>
              <select value={levelFilter} onChange={(e) => { setLevelFilter(e.target.value); setCurrentPage(1); }}
                className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                {LEVEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}

      <div className={DASHBOARD_KPI_GRID}>
        <DashboardStatCard title="Active Dunning Cases" value={activeCases.length} subtitle={`${cases.length} total`} icon={Bell} color="from-brand to-brand-hover" />
        <DashboardStatCard title="Level 1" value={levelCounts[1] || 0} subtitle="Initial reminder" icon={FileText} color="from-blue-500 to-blue-600" />
        <DashboardStatCard title="Level 2" value={levelCounts[2] || 0} subtitle="Second reminder" icon={ArrowUpCircle} color="from-amber-500 to-orange-500" />
        <DashboardStatCard title="Level 3+" value={(levelCounts[3] || 0) + (levelCounts[4] || 0) + (levelCounts[5] || 0)} subtitle="Escalated level" icon={AlertCircle} color="from-red-500 to-rose-500" />
      </div>

      <div className="bg-white rounded-3xl border border-slate-200">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={fetchData} />
        ) : cases.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Bell className="h-10 w-10 text-slate-300 mb-3" />
            <p className="text-sm font-medium text-slate-500 mb-1">No dunning cases found</p>
            <p className="text-xs text-slate-500">{hasActiveFilters ? "Try adjusting your filters." : "No active dunning processes at this time."}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100">
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Case ID</th>
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Customer</th>
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Invoice</th>
                  <th scope="col" className="text-right py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Overdue Amount</th>
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Level</th>
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Days Overdue</th>
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Status</th>
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Next Action</th>
                  <th scope="col" className="text-left py-3 px-4 font-medium text-slate-500 text-xs uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id} className="border-b border-slate-50 hover:bg-slate-50">
                    <td className="py-3 px-4 font-medium text-slate-900">#{c.id}</td>
                    <td className="py-3 px-4 text-slate-600">{c.customer_name || `Customer #${c.customer_id}`}</td>
                    <td className="py-3 px-4 text-slate-600">{c.invoice_number || `#${c.invoice_id}`}</td>
                    <td className="py-3 px-4 text-right font-medium text-slate-900">{formatDisplayCurrency(c.total_overdue_amount, c.currency)}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getLevelStyle(c.current_level)}`}>
                        Level {c.current_level || 1}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-600">{c.days_overdue || 0}d</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getStatusStyle(c.status)}`}>
                        {c.status ? c.status.charAt(0).toUpperCase() + c.status.slice(1) : "Unknown"}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-500 whitespace-nowrap">{c.next_action_at ? formatDisplayDate(c.next_action_at) : "—"}</td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1">
                        <button onClick={() => navigate(`/billing/dunning/${c.id}`)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-brand-600 bg-brand-50 rounded-lg hover:bg-brand-100">
                          <FileText className="h-3.5 w-3.5" /> View
                        </button>
                        {c.status === "active" && (
                          <>
                            <button onClick={() => setConfirmModal({ open: true, caseId: c.id, action: "escalate", title: "Escalate Case", message: "Are you sure you want to escalate this dunning case? This will increase the urgency level and may trigger more aggressive collection actions." })} disabled={!!actionLoading}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100 disabled:opacity-50">
                              {actionLoading === `escalate-${c.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />} Escalate
                            </button>
                            <button onClick={() => setResolveModal({ open: true, caseId: c.id, note: "" })} disabled={!!actionLoading}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100 disabled:opacity-50">
                              <CheckCircle className="h-3 w-3" /> Resolve
                            </button>
                            <button onClick={() => setConfirmModal({ open: true, caseId: c.id, action: "close", title: "Close Case", message: "Are you sure you want to close this dunning case? This will mark the case as closed and no further collection actions will be taken." })} disabled={!!actionLoading}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 disabled:opacity-50">
                              Close
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
    {resolveModal.open && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (actionLoading !== "resolve") setResolveModal({ open: false, caseId: null, note: "" }); }}>
        <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl mx-4" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-lg font-bold text-slate-900 mb-4">Resolve Dunning Case</h3>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Resolution Note (optional)</label>
            <textarea value={resolveModal.note} onChange={(e) => setResolveModal((p) => ({ ...p, note: e.target.value }))} rows={3}
              placeholder="Enter resolution details..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button onClick={() => setResolveModal({ open: false, caseId: null, note: "" })} disabled={actionLoading === "resolve"}
              className="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-lg">Cancel</button>
            <button onClick={handleResolve} disabled={actionLoading === "resolve"}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-50">
              {actionLoading === "resolve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
              Resolve
            </button>
          </div>
        </div>
      </div>
    )}

    {confirmModal.open && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (!actionLoading) setConfirmModal({ open: false, caseId: null, action: null, title: "", message: "" }); }}>
        <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl mx-4" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-lg font-bold text-slate-900 mb-4">{confirmModal.title}</h3>
          <p className="text-sm text-slate-600 mb-4">{confirmModal.message}</p>
          <div className="flex justify-end gap-3 mt-6">
            <button onClick={() => setConfirmModal({ open: false, caseId: null, action: null, title: "", message: "" })} disabled={!!actionLoading}
              className="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-lg">Cancel</button>
            <button onClick={async () => {
                const { caseId, action } = confirmModal;
                setConfirmModal({ open: false, caseId: null, action: null, title: "", message: "" });
                if (action === "escalate") await handleEscalate(caseId);
                else if (action === "close") await handleClose(caseId);
              }} disabled={!!actionLoading}
              className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 ${
                confirmModal.action === "escalate" ? "bg-amber-600 hover:bg-amber-700" : "bg-slate-600 hover:bg-slate-700"
              }`}>
              {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {confirmModal.action === "escalate" ? "Escalate" : "Close Case"}
            </button>
          </div>
        </div>
      </div>
    )}
    </div>
  );
}
