import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Package, Search, Filter, X, ChevronDown, ArrowUpDown, RefreshCw, Download, Plus, AlertCircle, CheckCircle, Clock, Archive, Image, Eye, Copy, RotateCcw, CreditCard, Upload, Sparkles, Trash2, Loader2, Pencil,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { productApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency } from "../../../utils/billing-helpers";
import { getCurrencySelectOptions } from "../../../utils/currency";
import { useCurrency } from "../utils/CurrencyContext";
import ImportWizardModal from "./import-wizard";
import { useConfirmationDialog, PageSkeleton, SuccessMessage, ErrorState, Pagination, StatusBadge } from "../../../components/billing-shared";

const PRODUCT_STATUS_BADGE_OPTIONS = [
  { value: "active", label: "active", color: "bg-green-100 text-green-700" },
  { value: "inactive", label: "inactive", color: "bg-slate-100 text-slate-700" },
  { value: "archived", label: "archived", color: "bg-slate-100 text-slate-600" },
];

const ITEMS_PER_PAGE = 10;

const IMAGE_FALLBACK_SRC = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='1.5'%3E%3Crect x='3' y='3' width='18' height='18' rx='2'/%3E%3Ccircle cx='8.5' cy='8.5' r='1.5'/%3E%3Cpath d='M21 15l-5-5L5 21'/%3E%3C/svg%3E";

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "archived", label: "Archived (Deleted)" },
];

const TYPE_OPTIONS = [
  { value: "service", label: "Service" },
  { value: "good", label: "Good" },
  { value: "subscription", label: "Subscription" },
  { value: "usage", label: "Usage-Based" },
  { value: "retainer", label: "Retainer" },
  { value: "other", label: "Other" },
];

