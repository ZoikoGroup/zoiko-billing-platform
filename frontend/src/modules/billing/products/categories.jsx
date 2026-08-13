import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Folder, FolderOpen, Search, Plus, X, ChevronDown, ChevronRight, Package, AlertCircle, CheckCircle, Trash2, Pencil, Boxes } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { productApi } from "../../../service/billingService";
import { formatDisplayDate, extractArray } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { Spinner, ErrorState, EmptyState, useConfirmationDialog } from "../../../components/billing-shared";

function CategoryNode({ category, depth, selectedId, onSelect, onToggle, productCount, expandedMap, getCount }) {
  const isSelected = selectedId === category.id;
  const hasChildren = (category.children_count ?? category.children?.length ?? 0) > 0;
  const expanded = !!expandedMap[category.id];
  return (
    <div>
      <div
        onClick={() => onSelect(category)}
        className={`group flex w-full items-center gap-2 px-2 py-2 rounded-xl cursor-pointer transition-colors ${isSelected ? "bg-brand-600 text-white" : "hover:bg-brand-50 text-slate-700"}`}
        style={{ paddingLeft: `${8 + depth * 20}px` }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(category.id); }}
            aria-label={expanded ? "Collapse" : "Expand"}
            className={`shrink-0 rounded p-0.5 ${isSelected ? "text-white/80 hover:text-white" : "text-slate-400 hover:text-slate-600"}`}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : <span className="w-[18px] shrink-0" />}
        {expanded ? (
          <FolderOpen size={16} className={`shrink-0 ${isSelected ? "text-white/90" : "text-brand-500"}`} />
        ) : (
          <Folder size={16} className={`shrink-0 ${isSelected ? "text-white/90" : "text-brand-500"}`} />
        )}
        <span className="flex-1 truncate text-sm font-medium">{category.name}</span>
        {productCount > 0 && (
          <span className={`shrink-0 text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${isSelected ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"}`}>
            {productCount}
          </span>
        )}
      </div>
      {hasChildren && expanded && (
        <div className="mt-0.5">
          {(category.children || []).map((child) => (
            <CategoryNode key={child.id} category={child} depth={depth + 1} selectedId={selectedId}
              onSelect={onSelect} onToggle={onToggle} productCount={getCount(child)} expandedMap={expandedMap} getCount={getCount} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function CategoriesPage() {
  const { formatCurrency, baseCurrency } = useCurrency();
  const navigate = useNavigate();
  const { confirm, ConfirmationDialog } = useConfirmationDialog();
  const [categories, setCategories] = useState([]);
  const [selected, setSelected] = useState(null);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [expandedChildren, setExpandedChildren] = useState({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [successMessage, setSuccessMessage] = useState(null);

  const [showModal, setShowModal] = useState(false);
  const [editCategory, setEditCategory] = useState(null);
  const [form, setForm] = useState({ name: "", description: "", parent_id: "", is_active: true });
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState(null);

  const showSuccess = (msg) => {
    setSuccessMessage(msg);
    setTimeout(() => setSuccessMessage(null), 4000);
  };

  const fetchCategories = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await productApi.listCategories({ root_only: false });
      setCategories(extractArray(data));
    } catch (err) {
      setError(err.message || "Failed to load categories");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCategories(); }, [fetchCategories, refreshKey]);

  const fetchProducts = useCallback(async (category) => {
    if (!category) return;
    setLoadingProducts(true);
    try {
      const data = await productApi.list({ category_id: category.id, per_page: 200, page: 1 });
      setSelectedProducts(extractArray(data));
    } catch {
      setSelectedProducts([]);
    } finally {
      setLoadingProducts(false);
    }
  }, []);

  useEffect(() => {
    if (selected) fetchProducts(selected);
  }, [selected, fetchProducts]);

  const toggle = (id) => {
    setExpandedChildren((p) => ({ ...p, [id]: !p[id] }));
  };

  const productCountFor = (category) => {
    const direct = category.direct_count ?? category.products_count ?? 0;
    const children = category.children || [];
    const nested = children.reduce((s, c) => s + productCountFor(c), 0);
    return direct + nested;
  };

  const flatten = (list, depth = 0) =>
    list.flatMap((c) => [{ ...c, depth }, ...flatten(c.children || [], depth + 1)]);

  const filtered = useMemo(() => {
    const all = flatten(categories);
    return search ? all.filter((c) => c.name?.toLowerCase().includes(search.toLowerCase())) : all;
  }, [categories, search]);

  // When not searching, render only root categories and let CategoryNode's own
  // recursion draw the nested children based on expand/collapse state — mapping
  // over the fully-flattened `filtered` list here would render every descendant
  // twice (once as a flat row, again nested once its parent is expanded).
  const treeList = search ? filtered : categories;

  useEffect(() => {
    if (!selected && filtered.length > 0 && !search) setSelected(filtered[0]);
  }, [filtered, selected, search]);

  const activeCount = filtered.filter((c) => c.status === "active" || c.is_active !== false).length;
  const totalProducts = filtered.reduce((s, c) => s + productCountFor(c), 0);

  const openCreate = () => {
    setEditCategory(null);
    setForm({ name: "", description: "", parent_id: "", is_active: true });
    setFormError(null);
    setShowModal(true);
  };

  const openEdit = (category) => {
    setEditCategory(category);
    setForm({ name: category.name || "", description: category.description || "", parent_id: category.parent_id ? String(category.parent_id) : "", is_active: category.status === "active" || category.is_active !== false });
    setFormError(null);
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setFormError("Category name is required."); return; }
    setFormLoading(true);
    setFormError(null);
    try {
      const payload = {
        name: form.name,
        description: form.description || undefined,
        parent_id: form.parent_id ? parseInt(form.parent_id) : null,
        is_active: form.is_active,
      };
      if (editCategory) await productApi.updateCategory(editCategory.id, payload);
      else await productApi.createCategory(payload);
      setShowModal(false);
      setRefreshKey((k) => k + 1);
      showSuccess(editCategory ? "Category updated" : "Category created");
    } catch (err) {
      setFormError(err.message || "Failed to save category");
    } finally {
      setFormLoading(false);
    }
  };

  const handleDelete = async (category) => {
    const ok = await confirm({
      title: "Delete category",
      message: `Delete "${category.name}"? Products in it are not deleted, but will be uncategorized.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await productApi.deleteCategory(category.id);
      if (selected?.id === category.id) setSelected(null);
      setRefreshKey((k) => k + 1);
      showSuccess("Category deleted");
    } catch (err) {
      setError(err.message || "Failed to delete category");
    }
  };

  const totalChildren = (cat) => {
    const direct = cat.children?.length ?? 0;
    return direct + (cat.children || []).reduce((s, c) => s + totalChildren(c), 0);
  };

  if (loading) {
    return (
      <HRPage title="Categories" subtitle="Organize products into browsable categories">
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      </HRPage>
    );
  }

  if (error && categories.length === 0) {
    return (
      <HRPage title="Categories" subtitle="Organize products into browsable categories">
        <ErrorState message={error} onRetry={() => setRefreshKey((k) => k + 1)} />
      </HRPage>
    );
  }

  return (
    <HRPage
      title="Categories"
      subtitle="Organize products into browsable categories"
      actions={
        <button onClick={openCreate}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-semibold shadow-sm hover:shadow-lg hover:shadow-brand-200 transition-all">
          <Plus size={18} /> Add New Category
        </button>
      }
    >
      {successMessage && (
        <div className="mb-6 flex items-center justify-between p-3.5 rounded-xl bg-emerald-50 border border-emerald-200">
          <div className="flex items-center gap-2 text-sm text-emerald-800">
            <CheckCircle size={16} className="text-emerald-600" /> {successMessage}
          </div>
          <button onClick={() => setSuccessMessage(null)} aria-label="Dismiss" className="text-emerald-600 hover:text-emerald-800"><X size={16} /></button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
        {/* ── Left: Category Tree ── */}
        <div className="bg-white border border-slate-200 rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden flex flex-col lg:h-[calc(100vh-240px)]">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Boxes className="h-4 w-4 text-brand" />
              <h3 className="text-sm font-semibold text-slate-800">Categories</h3>
            </div>
            <span className="text-xs text-slate-400 font-medium">{activeCount} active · {totalProducts} products</span>
          </div>
          <div className="p-3 border-b border-slate-100">
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input type="text" placeholder="Search categories..." value={search} onChange={(e) => setSearch(e.target.value)}
                aria-label="Search categories"
                className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {treeList.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <Folder className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                <p className="text-sm text-slate-400">No categories found</p>
              </div>
            ) : (
              treeList.map((c) => (
                <CategoryNode key={c.id} category={c} depth={search ? c.depth : 0} selectedId={selected?.id}
                  onSelect={(cat) => { setSelected(cat); setSearch(""); }}
                  onToggle={toggle} productCount={productCountFor(c)} expandedMap={expandedChildren} getCount={productCountFor} />
              ))
            )}
          </div>
        </div>

        {/* ── Right: Details Pane ── */}
        <div className="bg-white border border-slate-200 rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden flex flex-col lg:h-[calc(100vh-240px)]">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center p-10">
              <div className="text-center">
                <FolderOpen className="h-10 w-10 text-slate-300 mx-auto mb-3" />
                <p className="text-sm font-medium text-slate-500">Select a category</p>
                <p className="text-xs text-slate-400 mt-1">Choose a category from the tree to see details and products.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="px-6 py-5 border-b border-slate-100">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <div className="h-11 w-11 rounded-2xl bg-gradient-to-br from-brand to-brand-hover flex items-center justify-center shrink-0 shadow-sm">
                        <Package className="h-5 w-5 text-white" />
                      </div>
                      <div>
                        <h2 className="text-lg font-bold text-slate-800 truncate">{selected.name}</h2>
                        <span className={`inline-flex items-center gap-1.5 mt-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${selected.status === "active" || selected.is_active !== false ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${selected.status === "active" || selected.is_active !== false ? "bg-emerald-500" : "bg-slate-400"}`} />
                          {selected.status === "active" || selected.is_active !== false ? "Active" : "Inactive"}
                        </span>
                      </div>
                    </div>
                    <p className="text-sm text-slate-500 mt-3 max-w-prose">{selected.description || "No description provided."}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => openEdit(selected)} aria-label="Edit category"
                      className="p-2 rounded-lg hover:bg-brand-50 text-slate-400 hover:text-brand-700 transition-colors" title="Edit category">
                      <Pencil size={16} />
                    </button>
                    <button onClick={() => handleDelete(selected)} aria-label="Delete category"
                      className="p-2 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 transition-colors" title="Delete category">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6">
                  {[
                    { label: "Direct products", value: selectedProducts.length },
                    { label: "Nested categories", value: totalChildren(selected) },
                    { label: "Total products", value: productCountFor(selected) },
                    { label: "Created", value: selected.created_at ? formatDisplayDate(selected.created_at) : "—" },
                  ].map((s) => (
                    <div key={s.label} className="p-3 rounded-xl bg-slate-50 border border-slate-100">
                      <p className="text-lg font-bold text-slate-800 truncate">{s.value}</p>
                      <p className="text-[11px] text-slate-400 font-medium uppercase tracking-wide">{s.label}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-800">Products in {selected.name}</h3>
                <button onClick={() => navigate("/billing/products")}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 rounded-lg transition-colors">
                  <Package size={13} /> Browse all products
                </button>
              </div>

              <div className="flex-1 overflow-y-auto">
                {loadingProducts ? (
                  <div className="flex items-center justify-center py-10"><Spinner /></div>
                ) : selectedProducts.length === 0 ? (
                  <div className="px-6 py-12">
                    <EmptyState icon={Package} title="No products in this category"
                      message="Products added to this category will appear here." />
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-slate-50/60 border-b border-slate-100">
                          <th className="px-6 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Product</th>
                          <th className="px-6 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Type</th>
                          <th className="px-6 py-2.5 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Price</th>
                          <th className="px-6 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {selectedProducts.map((p) => (
                          <tr key={p.id} className="hover:bg-slate-50/70 transition-colors cursor-pointer" onClick={() => navigate(`/billing/products/${p.id}`)}>
                            <td className="px-6 py-3">
                              <div className="flex items-center gap-3">
                                {p.image_url ? (
                                  <img src={p.image_url} alt="" className="h-8 w-8 rounded-lg object-cover" />
                                ) : (
                                  <div className="h-8 w-8 rounded-lg bg-slate-100 flex items-center justify-center">
                                    <Package className="h-3.5 w-3.5 text-slate-400" />
                                  </div>
                                )}
                                <div>
                                  <p className="font-medium text-slate-800">{p.name}</p>
                                  {p.code && <p className="text-xs text-slate-400 font-mono">{p.code}</p>}
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-3 text-slate-500 capitalize">{p.product_type || "—"}</td>
                            <td className="px-6 py-3 text-right font-semibold text-slate-800">{formatCurrency(p.default_price || 0, p.currency || baseCurrency)}</td>
                            <td className="px-6 py-3 text-center">
                              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${p.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                                <span className={`h-1.5 w-1.5 rounded-full ${p.status === "active" ? "bg-emerald-500" : "bg-slate-400"}`} />
                                {p.status || "inactive"}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Create / Edit Category Modal ── */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4" onClick={() => setShowModal(false)}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-slate-800">{editCategory ? "Edit Category" : "Add New Category"}</h2>
                <p className="text-sm text-slate-500 mt-0.5">{editCategory ? `Update "${editCategory.name}"` : "Create a category to organize products"}</p>
              </div>
              <button onClick={() => setShowModal(false)} aria-label="Close" className="p-1.5 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
            </div>
            {formError && (
              <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                <AlertCircle size={16} /> {formError}
              </div>
            )}
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Category Name *</label>
                <input type="text" value={form.name} placeholder="e.g. Networking"
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Parent Category</label>
                <select value={form.parent_id} onChange={(e) => setForm((p) => ({ ...p, parent_id: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">None (root category)</option>
                  {categories
                    .filter((c) => !editCategory || c.id !== editCategory.id)
                    .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea rows={3} value={form.description} placeholder="Optional description"
                  onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <label className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border border-slate-200 cursor-pointer">
                <div>
                  <p className="text-sm font-medium text-slate-700">Active</p>
                  <p className="text-xs text-slate-400 mt-0.5">Inactive categories are hidden from new product forms</p>
                </div>
                <input type="checkbox" checked={form.is_active} onChange={(e) => setForm((p) => ({ ...p, is_active: e.target.checked }))}
                  className="h-5 w-5 rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
              </label>
            </div>
            <div className="flex justify-end gap-3 mt-8">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
              <button onClick={handleSave} disabled={formLoading || !form.name.trim()}
                className="px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-semibold hover:shadow-lg disabled:opacity-50">
                {formLoading ? "Saving..." : editCategory ? "Save Changes" : "Create Category"}
              </button>
            </div>
          </div>
        </div>
      )}

      {ConfirmationDialog}
    </HRPage>
  );
}
