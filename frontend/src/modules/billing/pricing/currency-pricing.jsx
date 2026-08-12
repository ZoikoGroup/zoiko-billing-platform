import { useState, useEffect, useCallback } from "react";
import {
  DollarSign, Search, Plus, RefreshCw, CheckCircle, Clock, X, Pencil,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { currencyPricingApi, productApi, settingsApi } from "../../../service/billingService";
import { formatDisplayCurrency } from "../../../utils/billing-helpers";
import { getCurrencySelectOptions } from "../../../utils/currency";
import { Spinner, EmptyState, ErrorState } from "../../../components/billing-shared";

const CURRENCY_OPTIONS = getCurrencySelectOptions();

const EMPTY_FORM = {
  product_id: "", currency: "", price: "", cost_price: "",
  conversion_type: "manual", exchange_rate: "", exchange_rate_date: "",
  is_active: true,
};

function CurrencyFormModal({ show, onClose, onSave, editItem, saving, productMap }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    settingsApi.getConfig().then((res) => {
      const cfg = res?.data || res;
      if (cfg?.default_currency) {
        setForm(f => f.currency ? f : { ...f, currency: cfg.default_currency });
      }
    }).catch((err) => console.error("[CurrencyPricing] Failed to load config:", err));
  }, [show]);

  useEffect(() => {
    if (editItem) {
      setForm({
        product_id: editItem.product_id ?? "", currency: editItem.currency || "USD",
        price: editItem.price ?? "", cost_price: editItem.cost_price ?? "",
        conversion_type: editItem.conversion_type || "manual",
        exchange_rate: editItem.exchange_rate ?? "", exchange_rate_date: editItem.exchange_rate_date || "",
        is_active: editItem.is_active ?? true,
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setFormError("");
  }, [editItem, show]);

  if (!show) return null;

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const handleSubmit = async () => {
    setFormError("");
    if (!form.product_id) return setFormError("Product ID is required");
    if (!form.currency) return setFormError("Currency is required");
    if (form.price === "" || Number(form.price) < 0) return setFormError("Price is required");

    const payload = {
      product_id: Number(form.product_id),
      currency: form.currency,
      price: Number(form.price),
      cost_price: form.cost_price !== "" ? Number(form.cost_price) : null,
      conversion_type: form.conversion_type,
      exchange_rate: form.exchange_rate !== "" ? Number(form.exchange_rate) : null,
      exchange_rate_date: form.exchange_rate_date || null,
      is_active: form.is_active,
    };

    await onSave(payload);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">{editItem ? "Edit Currency Pricing" : "Add Currency Pricing"}</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 hover:bg-gray-100 rounded-lg"><X size={20} /></button>
        </div>
        <div className="px-6 py-4 space-y-4">
          {formError && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">{formError}</div>}
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium text-gray-500 mb-1">Product *</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.product_id} onChange={e => set("product_id", e.target.value)}>
                <option value="">Select product...</option>
                {Object.entries(productMap).map(([id, name]) => (
                  <option key={id} value={id}>{name}</option>
                ))}
              </select>
            </div>
            <div><label className="block text-xs font-medium text-gray-500 mb-1">Currency *</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.currency} onChange={e => set("currency", e.target.value)}>
                {CURRENCY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium text-gray-500 mb-1">Price *</label><input type="number" step="0.01" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.price} onChange={e => set("price", e.target.value)} /></div>
            <div><label className="block text-xs font-medium text-gray-500 mb-1">Cost Price</label><input type="number" step="0.01" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.cost_price} onChange={e => set("cost_price", e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium text-gray-500 mb-1">Conversion Type</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.conversion_type} onChange={e => set("conversion_type", e.target.value)}>
                <option value="manual">Manual</option><option value="live">Live</option><option value="historical">Historical</option>
              </select>
            </div>
            <div><label className="block text-xs font-medium text-gray-500 mb-1">Exchange Rate</label><input type="number" step="0.0001" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.exchange_rate} onChange={e => set("exchange_rate", e.target.value)} /></div>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_active} onChange={e => set("is_active", e.target.checked)} className="rounded" /> Active</label>
          </div>
        </div>
        <div className="flex gap-2 justify-end px-6 py-4 border-t">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-gray-50">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700 disabled:opacity-50">{saving ? "Saving..." : editItem ? "Update" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

export default function CurrencyPricingPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ items: [], total: 0, page: 1, per_page: 20, pages: 0 });
  const [searchTerm, setSearchTerm] = useState("");
  const [currencyFilter, setCurrencyFilter] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [saving, setSaving] = useState(false);
  const [productMap, setProductMap] = useState({});

  useEffect(() => {
    productApi.list({ per_page: 100 }).then(res => {
      const items = res?.items || res || [];
      const map = {};
      items.forEach(p => { map[p.id] = p.name || p.sku || `Product ${p.id}`; });
      setProductMap(map);
    }).catch((err) => console.error("[CurrencyPricing] Failed to load product map:", err));
  }, []);

  const fetchData = useCallback(async (page = 1) => {
    setLoading(true); setError(null);
    try {
      const params = { page, per_page: 20 };
      if (searchTerm) params.search_term = searchTerm;
      if (currencyFilter) params.currency = currencyFilter;
      const res = await currencyPricingApi.list(params);
      setData(res);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [searchTerm, currencyFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSave = async (payload) => {
    setSaving(true);
    try {
      if (editItem) {
        await currencyPricingApi.update(editItem.id, payload);
      } else {
        await currencyPricingApi.create(payload);
      }
      setShowForm(false);
      setEditItem(null);
      fetchData();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const handleDeactivate = async (id) => {
    try {
      await currencyPricingApi.deactivate(id);
      fetchData();
    } catch (e) { setError(e.message); }
  };

  return (
    <HRPage title="Currency Pricing" icon={DollarSign}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <input className="pl-9 pr-3 py-2 border rounded-lg text-sm w-48" placeholder="Search..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
            </div>
            <select className="border rounded-lg px-3 py-2 text-sm" value={currencyFilter} onChange={e => setCurrencyFilter(e.target.value)}>
              <option value="">All Currencies</option>
              {CURRENCY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <button onClick={() => fetchData()} className="p-2 border rounded-lg hover:bg-gray-50"><RefreshCw size={16} /></button>
          </div>
          <button onClick={() => { setEditItem(null); setShowForm(true); }} className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700"><Plus size={16} /> Add Currency Price</button>
        </div>

        {error && <ErrorState message={error} onRetry={() => fetchData()} />}
        {loading ? <Spinner /> : !data.items?.length ? <EmptyState message="No currency pricing found" /> : (
          <div className="bg-white rounded-xl border overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr><th className="text-left px-4 py-3">Product</th><th className="text-left px-4 py-3">Currency</th><th className="text-right px-4 py-3">Price</th><th className="text-right px-4 py-3">Cost Price</th><th className="text-left px-4 py-3">Conversion</th><th className="text-right px-4 py-3">Rate</th><th className="text-center px-4 py-3">Active</th><th className="text-right px-4 py-3">Actions</th></tr>
              </thead>
              <tbody className="divide-y">
                {data.items.map(item => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm">
                      <div className="font-medium">{productMap[item.product_id] || `Product ${item.product_id}`}</div>
                      <div className="text-xs text-gray-400">ID: {item.product_id}</div>
                    </td>
                    <td className="px-4 py-3 text-sm font-medium">{item.currency}</td>
                    <td className="px-4 py-3 text-sm text-right">{formatDisplayCurrency(item.price, item.currency)}</td>
                    <td className="px-4 py-3 text-sm text-right">{item.cost_price ? formatDisplayCurrency(item.cost_price, item.currency) : "—"}</td>
                    <td className="px-4 py-3 text-sm capitalize">{item.conversion_type}</td>
                    <td className="px-4 py-3 text-sm text-right">{item.exchange_rate ?? "—"}</td>
                    <td className="px-4 py-3 text-center">{item.is_active ? <CheckCircle size={16} className="text-green-500 mx-auto" /> : <Clock size={16} className="text-gray-400 mx-auto" />}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => { setEditItem(item); setShowForm(true); }} className="text-blue-600 hover:text-blue-800 text-sm mr-3"><Pencil size={14} className="inline" /> Edit</button>
                      <button onClick={() => handleDeactivate(item.id)} className="text-red-500 hover:text-red-700 text-sm">Deactivate</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data.pages > 1 && (
          <div className="flex justify-center gap-2">
            {Array.from({ length: data.pages }, (_, i) => i + 1).map(p => (
              <button key={p} onClick={() => fetchData(p)} className={`px-3 py-1 rounded text-sm ${p === data.page ? "bg-brand-600 text-white" : "border hover:bg-gray-50"}`}>{p}</button>
            ))}
          </div>
        )}
      </div>

      <CurrencyFormModal show={showForm} onClose={() => { setShowForm(false); setEditItem(null); }} onSave={handleSave} editItem={editItem} saving={saving} productMap={productMap} />
    </HRPage>
  );
}
