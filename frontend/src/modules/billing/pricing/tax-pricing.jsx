import { useState, useEffect, useCallback } from "react";
import {
  DollarSign, Search, Plus, RefreshCw, CheckCircle, X, Pencil, Layers,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { taxPricingApi } from "../../../service/billingService";
import { formatDisplayDate } from "../../../utils/billing-helpers";
import { Spinner, EmptyState, ErrorState } from "../../../components/billing-shared";

const TAX_TYPE_OPTIONS = [
  { value: "vat", label: "VAT" },
  { value: "gst", label: "GST" },
  { value: "sales_tax", label: "Sales Tax" },
  { value: "withholding", label: "Withholding" },
  { value: "service_tax", label: "Service Tax" },
  { value: "customs", label: "Customs" },
  { value: "excise", label: "Excise" },
  { value: "other", label: "Other" },
];

const PRICING_TYPE_OPTIONS = [
  { value: "exclusive", label: "Exclusive" },
  { value: "inclusive", label: "Inclusive" },
];

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function StatusBadge({ is_active }) {
  return is_active
    ? <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700">Active</span>
    : <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">Inactive</span>;
}

const EMPTY_FORM = {
  name: "", code: "", description: "", tax_type: "vat", rate: "",
  pricing_type: "exclusive", country: "", region: "", state: "", city: "",
  effective_from: todayIsoDate(), effective_to: "", is_default: false,
  is_active: true, applies_to_products: true, applies_to_services: true,
  applies_to_shipping: false, is_compound: false, is_recoverable: true,
};

function TaxFormModal({ show, onClose, onSave, editItem, saving }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (editItem) {
      setForm({
        name: editItem.name || "", code: editItem.code || "", description: editItem.description || "",
        tax_type: editItem.tax_type || "vat", rate: editItem.rate ?? "",
        pricing_type: editItem.pricing_type || "exclusive", country: editItem.country || "",
        region: editItem.region || "", state: editItem.state || "", city: editItem.city || "",
        effective_from: editItem.effective_from || todayIsoDate(),
        effective_to: editItem.effective_to || "", is_default: editItem.is_default ?? false,
        is_active: editItem.is_active ?? true, applies_to_products: editItem.applies_to_products ?? true,
        applies_to_services: editItem.applies_to_services ?? true, applies_to_shipping: editItem.applies_to_shipping ?? false,
        is_compound: editItem.is_compound ?? false, is_recoverable: editItem.is_recoverable ?? true,
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
    if (!form.code.trim()) return setFormError("Code is required");
    if (form.rate === "" || Number(form.rate) < 0) return setFormError("Rate is required");
    if (Number(form.rate) > 100) return setFormError("Rate cannot exceed 100%");
    if (!form.effective_from) return setFormError("Effective from date is required");

    const payload = {
      name: form.name.trim(),
      code: form.code.trim().toUpperCase(),
      description: form.description || null,
      tax_type: form.tax_type,
      rate: Number(form.rate),
      pricing_type: form.pricing_type,
      country: form.country || null,
      region: form.region || null,
      state: form.state || null,
      city: form.city || null,
      effective_from: form.effective_from,
      effective_to: form.effective_to || null,
      is_default: form.is_default,
      is_active: form.is_active,
      applies_to_products: form.applies_to_products,
      applies_to_services: form.applies_to_services,
      applies_to_shipping: form.applies_to_shipping,
      is_compound: form.is_compound,
      is_recoverable: form.is_recoverable,
    };

    await onSave(payload);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">{editItem ? "Edit Tax Pricing" : "Create Tax Pricing"}</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
        </div>
        <div className="px-6 py-4 space-y-4">
          {formError && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-2 rounded-lg text-sm">{formError}</div>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Name *</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={form.name} onChange={e => set("name", e.target.value)} /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Code *</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={form.code} onChange={e => set("code", e.target.value)} placeholder="e.g. GST-18" /></div>
          </div>
<div><label className="block text-xs font-medium text-slate-500 mb-1">Description</label><textarea className="w-full border rounded-lg px-3 py-2 text-sm" rows={2} value={form.description} onChange={e => set("description", e.target.value)} /></div>
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
             <div><label className="block text-xs font-medium text-slate-500 mb-1">Tax Type *</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.tax_type} onChange={e => set("tax_type", e.target.value)}>
                {TAX_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Rate (%) *</label><input type="number" step="0.01" min="0" max="100" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.rate} onChange={e => set("rate", e.target.value)} /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Pricing Type</label>
              <select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.pricing_type} onChange={e => set("pricing_type", e.target.value)}>
                {PRICING_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
</div>
           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
             <div><label className="block text-xs font-medium text-slate-500 mb-1">Country</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={form.country} onChange={e => set("country", e.target.value)} placeholder="e.g. US" /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Region</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={form.region} onChange={e => set("region", e.target.value)} /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">State</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={form.state} onChange={e => set("state", e.target.value)} /></div>
</div>
           <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
             <div><label className="block text-xs font-medium text-slate-500 mb-1">Effective From *</label><input type="date" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.effective_from} onChange={e => set("effective_from", e.target.value)} /></div>
            <div><label className="block text-xs font-medium text-slate-500 mb-1">Effective To</label><input type="date" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.effective_to} onChange={e => set("effective_to", e.target.value)} /></div>
          </div>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_active} onChange={e => set("is_active", e.target.checked)} className="rounded" /> Active</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_default} onChange={e => set("is_default", e.target.checked)} className="rounded" /> Default</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.applies_to_products} onChange={e => set("applies_to_products", e.target.checked)} className="rounded" /> Products</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.applies_to_services} onChange={e => set("applies_to_services", e.target.checked)} className="rounded" /> Services</label>
          </div>
        </div>
        <div className="flex gap-2 justify-end px-6 py-4 border-t">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-slate-50">Cancel</button>
          <button onClick={handleSubmit} disabled={saving} className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700 disabled:opacity-50">{saving ? "Saving..." : editItem ? "Update Tax" : "Create Tax"}</button>
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
          <h2 className="text-lg font-semibold">Tax Pricing Details</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div><span className="text-slate-500">Name:</span> <span className="font-medium ml-2">{item.name}</span></div>
            <div><span className="text-slate-500">Code:</span> <span className="font-medium ml-2">{item.code}</span></div>
            <div><span className="text-slate-500">Type:</span> <span className="ml-2 capitalize">{item.tax_type}</span></div>
            <div><span className="text-slate-500">Rate:</span> <span className="ml-2 font-medium">{item.rate}%</span></div>
            <div><span className="text-slate-500">Pricing:</span> <span className="ml-2 capitalize">{item.pricing_type}</span></div>
            <div><span className="text-slate-500">Jurisdiction:</span> <span className="ml-2">{item.country || "—"}{item.region ? ` / ${item.region}` : ""}{item.state ? ` / ${item.state}` : ""}</span></div>
            <div><span className="text-slate-500">Effective:</span> <span className="ml-2">{formatDisplayDate(item.effective_from)}{item.effective_to ? ` — ${formatDisplayDate(item.effective_to)}` : ""}</span></div>
            <div><span className="text-slate-500">Default:</span> <span className="ml-2">{item.is_default ? "Yes" : "No"}</span></div>
            <div><span className="text-slate-500">Status:</span> <span className="ml-2"><StatusBadge is_active={item.is_active} /></span></div>
            <div><span className="text-slate-500">Products:</span> <span className="ml-2">{item.applies_to_products ? "Yes" : "No"}</span></div>
            <div><span className="text-slate-500">Services:</span> <span className="ml-2">{item.applies_to_services ? "Yes" : "No"}</span></div>
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

