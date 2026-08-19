import { useState, useEffect, useCallback } from "react";
import { Tag, Search, Plus, RefreshCw, CheckCircle, Clock } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { priceListApi, settingsApi } from "../../../service/billingService";
import { formatDisplayDate } from "../../../utils/billing-helpers";
import { getCurrencySelectOptions } from "../../../utils/currency";
import { Spinner, EmptyState, ErrorState } from "../../../components/billing-shared";

const CURRENCY_OPTIONS = getCurrencySelectOptions();

function StatusBadge({ status, isActive }) {
  const active = status === "active" || (isActive && status !== "deprecated");
  const styles = active ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-700";
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${styles}`}>
      {active ? <CheckCircle size={12} /> : <Clock size={12} />}
      {status || (isActive ? "active" : "inactive")}
    </span>
  );
}

export default function PriceListsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState({ items: [], total: 0, page: 1, per_page: 20, pages: 0 });
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(null);
  const [form, setForm] = useState({ name: "", code: "", description: "", currency: "", is_default: false, effective_from: "", effective_to: "", is_active: true });
  const [saving, setSaving] = useState(false);
  const [orgCurrency, setOrgCurrency] = useState("");

  useEffect(() => {
    settingsApi.getConfig().then((res) => {
      const cfg = res?.data || res;
      if (cfg?.default_currency) setOrgCurrency(cfg.default_currency);
    }).catch((err) => console.error("[PriceLists] Failed to load config:", err));
  }, []);

  const fetchData = useCallback(async (page = 1) => {
    setLoading(true); setError(null);
    try {
      const params = { page, per_page: 20, sort_by: "name", sort_order: "asc", active_only: !showInactive };
      if (searchTerm) params.search_term = searchTerm;
      if (statusFilter) params.status = statusFilter;
      const res = await priceListApi.list(params);
      setData(res);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [searchTerm, statusFilter, showInactive]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (showEdit) {
        await priceListApi.update(showEdit, form);
      } else {
        await priceListApi.create(form);
      }
      setShowCreate(false); setShowEdit(null);
      setForm({ name: "", code: "", description: "", currency: orgCurrency, is_default: false, effective_from: "", effective_to: "", is_active: true });
      fetchData();
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  };

  const handleEdit = (item) => {
    setForm({ name: item.name, code: item.code, description: item.description || "", currency: item.currency, is_default: item.is_default, effective_from: item.effective_from, effective_to: item.effective_to || "", is_active: item.is_active });
    setShowEdit(item.id);
  };

  const handleDeactivate = async (id) => {
    try { await priceListApi.deactivate(id); fetchData(); }
    catch (e) { setError(e.message); }
  };

  const handleActivate = async (id) => {
    try { await priceListApi.activate(id); fetchData(); }
    catch (e) { setError(e.message); }
  };

  return (
    <HRPage title="Price Lists" icon={Tag}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input className="pl-9 pr-3 py-2 border rounded-lg text-sm w-60" placeholder="Search price lists..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
            </div>
            <select className="border rounded-lg px-3 py-2 text-sm" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All Status</option>
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="deprecated">Deprecated</option>
            </select>
            <label className="flex items-center gap-2 text-sm text-slate-600 px-1">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Show inactive
            </label>
            <button onClick={() => fetchData()} className="p-2 border rounded-lg hover:bg-slate-50"><RefreshCw size={16} /></button>
          </div>
          <button onClick={() => { setForm({ name: "", code: "", description: "", currency: orgCurrency, is_default: false, effective_from: "", effective_to: "", is_active: true }); setShowCreate(true); setShowEdit(null); }} className="flex items-center gap-2 px-4 py-2 bg-brand-600 text-white rounded-lg hover:bg-brand-700"><Plus size={16} /> Create Price List</button>
        </div>

        {(showCreate || showEdit) && (
          <div className="bg-white border rounded-xl p-6 space-y-4">
            <h3 className="text-lg font-semibold">{showEdit ? "Edit Price List" : "Create Price List"}</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label className="block text-xs font-medium text-slate-500 mb-1">Name</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} /></div>
              <div><label className="block text-xs font-medium text-slate-500 mb-1">Code</label><input className="w-full border rounded-lg px-3 py-2 text-sm" value={form.code} onChange={e => setForm(p => ({ ...p, code: e.target.value }))} /></div>
              <div className="col-span-2"><label className="block text-xs font-medium text-slate-500 mb-1">Description</label><textarea className="w-full border rounded-lg px-3 py-2 text-sm" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} /></div>
              <div><label className="block text-xs font-medium text-slate-500 mb-1">Currency</label><select className="w-full border rounded-lg px-3 py-2 text-sm" value={form.currency} onChange={e => setForm(p => ({ ...p, currency: e.target.value }))}>{CURRENCY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}</select></div>
              <div className="flex items-center gap-2 pt-6"><input type="checkbox" id="is_default" checked={form.is_default} onChange={e => setForm(p => ({ ...p, is_default: e.target.checked }))} /><label htmlFor="is_default" className="text-sm">Set as default</label></div>
              <div><label className="block text-xs font-medium text-slate-500 mb-1">Effective From</label><input type="date" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.effective_from} onChange={e => setForm(p => ({ ...p, effective_from: e.target.value }))} /></div>
              <div><label className="block text-xs font-medium text-slate-500 mb-1">Effective To</label><input type="date" className="w-full border rounded-lg px-3 py-2 text-sm" value={form.effective_to} onChange={e => setForm(p => ({ ...p, effective_to: e.target.value }))} /></div>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => { setShowCreate(false); setShowEdit(null); }} className="px-4 py-2 border rounded-lg text-sm">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="px-4 py-2 bg-brand-600 text-white rounded-lg text-sm hover:bg-brand-700">{saving ? "Saving..." : "Save"}</button>
            </div>
          </div>
        )}

        {error && <ErrorState message={error} onRetry={() => fetchData()} />}

        {loading ? <Spinner /> : !data.items?.length ? <EmptyState message="No price lists found" /> : (
          <>
            <div className="bg-white rounded-3xl border overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
                  <tr><th className="text-left px-4 py-3">Name / Code</th><th className="text-left px-4 py-3">Currency</th><th className="text-left px-4 py-3">Status</th><th className="text-left px-4 py-3">Default</th><th className="text-left px-4 py-3">Effective</th><th className="text-right px-4 py-3">Actions</th></tr>
                </thead>
                <tbody className="divide-y">
                  {data.items.map(item => (
                    <tr key={item.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3"><div className="font-medium text-sm">{item.name}</div><div className="text-xs text-slate-400">{item.code}</div></td>
                      <td className="px-4 py-3 text-sm">{item.currency}</td>
                      <td className="px-4 py-3"><StatusBadge status={item.status} isActive={item.is_active} /></td>
                      <td className="px-4 py-3">{item.is_default ? <CheckCircle size={16} className="text-green-500" /> : "—"}</td>
                      <td className="px-4 py-3 text-sm">{formatDisplayDate(item.effective_from)}{item.effective_to ? ` — ${formatDisplayDate(item.effective_to)}` : ""}</td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => handleEdit(item)} className="text-brand-600 hover:text-brand-700 text-sm mr-3">Edit</button>
                        {item.is_active ? (
                          <button onClick={() => handleDeactivate(item.id)} className="text-red-500 hover:text-red-700 text-sm">Deactivate</button>
                        ) : (
                          <button onClick={() => handleActivate(item.id)} className="text-green-600 hover:text-green-800 text-sm">Activate</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.pages > 1 && (
              <div className="flex justify-center gap-2">
                {Array.from({ length: data.pages }, (_, i) => i + 1).map(p => (
                  <button key={p} onClick={() => fetchData(p)} className={`px-3 py-1 rounded text-sm ${p === data.page ? "bg-brand-600 text-white" : "border hover:bg-slate-50"}`}>{p}</button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </HRPage>
  );
}
