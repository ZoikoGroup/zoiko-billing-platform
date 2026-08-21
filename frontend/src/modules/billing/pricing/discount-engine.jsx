import { useState, useEffect, useCallback } from "react";
import {
  Percent, Search, Plus, RefreshCw, X, Pencil,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { discountApi, settingsApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency } from "../../../utils/billing-helpers";
import { getCurrencySelectOptions } from "../../../utils/currency";
import { Spinner, EmptyState, ErrorState } from "../../../components/billing-shared";

const DISCOUNT_TYPE_OPTIONS = [
  { value: "coupon", label: "Coupon" },
  { value: "promotion", label: "Promotion" },
  { value: "campaign", label: "Campaign" },
  { value: "seasonal", label: "Seasonal" },
  { value: "manual_override", label: "Manual Override" },
  { value: "automatic", label: "Automatic" },
  { value: "loyalty", label: "Loyalty" },
  { value: "referral", label: "Referral" },
  { value: "bulk", label: "Bulk" },
  { value: "early_bird", label: "Early Bird" },
];

const VALUE_TYPE_OPTIONS = [
  { value: "percentage", label: "Percentage" },
  { value: "fixed", label: "Fixed Amount" },
];

const CURRENCY_OPTIONS = getCurrencySelectOptions();

function StatusBadge({ status }) {
  const colors = { draft: "bg-slate-100 text-slate-600", active: "bg-green-100 text-green-700", paused: "bg-amber-100 text-amber-700", expired: "bg-red-100 text-red-600", exhausted: "bg-orange-100 text-orange-600", cancelled: "bg-slate-100 text-slate-500", pending_approval: "bg-blue-100 text-blue-600" };
  return <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${colors[status] || "bg-slate-100 text-slate-700"}`}>{status?.replace("_", " ") || "unknown"}</span>;
}

function nowIsoDatetime() {
  return new Date().toISOString().slice(0, 16);
}

const EMPTY_FORM = {
  name: "", code: "", description: "", discount_type: "coupon", discount_value: "",
  value_type: "percentage", min_order_amount: "", max_discount_amount: "",
  currency: "", usage_limit: "", per_customer_limit: 1,
  valid_from: nowIsoDatetime(), valid_to: "", status: "draft",
  is_active: true, requires_approval: false, auto_apply: false,
  stackable: false, applies_to_sale_items: true, applies_to_subscription: false,
  first_order_only: false,
};

function DiscountFormModal({ show, onClose, onSave, editItem, saving }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    settingsApi.getConfig().then((res) => {
      const cfg = res?.data || res;
      if (cfg?.default_currency) {
        setForm(f => f.currency ? f : { ...f, currency: cfg.default_currency });
      }
    }).catch((err) => console.error("[DiscountEngine] Failed to load config:", err));
  }, [show]);

  useEffect(() => {
    if (editItem) {
      const vf = editItem.valid_from ? new Date(editItem.valid_from).toISOString().slice(0, 16) : "";
      const vt = editItem.valid_to ? new Date(editItem.valid_to).toISOString().slice(0, 16) : "";
      setForm({
        name: editItem.name || "", code: editItem.code || "", description: editItem.description || "",
        discount_type: editItem.discount_type || "coupon", discount_value: editItem.discount_value ?? "",
        value_type: editItem.value_type || "percentage", min_order_amount: editItem.min_order_amount ?? "",
        max_discount_amount: editItem.max_discount_amount ?? "", currency: editItem.currency,
        usage_limit: editItem.usage_limit ?? "", per_customer_limit: editItem.per_customer_limit ?? 1,
        valid_from: vf, valid_to: vt, status: editItem.status || "draft",
        is_active: editItem.is_active ?? true, requires_approval: editItem.requires_approval ?? false,
        auto_apply: editItem.auto_apply ?? false, stackable: editItem.stackable ?? false,
        applies_to_sale_items: editItem.applies_to_sale_items ?? true,
        applies_to_subscription: editItem.applies_to_subscription ?? false,
        first_order_only: editItem.first_order_only ?? false,
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
    if (!form.name.trim()) return setFormError("Name is required");
    if (form.discount_value === "" || Number(form.discount_value) < 0) return setFormError("Discount value is required");
    if (!form.valid_from) return setFormError("Valid from date is required");

    const payload = {
      name: form.name.trim(),
      code: form.code ? form.code.trim().toUpperCase() : null,
      description: form.description || null,
      discount_type: form.discount_type,
      discount_value: Number(form.discount_value),
      value_type: form.value_type,
      min_order_amount: form.min_order_amount !== "" ? Number(form.min_order_amount) : null,
      max_discount_amount: form.max_discount_amount !== "" ? Number(form.max_discount_amount) : null,
      currency: form.currency,
      usage_limit: form.usage_limit !== "" ? Number(form.usage_limit) : null,
      per_customer_limit: Number(form.per_customer_limit) || 1,
      valid_from: new Date(form.valid_from).toISOString(),
      valid_to: form.valid_to ? new Date(form.valid_to).toISOString() : null,
      status: form.status,
      is_active: form.is_active,
      requires_approval: form.requires_approval,
      auto_apply: form.auto_apply,
      stackable: form.stackable,
      applies_to_sale_items: form.applies_to_sale_items,
      applies_to_subscription: form.applies_to_subscription,
      first_order_only: form.first_order_only,
    };

    await onSave(payload);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">{editItem ? "Edit Discount" : "Create Discount"}</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
        </div>
        <div className="px-6 py-4 space-y-4">
          {formError && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">{formError}</div>}
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Name *</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={form.name} onChange={e => set("name", e.target.value)} /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Code</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={form.code} onChange={e => set("code", e.target.value)} placeholder="e.g. SUMMER25" /></div>
          </div>
          <div><label className="block text-xs font-medium text-slate-500 mb-1">Description</label><textarea className="w-full border rounded-lg px-3 py-2 text-sm" rows={2} value={form.description} onChange={e => set("description", e.target.value)} /></div>
          <div className="grid grid-cols-3 gap-4">
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Discount Type *</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.discount_type} onChange={e => set("discount_type", e.target.value)}>
                {DISCOUNT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Value Type</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.value_type} onChange={e => set("value_type", e.target.value)}>
                {VALUE_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Value *</label><input type="number" step="0.01" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.discount_value} onChange={e => set("discount_value", e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Currency</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.currency} onChange={e => set("currency", e.target.value)}>
                {CURRENCY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Min Order Amount</label><input type="number" step="0.01" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.min_order_amount} onChange={e => set("min_order_amount", e.target.value)} /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Max Discount</label><input type="number" step="0.01" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.max_discount_amount} onChange={e => set("max_discount_amount", e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Valid From *</label><input type="datetime-local" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.valid_from} onChange={e => set("valid_from", e.target.value)} /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Valid To</label><input type="datetime-local" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.valid_to} onChange={e => set("valid_to", e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.status} onChange={e => set("status", e.target.value)}>
                <option value="draft">Draft</option><option value="active">Active</option><option value="paused">Paused</option>
              </select>
            </div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Usage Limit</label><input type="number" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.usage_limit} onChange={e => set("usage_limit", e.target.value)} placeholder="Unlimited" /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Per Customer Limit</label><input type="number" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.per_customer_limit} onChange={e => set("per_customer_limit", e.target.value)} /></div>
          </div>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_active} onChange={e => set("is_active", e.target.checked)} className="rounded" /> Active</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.auto_apply} onChange={e => set("auto_apply", e.target.checked)} className="rounded" /> Auto Apply</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.stackable} onChange={e => set("stackable", e.target.checked)} className="rounded" /> Stackable</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.first_order_only} onChange={e => set("first_order_only", e.target.checked)} className="rounded" /> First Order Only</label>
          </div>
        </div>
        <div className="flex gap-2 justify-end px-6 py-4 border-t">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-slate-50">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700 disabled:opacity-50">{saving ? "Saving..." : editItem ? "Update Discount" : "Create Discount"}</button>
        </div>
      </div>
    </div>
  );
}

function DetailModal({ show, onClose, item }) {
  if (!show || !item) return null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">Discount Details</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><span className="text-slate-500">Name:</span> <span className="font-medium ml-2">{item.name}</span></div>
            <div><span className="text-slate-500">Code:</span> <span className="font-medium ml-2">{item.code || "—"}</span></div>
            <div><span className="text-slate-500">Type:</span> <span className="ml-2 capitalize">{item.discount_type?.replace("_", " ")}</span></div>
            <div><span className="text-slate-500">Value:</span> <span className="ml-2">{item.value_type === "percentage" ? `${item.discount_value}%` : formatDisplayCurrency(item.discount_value)}</span></div>
            <div><span className="text-slate-500">Status:</span> <span className="ml-2"><StatusBadge status={item.status} /></span></div>
            <div><span className="text-slate-500">Currency:</span> <span className="ml-2">{item.currency}</span></div>
            <div><span className="text-slate-500">Valid:</span> <span className="ml-2">{formatDisplayDate(item.valid_from)}{item.valid_to ? ` — ${formatDisplayDate(item.valid_to)}` : ""}</span></div>
            <div><span className="text-slate-500">Usage:</span> <span className="ml-2">{item.usage_count ?? 0}{item.usage_limit ? ` / ${item.usage_limit}` : ""}</span></div>
            {item.min_order_amount && <div><span className="text-slate-500">Min Order:</span> <span className="ml-2">{formatDisplayCurrency(item.min_order_amount)}</span></div>}
            {item.max_discount_amount && <div><span className="text-slate-500">Max Discount:</span> <span className="ml-2">{formatDisplayCurrency(item.max_discount_amount)}</span></div>}
            <div><span className="text-slate-500">Stackable:</span> <span className="ml-2">{item.stackable ? "Yes" : "No"}</span></div>
            <div><span className="text-slate-500">Auto Apply:</span> <span className="ml-2">{item.auto_apply ? "Yes" : "No"}</span></div>
          </div>
          {item.description && <div className="text-sm"><span className="text-slate-500">Description:</span><p className="mt-1">{item.description}</p></div>}
        </div>
        <div className="flex justify-end px-6 py-4 border-t">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-slate-50">Close</button>
        </div>
      </div>
    </div>
  );
}

export default function DiscountEnginePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ items: [], total: 0, page: 1, per_page: 20, pages: 0 });
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [saving, setSaving] = useState(false);
  const [viewItem, setViewItem] = useState(null);

  const fetchData = useCallback(async (page = 1) => {
    setLoading(true); setError(null);
    try {
      const params = { page, per_page: 20 };
      if (searchTerm) params.search_term = searchTerm;
      if (typeFilter) params.discount_type = typeFilter;
      if (statusFilter) params.status = statusFilter;
      const res = await discountApi.list(params);
      setData(res);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [searchTerm, typeFilter, statusFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSave = async (payload) => {
    setSaving(true);
    try {
      if (editItem) {
        await discountApi.update(editItem.id, payload);
      } else {
        await discountApi.create(payload);
      }
      setShowForm(false);
      setEditItem(null);
      fetchData();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <HRPage title="Discount Engine" icon={Percent}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input className="pl-9 pr-3 py-2 border rounded-lg text-sm w-48" placeholder="Search discounts..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
            </div>
            <select className="border rounded-lg px-3 py-2 text-sm" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
              <option value="">All Types</option>
              {DISCOUNT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select className="border rounded-lg px-3 py-2 text-sm" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All Status</option>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
              <option value="paused">Paused</option>
              <option value="expired">Expired</option>
              <option value="exhausted">Exhausted</option>
            </select>
            <button onClick={() => fetchData()} className="p-2 border rounded-lg hover:bg-slate-50"><RefreshCw size={16} /></button>
          </div>
          <button onClick={() => { setEditItem(null); setShowForm(true); }} className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700"><Plus size={16} /> Create Discount</button>
        </div>

        {error && <ErrorState message={error} onRetry={() => fetchData()} />}
        {loading ? <Spinner /> : !data.items?.length ? <EmptyState message="No discounts found" /> : (
          <div className="bg-white rounded-3xl border overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr><th className="text-left px-4 py-3">Name / Code</th><th className="text-left px-4 py-3">Type</th><th className="text-left px-4 py-3">Value</th><th className="text-left px-4 py-3">Status</th><th className="text-left px-4 py-3">Valid Period</th><th className="text-center px-4 py-3">Used</th><th className="text-right px-4 py-3">Actions</th></tr>
              </thead>
              <tbody className="divide-y">
                {data.items.map(item => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3"><div className="font-medium text-sm">{item.name}</div>{item.code && <div className="text-xs text-slate-500">{item.code}</div>}</td>
                    <td className="px-4 py-3 text-sm capitalize">{item.discount_type?.replace("_", " ")}</td>
                    <td className="px-4 py-3 text-sm">{item.value_type === "percentage" ? `${item.discount_value}%` : formatDisplayCurrency(item.discount_value)}</td>
                    <td className="px-4 py-3"><StatusBadge status={item.status} /></td>
                    <td className="px-4 py-3 text-sm">{formatDisplayDate(item.valid_from)}{item.valid_to ? ` — ${formatDisplayDate(item.valid_to)}` : ""}</td>
                    <td className="px-4 py-3 text-center text-sm">{item.usage_count ?? 0}{item.usage_limit ? `/${item.usage_limit}` : ""}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setViewItem(item)} className="text-brand-600 hover:text-brand-700 text-sm mr-3">View</button>
                      <button onClick={() => { setEditItem(item); setShowForm(true); }} className="text-blue-600 hover:text-blue-800 text-sm mr-3"><Pencil size={14} className="inline" /> Edit</button>
                      <button onClick={async () => { try { await discountApi.deactivate(item.id); fetchData(); } catch (e) { setError(e.message); } }} className="text-red-500 hover:text-red-700 text-sm">Deactivate</button>
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
              <button key={p} onClick={() => fetchData(p)} className={`px-3 py-1 rounded text-sm ${p === data.page ? "bg-brand-600 text-white" : "border hover:bg-slate-50"}`}>{p}</button>
            ))}
          </div>
        )}
      </div>

      <DiscountFormModal show={showForm} onClose={() => { setShowForm(false); setEditItem(null); }} onSave={handleSave} editItem={editItem} saving={saving} />
      <DetailModal show={!!viewItem} onClose={() => setViewItem(null)} item={viewItem} />
    </HRPage>
  );
}
