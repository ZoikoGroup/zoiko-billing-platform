import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  ScrollText, Send, Ban, Eye, Loader2, Clock, CheckCircle, Wallet,
} from "lucide-react";
import { writeOffApi, customerApi, invoiceApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import {
  Pagination, DashboardHeader, DashboardStatCard, DashboardStatCardSkeleton,
  DASHBOARD_KPI_GRID, StatusBadge, DOMAIN_ACCENTS, ErrorState,
} from "../../../components/billing-shared";
import {
  Button, ListToolbar, FormModal, DataTable, Field, Select,
} from "../../../components/billing-ui";

const ITEMS_PER_PAGE = 10;

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending Approval" },
  { value: "approved", label: "Approved" },
  { value: "executed", label: "Executed" },
  { value: "reversed", label: "Reversed" },
  { value: "cancelled", label: "Cancelled" },
];

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

const emptyCreateForm = (currency) => ({
  customer_id: "", write_off_source: "invoice", invoice_id: "",
  write_off_type: "bad_debt", adjustment_type: "", amount: "", currency, reason: "", notes: "",
});

export default function WriteOffsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [writeOffs, setWriteOffs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const [stats, setStats] = useState(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(searchParams.get("status") || "");
  const [typeFilter, setTypeFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortField, setSortField] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreateForm(""));
  const [customers, setCustomers] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [formError, setFormError] = useState(null);
  const [cancelModal, setCancelModal] = useState({ open: false, id: null, reason: "" });

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
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message || "Failed to load write-offs");
      setWriteOffs([]); setTotal(0);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter, typeFilter, sortField, sortDir]);

  useEffect(() => { fetchWriteOffs(); }, [fetchWriteOffs]);
  useEffect(() => { if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages); }, [totalPages, currentPage]);

  useEffect(() => {
    writeOffApi.getDashboardStats().then((d) => setStats(d || {})).catch(() => {});
  }, []);

  const fetchCustomers = useCallback(async () => {
    try { const data = await customerApi.list({ per_page: 100 }); setCustomers(extractArray(data)); }
    catch (e) { /* silent */ }
  }, []);

  useEffect(() => { if (showCreateModal) fetchCustomers(); }, [showCreateModal, fetchCustomers]);

  const handleSort = (key) => {
    const serverKey = key === "write_off_number" ? "write_off_number" : key === "amount" ? "amount" : "created_at";
    setSortField(serverKey);
    setSortDir((d) => d === "asc" ? "desc" : "asc");
  };

  const openCreateModal = () => {
    setCreateForm(emptyCreateForm(""));
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

  const canSubmitAmount = createForm.customer_id && createForm.amount &&
    (createForm.write_off_source !== "invoice" || createForm.invoice_id);

  const handleCreate = async () => {
    if (!canSubmitAmount) return;
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

  const handleSubmitForApproval = async (id) => {
    setActionLoading(`submit-${id}`);
    try { await writeOffApi.submit(id); fetchWriteOffs(); }
    catch (err) { setError(err?.detail || err?.message || "Failed to submit write-off"); }
    finally { setActionLoading(null); }
  };

  const handleCancelConfirm = async () => {
    const { id, reason } = cancelModal;
    setCancelModal({ open: false, id: null, reason: "" });
    setActionLoading(`cancel-${id}`);
    try { await writeOffApi.cancel(id, reason || "Cancelled by user"); fetchWriteOffs(); }
    catch (err) { setError(err?.detail || err?.message || "Failed to cancel write-off"); }
    finally { setActionLoading(null); }
  };

  const hasActiveFilters = debouncedSearch || statusFilter || typeFilter;

  const columns = [
    {
      key: "write_off_number",
      label: "Number",
      sortable: true,
      render: (w) => <span className="font-medium text-slate-800">{w.write_off_number || `#${w.id}`}</span>,
    },
    {
      key: "customer",
      label: "Customer",
      render: (w) => <span>{w.customer_name || `#${w.customer_id}`}</span>,
    },
    {
      key: "write_off_type",
      label: "Type",
      render: (w) => <span className="capitalize">{w.write_off_type?.replace(/_/g, " ")}</span>,
    },
    {
      key: "write_off_source",
      label: "Source",
      render: (w) => <span className="capitalize">{w.write_off_source?.replace(/_/g, " ") || "—"}</span>,
    },
    {
      key: "status",
      label: "Status",
      render: (w) => <StatusBadge status={w.status} />,
    },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      sortable: true,
      render: (w) => <span className="font-medium whitespace-nowrap">{formatDisplayCurrency(w.amount, w.currency)}</span>,
    },
    {
      key: "created_at",
      label: "Date",
      sortable: true,
      render: (w) => <span className="whitespace-nowrap text-slate-500">{formatDisplayDate(w.created_at)}</span>,
    },
    {
      key: "actions",
      label: "Actions",
      align: "right",
      render: (w) => (
        <div className="inline-flex items-center gap-1">
          <button type="button" onClick={() => navigate(`/billing/write-offs/${w.id}`)} aria-label={`View write-off ${w.write_off_number || w.id}`}
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50">
            <Eye size={15} />
          </button>
          {w.status === "draft" && (
            <button type="button" onClick={() => handleSubmitForApproval(w.id)} disabled={actionLoading === `submit-${w.id}`}
              aria-label={`Submit write-off ${w.write_off_number || w.id} for approval`}
              className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-amber-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-40">
              {actionLoading === `submit-${w.id}` ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          )}
          {["draft", "pending_approval", "approved"].includes(w.status) && (
            <button type="button" onClick={() => setCancelModal({ open: true, id: w.id, reason: "" })} disabled={!!actionLoading}
              aria-label={`Cancel write-off ${w.write_off_number || w.id}`}
              className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-40">
              {actionLoading === `cancel-${w.id}` ? <Loader2 size={15} className="animate-spin" /> : <Ban size={15} />}
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      <DashboardHeader
        title="Write-offs"
        subtitle="Write off bad debt, adjust balances, and record financial adjustments"
        icon={ScrollText}
        iconGradient={DOMAIN_ACCENTS.writeoffs.chip}
        crumbs={[{ label: "Billing", href: "/billing" }, { label: "Payments", href: "/billing/payments/dashboard" }, {}]}
        lastUpdated={lastUpdated}
        onRefresh={() => fetchWriteOffs()}
        refreshing={refreshing}
      />

      {/* Server-backed KPIs */}
      <div className={DASHBOARD_KPI_GRID}>
        {stats === null ? (
          Array.from({ length: 4 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)
        ) : (
          <>
            <DashboardStatCard title="Total Write-offs" value={(stats.total_count || 0).toLocaleString()} icon={ScrollText} color={DOMAIN_ACCENTS.writeoffs.chip} />
            <DashboardStatCard title="Pending Approval" value={(stats.pending_approval_count || 0).toLocaleString()} icon={Clock} color="from-amber-500 to-orange-500" />
            <DashboardStatCard title="Executed Value" value={Number(stats.executed_value || 0)} icon={CheckCircle} color="from-emerald-500 to-teal-500" />
            <DashboardStatCard title="Outstanding Value" value={Number(stats.outstanding_value || 0)} icon={Wallet} color="from-slate-400 to-slate-500" />
          </>
        )}
      </div>

      <div>
        <ListToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search write-offs..."
          filtersOpen={showFilters || !!hasActiveFilters}
          onToggleFilters={() => setShowFilters(!showFilters)}
          primaryLabel="New Write-off"
          onPrimary={openCreateModal}
        >
          <Button variant="secondary" onClick={() => navigate("/billing/write-offs/dashboard")}>Dashboard</Button>
        </ListToolbar>

        {showFilters && (
          <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }} aria-label="Filter by status"
              className="appearance-none rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30">
              {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setCurrentPage(1); }} aria-label="Filter by type"
              className="appearance-none rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30">
              <option value="">All Types</option>
              {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        )}

        {error && writeOffs.length === 0 && !loading ? (
          <ErrorState message={error} onRetry={() => fetchWriteOffs()} />
        ) : (
          <>
            {error && (
              <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {error}
              </div>
            )}
            <DataTable
          columns={columns}
          data={writeOffs}
          loading={loading}
          minWidth={960}
          sortKey={sortField}
          sortDir={sortDir}
          onSort={handleSort}
          rowKey={(w) => w.id}
          emptyIcon={ScrollText}
          emptyTitle={hasActiveFilters ? "No write-offs match your filters" : "No write-offs yet"}
          emptyMessage={hasActiveFilters
            ? "Try adjusting your search or filters."
            : "Create your first write-off."}
          emptyAction={!hasActiveFilters && !loading ? (
            <Button variant="primary" onClick={openCreateModal}>New Write-off</Button>
          ) : undefined}
          footer={
            <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
              {total} total write-off(s)
            </Pagination>
          }
        />
          </>
        )}
      </div>

      {/* Create write-off */}
      <FormModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={() => handleCreate()}
        title="Create Write-off"
        description="Write off bad debt or adjust an outstanding balance."
        icon={ScrollText}
        busy={saving}
        error={formError}
        submitLabel="Create"
        size="lg"
      >
        <Field label="Customer" htmlFor="wo-customer" required>
          <Select id="wo-customer" value={createForm.customer_id} onChange={(v) => handleCustomerChange(v)}
            placeholder="Select customer"
            options={customers.map((c) => ({ value: String(c.id), label: c.display_name || c.company_name || `#${c.id}` }))} />
        </Field>
        {selectedCustomer && (
          <p className="-mt-2 text-xs text-slate-500">
            Outstanding balance: {formatDisplayCurrency(selectedCustomer.outstanding_balance || 0, "—", selectedCustomer.currency)}
          </p>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Source" htmlFor="wo-source" required>
            <Select id="wo-source" value={createForm.write_off_source} onChange={(v) => handleSourceChange(v)}
              placeholder={null}
              options={SOURCE_OPTIONS} />
          </Field>
          <Field label="Type" htmlFor="wo-type" required>
            <Select id="wo-type" value={createForm.write_off_type} onChange={(v) => setCreateForm((p) => ({ ...p, write_off_type: v }))}
              placeholder={null}
              options={TYPE_OPTIONS} />
          </Field>
        </div>

        {createForm.write_off_source === "invoice" && (
          <Field label="Invoice" htmlFor="wo-invoice" required>
            <Select id="wo-invoice" value={createForm.invoice_id} onChange={(v) => setCreateForm((p) => ({ ...p, invoice_id: v }))}
              placeholder="Select invoice"
              options={invoices.map((inv) => ({
                value: String(inv.id),
                label: `${inv.invoice_number || `#${inv.id}`} — balance ${formatDisplayCurrency(inv.balance_due, inv.currency)}`,
              }))} />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount" htmlFor="wo-amount" required>
            <input id="wo-amount" type="number" min="0" step="0.01" placeholder="0.00"
              value={createForm.amount}
              onChange={(e) => setCreateForm((p) => ({ ...p, amount: e.target.value }))}
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </Field>
          <Field label="Adjustment Type" htmlFor="wo-adjustment">
            <Select id="wo-adjustment" value={createForm.adjustment_type} onChange={(v) => setCreateForm((p) => ({ ...p, adjustment_type: v }))}
              placeholder="None"
              options={ADJUSTMENT_TYPE_OPTIONS} />
          </Field>
        </div>
        <Field label="Reason" htmlFor="wo-reason">
          <textarea id="wo-reason" rows={2} placeholder="Reason for write-off"
            value={createForm.reason}
            onChange={(e) => setCreateForm((p) => ({ ...p, reason: e.target.value }))}
            className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </Field>
        <Field label="Notes" htmlFor="wo-notes">
          <textarea id="wo-notes" rows={2} placeholder="Additional internal notes"
            value={createForm.notes}
            onChange={(e) => setCreateForm((p) => ({ ...p, notes: e.target.value }))}
            className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </Field>
      </FormModal>

      {/* Cancel write-off — asks for a reason instead of hardcoding one */}
      <FormModal
        open={cancelModal.open}
        onClose={() => setCancelModal({ open: false, id: null, reason: "" })}
        onSubmit={handleCancelConfirm}
        title="Cancel Write-off"
        description="This write-off will be cancelled and no balance changes will occur."
        icon={Ban}
        busy={!!actionLoading}
        submitLabel="Cancel Write-off"
        size="sm"
      >
        <Field label="Reason (optional)" htmlFor="wo-cancel-reason">
          <textarea id="wo-cancel-reason" rows={2} placeholder="Why is this write-off being cancelled?"
            value={cancelModal.reason}
            onChange={(e) => setCancelModal((p) => ({ ...p, reason: e.target.value }))}
            className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </Field>
      </FormModal>
    </div>
  );
}
