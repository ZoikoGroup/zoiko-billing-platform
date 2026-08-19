import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CreditCard, Search, Filter, X, ChevronDown, RefreshCw, Plus, AlertCircle, CheckCircle, Clock, FileText, XCircle, ArrowUpDown, Ban, DollarSign, User, Wallet, TrendingUp, Calendar, Loader2, Eye, Receipt, Hash, Layers } from "lucide-react";
import { paymentApi, invoiceApi, customerApi, creditNoteApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { sumInBaseCurrency } from "../../../utils/currency-conversion";
import { useCurrency } from "../utils/CurrencyContext";
import { ErrorState, PageSkeleton, SuccessMessage, DashboardHeader, DashboardStatCard, DASHBOARD_KPI_GRID, Pagination, useConfirmationDialog } from "../../../components/billing-shared";
import { useBillingDateRange } from "../utils/DateRangeContext";

const ITEMS_PER_PAGE = 10;

const STATUS_OPTIONS = [
  { value: "cleared", label: "Cleared", color: "bg-emerald-100 text-emerald-700" },
  { value: "pending", label: "Pending", color: "bg-amber-100 text-amber-700" },
  { value: "processing", label: "Processing", color: "bg-sky-100 text-sky-700" },
  { value: "failed", label: "Failed", color: "bg-red-100 text-red-700" },
  { value: "refunded", label: "Refunded", color: "bg-blue-100 text-blue-700" },
  { value: "cancelled", label: "Cancelled", color: "bg-slate-100 text-slate-700" },
];

// How the customer paid — shown in the "Record Payment" wizard. These map to
// the backend's PaymentGatewayType (sent as `gateway`), not PaymentType.
const PAYMENT_METHOD_OPTIONS = [
  { value: "", label: "All Types" },
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "credit_card", label: "Credit Card" },
  { value: "bank_transfer", label: "Bank Transfer" },
  { value: "online", label: "Online" },
  { value: "other", label: "Other" },
];

// method -> backend PaymentGatewayType; "online"/"other" have no equivalent
// enum value, so they're intentionally omitted (left unmapped).
const PAYMENT_METHOD_TO_GATEWAY = {
  cash: "cash", check: "check", credit_card: "credit_card", bank_transfer: "bank_transfer",
};

// What kind of payment this is, per the backend's PaymentType enum — used for
// the list page's "Type" filter, which must match real stored values.
const PAYMENT_TYPE_FILTER_OPTIONS = [
  { value: "", label: "All Types" },
  { value: "invoice_payment", label: "Invoice Payment" },
  { value: "subscription_payment", label: "Subscription Payment" },
  { value: "manual", label: "Manual" },
  { value: "refund", label: "Refund" },
  { value: "deposit", label: "Deposit" },
];

function StatusBadge({ status }) {
  const s = STATUS_OPTIONS.find((o) => o.value === status);
  if (!s) return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">{status || "unknown"}</span>;
  const icons = { cleared: CheckCircle, pending: Clock, processing: Clock, failed: XCircle, refunded: RefreshCw, cancelled: Ban };
  const Icon = icons[status] || Clock;
  return <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${s.color}`}><Icon size={12} /> {s.label}</span>;
}

function WizardStep({ number, label, active, completed }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
        completed ? "bg-emerald-500 text-white" : active ? "bg-brand-600 text-white" : "bg-slate-200 text-slate-500"
      }`}>
        {completed ? <CheckCircle size={16} /> : number}
      </div>
      <span className={`text-sm font-medium ${active ? "text-brand-700" : completed ? "text-emerald-600" : "text-slate-500"}`}>{label}</span>
    </div>
  );
}

