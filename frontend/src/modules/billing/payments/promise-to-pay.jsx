import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  HandCoins, History, CheckCircle, XCircle, Ban, Loader2, AlertTriangle,
} from "lucide-react";
import { promiseToPayApi, customerApi, invoiceApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import {
  Pagination, DashboardHeader, DashboardStatCard, DashboardStatCardSkeleton,
  DASHBOARD_KPI_GRID, StatusBadge, DOMAIN_ACCENTS,
  exportDashboardToCsv, exportDashboardToJson,
} from "../../../components/billing-shared";
import {
  Button, ListToolbar, FormModal, Modal, DataTable, Field, Select,
} from "../../../components/billing-ui";

const ITEMS_PER_PAGE = 10;

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "pending", label: "Pending" },
  { value: "overdue", label: "Overdue" },
  { value: "fulfilled", label: "Fulfilled" },
  { value: "broken", label: "Broken" },
  { value: "cancelled", label: "Cancelled" },
];

const CONFIRM_ACTIONS = {
  fulfil: { label: "Mark this promise as fulfilled?", api: promiseToPayApi.markFulfilled },
  break: { label: "Mark this promise as broken?", api: promiseToPayApi.markBroken },
  cancel: { label: "Cancel this promise to pay?", api: promiseToPayApi.cancel },
};

const INPUT_CLASS = "block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30";
const LABEL_CLASS = "mb-1 block text-xs font-medium text-slate-600";

const money = (v, currency) => formatDisplayCurrency(v, null, currency || undefined);

