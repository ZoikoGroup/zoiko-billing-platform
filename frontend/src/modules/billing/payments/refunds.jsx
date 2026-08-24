import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Undo2, Send, Ban, Eye, Loader2,
} from "lucide-react";
import { refundApi, customerApi, paymentApi, invoiceApi, creditNoteApi } from "../../../service/billingService";
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
  { value: "processing", label: "Processing" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
];

const TYPE_OPTIONS = [
  { value: "full", label: "Full Refund" },
  { value: "partial", label: "Partial Refund" },
  { value: "credit_note_refund", label: "Credit Note Refund" },
  { value: "overpayment_refund", label: "Overpayment Refund" },
  { value: "duplicate_payment_refund", label: "Duplicate Payment Refund" },
  { value: "manual_refund", label: "Manual Refund" },
  { value: "offline_refund", label: "Offline Refund" },
];

const SOURCE_OPTIONS = [
  { value: "payment", label: "Payment" },
  { value: "invoice", label: "Invoice" },
  { value: "credit_note", label: "Credit Note" },
  { value: "customer_credit_balance", label: "Customer Credit Balance" },
];

const METHOD_OPTIONS = [
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "card_refund", label: "Card Refund" },
  { value: "upi", label: "UPI" },
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
  { value: "wallet", label: "Wallet" },
  { value: "manual_adjustment", label: "Manual Adjustment" },
];

const emptyCreateForm = (currency) => ({
  customer_id: "", refund_source: "payment", payment_id: "", invoice_id: "", credit_note_id: "",
  refund_type: "partial", amount: "", currency, refund_method: "", reference_number: "", reason: "",
});

