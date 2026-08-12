import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { FileSignature, Search, Filter, X, ChevronDown, RefreshCw, Plus, AlertCircle, CheckCircle, Clock, FileText, XCircle, ArrowUpDown, Download, Ban, Send, User, Package, DollarSign, Eye, Trash2, Loader2, ShoppingCart, CreditCard, Percent, BarChart3 } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { quoteApi, customerApi, productApi, pricingApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { CalculationEngine } from "../utils/calculation-engine";
import { ErrorState, EmptyState, PageSkeleton, DashboardStatCard, DASHBOARD_KPI_GRID, DashboardDateRangeFilter, Pagination, useConfirmationDialog, StatusBadge as SharedStatusBadge } from "../../../components/billing-shared";
import { useCurrency } from "../utils/CurrencyContext";
import { useTerminology } from "../utils/TerminologyContext";
import { useBillingDateRange } from "../utils/DateRangeContext";

const ITEMS_PER_PAGE = 10;

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft", color: "bg-gray-100 text-gray-600" },
  { value: "sent", label: "Sent", color: "bg-blue-100 text-blue-700" },
  { value: "accepted", label: "Accepted", color: "bg-emerald-100 text-emerald-700" },
  { value: "rejected", label: "Rejected", color: "bg-red-100 text-red-700" },
  { value: "cancelled", label: "Cancelled", color: "bg-amber-100 text-amber-700" },
  { value: "converted", label: "Converted", color: "bg-brand-100 text-brand-700" },
  { value: "expired", label: "Expired", color: "bg-slate-100 text-slate-500" },
];

const STATUS_ICONS = { accepted: CheckCircle, rejected: XCircle, converted: RefreshCw, draft: Clock, sent: Send, cancelled: Ban, expired: Clock };

