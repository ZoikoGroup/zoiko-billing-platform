import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Tag, Search, Filter, X, ChevronDown, ArrowUpDown, RefreshCw, Download, Plus, AlertCircle, CheckCircle, Clock, Layers, Eye, Copy, Calendar } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { pricingApi, productApi, settingsApi } from "../../../service/billingService";
import { getCurrencySelectOptions } from "../../../utils/currency";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { Spinner, Pagination, ProductSelector } from "../../../components/billing-shared";

const ITEMS_PER_PAGE = 10;

const PRICING_MODEL_OPTIONS = [
  { value: "flat", label: "Flat Rate", desc: "Single fixed price per period" },
  { value: "per_unit", label: "Per Unit", desc: "Price per individual unit" },
  { value: "tiered", label: "Tiered", desc: "Different prices per quantity range" },
  { value: "volume", label: "Volume", desc: "All units at tier price when threshold met" },
  { value: "graduated", label: "Graduated", desc: "Each range segment priced separately" },
];

const BILLING_PERIOD_OPTIONS = [
  { value: "one_time", label: "One-Time" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "semi_annual", label: "Semi-Annual" },
  { value: "annual", label: "Annual" },
];

const CURRENCY_OPTIONS = getCurrencySelectOptions();

const SORT_FIELDS = [
  { key: "name", label: "Name" },
  { key: "price", label: "Price" },
  { key: "billing_frequency", label: "Frequency" },
  { key: "plan_type", label: "Model" },
  { key: "currency", label: "Currency" },
  { key: "status", label: "Status" },
  { key: "created_at", label: "Created" },
];

const MODEL_DYNAMIC_FIELDS = {
  flat: { showUnitPrice: true, showTiers: false, showMinMax: false, showFlatFee: false },
  per_unit: { showUnitPrice: true, showTiers: false, showMinMax: true, showFlatFee: false },
  tiered: { showUnitPrice: false, showTiers: true, showMinMax: false, showFlatFee: true },
  volume: { showUnitPrice: false, showTiers: true, showMinMax: false, showFlatFee: true },
  graduated: { showUnitPrice: false, showTiers: true, showMinMax: false, showFlatFee: true },
};

function StatusBadge({ status }) {
  const styles = {
    active: "bg-green-100 text-green-700",
    inactive: "bg-gray-100 text-gray-700",
    archived: "bg-slate-100 text-slate-600",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${styles[status] || "bg-gray-100 text-gray-700"}`}>
      {status === "active" ? <CheckCircle size={12} /> : <Clock size={12} />}
      {status || "unknown"}
    </span>
  );
}

function ModelBadge({ model }) {
  const colors = {
    flat: "bg-brand-100 text-brand-700",
    per_unit: "bg-blue-100 text-blue-700",
    tiered: "bg-amber-100 text-amber-700",
    volume: "bg-cyan-100 text-cyan-700",
    graduated: "bg-rose-100 text-rose-700",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium capitalize ${colors[model] || "bg-gray-100 text-gray-700"}`}>
      {model?.replace("_", " ") || "flat"}
    </span>
  );
}