export default function RefundsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [refunds, setRefunds] = useState([]);
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
  const [payments, setPayments] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [creditNotes, setCreditNotes] = useState([]);
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

  const fetchRefunds = useCallback(async () => {
    try {
      setError(null);
      if (!loading) setRefreshing(true);
      const data = await refundApi.list({
        page: safePage, per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        status: statusFilter || undefined,
        refund_type: typeFilter || undefined,
        sort_by: sortField, sort_order: sortDir,
      });
      setRefunds(extractArray(data));
      setTotal(data.total || 0);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message || "Failed to load refunds");
      setRefunds([]); setTotal(0);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter, typeFilter, sortField, sortDir]);

  useEffect(() => { fetchRefunds(); }, [fetchRefunds]);
  useEffect(() => { if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages); }, [totalPages, currentPage]);

  useEffect(() => {
    refundApi.getDashboardStats().then((d) => setStats(d || {})).catch(() => {});
  }, []);

  const fetchCustomers = useCallback(async () => {
    try { const data = await customerApi.list({ per_page: 100 }); setCustomers(extractArray(data)); }
    catch (e) { /* silent */ }
  }, []);

  useEffect(() => { if (showCreateModal) fetchCustomers(); }, [showCreateModal, fetchCustomers]);

  /* Deep-link support: ?create=1 and ?invoice_id=<id> prefill the create form */
  useEffect(() => {
    if (searchParams.get("create") !== "1" || showCreateModal) return;
    openCreateModal();
    if (!searchParams.get("invoice_id")) setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, showCreateModal]);

  useEffect(() => {
    const requestedInvoiceId = searchParams.get("invoice_id");
    if (!showCreateModal || !requestedInvoiceId || createForm.invoice_id) return;
    let cancelled = false;
    (async () => {
      try {
        const inv = await invoiceApi.get(requestedInvoiceId);
        if (cancelled) return;
        setCreateForm((p) => ({
          ...p,
          refund_source: "invoice",
          customer_id: inv.customer_id ? String(inv.customer_id) : p.customer_id,
          invoice_id: String(inv.id),
          amount: String(inv.balance_due ?? inv.total_amount ?? p.amount ?? ""),
          currency: inv.currency || p.currency,
        }));
        setInvoices((prev) => (prev.some((item) => item.id === inv.id) ? prev : [inv, ...prev]));
        if (inv.customer_id) {
          const customer = await customerApi.get(inv.customer_id).catch(() => null);
          if (!cancelled && customer) {
            setSelectedCustomer(customer);
            setCustomers((prev) => (prev.some((item) => item.id === customer.id) ? prev : [customer, ...prev]));
          }
        }
      } catch (err) {
        if (!cancelled) setFormError(err?.detail || err?.message || "Failed to prefill refund from invoice");
      } finally {
        if (!cancelled) setSearchParams({}, { replace: true });
      }
    })();
    return () => { cancelled = true; };
  }, [searchParams, showCreateModal, createForm.invoice_id, setSearchParams]);

  const handleSort = (key) => {
    const serverKey = key === "refund_number" ? "refund_number" : key === "amount" ? "amount" : "created_at";
    setSortField(serverKey);
    setSortDir((d) => d === "asc" ? "desc" : "asc");
  };

  const openCreateModal = () => {
    setCreateForm(emptyCreateForm(""));
    setSelectedCustomer(null);
    setPayments([]); setInvoices([]); setCreditNotes([]);
    setFormError(null); setShowCreateModal(true);
  };

  const handleCustomerChange = async (customerId) => {
    setCreateForm((p) => ({ ...p, customer_id: customerId, payment_id: "", invoice_id: "", credit_note_id: "" }));
    if (!customerId) { setSelectedCustomer(null); return; }
    try {
      const customer = await customerApi.get(customerId);
      setSelectedCustomer(customer);
      setCreateForm((p) => ({ ...p, currency: customer.currency || p.currency }));
    } catch (e) { setSelectedCustomer(null); }
    try {
      const [payRes, invRes, cnRes] = await Promise.all([
        paymentApi.list({ customer_id: customerId, per_page: 50, status: "cleared" }).catch(() => null),
        invoiceApi.list({ customer_id: customerId, per_page: 50, status: "paid,partially_paid,sent,overdue" }).catch(() => null),
        creditNoteApi.list({ customer_id: customerId, per_page: 50, status: "issued,partially_applied" }).catch(() => null),
      ]);
      setPayments(payRes ? extractArray(payRes) : []);
      setInvoices(invRes ? extractArray(invRes) : []);
      setCreditNotes(cnRes ? extractArray(cnRes) : []);
    } catch (e) { /* silent */ }
  };

  const handleSourceChange = (source) => {
    setCreateForm((p) => ({ ...p, refund_source: source, payment_id: "", invoice_id: "", credit_note_id: "" }));
  };

  const canSubmitAmount = createForm.customer_id && createForm.amount &&
    (createForm.refund_source !== "payment" || createForm.payment_id) &&
    (createForm.refund_source !== "invoice" || createForm.invoice_id) &&
    (createForm.refund_source !== "credit_note" || createForm.credit_note_id);

  const handleCreate = async () => {
    if (!canSubmitAmount) return;
    try {
      setSaving(true); setFormError(null);
      const body = {
        customer_id: Number(createForm.customer_id),
        refund_number: "auto",
        refund_type: createForm.refund_type,
        refund_source: createForm.refund_source,
        amount: Number(createForm.amount),
        currency: createForm.currency || undefined,
        refund_method: createForm.refund_method || undefined,
        reference_number: createForm.reference_number || undefined,
        reason: createForm.reason || undefined,
      };
      if (createForm.refund_source === "payment") body.payment_id = Number(createForm.payment_id);
      if (createForm.refund_source === "invoice") body.invoice_id = Number(createForm.invoice_id);
      if (createForm.refund_source === "credit_note") body.credit_note_id = Number(createForm.credit_note_id);
      await refundApi.create(body);
      setShowCreateModal(false);
      fetchRefunds();
    } catch (err) {
      setFormError(err?.detail || err?.message || "Failed to create refund");
    } finally { setSaving(false); }
  };

  const handleSubmitForApproval = async (id) => {
    setActionLoading(`submit-${id}`);
    try { await refundApi.submit(id); fetchRefunds(); }
    catch (err) { setError(err?.detail || err?.message || "Failed to submit refund"); }
    finally { setActionLoading(null); }
  };

  const handleCancelConfirm = async () => {
    const { id, reason } = cancelModal;
    setCancelModal({ open: false, id: null, reason: "" });
    setActionLoading(`cancel-${id}`);
    try { await refundApi.cancel(id, reason || "Cancelled by user"); fetchRefunds(); }
    catch (err) { setError(err?.detail || err?.message || "Failed to cancel refund"); }
    finally { setActionLoading(null); }
  };

  const hasActiveFilters = debouncedSearch || statusFilter || typeFilter;

  const columns = [
    {
      key: "refund_number",
      label: "Number",
      sortable: true,
      render: (r) => <span className="font-medium text-slate-800">{r.refund_number || `#${r.id}`}</span>,
    },
    {
      key: "customer",
      label: "Customer",
      render: (r) => <span>{r.customer_name || `#${r.customer_id}`}</span>,
    },
    {
      key: "refund_type",
      label: "Type",
      render: (r) => <span className="capitalize">{r.refund_type?.replace(/_/g, " ")}</span>,
    },
    {
      key: "refund_source",
      label: "Source",
      render: (r) => <span className="capitalize">{r.refund_source?.replace(/_/g, " ") || "—"}</span>,
    },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusBadge status={r.status} />,
    },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      sortable: true,
      render: (r) => <span className="font-medium whitespace-nowrap">{formatDisplayCurrency(r.amount, r.currency)}</span>,
    },
    {
      key: "created_at",
      label: "Date",
      sortable: true,
      render: (r) => <span className="whitespace-nowrap text-slate-500">{formatDisplayDate(r.created_at)}</span>,
    },
    {
      key: "actions",
      label: "Actions",
      align: "right",
      render: (r) => (
        <div className="inline-flex items-center gap-1">
          <button type="button" onClick={() => navigate(`/billing/refunds/${r.id}`)} aria-label={`View refund ${r.refund_number || r.id}`}
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50">
            <Eye size={15} />
          </button>
          {r.status === "draft" && (
            <button type="button" onClick={() => handleSubmitForApproval(r.id)} disabled={actionLoading === `submit-${r.id}`}
              aria-label={`Submit refund ${r.refund_number || r.id} for approval`}
              className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-amber-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-40">
              {actionLoading === `submit-${r.id}` ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          )}
          {["draft", "pending_approval", "approved", "failed"].includes(r.status) && (
            <button type="button" onClick={() => setCancelModal({ open: true, id: r.id, reason: "" })} disabled={!!actionLoading}
              aria-label={`Cancel refund ${r.refund_number || r.id}`}
              className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-40">
              {actionLoading === `cancel-${r.id}` ? <Loader2 size={15} className="animate-spin" /> : <Ban size={15} />}
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      <DashboardHeader
        title="Refunds"
        subtitle="Manage customer refunds across payments, invoices, and credit notes"
        icon={Undo2}
        iconGradient={DOMAIN_ACCENTS.refunds.chip}
        crumbs={[{ label: "Billing", href: "/billing" }, { label: "Payments", href: "/billing/payments/dashboard" }, {}]}
        lastUpdated={lastUpdated}
        onRefresh={() => fetchRefunds()}
        refreshing={refreshing}
      />

      {/* Server-backed KPIs */}
      <div className={DASHBOARD_KPI_GRID}>
        {stats === null ? (
          Array.from({ length: 4 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)
        ) : (
          <>
            <DashboardStatCard title="Total Refunds" value={(stats.total_count || 0).toLocaleString()} icon={Undo2} color={DOMAIN_ACCENTS.refunds.chip} />
            <DashboardStatCard title="Pending Approval" value={(stats.pending_approval_count || 0).toLocaleString()} color="from-amber-500 to-orange-500" />
            <DashboardStatCard title="Completed Value" value={Number(stats.completed_value || 0)} color="from-emerald-500 to-teal-500" />
            <DashboardStatCard title="Outstanding Value" value={Number(stats.outstanding_value || 0)} color="from-sky-500 to-cyan-500" />
          </>
        )}
      </div>

      <div>
        <ListToolbar
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search refunds..."
          filtersOpen={showFilters || !!hasActiveFilters}
          onToggleFilters={() => setShowFilters(!showFilters)}
          primaryLabel="New Refund"
          onPrimary={openCreateModal}
        >
          <Button variant="secondary" onClick={() => navigate("/billing/refunds/dashboard")}>Dashboard</Button>
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

        {error && refunds.length === 0 && !loading ? (
          <ErrorState message={error} onRetry={() => fetchRefunds()} />
        ) : (
          <>
            {error && (
              <div role="alert" className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {error}
              </div>
            )}
            <DataTable
          columns={columns}
          data={refunds}
          loading={loading}
          minWidth={960}
          sortKey={sortField}
          sortDir={sortDir}
          onSort={handleSort}
          rowKey={(r) => r.id}
          emptyIcon={Undo2}
          emptyTitle={hasActiveFilters ? "No refunds match your filters" : "No refunds yet"}
          emptyMessage={hasActiveFilters
            ? "Try adjusting your search or filters."
            : "Create your first refund."}
          emptyAction={!hasActiveFilters && !loading ? (
            <Button variant="primary" onClick={openCreateModal}>New Refund</Button>
          ) : undefined}
          footer={
            <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
              {total} total refund(s)
            </Pagination>
          }
        />
          </>
        )}
      </div>

      {/* Create refund */}
      <FormModal
        open={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSubmit={() => handleCreate()}
        title="Create Refund"
        description="Return funds to a customer from a payment, invoice balance, or credit note."
        icon={Undo2}
        busy={saving}
        error={formError}
        submitLabel="Create"
        size="lg"
      >
        <Field label="Customer" htmlFor="refund-customer" required>
          <Select id="refund-customer" value={createForm.customer_id} onChange={(v) => handleCustomerChange(v)}
            placeholder="Select customer"
            options={customers.map((c) => ({ value: String(c.id), label: c.display_name || c.company_name || `#${c.id}` }))} />
        </Field>
        {selectedCustomer && (
          <p className="-mt-2 text-xs text-slate-500">
            Available credit balance: {formatDisplayCurrency(selectedCustomer.credit_balance || 0, "—", selectedCustomer.currency)}
          </p>
        )}
        <div className="grid grid-cols-2 gap-4">
          <Field label="Source" htmlFor="refund-source" required>
            <Select id="refund-source" value={createForm.refund_source} onChange={(v) => handleSourceChange(v)}
              placeholder={null}
              options={SOURCE_OPTIONS} />
          </Field>
          <Field label="Type" htmlFor="refund-type" required>
            <Select id="refund-type" value={createForm.refund_type} onChange={(v) => setCreateForm((p) => ({ ...p, refund_type: v }))}
              placeholder={null}
              options={TYPE_OPTIONS} />
          </Field>
        </div>

        {createForm.refund_source === "payment" && (
          <Field label="Payment" htmlFor="refund-payment" required>
            <Select id="refund-payment" value={createForm.payment_id} onChange={(v) => setCreateForm((p) => ({ ...p, payment_id: v }))}
              placeholder="Select payment"
              options={payments.map((p) => ({
                value: String(p.id),
                label: `${p.payment_number || `#${p.id}`} — ${formatDisplayCurrency(p.amount, p.currency)}`,
              }))} />
          </Field>
        )}
        {createForm.refund_source === "invoice" && (
          <Field label="Invoice" htmlFor="refund-invoice" required>
            <Select id="refund-invoice" value={createForm.invoice_id} onChange={(v) => setCreateForm((p) => ({ ...p, invoice_id: v }))}
              placeholder="Select invoice"
              options={invoices.map((inv) => ({
                value: String(inv.id),
                label: `${inv.invoice_number || `#${inv.id}`} — paid ${formatDisplayCurrency(inv.paid_amount, inv.currency)}`,
              }))} />
          </Field>
        )}
        {createForm.refund_source === "credit_note" && (
          <Field label="Credit Note" htmlFor="refund-cn" required>
            <Select id="refund-cn" value={createForm.credit_note_id} onChange={(v) => setCreateForm((p) => ({ ...p, credit_note_id: v }))}
              placeholder="Select credit note"
              options={creditNotes.map((cn) => ({
                value: String(cn.id),
                label: `${cn.credit_note_number || `#${cn.id}`} — remaining ${formatDisplayCurrency(cn.remaining_amount, cn.currency)}`,
              }))} />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-4">
          <Field label="Amount" htmlFor="refund-amount" required>
            <input id="refund-amount" type="number" min="0" step="0.01" placeholder="0.00"
              value={createForm.amount}
              onChange={(e) => setCreateForm((p) => ({ ...p, amount: e.target.value }))}
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </Field>
          <Field label="Method" htmlFor="refund-method">
            <Select id="refund-method" value={createForm.refund_method} onChange={(v) => setCreateForm((p) => ({ ...p, refund_method: v }))}
              placeholder="Select method"
              options={METHOD_OPTIONS} />
          </Field>
        </div>
        <Field label="Reference Number" htmlFor="refund-ref">
          <input id="refund-ref" type="text" placeholder="Bank ref / UTR / cheque no."
            value={createForm.reference_number}
            onChange={(e) => setCreateForm((p) => ({ ...p, reference_number: e.target.value }))}
            className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </Field>
        <Field label="Reason" htmlFor="refund-reason">
          <textarea id="refund-reason" rows={2} placeholder="Reason for refund"
            value={createForm.reason}
            onChange={(e) => setCreateForm((p) => ({ ...p, reason: e.target.value }))}
            className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </Field>
      </FormModal>

      {/* Cancel refund — asks for a reason instead of hardcoding one */}
      <FormModal
        open={cancelModal.open}
        onClose={() => setCancelModal({ open: false, id: null, reason: "" })}
        onSubmit={handleCancelConfirm}
        title="Cancel Refund"
        description="This refund will be cancelled and no further processing will occur."
        icon={Ban}
        busy={!!actionLoading}
        submitLabel="Cancel Refund"
        size="sm"
      >
        <Field label="Reason (optional)" htmlFor="cancel-reason">
          <textarea id="cancel-reason" rows={2} placeholder="Why is this refund being cancelled?"
            value={cancelModal.reason}
            onChange={(e) => setCancelModal((p) => ({ ...p, reason: e.target.value }))}
            className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </Field>
      </FormModal>
    </div>
  );
}
