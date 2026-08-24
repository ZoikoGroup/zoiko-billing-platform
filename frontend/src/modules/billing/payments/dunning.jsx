import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell, AlertCircle, ArrowUpCircle, FileText, Loader2, CheckCircle, Wallet,
} from "lucide-react";
import { dunningApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import {
  ErrorState, DashboardHeader, DashboardStatCard, DashboardStatCardSkeleton,
  DASHBOARD_KPI_GRID, StatusBadge, DOMAIN_ACCENTS, Pagination,
  exportDashboardToCsv, exportDashboardToJson,
} from "../../../components/billing-shared";
import { Button, ListToolbar, FormModal, DataTable, Field } from "../../../components/billing-ui";
import { useCurrency } from "../utils/CurrencyContext";

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
  const { baseCurrency } = useCurrency();

  const [cases, setCases] = useState([]);
  const [levels, setLevels] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const hasLoadedOnce = useRef(false);

  const [stats, setStats] = useState(null);
  const [levelDist, setLevelDist] = useState([]);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);
  const [actionLoading, setActionLoading] = useState(null);
  const [resolveModal, setResolveModal] = useState({ open: false, caseId: null, note: "" });
  const [confirmModal, setConfirmModal] = useState({ open: false, caseId: null, action: null });

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      if (hasLoadedOnce.current) setRefreshing(true);
      else setLoading(true);
      const params = { page: safePage, per_page: ITEMS_PER_PAGE };
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
      setRefreshing(false);
      hasLoadedOnce.current = true;
    }
  }, [safePage, debouncedSearch, statusFilter, levelFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const refreshSidePanels = useCallback(() => {
    dunningApi.getDashboardStats().then((d) => setStats(d || {})).catch(() => {});
    dunningApi.getLevelDistribution().then((d) => setLevelDist(Array.isArray(d) ? d : [])).catch(() => {});
  }, []);

  useEffect(() => { refreshSidePanels(); }, [refreshSidePanels]);

  const afterAction = async () => {
    await fetchData();
    refreshSidePanels();
    setLastUpdated(new Date());
  };

  const handleEscalate = async (caseId) => {
    setActionLoading(`escalate-${caseId}`);
    try {
      await dunningApi.escalateCase(caseId);
      await afterAction();
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
      await afterAction();
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to resolve case");
    } finally { setActionLoading(null); }
  };

  const handleClose = async (caseId) => {
    setActionLoading(`close-${caseId}`);
    try {
      await dunningApi.closeCase(caseId);
      await afterAction();
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to close case");
    } finally { setActionLoading(null); }
  };

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

  /* Server-side totals (dunning dashboard-stats + level-distribution endpoints).
     Never derived from the current page slice. */
  const distFor = (lv) => levelDist.find((d) => String(d.level) === String(lv))?.count || 0;
  const level3Plus = levelDist
    .filter((d) => Number(d.level) >= 3)
    .reduce((sum, d) => sum + (d.count || 0), 0);

  const columns = [
    {
      key: "id",
      label: "Case ID",
      render: (c) => <span className="font-medium text-slate-900">#{c.id}</span>,
    },
    {
      key: "customer_name",
      label: "Customer",
      render: (c) => <span>{c.customer_name || `Customer #${c.customer_id}`}</span>,
    },
    {
      key: "invoice_number",
      label: "Invoice",
      render: (c) => <span>{c.invoice_number || `#${c.invoice_id}`}</span>,
    },
    {
      key: "total_overdue_amount",
      label: "Overdue Amount",
      align: "right",
      render: (c) => <span className="font-medium whitespace-nowrap">{formatDisplayCurrency(c.total_overdue_amount, c.currency)}</span>,
    },
    {
      key: "current_level",
      label: "Level",
      render: (c) => (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getLevelStyle(c.current_level)}`}>
          Level {c.current_level || 1}
        </span>
      ),
    },
    {
      key: "days_overdue",
      label: "Days Overdue",
      render: (c) => <span>{c.days_overdue || 0}d</span>,
    },
    {
      key: "status",
      label: "Status",
      render: (c) => <StatusBadge status={c.status} />,
    },
    {
      key: "next_action_at",
      label: "Next Action",
      render: (c) => <span className="whitespace-nowrap text-slate-500">{c.next_action_at ? formatDisplayDate(c.next_action_at) : "—"}</span>,
    },
    {
      key: "actions",
      label: "Actions",
      align: "right",
      render: (c) => (
        <div className="flex items-center justify-end gap-1">
          <button type="button" onClick={() => navigate(`/billing/dunning/${c.id}`)} aria-label={`View dunning case ${c.id}`}
            className="inline-flex items-center gap-1 rounded-lg bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-600 transition-colors hover:bg-brand-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50">
            <FileText className="h-3.5 w-3.5" /> View
          </button>
          {c.status === "active" && (
            <>
              <button type="button"
                onClick={() => setConfirmModal({ open: true, caseId: c.id, action: "escalate" })}
                disabled={!!actionLoading} aria-label={`Escalate dunning case ${c.id}`}
                className="inline-flex items-center gap-1 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-50">
                {actionLoading === `escalate-${c.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />} Escalate
              </button>
              <button type="button" onClick={() => setResolveModal({ open: true, caseId: c.id, note: "" })} disabled={!!actionLoading}
                aria-label={`Resolve dunning case ${c.id}`}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-50">
                <CheckCircle className="h-3 w-3" /> Resolve
              </button>
              <button type="button"
                onClick={() => setConfirmModal({ open: true, caseId: c.id, action: "close" })}
                disabled={!!actionLoading} aria-label={`Close dunning case ${c.id}`}
                className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-50">
                Close
              </button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      <DashboardHeader
        title="Dunning"
        subtitle="Manage automated dunning processes"
        icon={Bell}
        iconGradient={DOMAIN_ACCENTS.collections.chip}
        crumbs={[{ label: "Billing", href: "/billing" }, { label: "Collections", href: "/billing/collections/dashboard" }, {}]}
        lastUpdated={lastUpdated}
        onRefresh={fetchData}
        refreshing={refreshing}
        onExportCSV={() => handleExport("csv")}
        onExportJSON={() => handleExport("json")}
      />

      {!loading && (
        <ListToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search dunning cases..."
          filtersOpen={showFilters || !!hasActiveFilters}
          onToggleFilters={() => setShowFilters(!showFilters)}
          primaryLabel={null}
        >
          {hasActiveFilters && (
            <Button variant="ghost" onClick={clearFilters}>Clear</Button>
          )}
          <Button variant="secondary" onClick={() => navigate("/billing/dunning/levels")}>Dunning Levels</Button>
          <Button variant="secondary" onClick={() => navigate("/billing/collections/dashboard")}>Dashboard</Button>
        </ListToolbar>
      )}

      {showFilters && (
        <div className="rounded-3xl border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Field label="Status" htmlFor="dunning-status">
              <select id="dunning-status" value={statusFilter}
                onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
            <Field label="Dunning Level" htmlFor="dunning-level">
              <select id="dunning-level" value={levelFilter}
                onChange={(e) => { setLevelFilter(e.target.value); setCurrentPage(1); }}
                className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                {LEVEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </Field>
          </div>
        </div>
      )}

      {/* Server-backed KPIs */}
      <div className={DASHBOARD_KPI_GRID}>
        {stats === null ? (
          Array.from({ length: 4 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)
        ) : (
          <>
            <DashboardStatCard title="Active Dunning Cases" value={(stats.active_count || 0).toLocaleString()} subtitle={`${stats.total_count || 0} total`} icon={Bell} color={DOMAIN_ACCENTS.collections.chip} />
            <DashboardStatCard title="Total Overdue" value={Number(stats.total_overdue_amount || 0)} currency={baseCurrency} icon={Wallet} color="from-red-500 to-rose-500" />
            <DashboardStatCard title="Due for Action" value={(stats.due_for_action_count || 0).toLocaleString()} subtitle="Next action scheduled" icon={AlertCircle} color="from-amber-500 to-orange-500" />
            <DashboardStatCard title="Escalated to Collections" value={(stats.escalated_count || 0).toLocaleString()} icon={ArrowUpCircle} color="from-purple-500 to-violet-500" />
          </>
        )}
      </div>

      {/* Active-by-level summary (server level-distribution, org-wide) */}
      {levelDist.length > 0 && (
        <p className="-mt-4 text-xs text-slate-500">
          Active by level:{" "}
          {[1, 2].map((lv) => (
            <span key={lv} className="mr-3">L{lv}: {distFor(lv)}</span>
          ))}
          <span>L3+: {level3Plus}</span>
        </p>
      )}

      <div className="space-y-4">
        {error && cases.length > 0 && (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        {error && cases.length === 0 && !loading ? (
          <ErrorState message={error} onRetry={fetchData} />
        ) : (
          <DataTable
            columns={columns}
            data={cases}
            loading={loading}
            minWidth={1080}
            emptyIcon={Bell}
            emptyTitle={hasActiveFilters ? "No dunning cases match your filters" : "No dunning cases"}
            emptyMessage={hasActiveFilters
              ? "Try adjusting your search or filters."
              : "No active dunning processes at this time."}
            emptyAction={hasActiveFilters && !loading ? (
              <Button variant="secondary" onClick={clearFilters}>Clear Filters</Button>
            ) : undefined}
            footer={
              <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
                Showing {total === 0 ? 0 : Math.min((safePage - 1) * ITEMS_PER_PAGE + 1, total)}–{Math.min(safePage * ITEMS_PER_PAGE, total)} of {total}
              </Pagination>
            }
          />
        )}
      </div>

      {/* Resolve case */}
      <FormModal
        open={resolveModal.open}
        onClose={() => setResolveModal({ open: false, caseId: null, note: "" })}
        onSubmit={handleResolve}
        title="Resolve Dunning Case"
        icon={CheckCircle}
        busy={actionLoading === "resolve"}
        submitLabel="Resolve"
      >
        <Field label="Resolution Note (optional)" htmlFor="dunning-resolve-note">
          <textarea id="dunning-resolve-note" rows={3} value={resolveModal.note}
            onChange={(e) => setResolveModal((p) => ({ ...p, note: e.target.value }))}
            placeholder="Enter resolution details..."
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </Field>
      </FormModal>

      {/* Confirm escalate / close */}
      <FormModal
        open={confirmModal.open}
        onClose={() => setConfirmModal({ open: false, caseId: null, action: null })}
        onSubmit={() => {
          const { caseId, action } = confirmModal;
          setConfirmModal({ open: false, caseId: null, action: null });
          if (action === "escalate") handleEscalate(caseId);
          else if (action === "close") handleClose(caseId);
        }}
        title={confirmModal.action === "escalate" ? "Escalate Case" : "Close Case"}
        description={confirmModal.action === "escalate"
          ? "Are you sure you want to escalate this dunning case? This will increase the urgency level and may trigger more aggressive collection actions."
          : "Are you sure you want to close this dunning case? This will mark the case as closed and no further collection actions will be taken."}
        busy={!!actionLoading}
        submitLabel={confirmModal.action === "escalate" ? "Escalate" : "Close Case"}
        size="sm"
      />
    </div>
  );
}