function StatusBadge({ status }) {
  return <SharedStatusBadge status={status} options={STATUS_OPTIONS} icon={STATUS_ICONS[status] || Clock} />;
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

export default function QuotationListPage() {
  const navigate = useNavigate();
  const { singular } = useTerminology();
  const [searchParams, setSearchParams] = useSearchParams();

  const [quotes, setQuotes] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const { baseCurrency: orgDefaultCurrency } = useCurrency();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const { range: dateRangeValue, setRange: setDateRangeValue, customStart, customEnd, applyCustomRange, reset: resetDateRange, dateRange } = useBillingDateRange();
  const [showFilters, setShowFilters] = useState(false);
  const [sortField, setSortField] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");
  const [currentPage, setCurrentPage] = useState(1);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectAll, setSelectAll] = useState(false);
  const [bulkLoading, setBulkLoading] = useState(false);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const [showWizard, setShowWizard] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardData, setWizardData] = useState({
    customer_id: "", customer_name: "", customer_email: "", customer_phone: "",
    quote_number: "", subject: "", valid_until: "", currency: orgDefaultCurrency, discount_percentage: 0,
    notes: "", terms: "",
    items: [],
  });
  const [wizardLoading, setWizardLoading] = useState(false);
  const [wizardError, setWizardError] = useState(null);

  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [customerSearching, setCustomerSearching] = useState(false);

  const [productSearch, setProductSearch] = useState("");
  const [productList, setProductList] = useState([]);
  const [productLoading, setProductLoading] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setCurrentPage(1); }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const defaultCurrency = quotes.length > 0
    ? (quotes.find((q) => q.currency)?.currency || orgDefaultCurrency)
    : orgDefaultCurrency;

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchQuotes = useCallback(async (isInitial = false) => {
    try {
      setError(null);
      if (!isInitial) setRefreshing(true);
      const sortBy = sortField === "amount" ? "total_amount" : sortField;
      const data = await quoteApi.list({
        page: safePage, per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        status: statusFilter || undefined,
        date_from: dateRange.date_from || undefined,
        date_to: dateRange.date_to || undefined,
        sort_by: sortBy, sort_order: sortDir,
      });
      const items = extractArray(data);
      setQuotes(items);
      setTotal(data?.total || items.length || 0);
    } catch (err) {
      setError(err.message || "Failed to load quotations");
      setQuotes([]); setTotal(0);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter, dateRange.date_from, dateRange.date_to, sortField, sortDir]);

  useEffect(() => { fetchQuotes(true); }, [fetchQuotes]);
  useEffect(() => { if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages); }, [totalPages, currentPage]);

  const handleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
    setCurrentPage(1);
  };

   const SortHeader = ({ field, label, align }) => (
    <th scope="col" className={`px-4 py-3 text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer select-none hover:text-slate-700 ${align === "right" ? "text-right" : "text-left"}`} onClick={() => handleSort(field)}>
      <div className={`flex items-center gap-1 ${align === "right" ? "justify-end" : ""}`}>{label}<ArrowUpDown size={12} className={`${sortField === field ? "text-brand-600" : "text-slate-300"}`} /></div>
    </th>
  );

  const handleSelectAll = () => {
    if (selectAll) { setSelectedIds(new Set()); setSelectAll(false); }
    else { setSelectedIds(new Set(quotes.map((q) => q.id))); setSelectAll(true); }
  };

  const handleSelectOne = (id) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
    setSelectAll(next.size === quotes.length && quotes.length > 0);
  };

  const handleBulkAction = async (action) => {
    if (selectedIds.size === 0) return;
    const label = action === "send" ? "Send" : "Cancel";
    const ok = await confirm({ title: `${label} quotations`, message: `${label} ${selectedIds.size} quotation(s)?`, confirmLabel: label });
    if (!ok) return;
    setBulkLoading(true);
    try {
      for (const id of selectedIds) {
        if (action === "send") await quoteApi.send(id);
        else if (action === "cancel") await quoteApi.cancel(id);
      }
      setSelectedIds(new Set()); setSelectAll(false);
      fetchQuotes();
    } catch (err) {
      setError(err.message || `Failed to ${action} quotations`);
    } finally { setBulkLoading(false); }
  };

  const handleExportJSON = () => {
    const blob = new Blob([JSON.stringify(quotes, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "quotations.json"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCSV = () => {
    const headers = ["Quote #", singular, "Status", "Amount", "Currency", "Valid Until", "Created"];
    const rows = quotes.map((q) => [
      q.quote_number || `#${q.id}`, q.customer_name || q.customer?.name || "",
      q.status || "", q.total_amount || 0, q.currency || defaultCurrency,
      q.valid_until || "", q.created_at || "",
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "quotations.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const openWizard = () => {
    const prefix = "QTN-";
    const ts = Date.now().toString(36).toUpperCase();
    setWizardData({
      customer_id: "", customer_name: "", customer_email: "", customer_phone: "",
      quote_number: `${prefix}${ts}`,
      subject: "", valid_until: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
      currency: orgDefaultCurrency, notes: "", terms: "",
      discount_percentage: 0, items: [],
    });
    setWizardStep(1); setWizardError(null); setShowWizard(true);
    setCustomerSearch(""); setCustomerResults([]);
    setProductSearch(""); setProductList([]);
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

  const handleCloseWizard = useCallback(() => {
    if (wizardLoading) return;
    setShowWizard(false);
    setWizardError(null);
    if (searchParams.get("create") || searchParams.get("customer_id")) {
      navigate("/billing/quotations", { replace: true });
    }
  }, [wizardLoading, searchParams, navigate]);

  useEffect(() => {
    if (searchParams.get("create") === "1" && !showWizard) openWizard();
  }, [searchParams, showWizard]);

  useEffect(() => {
    const requestedCustomerId = searchParams.get("customer_id");
    if (!showWizard || wizardStep !== 1 || !requestedCustomerId || wizardData.customer_id) return;
    const loadRequestedCustomer = async () => {
      try {
        const customer = await customerApi.get(requestedCustomerId);
        selectCustomer(customer);
      } catch {
        // Keep the quote flow intact if the customer prefill fails
      }
    };
    loadRequestedCustomer();
  }, [searchParams, showWizard, wizardStep, wizardData.customer_id]);

  const selectCustomer = (c) => {
    setWizardData((p) => ({
      ...p, customer_id: c.id, customer_name: c.display_name || c.company_name || c.name || `${singular} #${c.id}`,
        customer_email: c.email || "", customer_phone: c.phone || "", currency: c.currency || orgDefaultCurrency,
    }));
    setCustomerResults([]);
    setCustomerSearch("");
  };

  const loadProducts = useCallback(async () => {
    setProductLoading(true);
    try {
      const data = await productApi.list({ per_page: 100, status: "active" });
      setProductList(extractArray(data));
    } catch { setProductList([]); }
    finally { setProductLoading(false); }
  }, []);

  useEffect(() => {
    if (showWizard && wizardStep === 2) loadProducts();
  }, [showWizard, wizardStep, loadProducts]);

  const addLineItem = async (productId) => {
    const product = productList.find((p) => p.id === Number(productId));
    if (!product) return;
    let basePrice = parseFloat(product.default_price || 0);
    let unitPrice = basePrice;
    let pricingPlanId = null;
    let priceSource = "catalog";
    let resolvedPrice = basePrice;
    let availablePlans = null;
    let needsPlanSelection = false;
    try {
      const plans = await pricingApi.listByProduct(product.id);
      const activePlans = Array.isArray(plans) ? plans : plans?.items || [];
      if (activePlans.length === 1) {
        const resp = await pricingApi.resolvePrice({ product_id: product.id, pricing_plan_id: activePlans[0].id });
        unitPrice = parseFloat(resp.unit_price ?? resp.resolved_price ?? activePlans[0].unit_price ?? basePrice);
        resolvedPrice = parseFloat(resp.resolved_price ?? unitPrice);
        basePrice = parseFloat(resp.base_price ?? basePrice);
        pricingPlanId = resp.pricing_plan_id ?? activePlans[0].id;
        priceSource = resp.price_source ?? "pricing_plan";
      } else if (activePlans.length === 0) {
        const resp = await pricingApi.resolvePrice({ product_id: product.id });
        unitPrice = parseFloat(resp.unit_price ?? resp.resolved_price ?? basePrice);
        resolvedPrice = parseFloat(resp.resolved_price ?? unitPrice);
        basePrice = parseFloat(resp.base_price ?? basePrice);
        pricingPlanId = resp.pricing_plan_id ?? null;
        priceSource = resp.price_source ?? "catalog";
      } else {
        availablePlans = activePlans;
        needsPlanSelection = true;
        unitPrice = null;
        resolvedPrice = null;
        priceSource = null;
        pricingPlanId = null;
      }
    } catch (priceErr) {
      console.warn("Price resolution failed, using catalog price:", priceErr);
    }
    setWizardData((p) => ({
      ...p,
      items: [...p.items, {
        id: Date.now(), line_number: p.items.length + 1,
        product_id: product.id, product_name: product.name,
        description: product.description || product.name,
        quantity: 1, unit_price: unitPrice,
        discount_percentage: 0,
        tax_percentage: parseFloat(product.tax_percentage || 0),
        is_tax_inclusive: product.tax_inclusive || false,
        pricing_plan_id: pricingPlanId,
        base_price: basePrice,
        resolved_price: resolvedPrice,
        price_source: priceSource,
        available_plans: availablePlans,
        needs_plan_selection: needsPlanSelection,
      }],
    }));
  };

  const handlePlanSelect = async (itemId, planId) => {
    setWizardData((p) => {
      const item = p.items.find((i) => i.id === itemId);
      if (!item) return p;
      (async () => {
        try {
          const params = { product_id: item.product_id };
          if (planId) params.pricing_plan_id = planId;
          const resp = await pricingApi.resolvePrice(params);
          setWizardData((prev) => ({
            ...prev,
            items: prev.items.map((i) => i.id === itemId ? {
              ...i,
              unit_price: parseFloat(resp.unit_price ?? resp.resolved_price ?? i.unit_price ?? 0),
              resolved_price: parseFloat(resp.resolved_price ?? resp.unit_price ?? i.resolved_price ?? 0),
              base_price: parseFloat(resp.base_price ?? i.base_price ?? 0),
              pricing_plan_id: resp.pricing_plan_id ?? planId ?? null,
              price_source: resp.price_source ?? (planId ? "pricing_plan" : "catalog"),
              needs_plan_selection: false,
            } : i),
          }));
        } catch (planErr) {
          console.warn("Plan price resolution failed:", planErr);
        }
      })();
      return p;
    });
  };

  const updateLineItem = (itemId, field, value) => {
    setWizardData((p) => ({
      ...p,
      items: p.items.map((item) => item.id === itemId
        ? { ...item, [field]: value, ...(field === "unit_price" && item.product_id ? { price_source: "negotiated" } : {}) }
        : item),
    }));
  };

  const removeLineItem = (itemId) => {
    setWizardData((p) => ({
      ...p,
      items: p.items.filter((item) => item.id !== itemId).map((item, i) => ({ ...item, line_number: i + 1 })),
    }));
  };

  // Delegates to the shared CalculationEngine (same engine the invoice wizard
  // uses) so line-item math — including tax-inclusive pricing — always matches
  // the backend, instead of a separately-maintained local reimplementation.
  const calcItemTotal = (item) => {
    const r = CalculationEngine.calculateLineItem(
      item.quantity || 1,
      item.unit_price || 0,
      item.discount_percentage || 0,
      0,
      item.tax_percentage || 0,
      1.0,
      item.is_tax_inclusive || false,
    );
    return {
      lineTotal: r.originalSubtotal,
      afterDisc: r.originalTaxableAmount,
      discAmt: r.originalDiscount,
      taxAmt: r.originalTaxAmount,
      total: r.originalLineTotal,
    };
  };

  const calcWizardTotals = () => {
    const subtotal = wizardData.items.reduce((s, item) => s + item.quantity * item.unit_price, 0);
    const discPct = parseFloat(wizardData.discount_percentage || 0);
    const itemDisc = wizardData.items.reduce((s, item) => s + calcItemTotal(item).discAmt, 0);
    const quoteDisc = subtotal * discPct / 100;
    const totalDisc = itemDisc + quoteDisc;
    const afterDisc = subtotal - totalDisc;
    const itemTax = wizardData.items.reduce((s, item) => s + calcItemTotal(item).taxAmt, 0);
    return { subtotal, discount: totalDisc, taxAmount: itemTax, total: afterDisc + itemTax };
  };

  const handleCreateQuotation = async () => {
    if (!wizardData.customer_id || !wizardData.quote_number) return;
    setWizardLoading(true); setWizardError(null);
    try {
      const quoteResp = await quoteApi.create({
        customer_id: Number(wizardData.customer_id),
        quote_number: wizardData.quote_number,
        subject: wizardData.subject || undefined,
        valid_until: wizardData.valid_until || undefined,
        currency: wizardData.currency,
        discount_percentage: parseFloat(wizardData.discount_percentage || 0),
        notes: wizardData.notes || undefined,
        terms: wizardData.terms || undefined,
      });
      const quoteId = quoteResp.id;
      for (const item of wizardData.items) {
        await quoteApi.addItem(quoteId, {
          line_number: item.line_number,
          product_id: item.product_id ? Number(item.product_id) : undefined,
          description: item.description,
          quantity: parseFloat(item.quantity || 1),
          unit_price: parseFloat(item.unit_price || 0),
          discount_percentage: parseFloat(item.discount_percentage || 0),
          tax_percentage: parseFloat(item.tax_percentage || 0),
          is_tax_inclusive: item.is_tax_inclusive || false,
          pricing_plan_id: item.pricing_plan_id || undefined,
          base_price: item.base_price != null ? parseFloat(item.base_price) : undefined,
          resolved_price: item.resolved_price != null ? parseFloat(item.resolved_price) : undefined,
          price_source: item.price_source || undefined,
        });
      }
      await quoteApi.recalculate(quoteId);
      setShowWizard(false);
      setCurrentPage(1);
      fetchQuotes();
      navigate(`/billing/quotations/${quoteId}`);
    } catch (err) {
      setWizardError(err?.detail || err?.message || "Failed to create quotation");
    } finally { setWizardLoading(false); }
  };

  const filteredByStatus = (status) => quotes.filter((q) => q.status === status);

  if (loading) {
    return <HRPage title="Quotations" subtitle="Manage quotations"><PageSkeleton rows={6} /></HRPage>;
  }

  if (error && quotes.length === 0) {
    return <HRPage title="Quotations" subtitle="Manage quotations"><ErrorState message={error} onRetry={() => fetchQuotes(true)} /></HRPage>;
  }

  return (
    <HRPage title="Quotations" subtitle="Enterprise sales proposal workspace">
      <div className="space-y-6">
        <div className={DASHBOARD_KPI_GRID}>
          <DashboardStatCard title="Total" value={total} icon={FileText} color="from-slate-500 to-slate-600" onClick={() => { setStatusFilter(""); setCurrentPage(1); }} />
          <DashboardStatCard title="Draft" value={filteredByStatus("draft").length} icon={Clock} color="from-slate-500 to-slate-600" subtitle={`${total > 0 ? ((filteredByStatus("draft").length / total) * 100).toFixed(0) : 0}%`} onClick={() => { setStatusFilter("draft"); setCurrentPage(1); }} />
          <DashboardStatCard title="Sent" value={filteredByStatus("sent").length} icon={Send} color="from-blue-500 to-blue-600" onClick={() => { setStatusFilter("sent"); setCurrentPage(1); }} />
          <DashboardStatCard title="Accepted" value={filteredByStatus("accepted").length} icon={CheckCircle} color="from-emerald-500 to-emerald-600" onClick={() => { setStatusFilter("accepted"); setCurrentPage(1); }} />
        </div>
        <div className={DASHBOARD_KPI_GRID}>
          <DashboardStatCard title="Rejected" value={filteredByStatus("rejected").length} icon={XCircle} color="from-red-500 to-rose-500" onClick={() => { setStatusFilter("rejected"); setCurrentPage(1); }} />
          <DashboardStatCard title="Converted" value={filteredByStatus("converted").length} icon={RefreshCw} color="from-brand to-brand-hover" onClick={() => { setStatusFilter("converted"); setCurrentPage(1); }} />
          <DashboardStatCard title="Cancelled/Exp" value={filteredByStatus("cancelled").length + filteredByStatus("expired").length} icon={Ban} color="from-amber-500 to-orange-500" />
          <DashboardStatCard title="Total Value" value={quotes.reduce((s, q) => s + parseFloat(q.total_amount || 0), 0)} currency={defaultCurrency} icon={DollarSign} color="from-brand to-brand-hover" />
        </div>

        <div className="bg-white border border-slate-200 rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
          <div className="p-6 border-b border-slate-100">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3 flex-1">
                <div className="relative flex-1 max-w-md">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input type="text" placeholder="Search quotations..." value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search quotations"
                    className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" aria-label="Clear search"><X size={16} /></button>}
                </div>
                <button onClick={() => setShowFilters(!showFilters)}
                  className={`p-2.5 rounded-xl border transition-colors ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
                  aria-label="Toggle filters" aria-expanded={showFilters}>
                  <Filter size={18} />
                </button>
                <button onClick={() => { setRefreshing(true); fetchQuotes(); }} disabled={refreshing}
                  className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50" aria-label="Refresh quotations">
                  <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
                </button>
                {selectedIds.size > 0 && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 font-medium">{selectedIds.size} selected</span>
                    <button onClick={() => handleBulkAction("send")} disabled={bulkLoading}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 rounded-lg hover:bg-blue-100 disabled:opacity-50">
                      {bulkLoading ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Send
                    </button>
                    <button onClick={() => handleBulkAction("cancel")} disabled={bulkLoading}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-50">
                      <Ban size={12} /> Cancel
                    </button>
                    <button onClick={() => { setSelectedIds(new Set()); setSelectAll(false); }}
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" aria-label="Clear selection"><X size={14} /></button>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => navigate("/billing/quotations/dashboard")}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors">
                  <BarChart3 size={16} /> Dashboard
                </button>
                <button onClick={handleExportJSON} className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" title="Export JSON" aria-label="Export quotations as JSON"><Download size={18} /></button>
                <button onClick={handleExportCSV} className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" title="Export CSV" aria-label="Export quotations as CSV"><FileText size={18} /></button>
                <button onClick={() => navigate("/billing/quotations/create")}
                  className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg">
                  <Plus size={18} /> New Quotation
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
                <DashboardDateRangeFilter range={dateRangeValue} onRangeChange={setDateRangeValue} customStart={customStart} customEnd={customEnd} onApplyCustom={applyCustomRange} onResetCustom={resetDateRange} />
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
                    <input type="checkbox" checked={selectAll} onChange={handleSelectAll}
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" aria-label="Select all quotations" />
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Quotation</th>
                   <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">{singular}</th>
                   <SortHeader field="amount" label="Amount" align="right" />
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Valid Until</th>
                  <SortHeader field="created_at" label="Created" />
                  <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {quotes.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-16 text-center">
                      <EmptyState
                        icon={FileSignature}
                        title="No quotations found"
                        message={search || statusFilter || dateRange.date_from ? "Try adjusting your search or filters" : "Create your first quotation to get started"}
                      />
                    </td>
                  </tr>
                ) : quotes.map((q) => (
                  <tr key={q.id} tabIndex={0} role="row"
                    className="hover:bg-slate-50 transition-colors focus:outline-2 focus:outline-brand-400 focus:outline-offset-[-2px]"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); navigate(`/billing/quotations/${q.id}`); }
                      if (e.key === "Escape") { e.preventDefault(); setSelectedIds(new Set()); setSelectAll(false); }
                    }}>
                    <td className="px-4 py-4">
                      <input type="checkbox" checked={selectedIds.has(q.id)} onChange={() => handleSelectOne(q.id)}
                        className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" aria-label={`Select quotation ${q.quote_number || q.id}`} />
                    </td>
                    <td className="px-4 py-4">
                      <button onClick={() => navigate(`/billing/quotations/${q.id}`)} className="font-medium text-slate-800 hover:text-brand-600 transition-colors whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <FileSignature size={14} className="text-slate-400" />
                          {q.quote_number || `#${q.id}`}
                          {q.quote_version > 1 && <span className="text-xs text-slate-400">v{q.quote_version}</span>}
                        </div>
                      </button>
                    </td>
                    <td className="px-4 py-4 text-slate-600">{q.customer_name || q.customer?.name || `${singular} #${q.customer_id}`}</td>
                     <td className="px-4 py-4 font-medium text-slate-800 whitespace-nowrap text-right">{formatDisplayCurrency(q.total_amount || q.total || 0, q.currency)}</td>
                    <td className="px-4 py-4"><StatusBadge status={q.status} /></td>
                    <td className="px-4 py-4 text-slate-500 text-xs">{formatDisplayDate(q.valid_until)}</td>
                    <td className="px-4 py-4 text-slate-500 text-xs">{formatDisplayDate(q.created_at)}</td>
                    <td className="px-4 py-4 text-right">
                      <button onClick={() => navigate(`/billing/quotations/${q.id}`)}
                        className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-brand-600 transition-colors" title="View" aria-label={`View quotation ${q.quote_number || q.id}`}>
                        <Eye size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
            {total} total quotation(s)
          </Pagination>
        </div>
      </div>

      {showWizard && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-10 overflow-y-auto" onClick={handleCloseWizard}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-4xl shadow-2xl mx-4 mb-10" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-slate-800">New Quotation</h2>
              <button onClick={handleCloseWizard} disabled={wizardLoading} aria-label="Close modal" className="p-1 hover:bg-slate-100 rounded-lg disabled:opacity-50"><X size={20} /></button>
            </div>

            <div className="flex items-center justify-between mb-8 px-4">
              <WizardStep number={1} label={singular} active={wizardStep === 1} completed={wizardStep > 1} />
              <div className="flex-1 h-px bg-slate-200 mx-3" />
              <WizardStep number={2} label="Products" active={wizardStep === 2} completed={wizardStep > 2} />
              <div className="flex-1 h-px bg-slate-200 mx-3" />
              <WizardStep number={3} label="Pricing Review" active={wizardStep === 3} completed={wizardStep > 3} />
              <div className="flex-1 h-px bg-slate-200 mx-3" />
              <WizardStep number={4} label="Preview" active={wizardStep === 4} completed={wizardStep > 4} />
            </div>

            {wizardError && (
              <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700"><AlertCircle size={16} />{wizardError}</div>
            )}

            {wizardStep === 1 && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><User size={20} className="text-brand-500" /> Select {singular}</h3>
                {wizardData.customer_id ? (
                  <div className="p-4 bg-brand-50 border border-brand-200 rounded-xl flex items-center justify-between">
                    <div>
                      <p className="font-medium text-slate-800">{wizardData.customer_name}</p>
                      <p className="text-sm text-slate-500">{wizardData.customer_email}{wizardData.customer_phone ? ` · ${wizardData.customer_phone}` : ""}</p>
                    </div>
                    <button onClick={() => setWizardData((p) => ({ ...p, customer_id: "", customer_name: "", customer_email: "", customer_phone: "" }))}
                      className="text-sm text-brand-600 hover:text-brand-700 font-medium">Change</button>
                  </div>
                ) : (
                  <div>
                    <div className="relative mb-3">
                      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <input type="text" placeholder={`Search ${singular.toLowerCase()}s by name, email, or phone...`} value={customerSearch}
                        onChange={(e) => setCustomerSearch(e.target.value)}
                        className="w-full pl-9 pr-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                    </div>
                    {customerSearching && <p className="text-sm text-slate-400 text-center py-2">Searching...</p>}
                    {customerResults.length > 0 && (
                      <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-60 overflow-y-auto">
                        {customerResults.map((c) => (
                          <button key={c.id} onClick={() => selectCustomer(c)}
                            className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors">
                            <p className="font-medium text-slate-800">{c.display_name || c.company_name || c.name || `${singular} #${c.id}`}</p>
                            <p className="text-xs text-slate-400">{c.email}{c.phone ? ` · ${c.phone}` : ""}</p>
                          </button>
                        ))}
                      </div>
                    )}
                    {customerResults.length === 0 && customerSearch.trim() && !customerSearching && (
                      <p className="text-sm text-slate-400 text-center py-4">No {singular.toLowerCase()}s found</p>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Quote Number *</label>
                    <input type="text" value={wizardData.quote_number}
                      onChange={(e) => setWizardData((p) => ({ ...p, quote_number: e.target.value }))}
                      className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Valid Until</label>
                    <input type="date" value={wizardData.valid_until}
                      onChange={(e) => setWizardData((p) => ({ ...p, valid_until: e.target.value }))}
                      className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Subject</label>
                  <input type="text" value={wizardData.subject}
                    onChange={(e) => setWizardData((p) => ({ ...p, subject: e.target.value }))}
                    placeholder="Brief description of this quotation..."
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
            )}

            {wizardStep === 2 && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><Package size={20} className="text-brand-500" /> Products & Services</h3>

                {productLoading ? (
                  <div className="flex items-center justify-center py-8"><Loader2 size={24} className="animate-spin text-brand-600" /></div>
                ) : (
                  <div className="relative mb-4">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <select value="" onChange={(e) => { if (e.target.value) { addLineItem(e.target.value); e.target.value = ""; } }}
                      className="w-full pl-9 pr-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30 appearance-none">
                      <option value="">Add a product or service...</option>
                      {productList.map((p) => <option key={p.id} value={p.id}>{p.name} — {formatDisplayCurrency(p.default_price, wizardData.currency)}</option>)}
                    </select>
                  </div>
                )}

                {wizardData.items.length === 0 ? (
                  <div className="text-center py-8 text-slate-400">
                    <ShoppingCart size={32} className="mx-auto mb-2 text-slate-300" />
                    <p>No line items yet. Select a product above to add one.</p>
                  </div>
                ) : (
                  <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
                    {wizardData.items.map((item) => {
                      const totals = calcItemTotal(item);
                      return (
                        <div key={item.id} className="p-4">
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-medium text-slate-800">{item.product_name || item.description}</span>
                            <button onClick={() => removeLineItem(item.id)} className="p-1 text-slate-400 hover:text-red-600" aria-label="Remove line item" title="Remove line item"><Trash2 size={14} /></button>
                          </div>
                          {item.needs_plan_selection && (
                            <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                              <p className="text-xs font-medium text-amber-700 mb-2">Select a pricing plan for this item:</p>
                              <div className="flex flex-wrap gap-2">
                                <button onClick={() => handlePlanSelect(item.id, null)}
                                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-brand-200 transition-colors">
                                  Catalog Price
                                </button>
                                {item.available_plans && item.available_plans.map((plan) => (
                                  <button key={plan.id} onClick={() => handlePlanSelect(item.id, plan.id)}
                                    className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-brand-50 hover:border-brand-200 hover:text-brand-700 transition-colors">
                                    {plan.name || plan.plan_name || `Plan #${plan.id}`}
                                    {plan.unit_price != null && <span className="ml-1 text-slate-400">— {formatDisplayCurrency(plan.unit_price, wizardData.currency)}</span>}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          <div className="grid grid-cols-5 gap-3">
                            <div>
                              <label className="text-xs text-slate-500">Qty</label>
                              <input type="number" min="1" step="1" value={item.quantity}
                                onChange={(e) => updateLineItem(item.id, "quantity", Math.max(1, parseInt(e.target.value) || 1))}
                                className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                            </div>
                            <div>
                              <label className="text-xs text-slate-500">Unit Price</label>
                              <input type="number" min="0" step="0.01" value={item.unit_price}
                                onChange={(e) => updateLineItem(item.id, "unit_price", parseFloat(e.target.value) || 0)}
                                className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                            </div>
                            <div>
                              <label className="text-xs text-slate-500">Disc %</label>
                              <input type="number" min="0" max="100" step="0.1" value={item.discount_percentage}
                                onChange={(e) => updateLineItem(item.id, "discount_percentage", parseFloat(e.target.value) || 0)}
                                className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                            </div>
                            <div>
                              <label className="text-xs text-slate-500">Tax %</label>
                              <input type="number" min="0" max="100" step="0.1" value={item.tax_percentage}
                                onChange={(e) => updateLineItem(item.id, "tax_percentage", parseFloat(e.target.value) || 0)}
                                className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                            </div>
                            <div className="flex items-end justify-end">
                              <p className="text-sm font-semibold text-slate-800">{formatDisplayCurrency(totals.total, wizardData.currency)}</p>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                  <textarea value={wizardData.notes} onChange={(e) => setWizardData((p) => ({ ...p, notes: e.target.value }))}
                    rows={2} placeholder="Internal notes..."
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
            )}

            {wizardStep === 3 && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><DollarSign size={20} className="text-brand-500" /> Pricing Review</h3>

                {wizardData.items.length === 0 ? (
                  <div className="text-center py-8 text-slate-400">
                    <p>No items to review. Add products in the previous step.</p>
                  </div>
                ) : (
                  <div className="border border-slate-200 rounded-xl overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50">
                          <th scope="col" className="px-4 py-2 text-left text-xs font-semibold text-slate-500 uppercase">Item</th>
                          <th scope="col" className="px-4 py-2 text-right text-xs font-semibold text-slate-500 uppercase">Qty</th>
                          <th scope="col" className="px-4 py-2 text-right text-xs font-semibold text-slate-500 uppercase">Price</th>
                          <th scope="col" className="px-4 py-2 text-right text-xs font-semibold text-slate-500 uppercase">Disc</th>
                          <th scope="col" className="px-4 py-2 text-right text-xs font-semibold text-slate-500 uppercase">Tax</th>
                          <th scope="col" className="px-4 py-2 text-right text-xs font-semibold text-slate-500 uppercase">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {wizardData.items.map((item) => {
                          const t = calcItemTotal(item);
                          return (
                            <tr key={item.id}>
                              <td className="px-4 py-2 text-slate-800">{item.product_name || item.description}</td>
                              <td className="px-4 py-2 text-right text-slate-600">{item.quantity}</td>
                              <td className="px-4 py-2 text-right text-slate-600">{formatDisplayCurrency(item.unit_price, wizardData.currency)}</td>
                              <td className="px-4 py-2 text-right text-slate-500">{item.discount_percentage > 0 ? `${item.discount_percentage}%` : "—"}</td>
                              <td className="px-4 py-2 text-right text-slate-500">{item.tax_percentage > 0 ? `${item.tax_percentage}%` : "—"}</td>
                              <td className="px-4 py-2 text-right font-medium text-slate-800">{formatDisplayCurrency(t.total, wizardData.currency)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Discount %</label>
                  <div className="relative max-w-xs">
                    <Percent size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input type="number" min="0" max="100" step="0.1" value={wizardData.discount_percentage}
                      onChange={(e) => setWizardData((p) => ({ ...p, discount_percentage: parseFloat(e.target.value) || 0 }))}
                      className="w-full pl-9 pr-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                </div>

                <div className="border-t border-slate-200 pt-4">
                  <div className="flex justify-between text-sm text-slate-600 mb-1">
                    <span>Subtotal ({wizardData.items.length} item(s))</span>
                    <span>{formatDisplayCurrency(calcWizardTotals().subtotal, wizardData.currency)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-slate-600 mb-1">
                    <span>Discount</span>
                    <span className="text-red-500">-{formatDisplayCurrency(calcWizardTotals().discount, wizardData.currency)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-slate-600 mb-1">
                    <span>Tax</span>
                    <span>{formatDisplayCurrency(calcWizardTotals().taxAmount, wizardData.currency)}</span>
                  </div>
                  <div className="flex justify-between text-lg font-bold text-slate-800 border-t border-slate-200 pt-2 mt-2">
                    <span>Total</span>
                    <span>{formatDisplayCurrency(calcWizardTotals().total, wizardData.currency)}</span>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Terms & Conditions</label>
                  <textarea value={wizardData.terms} onChange={(e) => setWizardData((p) => ({ ...p, terms: e.target.value }))}
                    rows={2} placeholder="Payment terms, delivery terms, etc."
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
            )}

            {wizardStep === 4 && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><Eye size={20} className="text-brand-500" /> Preview</h3>

                <div className="border border-slate-200 rounded-xl p-6 bg-white">
                  <div className="flex justify-between items-start mb-6">
                    <div>
                      <h2 className="text-2xl font-bold text-slate-800">QUOTATION</h2>
                      <p className="text-sm text-slate-500 mt-1">#{wizardData.quote_number}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-slate-500">Valid Until: {formatDisplayDate(wizardData.valid_until)}</p>
                      <p className="text-xs text-slate-400 mt-1">Status: Draft</p>
                    </div>
                  </div>

                  <div className="mb-6 p-4 bg-slate-50 rounded-xl">
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">{singular}</p>
                    <p className="font-medium text-slate-800">{wizardData.customer_name}</p>
                    {wizardData.customer_email && <p className="text-sm text-slate-500">{wizardData.customer_email}</p>}
                    {wizardData.customer_phone && <p className="text-sm text-slate-500">{wizardData.customer_phone}</p>}
                  </div>

                  {wizardData.subject && (
                    <div className="mb-4">
                      <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Subject</p>
                      <p className="text-sm text-slate-700">{wizardData.subject}</p>
                    </div>
                  )}

                  {wizardData.items.length > 0 && (
                    <div className="overflow-x-auto mb-4">
                      <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-200">
                          <th scope="col" className="py-2 text-left text-xs font-semibold text-slate-500 uppercase">Item</th>
                          <th scope="col" className="py-2 text-right text-xs font-semibold text-slate-500 uppercase">Qty</th>
                          <th scope="col" className="py-2 text-right text-xs font-semibold text-slate-500 uppercase">Price</th>
                          <th scope="col" className="py-2 text-right text-xs font-semibold text-slate-500 uppercase">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {wizardData.items.map((item) => (
                          <tr key={item.id}>
                            <td className="py-2 text-slate-800">{item.product_name || item.description}</td>
                            <td className="py-2 text-right text-slate-600">{item.quantity}</td>
                            <td className="py-2 text-right text-slate-600">{formatDisplayCurrency(item.unit_price, wizardData.currency)}</td>
                            <td className="py-2 text-right font-medium text-slate-800">{formatDisplayCurrency(calcItemTotal(item).total, wizardData.currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                      </table>
                    </div>
                  )}

                  <div className="border-t border-slate-200 pt-3 ml-auto w-64">
                    <div className="flex justify-between text-sm text-slate-600 mb-1">
                      <span>Subtotal</span>
                      <span>{formatDisplayCurrency(calcWizardTotals().subtotal, wizardData.currency)}</span>
                    </div>
                    {calcWizardTotals().discount > 0 && (
                      <div className="flex justify-between text-sm text-red-500 mb-1">
                        <span>Discount</span>
                        <span>-{formatDisplayCurrency(calcWizardTotals().discount, wizardData.currency)}</span>
                      </div>
                    )}
                    {calcWizardTotals().taxAmount > 0 && (
                      <div className="flex justify-between text-sm text-slate-600 mb-1">
                        <span>Tax</span>
                        <span>{formatDisplayCurrency(calcWizardTotals().taxAmount, wizardData.currency)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-base font-bold text-slate-800 border-t border-slate-200 pt-2 mt-1">
                      <span>Total</span>
                      <span>{formatDisplayCurrency(calcWizardTotals().total, wizardData.currency)}</span>
                    </div>
                  </div>

                  {wizardData.terms && (
                    <div className="mt-4 p-3 bg-slate-50 rounded-lg text-xs text-slate-500">
                      <p className="font-medium text-slate-600 mb-1">Terms</p>
                      <p className="whitespace-pre-wrap">{wizardData.terms}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="flex justify-between mt-8 pt-6 border-t border-slate-100">
              <div>
                {wizardStep > 1 && (
                  <button onClick={() => setWizardStep((s) => s - 1)}
                    className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Back</button>
                )}
              </div>
              <div className="flex gap-3">
                <button onClick={handleCloseWizard}
                  disabled={wizardLoading}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl disabled:opacity-50">Cancel</button>
                {wizardStep < 4 ? (
                  <button onClick={() => {
                    if (wizardStep === 1 && !wizardData.customer_id) { setWizardError("Please select a customer"); return; }
                    if (wizardStep === 2 && wizardData.items.length === 0) { setWizardError("Please add at least one product"); return; }
                    setWizardError(null);
                    setWizardStep((s) => s + 1);
                  }} disabled={wizardStep === 1 && !wizardData.customer_id}
                    className="px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">
                    Continue
                  </button>
                ) : (
                  <button onClick={handleCreateQuotation} disabled={wizardLoading}
                    className="inline-flex items-center gap-2 px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">
                    {wizardLoading ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}
                    {wizardLoading ? "Creating..." : "Create Quotation"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {ConfirmationDialog}
    </HRPage>
  );
}
