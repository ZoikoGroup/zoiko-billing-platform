import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Users, Search, Filter, X, RefreshCw, Download,
  CheckCircle, AlertCircle, Clock, UserCheck, UserX, Plus, ArrowUpDown,
  FileText, Mail, Phone,
  Columns, Upload, Trash2 } from "lucide-react"
import HRPage from "../../../components/HRPage";
import { customerApi, settingsApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency } from "../../../utils/billing-helpers";
import { getCurrencySelectOptions, getCountrySelectOptions, getCurrencyForCountry } from "../../../utils/currency";
import { getCustomerTaxFields } from "../utils/countryIntelligence";
import { useCurrency, getOrgBaseCurrency } from "../utils/CurrencyContext";
import { useTerminology } from "../utils/TerminologyContext";
import { useConfirmationDialog, PageSkeleton, ErrorState, Pagination, StatusBadge as SharedStatusBadge } from "../../../components/billing-shared";

const ITEMS_PER_PAGE = 15;

const STATUS_OPTIONS = [
  { value: "active", label: "Active", color: "bg-emerald-100 text-emerald-700" },
  { value: "inactive", label: "Inactive", color: "bg-gray-100 text-gray-700" },
  { value: "suspended", label: "Suspended", color: "bg-amber-100 text-amber-700" },
  { value: "closed", label: "Closed", color: "bg-red-100 text-red-700" },
];

const STATUS_ICONS = { active: CheckCircle, suspended: AlertCircle, inactive: Clock, closed: Clock };

const PAYMENT_TERMS_OPTIONS = [
  { value: "", label: "All Terms" },
  { value: "due_on_receipt", label: "Due on Receipt" },
  { value: "net_15", label: "Net 15" },
  { value: "net_30", label: "Net 30" },
  { value: "net_45", label: "Net 45" },
  { value: "net_60", label: "Net 60" },
  { value: "net_90", label: "Net 90" },
];

const PAYMENT_TERMS_CREDIT_DAYS = {
  due_on_receipt: 0, net_15: 15, net_30: 30, net_45: 45, net_60: 60, net_90: 90,
};

const CUSTOMER_TYPES = [
  { value: "", label: "All Types" },
  { value: "business", label: "Business" },
  { value: "individual", label: "Individual" },
  { value: "non_profit", label: "Non-Profit" },
  { value: "government", label: "Government" },
];

const ALL_COLUMNS = [
  { key: "name", label: "Name", default: true },
  { key: "contact", label: "Contact", default: true },
  { key: "company", label: "Company", default: true },
  { key: "status", label: "Status", default: true },
  { key: "customer_type", label: "Type", default: false },
  { key: "currency", label: "Currency", default: false },
  { key: "payment_terms", label: "Payment Terms", default: false },
  { key: "credit_limit", label: "Credit Limit", default: false },
  { key: "outstanding", label: "Outstanding", default: false },
  { key: "revenue", label: "Revenue", default: false },
  { key: "created_at", label: "Created", default: true },
];