export default function PromiseToPayPage() {
  const navigate = useNavigate();

  const [promises, setPromises] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const [stats, setStats] = useState(null);
  const [statsFailed, setStatsFailed] = useState(false);

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

  /* ---------------- data ---------------- */

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

  useEffect(() => {
    let cancelled = false;
    promiseToPayApi.getDashboardStats()
      .then((data) => { if (!cancelled) setStats(data || {}); })
      .catch(() => { if (!cancelled) setStatsFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const fetchCustomers = useCallback(async () => {
    try { const data = await customerApi.list({ per_page: 100 }); setCustomers(extractArray(data)); }
    catch (e) { /* silent */ }
  }, []);

  useEffect(() => { if (showCreateModal) fetchCustomers(); }, [showCreateModal, fetchCustomers]);

  /* ---------------- actions ---------------- */

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
    try {
      await actionFn();
      fetchPromises();
      promiseToPayApi.getDashboardStats().then((d) => setStats(d || {})).catch(() => {});
    } catch (err) {
      setError(err?.detail || err?.message || `Failed to ${action}`);
    } finally { setActionLoading(null); }
  };

  const runConfirmedAction = async () => {
    const { id, action, notes } = confirmModal;
    setConfirmModal({ open: false, id: null, action: null, notes: "" });
    await handleAction(id, action, () => CONFIRM_ACTIONS[action].api(id, notes || undefined));
  };

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

  const canSubmit = createForm.customer_id && createForm.promise_amount && createForm.promise_date;
  const hasActiveFilters = Boolean(debouncedSearch || statusFilter);

  const handleExport = useCallback((format) => {
    const payload = { promises: promises };
    if (format === "csv") exportDashboardToCsv(payload, "promise-to-pay");
    else exportDashboardToJson(payload, "promise-to-pay");
  }, [promises]);

  /* ---------------- derived KPIs (server stats, never page slice) ---------------- */

  const openCount = (stats?.pending_count || 0) + (stats?.overdue_count || 0);

  /* ---------------- table ---------------- */

  const columns = [
    {
      key: "customer",
      label: "Customer",
      render: (p) => <span className="font-medium text-slate-800">{p.customer_name || `#${p.customer_id}`}</span>,
    },
    {
      key: "promise_amount",
      label: "Amount",
      align: "right",
      render: (p) => <span className="font-medium whitespace-nowrap">{money(p.promise_amount, p.currency)}</span>,
    },
    {
      key: "promise_date",
      label: "Promise Date",
      render: (p) => <span className="whitespace-nowrap">{formatDisplayDate(p.promise_date)}</span>,
    },
    {
      key: "status",
      label: "Status",
      render: (p) => <StatusBadge status={p.status} />,
    },
    {
      key: "notes",
      label: "Notes",
      headerClassName: "w-64",
      render: (p) => <span className="block max-w-xs truncate text-slate-500">{p.notes || "—"}</span>,
    },
    {
      key: "actions",
      label: "Actions",
      align: "right",
      render: (p) => (
        <div className="inline-flex items-center gap-1">
          <button type="button" onClick={() => openTimeline(p)} disabled={!!actionLoading} aria-label={`View history for promise ${p.id}`}
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-brand-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-40">
            <History size={15} />
          </button>
          {["pending", "overdue"].includes(p.status) && (
            <>
              <button type="button" onClick={() => setConfirmModal({ open: true, id: p.id, action: "fulfil", notes: "" })} disabled={!!actionLoading}
                aria-label={`Mark promise ${p.id} fulfilled`}
                className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-40">
                {actionLoading === `fulfil-${p.id}` ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
              </button>
              <button type="button" onClick={() => setConfirmModal({ open: true, id: p.id, action: "break", notes: "" })} disabled={!!actionLoading}
                aria-label={`Mark promise ${p.id} broken`}
                className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-40">
                {actionLoading === `break-${p.id}` ? <Loader2 size={15} className="animate-spin" /> : <XCircle size={15} />}
              </button>
              <button type="button" onClick={() => setConfirmModal({ open: true, id: p.id, action: "cancel", notes: "" })} disabled={!!actionLoading}
                aria-label={`Cancel promise ${p.id}`}
                className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-40">
                {actionLoading === `cancel-${p.id}` ? <Loader2 size={15} className="animate-spin" /> : <Ban size={15} />}
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
        title="Promise to Pay"
        subtitle="Track customer payment promises and their fulfillment status"
        icon={HandCoins}
        iconGradient={DOMAIN_ACCENTS.collections.chip}
        crumbs={[{ label: "Billing", href: "/billing" }, { label: "Collections", href: "/billing/collections/dashboard" }, {}]}
        lastUpdated={lastUpdated}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        onExportCSV={() => handleExport("csv")}
        onExportJSON={() => handleExport("json")}
      />

      {!statsFailed && (
        <div className={DASHBOARD_KPI_GRID}>
          {stats === null
            ? Array.from({ length: 4 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)
            : (
              <>
                <DashboardStatCard title="Open Promises" value={openCount.toLocaleString()} icon={HandCoins} color={DOMAIN_ACCENTS.collections.chip} />
                <DashboardStatCard title="Overdue" value={(stats.overdue_count || 0).toLocaleString()} icon={AlertTriangle} color="from-red-500 to-orange-500" />
                <DashboardStatCard title="Fulfilled" value={(stats.fulfilled_count || 0).toLocaleString()} icon={CheckCircle} color="from-emerald-500 to-teal-500" />
                <DashboardStatCard title="Broken" value={(stats.broken_count || 0).toLocaleString()} icon={XCircle} color="from-slate-400 to-slate-500" />
              </>
            )}
        </div>
      )}

      <div>
        <ListToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search promises..."
          filtersOpen={showFilters}
          onToggleFilters={() => setShowFilters(!showFilters)}
          primaryLabel="New Promise"
          onPrimary={() => { setFormError(null); setShowCreateModal(true); }}
        >
          <Button variant="secondary" onClick={() => navigate("/billing/collections/dashboard")}>Dashboard</Button>
        </ListToolbar>

        {showFilters && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
              aria-label="Filter by status"
              className="appearance-none rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
            >
              {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}

        {error && (
          <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        <DataTable
          columns={columns}
          data={promises}
          loading={loading}
          minWidth={860}
          emptyIcon={HandCoins}
          emptyTitle={hasActiveFilters ? "No promises match your filters" : "No promises to pay yet"}
          emptyMessage={hasActiveFilters
            ? "Try adjusting your search or status filter."
            : "Log a commitment when a customer promises to pay an outstanding balance."}
          emptyAction={!hasActiveFilters && !loading ? (
            <Button variant="primary" onClick={() => { setFormError(null); setShowCreateModal(true); }}>Log a Promise</Button>
          ) : undefined}
          footer={
            <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
              {total} total promise(s)
            </Pagination>
          }
        />
      </div>

      {/* Create promise */}
      <FormModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={() => { if (canSubmit) handleCreate(); }}
        title="Log a Promise to Pay"
        description="Record a customer's commitment to pay by a promised date."
        icon={HandCoins}
        busy={saving}
        error={formError}
        submitLabel="Create"
        submitIcon={HandCoins}
      >
        <Field label="Customer" htmlFor="ptp-customer" required>
          <Select
            id="ptp-customer"
            value={createForm.customer_id}
            onChange={(v) => handleCustomerChange(v)}
            placeholder="Select customer"
            options={customers.map((c) => ({ value: String(c.id), label: c.display_name || c.company_name || `#${c.id}` }))}
          />
        </Field>
        <Field label="Invoice (optional)" htmlFor="ptp-invoice">
          <Select
            id="ptp-invoice"
            value={createForm.invoice_id}
            onChange={(v) => setCreateForm((p) => ({ ...p, invoice_id: v }))}
            placeholder="None"
            options={invoices.map((inv) => ({
              value: String(inv.id),
              label: `${inv.invoice_number || `#${inv.id}`} — balance ${money(inv.balance_due, inv.currency)}`,
            }))}
          />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount" htmlFor="ptp-amount" required>
            <input id="ptp-amount" type="number" min="0" step="0.01" required
              value={createForm.promise_amount}
              onChange={(e) => setCreateForm((p) => ({ ...p, promise_amount: e.target.value }))}
              className={INPUT_CLASS} />
          </Field>
          <Field label="Promise Date" htmlFor="ptp-date" required>
            <input id="ptp-date" type="date" required
              value={createForm.promise_date}
              onChange={(e) => setCreateForm((p) => ({ ...p, promise_date: e.target.value }))}
              className={INPUT_CLASS} />
          </Field>
        </div>
        <Field label="Notes" htmlFor="ptp-notes">
          <textarea id="ptp-notes" rows={2} value={createForm.notes}
            onChange={(e) => setCreateForm((p) => ({ ...p, notes: e.target.value }))}
            className={INPUT_CLASS} />
        </Field>
      </FormModal>

      {/* Confirm action (fulfil / break / cancel) */}
      <FormModal
        open={confirmModal.open}
        onClose={() => setConfirmModal({ open: false, id: null, action: null, notes: "" })}
        onSubmit={runConfirmedAction}
        title={CONFIRM_ACTIONS[confirmModal.action]?.label || "Confirm"}
        busy={!!actionLoading}
        submitLabel="Confirm"
        size="sm"
      >
        <div>
          <label htmlFor="ptp-action-notes" className={LABEL_CLASS}>Notes (optional)</label>
          <textarea id="ptp-action-notes" rows={3} value={confirmModal.notes}
            onChange={(e) => setConfirmModal((p) => ({ ...p, notes: e.target.value }))}
            className={INPUT_CLASS} />
        </div>
      </FormModal>

      {/* Promise history */}
      <Modal
        open={!!timelinePromise}
        onClose={() => setTimelinePromise(null)}
        title="Promise History"
        description={timelinePromise
          ? `${timelinePromise.customer_name || `Customer #${timelinePromise.customer_id}`} · ${money(timelinePromise.promise_amount, timelinePromise.currency)}`
          : undefined}
        icon={History}
      >
        {timelineError && (
          <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {timelineError}
          </div>
        )}
        {timelineLoading ? (
          <div className="flex items-center justify-center py-10 text-slate-500"><Loader2 size={20} className="animate-spin" /></div>
        ) : timelineEntries.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">No history yet for this promise.</p>
        ) : (
          <ol className="relative ml-2 space-y-5 border-l-2 border-brand-100">
            {timelineEntries.map((e, i) => (
              <li key={e.metadata?.audit_id || e.metadata?.communication_id || i} className="ml-4">
                <span className={`absolute -left-[7px] mt-1 h-3 w-3 rounded-full border-2 border-white ${e.event_type?.includes("fulfilled") ? "bg-emerald-500" : e.event_type?.includes("broken") ? "bg-red-500" : e.event_type?.includes("reminder") ? "bg-sky-500" : "bg-brand-400"}`} />
                <div className="text-sm font-medium text-slate-800">{e.title}</div>
                {e.description && <div className="mt-0.5 text-xs text-slate-500">{e.description}</div>}
                <div className="mt-0.5 text-[11px] text-slate-500">{formatDisplayDate(e.timestamp)}</div>
              </li>
            ))}
          </ol>
        )}
      </Modal>
    </div>
  );
}