function TaxGroupsModal({ show, onClose, taxPricingApi, allTaxItems, onError }) {
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState([]);
  const [showCreateEdit, setShowCreateEdit] = useState(false);
  const [editGroup, setEditGroup] = useState(null);
  const [groupForm, setGroupForm] = useState({ name: "", code: "", description: "", country: "", is_default: false, is_active: true });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [viewMembers, setViewMembers] = useState(null);
  const [members, setMembers] = useState([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [addMemberTaxId, setAddMemberTaxId] = useState("");
  const [addMemberSaving, setAddMemberSaving] = useState(false);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const res = await taxPricingApi.listGroups({ per_page: 50 });
      setGroups(res?.items || []);
    } catch (e) { onError(e.message); }
    finally { setLoading(false); }
  }, [taxPricingApi, onError]);

  useEffect(() => { if (show) fetchGroups(); }, [show, fetchGroups]);

  const handleSaveGroup = async () => {
    setFormError("");
    if (!groupForm.name.trim()) return setFormError("Name is required");
    if (!groupForm.code.trim()) return setFormError("Code is required");
    setSaving(true);
    try {
      const payload = {
        name: groupForm.name.trim(),
        code: groupForm.code.trim().toUpperCase(),
        description: groupForm.description || null,
        country: groupForm.country || null,
        is_default: groupForm.is_default,
        is_active: groupForm.is_active,
      };
      if (editGroup) {
        await taxPricingApi.updateGroup(editGroup.id, payload);
      } else {
        await taxPricingApi.createGroup(payload);
      }
      setShowCreateEdit(false);
      setEditGroup(null);
      setGroupForm({ name: "", code: "", description: "", country: "", is_default: false, is_active: true });
      fetchGroups();
    } catch (e) { setFormError(e.message); }
    finally { setSaving(false); }
  };

  const handleDeleteGroup = async (id) => {
    try {
      await taxPricingApi.deactivateGroup(id);
      fetchGroups();
    } catch (e) { onError(e.message); }
  };

  const fetchMembers = async (group) => {
    setViewMembers(group);
    setLoadingMembers(true);
    try {
      const res = await taxPricingApi.listGroupMembers(group.id);
      setMembers(res?.items || res?.tax_items || []);
    } catch (e) { onError(e.message); }
    finally { setLoadingMembers(false); }
  };

  const handleAddMember = async () => {
    if (!addMemberTaxId) return;
    setAddMemberSaving(true);
    try {
      await taxPricingApi.addGroupMember(viewMembers.id, { tax_pricing_id: Number(addMemberTaxId) });
      setAddMemberTaxId("");
      fetchMembers(viewMembers);
    } catch (e) { onError(e.message); }
    finally { setAddMemberSaving(false); }
  };

  const handleRemoveMember = async (memberId) => {
    try {
      await taxPricingApi.removeGroupMember(memberId);
      fetchMembers(viewMembers);
    } catch (e) { onError(e.message); }
  };

  if (!show) return null;

  const usedTaxIds = new Set((members || []).map(m => m.tax_pricing_id || m.id));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">Tax Groups</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => { setEditGroup(null); setGroupForm({ name: "", code: "", description: "", country: "", is_default: false, is_active: true }); setShowCreateEdit(true); }} className="flex items-center gap-1 px-3 py-1.5 bg-brand-600 text-white rounded-lg text-xs font-medium hover:bg-brand-700"><Plus size={14} /> Add Group</button>
            <button onClick={onClose} aria-label="Close" className="p-1 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
          </div>
        </div>
        <div className="px-6 py-4">
          {showCreateEdit && (
            <div className="mb-4 p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
              <h3 className="text-sm font-semibold">{editGroup ? "Edit Tax Group" : "Create Tax Group"}</h3>
              {formError && <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-xs">{formError}</div>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div><label className="block text-xs font-medium text-slate-500 mb-1">Name *</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={groupForm.name} onChange={e => setGroupForm(p => ({ ...p, name: e.target.value }))} /></div>
                <div><label className="block text-xs font-medium text-slate-500 mb-1">Code *</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={groupForm.code} onChange={e => setGroupForm(p => ({ ...p, code: e.target.value }))} /></div>
                <div className="col-span-2"><label className="block text-xs font-medium text-slate-500 mb-1">Description</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={groupForm.description} onChange={e => setGroupForm(p => ({ ...p, description: e.target.value }))} /></div>
                <div><label className="block text-xs font-medium text-slate-500 mb-1">Country</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={groupForm.country} onChange={e => setGroupForm(p => ({ ...p, country: e.target.value }))} placeholder="e.g. US" /></div>
                <div className="flex items-center gap-4 pt-5">
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={groupForm.is_default} onChange={e => setGroupForm(p => ({ ...p, is_default: e.target.checked }))} className="rounded" /> Default</label>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={groupForm.is_active} onChange={e => setGroupForm(p => ({ ...p, is_active: e.target.checked }))} className="rounded" /> Active</label>
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <button onClick={() => { setShowCreateEdit(false); setEditGroup(null); }} className="px-3 py-1.5 border rounded-lg text-xs">Cancel</button>
                <button onClick={handleSaveGroup} disabled={saving} className="px-3 py-1.5 bg-brand-600 text-white rounded-lg text-xs hover:bg-brand-700 disabled:opacity-50">{saving ? "Saving..." : editGroup ? "Update" : "Create"}</button>
              </div>
            </div>
          )}

          {loading ? <Spinner /> : !groups.length ? <EmptyState message="No tax groups found" /> : (
            <div className="bg-white rounded-3xl border overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                  <tr><th className="text-left px-4 py-3">Name</th><th className="text-left px-4 py-3">Code</th><th className="text-left px-4 py-3">Country</th><th className="text-center px-4 py-3">Default</th><th className="text-center px-4 py-3">Active</th><th className="text-right px-4 py-3">Actions</th></tr>
                </thead>
                <tbody className="divide-y">
                  {groups.map(g => (
                    <tr key={g.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 text-sm font-medium">{g.name}</td>
                      <td className="px-4 py-3 text-sm">{g.code}</td>
                      <td className="px-4 py-3 text-sm">{g.country || "—"}</td>
                      <td className="px-4 py-3 text-center">{g.is_default ? <CheckCircle size={16} className="text-green-500 mx-auto" /> : "—"}</td>
                      <td className="px-4 py-3 text-center">{g.is_active ? <CheckCircle size={16} className="text-green-500 mx-auto" /> : "—"}</td>
                      <td className="px-4 py-3 text-right space-x-2">
                        <button onClick={() => fetchMembers(g)} className="text-brand-600 hover:text-brand-700 text-xs">Members</button>
                        <button onClick={() => { setEditGroup(g); setGroupForm({ name: g.name, code: g.code, description: g.description || "", country: g.country || "", is_default: g.is_default ?? false, is_active: g.is_active ?? true }); setShowCreateEdit(true); }} className="text-blue-600 hover:text-blue-800 text-xs"><Pencil size={12} className="inline" /> Edit</button>
                        <button onClick={() => handleDeleteGroup(g.id)} className="text-red-500 hover:text-red-700 text-xs">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="flex justify-end px-6 py-4 border-t">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm hover:bg-slate-50">Close</button>
        </div>
      </div>

      {viewMembers && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h2 className="text-lg font-semibold">Members: {viewMembers.name}</h2>
              <button onClick={() => { setViewMembers(null); setMembers([]); }} className="p-1 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-slate-500 mb-1">Add Tax Pricing to Group</label>
                  <select className="w-full border rounded-lg px-3 py-2 text-sm" value={addMemberTaxId} onChange={e => setAddMemberTaxId(e.target.value)}>
                    <option value="">Select a tax pricing...</option>
                    {allTaxItems.filter(t => !usedTaxIds.has(t.id)).map(t => (
                      <option key={t.id} value={t.id}>{t.name} ({t.code}) - {t.rate}%</option>
                    ))}
                  </select>
                </div>
                <button onClick={handleAddMember} disabled={!addMemberTaxId || addMemberSaving} className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700 disabled:opacity-50 whitespace-nowrap">{addMemberSaving ? "Adding..." : "Add"}</button>
              </div>

              {loadingMembers ? <Spinner /> : !members.length ? <EmptyState message="No members in this group" /> : (
                <div className="bg-white rounded-3xl border overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                      <tr><th className="text-left px-4 py-3">Name</th><th className="text-left px-4 py-3">Code</th><th className="text-right px-4 py-3">Rate</th><th className="text-right px-4 py-3">Actions</th></tr>
                    </thead>
                    <tbody className="divide-y">
                      {members.map(m => (
                        <tr key={m.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3 text-sm font-medium">{m.name}</td>
                          <td className="px-4 py-3 text-sm">{m.code}</td>
                          <td className="px-4 py-3 text-sm text-right">{m.rate}%</td>
                          <td className="px-4 py-3 text-right">
                            <button onClick={() => handleRemoveMember(m.tax_pricing_id || m.id)} className="text-red-500 hover:text-red-700 text-xs">Remove</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="flex justify-end px-6 py-4 border-t">
              <button onClick={() => { setViewMembers(null); setMembers([]); }} className="px-4 py-2 border rounded-lg text-sm hover:bg-slate-50">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TaxPricingPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ items: [], total: 0, page: 1, per_page: 20, pages: 0 });
  const [searchTerm, setSearchTerm] = useState("");
  const [taxTypeFilter, setTaxTypeFilter] = useState("");
  const [countryFilter, setCountryFilter] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [saving, setSaving] = useState(false);
  const [viewItem, setViewItem] = useState(null);
  const [showTaxGroups, setShowTaxGroups] = useState(false);

  const fetchData = useCallback(async (page = 1) => {
    setLoading(true); setError(null);
    try {
      const params = { page, per_page: 20 };
      if (searchTerm) params.search_term = searchTerm;
      if (taxTypeFilter) params.tax_type = taxTypeFilter;
      if (countryFilter) params.country = countryFilter;
      const res = await taxPricingApi.list(params);
      setData(res);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [searchTerm, taxTypeFilter, countryFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSave = async (payload) => {
    setSaving(true);
    try {
      if (editItem) {
        await taxPricingApi.update(editItem.id, payload);
      } else {
        await taxPricingApi.create(payload);
      }
      setShowForm(false);
      setEditItem(null);
      fetchData();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  return (
    <HRPage title="Tax Pricing" icon={DollarSign}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
              <input className="pl-9 pr-3 py-2 border rounded-lg text-sm w-48" placeholder="Search tax pricing..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
            </div>
            <select className="border rounded-lg px-3 py-2 text-sm" value={taxTypeFilter} onChange={e => setTaxTypeFilter(e.target.value)}>
              <option value="">All Types</option>
              {TAX_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input className="border rounded-lg px-3 py-2 text-sm w-32" placeholder="Country" value={countryFilter} onChange={e => setCountryFilter(e.target.value)} />
            <button onClick={() => fetchData()} className="p-2 border rounded-lg hover:bg-slate-50"><RefreshCw size={16} /></button>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowTaxGroups(true)} className="flex items-center gap-2 px-4 py-2 border rounded-lg text-sm hover:bg-slate-50"><Layers size={16} /> Tax Groups</button>
            <button onClick={() => { setEditItem(null); setShowForm(true); }} className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700"><Plus size={16} /> Create Tax</button>
          </div>
        </div>

        {error && <ErrorState message={error} onRetry={() => fetchData()} />}
        {loading ? <Spinner /> : !data.items?.length ? <EmptyState message="No tax pricing found" /> : (
          <div className="bg-white rounded-3xl border overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                <tr><th className="text-left px-4 py-3">Name / Code</th><th className="text-left px-4 py-3">Type</th><th className="text-right px-4 py-3">Rate</th><th className="text-left px-4 py-3">Jurisdiction</th><th className="text-left px-4 py-3">Pricing</th><th className="text-left px-4 py-3">Effective</th><th className="text-center px-4 py-3">Default</th><th className="text-right px-4 py-3">Actions</th></tr>
              </thead>
              <tbody className="divide-y">
                {data.items.map(item => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3"><div className="font-medium text-sm">{item.name}</div><div className="text-xs text-slate-500">{item.code}</div></td>
                    <td className="px-4 py-3 text-sm capitalize">{item.tax_type}</td>
                    <td className="px-4 py-3 text-sm text-right">{item.rate}%</td>
                    <td className="px-4 py-3 text-sm">{item.country || "—"}{item.region ? ` / ${item.region}` : ""}</td>
                    <td className="px-4 py-3 text-sm capitalize">{item.pricing_type}</td>
                    <td className="px-4 py-3 text-sm">{formatDisplayDate(item.effective_from)}{item.effective_to ? ` — ${formatDisplayDate(item.effective_to)}` : ""}</td>
                    <td className="px-4 py-3 text-center">{item.is_default ? <CheckCircle size={16} className="text-green-500 mx-auto" /> : "—"}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setViewItem(item)} className="text-brand-600 hover:text-brand-700 text-sm mr-3">View</button>
                      <button onClick={() => { setEditItem(item); setShowForm(true); }} className="text-blue-600 hover:text-blue-800 text-sm mr-3"><Pencil size={14} className="inline" /> Edit</button>
                      <button onClick={async () => { try { await taxPricingApi.deactivate(item.id); fetchData(); } catch (e) { setError(e.message); } }} className="text-red-500 hover:text-red-700 text-sm">Deactivate</button>
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

      <TaxFormModal show={showForm} onClose={() => { setShowForm(false); setEditItem(null); }} onSave={handleSave} editItem={editItem} saving={saving} />
      <DetailModal show={!!viewItem} onClose={() => setViewItem(null)} item={viewItem} />

      {showTaxGroups && (
        <TaxGroupsModal
          show={showTaxGroups}
          onClose={() => setShowTaxGroups(false)}
          taxPricingApi={taxPricingApi}
          allTaxItems={data.items || []}
          onError={setError}
        />
      )}
    </HRPage>
  );
}