export default function CustomerListPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { confirm, ConfirmationDialog } = useConfirmationDialog();
  const { baseCurrency } = useCurrency();
  const { singular, plural, getLabel } = useTerminology();

  const [customers, setCustomers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState("");
  const [paymentTermsFilter, setPaymentTermsFilter] = useState("");
  const [industryFilter, setIndustryFilter] = useState("");
  const [creditLimitMin, setCreditLimitMin] = useState("");
  const [creditLimitMax, setCreditLimitMax] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [showColumnSelector, setShowColumnSelector] = useState(false);

  const [visibleColumns, setVisibleColumns] = useState(ALL_COLUMNS.filter((c) => c.default).map((c) => c.key));

  const [sortField, setSortField] = useState("company_name");
  const [sortDir, setSortDir] = useState("asc");
  const [currentPage, setCurrentPage] = useState(1);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectAll, setSelectAll] = useState(false);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [editCustomer, setEditCustomer] = useState(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState(null);

  const [bulkActionLoading, setBulkActionLoading] = useState(false);

  const [kpiData, setKpiData] = useState(null);
  const [orgConfig, setOrgConfig] = useState(null);

  const [newCustomer, setNewCustomer] = useState({
    company_name: "", display_name: "", legal_name: "", email: "", phone: "", website: "",
    customer_type: "business", status: "active",
    gst_number: "", vat_number: "", pan: "", tin: "", tax_id: "",
    billing_address: "", shipping_address: "", billing_country: "", shipping_country: "",
    shipping_same_as_billing: false,
    currency: "", payment_terms: "net_30", credit_limit: "", credit_days: 30, price_list: "",
    notes: "",
  });

  const [importText, setImportText] = useState("");
  const [importResult, setImportResult] = useState(null);
  const [importLoading, setImportLoading] = useState(false);

  const fetchKPI = useCallback(() => {
    customerApi.getKPI().then(setKpiData).catch((err) => {
      console.error("[CustomerList] Failed to load KPI data:", err);
      setError(err?.detail || err?.message || "Failed to load KPI data");
    });
  }, []);

  useEffect(() => {
    fetchKPI();
    settingsApi.getConfig().then((cfg) => {
      setOrgConfig(cfg);
      const orgCurrency = cfg?.base_currency || cfg?.default_currency || getOrgBaseCurrency();
      setNewCustomer((prev) => ({ ...prev, currency: prev.currency || orgCurrency }));
    }).catch((err) => {
      console.error("[CustomerList] Failed to load config:", err);
      // Don't set main error state here, config is non-fatal for listing
    });
  }, [fetchKPI]);

  useEffect(() => {
    const requestedStatus = searchParams.get("status");
    if (requestedStatus) setStatusFilter(requestedStatus);
  }, [searchParams]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const hasActiveFilters = statusFilter || typeFilter || currencyFilter || paymentTermsFilter || industryFilter || creditLimitMin || creditLimitMax || dateFrom || dateTo;

  const clearFilters = () => {
    setStatusFilter(""); setTypeFilter(""); setCurrencyFilter(""); setPaymentTermsFilter("");
    setIndustryFilter(""); setCreditLimitMin(""); setCreditLimitMax("");
    setDateFrom(""); setDateTo(""); setCurrentPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchCustomers = useCallback(async () => {
    try {
      setError(null);
      if (!loading) setRefreshing(true);

      const params = {
        page: safePage,
        per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        status: statusFilter || undefined,
        customer_type: typeFilter || undefined,
        currency: currencyFilter || undefined,
        payment_terms: paymentTermsFilter || undefined,
        industry: industryFilter || undefined,
        credit_limit_min: creditLimitMin || undefined,
        credit_limit_max: creditLimitMax || undefined,
        date_from: dateFrom || undefined,
        date_to: dateTo || undefined,
        sort_by: sortField,
        sort_order: sortDir,
      };

      const data = await customerApi.list(params);
      const items = data.items || data.data || data || [];
      setCustomers(Array.isArray(items) ? items : []);
      setTotal(data.total || items.length || 0);
      setSelectedIds(new Set());
      setSelectAll(false);
    } catch (err) {
      setError(err.message || "Failed to load customers");
      setCustomers([]);
      setTotal(0);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter, typeFilter, currencyFilter, paymentTermsFilter, industryFilter, creditLimitMin, creditLimitMax, dateFrom, dateTo, sortField, sortDir, loading]);

  useEffect(() => { fetchCustomers(); }, [fetchCustomers]);

  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages);
  }, [totalPages, currentPage]);

  const handleRefresh = () => { setRefreshing(true); fetchCustomers(); };

  const handleSort = (field) => {
    if (sortField === field) { setSortDir((d) => (d === "asc" ? "desc" : "asc")); }
    else { setSortField(field); setSortDir("asc"); }
    setCurrentPage(1);
  };

  const handleSelectAll = (checked) => {
    if (checked) setSelectedIds(new Set(customers.map((c) => c.id)));
    else setSelectedIds(new Set());
    setSelectAll(checked);
  };

  const handleSelectOne = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectAll(next.size === customers.length && customers.length > 0);
      return next;
    });
  };

  const handleBulkAction = async (action) => {
    if (selectedIds.size === 0) return;
    setBulkActionLoading(true);
    try {
      const ids = Array.from(selectedIds);
      const results = await Promise.allSettled(ids.map((id) => {
        if (action === "activate") return customerApi.activate(id);
        if (action === "deactivate") return customerApi.deactivate(id);
        if (action === "suspend") return customerApi.suspend(id);
        return Promise.resolve();
      }));
      setSelectedIds(new Set());
      setSelectAll(false);
      fetchCustomers();
      fetchKPI();
    } catch (err) {
      setError(err.message || "Bulk action failed");
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const ok = await confirm({
      title: `Delete selected ${plural.toLowerCase()}`,
      message: `Delete ${selectedIds.size} selected ${selectedIds.size === 1 ? singular.toLowerCase() : plural.toLowerCase()}? This cannot be undone.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setBulkActionLoading(true);
    try {
      await customerApi.bulkDelete(Array.from(selectedIds));
      setSelectedIds(new Set());
      setSelectAll(false);
      fetchCustomers();
      fetchKPI();
    } catch (err) {
      setError(err.message || "Bulk delete failed");
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleExport = async (format) => {
    try {
      const allData = await customerApi.exportData(format);
      const items = allData.items || allData.data || allData || [];
      const rows = Array.isArray(items) ? items : [];

      if (format === "json") {
        const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `customers-${new Date().toISOString().split("T")[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
      } else {
        const headers = ["Name", "Email", "Phone", "Company", "Type", "Status", "Currency", "Payment Terms", "Credit Limit", "Created"];
        const csv = [headers.join(","), ...rows.map((r) => [
          `"${(r.display_name || r.company_name || "").replace(/"/g, '""')}"`,
          r.email || "", r.phone || "", r.company_name || "", r.customer_type || "",
          r.status || "", r.currency || "", r.payment_terms || "", r.credit_limit || "", r.created_at || ""
        ].join(","))].join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `customers-${new Date().toISOString().split("T")[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setError(err.message || "Export failed");
    }
  };

  const handleCreate = async () => {
    setFormLoading(true);
    setFormError(null);
    if (!newCustomer.company_name?.trim()) { setFormError("Company name is required"); setFormLoading(false); return; }
    if (!newCustomer.email?.trim()) { setFormError("Email is required"); setFormLoading(false); return; }
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(newCustomer.email.trim())) { setFormError("Please enter a valid email address"); setFormLoading(false); return; }
    try {
      const payload = {
        ...newCustomer,
        customer_code: newCustomer.customer_code || `CUST-${Date.now()}`,
        credit_days: newCustomer.credit_days === "" || newCustomer.credit_days == null ? PAYMENT_TERMS_CREDIT_DAYS[newCustomer.payment_terms] ?? 30 : Math.max(0, parseInt(newCustomer.credit_days, 10) || 0),
        credit_limit: newCustomer.credit_limit === "" || newCustomer.credit_limit == null ? undefined : Math.max(0, parseFloat(newCustomer.credit_limit) || 0),
      };
      if (payload.credit_limit === undefined) delete payload.credit_limit;
      delete payload.shipping_same_as_billing;
      await customerApi.create(payload);
      setShowCreateModal(false);
      setNewCustomer({
        company_name: "", display_name: "", legal_name: "", email: "", phone: "", website: "",
        customer_type: "business", status: "active",
        gst_number: "", vat_number: "", pan: "", tin: "", tax_id: "",
        billing_address: "", shipping_address: "", billing_country: "", shipping_country: "",
        shipping_same_as_billing: false,
        currency: orgConfig?.base_currency || orgConfig?.default_currency || getOrgBaseCurrency(), payment_terms: "net_30", credit_limit: "", credit_days: 30, price_list: "",
        notes: "",
      });
      setCurrentPage(1);
      fetchCustomers();
      fetchKPI();
    } catch (err) {
      setFormError(err.message || "Failed to create customer");
    } finally {
      setFormLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!editCustomer) return;
    setFormLoading(true);
    setFormError(null);
    if (!editCustomer.company_name?.trim()) { setFormError("Company name is required"); setFormLoading(false); return; }
    try {
      const payload = { ...editCustomer };
      payload.credit_days = editCustomer.credit_days === "" || editCustomer.credit_days == null ? undefined : Math.max(0, parseInt(editCustomer.credit_days, 10) || 0);
      payload.credit_limit = editCustomer.credit_limit === "" || editCustomer.credit_limit == null ? undefined : Math.max(0, parseFloat(editCustomer.credit_limit) || 0);
      if (payload.credit_days === undefined) delete payload.credit_days;
      if (payload.credit_limit === undefined) delete payload.credit_limit;
      await customerApi.update(editCustomer.id, payload);
      setShowEditModal(false);
      setEditCustomer(null);
      fetchCustomers();
      fetchKPI();
    } catch (err) {
      setFormError(err.message || "Failed to update customer");
    } finally {
      setFormLoading(false);
    }
  };

  const handleImport = async () => {
    setImportLoading(true);
    setImportResult(null);
    try {
      let items;
      try { items = JSON.parse(importText); }
      catch { items = importText.split("\n").filter(Boolean).map((line) => {
        const parts = line.split(",");
        return { company_name: parts[0], email: parts[1], customer_code: parts[2] || `IMP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` };
      }); }
      const result = await customerApi.importData(items);
      setImportResult(result);
      if (result.imported > 0) { setShowImportModal(false); setImportText(""); fetchCustomers(); fetchKPI(); }
    } catch (err) {
      setImportResult({ success: false, imported: 0, skipped: 0, errors: [err.message || "Import failed"] });
    } finally {
      setImportLoading(false);
    }
  };

  const SortHeader = ({ field, label }) => (
    <th scope="col" className={`px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer select-none hover:text-slate-700 ${!visibleColumns.includes(field) ? "hidden" : ""}`} onClick={() => handleSort(field)}>
      <div className="flex items-center gap-1">{label}<ArrowUpDown size={12} className={`${sortField === field ? "text-brand-600" : "text-slate-300"}`} /></div>
    </th>
  );

  const clearForm = () => setNewCustomer({
    company_name: "", display_name: "", legal_name: "", email: "", phone: "", website: "",
    customer_type: "business", status: "active",
    gst_number: "", vat_number: "", pan: "", tin: "", tax_id: "",
    billing_address: "", shipping_address: "", billing_country: "", shipping_country: "",
    shipping_same_as_billing: false,
    currency: orgConfig?.base_currency || orgConfig?.default_currency || getOrgBaseCurrency(), payment_terms: "net_30", credit_limit: "", credit_days: 30, price_list: "",
    notes: "",
  });

  const renderCreateModal = () => (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 overflow-y-auto py-8" onClick={() => { setShowCreateModal(false); clearForm(); }}>
      <div className="bg-white rounded-3xl p-8 w-full max-w-3xl shadow-2xl my-auto max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-slate-800">New {singular}</h2>
          <button onClick={() => { setShowCreateModal(false); clearForm(); }} className="p-1 hover:bg-slate-100 rounded-lg" aria-label="Close dialog"><X size={20} /></button>
        </div>
        {formError && <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700"><AlertCircle size={16} />{formError}</div>}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div><label className="block text-sm font-medium text-slate-700 mb-1">Company Name <span className="text-red-500">*</span></label><input value={newCustomer.company_name} onChange={(e) => setNewCustomer((p) => ({ ...p, company_name: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
          <div><label className="block text-sm font-medium text-slate-700 mb-1">Display Name</label><input value={newCustomer.display_name} onChange={(e) => setNewCustomer((p) => ({ ...p, display_name: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
          <div><label className="block text-sm font-medium text-slate-700 mb-1">Email <span className="text-red-500">*</span></label><input type="email" value={newCustomer.email} onChange={(e) => setNewCustomer((p) => ({ ...p, email: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
          <div><label className="block text-sm font-medium text-slate-700 mb-1">Phone</label><input value={newCustomer.phone} onChange={(e) => setNewCustomer((p) => ({ ...p, phone: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
          <div><label className="block text-sm font-medium text-slate-700 mb-1">Website</label><input value={newCustomer.website} onChange={(e) => setNewCustomer((p) => ({ ...p, website: e.target.value }))} placeholder="https://example.com" className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
          <div><label className="block text-sm font-medium text-slate-700 mb-1">Customer Type</label><select value={newCustomer.customer_type} onChange={(e) => setNewCustomer((p) => ({ ...p, customer_type: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"><option value="business">Business</option><option value="individual">Individual</option><option value="non_profit">Non-Profit</option><option value="government">Government</option></select></div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <div><label className="block text-sm font-medium text-slate-700 mb-1">Currency</label><select value={newCustomer.currency} onChange={(e) => setNewCustomer((p) => ({ ...p, currency: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"><option value="">Select</option>{getCurrencySelectOptions().map((c) => (<option key={c.value} value={c.value}>{c.value} - {c.label}</option>))}</select></div>
          <div><label className="block text-sm font-medium text-slate-700 mb-1">Payment Terms</label><select value={newCustomer.payment_terms} onChange={(e) => { const t = e.target.value; setNewCustomer((p) => ({ ...p, payment_terms: t, credit_days: PAYMENT_TERMS_CREDIT_DAYS[t] ?? 30 })); }} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"><option value="due_on_receipt">Due on Receipt</option><option value="net_15">Net 15</option><option value="net_30">Net 30</option><option value="net_45">Net 45</option><option value="net_60">Net 60</option><option value="net_90">Net 90</option></select></div>
          <div><label className="block text-sm font-medium text-slate-700 mb-1">Credit Limit</label><input type="number" min="0" step="0.01" value={newCustomer.credit_limit} onChange={(e) => setNewCustomer((p) => ({ ...p, credit_limit: e.target.value }))} placeholder="0.00" className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
          <div><label className="block text-sm font-medium text-slate-700 mb-1">Credit Days</label><input type="number" min="0" step="1" value={newCustomer.credit_days} onChange={(e) => setNewCustomer((p) => ({ ...p, credit_days: e.target.value === "" ? "" : Math.max(0, parseInt(e.target.value, 10) || 0) }))} placeholder="0" className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div><label className="block text-sm font-medium text-slate-700 mb-1">Billing Address</label><textarea rows={2} value={newCustomer.billing_address} onChange={(e) => setNewCustomer((p) => ({ ...p, billing_address: e.target.value }))} placeholder="Street, City, State, ZIP, Country" className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
          <div><label className="block text-sm font-medium text-slate-700 mb-1">Billing Country</label><select value={newCustomer.billing_country} onChange={(e) => { const country = e.target.value; const curInfo = getCurrencyForCountry(country); setNewCustomer((p) => ({ ...p, billing_country: country, shipping_country: p.shipping_same_as_billing ? country : p.shipping_country, currency: p.currency || (curInfo ? curInfo.code : p.currency) })); }} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"><option value="">Select Country</option>{getCountrySelectOptions().map((c) => (<option key={c.code} value={c.value}>{c.label}</option>))}</select></div>

            <label className="flex items-center gap-2 text-sm text-slate-700 mb-2"><input type="checkbox" checked={newCustomer.shipping_same_as_billing} onChange={(e) => setNewCustomer((p) => ({ ...p, shipping_same_as_billing: e.target.checked, shipping_address: e.target.checked ? p.billing_address : "", shipping_country: e.target.checked ? p.billing_country : "" }))} className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" /> Same as billing</label>
            {!newCustomer.shipping_same_as_billing && (<><label className="block text-sm font-medium text-slate-700 mb-1">Shipping Address</label><textarea rows={2} value={newCustomer.shipping_address} onChange={(e) => setNewCustomer((p) => ({ ...p, shipping_address: e.target.value }))} placeholder="Street, City, State, ZIP, Country" className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /><label className="block text-sm font-medium text-slate-700 mb-1">Shipping Country</label><select value={newCustomer.shipping_country} onChange={(e) => setNewCustomer((p) => ({ ...p, shipping_country: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"><option value="">Select Country</option>{getCountrySelectOptions().map((c) => (<option key={c.code} value={c.value}>{c.label}</option>))}</select></>)}
                     </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          {getCustomerTaxFields(newCustomer.billing_country).map((f) => (
            <div key={f.key}>
              <label className="block text-sm font-medium text-slate-700 mb-1">{f.label}</label>
              <input value={newCustomer[f.key] || ""} onChange={(e) => setNewCustomer((p) => ({ ...p, [f.key]: e.target.value }))} placeholder={f.placeholder} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
          ))}
          {!newCustomer.billing_country && <p className="md:col-span-2 text-xs text-slate-400">Select a billing country above to show its relevant tax identifier(s).</p>}
        </div>
        <div className="mb-4"><label className="block text-sm font-medium text-slate-700 mb-1">Notes</label><textarea rows={2} value={newCustomer.notes} onChange={(e) => setNewCustomer((p) => ({ ...p, notes: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
        <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-100">
          <button onClick={() => { setShowCreateModal(false); clearForm(); }} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
          <button onClick={handleCreate} disabled={formLoading || !newCustomer.company_name} className="px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">{formLoading ? "Creating..." : `Create ${singular}`}</button>
        </div>
      </div>
    </div>
  );

  const renderEditModal = () => {
    if (!editCustomer) return null;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 overflow-y-auto py-8" onClick={() => setShowEditModal(false)}>
        <div className="bg-white rounded-3xl p-8 w-full max-w-3xl shadow-2xl my-auto max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-6"><h2 className="text-xl font-bold text-slate-800">Edit {singular}</h2><button onClick={() => setShowEditModal(false)} className="p-1 hover:bg-slate-100 rounded-lg" aria-label="Close dialog"><X size={20} /></button></div>
          {formError && <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700"><AlertCircle size={16} />{formError}</div>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {["company_name", "display_name", "email", "phone", "website"].map((field) => (
              <div key={field}><label className="block text-sm font-medium text-slate-700 mb-1 capitalize">{field.replace(/_/g, " ")}{field === "company_name" ? " *" : ""}</label><input type={field === "email" ? "email" : "text"} value={editCustomer[field] || ""} onChange={(e) => setEditCustomer((p) => ({ ...p, [field]: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
            ))}
            <div><label className="block text-sm font-medium text-slate-700 mb-1">Customer Type</label><select value={editCustomer.customer_type || "business"} onChange={(e) => setEditCustomer((p) => ({ ...p, customer_type: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"><option value="business">Business</option><option value="individual">Individual</option><option value="non_profit">Non-Profit</option><option value="government">Government</option></select></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <div><label className="block text-sm font-medium text-slate-700 mb-1">Currency</label><select value={editCustomer.currency || ""} onChange={(e) => setEditCustomer((p) => ({ ...p, currency: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"><option value="">Select</option>{getCurrencySelectOptions().map((c) => (<option key={c.value} value={c.value}>{c.value}</option>))}</select></div>
            <div><label className="block text-sm font-medium text-slate-700 mb-1">Payment Terms</label><select value={editCustomer.payment_terms || "net_30"} onChange={(e) => { const t = e.target.value; setEditCustomer((p) => ({ ...p, payment_terms: t, credit_days: PAYMENT_TERMS_CREDIT_DAYS[t] ?? 30 })); }} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"><option value="due_on_receipt">Due on Receipt</option><option value="net_15">Net 15</option><option value="net_30">Net 30</option><option value="net_45">Net 45</option><option value="net_60">Net 60</option><option value="net_90">Net 90</option></select></div>
            <div><label className="block text-sm font-medium text-slate-700 mb-1">Credit Limit</label><input type="number" min="0" step="0.01" value={editCustomer.credit_limit || ""} onChange={(e) => setEditCustomer((p) => ({ ...p, credit_limit: e.target.value }))} placeholder="0.00" className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
            <div><label className="block text-sm font-medium text-slate-700 mb-1">Credit Days</label><input type="number" min="0" step="1" value={editCustomer.credit_days ?? ""} onChange={(e) => setEditCustomer((p) => ({ ...p, credit_days: e.target.value === "" ? "" : Math.max(0, parseInt(e.target.value, 10) || 0) }))} placeholder="0" className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div><label className="block text-sm font-medium text-slate-700 mb-1">Billing Address</label><textarea rows={2} value={editCustomer.billing_address || ""} onChange={(e) => setEditCustomer((p) => ({ ...p, billing_address: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
            <div><label className="block text-sm font-medium text-slate-700 mb-1">Shipping Address</label><textarea rows={2} value={editCustomer.shipping_address || ""} onChange={(e) => setEditCustomer((p) => ({ ...p, shipping_address: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" /></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div><label className="block text-sm font-medium text-slate-700 mb-1">Billing Country</label><select value={editCustomer.billing_country || ""} onChange={(e) => setEditCustomer((p) => ({ ...p, billing_country: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"><option value="">Select Country</option>{getCountrySelectOptions().map((c) => (<option key={c.code} value={c.value}>{c.label}</option>))}</select></div>
            <div><label className="block text-sm font-medium text-slate-700 mb-1">Shipping Country</label><select value={editCustomer.shipping_country || ""} onChange={(e) => setEditCustomer((p) => ({ ...p, shipping_country: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30"><option value="">Select Country</option>{getCountrySelectOptions().map((c) => (<option key={c.code} value={c.value}>{c.label}</option>))}</select></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {getCustomerTaxFields(editCustomer.billing_country).map((f) => (
              <div key={f.key}>
                <label className="block text-sm font-medium text-slate-700 mb-1">{f.label}</label>
                <input value={editCustomer[f.key] || ""} onChange={(e) => setEditCustomer((p) => ({ ...p, [f.key]: e.target.value }))} placeholder={f.placeholder} className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            ))}
            {!editCustomer.billing_country && <p className="md:col-span-2 text-xs text-slate-400">Select a billing country above to show its relevant tax identifier(s).</p>}
          </div>
          <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-slate-100"><button onClick={() => setShowEditModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button><button onClick={handleUpdate} disabled={formLoading} className="px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">{formLoading ? "Saving..." : "Save Changes"}</button></div>
        </div>
      </div>
    );
  };

  const renderImportModal = () => (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 overflow-y-auto py-8" onClick={() => { setShowImportModal(false); setImportResult(null); setImportText(""); }}>
      <div className="bg-white rounded-3xl p-8 w-full max-w-2xl shadow-2xl my-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6"><h2 className="text-xl font-bold text-slate-800">Import {plural}</h2><button onClick={() => { setShowImportModal(false); setImportResult(null); setImportText(""); }} className="p-1 hover:bg-slate-100 rounded-lg" aria-label="Close dialog"><X size={20} /></button></div>
        {importResult ? (
          <div className={`p-4 rounded-xl ${importResult.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"} mb-4`}>
            <p className="font-medium">{importResult.imported} imported, {importResult.skipped} skipped</p>
            {importResult.errors?.length > 0 && <ul className="mt-2 text-xs space-y-1 max-h-40 overflow-y-auto">{importResult.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
          </div>
        ) : (
          <>
            <div className="mb-4">
              <label className="block text-sm font-medium text-slate-700 mb-2">Paste JSON array or CSV rows</label>
              <textarea rows={8} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='[{"company_name":"Acme","email":"acme@test.com","customer_code":"CUST-001"}]' className="w-full px-4 py-3 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 font-mono" />
            </div>
            <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
              <button onClick={() => { setShowImportModal(false); setImportText(""); }} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
              <button onClick={handleImport} disabled={importLoading || !importText.trim()} className="px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">{importLoading ? "Importing..." : "Import"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  if (loading) {
    return <HRPage title={plural} subtitle={`Manage your ${getLabel("pluralLower")}`}><PageSkeleton rows={6} /></HRPage>;
  }

  if (error && customers.length === 0) {
    return <HRPage title={plural} subtitle={`Manage your ${getLabel("pluralLower")}`}><ErrorState message={error} onRetry={handleRefresh} /></HRPage>;
  }

  return (
    <HRPage title={plural} subtitle={`Manage your ${getLabel("pluralLower")}`}>
      {kpiData && (
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-7 gap-3 mb-6">
          <div className="bg-white rounded-xl border border-slate-200 p-4"><p className="text-xs font-medium text-slate-500 uppercase tracking-wider truncate">Total</p><p className="text-xl font-bold text-slate-800 mt-1 whitespace-nowrap">{kpiData.total_customers || 0}</p></div>
          <div className="bg-white rounded-xl border border-slate-200 p-4"><p className="text-xs font-medium text-slate-500 uppercase tracking-wider truncate">Active</p><p className="text-xl font-bold text-emerald-600 mt-1 whitespace-nowrap">{kpiData.active_customers || 0}</p></div>
          <div className="bg-white rounded-xl border border-slate-200 p-4"><p className="text-xs font-medium text-slate-500 uppercase tracking-wider truncate">Inactive</p><p className="text-xl font-bold text-slate-500 mt-1 whitespace-nowrap">{kpiData.inactive_customers || 0}</p></div>
          <div className="bg-white rounded-xl border border-slate-200 p-4"><p className="text-xs font-medium text-slate-500 uppercase tracking-wider truncate">New (30d)</p><p className="text-xl font-bold text-brand-600 mt-1 whitespace-nowrap">{kpiData.new_customers_30d || 0}</p></div>
          <div className="bg-white rounded-xl border border-slate-200 p-4"><p className="text-xs font-medium text-slate-500 uppercase tracking-wider truncate">Revenue</p><p className="text-xl font-bold text-slate-800 mt-1 whitespace-nowrap">{formatDisplayCurrency(kpiData.total_revenue || 0, baseCurrency)}</p></div>
          <div className="bg-white rounded-xl border border-slate-200 p-4"><p className="text-xs font-medium text-slate-500 uppercase tracking-wider truncate">Outstanding</p><p className="text-xl font-bold text-amber-600 mt-1 whitespace-nowrap">{formatDisplayCurrency(kpiData.outstanding_balance || 0, baseCurrency)}</p></div>
          <div className="bg-white rounded-xl border border-slate-200 p-4"><p className="text-xs font-medium text-slate-500 uppercase tracking-wider truncate">Avg Collection</p><p className="text-xl font-bold text-slate-800 mt-1 whitespace-nowrap">{kpiData.avg_collection_time_days || 0}d</p></div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
        <div className="p-6 border-b border-slate-100">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-1">
              <div className="relative flex-1 max-w-md">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input type="text" placeholder={getLabel("searchPlaceholder")} value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-9 pr-8 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" aria-label="Clear search"><X size={16} /></button>}
              </div>
              <button onClick={() => setShowFilters(!showFilters)}
                className={`p-2.5 rounded-xl border transition-colors ${showFilters || hasActiveFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
                aria-label="Toggle filters" aria-pressed={showFilters}>
                <Filter size={18} />
              </button>
              <div className="relative">
                <button onClick={() => setShowColumnSelector(!showColumnSelector)}
                  className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50"
                  aria-label="Choose visible columns" aria-pressed={showColumnSelector}>
                  <Columns size={18} />
                </button>
                {showColumnSelector && (
                  <div className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg p-3 z-50 w-48" onClick={(e) => e.stopPropagation()}>
                    <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Columns</p>
                    {ALL_COLUMNS.map((col) => (
                      <label key={col.key} className="flex items-center gap-2 py-1.5 text-sm text-slate-700 cursor-pointer hover:bg-slate-50 px-2 rounded-lg">
                        <input type="checkbox" checked={visibleColumns.includes(col.key)}
                          onChange={() => setVisibleColumns((prev) => prev.includes(col.key) ? prev.filter((k) => k !== col.key) : [...prev, col.key])}
                          className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                        {col.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={handleRefresh} disabled={refreshing} className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50" aria-label="Refresh list">
                <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowImportModal(true)} className="flex items-center gap-2 px-3 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50"><Upload size={16} /> Import</button>
              <div className="relative group">
                <button className="flex items-center gap-2 px-3 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50"><Download size={16} /> Export</button>
                <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg p-1 hidden group-hover:block z-50 min-w-[140px]">
                  <button onClick={() => handleExport("csv")} className="block w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 rounded-lg">Export CSV</button>
                  <button onClick={() => handleExport("json")} className="block w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 rounded-lg">Export JSON</button>
                </div>
              </div>
              <button onClick={() => setShowCreateModal(true)} className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg"><Plus size={18} /> {getLabel("newButton")}</button>
            </div>
          </div>

          {showFilters && (
            <div className="flex flex-wrap items-center gap-3 mt-4 pt-4 border-t border-slate-100">
              <div>
                <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-3 py-2 pr-7 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">All Statuses</option>
                  {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-3 py-2 pr-7 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  {CUSTOMER_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <select value={currencyFilter} onChange={(e) => { setCurrencyFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-3 py-2 pr-7 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">All Currencies</option>
                  {getCurrencySelectOptions().map((c) => <option key={c.value} value={c.value}>{c.value}</option>)}
                </select>
              </div>
              <div>
                <select value={paymentTermsFilter} onChange={(e) => { setPaymentTermsFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-3 py-2 pr-7 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  {PAYMENT_TERMS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div>
                <input type="number" placeholder="Min credit limit" value={creditLimitMin} onChange={(e) => { setCreditLimitMin(e.target.value); setCurrentPage(1); }}
                  className="w-28 px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <input type="number" placeholder="Max credit limit" value={creditLimitMax} onChange={(e) => { setCreditLimitMax(e.target.value); setCurrentPage(1); }}
                  className="w-28 px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setCurrentPage(1); }}
                  className="px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <span className="text-slate-400 text-sm">-</span>
              <div>
                <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setCurrentPage(1); }}
                  className="px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              {hasActiveFilters && (
                <button onClick={clearFilters} className="flex items-center gap-1 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-xl">
                  <X size={14} /> Clear
                </button>
              )}
            </div>
          )}
        </div>

        {selectedIds.size > 0 && (
          <div className="flex items-center gap-3 px-6 py-3 bg-brand-50 border-b border-brand-100">
            <span className="text-sm font-medium text-brand-700">{selectedIds.size} selected</span>
            <div className="h-4 w-px bg-brand-200" />
            <button onClick={() => handleBulkAction("activate")} disabled={bulkActionLoading} className="flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 disabled:opacity-50"><UserCheck size={14} /> Activate</button>
            <button onClick={() => handleBulkAction("deactivate")} disabled={bulkActionLoading} className="flex items-center gap-1 px-3 py-1.5 bg-gray-600 text-white rounded-lg text-xs font-medium hover:bg-gray-700 disabled:opacity-50"><UserX size={14} /> Deactivate</button>
            <button onClick={() => handleBulkAction("suspend")} disabled={bulkActionLoading} className="flex items-center gap-1 px-3 py-1.5 bg-amber-600 text-white rounded-lg text-xs font-medium hover:bg-amber-700 disabled:opacity-50"><AlertCircle size={14} /> Suspend</button>
            <button onClick={handleBulkDelete} disabled={bulkActionLoading} className="flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 disabled:opacity-50"><Trash2 size={14} /> Delete</button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th scope="col" className="px-3 py-3 w-10"><input type="checkbox" checked={selectAll} onChange={(e) => handleSelectAll(e.target.checked)} className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" aria-label={`Select all ${plural.toLowerCase()}`} /></th>
                <SortHeader field="name" label="Name" />
                <th scope="col" className={`px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider ${!visibleColumns.includes("contact") ? "hidden" : ""}`}>Contact</th>
                <th scope="col" className={`px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider ${!visibleColumns.includes("company") ? "hidden" : ""}`}>Company</th>
                <SortHeader field="status" label="Status" />
                <th scope="col" className={`px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider ${!visibleColumns.includes("customer_type") ? "hidden" : ""}`}>Type</th>
                <th scope="col" className={`px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider ${!visibleColumns.includes("currency") ? "hidden" : ""}`}>Currency</th>
                <th scope="col" className={`px-3 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider ${!visibleColumns.includes("payment_terms") ? "hidden" : ""}`}>Terms</th>
                <th scope="col" className={`px-3 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider ${!visibleColumns.includes("credit_limit") ? "hidden" : ""}`}>Credit Limit</th>
                <th scope="col" className={`px-3 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider ${!visibleColumns.includes("outstanding") ? "hidden" : ""}`}>Outstanding</th>
                <th scope="col" className={`px-3 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider ${!visibleColumns.includes("revenue") ? "hidden" : ""}`}>Revenue</th>
                <SortHeader field="created_at" label="Created" />
                <th scope="col" className="px-3 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {customers.length === 0 ? (
                <tr><td colSpan={13} className="px-4 py-16 text-center">
                  <div className="flex flex-col items-center"><Users size={40} className="text-slate-300 mb-3" /><p className="text-slate-500 font-medium">{getLabel("emptyState")}</p><p className="text-slate-400 text-sm mt-1">{search || hasActiveFilters ? "Try adjusting your search or filters" : `Add your first ${getLabel("singularLower")} to get started`}</p></div>
                </td></tr>
              ) : customers.map((customer) => (
                <tr key={customer.id} tabIndex={0} role="row"
                  className={`hover:bg-slate-50 transition-colors focus:outline-2 focus:outline-brand-400 focus:outline-offset-[-2px] ${selectedIds.has(customer.id) ? "bg-brand-50/50" : ""}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); navigate(`/billing/customers/${customer.id}`); }
                    if (e.key === "Escape") { e.preventDefault(); setSelectedIds(new Set()); setSelectAll(false); }
                  }}>
                  <td className="px-3 py-3"><input type="checkbox" checked={selectedIds.has(customer.id)} onChange={() => handleSelectOne(customer.id)} className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" aria-label={`Select ${customer.display_name || customer.company_name || singular.toLowerCase()}`} /></td>
                  <td className="px-3 py-3">
                    <button onClick={() => navigate(`/billing/customers/${customer.id}`)} className="flex items-center gap-3 group">
                      <div className="h-8 w-8 rounded-full bg-gradient-to-br from-brand to-brand-hover text-white flex items-center justify-center text-sm font-bold flex-shrink-0">
                        {(customer.display_name || customer.company_name || "?").charAt(0).toUpperCase()}
                      </div>
                      <div className="text-left">
                        <p className="font-medium text-slate-800 group-hover:text-brand-600 transition-colors truncate max-w-[180px]">{customer.display_name || customer.company_name || "Unnamed"}</p>
                        <p className="text-xs text-slate-400">{customer.customer_code || customer.id}</p>
                      </div>
                    </button>
                  </td>
                  <td className={`px-3 py-3 ${!visibleColumns.includes("contact") ? "hidden" : ""}`}>
                    <div className="flex flex-col gap-0.5">
                      {customer.email && <span className="flex items-center gap-1 text-xs text-slate-500"><Mail size={12} />{customer.email}</span>}
                      {customer.phone && <span className="flex items-center gap-1 text-xs text-slate-500"><Phone size={12} />{customer.phone}</span>}
                    </div>
                  </td>
                  <td className={`px-3 py-3 text-sm text-slate-600 ${!visibleColumns.includes("company") ? "hidden" : ""}`}>{customer.company_name || "—"}</td>
                  <td className="px-3 py-3"><SharedStatusBadge status={customer.status} options={STATUS_OPTIONS} icon={STATUS_ICONS[customer.status] || Clock} /></td>
                  <td className={`px-3 py-3 text-xs text-slate-500 capitalize ${!visibleColumns.includes("customer_type") ? "hidden" : ""}`}>{customer.customer_type?.replace(/_/g, " ") || "—"}</td>
                  <td className={`px-3 py-3 text-xs text-slate-500 ${!visibleColumns.includes("currency") ? "hidden" : ""}`}>{customer.currency || "—"}</td>
                  <td className={`px-3 py-3 text-xs text-slate-500 capitalize ${!visibleColumns.includes("payment_terms") ? "hidden" : ""}`}>{customer.payment_terms?.replace(/_/g, " ") || "—"}</td>
                  <td className={`px-3 py-3 text-right text-sm font-medium text-slate-800 ${!visibleColumns.includes("credit_limit") ? "hidden" : ""} whitespace-nowrap`}>{formatDisplayCurrency(customer.credit_limit || 0, baseCurrency)}</td>
                  <td className={`px-3 py-3 text-right text-sm font-medium ${!visibleColumns.includes("outstanding") ? "hidden" : ""} ${parseFloat(customer.outstanding_balance || 0) > 0 ? "text-amber-600" : "text-slate-800"} whitespace-nowrap`}>{formatDisplayCurrency(customer.outstanding_balance || 0, baseCurrency)}</td>
                  <td className={`px-3 py-3 text-right text-sm font-medium text-slate-800 ${!visibleColumns.includes("revenue") ? "hidden" : ""} whitespace-nowrap`}>{formatDisplayCurrency(customer.total_revenue || 0, baseCurrency)}</td>
                  <td className="px-3 py-3 text-xs text-slate-500">{formatDisplayDate(customer.created_at)}</td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => navigate(`/billing/customers/${customer.id}`)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-brand-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" title="View" aria-label={`View ${customer.display_name || customer.company_name || singular.toLowerCase()}`}><FileText size={15} /></button>
                      <button onClick={() => { setEditCustomer({ ...customer }); setShowEditModal(true); }} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-blue-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" title="Edit" aria-label={`Edit ${customer.display_name || customer.company_name || singular.toLowerCase()}`}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
          {total} total {plural}(s)
        </Pagination>
      </div>

      {showCreateModal && renderCreateModal()}
      {showEditModal && renderEditModal()}
      {showImportModal && renderImportModal()}
      {ConfirmationDialog}
    </HRPage>
  );
}