export default function PaymentListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { baseCurrency } = useCurrency();

  const [payments, setPayments] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const { range: dateRangeValue, setRange: setDateRangeValue, customStart, customEnd, applyCustomRange, reset: resetDateRange, dateRange } = useBillingDateRange();
  const [showFilters, setShowFilters] = useState(false);
  const [sortField, setSortField] = useState("payment_date");
  const [sortDir, setSortDir] = useState("desc");
  const [currentPage, setCurrentPage] = useState(1);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardData, setWizardData] = useState({
    customer_id: "", customer_name: "", customer_email: "", customer_phone: "", customer_currency: "",
    invoice_id: "", invoice_number: "", invoice_total: 0, invoice_paid: 0, invoice_balance: 0,
    invoice_status: "", invoice_payment_terms: "",
    payment_number: "", payment_date: new Date().toISOString().split("T")[0],
    amount: 0, currency: "", payment_type: "bank_transfer", payment_method_id: "", payment_method_label: "",
    transaction_id: "", reference_number: "", gateway: "", gateway_charge_id: "",
    exchange_rate: 1, gateway_fee: 0, notes: "",
    allocations: [],
  });
  const [wizardLoading, setWizardLoading] = useState(false);
  const [wizardError, setWizardError] = useState(null);
  const [wizardSuccess, setWizardSuccess] = useState(null);

  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [customerSearching, setCustomerSearching] = useState(false);
  const [customerOutstanding, setCustomerOutstanding] = useState([]);
  const [customerCredits, setCustomerCredits] = useState([]);
  const [customerRecentPayments, setCustomerRecentPayments] = useState([]);
  const [customerInvoiceSearch, setCustomerInvoiceSearch] = useState("");
  const [invoiceResults, setInvoiceResults] = useState([]);
  const [invoiceSearching, setInvoiceSearching] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [allocationMode, setAllocationMode] = useState("full");
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setCurrentPage(1); }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchPayments = useCallback(async (isInitial = false) => {
    try {
      setError(null);
      if (!isInitial) setRefreshing(true);
      const sortBy = sortField === "amount" ? "amount" : sortField === "customer" ? "customer_id" : sortField;
      const data = await paymentApi.list({
        page: safePage, per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        status: statusFilter || undefined,
        payment_type: typeFilter || undefined,
        date_from: dateRange.date_from || undefined,
        date_to: dateRange.date_to || undefined,
        sort_by: sortBy, sort_order: sortDir,
      });
      const items = extractArray(data);
      setPayments(items);
      setTotal(data?.total || items.length || 0);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.message || "Failed to load payments");
      setPayments([]); setTotal(0);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter, typeFilter, dateRange.date_from, dateRange.date_to, sortField, sortDir]);

  useEffect(() => { fetchPayments(true); }, [fetchPayments]);
  useEffect(() => { if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages); }, [totalPages, currentPage]);

  const handleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
    setCurrentPage(1);
  };

  const SortHeader = ({ field, label }) => (
    <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer select-none hover:text-slate-700" onClick={() => handleSort(field)}>
      <div className="flex items-center gap-1">{label}<ArrowUpDown size={12} className={`${sortField === field ? "text-brand-600" : "text-slate-300"}`} /></div>
    </th>
  );

  const handleSelectAll = () => {
    if (selectAll) { setSelectedIds(new Set()); setSelectAll(false); }
    else { setSelectedIds(new Set(payments.map((p) => p.id))); setSelectAll(true); }
  };

  const handleSelectOne = (id) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
    setSelectAll(next.size === payments.length && payments.length > 0);
  };

  const handleBulkAction = async (status) => {
    if (selectedIds.size === 0) return;
    const ok = await confirm({ title: `Mark as ${status}`, message: `Mark ${selectedIds.size} payment(s) as ${status}?`, confirmLabel: status });
    if (!ok) return;
    setBulkLoading(true);
    try {
      for (const id of selectedIds) await paymentApi.updateStatus(id, status);
      setSelectedIds(new Set()); setSelectAll(false);
      fetchPayments();
    } catch (err) {
      setError(err.message || "Bulk action failed");
    } finally { setBulkLoading(false); }
  };

  const handleExportJSON = () => {
    const blob = new Blob([JSON.stringify(payments, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "payments.json"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCSV = () => {
    const headers = ["Payment #", "Customer", "Amount", "Currency", "Method", "Status", "Date", "Transaction ID"];
    const rows = payments.map((p) => [
      p.payment_number || `#${p.id}`, p.customer_name || p.customer?.name || "",
      p.amount || 0, p.currency || "USD",
      p.payment_method_type || p.payment_type || "", p.status || "",
      p.payment_date || "", p.transaction_id || "",
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "payments.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const openWizard = () => {
    const prefix = "PAY-";
    const ts = Date.now().toString(36).toUpperCase();
    setWizardData({
      customer_id: "", customer_name: "", customer_email: "", customer_phone: "", customer_currency: "",
      invoice_id: "", invoice_number: "", invoice_total: 0, invoice_paid: 0, invoice_balance: 0,
      invoice_status: "", invoice_payment_terms: "",
      payment_number: `${prefix}${ts}`, payment_date: new Date().toISOString().split("T")[0],
      amount: 0, currency: "", payment_type: "bank_transfer", payment_method_id: "", payment_method_label: "",
      transaction_id: "", reference_number: "", gateway: "", gateway_charge_id: "",
      exchange_rate: 1, gateway_fee: 0, notes: "", allocations: [],
    });
    setWizardStep(1); setWizardError(null); setWizardSuccess(null); setShowWizard(true);
    setCustomerSearch(""); setCustomerResults([]);
    setCustomerOutstanding([]); setCustomerCredits([]); setCustomerRecentPayments([]);
    setCustomerInvoiceSearch(""); setInvoiceResults([]); setPaymentMethods([]); setShowAdvanced(false);
    setAllocationMode("full");
  };

  const closeWizard = () => {
    setShowWizard(false);
    setWizardError(null);
    if (searchParams.get("create") === "1" || searchParams.get("invoice_id")) setSearchParams({}, { replace: true });
  };

  const searchCustomers = useCallback(async (term) => {
    if (!term.trim()) { setCustomerResults([]); return; }
    setCustomerSearching(true);
    try {
      const data = await customerApi.search(term, 10);
      setCustomerResults(Array.isArray(data) ? data : data?.items || data?.data || []);
    } catch { setCustomerResults([]); }
    finally { setCustomerSearching(false); }
  }, []);

  useEffect(() => {
    if (!showWizard || wizardStep !== 1) return;
    const timer = setTimeout(() => searchCustomers(customerSearch), 300);
    return () => clearTimeout(timer);
  }, [customerSearch, showWizard, wizardStep, searchCustomers]);

  useEffect(() => {
    if (searchParams.get("create") === "1" && !showWizard) openWizard();
  }, [searchParams, showWizard]);

  useEffect(() => {
    const requestedInvoiceId = searchParams.get("invoice_id");
    if (!showWizard || wizardStep !== 1 || !requestedInvoiceId || wizardData.invoice_id) return;
    loadInvoiceById(requestedInvoiceId);
  }, [searchParams, showWizard, wizardStep, wizardData.invoice_id]);

  useEffect(() => {
    const requestedCustomerId = searchParams.get("customer_id");
    if (!showWizard || wizardStep !== 1 || !requestedCustomerId || wizardData.customer_id) return;
    const loadRequestedCustomer = async () => {
      try {
        const customer = await customerApi.get(requestedCustomerId);
        await selectCustomer(customer);
      } catch {
        // Keep the payment flow intact if the customer prefill fails
      }
    };
    loadRequestedCustomer();
  }, [searchParams, showWizard, wizardStep, wizardData.customer_id]);

  const loadCustomerData = async (customerId) => {
    try {
      const [invData, credData, payData, methodData] = await Promise.all([
        invoiceApi.list({ customer_id: customerId, status: "overdue,sent,partially_paid", per_page: 50 }).catch(() => ({ items: [] })),
        creditNoteApi.list({ customer_id: customerId, per_page: 50 }).catch(() => ({ items: [] })),
        paymentApi.list({ customer_id: customerId, per_page: 10 }).catch(() => ({ items: [] })),
        paymentApi.listMethods(customerId).catch(() => []),
      ]);
      setCustomerOutstanding(extractArray(invData));
      setCustomerCredits(extractArray(credData));
      setCustomerRecentPayments(extractArray(payData));
      const methods = extractArray(methodData);
      setPaymentMethods(methods);
      const preferred = methods.find((m) => m.is_default || m.default) || methods[0];
      if (preferred) {
        setWizardData((p) => ({
          ...p,
          payment_method_id: preferred.id ? String(preferred.id) : "",
          payment_method_label: preferred.label || preferred.name || preferred.payment_method_type || preferred.provider || "Saved method",
          payment_type: preferred.payment_method_type || preferred.method_type || p.payment_type,
        }));
      }
    } catch (err) { console.error("[PaymentList] Failed to load customer data:", err); }
  };

  const selectCustomer = async (c) => {
    const currency = c.currency || "USD";
    setWizardData((p) => ({
      ...p, customer_id: c.id,
      customer_name: c.display_name || c.company_name || c.name || `Customer #${c.id}`,
      customer_email: c.email || "", customer_phone: c.phone || "", customer_currency: currency, currency,
    }));
    setCustomerResults([]); setCustomerSearch("");
    await loadCustomerData(c.id);
  };

  const selectInvoice = async (inv) => {
    if (inv.customer_id && !wizardData.customer_id) {
      const c = await customerApi.get(inv.customer_id).catch(() => null);
      if (c) {
        const currency = inv.currency || c.currency || "USD";
        setWizardData((p) => ({
          ...p,
          customer_id: c.id,
          customer_name: c.display_name || c.company_name || c.name || `Customer #${c.id}`,
          customer_email: c.email || "",
          customer_phone: c.phone || "",
          customer_currency: currency,
          currency,
        }));
        await loadCustomerData(c.id);
      }
    }
    const total = parseFloat(inv.total_amount || inv.amount || 0);
    const paid = parseFloat(inv.paid_amount || inv.amount_paid || 0);
    const balance = parseFloat(inv.balance_due ?? inv.amount_due ?? (total - paid));
    const suggested = Math.max(0, balance || total);
    setWizardData((p) => ({
      ...p,
      invoice_id: inv.id, invoice_number: inv.invoice_number || `#${inv.id}`,
      invoice_total: total,
      invoice_paid: paid,
      invoice_balance: suggested,
      invoice_status: inv.status, invoice_payment_terms: inv.payment_terms || "",
      amount: suggested,
      currency: inv.currency || p.currency || "USD",
      reference_number: inv.invoice_number || p.reference_number,
      notes: p.notes || `Payment for ${inv.invoice_number || `invoice #${inv.id}`}`,
      allocations: [{ invoice_id: inv.id, amount: suggested }],
    }));
    setAllocationMode("full");
  };

  const loadInvoiceById = async (invoiceId) => {
    setInvoiceSearching(true);
    setWizardError(null);
    try {
      const inv = await invoiceApi.get(invoiceId);
      if (inv.customer_id && !wizardData.customer_id) {
        const c = await customerApi.get(inv.customer_id).catch(() => null);
        if (c) {
          setWizardData((p) => ({
            ...p, customer_id: c.id,
            customer_name: c.display_name || c.company_name || c.name || `Customer #${c.id}`,
            customer_email: c.email || "", customer_phone: c.phone || "", customer_currency: c.currency || "USD",
            currency: c.currency || "USD",
          }));
          await loadCustomerData(c.id);
        }
      }
      await selectInvoice(inv);
    } catch (err) {
      setWizardError(err?.message || `Invoice "${invoiceId}" not found`);
    } finally {
      setInvoiceSearching(false);
    }
  };

  const updateAllocationAmount = (idx, amount) => {
    setWizardData((p) => {
      const allocs = [...p.allocations];
      if (allocs[idx]) allocs[idx] = { ...allocs[idx], amount: Math.max(0, parseFloat(amount) || 0) };
      return { ...p, allocations: allocs, amount: allocs.reduce((s, a) => s + a.amount, 0) };
    });
  };

  const calcRemaining = () => {
    const totalAlloc = wizardData.allocations.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0);
    const paymentAmt = parseFloat(wizardData.amount || 0);
    return paymentAmt - totalAlloc;
  };

  const handleCreatePayment = async () => {
    if (!wizardData.customer_id || wizardData.amount <= 0) return;
    setWizardLoading(true); setWizardError(null);
    try {
      const payResp = await paymentApi.create({
        customer_id: Number(wizardData.customer_id),
        payment_number: wizardData.payment_number,
        transaction_id: wizardData.transaction_id || undefined,
        // wizardData.payment_type holds the customer's payment METHOD
        // (cash/check/credit_card/bank_transfer/...) — the backend's
        // `payment_type` field is actually the payment's business category,
        // so the method is sent as `gateway` (when representable) instead.
        payment_type: wizardData.invoice_id ? "invoice_payment" : "manual",
        amount: parseFloat(wizardData.amount),
        currency: wizardData.currency,
        exchange_rate: parseFloat(wizardData.exchange_rate || 1),
        gateway: PAYMENT_METHOD_TO_GATEWAY[wizardData.payment_type] || wizardData.gateway || undefined,
        gateway_charge_id: wizardData.gateway_charge_id || undefined,
        gateway_fee: parseFloat(wizardData.gateway_fee || 0),
        payment_date: wizardData.payment_date,
        notes: wizardData.notes || undefined,
      });
      const paymentId = payResp.id;
      let cappedCount = 0;
      for (const alloc of wizardData.allocations) {
        if (alloc.invoice_id && parseFloat(alloc.amount) > 0) {
          const requested = parseFloat(alloc.amount);
          const result = await paymentApi.allocate(paymentId, { invoice_id: Number(alloc.invoice_id), amount: requested });
          if (result?.amount != null && parseFloat(result.amount) < requested) cappedCount += 1;
        }
      }
      setCurrentPage(1);
      fetchPayments();
      setWizardSuccess(
        cappedCount > 0
          ? "Payment recorded. The allocated amount was reduced to the invoice's remaining balance — the excess was not applied."
          : "Payment recorded successfully."
      );
      setTimeout(() => {
        setShowWizard(false);
        navigate(`/billing/payments/${paymentId}`);
      }, 1200);
    } catch (err) {
      setWizardError(err?.detail || err?.message || "Failed to record payment");
    } finally { setWizardLoading(false); }
  };

  const filteredByStatus = (status) => payments.filter((p) => p.status === status);
  const completedAmt = sumInBaseCurrency(filteredByStatus("cleared"), baseCurrency).total;
  const pendingAmt = sumInBaseCurrency(filteredByStatus("pending"), baseCurrency).total;

  const headerProps = {
    title: "Payments",
    subtitle: "Accounts receivable workspace",
    icon: CreditCard,
    iconGradient: "from-brand to-brand-hover",
    lastUpdated,
    refreshing,
    onRefresh: () => { setRefreshing(true); fetchPayments(); },
    onExportCSV: handleExportCSV,
    onExportJSON: handleExportJSON,
    dateRange: dateRangeValue,
    onDateRangeChange: setDateRangeValue,
    customStart,
    customEnd,
    onApplyCustomRange: applyCustomRange,
    onResetDateRange: resetDateRange,
  };

  if (loading) return <div className="space-y-8 px-4 py-6 sm:px-6 max-w-7xl mx-auto"><DashboardHeader {...headerProps} /><PageSkeleton rows={6} /></div>;
  if (error && payments.length === 0) return <div className="space-y-8 px-4 py-6 sm:px-6 max-w-7xl mx-auto"><DashboardHeader {...headerProps} /><ErrorState message={error} onRetry={() => fetchPayments(true)} /></div>;

  return (
    <div className="space-y-8 px-4 py-6 sm:px-6 max-w-7xl mx-auto">
      <DashboardHeader {...headerProps} />
      <div className="space-y-6">
        <div className={DASHBOARD_KPI_GRID}>
          <DashboardStatCard title="Payments" value={total} icon={CreditCard} color="from-brand to-brand-hover" onClick={() => { setStatusFilter(""); setCurrentPage(1); }} />
          <DashboardStatCard title="Cleared" value={filteredByStatus("cleared").length} icon={CheckCircle} color="from-emerald-500 to-emerald-600" subtitle={formatDisplayCurrency(completedAmt, baseCurrency)} onClick={() => { setStatusFilter("cleared"); setCurrentPage(1); }} />
          <DashboardStatCard title="Pending" value={filteredByStatus("pending").length} icon={Clock} color="from-amber-500 to-orange-500" onClick={() => { setStatusFilter("pending"); setCurrentPage(1); }} />
          <DashboardStatCard title="Failed" value={filteredByStatus("failed").length} icon={XCircle} color="from-red-500 to-rose-500" onClick={() => { setStatusFilter("failed"); setCurrentPage(1); }} />
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          <DashboardStatCard title="Refunded" value={filteredByStatus("refunded").length} icon={RefreshCw} color="from-blue-500 to-blue-600" />
          <DashboardStatCard title="Outstanding" value={Number(pendingAmt)} currency={baseCurrency} icon={Wallet} color="from-amber-500 to-orange-500" />
          <DashboardStatCard title="Revenue" value={Number(completedAmt)} currency={baseCurrency} icon={DollarSign} color="from-brand to-brand-hover" href="/billing/collections-receivables" />
          <DashboardStatCard title="Avg/Day" value={Number(payments.length > 0 ? completedAmt / Math.max(payments.length, 1) : 0)} currency={baseCurrency} icon={TrendingUp} color="from-slate-500 to-slate-600" />
        </div>

        <div className="bg-white border border-slate-200 rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
          <div className="p-6 border-b border-slate-100">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3 flex-1">
                <div className="relative flex-1 max-w-md">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input type="text" placeholder="Search payments..." value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  {search && <button onClick={() => setSearch("")} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 rounded"><X size={16} /></button>}
                </div>
                <button onClick={() => setShowFilters(!showFilters)} aria-label={showFilters ? "Hide filters" : "Show filters"} aria-pressed={showFilters}
                  className={`p-2.5 rounded-xl border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}>
                  <Filter size={18} />
                </button>
                {selectedIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 font-medium">{selectedIds.size} selected</span>
                    <button onClick={() => handleBulkAction("cleared")} disabled={bulkLoading}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 rounded-lg hover:bg-emerald-100 disabled:opacity-50">
                      {bulkLoading ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />} Mark Cleared
                    </button>
                    <button onClick={() => handleBulkAction("failed")} disabled={bulkLoading}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-50">
                      <XCircle size={12} /> Fail
                    </button>
                    <button onClick={() => { setSelectedIds(new Set()); setSelectAll(false); }} aria-label="Clear selection"
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"><X size={14} /></button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => navigate("/billing/payments")}
                  className="px-4 py-2.5 text-sm font-medium text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
                  Dashboard
                </button>
                <button onClick={openWizard}
                  className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
                  <Plus size={18} /> Record Payment
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
                  <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setCurrentPage(1); }}
                    className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                    {PAYMENT_TYPE_FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                </div>
                {(statusFilter || typeFilter || dateRange.date_from || dateRange.date_to) && (
                  <button onClick={() => { setStatusFilter(""); setTypeFilter(""); resetDateRange(); setCurrentPage(1); }}
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
                    <input type="checkbox" checked={selectAll} onChange={handleSelectAll} aria-label="Select all payments"
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Payment</th>
                  <SortHeader field="customer" label="Customer" />
                  <SortHeader field="amount" label="Amount" />
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Method</th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                  <SortHeader field="payment_date" label="Date" />
                  <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {payments.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-16 text-center">
                      <div className="flex flex-col items-center">
                        <CreditCard size={40} className="text-slate-300 mb-3" />
                        <p className="text-slate-500 font-medium">No payments found</p>
                        <p className="text-slate-400 text-sm mt-1">{search || statusFilter ? "Try adjusting your search or filters" : "Record your first payment to get started"}</p>
                      </div>
                    </td>
                  </tr>
                ) : payments.map((pmt) => (
                  <tr key={pmt.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-4">
                      <input type="checkbox" checked={selectedIds.has(pmt.id)} onChange={() => handleSelectOne(pmt.id)} aria-label={`Select payment ${pmt.payment_number || pmt.id}`}
                        className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                    </td>
                    <td className="px-4 py-4">
                      <button onClick={() => navigate(`/billing/payments/${pmt.id}`)} className="font-medium text-slate-800 hover:text-brand-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 rounded">
                        <div className="flex items-center gap-2">
                          <Receipt size={14} className="text-slate-400" />
                          {pmt.payment_number || `#${pmt.id}`}
                        </div>
                      </button>
                    </td>
                    <td className="px-4 py-4 text-slate-600">{pmt.customer_name || pmt.customer?.name || `Customer #${pmt.customer_id}`}</td>
                    <td className="px-4 py-4 font-medium text-slate-800">{formatDisplayCurrency(pmt.amount, pmt.currency)}</td>
                    <td className="px-4 py-4 text-slate-600 text-xs capitalize">{pmt.payment_type?.replace(/_/g, " ") || pmt.payment_method || "—"}</td>
                    <td className="px-4 py-4"><StatusBadge status={pmt.status} /></td>
                    <td className="px-4 py-4 text-slate-500 text-xs">{formatDisplayDate(pmt.payment_date)}</td>
                    <td className="px-4 py-4 text-right">
                      <button onClick={() => navigate(`/billing/payments/${pmt.id}`)}
                        className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-brand-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" title="View" aria-label={`View payment ${pmt.payment_number || pmt.id}`}>
                        <Eye size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
            {total} total payment(s)
          </Pagination>
        </div>
      </div>

      {showWizard && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-10 overflow-y-auto" onClick={() => { if (!wizardLoading && !wizardSuccess) closeWizard(); }}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-4xl shadow-2xl mx-4 mb-10" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-slate-800">Record Payment</h2>
              <button onClick={() => { if (!wizardLoading && !wizardSuccess) closeWizard(); }} aria-label="Close record payment dialog" className="p-1 hover:bg-slate-100 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"><X size={20} /></button>
            </div>

            <div className="flex items-center justify-between mb-8 px-4">
              <WizardStep number={1} label="Customer / Invoice" active={wizardStep === 1} completed={wizardStep > 1} />
              <div className="flex-1 h-px bg-slate-200 mx-3" />
              <WizardStep number={2} label="Allocation" active={wizardStep === 2} completed={wizardStep > 2} />
              <div className="flex-1 h-px bg-slate-200 mx-3" />
              <WizardStep number={3} label="Review" active={wizardStep === 3} completed={wizardStep > 3} />
              <div className="flex-1 h-px bg-slate-200 mx-3" />
              <WizardStep number={4} label="Confirm" active={wizardStep === 4} completed={wizardStep > 4} />
            </div>

            {wizardSuccess && <SuccessMessage message={wizardSuccess} />}
            {wizardError && <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700"><AlertCircle size={16} />{wizardError}</div>}

            {wizardStep === 1 && (
              <div className="space-y-6">
                <div>
                  <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-4"><User size={20} className="text-brand-500" /> Select Customer</h3>
                  {wizardData.customer_id ? (
                    <div className="p-4 bg-brand-50 border border-brand-200 rounded-xl">
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded-full bg-gradient-to-br from-brand to-brand-hover text-white flex items-center justify-center font-bold">
                            {wizardData.customer_name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="font-medium text-slate-800">{wizardData.customer_name}</p>
                            <p className="text-xs text-slate-500">{wizardData.customer_email}{wizardData.customer_phone ? ` · ${wizardData.customer_phone}` : ""}</p>
                          </div>
                        </div>
                        <button onClick={() => setWizardData((p) => ({ ...p, customer_id: "", customer_name: "", customer_email: "", customer_phone: "", invoice_id: "", invoice_number: "", allocations: [] }))}
                          className="text-sm text-brand-600 hover:text-brand-700 font-medium">Change</button>
                      </div>

                      {customerOutstanding.length > 0 && (
                        <div className="mb-3">
                          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Outstanding Invoices ({customerOutstanding.length})</p>
                          <div className="max-h-40 overflow-y-auto space-y-1">
                            {customerOutstanding.map((inv) => {
                              const bal = parseFloat(inv.total_amount || inv.amount || 0) - parseFloat(inv.paid_amount || 0);
                              return (
                                <button key={inv.id} onClick={() => selectInvoice(inv)}
                                  className={`w-full text-left p-2 rounded-lg text-sm transition-colors flex items-center justify-between ${
                                    wizardData.invoice_id === inv.id ? "bg-brand-100 border border-brand-200" : "bg-white border border-slate-200 hover:bg-slate-50"
                                  }`}>
                                  <div>
                                    <span className="font-medium text-slate-700">{inv.invoice_number || `#${inv.id}`}</span>
                                    <span className="text-xs text-slate-400 ml-2 capitalize">{inv.status?.replace(/_/g, " ")}</span>
                                  </div>
                                  <span className="font-medium text-slate-800">{formatDisplayCurrency(bal, inv.currency)}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {customerCredits.length > 0 && (
                        <div className="mb-3">
                          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Available Credits</p>
                          <p className="text-sm text-slate-600">
                            {formatDisplayCurrency(sumInBaseCurrency(customerCredits.filter((c) => c.status === "issued" || c.status === "applied"), baseCurrency).total, baseCurrency)}
                            <span className="text-xs text-slate-400 ml-1">({customerCredits.filter((c) => c.status === "issued").length} issued)</span>
                          </p>
                        </div>
                      )}

                      {customerRecentPayments.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Recent Payments</p>
                          <div className="flex flex-wrap gap-2">
                            {customerRecentPayments.slice(0, 5).map((p) => (
                              <span key={p.id} className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded-lg">
                                {formatDisplayCurrency(p.amount, p.currency)} · {formatDisplayDate(p.payment_date)}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {customerOutstanding.length === 0 && customerCredits.length === 0 && customerRecentPayments.length === 0 && (
                        <p className="text-xs text-slate-400">No outstanding invoices, credits, or recent payments found.</p>
                      )}
                    </div>
                  ) : (
                    <div>
                      <div className="relative mb-3">
                        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <input type="text" placeholder="Search customers by name, email, or phone..." value={customerSearch}
                          onChange={(e) => setCustomerSearch(e.target.value)}
                          className="w-full pl-9 pr-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                      </div>
                      {customerSearching && <p className="text-sm text-slate-400 text-center py-2">Searching...</p>}
                      {customerResults.length > 0 && (
                        <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-60 overflow-y-auto">
                          {customerResults.map((c) => (
                            <button key={c.id} onClick={() => selectCustomer(c)}
                              className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors">
                              <p className="font-medium text-slate-800">{c.display_name || c.company_name || c.name || `Customer #${c.id}`}</p>
                              <p className="text-xs text-slate-400">{c.email}{c.phone ? ` · ${c.phone}` : ""}</p>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-4"><FileText size={20} className="text-brand-500" /> Invoice (Optional)</h3>
                  <div className="flex gap-3">
                    <div className="relative flex-1">
                      <Hash size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input type="text" placeholder="Enter invoice number or ID..." value={customerInvoiceSearch}
                        onChange={(e) => setCustomerInvoiceSearch(e.target.value)}
                        className="w-full pl-9 pr-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                    </div>
                    <button onClick={() => { if (customerInvoiceSearch.trim()) loadInvoiceById(customerInvoiceSearch.trim()); }}
                      disabled={invoiceSearching || !customerInvoiceSearch.trim()}
                      className="px-4 py-2.5 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 disabled:opacity-50 inline-flex items-center gap-2">
                      {invoiceSearching && <Loader2 size={14} className="animate-spin" />} Load
                    </button>
                  </div>

                  {wizardData.invoice_id && (
                    <div className="mt-3 p-4 bg-blue-50 border border-blue-200 rounded-xl">
                      <div className="flex items-center justify-between mb-2">
                        <p className="font-medium text-slate-800">{wizardData.invoice_number}</p>
                        <button onClick={() => setWizardData((p) => ({ ...p, invoice_id: "", invoice_number: "", invoice_total: 0, invoice_paid: 0, invoice_balance: 0, allocations: [] }))}
                          className="text-xs text-blue-600 hover:text-blue-800">Clear</button>
                      </div>
                      <div className="grid grid-cols-4 gap-3 text-sm">
                        <div><span className="text-xs text-slate-500">Total</span><p className="font-medium">{formatDisplayCurrency(wizardData.invoice_total, wizardData.currency)}</p></div>
                        <div><span className="text-xs text-slate-500">Paid</span><p className="font-medium text-emerald-600">{formatDisplayCurrency(wizardData.invoice_paid, wizardData.currency)}</p></div>
                        <div><span className="text-xs text-slate-500">Balance</span><p className="font-medium text-amber-600">{formatDisplayCurrency(wizardData.invoice_balance, wizardData.currency)}</p></div>
                        <div><span className="text-xs text-slate-500">Status</span><p className="font-medium capitalize">{wizardData.invoice_status?.replace(/_/g, " ")}</p></div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Payment Number *</label>
                    <input type="text" value={wizardData.payment_number}
                      onChange={(e) => setWizardData((p) => ({ ...p, payment_number: e.target.value }))}
                      className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Payment Date</label>
                    <input type="date" value={wizardData.payment_date}
                      onChange={(e) => setWizardData((p) => ({ ...p, payment_date: e.target.value }))}
                      className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Payment Type</label>
                    <select value={wizardData.payment_type}
                      onChange={(e) => setWizardData((p) => ({ ...p, payment_type: e.target.value }))}
                      className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                      {PAYMENT_METHOD_OPTIONS.filter((t) => t.value).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Amount *</label>
                    <div className="relative">
                      <DollarSign size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input type="number" min="0" step="0.01" value={wizardData.amount}
                        onChange={(e) => setWizardData((p) => ({ ...p, amount: parseFloat(e.target.value) || 0 }))}
                        className="w-full pl-9 pr-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {wizardStep === 2 && (
              <div className="space-y-6">
                <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><Layers size={20} className="text-brand-500" /> Payment Allocation</h3>

                <div className="flex gap-2 mb-4">
                  {["full", "partial", "overpayment"].map((mode) => (
                    <button key={mode} onClick={() => setAllocationMode(mode)}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                        allocationMode === mode ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                      }`}>
                      {mode === "full" ? "Full Payment" : mode === "partial" ? "Partial Payment" : "Overpayment"}
                    </button>
                  ))}
                </div>

                {wizardData.invoice_id ? (
                  <div className="border border-slate-200 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <p className="font-medium text-slate-800">{wizardData.invoice_number}</p>
                        <p className="text-xs text-slate-400 capitalize">Status: {wizardData.invoice_status?.replace(/_/g, " ")}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-slate-500">Balance: <span className="font-semibold text-amber-600">{formatDisplayCurrency(wizardData.invoice_balance, wizardData.currency)}</span></p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <label className="block text-xs text-slate-500 mb-1">Allocation Amount</label>
                        <input type="number" min="0" step="0.01" value={wizardData.allocations[0]?.amount || 0}
                          onChange={(e) => updateAllocationAmount(0, e.target.value)}
                          className="w-full px-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                      </div>
                      <div className="pt-5">
                        <span className="text-sm text-slate-400">of {formatDisplayCurrency(wizardData.invoice_balance, wizardData.currency)}</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700 flex items-center gap-2">
                    <AlertCircle size={16} /> No invoice selected. This payment will be recorded without allocation.
                  </div>
                )}

                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
                  <div className="flex justify-between text-sm text-slate-600 mb-1">
                    <span>Payment Amount</span>
                    <span className="font-medium text-slate-800">{formatDisplayCurrency(wizardData.amount, wizardData.currency)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-slate-600 mb-1">
                    <span>Allocated</span>
                    <span className="font-medium text-slate-800">{formatDisplayCurrency(wizardData.allocations.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0), wizardData.currency)}</span>
                  </div>
                  <div className="flex justify-between text-sm font-medium border-t border-slate-200 pt-2 mt-1">
                    <span>Unallocated / Overpayment</span>
                    <span className={calcRemaining() > 0 ? "text-amber-600" : calcRemaining() < 0 ? "text-red-600" : "text-slate-800"}>
                      {formatDisplayCurrency(Math.abs(calcRemaining()), wizardData.currency)}
                      {calcRemaining() > 0 ? " (unallocated)" : calcRemaining() < 0 ? " (overpayment)" : ""}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {wizardStep === 3 && (
              <div className="space-y-6">
                <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><FileText size={20} className="text-brand-500" /> Review Payment</h3>

                <div className="border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <User size={16} className="text-slate-400" />
                    <div>
                      <p className="text-xs text-slate-500">Customer</p>
                      <p className="text-sm font-medium text-slate-800">{wizardData.customer_name}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Hash size={16} className="text-slate-400" />
                    <div>
                      <p className="text-xs text-slate-500">Payment Number</p>
                      <p className="text-sm font-medium text-slate-800">{wizardData.payment_number}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <DollarSign size={16} className="text-slate-400" />
                    <div>
                      <p className="text-xs text-slate-500">Amount</p>
                      <p className="text-sm font-medium text-slate-800">{formatDisplayCurrency(wizardData.amount, wizardData.currency)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <CreditCard size={16} className="text-slate-400" />
                    <div>
                      <p className="text-xs text-slate-500">Payment Type</p>
                      <p className="text-sm font-medium text-slate-800 capitalize">{wizardData.payment_type?.replace(/_/g, " ")}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Calendar size={16} className="text-slate-400" />
                    <div>
                      <p className="text-xs text-slate-500">Payment Date</p>
                      <p className="text-sm font-medium text-slate-800">{formatDisplayDate(wizardData.payment_date)}</p>
                    </div>
                  </div>
                  {wizardData.invoice_id && (
                    <div className="flex items-center gap-3">
                      <FileText size={16} className="text-slate-400" />
                      <div>
                        <p className="text-xs text-slate-500">Invoice</p>
                        <p className="text-sm font-medium text-slate-800">{wizardData.invoice_number} — {formatDisplayCurrency(wizardData.allocations.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0), wizardData.currency)} allocated</p>
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Transaction ID</label>
                  <input type="text" value={wizardData.transaction_id}
                    onChange={(e) => setWizardData((p) => ({ ...p, transaction_id: e.target.value }))}
                    placeholder="Optional transaction reference"
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Gateway</label>
                    <input type="text" value={wizardData.gateway}
                      onChange={(e) => setWizardData((p) => ({ ...p, gateway: e.target.value }))}
                      placeholder="e.g., Stripe, PayPal"
                      className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Gateway Fee</label>
                    <input type="number" min="0" step="0.01" value={wizardData.gateway_fee}
                      onChange={(e) => setWizardData((p) => ({ ...p, gateway_fee: parseFloat(e.target.value) || 0 }))}
                      className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                  <textarea value={wizardData.notes} onChange={(e) => setWizardData((p) => ({ ...p, notes: e.target.value }))}
                    rows={2} placeholder="Optional notes..."
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
            )}

            {wizardStep === 4 && (
              <div className="space-y-6">
                <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><CheckCircle size={20} className="text-brand-500" /> Confirm Payment</h3>
                <div className="border border-slate-200 rounded-xl p-6 bg-white">
                  <div className="flex justify-between items-start mb-6">
                    <div>
                      <h2 className="text-2xl font-bold text-slate-800">PAYMENT RECEIPT</h2>
                      <p className="text-sm text-slate-500 mt-1">#{wizardData.payment_number}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-slate-500">Date: {formatDisplayDate(wizardData.payment_date)}</p>
                      <p className="text-xs text-slate-400 mt-1">Status: Pending</p>
                    </div>
                  </div>
                  <div className="mb-6 p-4 bg-slate-50 rounded-xl">
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Customer</p>
                    <p className="font-medium text-slate-800">{wizardData.customer_name}</p>
                    {wizardData.customer_email && <p className="text-sm text-slate-500">{wizardData.customer_email}</p>}
                    {wizardData.customer_phone && <p className="text-sm text-slate-500">{wizardData.customer_phone}</p>}
                  </div>
                  <div className="border-t border-slate-200 pt-4 space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Payment Type</span>
                      <span className="font-medium text-slate-800 capitalize">{wizardData.payment_type?.replace(/_/g, " ")}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Amount</span>
                      <span className="font-medium text-slate-800">{formatDisplayCurrency(wizardData.amount, wizardData.currency)}</span>
                    </div>
                    {wizardData.allocations.length > 0 && wizardData.allocations[0]?.amount > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500">Allocated to {wizardData.invoice_number}</span>
                        <span className="font-medium text-emerald-600">{formatDisplayCurrency(wizardData.allocations.reduce((s, a) => s + (parseFloat(a.amount) || 0), 0), wizardData.currency)}</span>
                      </div>
                    )}
                    {calcRemaining() > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500">Unallocated Balance</span>
                        <span className="font-medium text-amber-600">{formatDisplayCurrency(calcRemaining(), wizardData.currency)}</span>
                      </div>
                    )}
                    {wizardData.gateway_fee > 0 && (
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500">Gateway Fee</span>
                        <span className="font-medium text-slate-800">{formatDisplayCurrency(wizardData.gateway_fee, wizardData.currency)}</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-between mt-8 pt-6 border-t border-slate-100">
              <div>
                {wizardStep > 1 && (
                  <button onClick={() => setWizardStep((s) => s - 1)} disabled={wizardLoading || !!wizardSuccess}
                    className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl disabled:opacity-50">Back</button>
                )}
              </div>
              <div className="flex gap-3">
                <button onClick={() => closeWizard()} disabled={wizardLoading || !!wizardSuccess}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl disabled:opacity-50">Cancel</button>
                {wizardStep < 4 ? (
                  <button onClick={() => {
                    if (wizardStep === 1 && !wizardData.customer_id) { setWizardError("Please select a customer"); return; }
                    if (wizardStep === 1 && (!wizardData.amount || parseFloat(wizardData.amount) <= 0)) { setWizardError("Please enter a valid payment amount"); return; }
                    if (wizardStep === 2 && wizardData.invoice_id) {
                      const allocAmt = parseFloat(wizardData.allocations[0]?.amount || 0);
                      if (allocAmt > parseFloat(wizardData.invoice_balance)) { setWizardError("Allocation amount cannot exceed invoice balance"); return; }
                    }
                    setWizardError(null);
                    setWizardStep((s) => s + 1);
                  }} disabled={wizardStep === 1 && (!wizardData.customer_id || !wizardData.amount)}
                    className="px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">
                    Continue
                  </button>
                ) : (
                  <button onClick={handleCreatePayment} disabled={wizardLoading || !!wizardSuccess}
                    className="inline-flex items-center gap-2 px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">
                    {wizardLoading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle size={16} />}
                    {wizardLoading ? "Recording..." : "Record Payment"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {ConfirmationDialog}
    </div>
  );
}
