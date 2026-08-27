import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Repeat, Search, Filter, X, ChevronDown, Plus, AlertCircle, CheckCircle, Clock, PauseCircle, XCircle, ArrowUpDown, DollarSign, TrendingUp, Percent, Loader2, Eye, Receipt, Play, UserCheck } from "lucide-react";
import { subscriptionApi, settingsApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { ErrorState, PageSkeleton, DashboardHeader, DashboardStatCard, DASHBOARD_KPI_GRID, Pagination, useConfirmationDialog } from "../../../components/billing-shared";
import { useTerminology } from "../utils/TerminologyContext";
import { useBillingDateRange } from "../utils/DateRangeContext";

const ITEMS_PER_PAGE = 10;

const STATUS_OPTIONS = [
  { value: "active", label: "Active", color: "bg-emerald-100 text-emerald-700" },
  { value: "paused", label: "Paused", color: "bg-amber-100 text-amber-700" },
  { value: "past_due", label: "Past Due", color: "bg-red-100 text-red-700" },
  { value: "cancelled", label: "Cancelled", color: "bg-slate-100 text-slate-500" },
  { value: "expired", label: "Expired", color: "bg-slate-100 text-slate-700" },
];

function StatusBadge({ status }) {
  const s = STATUS_OPTIONS.find((o) => o.value === status);
  if (!s) return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">{status || "unknown"}</span>;
  const icons = { active: CheckCircle, paused: PauseCircle, past_due: AlertCircle, cancelled: XCircle, expired: Clock };
  const Icon = icons[status] || Clock;
  return <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${s.color}`}><Icon size={12} /> {s.label}</span>;
}

function SortHeader({ field, label, sortField, sortDir, onSort, align }) {
  const active = sortField === field;
  return (
    <th scope="col" className={`px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer select-none hover:text-slate-700 ${align === "right" ? "text-right" : "text-left"}`} onClick={() => onSort(field)}
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}>
      <div className={`flex items-center gap-1 ${align === "right" ? "justify-end" : ""}`}>{label}<ArrowUpDown size={12} className={`${active ? "text-brand-600" : "text-slate-300"}`} /></div>
    </th>
  );
}

export default function SubscriptionListPage() {
  const navigate = useNavigate();
  const { singular } = useTerminology();

  const [subscriptions, setSubscriptions] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setCurrentPage(1); }, 400);
    return () => clearTimeout(timer);
  }, [search]);
  const [statusFilter, setStatusFilter] = useState("");
  const { range: dateRangeValue, setRange: setDateRangeValue, customStart, customEnd, applyCustomRange, reset: resetDateRange, dateRange } = useBillingDateRange();
  const [showFilters, setShowFilters] = useState(false);
  const [sortField, setSortField] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");
  const [currentPage, setCurrentPage] = useState(1);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [orgCurrency, setOrgCurrency] = useState("");
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  // ── Summary KPIs (fetched independently of pagination) ───────────────────
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const fetchSummary = useCallback(async () => {
    try {
      setSummaryLoading(true);
      const data = await subscriptionApi.summary();
      setSummary(data);
      if (data?.reporting_currency) setOrgCurrency(data.reporting_currency);
    } catch {
      // Non-critical: fall back to page-derived values if summary fails
    } finally {
      setSummaryLoading(false);
    }
  }, []);

  useEffect(() => {
    settingsApi.getConfig().then((cfg) => {
      if (cfg?.default_currency) setOrgCurrency(cfg.default_currency);
      else if (cfg?.currency) setOrgCurrency(cfg.currency);
    }).catch((err) => console.error("[SubList] Failed to load settings config:", err));
  }, []);

  // Backward-compat: redirect ?create=1 and ?contract_id to full-page create
  const [searchParams, setSearchParams] = useSearchParams();
  const createParam = searchParams.get("create");
  const contractIdParam = searchParams.get("contract_id");
  const customerIdParam = searchParams.get("customer_id");

  useEffect(() => {
    if (createParam === "1" || contractIdParam || customerIdParam) {
      const params = new URLSearchParams();
      if (contractIdParam) params.set("contract_id", contractIdParam);
      if (customerIdParam) params.set("customer_id", customerIdParam);
      const qs = params.toString();
      navigate(`/billing/subscriptions/create${qs ? `?${qs}` : ""}`, { replace: true });
    }
  }, [createParam, contractIdParam, customerIdParam, navigate]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchSubscriptions = useCallback(async (isInitial = false) => {
    try {
      setError(null);
      if (!isInitial) setRefreshing(true);
      const sortBy = sortField === "amount" ? "unit_price" : sortField === "customer" ? "customer_id" : sortField === "next_billing" ? "next_billing_at" : sortField;
      const data = await subscriptionApi.list({
        page: safePage, per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        status: statusFilter || undefined,
        date_from: dateRange.date_from || undefined,
        date_to: dateRange.date_to || undefined,
        sort_by: sortBy, sort_order: sortDir,
      });
      const items = extractArray(data);
      setSubscriptions(items);
      setTotal(data?.total || items.length || 0);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message || "Failed to load subscriptions");
      setSubscriptions([]); setTotal(0);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter, dateRange.date_from, dateRange.date_to, sortField, sortDir]);

  useEffect(() => { fetchSubscriptions(true); }, [fetchSubscriptions]);
  useEffect(() => { fetchSummary(); }, [fetchSummary]);
  useEffect(() => { if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages); }, [totalPages, currentPage]);

  const handleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
    setCurrentPage(1);
  };

  const handleSelectAll = () => {
    if (selectAll) { setSelectedIds(new Set()); setSelectAll(false); }
    else { setSelectedIds(new Set(subscriptions.map((s) => s.id))); setSelectAll(true); }
  };

  const handleSelectOne = (id) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
    setSelectAll(next.size === subscriptions.length && subscriptions.length > 0);
  };

  const handleBulkAction = async (action) => {
    if (selectedIds.size === 0) return;
    const labels = { pause: "pause", resume: "resume", cancel: "cancel" };
    const ok = await confirm({ title: `${labels[action]} subscriptions`, message: `${labels[action]} ${selectedIds.size} subscription(s)?`, confirmLabel: labels[action] });
    if (!ok) return;
    setBulkLoading(true);
    try {
      const ids = Array.from(selectedIds);
      const results = await Promise.allSettled(ids.map((id) => {
        if (action === "pause") return subscriptionApi.pause(id);
        if (action === "resume") return subscriptionApi.resume(id);
        if (action === "cancel") return subscriptionApi.cancel(id);
        return Promise.resolve();
      }));
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        setError(`${failed} of ${ids.length} subscription(s) could not be updated. The rest were applied.`);
      }
      setSelectedIds(new Set()); setSelectAll(false);
    } finally {
      await Promise.all([fetchSubscriptions(), fetchSummary()]);
      setBulkLoading(false);
    }
  };

  const handleExportJSON = () => {
    const blob = new Blob([JSON.stringify(subscriptions, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "subscriptions.json"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCSV = () => {
    const headers = ["Subscription #", singular, "Plan", "Amount", "Currency", "Status", "Next Billing", "Start Date", "End Date"];
    const rows = subscriptions.map((s) => [
      s.subscription_number || `#${s.id}`, s.customer_name || s.customer?.name || "",
      s.plan_name || s.plan?.name || "", s.amount || s.unit_price || 0, s.currency || orgCurrency,
      s.status || "", s.next_billing_at || "", s.start_date || "", s.current_term_end || "",
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "subscriptions.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  // ── KPI values: prefer summary (all-pages aggregate), fall back to page-derived ──
  const kpiTotal      = summary?.total         ?? total;
  const kpiActive     = summary?.active_count   ?? subscriptions.filter((s) => s.status === "active").length;
  const kpiPaused     = summary?.paused_count   ?? subscriptions.filter((s) => s.status === "paused").length;
  const kpiCancelled  = summary?.cancelled_count ?? subscriptions.filter((s) => s.status === "cancelled").length;
  const kpiExpiring   = summary?.expiring_count ?? subscriptions.filter((s) => {
    if (!s.current_term_end) return false;
    const diff = (new Date(s.current_term_end) - new Date()) / (1000 * 60 * 60 * 24);
    return diff > 0 && diff <= 30;
  }).length;
  const kpiMrr        = summary?.mrr   != null ? parseFloat(summary.mrr)  : 0;
  const kpiArr        = summary?.arr   != null ? parseFloat(summary.arr)  : 0;
  const reportingCurrency = summary?.reporting_currency || orgCurrency;

  // Next billing estimate: page-derived only (not in summary)
  const nextBillingAmount = subscriptions
    .filter((s) => s.next_billing_at)
    .reduce((sum, s) => sum + parseFloat(s.unit_price || s.amount || 0) * parseInt(s.quantity || 1), 0);

  const headerProps = {
    title: "Subscriptions",
    subtitle: "Enterprise recurring billing engine",
    icon: Repeat,
    lastUpdated,
    refreshing,
    onRefresh: () => { setRefreshing(true); fetchSubscriptions(); },
    onExportCSV: handleExportCSV,
    onExportJSON: handleExportJSON,
    dateRange: dateRangeValue,
    onDateRangeChange: setDateRangeValue,
    customStart,
    customEnd,
    onApplyCustomRange: applyCustomRange,
    onResetDateRange: resetDateRange,
  };

  if (loading) return <div className="space-y-8"><DashboardHeader {...headerProps} /><PageSkeleton rows={6} /></div>;
  if (error && subscriptions.length === 0) return <div className="space-y-8"><DashboardHeader {...headerProps} /><ErrorState message={error} onRetry={() => fetchSubscriptions(true)} /></div>;

  return (
    <div className="space-y-8">
      <DashboardHeader {...headerProps} />
      <div className="space-y-6">
        <div className={DASHBOARD_KPI_GRID}>
          <DashboardStatCard title="Subscriptions" value={kpiTotal} icon={UserCheck} color="from-slate-500 to-slate-600" loading={summaryLoading} onClick={() => { setStatusFilter(""); setCurrentPage(1); }} />
          <DashboardStatCard title="Active" value={kpiActive} icon={CheckCircle} color="from-emerald-500 to-emerald-600" loading={summaryLoading} onClick={() => { setStatusFilter("active"); setCurrentPage(1); }} />
          <DashboardStatCard title="Paused" value={kpiPaused} icon={PauseCircle} color="from-amber-500 to-orange-500" loading={summaryLoading} onClick={() => { setStatusFilter("paused"); setCurrentPage(1); }} />
          <DashboardStatCard title="Cancelled" value={kpiCancelled} icon={XCircle} color="from-slate-500 to-slate-600" loading={summaryLoading} onClick={() => { setStatusFilter("cancelled"); setCurrentPage(1); }} />
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          <DashboardStatCard title="Expiring Soon (30d)" value={kpiExpiring} icon={AlertCircle} color="from-red-500 to-rose-500" loading={summaryLoading} />
          <DashboardStatCard title="MRR" value={Number(kpiMrr)} currency={reportingCurrency} icon={TrendingUp} color="from-blue-500 to-blue-600" loading={summaryLoading} />
          <DashboardStatCard title="ARR" value={Number(kpiArr)} currency={reportingCurrency} icon={Percent} color="from-brand to-brand-hover" loading={summaryLoading} />
          <DashboardStatCard title="Next Billing Amt" value={Number(nextBillingAmount)} currency={reportingCurrency} icon={DollarSign} color="from-brand to-brand-hover" />
        </div>

        <div className="bg-white border border-slate-200 rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
          <div className="p-6 border-b border-slate-100">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3 flex-1">
                <div className="relative flex-1 max-w-md">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input type="text" placeholder="Search subscriptions..." value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-600"><X size={16} /></button>}
                </div>
                <button onClick={() => setShowFilters(!showFilters)} aria-label="Toggle filters"
                  className={`p-2.5 rounded-xl border transition-colors ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}>
                  <Filter size={18} />
                </button>
                {selectedIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 font-medium">{selectedIds.size} selected</span>
                    <button onClick={() => handleBulkAction("pause")} disabled={bulkLoading} aria-label={`Pause ${selectedIds.size} subscription(s)`}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-50 rounded-lg hover:bg-amber-100 disabled:opacity-50">
                      {bulkLoading ? <Loader2 size={12} className="animate-spin" /> : <PauseCircle size={12} />} Pause
                    </button>
                    <button onClick={() => handleBulkAction("resume")} disabled={bulkLoading} aria-label={`Resume ${selectedIds.size} subscription(s)`}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100 disabled:opacity-50">
                      <Play size={12} /> Resume
                    </button>
                    <button onClick={() => handleBulkAction("cancel")} disabled={bulkLoading} aria-label={`Cancel ${selectedIds.size} subscription(s)`}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-50">
                      <XCircle size={12} /> Cancel
                    </button>
                <button onClick={() => { setSelectedIds(new Set()); setSelectAll(false); }} aria-label="Clear selection"
                  className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-600"><X size={14} /></button>
              </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => navigate("/billing/subscriptions/create")}
                  className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg">
                  <Plus size={18} /> Create Subscription
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
                  <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                </div>
                {(statusFilter || dateRange.date_from || dateRange.date_to) && (
                  <button onClick={() => { setStatusFilter(""); resetDateRange(); setCurrentPage(1); }}
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
                    <input type="checkbox" checked={selectAll} onChange={handleSelectAll} aria-label="Select all subscriptions"
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Subscription</th>
                   <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{singular}</th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Plan</th>
                   <SortHeader field="amount" label="Amount" sortField={sortField} sortDir={sortDir} onSort={handleSort} align="right" />
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                  <SortHeader field="next_billing" label="Next Billing" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                  <SortHeader field="start_date" label="Start Date" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Billing</th>
                  <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {subscriptions.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-16 text-center">
                      <div className="flex flex-col items-center">
                        <Repeat size={40} className="text-slate-300 mb-3" />
                    <p className="text-slate-500 font-medium">No subscriptions found</p>
                    <p className="text-slate-500 text-sm mt-1">{search || statusFilter ? "Try adjusting your search or filters" : "Create your first subscription to get started"}</p>
                    {!search && !statusFilter && (
                      <button onClick={() => navigate("/billing/subscriptions/create")}
                        className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
                        <Plus size={16} /> Create your first subscription
                      </button>
                    )}
                      </div>
                    </td>
                  </tr>
                ) : subscriptions.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-4">
                      <input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => handleSelectOne(s.id)} aria-label={`Select subscription ${s.subscription_number || s.id}`}
                        className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                    </td>
                    <td className="px-4 py-4">
                      <button onClick={() => navigate(`/billing/subscriptions/${s.id}`)} className="font-medium text-slate-800 hover:text-brand-600 transition-colors whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Receipt size={14} className="text-slate-500" />
                          {s.subscription_number || `#${s.id}`}
                        </div>
                      </button>
                    </td>
                    <td className="px-4 py-4 text-slate-600">{s.customer_name || s.customer?.name || `${singular} #${s.customer_id}`}</td>
                    <td className="px-4 py-4 text-slate-600">{s.plan_name || s.plan?.name || `Plan #${s.plan_id}`}</td>
                     <td className="px-4 py-4 font-medium text-slate-800 whitespace-nowrap text-right">{formatDisplayCurrency(s.amount || s.unit_price, s.currency)}</td>
                    <td className="px-4 py-4"><StatusBadge status={s.status} /></td>
                    <td className="px-4 py-4 text-slate-500 text-xs">{formatDisplayDate(s.next_billing_at)}</td>
                    <td className="px-4 py-4 text-slate-500 text-xs">{formatDisplayDate(s.start_date)}</td>
                    <td className="px-4 py-4 text-slate-500 text-xs capitalize">{s.plan_billing_period || s.billing_period || "—"}</td>
                    <td className="px-4 py-4 text-right">
                      <button onClick={() => navigate(`/billing/subscriptions/${s.id}`)}
                        className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-brand-600 transition-colors" title="View">
                        <Eye size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
            {total} total subscription(s)
          </Pagination>
        </div>
      </div>
      {ConfirmationDialog}
    </div>
  );
}
