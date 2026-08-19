import { useState, useEffect, useCallback } from "react";
import {
  ListFilter, Search, Plus, RefreshCw, X, Pencil,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { pricingRuleApi } from "../../../service/billingService";
import { formatDisplayDate } from "../../../utils/billing-helpers";
import { Spinner, EmptyState, ErrorState } from "../../../components/billing-shared";

const RULE_TYPE_OPTIONS = [
  { value: "percentage_discount", label: "Percentage Discount" },
  { value: "fixed_discount", label: "Fixed Discount" },
  { value: "tier_pricing", label: "Tier Pricing" },
  { value: "volume_pricing", label: "Volume Pricing" },
  { value: "quantity_break", label: "Quantity Break" },
  { value: "customer_pricing", label: "Customer Pricing" },
  { value: "regional_pricing", label: "Regional Pricing" },
  { value: "date_based_pricing", label: "Date Based" },
  { value: "buy_get", label: "Buy X Get Y" },
  { value: "bundle_pricing", label: "Bundle Pricing" },
  { value: "loyalty_pricing", label: "Loyalty" },
];

const SCOPE_OPTIONS = [
  { value: "global", label: "Global" },
  { value: "product", label: "Product" },
  { value: "product_category", label: "Category" },
  { value: "customer", label: "Customer" },
  { value: "customer_group", label: "Customer Group" },
  { value: "region", label: "Region" },
  { value: "organization", label: "Organization" },
];

const VALUE_TYPE_OPTIONS = [
  { value: "percentage", label: "Percentage" },
  { value: "fixed", label: "Fixed Amount" },
];

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function StatusBadge({ status }) {
  const colors = { draft: "bg-slate-100 text-slate-600", active: "bg-green-100 text-green-700", inactive: "bg-slate-100 text-slate-700", expired: "bg-red-100 text-red-600", scheduled: "bg-blue-100 text-blue-600" };
  return <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${colors[status] || "bg-slate-100 text-slate-700"}`}>{status || "unknown"}</span>;
}

const EMPTY_FORM = {
  name: "", code: "", description: "", rule_type: "percentage_discount", scope: "global",
  priority: 0, value: "", value_type: "percentage", min_quantity: "", max_quantity: "",
  effective_from: todayIsoDate(), effective_to: "", status: "draft", is_active: true,
  auto_apply: false, requires_approval: false, usage_limit: "", stackable: false,
  max_stack_count: 1, product_id: "", customer_id: "", region: "", country: "",
};

function RuleFormModal({ show, onClose, onSave, editRule, saving }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (editRule) {
      setForm({
        name: editRule.name || "", code: editRule.code || "", description: editRule.description || "",
        rule_type: editRule.rule_type || "percentage_discount", scope: editRule.scope || "global",
        priority: editRule.priority ?? 0, value: editRule.value ?? "", value_type: editRule.value_type || "percentage",
        min_quantity: editRule.min_quantity ?? "", max_quantity: editRule.max_quantity ?? "",
        effective_from: editRule.effective_from || todayIsoDate(),
        effective_to: editRule.effective_to || "", status: editRule.status || "draft",
        is_active: editRule.is_active ?? true, auto_apply: editRule.auto_apply ?? false,
        requires_approval: editRule.requires_approval ?? false, usage_limit: editRule.usage_limit ?? "",
        stackable: editRule.stackable ?? false, max_stack_count: editRule.max_stack_count ?? 1,
        product_id: editRule.product_id ?? "", customer_id: editRule.customer_id ?? "",
        region: editRule.region || "", country: editRule.country || "",
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setFormError("");
  }, [editRule, show]);

  if (!show) return null;

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  const handleSubmit = async () => {
    setFormError("");
    if (!form.name.trim()) return setFormError("Name is required");
    if (!form.code.trim()) return setFormError("Code is required");
    if (!form.effective_from) return setFormError("Effective from date is required");

    const payload = {
      name: form.name.trim(),
      code: form.code.trim().toUpperCase(),
      description: form.description || null,
      rule_type: form.rule_type,
      scope: form.scope,
      priority: Number(form.priority) || 0,
      value: form.value !== "" ? Number(form.value) : null,
      value_type: form.value_type,
      effective_from: form.effective_from,
      effective_to: form.effective_to || null,
      status: form.status,
      is_active: form.is_active,
      auto_apply: form.auto_apply,
      requires_approval: form.requires_approval,
      usage_limit: form.usage_limit !== "" ? Number(form.usage_limit) : null,
      stackable: form.stackable,
      max_stack_count: Number(form.max_stack_count) || 1,
      product_id: form.product_id ? Number(form.product_id) : null,
      customer_id: form.customer_id ? Number(form.customer_id) : null,
      region: form.region || null,
      country: form.country || null,
      min_quantity: form.min_quantity !== "" ? Number(form.min_quantity) : null,
      max_quantity: form.max_quantity !== "" ? Number(form.max_quantity) : null,
    };

    await onSave(payload);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">{editRule ? "Edit Pricing Rule" : "Create Pricing Rule"}</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
        </div>
        <div className="px-6 py-4 space-y-4">
          {formError && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">{formError}</div>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Name *</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={form.name} onChange={e => set("name", e.target.value)} /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Code *</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={form.code} onChange={e => set("code", e.target.value)} placeholder="e.g. DISC-001" /></div>
          </div>
          <div><label className="block text-xs font-medium text-slate-500 mb-1">Description</label><textarea className="w-full border rounded-lg px-3 py-2 text-sm" rows={2} value={form.description} onChange={e => set("description", e.target.value)} /></div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Rule Type *</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.rule_type} onChange={e => set("rule_type", e.target.value)}>
                {RULE_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Scope</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.scope} onChange={e => set("scope", e.target.value)}>
                {SCOPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Value Type</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.value_type} onChange={e => set("value_type", e.target.value)}>
                {VALUE_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Value</label><input type="number" step="0.01" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.value} onChange={e => set("value", e.target.value)} /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Priority</label><input type="number" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.priority} onChange={e => set("priority", e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Effective From *</label><input type="date" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.effective_from} onChange={e => set("effective_from", e.target.value)} /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Effective To</label><input type="date" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.effective_to} onChange={e => set("effective_to", e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.status} onChange={e => set("status", e.target.value)}>
                <option value="draft">Draft</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="scheduled">Scheduled</option>
              </select>
            </div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Usage Limit</label><input type="number" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.usage_limit} onChange={e => set("usage_limit", e.target.value)} placeholder="Unlimited" /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Product ID</label><input type="number" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.product_id} onChange={e => set("product_id", e.target.value)} placeholder="Optional" /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Region</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={form.region} onChange={e => set("region", e.target.value)} placeholder="Optional" /></div>
          </div>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_active} onChange={e => set("is_active", e.target.checked)} className="rounded" /> Active</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.auto_apply} onChange={e => set("auto_apply", e.target.checked)} className="rounded" /> Auto Apply</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.stackable} onChange={e => set("stackable", e.target.checked)} className="rounded" /> Stackable</label>
          </div>
        </div>
        <div className="flex gap-2 justify-end px-6 py-4 border-t">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-slate-50">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700 disabled:opacity-50">{saving ? "Saving..." : editRule ? "Update Rule" : "Create Rule"}</button>
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
          <h2 className="text-lg font-semibold">Pricing Rule Details</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><span className="text-slate-500">Name:</span> <span className="font-medium ml-2">{item.name}</span></div>
            <div><span className="text-slate-500">Code:</span> <span className="font-medium ml-2">{item.code}</span></div>
            <div><span className="text-slate-500">Type:</span> <span className="ml-2 capitalize">{item.rule_type?.replace("_", " ")}</span></div>
            <div><span className="text-slate-500">Scope:</span> <span className="ml-2 capitalize">{item.scope}</span></div>
            <div><span className="text-slate-500">Value:</span> <span className="ml-2">{item.value_type === "percentage" ? `${item.value}%` : `$${item.value}`}</span></div>
            <div><span className="text-slate-500">Priority:</span> <span className="ml-2">{item.priority}</span></div>
            <div><span className="text-slate-500">Status:</span> <span className="ml-2"><StatusBadge status={item.status} /></span></div>
            <div><span className="text-slate-500">Usage:</span> <span className="ml-2">{item.usage_count ?? 0}{item.usage_limit ? ` / ${item.usage_limit}` : ""}</span></div>
            <div><span className="text-slate-500">Effective:</span> <span className="ml-2">{formatDisplayDate(item.effective_from)}{item.effective_to ? ` — ${formatDisplayDate(item.effective_to)}` : ""}</span></div>
            <div><span className="text-slate-500">Stackable:</span> <span className="ml-2">{item.stackable ? "Yes" : "No"}</span></div>
            {item.product_id && <div><span className="text-slate-500">Product ID:</span> <span className="ml-2">{item.product_id}</span></div>}
            {item.region && <div><span className="text-slate-500">Region:</span> <span className="ml-2">{item.region}</span></div>}
            {item.country && <div><span className="text-slate-500">Country:</span> <span className="ml-2">{item.country}</span></div>}
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

export default function PricingRulesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ items: [], total: 0, page: 1, per_page: 20, pages: 0 });
  const [searchTerm, setSearchTerm] = useState("");
  const [ruleTypeFilter, setRuleTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editRule, setEditRule] = useState(null);
  const [saving, setSaving] = useState(false);
  const [viewItem, setViewItem] = useState(null);

  const fetchData = useCallback(async (page = 1) => {
    setLoading(true); setError(null);
    try {
      const params = { page, per_page: 20, active_only: !showInactive };
      if (searchTerm) params.search_term = searchTerm;
      if (ruleTypeFilter) params.rule_type = ruleTypeFilter;
      if (statusFilter) params.status = statusFilter;
      const res = await pricingRuleApi.list(params);
      setData(res);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [searchTerm, ruleTypeFilter, statusFilter, showInactive]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSave = async (payload) => {
    setSaving(true);
    try {
      if (editRule) {
        await pricingRuleApi.update(editRule.id, payload);
      } else {
        await pricingRuleApi.create(payload);
      }
      setShowForm(false);
      setEditRule(null);
      fetchData();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <HRPage title="Pricing Rules" icon={ListFilter}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input className="pl-9 pr-3 py-2 border rounded-lg text-sm w-48" placeholder="Search rules..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
            </div>
            <select className="border rounded-lg px-3 py-2 text-sm" value={ruleTypeFilter} onChange={e => setRuleTypeFilter(e.target.value)}>
              <option value="">All Types</option>
              {RULE_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select className="border rounded-lg px-3 py-2 text-sm" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All Status</option>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
              <option value="inactive">Inactive</option>
              <option value="expired">Expired</option>
              <option value="scheduled">Scheduled</option>
            </select>
            <label className="flex items-center gap-2 text-sm text-slate-600 px-1">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Show inactive
            </label>
            <button onClick={() => fetchData()} className="p-2 border rounded-lg hover:bg-slate-50"><RefreshCw size={16} /></button>
          </div>
          <button onClick={() => { setEditRule(null); setShowForm(true); }} className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700"><Plus size={16} /> Create Rule</button>
        </div>

        {error && <ErrorState message={error} onRetry={() => fetchData()} />}
        {loading ? <Spinner /> : !data.items?.length ? <EmptyState message="No pricing rules found" /> : (
          <div className="bg-white rounded-3xl border overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr><th className="text-left px-4 py-3">Name / Code</th><th className="text-left px-4 py-3">Type</th><th className="text-left px-4 py-3">Scope</th><th className="text-center px-4 py-3">Priority</th><th className="text-left px-4 py-3">Status</th><th className="text-left px-4 py-3">Effective</th><th className="text-right px-4 py-3">Actions</th></tr>
              </thead>
              <tbody className="divide-y">
                {data.items.map(item => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3"><div className="font-medium text-sm">{item.name}</div><div className="text-xs text-slate-400">{item.code}</div></td>
                    <td className="px-4 py-3 text-sm capitalize">{item.rule_type?.replace("_", " ")}</td>
                    <td className="px-4 py-3 text-sm capitalize">{item.scope}</td>
                    <td className="px-4 py-3 text-center text-sm">{item.priority}</td>
                    <td className="px-4 py-3"><StatusBadge status={item.status} /></td>
                    <td className="px-4 py-3 text-sm">{formatDisplayDate(item.effective_from)}{item.effective_to ? ` — ${formatDisplayDate(item.effective_to)}` : ""}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setViewItem(item)} className="text-brand-600 hover:text-brand-700 text-sm mr-3">View</button>
                      <button onClick={() => { setEditRule(item); setShowForm(true); }} className="text-blue-600 hover:text-blue-800 text-sm mr-3"><Pencil size={14} className="inline" /> Edit</button>
                      {item.is_active ? (
                        <button onClick={async () => { try { await pricingRuleApi.deactivate(item.id); fetchData(); } catch (e) { setError(e.message); } }} className="text-red-500 hover:text-red-700 text-sm">Deactivate</button>
                      ) : (
                        <button onClick={async () => { try { await pricingRuleApi.activate(item.id); fetchData(); } catch (e) { setError(e.message); } }} className="text-green-600 hover:text-green-800 text-sm">Activate</button>
                      )}
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

      <RuleFormModal show={showForm} onClose={() => { setShowForm(false); setEditRule(null); }} onSave={handleSave} editRule={editRule} saving={saving} />
      <DetailModal show={!!viewItem} onClose={() => setViewItem(null)} item={viewItem} />
    </HRPage>
  );
}
