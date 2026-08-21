import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Receipt, Filter, X, RefreshCw, Download,
  Plus, AlertCircle, CheckCircle, FileText, Ban, Send, Eye, Edit,
} from "lucide-react";
import { creditNoteApi, customerApi, invoiceApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { PageSkeleton, ErrorState, StatusBadge as SharedStatusBadge, Pagination } from "../../../components/billing-shared";
import { useCurrency } from "../utils/CurrencyContext";
import { useTerminology } from "../utils/TerminologyContext";
import { PageHeader, Button, DataTable, SearchInput, Select, Modal } from "../../../components/billing-ui";

const ITEMS_PER_PAGE = 10;

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft", color: "bg-slate-100 text-slate-700" },
  { value: "approved", label: "Approved", color: "bg-indigo-100 text-indigo-700" },
  { value: "issued", label: "Issued", color: "bg-blue-100 text-blue-700" },
  { value: "partially_applied", label: "Partially Applied", color: "bg-amber-100 text-amber-700" },
  { value: "fully_applied", label: "Fully Applied", color: "bg-emerald-100 text-emerald-700" },
  { value: "voided", label: "Voided", color: "bg-red-100 text-red-700" },
];

const TYPE_OPTIONS = [
  { value: "full_credit", label: "Full Credit" },
  { value: "partial_credit", label: "Partial Credit" },
  { value: "item_credit", label: "Item Credit" },
  { value: "service_credit", label: "Service Credit" },
  { value: "pricing_adjustment", label: "Pricing Adjustment" },
  { value: "tax_adjustment", label: "Tax Adjustment" },
  { value: "goodwill", label: "Goodwill" },
  { value: "refund", label: "Refund (legacy)" },
  { value: "adjustment", label: "Adjustment (legacy)" },
  { value: "promotional", label: "Promotional (legacy)" },
  { value: "write_off", label: "Write Off (legacy)" },
  { value: "cancellation", label: "Cancellation (legacy)" },
];

const inputClass = "block w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-500 transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30";

