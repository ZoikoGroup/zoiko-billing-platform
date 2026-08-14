import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  FileText, Search, Filter, X, ChevronDown, Plus, CheckCircle, Clock, XCircle, ArrowUpDown, Ban, DollarSign, Wallet, TrendingUp, Percent, Loader2, Eye, Receipt,
} from "lucide-react";
import { contractApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { ErrorState, PageSkeleton, DashboardHeader, DashboardStatCard, DASHBOARD_KPI_GRID, Pagination, useConfirmationDialog } from "../../../components/billing-shared";
import { useTerminology } from "../utils/TerminologyContext";
import { useBillingDateRange } from "../utils/DateRangeContext";

const ITEMS_PER_PAGE = 10;

const STATUS_OPTIONS = [
  { value: "active", label: "Active", color: "bg-emerald-100 text-emerald-700" },
  { value: "pending", label: "Pending", color: "bg-blue-100 text-blue-700" },
  { value: "draft", label: "Draft", color: "bg-slate-100 text-slate-700" },
  { value: "expired", label: "Expired", color: "bg-gray-100 text-gray-700" },
  { value: "terminated", label: "Terminated", color: "bg-red-100 text-red-700" },
  { value: "cancelled", label: "Cancelled", color: "bg-slate-100 text-slate-500" },
];

const BILLING_PERIODS = [
  { value: "", label: "All Periods" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "semi_annual", label: "Semi-Annually" },
  { value: "annual", label: "Annually" },
];

function StatusBadge({ status }) {
  const s = STATUS_OPTIONS.find((o) => o.value === status);
  if (!s) return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700">{status || "unknown"}</span>;
  const icons = { active: CheckCircle, pending: Clock, draft: FileText, expired: Clock, terminated: XCircle, cancelled: Ban };
  const Icon = icons[status] || Clock;
  return <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${s.color}`}><Icon size={12} /> {s.label}</span>;
}

function SortHeader({ field, label, sortField, sortDir, onSort }) {
  const active = sortField === field;
  return (
    <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer select-none hover:text-slate-700" onClick={() => onSort(field)}>
      <div className="flex items-center gap-1">{label}<ArrowUpDown size={12} className={`${active ? "text-brand-600" : "text-slate-300"}`} /></div>
    </th>
  );
}

export default function ContractListPage() {
  const navigate = useNavigate();
  const { singular } = useTerminology();

  const [contracts, setContracts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [billingFilter, setBillingFilter] = useState("");
  const { range: dateRangeValue, setRange: setDateRangeValue, customStart, customEnd, applyCustomRange, reset: resetDateRange, dateRange } = useBillingDateRange();
  const [showFilters, setShowFilters] = useState(false);
  const [sortField, setSortField] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");
  const [currentPage, setCurrentPage] = useState(1);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  // ── Summary KPIs (fetched independently of pagination) ───────────────────
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const fetchSummary = useCallback(async () => {
    try {
      setSummaryLoading(true);
      const data = await contractApi.summary();
      setSummary(data);
    } catch {
      // Non-critical: fall back to page-derived values if summary fails
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setCurrentPage(1); }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchContracts = useCallback(async (isInitial = false) => {
    try {
      setError(null);
      if (!isInitial) setRefreshing(true);
      const sortBy = sortField === "value" ? "value" : sortField === "customer" ? "customer_id" : sortField === "start_date" ? "start_date" : sortField;
      const data = await contractApi.list({
        page: safePage, per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        status: statusFilter || undefined,
        billing_period: billingFilter || undefined,
        date_from: dateRange.date_from || undefined,
        date_to: dateRange.date_to || undefined,
        sort_by: sortBy, sort_order: sortDir,
      });
      const items = extractArray(data);
      setContracts(items);
      setTotal(data?.total || items.length || 0);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message || "Failed to load contracts");
      setContracts([]); setTotal(0);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter, billingFilter, dateRange.date_from, dateRange.date_to, sortField, sortDir]);

  useEffect(() => { fetchContracts(true); }, [fetchContracts]);
  useEffect(() => { fetchSummary(); }, [fetchSummary]);
  useEffect(() => { if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages); }, [totalPages, currentPage]);

  const handleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
    setCurrentPage(1);
  };

  const handleSelectAll = () => {
    if (selectAll) { setSelectedIds(new Set()); setSelectAll(false); }
    else { setSelectedIds(new Set(contracts.map((c) => c.id))); setSelectAll(true); }
  };

  const handleSelectOne = (id) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
    setSelectAll(next.size === contracts.length && contracts.length > 0);
  };

  const handleBulkAction = async (status) => {
    if (selectedIds.size === 0) return;
    const ok = await confirm({ title: `Mark as ${status}`, message: `Mark ${selectedIds.size} contract(s) as ${status}?`, confirmLabel: status });
    if (!ok) return;
    setBulkLoading(true);
    try {
      const ids = Array.from(selectedIds);
      const results = await Promise.allSettled(ids.map((id) => {
        if (status === "active") return contractApi.activate(id);
        if (status === "cancelled") return contractApi.cancel(id);
        if (status === "terminated") return contractApi.terminate(id);
        return Promise.resolve();
      }));
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        setError(`${failed} of ${ids.length} contract(s) could not be updated. The rest were applied.`);
      }
      setSelectedIds(new Set()); setSelectAll(false);
    } finally {
      await Promise.all([fetchContracts(), fetchSummary()]);
      setBulkLoading(false);
    }
  };

  const handleExportJSON = () => {
    const blob = new Blob([JSON.stringify(contracts, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "contracts.json"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCSV = () => {
    const headers = ["Contract #", "Name", singular, "Value", "Currency", "Status", "Start Date", "End Date", "Billing Period", "Auto Renew"];
    const rows = contracts.map((c) => [
      c.contract_number || `#${c.id}`, c.contract_name || "",
      c.customer_name || c.customer?.name || "", c.total_value || c.value || 0, c.currency || "",
      c.status || "", c.start_date || "", c.end_date || "",
      c.billing_period || "", c.auto_renew ? "Yes" : "No",
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "contracts.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  // ── KPI values: prefer summary (all-pages aggregate), fall back to page-derived ──
  const defaultCurrency = contracts.length > 0
    ? (contracts.find((c) => c.currency)?.currency || "")
    : "";

  const kpiTotal        = summary?.total         ?? total;
  const kpiActive       = summary?.active_count   ?? contracts.filter((c) => c.status === "active").length;
  const kpiExpiring     = summary?.expiring_count ?? contracts.filter((c) => {
    if (!c.end_date) return false;
    const diff = (new Date(c.end_date) - new Date()) / (1000 * 60 * 60 * 24);
    return diff > 0 && diff <= 30;
  }).length;
  const kpiExpired      = summary?.expired_count  ?? contracts.filter((c) => c.status === "expired").length;
  const kpiDraft        = summary?.draft_count    ?? contracts.filter((c) => c.status === "draft").length;
  const kpiTotalValue   = summary?.total_value    ?? contracts.reduce((s, c) => s + parseFloat(c.total_value || c.value || 0), 0);
  const kpiActiveValue  = summary?.active_value   ?? contracts.filter((c) => c.status === "active").reduce((s, c) => s + parseFloat(c.total_value || c.value || 0), 0);
  const kpiMrr          = summary?.mrr            ?? 0;
  const kpiArr          = summary?.arr            ?? kpiMrr * 12;

  const headerProps = {
    title: "Contracts",
    subtitle: "Enterprise commercial agreement workspace",
    icon: FileText,
    lastUpdated,
    refreshing,
    onRefresh: () => { setRefreshing(true); fetchContracts(); },
    onExportCSV: handleExportCSV,
    onExportJSON: handleExportJSON,
    dateRange: dateRangeValue,
    onDateRangeChange: setDateRangeValue,
    customStart,
    customEnd,
    onApplyCustomRange: applyCustomRange,
    onResetDateRange: resetDateRange,
  };

  if (loading) return <div className="space-y-8 px-4 py-6 sm:px-6"><DashboardHeader {...headerProps} /><PageSkeleton rows={6} /></div>;
  if (error && contracts.length === 0) return <div className="space-y-8 px-4 py-6 sm:px-6"><DashboardHeader {...headerProps} /><ErrorState message={error} onRetry={() => fetchContracts(true)} /></div>;

  return (
    <div className="space-y-8 px-4 py-6 sm:px-6">
      <DashboardHeader {...headerProps} />
      <div className="space-y-6">
        <div className={DASHBOARD_KPI_GRID}>
          <DashboardStatCard title="Contracts" value={kpiTotal} icon={FileText} color="from-slate-500 to-slate-600" loading={summaryLoading} onClick={() => { setStatusFilter(""); setCurrentPage(1); }} />
          <DashboardStatCard title="Active Contracts" value={kpiActive} icon={FileText} color="from-emerald-500 to-emerald-600" loading={summaryLoading} onClick={() => { setStatusFilter("active"); setCurrentPage(1); }} />
          <DashboardStatCard title="Expiring Soon (30d)" value={kpiExpiring} icon={Clock} color="from-amber-500 to-orange-500" loading={summaryLoading} />
          <DashboardStatCard title="Expired" value={kpiExpired} icon={XCircle} color="from-gray-500 to-slate-600" loading={summaryLoading} onClick={() => { setStatusFilter("expired"); setCurrentPage(1); }} />
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          <DashboardStatCard title="Draft" value={kpiDraft} icon={FileText} color="from-slate-500 to-slate-600" loading={summaryLoading} onClick={() => { setStatusFilter("draft"); setCurrentPage(1); }} />
          <DashboardStatCard title="Total Contract Value" value={Number(kpiTotalValue)} currency={defaultCurrency} icon={DollarSign} color="from-brand to-brand-hover" loading={summaryLoading} />
          <DashboardStatCard title="Active Value" value={Number(kpiActiveValue)} currency={defaultCurrency} icon={Wallet} color="from-emerald-500 to-emerald-600" loading={summaryLoading} />
          <DashboardStatCard title="Monthly Recurring" value={Number(kpiMrr)} currency={defaultCurrency} icon={TrendingUp} color="from-blue-500 to-blue-600" loading={summaryLoading} />
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          <DashboardStatCard title="Annual Recurring" value={Number(kpiArr)} currency={defaultCurrency} icon={Percent} color="from-brand to-brand-hover" loading={summaryLoading} />
        </div>

        <div className="bg-white border border-slate-200 rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
          <div className="p-6 border-b border-slate-100">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3 flex-1">
                <div className="relative flex-1 max-w-md">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input type="text" placeholder="Search contracts..." value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search contracts"
                    className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  {search && <button onClick={() => setSearch("")} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={16} /></button>}
                </div>
                <button onClick={() => setShowFilters(!showFilters)} aria-label="Toggle filters" aria-pressed={showFilters}
                  className={`p-2.5 rounded-xl border transition-colors ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}>
                  <Filter size={18} />
                </button>
                {selectedIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 font-medium">{selectedIds.size} selected</span>
                    <button onClick={() => handleBulkAction("active")} disabled={bulkLoading}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100 disabled:opacity-50">
                      {bulkLoading ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />} Activate
                    </button>
                    <button onClick={() => handleBulkAction("cancelled")} disabled={bulkLoading}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-50">
                      <XCircle size={12} /> Cancel
                    </button>
                    <button onClick={() => handleBulkAction("terminated")} disabled={bulkLoading}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100 disabled:opacity-50">
                      <Ban size={12} /> Terminate
                    </button>
                    <button onClick={() => { setSelectedIds(new Set()); setSelectAll(false); }} aria-label="Clear selection"
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"><X size={14} /></button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => navigate("/billing/contracts/create")}
                  className="flex items-center gap-2 px-5 py-2.5 bg-linear-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-2">
                  <Plus size={18} /> Create Contract
                </button>
              </div>
            </div>

            {showFilters && (
              <div className="flex flex-wrap items-center gap-3 mt-4 pt-4 border-t border-slate-100">
                <div className="relative">
                  <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                    className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                    <option value="">All Statuses</option>
                    {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                </div>
                <div className="relative">
                  <select value={billingFilter} onChange={(e) => { setBillingFilter(e.target.value); setCurrentPage(1); }}
                    className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                    {BILLING_PERIODS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                </div>
                {(statusFilter || billingFilter || dateRange.date_from || dateRange.date_to) && (
                  <button onClick={() => { setStatusFilter(""); setBillingFilter(""); resetDateRange(); setCurrentPage(1); }}
                    className="text-xs text-brand-600 hover:text-brand-700 font-medium">Clear filters</button>
                )}
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th scope="col" className="px-4 py-3 w-10">
                    <input type="checkbox" checked={selectAll} onChange={handleSelectAll}
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Contract</th>
                   <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{singular}</th>
                   <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Value</th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                  <SortHeader field="start_date" label="Start" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                  <SortHeader field="end_date" label="End" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Billing</th>
                  <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {contracts.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-16 text-center">
                      <div className="flex flex-col items-center">
                        <FileText size={40} className="text-slate-300 mb-3" />
                        <p className="text-slate-500 font-medium">No contracts found</p>
                        <p className="text-slate-400 text-sm mt-1">{search || statusFilter ? "Try adjusting your search or filters" : "Create your first contract to get started"}</p>
                      </div>
                    </td>
                  </tr>
                ) : contracts.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-4">
                      <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => handleSelectOne(c.id)}
                        className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                    </td>
                    <td className="px-4 py-4">
                      <button onClick={() => navigate(`/billing/contracts/${c.id}`)} className="font-medium text-slate-800 hover:text-brand-600 transition-colors whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Receipt size={14} className="text-slate-400" />
                          {c.contract_number || `#${c.id}`}
                        </div>
                        {c.contract_name && <p className="text-xs text-slate-400 mt-0.5">{c.contract_name}</p>}
                      </button>
                    </td>
                    <td className="px-4 py-4 text-slate-600">{c.customer_name || c.customer?.name || `${singular} #${c.customer_id}`}</td>
                     <td className="px-4 py-4 font-medium text-slate-800 whitespace-nowrap text-right">{formatDisplayCurrency(c.total_value || c.value, c.currency)}</td>
                    <td className="px-4 py-4"><StatusBadge status={c.status} /></td>
                    <td className="px-4 py-4 text-slate-500 text-xs">{formatDisplayDate(c.start_date)}</td>
                    <td className="px-4 py-4 text-slate-500 text-xs">{formatDisplayDate(c.end_date) || "—"}</td>
                    <td className="px-4 py-4 text-slate-500 text-xs capitalize">{c.billing_period?.replace(/_/g, " ") || "—"}</td>
                    <td className="px-4 py-4 text-right">
                      <button onClick={() => navigate(`/billing/contracts/${c.id}`)} aria-label={`View contract ${c.contract_number || `#${c.id}`}`}
                        className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-brand-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" title="View">
                        <Eye size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
            {total} total contract(s)
          </Pagination>
        </div>
      </div>
      {ConfirmationDialog}
    </div>
  );
}
