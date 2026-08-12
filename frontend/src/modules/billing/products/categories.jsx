import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Search, RefreshCw, Plus, Folder, Package, FolderTree, ChevronRight, ChevronDown, Pencil, Trash2, X, AlertCircle, CheckCircle, Archive, Layers } from "lucide-react";
import { productApi } from "../../../service/billingService";
import { formatDisplayCurrency } from "../../../utils/billing-helpers";
import { Spinner, ErrorState, useConfirmationDialog } from "../../../components/billing-shared";

function CategoryRow({
  category,
  depth,
  selected,
  onToggleSelect,
  expanded,
  onToggleExpand,
  childrenMap,
  products,
  getProducts,
  productsLoading,
  forceExpand,
  onEdit,
  onDelete,
}) {
  const children = childrenMap[category.id] || [];
  const hasChildren = children.length > 0;
  const isExpanded = forceExpand || expanded.has(category.id);
  const count = category.product_count ?? category.products_count ?? 0;

  return (
    <div style={{ marginLeft: depth * 24 }}>
      <div className="group flex items-center gap-2.5 rounded-lg px-4 py-2.5 hover:bg-blue-50/60 transition-colors">
        <input
          type="checkbox"
          aria-label={`Select ${category.name}`}
          checked={selected.has(category.id)}
          onChange={() => onToggleSelect(category.id)}
          className="h-4 w-4 rounded border-slate-300 text-blue-700 focus:ring-blue-600 cursor-pointer"
        />
        <button
          onClick={() => onToggleExpand(category.id)}
          aria-label={isExpanded ? "Collapse" : "Expand"}
          className="p-1 -ml-1 text-slate-400 hover:text-slate-600"
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <Folder size={17} className="text-blue-700 shrink-0" />
        <span className="text-sm font-medium text-slate-900 flex-1 truncate">{category.name}</span>
        <span className="text-xs font-medium bg-blue-50 text-blue-900 px-2.5 py-1 rounded-full whitespace-nowrap">
          {count} {count === 1 ? "product" : "products"}
        </span>
        <button onClick={() => onEdit(category)} title="Edit" aria-label={`Edit ${category.name}`}
          className="p-1 text-slate-300 hover:text-blue-600 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
          <Pencil size={14} />
        </button>
        <button onClick={() => onDelete(category)} title="Delete" aria-label={`Delete ${category.name}`}
          className="p-1 text-slate-300 hover:text-red-600 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 rounded">
          <Trash2 size={14} />
        </button>
      </div>

      {isExpanded && (
        productsLoading.has(category.id) ? (
          <div className="flex items-center gap-2 pl-6 pr-4 py-2 text-xs text-slate-400"
            style={{ marginLeft: depth * 24 + 30 }}>
            <Spinner /> Loading products...
          </div>
        ) : products.length > 0 && (
          <div
            className="border-l-[1.5px] border-blue-200"
            style={{ marginLeft: depth * 24 + 30 }}
          >
            {products.map((product) => (
              <div key={product.id} className="flex items-center gap-2.5 pl-6 pr-4 py-2">
                <Package size={15} className="text-slate-400 shrink-0" />
                <span className="text-[13px] text-slate-600 flex-1 truncate">{product.name}</span>
                <span className="text-xs text-slate-400 font-mono whitespace-nowrap">{product.code}</span>
                <span className="text-[13px] font-medium text-slate-900 min-w-[64px] text-right">
                  {formatDisplayCurrency(product.default_price, product.currency)}
                </span>
              </div>
            ))}
          </div>
        )
      )}

      {hasChildren &&
        isExpanded &&
        children.map((child) => (
          <CategoryRow
            key={child.id}
            category={child}
            depth={depth + 1}
            selected={selected}
            onToggleSelect={onToggleSelect}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            childrenMap={childrenMap}
            products={getProducts(child.id)}
            getProducts={getProducts}
            productsLoading={productsLoading}
            forceExpand={forceExpand}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
    </div>
  );
}

export default function ProductCategoriesPage() {
  const { confirm, ConfirmationDialog } = useConfirmationDialog();
  const [categories, setCategories] = useState([]);
  const [childrenMap, setChildrenMap] = useState({});
  const [productsMap, setProductsMap] = useState({});
  const [productsLoading, setProductsLoading] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [expanded, setExpanded] = useState(new Set());

  const [showForm, setShowForm] = useState(false);
  const [editCategory, setEditCategory] = useState(null);
  const getDefaultFormData = () => ({ name: "", code: "", description: "", parent_id: "" });
  const [formData, setFormData] = useState(getDefaultFormData());
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState(null);

  const [bulkLoading, setBulkLoading] = useState(false);

  const fetchCategories = useCallback(async (isInitial = false) => {
    try {
      if (!isInitial) setError(null);
      if (!isInitial) setRefreshing(true);
      const data = await productApi.listCategories({ root_only: false });
      const items = Array.isArray(data) ? data : data?.items || data?.categories || data?.data || [];

      const rootItems = items.filter(c => !c.parent_id);
      setCategories(rootItems);

      const nextChildrenMap = {};
      for (const item of items) {
        if (item.parent_id) {
          if (!nextChildrenMap[item.parent_id]) nextChildrenMap[item.parent_id] = [];
          nextChildrenMap[item.parent_id].push(item);
        }
      }
      setChildrenMap(nextChildrenMap);
    } catch (err) {
      setError(err.message || "Failed to load categories");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchChildren = useCallback(async (parentId) => {
    try {
      const data = await productApi.listChildCategories(parentId);
      const items = Array.isArray(data) ? data : data?.items || data?.categories || data?.data || [];
      setChildrenMap((prev) => ({ ...prev, [parentId]: items }));
      return items;
    } catch {
      return [];
    }
  }, []);

  const fetchProductsForCategory = useCallback(async (catId) => {
    setProductsLoading((prev) => new Set(prev).add(catId));
    try {
      const data = await productApi.list({ category_id: catId, per_page: 200, is_active: false, page: 1 });
      const items = data?.items || data?.data || [];
      setProductsMap((prev) => ({ ...prev, [catId]: Array.isArray(items) ? items : [] }));
    } catch {
      setProductsMap((prev) => ({ ...prev, [catId]: [] }));
    } finally {
      setProductsLoading((prev) => { const next = new Set(prev); next.delete(catId); return next; });
    }
  }, []);

  useEffect(() => { fetchCategories(true); }, [fetchCategories]);

  const toggleExpand = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  useEffect(() => {
    for (const id of expanded) {
      if (!childrenMap[id]) fetchChildren(id);
      if (productsMap[id] === undefined) fetchProductsForCategory(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormLoading(true);
    setFormError(null);
    try {
      const payload = { name: formData.name, code: formData.code, description: formData.description };
      if (editCategory) payload.parent_id = formData.parent_id ? Number(formData.parent_id) : null;
      else if (formData.parent_id) payload.parent_id = Number(formData.parent_id);
      if (editCategory) {
        await productApi.updateCategory(editCategory.id, payload);
      } else {
        await productApi.createCategory(payload);
      }
      setShowForm(false);
      setEditCategory(null);
      setFormData(getDefaultFormData());
      fetchCategories();
    } catch (err) {
      setFormError(err.message || "Failed to save category");
    } finally {
      setFormLoading(false);
    }
  };

  const handleDelete = async (cat) => {
    const ok = await confirm({ title: "Delete category", message: `Delete category "${cat.name}"? This action cannot be undone.`, confirmLabel: "Delete" });
    if (!ok) return;
    try {
      await productApi.deleteCategory(cat.id);
      fetchCategories();
    } catch (err) {
      setError(err.message || "Failed to delete category");
    }
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    const ok = await confirm({ title: "Delete selected categories", message: `Delete ${selected.size} selected categor${selected.size === 1 ? "y" : "ies"}? This cannot be undone.`, confirmLabel: "Delete" });
    if (!ok) return;
    setBulkLoading(true);
    try {
      const results = await Promise.allSettled(
        Array.from(selected).map((id) => productApi.deleteCategory(id))
      );
      const failed = results.filter((r) => r.status === "rejected");
      setSelected(new Set());
      fetchCategories();
      if (failed.length > 0) {
        setError(`${failed.length} categor${failed.length === 1 ? "y" : "ies"} could not be deleted.`);
      }
    } catch (err) {
      setError(err.message || "Bulk delete failed");
    } finally {
      setBulkLoading(false);
    }
  };

  const handleEdit = (cat) => {
    setEditCategory(cat);
    setFormData({ name: cat.name || "", code: cat.code || "", description: cat.description || "", parent_id: cat.parent_id || "" });
    setShowForm(true);
  };

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const getDescendantIds = (id) => {
    const descendants = new Set();
    const walk = (parentId) => {
      for (const child of childrenMap[parentId] || []) {
        descendants.add(child.id);
        walk(child.id);
      }
    };
    walk(id);
    return descendants;
  };

  const q = query.trim().toLowerCase();
  const searchMode = !!q;
  const filteredCategories = useMemo(() => {
    if (!q) return categories;
    const all = [...categories, ...Object.values(childrenMap).flat()];
    return all.filter((c) => {
      const nameMatch = (c.name || "").toLowerCase().includes(q);
      const productMatch = (productsMap[c.id] || []).some((p) => (p.name || "").toLowerCase().includes(q));
      return nameMatch || productMatch;
    });
  }, [q, categories, childrenMap, productsMap]);

  const categoriesToRender = searchMode ? filteredCategories : categories;
  const productsFor = (catId) => productsMap[catId] || [];

  return (
    <div className="bg-white rounded-3xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
      {/* Header */}
      <div className="px-7 pt-6 pb-5 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-2xl bg-gradient-to-r from-[#FF7A00] to-[#FF5500] text-white flex items-center justify-center shadow-sm shrink-0">
            <Layers size={20} />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Product categories</h1>
            <p className="text-sm text-slate-500 mt-0.5">Organize products into categories</p>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3 px-7 py-4 bg-slate-50">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search categories..."
            aria-label="Search categories"
            className="w-full h-9 pl-9 pr-3 rounded-lg border border-slate-200 bg-white text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
              <X size={14} />
            </button>
          )}
        </div>
        <button
          onClick={() => { setRefreshing(true); fetchCategories(); }}
          aria-label="Refresh categories"
          className="h-9 w-9 flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          disabled={refreshing}
        >
          <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
        </button>
        <button
          onClick={() => { setShowForm(true); setEditCategory(null); setFormData(getDefaultFormData()); }}
          className="h-9 flex items-center gap-1.5 px-4 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-800 transition-colors whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        >
          <Plus size={16} />
          Add category
        </button>
      </div>

      {formError && (
        <div className="mx-7 my-4 flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          <AlertCircle size={16} /> {formError}
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="mx-7 my-4 p-6 bg-slate-50 rounded-2xl border border-slate-200">
          <h3 className="text-base font-semibold text-slate-900 mb-4">{editCategory ? "Edit category" : "New category"}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name *</label>
              <input required value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-600" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Code *</label>
              <input required value={formData.code} onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                className="w-full h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-600" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Parent category</label>
              <select value={formData.parent_id} onChange={(e) => setFormData({ ...formData, parent_id: e.target.value })}
                className="w-full h-9 px-3 rounded-lg border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-600">
                <option value="">None (root category)</option>
                {(function renderDropdownOptions(cats, depth = 0) {
                  return cats.map(c => {
                    if (editCategory && (c.id === editCategory.id || getDescendantIds(editCategory.id).has(c.id))) return null;
                    const children = childrenMap[c.id] || [];
                    return (
                      <React.Fragment key={c.id}>
                        <option value={c.id}>{"\u00A0\u00A0".repeat(depth)}{c.name}</option>
                        {children.length > 0 && renderDropdownOptions(children, depth + 1)}
                      </React.Fragment>
                    );
                  });
                })(categories)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
              <textarea value={formData.description} rows={1} onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-600" />
            </div>
          </div>
          <div className="flex gap-3 mt-5">
            <button type="submit" disabled={formLoading || !formData.name}
              className="h-9 flex items-center gap-1.5 px-4 rounded-lg bg-blue-700 text-white text-sm font-medium hover:bg-blue-800 transition-colors disabled:opacity-50">
              {formLoading ? "Saving..." : editCategory ? "Update category" : "Create category"}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditCategory(null); setFormError(null); setFormData(getDefaultFormData()); }}
              className="h-9 px-4 rounded-lg border border-slate-200 bg-white text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">Cancel</button>
          </div>
        </form>
      )}

      {selected.size > 0 && (
        <div className="mx-7 mb-4 flex items-center gap-3 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg">
          <CheckCircle size={16} className="text-blue-700" />
          <span className="text-sm font-medium text-blue-900">{selected.size} selected</span>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-xs text-blue-700 hover:text-blue-900">Clear</button>
          <button onClick={handleBulkDelete} disabled={bulkLoading}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-600 text-white text-xs font-medium hover:bg-red-700 disabled:opacity-50">
            <Archive size={13} /> Delete
          </button>
        </div>
      )}

      {/* Tree */}
      <div className="px-3 py-3 overflow-x-auto">
        {loading ? (
          <Spinner />
        ) : error && categories.length === 0 ? (
          <ErrorState message={error} onRetry={fetchCategories} />
        ) : categoriesToRender.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-center">
            <FolderTree size={40} className="text-slate-300 mb-3" />
            <p className="text-sm text-slate-500 font-medium">{searchMode ? "No categories match your search." : "No categories yet. Add one to get started."}</p>
          </div>
        ) : (
          categoriesToRender.map((category) => (
            <CategoryRow
              key={category.id}
              category={category}
              depth={0}
              selected={selected}
              onToggleSelect={toggleSelect}
              expanded={expanded}
              onToggleExpand={toggleExpand}
              childrenMap={childrenMap}
              products={productsFor(category.id)}
              getProducts={productsFor}
              productsLoading={productsLoading}
              forceExpand={searchMode}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))
        )}
        {!loading && categories.length > 0 && (
          <p className="px-4 pt-2 pb-1 text-xs text-slate-400">{categoriesToRender.length} categor{categoriesToRender.length === 1 ? "y" : "ies"}</p>
        )}
      </div>
      {ConfirmationDialog}
    </div>
  );
}