export default function CreditNotesPage() {
  const { singular, plural, getLabel } = useTerminology();
  const navigate = useNavigate();
  const { baseCurrency } = useCurrency();
  const [searchParams, setSearchParams] = useSearchParams();

  const [creditNotes, setCreditNotes] = useState([]);
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

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showApplyModal, setShowApplyModal] = useState(false);
  const [showApplicationsModal, setShowApplicationsModal] = useState(false);
  const [selectedCN, setSelectedCN] = useState(null);
  const [applications, setApplications] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [outstandingTotal, setOutstandingTotal] = useState(0);

  const [createForm, setCreateForm] = useState({
    customer_id: "", invoice_id: "", credit_note_type: "full_credit",
    reason: "", total_amount: "", tax_amount: "0", subtotal: "", discount_amount: "0",
    currency: "USD", issue_date: new Date().toISOString().split("T")[0],
  });
  const [editForm, setEditForm] = useState({ reason: "", total_amount: "", tax_amount: "", subtotal: "", discount_amount: "" });
  const [applyForm, setApplyForm] = useState({ invoice_id: "", amount: "" });
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [formError, setFormError] = useState(null);
  const [prefillNotice, setPrefillNotice] = useState("");

  const [sortField, setSortField] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setCurrentPage(1); }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const sortParam = sortDir === "desc" ? `-${sortField}` : sortField;

  const fetchCreditNotes = useCallback(async () => {
    try {
      setError(null);
      if (!loading) setRefreshing(true);
      const data = await creditNoteApi.list({
        page: safePage, per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        status: statusFilter || undefined,
        credit_note_type: typeFilter || undefined,
      });
      setCreditNotes(extractArray(data));
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.message || "Failed to load credit notes");
      setCreditNotes([]); setTotal(0);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter, typeFilter]);

  useEffect(() => { fetchCreditNotes(); }, [fetchCreditNotes]);
  useEffect(() => { if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages); }, [totalPages, currentPage]);

  const fetchCustomers = useCallback(async () => {
    try { const data = await customerApi.list({ per_page: 100 }); setCustomers(extractArray(data)); }
    catch (e) { /* silent */ }
  }, []);

  const fetchInvoices = useCallback(async () => {
    try { const data = await invoiceApi.list({ per_page: 100, status: "sent,paid,partially_paid,overdue" }); setInvoices(extractArray(data)); }
    catch (e) { /* silent */ }
  }, []);

  const fetchOutstanding = useCallback(async () => {
    try { const data = await creditNoteApi.getOutstanding(); setOutstandingTotal(data.outstanding_credits || 0); }
    catch (e) { /* silent */ }
  }, []);

  useEffect(() => {
    if (showCreateModal) { fetchCustomers(); fetchInvoices(); }
  }, [showCreateModal, fetchCustomers, fetchInvoices]);

  useEffect(() => {
    fetchOutstanding();
  }, [fetchOutstanding]);

  const applyInvoiceToCreateForm = useCallback((inv) => {
    if (!inv) return;
    const total = Number(inv.balance_due || inv.total_amount || inv.total || inv.amount || 0);
    const tax = Number(inv.tax_amount || 0);
    setCreateForm((p) => ({
      ...p,
      customer_id: inv.customer_id ? String(inv.customer_id) : p.customer_id,
      invoice_id: inv.id ? String(inv.id) : p.invoice_id,
      total_amount: total ? String(total) : p.total_amount,
      subtotal: total ? String(Math.max(0, total - tax)) : p.subtotal,
      tax_amount: String(tax || 0),
      currency: inv.currency || p.currency,
      reason: p.reason || `Credit for ${inv.invoice_number || `invoice #${inv.id}`}`,
    }));
  }, []);

  useEffect(() => {
    const invoiceId = searchParams.get("invoice_id");
    if (!invoiceId || showCreateModal) return;
    let cancelled = false;
    async function prefillFromInvoice() {
      try {
        const inv = await invoiceApi.get(invoiceId);
        if (cancelled) return;
        applyInvoiceToCreateForm(inv);
        setInvoices((prev) => prev.some((item) => item.id === inv.id) ? prev : [inv, ...prev]);
        if (inv.customer_id) {
          customerApi.get(inv.customer_id).then((customer) => {
            setCustomers((prev) => prev.some((item) => item.id === customer.id) ? prev : [customer, ...prev]);
          }).catch((err) => console.error("[CreditNotes] Failed to load customer:", err));
        }
        setPrefillNotice(`Preselected ${inv.invoice_number || `invoice #${inv.id}`} for this credit note.`);
        setFormError(null);
        setShowCreateModal(true);
        setSearchParams({}, { replace: true });
      } catch (err) {
        setFormError(err?.detail || err?.message || "Failed to prefill credit note from invoice");
      }
    }
    prefillFromInvoice();
    return () => { cancelled = true; };
  }, [searchParams, showCreateModal, applyInvoiceToCreateForm, setSearchParams]);

  const handleRefresh = () => { setRefreshing(true); fetchCreditNotes(); fetchOutstanding(); };
  const toggleSort = (field) => { setSortField(field); setSortDir((d) => (field === sortField ? (d === "asc" ? "desc" : "asc") : "asc")); };

  const openCreateModal = () => {
    setCreateForm({
      customer_id: "", invoice_id: "", credit_note_type: "full_credit",
      reason: "", total_amount: "", tax_amount: "0", subtotal: "", discount_amount: "0",
      currency: baseCurrency, issue_date: new Date().toISOString().split("T")[0],
    });
    setPrefillNotice("");
    setFormError(null); setShowCreateModal(true);
  };

  const openEditModal = (cn) => {
    setSelectedCN(cn);
    setEditForm({
      reason: cn.reason || "", total_amount: String(cn.total_amount || ""),
      tax_amount: String(cn.tax_amount || "0"), subtotal: String(cn.subtotal || ""),
      discount_amount: String(cn.discount_amount || "0"),
    });
    setFormError(null); setShowEditModal(true);
  };

  const openApplyModal = (cn) => {
    setSelectedCN(cn);
    setApplyForm({ invoice_id: "", amount: String(cn.remaining_amount || cn.total_amount || "") });
    setFormError(null);
    fetchInvoices(); setShowApplyModal(true);
  };

  const openApplicationsModal = async (cn) => {
    try {
      setSelectedCN(cn);
      const data = await creditNoteApi.listApplications(cn.id);
      setApplications(Array.isArray(data) ? data : []);
      setShowApplicationsModal(true);
    } catch (err) {
      setFormError(err.message || "Failed to load applications");
    }
  };

  const handleCreate = async () => {
    try {
      setSaving(true); setFormError(null);
      await creditNoteApi.create({
        customer_id: Number(createForm.customer_id),
        invoice_id: createForm.invoice_id ? Number(createForm.invoice_id) : undefined,
        credit_note_number: "auto",
        credit_note_type: createForm.credit_note_type,
        reason: createForm.reason || undefined,
        total_amount: Number(createForm.total_amount),
        tax_amount: Number(createForm.tax_amount || 0),
        subtotal: Number(createForm.subtotal || createForm.total_amount),
        discount_amount: Number(createForm.discount_amount || 0),
        currency: createForm.currency,
        issue_date: createForm.issue_date,
      });
      setShowCreateModal(false);
      fetchCreditNotes(); fetchOutstanding();
    } catch (err) {
      setFormError(err?.detail || err?.message || "Failed to create credit note");
    } finally { setSaving(false); }
  };

  const handleEdit = async () => {
    if (!selectedCN) return;
    try {
      setSaving(true); setFormError(null);
      await creditNoteApi.update(selectedCN.id, {
        reason: editForm.reason || undefined,
        total_amount: editForm.total_amount ? Number(editForm.total_amount) : undefined,
        tax_amount: editForm.tax_amount ? Number(editForm.tax_amount) : undefined,
        subtotal: editForm.subtotal ? Number(editForm.subtotal) : undefined,
        discount_amount: editForm.discount_amount ? Number(editForm.discount_amount) : undefined,
      });
      setShowEditModal(false);
      fetchCreditNotes();
    } catch (err) {
      setFormError(err?.detail || err?.message || "Failed to update credit note");
    } finally { setSaving(false); }
  };

  const handleAction = async (action, actionFn) => {
    setActionLoading(action);
    try { await actionFn(); fetchCreditNotes(); fetchOutstanding(); }
    catch (err) { setError(err?.detail || err?.message || `Failed to ${action} credit note`); }
    finally { setActionLoading(null); }
  };

  const handleApply = async () => {
    if (!selectedCN) return;
    try {
      setSaving(true); setFormError(null);
      await creditNoteApi.applyToInvoice(selectedCN.id, {
        invoice_id: Number(applyForm.invoice_id),
        amount: Number(applyForm.amount),
      });
      setShowApplyModal(false);
      fetchCreditNotes(); fetchOutstanding();
    } catch (err) {
      setFormError(err?.detail || err?.message || "Failed to apply credit note");
    } finally { setSaving(false); }
  };

  const handleExportJSON = () => {
    const blob = new Blob([JSON.stringify(creditNotes, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "credit-notes.json"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCSV = () => {
    const headers = ["ID", "Number", "Type", "Status", `${singular} ID`, "Invoice ID", "Total", "Remaining", "Currency", "Issue Date", "Reason"];
    const rows = creditNotes.map((cn) => [cn.id, cn.credit_note_number, cn.credit_note_type, cn.status, cn.customer_id, cn.invoice_id || "", cn.total_amount, cn.remaining_amount, cn.currency, cn.issue_date, cn.reason || ""]);
    const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "credit-notes.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const StatusBadge = ({ status }) => (
    <SharedStatusBadge status={status} options={STATUS_OPTIONS} />
  );

  const actionBtn = "rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:opacity-40 disabled:cursor-not-allowed";

  const renderActions = (cn) => (
    <div className="inline-flex items-center justify-end gap-1">
      <button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/billing/credit-notes/${cn.id}`); }}
        className={`${actionBtn} hover:text-slate-700`} title="View" aria-label="View credit note">
        <Eye size={15} />
      </button>
      {cn.status === "draft" && (
        <>
          <button type="button" onClick={(e) => { e.stopPropagation(); openEditModal(cn); }}
            className={`${actionBtn} hover:text-blue-600`} title="Edit" aria-label="Edit credit note">
            <Edit size={15} />
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); handleAction("approve", () => creditNoteApi.approve(cn.id)); }} disabled={actionLoading === "approve"}
            className={`${actionBtn} hover:text-brand-600`} title="Approve" aria-label="Approve credit note">
            <CheckCircle size={15} />
          </button>
        </>
      )}
      {cn.status === "approved" && (
        <button type="button" onClick={(e) => { e.stopPropagation(); handleAction("issue", () => creditNoteApi.issue(cn.id)); }} disabled={actionLoading === "issue"}
          className={`${actionBtn} hover:text-emerald-700`} title="Issue" aria-label="Issue credit note">
          <Send size={15} />
        </button>
      )}
      {(cn.status === "issued" || cn.status === "partially_applied") && (
        <button type="button" onClick={(e) => { e.stopPropagation(); openApplyModal(cn); }}
          className={`${actionBtn} hover:text-brand-600`} title="Apply to Invoice" aria-label="Apply credit note to invoice">
          <CheckCircle size={15} />
        </button>
      )}
      {(cn.status === "issued" || cn.status === "partially_applied" || cn.status === "fully_applied") && (
        <button type="button" onClick={(e) => { e.stopPropagation(); openApplicationsModal(cn); }}
          className={`${actionBtn} hover:text-amber-600`} title="View Applications" aria-label="View applications">
          <FileText size={15} />
        </button>
      )}
      {cn.status !== "voided" && cn.status !== "fully_applied" && (
        <button type="button" onClick={(e) => { e.stopPropagation(); handleAction("void", () => creditNoteApi.void(cn.id, "Voided by user")); }} disabled={actionLoading === "void"}
          className={`${actionBtn} hover:text-red-600`} title="Void" aria-label="Void credit note">
          <Ban size={15} />
        </button>
      )}
    </div>
  );

  const columns = [
    { key: "credit_note_number", label: "Number", sortable: true, render: (cn) => <span className="font-semibold text-slate-800 whitespace-nowrap">{cn.credit_note_number || `#${cn.id}`}</span> },
    { key: "customer_name", label: singular, render: (cn) => <span className="text-slate-600">{cn.customer_name || `#${cn.customer_id}`}</span> },
    { key: "credit_note_type", label: "Type", sortable: true, render: (cn) => <span className="capitalize text-slate-600">{cn.credit_note_type?.replace(/_/g, " ")}</span> },
    { key: "status", label: "Status", render: (cn) => <StatusBadge status={cn.status} /> },
    { key: "total_amount", label: "Amount", sortable: true, align: "right", render: (cn) => <span className="font-semibold text-slate-800 whitespace-nowrap">{formatDisplayCurrency(cn.total_amount, cn.currency)}</span> },
    { key: "remaining", label: "Remaining", align: "right", render: (cn) => <span className="font-medium text-slate-600 whitespace-nowrap">{formatDisplayCurrency(cn.remaining_amount, cn.currency)}</span> },
    { key: "issue_date", label: "Date", sortable: true, render: (cn) => <span className="text-xs text-slate-500 whitespace-nowrap">{formatDisplayDate(cn.issue_date)}</span> },
    { key: "actions", label: "", align: "right", render: renderActions },
  ];

  const hasActiveFilters = Boolean(search || statusFilter || typeFilter);

  if (loading) {
    return (
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Credit Notes" }]}
          title="Credit Notes"
          description="Create, approve, issue, and apply credit notes to invoices"
          icon={Receipt}
        />
        <PageSkeleton rows={8} />
      </div>
    );
  }

  if (error && creditNotes.length === 0) {
    return (
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Credit Notes" }]}
          title="Credit Notes"
          description="Create, approve, issue, and apply credit notes to invoices"
          icon={Receipt}
        />
        <div role="alert" aria-live="assertive"><ErrorState message={error} onRetry={handleRefresh} title="Something went wrong" /></div>
      </div>
    );
  }

  return (
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Credit Notes" }]}
          title="Credit Notes"
          description="Create, approve, issue, and apply credit notes to invoices"
          icon={Receipt}
          actions={
            <>
              <Button variant="secondary" icon={Download} onClick={handleExportJSON}>Export JSON</Button>
              <Button variant="secondary" icon={FileText} onClick={handleExportCSV}>Export CSV</Button>
              <Button variant="primary" icon={Plus} onClick={openCreateModal}>New Credit Note</Button>
            </>
          }
        />

        <div className="bg-white border border-slate-200 rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
          <div className="p-6 border-b border-slate-100">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3 flex-1">
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  debounceMs={0}
                  placeholder="Search credit notes..."
                  className="flex-1 max-w-md"
                  aria-label="Search credit notes"
                />
                <button onClick={() => setShowFilters(!showFilters)}
                  className={`p-2.5 rounded-xl border transition-colors ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
                  aria-label="Toggle filters">
                  <Filter size={18} />
                </button>
                <button onClick={handleRefresh} disabled={refreshing} className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50" aria-label="Refresh">
                  <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-brand-700 bg-brand-50 border border-brand-100 rounded-lg px-3 py-1.5">
                  Outstanding: {formatDisplayCurrency(outstandingTotal)}
                </span>
                <span className="text-xs font-medium text-slate-500">{total} credit note(s)</span>
              </div>
            </div>

            {showFilters && (
              <div className="mt-4 pt-4 border-t border-slate-100 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <Select
                    value={statusFilter}
                    onChange={(v) => { setStatusFilter(v); setCurrentPage(1); }}
                    options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                    placeholder="All Statuses"
                    className="w-44"
                  />
                  <Select
                    value={typeFilter}
                    onChange={(v) => { setTypeFilter(v); setCurrentPage(1); }}
                    options={TYPE_OPTIONS}
                    placeholder="All Types"
                    className="w-48"
                  />
                  {hasActiveFilters && (
                    <button onClick={() => { setSearch(""); setStatusFilter(""); setTypeFilter(""); setCurrentPage(1); }}
                      className="text-xs font-medium text-red-600 hover:text-red-700 flex items-center gap-1">
                      <X size={12} /> Clear all
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="p-6">
            <DataTable
              columns={columns}
              data={creditNotes}
              rowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/billing/credit-notes/${row.id}`)}
              sortKey={sortField}
              sortDir={sortDir}
              onSort={toggleSort}
              emptyTitle="No credit notes found"
              emptyMessage={hasActiveFilters ? "Try adjusting your search or filters" : "No credit notes yet"}
              emptyIcon={Receipt}
              emptyAction={!hasActiveFilters ? (
                <Button variant="primary" icon={Plus} onClick={openCreateModal}>
                  Create your first credit note
                </Button>
              ) : undefined}
              striped
            />
          </div>
          <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
            {total} total credit note(s)
          </Pagination>
        </div>

        <Modal
          open={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          title="Create Credit Note"
          icon={Receipt}
          footer={
            <>
              <Button variant="secondary" onClick={() => setShowCreateModal(false)}>Cancel</Button>
              <Button variant="primary" icon={Plus} loading={saving} disabled={!createForm.customer_id || !createForm.total_amount} onClick={handleCreate}>
                Create
              </Button>
            </>
          }
        >
          {formError && <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2"><AlertCircle className="h-4 w-4 flex-shrink-0" /> {formError}</div>}
          {prefillNotice && <div className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-700 flex items-center gap-2"><CheckCircle className="h-4 w-4 flex-shrink-0" /> {prefillNotice}</div>}
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{singular} *</label>
              <select value={createForm.customer_id} onChange={(e) => setCreateForm((p) => ({ ...p, customer_id: e.target.value }))} className={inputClass}>
                <option value="">Select {getLabel("singularLower")}</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.display_name || c.company_name || c.name || c.customer_name || `#${c.id}`}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Invoice (optional)</label>
              <select value={createForm.invoice_id} onChange={(e) => {
                const invoiceId = e.target.value;
                const inv = invoices.find((item) => String(item.id) === invoiceId);
                if (inv) applyInvoiceToCreateForm(inv);
                else setCreateForm((p) => ({ ...p, invoice_id: invoiceId }));
              }} className={inputClass}>
                <option value="">No invoice</option>
                {invoices.map((inv) => <option key={inv.id} value={inv.id}>{inv.invoice_number || `#${inv.id}`} — {formatDisplayCurrency(inv.total_amount || inv.total, inv.currency)}</option>)}
              </select>
              {createForm.invoice_id && <p className="mt-1 text-xs text-slate-500">{singular}, amount, tax, and currency are filled from the selected invoice.</p>}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Type *</label>
                <select value={createForm.credit_note_type} onChange={(e) => setCreateForm((p) => ({ ...p, credit_note_type: e.target.value }))} className={inputClass}>
                  {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Issue Date *</label>
                <input type="date" value={createForm.issue_date} onChange={(e) => setCreateForm((p) => ({ ...p, issue_date: e.target.value }))} className={inputClass} />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Total Amount *</label>
              <input type="number" min="0" step="0.01" value={createForm.total_amount} onChange={(e) => setCreateForm((p) => ({ ...p, total_amount: e.target.value }))} placeholder="0.00" className={inputClass} />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Subtotal</label>
                <input type="number" min="0" step="0.01" value={createForm.subtotal} onChange={(e) => setCreateForm((p) => ({ ...p, subtotal: e.target.value }))} placeholder="0.00" className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Discount</label>
                <input type="number" min="0" step="0.01" value={createForm.discount_amount} onChange={(e) => setCreateForm((p) => ({ ...p, discount_amount: e.target.value }))} placeholder="0.00" className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Tax Amount</label>
                <input type="number" min="0" step="0.01" value={createForm.tax_amount} onChange={(e) => setCreateForm((p) => ({ ...p, tax_amount: e.target.value }))} placeholder="0.00" className={inputClass} />
              </div>
            </div>
            <p className="text-xs text-slate-500">If Subtotal, Discount, or Tax are set, Total Amount must equal Subtotal − Discount + Tax.</p>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Reason</label>
              <textarea value={createForm.reason} onChange={(e) => setCreateForm((p) => ({ ...p, reason: e.target.value }))} rows={2} placeholder="Reason for credit note" className={inputClass} />
            </div>
          </div>
        </Modal>

        <Modal
          open={showEditModal}
          onClose={() => setShowEditModal(false)}
          title={selectedCN ? `Edit ${selectedCN.credit_note_number}` : "Edit Credit Note"}
          icon={Edit}
          footer={
            <>
              <Button variant="secondary" onClick={() => setShowEditModal(false)}>Cancel</Button>
              <Button variant="primary" icon={CheckCircle} loading={saving} onClick={handleEdit}>Save</Button>
            </>
          }
        >
          {formError && <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2"><AlertCircle className="h-4 w-4 flex-shrink-0" /> {formError}</div>}
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Total Amount</label>
              <input type="number" min="0" step="0.01" value={editForm.total_amount} onChange={(e) => setEditForm((p) => ({ ...p, total_amount: e.target.value }))} className={inputClass} />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Subtotal</label>
                <input type="number" min="0" step="0.01" value={editForm.subtotal} onChange={(e) => setEditForm((p) => ({ ...p, subtotal: e.target.value }))} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Discount</label>
                <input type="number" min="0" step="0.01" value={editForm.discount_amount} onChange={(e) => setEditForm((p) => ({ ...p, discount_amount: e.target.value }))} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Tax Amount</label>
                <input type="number" min="0" step="0.01" value={editForm.tax_amount} onChange={(e) => setEditForm((p) => ({ ...p, tax_amount: e.target.value }))} className={inputClass} />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Reason</label>
              <textarea value={editForm.reason} onChange={(e) => setEditForm((p) => ({ ...p, reason: e.target.value }))} rows={2} className={inputClass} />
            </div>
          </div>
        </Modal>

        <Modal
          open={showApplyModal}
          onClose={() => setShowApplyModal(false)}
          title={selectedCN ? `Apply ${selectedCN.credit_note_number}` : "Apply Credit Note"}
          icon={CheckCircle}
          footer={
            <>
              <Button variant="secondary" onClick={() => setShowApplyModal(false)}>Cancel</Button>
              <Button variant="primary" icon={CheckCircle} loading={saving} disabled={!applyForm.invoice_id || !applyForm.amount} onClick={handleApply}>Apply</Button>
            </>
          }
        >
          {selectedCN && <p className="mb-4 text-sm text-slate-600">Remaining amount: <span className="font-semibold">{formatDisplayCurrency(selectedCN.remaining_amount, selectedCN.currency)}</span></p>}
          {formError && <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2"><AlertCircle className="h-4 w-4 flex-shrink-0" /> {formError}</div>}
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Invoice *</label>
              <select value={applyForm.invoice_id} onChange={(e) => setApplyForm((p) => ({ ...p, invoice_id: e.target.value }))} className={inputClass}>
                <option value="">Select invoice</option>
                {invoices.map((inv) => <option key={inv.id} value={inv.id}>{inv.invoice_number || `#${inv.id}`} — {formatDisplayCurrency(inv.balance_due || inv.total_amount || inv.total, inv.currency)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Amount *</label>
              <input type="number" min="0" step="0.01" value={applyForm.amount} onChange={(e) => setApplyForm((p) => ({ ...p, amount: e.target.value }))} className={inputClass} />
            </div>
          </div>
        </Modal>

        <Modal
          open={showApplicationsModal}
          onClose={() => setShowApplicationsModal(false)}
          title={selectedCN ? `Applications — ${selectedCN.credit_note_number}` : "Applications"}
          icon={FileText}
          footer={
            <Button variant="secondary" onClick={() => setShowApplicationsModal(false)}>Close</Button>
          }
        >
          {applications.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-6">No applications yet</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="text-left py-2 px-2 text-xs font-medium text-slate-500">Invoice</th>
                    <th className="text-right py-2 px-2 text-xs font-medium text-slate-500">Amount</th>
                    <th className="text-right py-2 px-2 text-xs font-medium text-slate-500">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {applications.map((app) => (
                    <tr key={app.id} className="border-b border-slate-50">
                      <td className="py-2 px-2 text-slate-700 font-medium">{app.invoice_id ? `#${app.invoice_id}` : "—"}</td>
                      <td className="py-2 px-2 text-right text-slate-700">{formatDisplayCurrency(app.amount, selectedCN?.currency)}</td>
                      <td className="py-2 px-2 text-right text-slate-500">{formatDisplayDate(app.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      </div>
  );
}
