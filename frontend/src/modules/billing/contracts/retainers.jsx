import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  Wallet, Search, Filter, X, ChevronDown, RefreshCw, Download,
  Plus, AlertCircle, CheckCircle, Clock, Edit, Trash2,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { productApi, settingsApi } from "../../../service/billingService";
import { formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { Pagination } from "../../../components/billing-shared";

const ITEMS_PER_PAGE = 10;
const RETAINER_TYPE = "retainer";

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

const BILLING_PERIODS = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "semi_annual", label: "Semi-Annual" },
  { value: "annual", label: "Annual" },
  { value: "one_time", label: "One-Time" },
];

export default function RetainersPage() {
  const navigate = useNavigate();

  const [retainers, setRetainers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [selectedRetainer, setSelectedRetainer] = useState(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  const [form, setForm] = useState({
    name: "", sku: "", description: "", unit_price: "",
    billing_period: "monthly", currency: "", status: "active",
  });
  const [orgSettings, setOrgSettings] = useState({});

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setCurrentPage(1); }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);

  const fetchRetainers = useCallback(async () => {
    try {
      setError(null);
      if (!loading) setRefreshing(true);
      const data = await productApi.list({
        page: safePage, per_page: ITEMS_PER_PAGE,
        search_term: debouncedSearch || undefined,
        product_type: RETAINER_TYPE,
        status: statusFilter || undefined,
      });
      setRetainers(extractArray(data));
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.message || "Failed to load retainers");
      setRetainers([]); setTotal(0);
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [safePage, debouncedSearch, statusFilter, loading]);

  const fetchOrgSettings = useCallback(async () => {
    try { const data = await settingsApi.get(); setOrgSettings(data || {}); }
    catch { /* silent */ }
  }, []);

  useEffect(() => { fetchRetainers(); fetchOrgSettings(); }, [fetchRetainers, fetchOrgSettings]);
  useEffect(() => { if (currentPage > totalPages && totalPages > 0) setCurrentPage(totalPages); }, [totalPages, currentPage]);

  const handleRefresh = () => { setRefreshing(true); fetchRetainers(); };

  const openCreateModal = () => {
    setForm({ name: "", sku: "", description: "", unit_price: "", billing_period: "monthly", currency: orgSettings.default_currency || "", status: "active" });
    setFormError(null); setShowCreateModal(true);
  };

  const openEditModal = (r) => {
    setSelectedRetainer(r);
    setForm({
      name: r.name || "", sku: r.sku || "", description: r.description || "",
      unit_price: String(r.unit_price || r.price || ""), billing_period: r.billing_period || "monthly",
      currency: r.currency || orgSettings.default_currency || "", status: r.status || "active",
    });
    setFormError(null); setShowEditModal(true);
  };

  const openDeleteModal = (r) => { setSelectedRetainer(r); setShowDeleteModal(true); };

  const handleCreate = async () => {
    try {
      setSaving(true); setFormError(null);
      const generatedCode = form.sku || `RET-${Date.now().toString(36).toUpperCase()}`;
      await productApi.create({
        name: form.name,
        code: generatedCode,
        description: form.description || undefined,
        product_type: RETAINER_TYPE,
        default_price: Number(form.unit_price) || 0,
        currency: form.currency || undefined,
        billing_frequency: form.billing_period || "monthly",
        is_active: form.status === "active",
      });
      setShowCreateModal(false); fetchRetainers();
    } catch (err) {
      setFormError(err?.detail || err?.message || "Failed to create retainer");
    } finally { setSaving(false); }
  };

  const handleEdit = async () => {
    if (!selectedRetainer) return;
    try {
      setSaving(true); setFormError(null);
      await productApi.update(selectedRetainer.id, {
        name: form.name,
        code: form.sku || selectedRetainer.code || selectedRetainer.sku,
        description: form.description || undefined,
        default_price: Number(form.unit_price) || 0,
        billing_frequency: form.billing_period || "monthly",
        is_active: form.status === "active",
      });
      setShowEditModal(false); fetchRetainers();
    } catch (err) {
      setFormError(err?.detail || err?.message || "Failed to update retainer");
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!selectedRetainer) return;
    try {
      setSaving(true); setFormError(null);
      await productApi.delete(selectedRetainer.id);
      setShowDeleteModal(false); fetchRetainers();
    } catch (err) {
      setFormError(err?.detail || err?.message || "Failed to delete retainer");
    } finally { setSaving(false); }
  };

  const handleExportJSON = () => {
    const blob = new Blob([JSON.stringify(retainers, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "retainers.json"; a.click();
    URL.revokeObjectURL(url);
  };
  const activeRetainers = retainers.filter((r) => r.status === "active").length;

  const totalValue = retainers.reduce((s, r) => s + parseFloat(r.unit_price || r.price || 0), 0);

  const defaultCurrency = retainers.length > 0
    ? (retainers.find((r) => r.currency)?.currency || "")
    : "";

  if (loading) {
    return (
      <HRPage title="Retainers" subtitle="Manage retainer products">
        <div className="flex items-center justify-center py-20">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-slate-200 border-t-brand-600" />
        </div>
      </HRPage>
    );
  }

  if (error && retainers.length === 0) {
    return (
      <HRPage title="Retainers" subtitle="Manage retainer products">
        <div className="flex flex-col items-center justify-center py-20">
          <AlertCircle className="h-12 w-12 text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-slate-800 mb-2">Something went wrong</h3>
          <p className="text-slate-600 mb-6 text-center max-w-md">{error}</p>
          <button onClick={handleRefresh} className="inline-flex items-center gap-2 px-6 py-3 bg-brand-600 text-white rounded-xl font-medium hover:bg-brand-700"><RefreshCw size={18} /> Try Again</button>
        </div>
      </HRPage>
    );
  }

  return (
    <HRPage title="Retainers" subtitle="Manage retainer products">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Retainers</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{retainers.length}</p>
          <p className="text-xs text-gray-400 mt-1">{activeRetainers} active</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Value</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{formatDisplayCurrency(totalValue, defaultCurrency)}</p>
          <p className="text-xs text-gray-400 mt-1">Sum of unit prices</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Avg Price</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{retainers.length ? formatDisplayCurrency(totalValue / retainers.length, defaultCurrency) : "—"}</p>
          <p className="text-xs text-gray-400 mt-1">Per retainer product</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3 flex-1">
<div className="relative flex-1 max-w-md">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input type="text" placeholder="Search retainers..." value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search retainers"
                className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              {search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X size={16} /></button>}
            </div>
          <button onClick={() => setShowFilters(!showFilters)}
            className={`p-2.5 rounded-xl border transition-colors ${showFilters ? "bg-brand-50 border-brand-200 text-brand-600" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}><Filter size={18} /></button>
          <button onClick={handleRefresh} disabled={refreshing} aria-label="Refresh" className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleExportJSON} className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50" title="Export JSON"><Download size={18} /></button>
          <button onClick={openCreateModal} className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-xl hover:bg-brand-700 transition-colors">
            <Plus size={16} /> New Retainer
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}

      {showFilters && (
        <div className="flex flex-wrap items-center gap-3 mb-4 p-4 bg-slate-50 rounded-xl border border-slate-200">
          <div className="relative">
            <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setCurrentPage(1); }}
              className="appearance-none px-4 py-2 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
              <option value="">All Statuses</option>
              {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
<thead>
               <tr className="bg-slate-50 border-b border-slate-100">
                 <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Name</th>
                 <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">SKU</th>
                 <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Unit Price</th>
                 <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Billing Period</th>
                 <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                 <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
               </tr>
             </thead>
            <tbody className="divide-y divide-slate-50">
              {retainers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center">
                      <Wallet size={40} className="text-slate-300 mb-3" />
                      <p className="text-slate-500 font-medium">No retainer products found</p>
                      <p className="text-slate-400 text-sm mt-1">{search || statusFilter ? "Try adjusting your search or filters" : "Create your first retainer product"}</p>
                    </div>
                  </td>
                </tr>
              ) : retainers.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-4">
                    <p className="font-medium text-slate-800">{r.name}</p>
                    {r.description && <p className="text-xs text-slate-400 mt-0.5 truncate max-w-[200px]">{r.description}</p>}
                  </td>
                  <td className="px-4 py-4 text-slate-500">{r.sku || "—"}</td>
                  <td className="px-4 py-4 text-right font-medium text-slate-800">{formatDisplayCurrency(r.unit_price || r.price, r.currency)}</td>
                  <td className="px-4 py-4 capitalize text-slate-600">{r.billing_period?.replace(/_/g, " ") || "—"}</td>
                  <td className="px-4 py-4">
                    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${r.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-600"}`}>
                      {r.status === "active" ? <CheckCircle size={12} /> : <Clock size={12} />}
                      {r.status || "unknown"}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button onClick={() => openEditModal(r)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-blue-600 transition-colors" aria-label="Edit retainer"><Edit size={15} /></button>
                      <button onClick={() => openDeleteModal(r)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-red-600 transition-colors" aria-label="Delete retainer"><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pagination page={safePage} totalPages={totalPages} onPageChange={setCurrentPage}>
          {total} total retainer(s)
        </Pagination>
      </div>

      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowCreateModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-800">Create Retainer</h3>
              <button onClick={() => setShowCreateModal(false)} className="p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <div className="p-6 space-y-4">
              {formError && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2"><AlertCircle className="h-4 w-4 flex-shrink-0" /> {formError}</div>}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Name *</label>
                <input type="text" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Monthly Consulting Retainer"
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">SKU</label>
                  <input type="text" value={form.sku} onChange={(e) => setForm((p) => ({ ...p, sku: e.target.value }))}
                    placeholder="RET-001"
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Unit Price *</label>
                  <input type="number" min="0" step="0.01" value={form.unit_price} onChange={(e) => setForm((p) => ({ ...p, unit_price: e.target.value }))}
                    placeholder="0.00"
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Billing Period *</label>
                  <select value={form.billing_period} onChange={(e) => setForm((p) => ({ ...p, billing_period: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                    {BILLING_PERIODS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Status</label>
                  <select value={form.status} onChange={(e) => setForm((p) => ({ ...p, status: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
                <textarea value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                  rows={2} placeholder="Retainer description..."
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200">
              <button onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">Cancel</button>
              <button onClick={handleCreate} disabled={saving || !form.name || !form.unit_price}
                className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5">
                {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Plus size={16} />} Create
              </button>
            </div>
          </div>
        </div>
      )}

      {showEditModal && selectedRetainer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowEditModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-800">Edit {selectedRetainer.name}</h3>
              <button onClick={() => setShowEditModal(false)} className="p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600"><X size={18} /></button>
            </div>
            <div className="p-6 space-y-4">
              {formError && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2"><AlertCircle className="h-4 w-4 flex-shrink-0" /> {formError}</div>}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Name *</label>
                <input type="text" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">SKU</label>
                  <input type="text" value={form.sku} onChange={(e) => setForm((p) => ({ ...p, sku: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Unit Price *</label>
                  <input type="number" min="0" step="0.01" value={form.unit_price} onChange={(e) => setForm((p) => ({ ...p, unit_price: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Billing Period</label>
                  <select value={form.billing_period} onChange={(e) => setForm((p) => ({ ...p, billing_period: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                    {BILLING_PERIODS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Status</label>
                  <select value={form.status} onChange={(e) => setForm((p) => ({ ...p, status: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Description</label>
                <textarea value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                  rows={2}
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200">
              <button onClick={() => setShowEditModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">Cancel</button>
              <button onClick={handleEdit} disabled={saving || !form.name || !form.unit_price}
                className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5">
                {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <CheckCircle size={16} />} Save
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteModal && selectedRetainer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowDeleteModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-red-100 text-red-600 flex items-center justify-center mb-4"><AlertCircle size={24} /></div>
              <h3 className="text-lg font-semibold text-slate-800 mb-2">Delete Retainer</h3>
              <p className="text-sm text-slate-600">Are you sure you want to delete <strong>{selectedRetainer.name}</strong>? This action cannot be undone.</p>
              {formError && <div className="mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">{formError}</div>}
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200">
              <button onClick={() => setShowDeleteModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">Cancel</button>
              <button onClick={handleDelete} disabled={saving}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 flex items-center gap-1.5">
                {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Trash2 size={16} />} Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </HRPage>
  );
}