export default function PricingPlansPage() {
  const navigate = useNavigate();

  const [plans, setPlans] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [productsById, setProductsById] = useState({});

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [periodFilter, setPeriodFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const [sortField, setSortField] = useState("name");
  const [sortDir, setSortDir] = useState("asc");
  const [currentPage, setCurrentPage] = useState(1);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectAll, setSelectAll] = useState(false);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editPlan, setEditPlan] = useState(null);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState(null);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewPlan, setPreviewPlan] = useState(null);

  const [formTiers, setFormTiers] = useState([]);
  const [newTier, setNewTier] = useState({ from: "", to: "", price: "", flat_fee: "" });

  const [selectedProduct, setSelectedProduct] = useState(null);
  const [productLoading, setProductLoading] = useState(false);
  const [orgCurrency, setOrgCurrency] = useState("");

  const getDefaultPlan = () => ({
    name: "", description: "", price: "", currency: orgCurrency,
    billing_period: "monthly", pricing_model: "flat",
    trial_days: "", setup_fee: "", product_id: "",
    effective_from: new Date().toISOString().slice(0, 10),
    effective_to: "", min_quantity: 1, max_quantity: "",
    status: "active", flat_fee: "", notes: "", priority: "",
  });

  const [newPlan, setNewPlan] = useState(getDefaultPlan());

  useEffect(() => {
    settingsApi.getConfig().then((res) => {
      const cfg = res?.data || res;
      if (cfg?.default_currency) setOrgCurrency(cfg.default_currency);
    }).catch((err) => console.error("[PricingPlans] Failed to load config:", err));
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setCurrentPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchPlans = useCallback(async () => {
    try {
      setError(null);
      if (!loading) setRefreshing(true);
      const params = {
        page: safePage, per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        status: statusFilter || undefined,
        pricing_model: modelFilter || undefined,
        billing_period: periodFilter || undefined,
        sort_by: sortField === "price" ? "unit_price" : sortField === "billing_frequency" ? "billing_period" : sortField === "plan_type" ? "pricing_model" : sortField,
        sort_order: sortDir,
      };
      const data = await pricingApi.list(params);
      const items = data.items || data.data || data || [];
      setPlans(Array.isArray(items) ? items : []);
      setTotal(data.total || items.length || 0);
      setSelectedIds(new Set());
      setSelectAll(false);
    } catch (err) {
      setError(err.message || "Failed to load pricing plans");
      setPlans([]); setTotal(0);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter, modelFilter, periodFilter, sortField, sortDir, loading]);

  useEffect(() => { fetchPlans(); }, [fetchPlans]);
  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages);
  }, [totalPages, currentPage]);

  useEffect(() => {
    productApi.list({ per_page: 200, status: "active" }).then((data) => {
      const items = extractArray(data);
      setProductsById(Object.fromEntries(items.map((p) => [String(p.id), p])));
    }).catch((err) => console.error("[PricingPlans] Failed to load products:", err));
  }, []);

  const handleRefresh = () => { setRefreshing(true); fetchPlans(); };

  const handleSort = (field) => {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
    setCurrentPage(1);
  };

  const handleSelectAll = (checked) => {
    if (checked) setSelectedIds(new Set(plans.map((p) => p.id)));
    else setSelectedIds(new Set());
    setSelectAll(checked);
  };

  const handleSelectOne = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      setSelectAll(next.size === plans.length && plans.length > 0);
      return next;
    });
  };

  const handleBulkAction = async (action) => {
    if (selectedIds.size === 0) return;
    setBulkActionLoading(true);
    try {
      const ids = Array.from(selectedIds);
      const results = await Promise.allSettled(
        ids.map((id) => {
          if (action === "activate") return pricingApi.activate(id);
          if (action === "deactivate") return pricingApi.deactivate(id);
          return Promise.resolve();
        })
      );
      setSelectedIds(new Set()); setSelectAll(false);
      fetchPlans();
    } catch (err) {
      setError(err.message || "Bulk action failed");
    } finally { setBulkActionLoading(false); }
  };

  const handleExport = async (format) => {
    try {
      const allData = await pricingApi.list({ per_page: 100 });
      const items = extractArray(allData);
      const filename = `pricing-plans-${new Date().toISOString().split("T")[0]}`;
      if (format === "json") {
        const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = `${filename}.json`; a.click();
        URL.revokeObjectURL(url);
      } else if (format === "csv") {
        const headers = ["Name", "Model", "Price", "Currency", "Period", "Trial Days", "Setup Fee", "Status", "Product", "Effective From", "Effective To", "Created"];
        const csv = [headers.join(","), ...items.map((r) =>
          [`"${(r.name || "").replace(/"/g, '""')}"`, r.pricing_model || r.plan_type || "", r.unit_price ?? r.price ?? "", r.currency || "", r.billing_period || r.billing_frequency || "", r.trial_days || "", r.setup_fee || "", (r.is_active ?? r.status === "active") ? "active" : "inactive", r.product_name || "", r.effective_from || "", r.effective_to || "", r.created_at || ""].join(",")
        )].join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = `${filename}.csv`; a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setError(err.message || "Export failed");
    }
  };

  const loadProductDefaults = async (productId) => {
    if (!productId) {
      setSelectedProduct(null);
      return;
    }
    setProductLoading(true);
    try {
      const prod = productsById[String(productId)];
      if (prod) {
        setSelectedProduct(prod);
      } else {
        const data = await productApi.get(Number(productId));
        setSelectedProduct(data);
      }
    } catch {
      setSelectedProduct(null);
    } finally {
      setProductLoading(false);
    }
  };

  const handleFormChange = (data) => {
    if (data.product_id !== (editPlan || newPlan).product_id) {
      loadProductDefaults(data.product_id);
    }
    editPlan ? setEditPlan(data) : setNewPlan(data);
  };

  const applyProductDefaults = (formData, product) => {
    if (!product) return formData;
    return {
      ...formData,
      price: formData.price || product.default_price || "",
      currency: formData.currency || product.currency || "USD",
      billing_period: formData.billing_period || product.billing_frequency || "monthly",
    };
  };

  const handleCreate = async () => {
    setFormLoading(true); setFormError(null);
    try {
      if (!newPlan.product_id) {
        setFormError("Select a product before creating a pricing plan.");
        return;
      }
      const enriched = applyProductDefaults(newPlan, selectedProduct);
      const payload = {
        ...enriched,
        unit_price: parseFloat(enriched.price) || 0,
        flat_fee: parseFloat(enriched.flat_fee) || 0,
        trial_days: parseInt(enriched.trial_days) || 0,
        setup_fee: parseFloat(enriched.setup_fee) || 0,
        min_quantity: parseInt(enriched.min_quantity) || 1,
        max_quantity: enriched.max_quantity ? parseInt(enriched.max_quantity) : null,
        effective_from: enriched.effective_from || new Date().toISOString().slice(0, 10),
        effective_to: enriched.effective_to || null,
        product_id: Number(enriched.product_id),
        billing_period: enriched.billing_period,
        pricing_model: enriched.pricing_model,
      };
      if (enriched.status) payload.status = enriched.status;

      const modelCfg = MODEL_DYNAMIC_FIELDS[enriched.pricing_model] || MODEL_DYNAMIC_FIELDS.flat;
      if (!modelCfg.showUnitPrice) {
        delete payload.unit_price;
      }

      await pricingApi.create(payload);

      if (formTiers.length > 0 && MODEL_DYNAMIC_FIELDS[enriched.pricing_model]?.showTiers) {
        const newPlanData = await pricingApi.list({ per_page: 1, sort_by: "created_at", sort_order: "desc" });
        const newPlanId = extractArray(newPlanData)[0]?.id;
        if (newPlanId) {
          for (const tier of formTiers) {
            await pricingApi.addTier(newPlanId, {
              from_quantity: parseInt(tier.from),
              to_quantity: tier.to ? parseInt(tier.to) : null,
              unit_price: parseFloat(tier.price) || 0,
              flat_fee: parseFloat(tier.flat_fee) || 0,
            });
          }
        }
      }

      setShowCreateModal(false);
      setNewPlan(getDefaultPlan());
      setFormTiers([]);
      setSelectedProduct(null);
      setCurrentPage(1);
      fetchPlans();
    } catch (err) { setFormError(err.message || "Failed to create plan"); }
    finally { setFormLoading(false); }
  };

  const handleUpdate = async () => {
    if (!editPlan) return;
    setFormLoading(true); setFormError(null);
    try {
      const enriched = applyProductDefaults(editPlan, selectedProduct);
      const payload = {
        ...enriched,
        unit_price: parseFloat(enriched.price) || 0,
        flat_fee: parseFloat(enriched.flat_fee) || 0,
        trial_days: parseInt(enriched.trial_days) || 0,
        setup_fee: parseFloat(enriched.setup_fee) || 0,
        min_quantity: parseInt(enriched.min_quantity) || 1,
        max_quantity: enriched.max_quantity ? parseInt(enriched.max_quantity) : null,
        effective_from: enriched.effective_from || new Date().toISOString().slice(0, 10),
        effective_to: enriched.effective_to || null,
      };
      if (enriched.status) payload.status = enriched.status;

      await pricingApi.update(editPlan.id, payload);
      setShowEditModal(false); setEditPlan(null);
      setSelectedProduct(null);
      setFormTiers([]);
      fetchPlans();
    } catch (err) { setFormError(err.message || "Failed to update plan"); }
    finally { setFormLoading(false); }
  };

  const handleDeactivate = async (id) => {
    try { await pricingApi.deactivate(id); fetchPlans(); }
    catch (err) { setError(err.message || "Failed to deactivate plan"); }
  };

  const handleActivate = async (id) => {
    try { await pricingApi.activate(id); fetchPlans(); }
    catch (err) { setError(err.message || "Failed to activate plan"); }
  };

  const handleDuplicate = async (plan) => {
    const defaultPlan = getDefaultPlan();
    setNewPlan({
      ...defaultPlan,
      name: `${plan.name} (Copy)`,
      description: plan.description || "",
      price: plan.price || "",
      currency: plan.currency || "USD",
      billing_period: plan.billing_period || plan.billing_frequency || "monthly",
      pricing_model: plan.pricing_model || plan.plan_type || "flat",
      trial_days: plan.trial_days || "",
      setup_fee: plan.setup_fee || "",
      product_id: plan.product_id || "",
      effective_from: new Date().toISOString().slice(0, 10),
      effective_to: "",
      min_quantity: plan.min_quantity || 1,
      max_quantity: plan.max_quantity || "",
      flat_fee: plan.flat_fee || "",
    });
    if (plan.product_id) loadProductDefaults(plan.product_id);
    setFormTiers([]);
    setShowCreateModal(true);
  };

  const handlePreview = async (plan) => {
    let tiers = [];
    if (MODEL_DYNAMIC_FIELDS[plan.plan_type || plan.pricing_model]?.showTiers) {
      try {
        const data = await pricingApi.listTiers(plan.id);
        tiers = extractArray(data);
      } catch (err) { console.error("[PricingPlans] Failed to load tiers:", err); }
    }
    setPreviewPlan({ ...plan, tiers });
    setShowPreviewModal(true);
  };

  const openCreateWithProduct = (productId) => {
    const defaultPlan = getDefaultPlan();
    setNewPlan({ ...defaultPlan, product_id: String(productId) });
    loadProductDefaults(productId);
    setFormTiers([]);
    setShowCreateModal(true);
  };

  const addFormTier = () => {
    if (!newTier.from || !newTier.price) return;
    setFormTiers([...formTiers, { ...newTier, id: Date.now() }]);
    setNewTier({ from: "", to: "", price: "", flat_fee: "" });
  };

  const removeFormTier = (id) => {
    setFormTiers(formTiers.filter((t) => t.id !== id));
  };

  const SortHeader = ({ field, label }) => (
    <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider cursor-pointer select-none hover:text-slate-700" onClick={() => handleSort(field)}>
      <div className="flex items-center gap-1">
        {label}
        <ArrowUpDown size={12} className={`${sortField === field ? "text-brand-600" : "text-slate-300"}`} />
      </div>
    </th>
  );

  const PricingIntelligenceCard = ({ productId, compact }) => {
    const pid = productId || (editPlan || newPlan)?.product_id;
    const prod = selectedProduct;
    if (!pid) return null;
    return (
      <div className={`${compact ? "bg-slate-50 rounded-lg p-3" : "bg-gradient-to-br from-brand-50 to-indigo-50 rounded-xl border border-brand-200 p-4"}`}>
        {productLoading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500"><Spinner /> Loading product...</div>
        ) : prod ? (
          <div className={compact ? "flex items-center gap-3" : "space-y-2"}>
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-full bg-gradient-to-br from-brand to-brand-hover text-white flex items-center justify-center text-xs font-bold">
                {(prod.name || "?").charAt(0).toUpperCase()}
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-800">{prod.name}</p>
                <p className="text-xs text-slate-500">{prod.category_id ? `Category: ${prod.category_id}` : ""} {prod.product_type ? `· ${prod.product_type}` : ""}</p>
              </div>
            </div>
            {!compact && (
              <div className="grid grid-cols-3 gap-3 pt-2 border-t border-brand-200">
                <div>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider">Default Price</p>
                  <p className="text-sm font-bold text-slate-900">{formatDisplayCurrency(prod.default_price, prod.currency)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider">Currency</p>
                  <p className="text-sm font-medium text-slate-700">{prod.currency || "USD"}</p>
                </div>
                <div>
                  <p className="text-[10px] text-slate-500 uppercase tracking-wider">Billing Default</p>
                  <p className="text-sm font-medium text-slate-700 capitalize">{prod.billing_frequency?.replace("_", " ") || "—"}</p>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  const PlanFormFields = ({ data, onChange, includeStatus, isEdit }) => {
    const modelCfg = MODEL_DYNAMIC_FIELDS[data.pricing_model] || MODEL_DYNAMIC_FIELDS.flat;

    return (
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Plan Name *</label>
            <input type="text" value={data.name || ""} onChange={(e) => onChange({ ...data, name: e.target.value })}
              className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" placeholder="e.g. Standard Monthly" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Associated Product *</label>
            {!data.product_id && (
              <ProductSelector
                compact
                showFavorites={false}
                showRecent={false}
                fetchProducts={(params) => productApi.list(params)}
                fetchCategories={(params) => productApi.listCategories(params)}
                onSelect={(product) => { onChange({ ...data, product_id: String(product.id) }); loadProductDefaults(product.id); }}
                placeholder="Search products by name, SKU, or category..."
              />
            )}
          </div>
        </div>

        {data.product_id && (
          <div className="space-y-2">
            <PricingIntelligenceCard productId={data.product_id} />
            <button type="button" onClick={() => onChange({ ...data, product_id: "" })} className="text-xs text-brand-600 hover:text-brand-700 font-medium">
              Change product
            </button>
          </div>
        )}

        <div className="border-t border-slate-100 pt-4">
          <label className="block text-sm font-medium text-slate-700 mb-1">Pricing Model</label>
          <div className="grid grid-cols-5 gap-2">
            {PRICING_MODEL_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" onClick={() => onChange({ ...data, pricing_model: opt.value })}
                className={`px-3 py-2 border rounded-xl text-xs font-medium text-center transition-colors ${
                  data.pricing_model === opt.value
                    ? "bg-brand-600 text-white border-brand-600 shadow-sm"
                    : "bg-white text-slate-600 border-slate-200 hover:border-brand-200 hover:text-brand-600"
                }`}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Billing Period</label>
            <select value={data.billing_period || "monthly"} onChange={(e) => onChange({ ...data, billing_period: e.target.value })}
              className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
              {BILLING_PERIOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Currency</label>
            <select value={data.currency || "USD"} onChange={(e) => onChange({ ...data, currency: e.target.value })}
              className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
              {CURRENCY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {modelCfg.showUnitPrice && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Unit Price *</label>
              <input type="number" step="0.01" min="0" value={data.price || ""} onChange={(e) => onChange({ ...data, price: e.target.value })}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
          )}
          {modelCfg.showFlatFee && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Flat Fee</label>
              <input type="number" step="0.01" min="0" value={data.flat_fee || ""} onChange={(e) => onChange({ ...data, flat_fee: e.target.value })}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" placeholder="Optional base fee" />
            </div>
          )}
          {!modelCfg.showUnitPrice && !modelCfg.showFlatFee && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Setup Fee</label>
              <input type="number" step="0.01" min="0" value={data.setup_fee || ""} onChange={(e) => onChange({ ...data, setup_fee: e.target.value })}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{modelCfg.showUnitPrice || modelCfg.showFlatFee ? "Setup Fee" : "Trial Days"}</label>
            <input type="number" min="0" value={modelCfg.showUnitPrice || modelCfg.showFlatFee ? (data.setup_fee || "") : (data.trial_days || "")}
              onChange={(e) => onChange({ ...data, [modelCfg.showUnitPrice || modelCfg.showFlatFee ? "setup_fee" : "trial_days"]: e.target.value })}
              className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </div>
        </div>

        {modelCfg.showMinMax && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Min Quantity</label>
              <input type="number" min="1" value={data.min_quantity || 1} onChange={(e) => onChange({ ...data, min_quantity: e.target.value })}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Max Quantity</label>
              <input type="number" min="0" value={data.max_quantity || ""} onChange={(e) => onChange({ ...data, max_quantity: e.target.value })}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" placeholder="Unlimited" />
            </div>
          </div>
        )}

        {!modelCfg.showUnitPrice && !modelCfg.showFlatFee && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Setup Fee</label>
              <input type="number" step="0.01" min="0" value={data.setup_fee || ""} onChange={(e) => onChange({ ...data, setup_fee: e.target.value })}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Trial Days</label>
              <input type="number" min="0" value={data.trial_days || ""} onChange={(e) => onChange({ ...data, trial_days: e.target.value })}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
          </div>
        )}

        <div>
          <button type="button" onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700">
            <ChevronDown size={14} className={`transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
            Advanced Pricing Settings
          </button>
          {showAdvanced && (
            <div className="mt-3 space-y-4 p-4 bg-slate-50 rounded-xl">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Effective From *</label>
                  <input type="date" value={data.effective_from || ""} onChange={(e) => onChange({ ...data, effective_from: e.target.value })}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Effective To</label>
                  <input type="date" value={data.effective_to || ""} onChange={(e) => onChange({ ...data, effective_to: e.target.value })}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea rows={2} value={data.notes || ""} onChange={(e) => onChange({ ...data, notes: e.target.value })}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" placeholder="Internal notes about this pricing plan" />
              </div>
              {includeStatus && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
                    <select value={data.status || "active"} onChange={(e) => onChange({ ...data, status: e.target.value })}
                      className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {modelCfg.showTiers && (
          <div className="border-t border-slate-100 pt-4">
            <label className="block text-sm font-medium text-slate-700 mb-2">Pricing Tiers</label>
            <div className="flex items-center gap-2 mb-3">
              <input type="number" placeholder="From" value={newTier.from} onChange={(e) => setNewTier((p) => ({ ...p, from: e.target.value }))}
                className="w-20 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              <span className="text-slate-400">→</span>
              <input type="number" placeholder="To" value={newTier.to} onChange={(e) => setNewTier((p) => ({ ...p, to: e.target.value }))}
                className="w-20 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              <input type="number" step="0.01" placeholder="Price" value={newTier.price} onChange={(e) => setNewTier((p) => ({ ...p, price: e.target.value }))}
                className="w-24 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              <input type="number" step="0.01" placeholder="Flat fee" value={newTier.flat_fee} onChange={(e) => setNewTier((p) => ({ ...p, flat_fee: e.target.value }))}
                className="w-24 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              <button onClick={addFormTier} disabled={!newTier.from || !newTier.price}
                className="px-3 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50">Add</button>
            </div>
            {formTiers.length > 0 && (
              <div className="space-y-1.5 max-h-40 overflow-y-auto">
                {formTiers.map((tier) => (
                  <div key={tier.id} className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg text-sm">
                    <span className="text-slate-700">{tier.from} → {tier.to || "∞"} @ {formatDisplayCurrency(tier.price)}{tier.flat_fee ? ` + ${formatDisplayCurrency(tier.flat_fee)} flat` : ""}</span>
                    <button onClick={() => removeFormTier(tier.id)} className="text-slate-400 hover:text-red-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 rounded" aria-label="Remove tier"><X size={14} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderModal = (isEdit) => {
    const show = isEdit ? showEditModal : showCreateModal;
    const setShow = isEdit ? setShowEditModal : setShowCreateModal;
    const data = isEdit ? editPlan : newPlan;
    const setData = isEdit ? setEditPlan : setNewPlan;
    const onSubmit = isEdit ? handleUpdate : handleCreate;
    const title = isEdit ? "Edit Pricing Plan" : "New Pricing Plan";
    const btnLabel = isEdit ? (formLoading ? "Saving..." : "Save Changes") : (formLoading ? "Creating..." : "Create Plan");
    if (!show) return null;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setShow(false); setShowAdvanced(false); setFormTiers([]); }}>
        <div className="bg-white rounded-3xl p-8 w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-6">
            <div>
              <h2 className="text-xl font-bold text-slate-800">{title}</h2>
              <p className="text-xs text-slate-400 mt-0.5">{isEdit ? "Update pricing plan parameters" : "Define how this product is priced and billed"}</p>
            </div>
            <button onClick={() => { setShow(false); setShowAdvanced(false); setFormTiers([]); }} className="p-1 hover:bg-slate-100 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" aria-label="Close dialog"><X size={20} /></button>
          </div>
          {formError && (
            <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
              <AlertCircle size={16} />{formError}
            </div>
          )}
          <PlanFormFields data={data} onChange={setData} includeStatus={isEdit} isEdit={isEdit} />
          <div className="flex justify-end gap-3 mt-8 pt-4 border-t border-slate-100">
            <button onClick={() => { setShow(false); setShowAdvanced(false); setFormTiers([]); }} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
            <button onClick={onSubmit} disabled={formLoading || !data.name || !data.product_id}
              className="px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">
              {btnLabel}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const PreviewModal = () => {
    if (!showPreviewModal || !previewPlan) return null;
    const plan = previewPlan;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowPreviewModal(false)}>
        <div className="bg-white rounded-3xl p-8 w-full max-w-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-bold text-slate-800">Pricing Preview</h2>
            <button onClick={() => setShowPreviewModal(false)} className="p-1 hover:bg-slate-100 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" aria-label="Close preview"><X size={20} /></button>
          </div>
          <div className="space-y-4">
            <div className="bg-gradient-to-br from-brand-50 to-indigo-50 rounded-xl p-6 text-center border border-brand-200">
              <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{plan.name}</p>
              <p className="text-3xl font-bold text-brand-700">{formatDisplayCurrency(plan.unit_price ?? plan.price ?? 0, plan.currency)}</p>
              <p className="text-sm text-slate-500 mt-1 capitalize">{(plan.billing_period || plan.billing_frequency)?.replace("_", " ")}</p>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-xs text-slate-500">Model</p>
                <p className="font-medium text-slate-800 capitalize">{(plan.pricing_model || plan.plan_type)?.replace("_", " ") || "Flat Rate"}</p>
              </div>
              <div className="bg-slate-50 rounded-lg p-3">
                <p className="text-xs text-slate-500">Status</p>
                <p className="font-medium text-slate-800">{(plan.is_active ?? plan.status === "active") ? "Active" : "Inactive"}</p>
              </div>
              {plan.setup_fee > 0 && (
                <div className="bg-slate-50 rounded-lg p-3">
                  <p className="text-xs text-slate-500">Setup Fee</p>
                  <p className="font-medium text-slate-800">{formatDisplayCurrency(plan.setup_fee, plan.currency)}</p>
                </div>
              )}
              {plan.trial_days > 0 && (
                <div className="bg-slate-50 rounded-lg p-3">
                  <p className="text-xs text-slate-500">Trial</p>
                  <p className="font-medium text-slate-800">{plan.trial_days} days</p>
                </div>
              )}
              {plan.effective_from && (
                <div className="bg-slate-50 rounded-lg p-3">
                  <p className="text-xs text-slate-500">Effective From</p>
                  <p className="font-medium text-slate-800">{formatDisplayDate(plan.effective_from)}</p>
                </div>
              )}
              {plan.effective_to && (
                <div className="bg-slate-50 rounded-lg p-3">
                  <p className="text-xs text-slate-500">Expires</p>
                  <p className="font-medium text-slate-800">{formatDisplayDate(plan.effective_to)}</p>
                </div>
              )}
            </div>
            {plan.tiers && plan.tiers.length > 0 && (
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Tiers</p>
                <div className="space-y-1.5">
                  {plan.tiers.map((tier, i) => (
                    <div key={tier.id || i} className="flex justify-between px-3 py-2 bg-slate-50 rounded-lg text-sm">
                      <span className="text-slate-600">{tier.from_quantity} → {tier.to_quantity ?? "∞"} units</span>
                      <span className="font-medium text-slate-800">{formatDisplayCurrency(tier.unit_price || 0, plan.currency)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {plan.notes && (
              <div className="pt-2 border-t border-slate-100">
                <p className="text-xs text-slate-500">Notes</p>
                <p className="text-sm text-slate-700 mt-0.5">{plan.notes}</p>
              </div>
            )}
          </div>
          <div className="flex justify-end mt-6">
            <button onClick={() => setShowPreviewModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Close</button>
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <HRPage title="Pricing Plans" subtitle="Enterprise Commercial Pricing Engine">
        <div className="flex flex-col items-center justify-center py-20">
          <div className="relative">
            <div className="h-16 w-16 rounded-full border-4 border-slate-200 border-t-brand-600 animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center"><RefreshCw size={24} className="text-brand-600" /></div>
          </div>
          <p className="mt-4 text-slate-600 font-medium">Loading pricing plans...</p>
        </div>
      </HRPage>
    );
  }

  if (error && plans.length === 0) {
    return (
      <HRPage title="Pricing Plans" subtitle="Enterprise Commercial Pricing Engine">
        <div className="flex flex-col items-center justify-center py-20">
          <div className="h-16 w-16 rounded-full bg-red-100 text-red-600 flex items-center justify-center mb-4"><AlertCircle size={32} /></div>
          <h3 className="text-xl font-bold text-slate-800 mb-2">Something went wrong</h3>
          <p className="text-slate-600 mb-6 text-center max-w-md">{error}</p>
          <button onClick={handleRefresh} className="px-6 py-3 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl font-medium hover:shadow-lg flex items-center gap-2">
            <RefreshCw size={18} /> Try Again
          </button>
        </div>
      </HRPage>
    );
  }

  return (
    <HRPage title="Pricing Plans" subtitle="Enterprise Commercial Pricing Engine">

      <div className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-100">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3 flex-1">
              <div className="relative flex-1 max-w-md">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input type="text" placeholder="Search plans by name..." value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                {search && (
                  <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 rounded" aria-label="Clear search">
                    <X size={16} />
                  </button>
                )}
              </div>
              <button onClick={() => setShowFilters(!showFilters)}
                className={`p-2.5 rounded-xl border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
                aria-label="Toggle filters" aria-pressed={showFilters}>
                <Filter size={18} />
              </button>
              <button onClick={handleRefresh} disabled={refreshing} className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" aria-label="Refresh pricing plans">
                <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
              </button>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <button onClick={() => handleExport("csv")} className="flex items-center gap-2 px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50">
                  <Download size={16} /> Export
                </button>
              </div>
              <button onClick={() => { setNewPlan(getDefaultPlan()); setSelectedProduct(null); setFormTiers([]); setShowCreateModal(true); }}
                className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg">
                <Plus size={18} /> Add Plan
              </button>
            </div>
          </div>

          {showFilters && (
            <div className="flex flex-wrap items-center gap-3 mt-4 pt-4 border-t border-slate-100">
              <div className="relative">
                <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">All Statuses</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
              <div className="relative">
                <select value={modelFilter} onChange={(e) => { setModelFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">All Models</option>
                  {PRICING_MODEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
              <div className="relative">
                <select value={periodFilter} onChange={(e) => { setPeriodFilter(e.target.value); setCurrentPage(1); }}
                  className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">All Periods</option>
                  {BILLING_PERIOD_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              </div>
              <div className="relative">
                <select value={sortField} onChange={(e) => setSortField(e.target.value)}
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
              className="flex items-center gap-1 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-50">
              <CheckCircle size={14} /> Activate
            </button>
            <button onClick={() => handleBulkAction("deactivate")} disabled={bulkActionLoading}
              className="flex items-center gap-1 px-3 py-1.5 bg-slate-600 text-white rounded-lg text-xs font-medium hover:bg-slate-700 disabled:opacity-50">
              <Clock size={14} /> Deactivate
            </button>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="px-4 py-3 w-10">
                  <input type="checkbox" checked={selectAll} onChange={(e) => handleSelectAll(e.target.checked)}
                    className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                </th>
                <SortHeader field="name" label="Plan" />
                <SortHeader field="plan_type" label="Model" />
                <SortHeader field="price" label="Price" />
                <SortHeader field="billing_frequency" label="Period" />
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Product</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Effective</th>
                <SortHeader field="status" label="Status" />
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {plans.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center">
                      <Tag size={40} className="text-slate-300 mb-3" />
                      <p className="text-slate-500 font-medium">No pricing plans found</p>
                      <p className="text-slate-400 text-sm mt-1">{search || statusFilter || modelFilter ? "Try adjusting your search or filters" : "Add your first pricing plan to get started"}</p>
                    </div>
                  </td>
                </tr>
              ) : plans.map((plan) => {
                const isTieredModel = MODEL_DYNAMIC_FIELDS[plan.plan_type || plan.pricing_model]?.showTiers;
                return (
                  <tr key={plan.id} className={`hover:bg-slate-50 transition-colors ${selectedIds.has(plan.id) ? "bg-brand-50/50" : ""}`}>
                    <td className="px-4 py-4">
                      <input type="checkbox" checked={selectedIds.has(plan.id)} onChange={() => handleSelectOne(plan.id)}
                        className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-full bg-gradient-to-br from-brand to-brand-hover text-white flex items-center justify-center text-sm font-bold">
                          {(plan.name || "?").charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-slate-800">{plan.name || "Unnamed"}</p>
                          <p className="text-xs text-slate-400">{plan.trial_days ? `${plan.trial_days}d trial` : plan.setup_fee ? `${formatDisplayCurrency(plan.setup_fee)} setup` : "—"}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4"><ModelBadge model={plan.pricing_model || plan.plan_type} /></td>
                    <td className="px-4 py-4 font-medium text-slate-800">{formatDisplayCurrency(plan.unit_price ?? plan.price ?? 0, plan.currency)}</td>
                    <td className="px-4 py-4 text-slate-600 capitalize">{(plan.billing_period || plan.billing_frequency)?.replace(/_/g, " ") || "—"}</td>
                    <td className="px-4 py-4">
                      <button onClick={() => navigate(`/billing/products/${plan.product_id}`)} className="text-brand-600 hover:text-brand-700 text-xs font-medium hover:underline">
                        {plan.product_name || plan.product?.name || `Product #${plan.product_id}`}
                      </button>
                    </td>
                    <td className="px-4 py-4 text-xs text-slate-500">
                      {plan.effective_from ? (
                        <span className="flex items-center gap-1"><Calendar size={11} />{formatDisplayDate(plan.effective_from)}{plan.effective_to ? ` → ${formatDisplayDate(plan.effective_to)}` : " → ∞"}</span>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-4"><StatusBadge status={(plan.is_active ?? plan.status === "active") ? "active" : "inactive"} /></td>
                    <td className="px-4 py-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => handlePreview(plan)}
                          className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-brand-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" title="Preview Pricing" aria-label={`Preview pricing for ${plan.name || "plan"}`}>
                          <Eye size={16} />
                        </button>
                        <button onClick={() => handleDuplicate(plan)}
                          className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-emerald-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" title="Duplicate Plan" aria-label={`Duplicate ${plan.name || "plan"}`}>
                          <Copy size={16} />
                        </button>
                        {isTieredModel && (
                          <button onClick={() => navigate(`/billing/pricing/tier-management?plan_id=${plan.id}`)}
                            className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-amber-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" title="Manage Tiers" aria-label={`Manage tiers for ${plan.name || "plan"}`}>
                            <Layers size={16} />
                          </button>
                        )}
                        {(plan.is_active ?? plan.status === "active") ? (
                          <button onClick={() => handleDeactivate(plan.id)}
                            className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-red-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" title="Deactivate" aria-label={`Deactivate ${plan.name || "plan"}`}>
                            <Clock size={16} />
                          </button>
                        ) : (
                          <button onClick={() => handleActivate(plan.id)}
                            className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-emerald-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" title="Activate" aria-label={`Activate ${plan.name || "plan"}`}>
                            <CheckCircle size={16} />
                          </button>
                        )}
                        <button onClick={() => { setEditPlan({ ...plan }); if (plan.product_id) loadProductDefaults(plan.product_id); setShowEditModal(true); }}
                          className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-blue-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30" title="Edit" aria-label={`Edit ${plan.name || "plan"}`}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
          {total} total plan(s)
        </Pagination>
      </div>

      {renderModal(false)}
      {renderModal(true)}
      <PreviewModal />
    </HRPage>
  );
}