const BILLING_FREQUENCY_OPTIONS = [
  { value: "one_time", label: "One Time" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
  { value: "usage_based", label: "Usage Based" },
  { value: "recurring", label: "Recurring" },
];

const SORT_FIELDS = [
  { key: "name", label: "Name" },
  { key: "code", label: "Code" },
  { key: "default_price", label: "Price" },
  { key: "created_at", label: "Created" },
];

const COLUMN_OPTIONS = [
  { key: "name", label: "Product" },
  { key: "code", label: "Code" },
  { key: "default_price", label: "Price" },
  { key: "product_type", label: "Type" },
  { key: "status", label: "Status" },
  { key: "created_at", label: "Created" },
  { key: "image", label: "Image" },
];

export default function ProductListPage() {
  const { baseCurrency } = useCurrency();
  const navigate = useNavigate();
  const { confirm, ConfirmationDialog } = useConfirmationDialog();
  const [products, setProducts] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const searchInputRef = useRef(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [sortField, setSortField] = useState("name");
  const [sortDir, setSortDir] = useState("asc");
  const [currentPage, setCurrentPage] = useState(1);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectAll, setSelectAll] = useState(false);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editProduct, setEditProduct] = useState(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState(null);
  const [showAdvancedCreate, setShowAdvancedCreate] = useState(false);
  const [showAdvancedEdit, setShowAdvancedEdit] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState(null);

  const [categories, setCategories] = useState([]);

  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState(null);

  const [visibleColumns, setVisibleColumns] = useState(new Set(COLUMN_OPTIONS.map((c) => c.key)));
  const [showColumnMenu, setShowColumnMenu] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);

  const [newProduct, setNewProduct] = useState({
    name: "", code: "", default_price: "", description: "", product_type: "service", is_active: true, image_url: "",
    category_id: "", brand: "", billing_frequency: "one_time", default_discount: "", invoice_description: "",
    currency: baseCurrency, original_price: "", country: "", gst_vat_group: "",
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
      if (e.key === "Escape" && document.activeElement === searchInputRef.current) {
        searchInputRef.current.blur();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchProducts = useCallback(async (isInitial = false) => {
    try {
      setError(null);
      if (!isInitial) setRefreshing(true);

      const params = {
        page: safePage,
        per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        product_type: typeFilter || undefined,
        status: statusFilter || undefined,
        category_id: categoryFilter || undefined,
        currency: currencyFilter || undefined,
        sort_by: sortField,
        sort_order: sortDir,
      };
      const data = await productApi.list(params);
      const items = data?.items || data?.data || data || [];
      setProducts(Array.isArray(items) ? items : []);
      setTotal(data?.total || items.length || 0);
      setSelectedIds(new Set());
      setSelectAll(false);
    } catch (err) {
      setError(err.message || "Failed to load products");
      setProducts([]);
      setTotal(0);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter, typeFilter, categoryFilter, currencyFilter, sortField, sortDir]);

  useEffect(() => { fetchProducts(true); }, [fetchProducts]);
  useEffect(() => { fetchCategories(); }, []);
  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages);
  }, [totalPages, currentPage]);

  const fetchCategories = useCallback(async () => {
    try {
      const data = await productApi.listCategories({ root_only: true });
      const items = data?.items || data?.data || data || [];
      setCategories(Array.isArray(items) ? items : []);
    } catch {
      // silent
    }
  }, []);

  const handleRefresh = () => { setRefreshing(true); fetchProducts(); };

  const handleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
    setCurrentPage(1);
  };

  const handleSelectAll = (checked) => {
    if (checked) setSelectedIds(new Set(products.map((p) => p.id)));
    else setSelectedIds(new Set());
    setSelectAll(checked);
  };

  const handleSelectOne = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setSelectAll(next.size === products.length && products.length > 0);
      return next;
    });
  };

  const handleBulkAction = async (action) => {
    if (selectedIds.size === 0) return;
    setBulkActionLoading(true);
    try {
      const ids = Array.from(selectedIds);
      const statusByAction = { activate: "active", deactivate: "inactive", archive: "archived", restore: "restored" };
      const result = await productApi.bulkStatus(ids, statusByAction[action]);
      const failed = result?.failed || [];
      setSelectedIds(new Set());
      setSelectAll(false);
      fetchProducts();
      setSuccessMessage(`${ids.length} product(s) ${action}d successfully`);
      setTimeout(() => setSuccessMessage(null), 4000);
      if (failed.length > 0) setError(`${failed.length} selected product(s) could not be updated.`);
    } catch (err) {
      setError(err.message || "Bulk action failed");
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const ok = await confirm({ title: "Delete products", message: `Delete ${selectedIds.size} selected product(s)? This action cannot be undone.`, confirmLabel: "Delete" });
    if (!ok) return;
    setBulkActionLoading(true);
    try {
      const ids = Array.from(selectedIds);
      await productApi.bulkDelete(ids);
      setSelectedIds(new Set());
      setSelectAll(false);
      fetchProducts();
      setSuccessMessage(`${ids.length} product(s) deleted`);
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err) {
      setError(err.message || "Failed to delete products");
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleDeleteProduct = async (id, name) => {
    const ok = await confirm({ title: "Delete product", message: `Delete product "${name}"? This action cannot be undone.`, confirmLabel: "Delete" });
    if (!ok) return;
    try {
      await productApi.delete(id);
      fetchProducts();
      setSuccessMessage(`Product "${name}" deleted`);
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to delete product");
    }
  };

  const handleRestoreProduct = async (id) => {
    try {
      await productApi.restore(id);
      fetchProducts();
      setSuccessMessage("Product restored successfully");
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to restore product");
    }
  };

  const handleDuplicateProduct = async (id) => {
    if (duplicatingId) return;
    setDuplicatingId(id);
    try {
      await productApi.duplicate(id);
      setCurrentPage(1);
      fetchProducts();
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to duplicate product");
    } finally {
      setDuplicatingId(null);
    }
  };

  const handleExport = async (scope = "all", format = "csv") => {
    setExportLoading(true);
    setShowExportMenu(false);
    try {
      const ids = scope === "selected" ? Array.from(selectedIds) : null;
      const filters = scope === "filtered" ? {
        search_term: debouncedSearch || undefined,
        product_type: typeFilter || undefined,
        status: statusFilter || undefined,
        category_id: categoryFilter || undefined,
        currency: currencyFilter || undefined,
      } : null;
      await productApi.exportCatalog({ format, scope, ids, filters });
    } catch (err) {
      setError(err.message || "Export failed");
    } finally {
      setExportLoading(false);
    }
  };

  const handleCreate = async () => {
    setFormLoading(true);
    setFormError(null);

    const price = parseFloat(newProduct.default_price || 0);
    const discount = parseFloat(newProduct.default_discount || 0);
    if (price < 0) { setFormError("Default price cannot be negative."); setFormLoading(false); return; }
    if (discount < 0 || discount > 100) { setFormError("Default discount must be between 0 and 100."); setFormLoading(false); return; }

    try {
      await productApi.create({
        ...newProduct,
        category_id: newProduct.category_id ? parseInt(newProduct.category_id) : undefined,
        default_price: price,
        default_discount: discount,
        original_price: newProduct.original_price ? parseFloat(newProduct.original_price) : undefined,
        country: newProduct.country || undefined,
        gst_vat_group: newProduct.gst_vat_group || undefined,
        image_url: newProduct.image_url || undefined,
        brand: newProduct.brand || undefined,
        invoice_description: newProduct.invoice_description || undefined,
      });
      setShowCreateModal(false);
      setNewProduct({ name: "", code: "", default_price: "", description: "", product_type: "service", is_active: true, image_url: "", category_id: "", brand: "", billing_frequency: "one_time", default_discount: "", invoice_description: "", currency: baseCurrency, original_price: "", country: "", gst_vat_group: "" });
      setCurrentPage(1);
      fetchProducts();
    } catch (err) {
      setFormError(err.message || "Failed to create product");
    } finally {
      setFormLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!editProduct) return;
    setFormLoading(true);
    setFormError(null);

    const price = parseFloat(editProduct.default_price || 0);
    const discount = parseFloat(editProduct.default_discount || 0);
    if (price < 0) { setFormError("Default price cannot be negative."); setFormLoading(false); return; }
    if (discount < 0 || discount > 100) { setFormError("Default discount must be between 0 and 100."); setFormLoading(false); return; }

    try {
      await productApi.update(editProduct.id, {
        ...editProduct,
        category_id: editProduct.category_id ? parseInt(editProduct.category_id) : null,
        default_price: price,
        default_discount: discount,
        original_price: editProduct.original_price ? parseFloat(editProduct.original_price) : null,
        country: editProduct.country || null,
        gst_vat_group: editProduct.gst_vat_group || null,
        image_url: editProduct.image_url || null,
        brand: editProduct.brand || null,
        invoice_description: editProduct.invoice_description || null,
      });
      setShowEditModal(false);
      setEditProduct(null);
      fetchProducts();
    } catch (err) {
      setFormError(err.message || "Failed to update product");
    } finally {
      setFormLoading(false);
    }
  };

  const toggleColumn = (key) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const SortHeader = ({ field, label }) => (
    <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
      <div
        role="button"
        tabIndex={0}
        className="flex items-center gap-1 cursor-pointer select-none hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 rounded"
        onClick={() => handleSort(field)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSort(field); } }}
      >
        {label}
        <ArrowUpDown size={12} className={`${sortField === field ? "text-brand-600" : "text-slate-300"}`} />
      </div>
    </th>
  );

  const isSubscriptionType = (data) => data.product_type === "subscription";
  const isUsageType = (data) => data.product_type === "usage";
  const isPhysicalType = (data) => data.product_type === "good";
  const isServiceType = (data) => data.product_type === "service";

  const pricingModelFor = (data) => {
    const freq = data.billing_frequency || "";
    if (data.product_type === "usage" || freq === "usage_based") return { label: "Usage Based", cls: "bg-amber-100 text-amber-700" };
    if (freq === "one_time") return { label: "One-Time", cls: "bg-slate-100 text-slate-600" };
    if (["monthly", "quarterly", "yearly", "semi_annual"].includes(freq)) return { label: "Subscription", cls: "bg-emerald-100 text-emerald-700" };
    if (freq === "recurring") return { label: "Recurring", cls: "bg-violet-100 text-violet-700" };
    return { label: "One-Time", cls: "bg-slate-100 text-slate-600" };
  };

  const getFrequencyForType = (productType) => {
    const map = {
      good: "one_time",
      service: "one_time",
      subscription: "monthly",
      usage: "usage_based",
      retainer: "monthly",
    };
    return map[productType] || "one_time";
  };

  const handleTypeChange = (value, data, setData) => {
    const updates = { product_type: value, billing_frequency: getFrequencyForType(value) };
    if (value === "subscription") { updates.is_subscribable = true; updates.is_usage_billable = false; }
    else if (value === "usage") { updates.is_usage_billable = true; updates.is_subscribable = false; }
    else if (value === "good") { updates.is_subscribable = false; updates.is_usage_billable = false; }
    else if (value === "service") { updates.is_subscribable = false; updates.is_usage_billable = false; }
    setData((p) => ({ ...p, ...updates }));
  };

  const renderFormFields = (data, setData, showAdvanced, setShowAdvanced, includeImage = true) => (
    <div className="space-y-6">
      {/* ── Basic Information ── */}
      <div>
        <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Package size={14} className="text-brand-500" /> Basic Information
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Product Name *</label>
            <input type="text" value={data.name || ""}
              onChange={(e) => setData((p) => ({ ...p, name: e.target.value }))}
              className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">SKU / Code *</label>
            <input type="text" value={data.code || ""}
              onChange={(e) => setData((p) => ({ ...p, code: e.target.value }))}
              className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </div>
        </div>
        <div className="mt-4">
          <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
          <textarea value={data.description || ""} rows={3}
            onChange={(e) => setData((p) => ({ ...p, description: e.target.value }))}
            className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Category</label>
            <select value={data.category_id || ""}
              onChange={(e) => setData((p) => ({ ...p, category_id: e.target.value }))}
              className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
              <option value="">No Category</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Brand</label>
            <input type="text" value={data.brand || ""} placeholder="e.g. Zoiko, Partner X"
              onChange={(e) => setData((p) => ({ ...p, brand: e.target.value }))}
              className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </div>
        </div>
      </div>

      {/* ── Product Type & Status ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Product Type *</label>
          <select value={data.product_type || "service"}
            onChange={(e) => handleTypeChange(e.target.value, data, setData)}
            className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
            {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {isSubscriptionType(data) && (
            <p className="text-xs text-blue-600 mt-1 flex items-center gap-1">
              <CheckCircle size={12} /> Automatically subscribable
            </p>
          )}
          {isUsageType(data) && (
            <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
              <Clock size={12} /> Usage-based billing enabled
            </p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
          <select value={data.is_active ? "active" : "inactive"}
            onChange={(e) => setData((p) => ({ ...p, is_active: e.target.value === "active" }))}
            className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
      </div>

      {/* ── Billing Profile ── */}
      <div className="border-t border-slate-100 pt-5">
        <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <CreditCard size={14} className="text-brand-500" /> Billing Profile
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Default Price *</label>
            <input type="number" step="0.01" min="0" value={data.default_price || ""}
              onChange={(e) => setData((p) => ({ ...p, default_price: e.target.value }))}
              className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Preferred Currency</label>
            <select value={data.currency || baseCurrency}
              onChange={(e) => setData((p) => ({ ...p, currency: e.target.value }))}
              className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
              {getCurrencySelectOptions().map((c) => (
                <option key={c.value} value={c.value}>{c.value}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Billing Frequency</label>
            <select value={data.billing_frequency || "one_time"}
              onChange={(e) => setData((p) => ({ ...p, billing_frequency: e.target.value }))}
              className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
              {BILLING_FREQUENCY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Default Discount (%)</label>
            <input type="number" step="0.01" min="0" max="100" value={data.default_discount || ""}
              onChange={(e) => setData((p) => ({ ...p, default_discount: e.target.value }))}
              className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </div>
        </div>
        <div className="mt-4">
          <label className="block text-sm font-medium text-slate-700 mb-1">Invoice Description</label>
          <textarea value={data.invoice_description || ""} rows={2} placeholder="Default description shown on invoices when this product is selected"
            onChange={(e) => setData((p) => ({ ...p, invoice_description: e.target.value }))}
            className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </div>
      </div>

      {/* ── Advanced Fields (CEO UX: hidden by default) ── */}
      <div className="border-t border-slate-100 pt-4">
        <button type="button" onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-700 transition-colors">
          <ChevronDown size={14} className={`transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
          {showAdvanced ? "Hide Advanced Fields" : "Show Advanced Fields"}
        </button>
        {showAdvanced && (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Unit / Meter</label>
                <input type="text" value={data.unit_label || ""} placeholder="e.g. hours, licenses, seats"
                  onChange={(e) => setData((p) => ({ ...p, unit_label: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Original Price</label>
                <input type="number" step="0.01" min="0" value={data.original_price || ""} placeholder="List price before discount"
                  onChange={(e) => setData((p) => ({ ...p, original_price: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Cost Price</label>
                <input type="number" step="0.01" min="0" value={data.cost_price || ""}
                  onChange={(e) => setData((p) => ({ ...p, cost_price: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Country</label>
                <input type="text" value={data.country || ""} placeholder="e.g. US, IN, GB"
                  onChange={(e) => setData((p) => ({ ...p, country: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Tax Rate (%)</label>
                <input type="number" step="0.01" min="0" value={data.tax_percentage || ""}
                  onChange={(e) => setData((p) => ({ ...p, tax_percentage: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">GST / VAT Group</label>
                <input type="text" value={data.gst_vat_group || ""} placeholder="e.g. STANDARD, REDUCED, EXEMPT"
                  onChange={(e) => setData((p) => ({ ...p, gst_vat_group: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input type="checkbox" checked={data.tax_inclusive || false}
                  onChange={(e) => setData((p) => ({ ...p, tax_inclusive: e.target.checked }))}
                  className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                Tax Inclusive
              </label>
            </div>
            {isPhysicalType(data) && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-700">
                <strong>Inventory Tracking:</strong> This is a physical product. Manage stock levels from the Inventory module.
              </div>
            )}
            {isServiceType(data) && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-700">
                <strong>Service Product:</strong> No inventory tracking needed. Configure delivery from the Service Delivery module.
              </div>
            )}
            {isSubscriptionType(data) && (
              <div className="bg-brand-50 border border-brand-200 rounded-xl p-3 text-xs text-brand-700">
                <strong>Subscription Product:</strong> Configure recurring pricing plans from the Pricing Plans module.
              </div>
            )}
            {includeImage && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Image URL</label>
                <input type="text" value={data.image_url || ""} placeholder="https://example.com/image.jpg"
                  onChange={(e) => setData((p) => ({ ...p, image_url: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                {data.image_url && (
                  <div className="mt-2 flex items-center gap-2">
                    <img src={data.image_url} alt="Preview"
                      onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = IMAGE_FALLBACK_SRC; }}
                      className="h-10 w-10 rounded-lg object-cover border" />
                    <button onClick={() => setData((p) => ({ ...p, image_url: "" }))} className="text-xs text-red-600 hover:text-red-800">Remove</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const renderCreateModal = () => (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowCreateModal(false)}>
      <div className="bg-white rounded-3xl p-8 w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-slate-800">New Product</h2>
          <button onClick={() => setShowCreateModal(false)} aria-label="Close" className="p-1 hover:bg-slate-100 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"><X size={20} /></button>
        </div>
        {formError && (
          <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <AlertCircle size={16} />{formError}
          </div>
        )}
        {renderFormFields(newProduct, (updater) => { setNewProduct(updater(newProduct)); }, showAdvancedCreate, setShowAdvancedCreate)}
        <div className="flex justify-end gap-3 mt-8">
          <button onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
          <button onClick={handleCreate} disabled={formLoading || !newProduct.name}
            className="px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">
            {formLoading ? "Creating..." : "Create Product"}
          </button>
        </div>
      </div>
    </div>
  );

  const renderEditModal = () => {
    if (!editProduct) return null;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowEditModal(false)}>
        <div className="bg-white rounded-3xl p-8 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-bold text-slate-800">Edit Product</h2>
            <button onClick={() => setShowEditModal(false)} aria-label="Close" className="p-1 hover:bg-slate-100 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"><X size={20} /></button>
          </div>
          {formError && (
            <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
              <AlertCircle size={16} />{formError}
            </div>
          )}
          {renderFormFields(editProduct, setEditProduct, showAdvancedEdit, setShowAdvancedEdit)}
          <div className="flex justify-end gap-3 mt-8">
            <button onClick={() => setShowEditModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
            <button onClick={handleUpdate} disabled={formLoading}
              className="px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">
              {formLoading ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <HRPage title="Products" subtitle="Manage your products">
        <PageSkeleton rows={6} />
      </HRPage>
    );
  }

  if (error && products.length === 0) {
    return (
      <HRPage title="Products" subtitle="Manage your products">
        <ErrorState message={error} onRetry={handleRefresh} />
      </HRPage>
    );
  }

  return (
    <HRPage title="Products" subtitle="Manage your products">
      <nav className="mb-5 flex items-center gap-1.5 text-xs text-slate-400" aria-label="Breadcrumb">
        <span className="font-medium text-slate-500">Products</span>
        <span>/</span>
        <span className="font-semibold text-brand-700">Product List</span>
        <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">
          <Package size={11} /> {total} catalog items
        </span>
      </nav>
      {successMessage && <SuccessMessage message={successMessage} onDismiss={() => setSuccessMessage(null)} />}

      <div className="bg-white border border-slate-200 rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
        <div className="p-6 border-b border-slate-100">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-1">
              <div className="relative flex-1 max-w-md">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input ref={searchInputRef} type="text" placeholder="Search by name, code..." value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-9 pr-14 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                {search ? (
                  <button onClick={() => setSearch("")} aria-label="Clear search"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 rounded-lg">
                    <X size={16} />
                  </button>
                ) : (
                  <kbd className="absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded-md border border-slate-200 bg-slate-50 text-[10px] font-semibold text-slate-400 pointer-events-none">⌘K</kbd>
                )}
              </div>
              <button onClick={() => setShowFilters(!showFilters)} aria-label="Toggle filters" aria-expanded={showFilters}
                className={`p-2.5 rounded-xl border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}>
                <Filter size={18} />
              </button>
              <div className="relative">
                <button onClick={() => setShowColumnMenu(!showColumnMenu)} aria-label="Choose visible columns" aria-expanded={showColumnMenu}
                  className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
                  <Eye size={18} />
                </button>
                {showColumnMenu && (
                  <div className="absolute left-0 top-full mt-1 z-20 w-48 bg-white border border-slate-200 rounded-xl shadow-lg py-2">
                    <p className="px-3 py-1 text-xs font-semibold text-slate-400 uppercase tracking-wider">Columns</p>
                    {COLUMN_OPTIONS.map((col) => (
                      <label key={col.key} className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 cursor-pointer">
                        <input type="checkbox" checked={visibleColumns.has(col.key)}
                          onChange={() => toggleColumn(col.key)}
                          className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                        {col.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={handleRefresh} disabled={refreshing} aria-label="Refresh products"
                className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
                <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              {/* Enhanced Export Dropdown */}
              <div className="relative">
                <button
                  onClick={() => setShowExportMenu(!showExportMenu)}
                  disabled={exportLoading}
                  className="flex items-center gap-2 px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  {exportLoading ? <RefreshCw size={16} className="animate-spin" /> : <Download size={16} />}
                  Export
                  <ChevronDown size={14} />
                </button>
                {showExportMenu && (
                  <div className="absolute right-0 top-full mt-1 z-30 w-56 bg-white border border-slate-200 rounded-2xl shadow-xl py-2">
                    <p className="px-3 py-1 text-xs font-semibold text-slate-400 uppercase tracking-wider">Format</p>
                    <button onClick={() => handleExport("all", "csv")} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 text-left">
                      <Download size={14} className="text-slate-400" /> Export Entire Catalog (CSV)
                    </button>
                    <button onClick={() => handleExport("all", "xlsx")} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 text-left">
                      <Download size={14} className="text-slate-400" /> Export Entire Catalog (Excel)
                    </button>
                    {selectedIds.size > 0 && (
                      <>
                        <div className="my-1 border-t border-slate-100" />
                        <p className="px-3 py-1 text-xs font-semibold text-slate-400 uppercase tracking-wider">Selected Rows</p>
                        <button onClick={() => handleExport("selected", "csv")} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-brand-700 hover:bg-brand-50 text-left">
                          <CheckCircle size={14} className="text-brand-300" /> Export {selectedIds.size} Selected (CSV)
                        </button>
                        <button onClick={() => handleExport("selected", "xlsx")} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-brand-700 hover:bg-brand-50 text-left">
                          <CheckCircle size={14} className="text-brand-300" /> Export {selectedIds.size} Selected (Excel)
                        </button>
                      </>
                    )}
                    {(debouncedSearch || statusFilter || typeFilter || categoryFilter || currencyFilter) && (
                      <>
                        <div className="my-1 border-t border-slate-100" />
                        <p className="px-3 py-1 text-xs font-semibold text-slate-400 uppercase tracking-wider">Current Filter</p>
                        <button onClick={() => handleExport("filtered", "csv")} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-amber-700 hover:bg-amber-50 text-left">
                          <Filter size={14} className="text-amber-400" /> Export Filtered (CSV)
                        </button>
                        <button onClick={() => handleExport("filtered", "xlsx")} className="flex items-center gap-2 w-full px-3 py-2 text-sm text-amber-700 hover:bg-amber-50 text-left">
                          <Filter size={14} className="text-amber-400" /> Export Filtered (Excel)
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {/* Import button */}
              <button
                onClick={() => setShowImportModal(true)}
                className="flex items-center gap-2 px-4 py-2.5 border border-brand-200 bg-brand-50 text-brand-700 rounded-xl text-sm font-medium hover:bg-brand-100 transition-colors"
              >
                <Upload size={16} /> Import
              </button>
              <button onClick={() => { fetchCategories(); setShowCreateModal(true); }}
                className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg">
                <Plus size={18} /> Add Product
              </button>
            </div>
          </div>

          {showFilters && (
            <div className="flex flex-wrap items-center gap-3 mt-4 pt-4 border-t border-slate-100">
              <div className="relative">
                <select value={statusFilter}
                  onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">All Statuses</option>
                  {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
              <div className="relative">
                <select value={typeFilter}
                  onChange={(e) => { setTypeFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">All Types</option>
                  {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
              <div className="relative">
                <select value={categoryFilter}
                  onChange={(e) => { setCategoryFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">All Categories</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
              <div className="relative">
                <select value={currencyFilter}
                  onChange={(e) => { setCurrencyFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">All Currencies</option>
                  {getCurrencySelectOptions().map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
              <div className="relative">
                <select value={sortField}
                  onChange={(e) => setSortField(e.target.value)}
                  className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  {SORT_FIELDS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
              <button onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                className="flex items-center gap-1 px-3 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">
                <ArrowUpDown size={14} /> {sortDir === "asc" ? "A-Z" : "Z-A"}
              </button>
            </div>
          )}
        </div>

        {selectedIds.size > 0 && (
          <div className="flex items-center gap-3 px-6 py-3 bg-brand-50 border-b border-brand-100">
            <span className="text-sm font-medium text-brand-700">{selectedIds.size} selected</span>
            <div className="h-4 w-px bg-brand-200" />
            <button onClick={() => handleBulkAction("activate")} disabled={bulkActionLoading}
              className="flex items-center gap-1 px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 disabled:opacity-50">
              <CheckCircle size={14} /> Activate
            </button>
            <button onClick={() => handleBulkAction("deactivate")} disabled={bulkActionLoading}
              className="flex items-center gap-1 px-3 py-1.5 bg-slate-600 text-white rounded-lg text-xs font-medium hover:bg-slate-700 disabled:opacity-50">
              <Clock size={14} /> Deactivate
            </button>
            <button onClick={() => handleBulkAction("archive")} disabled={bulkActionLoading}
              className="flex items-center gap-1 px-3 py-1.5 bg-slate-600 text-white rounded-lg text-xs font-medium hover:bg-slate-700 disabled:opacity-50">
              <Archive size={14} /> Archive
            </button>
            {statusFilter === "archived" && (
              <button onClick={() => handleBulkAction("restore")} disabled={bulkActionLoading}
                className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-50">
                <RotateCcw size={14} /> Restore
              </button>
            )}
            <button onClick={handleBulkDelete} disabled={bulkActionLoading}
              className="flex items-center gap-1 px-3 py-1.5 bg-red-600 text-white rounded-lg text-xs font-medium hover:bg-red-700 disabled:opacity-50">
              <Trash2 size={14} /> Delete
            </button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th scope="col" className="px-4 py-3 w-10">
                  <input type="checkbox" checked={selectAll}
                    onChange={(e) => handleSelectAll(e.target.checked)}
                    aria-label="Select all products"
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                </th>
                {visibleColumns.has("image") && (
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider w-14">Image</th>
                )}
                {visibleColumns.has("name") && <SortHeader field="name" label="Product" />}
                {visibleColumns.has("code") && <SortHeader field="code" label="Code" />}
                {visibleColumns.has("default_price") && <SortHeader field="default_price" label="Price" />}
                {visibleColumns.has("product_type") && (
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Type</th>
                )}
                {visibleColumns.has("product_type") && (
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Pricing Model</th>
                )}
                {visibleColumns.has("status") && <SortHeader field="status" label="Status" />}
                {visibleColumns.has("created_at") && <SortHeader field="created_at" label="Created" />}
                <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {products.length === 0 ? (
                <tr>
                  <td colSpan={visibleColumns.size + 2 + (visibleColumns.has("product_type") ? 1 : 0)} className="px-4 py-0">
                    <div className="flex flex-col items-center justify-center py-20 gap-5">
                      <div className="relative">
                        <div className="w-24 h-24 rounded-3xl bg-gradient-to-br from-brand-100 to-brand-100 flex items-center justify-center shadow-inner">
                          <Package size={40} className="text-brand-300" />
                        </div>
                        <div className="absolute -top-2 -right-2 w-8 h-8 rounded-full bg-amber-400 flex items-center justify-center shadow">
                          <Sparkles size={14} className="text-white" />
                        </div>
                      </div>
                      <div className="text-center">
                        <h3 className="text-lg font-bold text-slate-800 mb-1">
                          {search || statusFilter || typeFilter || categoryFilter || currencyFilter ? "No products match your filters" : "No products or services yet"}
                        </h3>
                        <p className="text-sm text-slate-500 max-w-sm">
                          {search || statusFilter || typeFilter || categoryFilter || currencyFilter
                            ? "Try adjusting your search or filter criteria."
                            : "Add your first product or service to start creating invoices, quotations, and subscriptions."}
                        </p>
                      </div>
                      {!search && !statusFilter && !typeFilter && !categoryFilter && !currencyFilter && (
                        <div className="flex gap-3">
                          <button
                            onClick={() => { fetchCategories(); setShowCreateModal(true); }}
                            className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-semibold hover:shadow-lg hover:shadow-brand-200 transition-all"
                          >
                            <Plus size={16} /> Add Product / Service
                          </button>
                          <button
                            onClick={() => setShowImportModal(true)}
                            className="flex items-center gap-2 px-5 py-2.5 border-2 border-brand-200 text-brand-700 rounded-xl text-sm font-semibold hover:bg-brand-50 transition-colors"
                          >
                            <Upload size={16} /> Import Catalog
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ) : products.map((product) => (
                <tr key={product.id} tabIndex={0} role="row"
                  className={`hover:bg-slate-50 transition-colors cursor-pointer focus:outline-2 focus:outline-brand-400 focus:outline-offset-[-2px] ${selectedIds.has(product.id) ? "bg-brand-50/50" : ""}`}
                  onClick={() => navigate(`/billing/products/${product.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); navigate(`/billing/products/${product.id}`); }
                    if (e.key === "Escape") { e.preventDefault(); setSelectedIds(new Set()); setSelectAll(false); }
                  }}>
                  <td className="px-4 py-4" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedIds.has(product.id)}
                      onChange={() => handleSelectOne(product.id)}
                      aria-label={`Select ${product.name || "product"}`}
                      className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                  </td>
                  {visibleColumns.has("image") && (
                    <td className="px-4 py-4">
                      {product.image_url ? (
                        <img src={product.image_url} alt={product.name ? `${product.name} thumbnail` : "Product thumbnail"}
                          onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = IMAGE_FALLBACK_SRC; }}
                          className="h-10 w-10 rounded-lg object-cover border" />
                      ) : (
                        <div className="h-10 w-10 rounded-lg bg-slate-100 flex items-center justify-center">
                          <Image size={16} className="text-slate-400" />
                        </div>
                      )}
                    </td>
                  )}
                  {visibleColumns.has("name") && (
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-full bg-gradient-to-br from-blue-500 to-cyan-500 text-white flex items-center justify-center text-sm font-bold">
                          {(product.name || "?").charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-slate-800">{product.name || "Unnamed"}</p>
                          {product.description && <p className="text-xs text-slate-400 line-clamp-1">{product.description}</p>}
                        </div>
                      </div>
                    </td>
                  )}
                  {visibleColumns.has("code") && <td className="px-4 py-4 text-sm text-slate-600 font-mono whitespace-nowrap">{product.code || "—"}</td>}
                  {visibleColumns.has("default_price") && <td className="px-4 py-4 text-sm font-medium text-slate-800 whitespace-nowrap">{formatDisplayCurrency(product.default_price || 0, product.currency || baseCurrency)}</td>}
                  {visibleColumns.has("product_type") && (
                    <td className="px-4 py-4">
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700 capitalize">
                        {product.product_type ? product.product_type.replace("_", " ") : "—"}
                      </span>
                    </td>
                  )}
                  {visibleColumns.has("product_type") && (
                    <td className="px-4 py-4">
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium capitalize ${pricingModelFor(product).cls}`}>
                        {pricingModelFor(product).label}
                      </span>
                    </td>
                  )}
                  {visibleColumns.has("status") && <td className="px-4 py-4"><StatusBadge status={product.status} options={PRODUCT_STATUS_BADGE_OPTIONS} /></td>}
                  {visibleColumns.has("created_at") && <td className="px-4 py-4 text-sm text-slate-500">{formatDisplayDate(product.created_at)}</td>}
                  <td className="px-4 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                    {product.status === "archived" ? (
                      <button onClick={() => handleRestoreProduct(product.id)} aria-label={`Restore ${product.name || "product"}`}
                        className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-blue-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" title="Restore">
                        <RotateCcw size={16} />
                      </button>
                    ) : (
                      <>
                        <button onClick={() => { fetchCategories(); setEditProduct({ ...product }); setShowEditModal(true); }} aria-label={`Edit ${product.name || "product"}`}
                          className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-blue-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" title="Edit">
                          <Pencil size={16} />
                        </button>
                        <button onClick={() => handleDuplicateProduct(product.id)} disabled={duplicatingId === product.id} aria-label={`Duplicate ${product.name || "product"}`}
                          className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-brand-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-50 disabled:cursor-not-allowed" title="Duplicate">
                          {duplicatingId === product.id ? <Loader2 size={16} className="animate-spin" /> : <Copy size={16} />}
                        </button>
                        <button onClick={() => handleDeleteProduct(product.id, product.name)} aria-label={`Delete ${product.name || "product"}`}
                          className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-red-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500" title="Delete">
                          <Trash2 size={16} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
          {total} total product(s)
        </Pagination>
      </div>

      {showCreateModal && renderCreateModal()}
      {showEditModal && renderEditModal()}
      {showImportModal && (
        <ImportWizardModal
          onClose={() => setShowImportModal(false)}
          onImported={() => { setShowImportModal(false); setCurrentPage(1); fetchProducts(); }}
        />
      )}
      {showExportMenu && (
        <div className="fixed inset-0 z-20" onClick={() => setShowExportMenu(false)} />
      )}
      {showColumnMenu && (
        <div className="fixed inset-0 z-10" onClick={() => setShowColumnMenu(false)} />
      )}
      {ConfirmationDialog}
    </HRPage>
  );
}
