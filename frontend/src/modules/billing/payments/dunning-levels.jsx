import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Trash2, Loader2, AlertCircle, X, Layers } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { dunningApi } from "../../../service/billingService";
import { formatDisplayCurrency } from "../../../utils/billing-helpers";

const ACTION_TYPE_OPTIONS = [
  { value: "email_reminder", label: "Email Reminder" },
  { value: "sms_reminder", label: "SMS Reminder" },
  { value: "late_fee", label: "Late Fee" },
  { value: "phone_call", label: "Phone Call" },
  { value: "escalate_collections", label: "Escalate to Collections" },
];

const emptyForm = () => ({
  level_number: "", name: "", min_days_overdue: "", max_days_overdue: "",
  action_type: "email_reminder", action_template: "", fee_amount: "0", fee_percentage: "0",
});

export default function DunningLevelsPage() {
  const navigate = useNavigate();
  const [levels, setLevels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(null);

  const fetchLevels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await dunningApi.listLevels();
      setLevels(Array.isArray(data) ? [...data].sort((a, b) => a.level_number - b.level_number) : []);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load dunning levels");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchLevels(); }, [fetchLevels]);

  const handleCreate = async () => {
    try {
      setSaving(true); setFormError(null);
      await dunningApi.createLevel({
        level_number: Number(form.level_number),
        name: form.name,
        min_days_overdue: Number(form.min_days_overdue),
        max_days_overdue: form.max_days_overdue ? Number(form.max_days_overdue) : undefined,
        action_type: form.action_type,
        action_template: form.action_template || undefined,
        fee_amount: Number(form.fee_amount) || 0,
        fee_percentage: Number(form.fee_percentage) || 0,
      });
      setShowModal(false);
      setForm(emptyForm());
      fetchLevels();
    } catch (err) {
      setFormError(err?.detail || err?.message || "Failed to create dunning level");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    setDeleteLoading(id);
    try {
      await dunningApi.deleteLevel(id);
      fetchLevels();
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to delete dunning level");
    } finally {
      setDeleteLoading(null);
    }
  };

  const canSubmit = form.level_number && form.name && form.min_days_overdue !== "";

  return (
    <HRPage
      title="Dunning Levels"
      subtitle="Configure escalating reminder rules by days overdue"
      actions={
        <button onClick={() => navigate("/billing/dunning")} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
      }
    >
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="flex justify-end mb-4">
        <button onClick={() => setShowModal(true)} className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-xl hover:bg-brand-700">
          <Plus size={16} /> New Level
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Level</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Days Overdue</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Action</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Fee</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-16 text-center"><Loader2 className="h-6 w-6 animate-spin text-brand-600 mx-auto" /></td></tr>
              ) : levels.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-16 text-center">
                    <div className="flex flex-col items-center">
                      <Layers size={40} className="text-slate-300 mb-3" />
                      <p className="text-slate-500 font-medium">No dunning levels configured</p>
                      <p className="text-slate-500 text-sm mt-1">Add levels to enable automated reminder escalation.</p>
                    </div>
                  </td>
                </tr>
              ) : levels.map((l) => (
                <tr key={l.id} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-4 font-medium text-slate-800">Level {l.level_number}</td>
                  <td className="px-4 py-4 text-slate-600">{l.name}</td>
                  <td className="px-4 py-4 text-slate-600">{l.min_days_overdue}{l.max_days_overdue != null ? `–${l.max_days_overdue}` : "+"} days</td>
                  <td className="px-4 py-4"><span className="capitalize text-slate-600">{(l.action_type || "").replace(/_/g, " ")}</span></td>
                  <td className="px-4 py-4 text-right text-slate-600">
                    {Number(l.fee_amount) > 0 && formatDisplayCurrency(l.fee_amount, "—")}
                    {Number(l.fee_percentage) > 0 && ` ${l.fee_percentage}%`}
                    {!Number(l.fee_amount) && !Number(l.fee_percentage) && "—"}
                  </td>
                  <td className="px-4 py-4 text-right">
                    <button onClick={() => handleDelete(l.id)} disabled={deleteLoading === l.id}
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-red-600 transition-colors disabled:opacity-40" title="Delete">
                      {deleteLoading === l.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-800">New Dunning Level</h3>
              <button onClick={() => setShowModal(false)} className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-600"><X size={18} /></button>
            </div>
            <div className="p-6 space-y-4">
              {formError && <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2"><AlertCircle className="h-4 w-4 flex-shrink-0" /> {formError}</div>}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Level Number *</label>
                  <input type="number" min="1" value={form.level_number} onChange={(e) => setForm((p) => ({ ...p, level_number: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Name *</label>
                  <input type="text" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="e.g. Friendly Reminder"
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Min Days Overdue *</label>
                  <input type="number" min="0" value={form.min_days_overdue} onChange={(e) => setForm((p) => ({ ...p, min_days_overdue: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Max Days Overdue</label>
                  <input type="number" min="0" value={form.max_days_overdue} onChange={(e) => setForm((p) => ({ ...p, max_days_overdue: e.target.value }))} placeholder="Unlimited"
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Action Type *</label>
                <select value={form.action_type} onChange={(e) => setForm((p) => ({ ...p, action_type: e.target.value }))}
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                  {ACTION_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Flat Fee</label>
                  <input type="number" min="0" step="0.01" value={form.fee_amount} onChange={(e) => setForm((p) => ({ ...p, fee_amount: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">Fee Percentage</label>
                  <input type="number" min="0" step="0.01" value={form.fee_percentage} onChange={(e) => setForm((p) => ({ ...p, fee_percentage: e.target.value }))}
                    className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200">
              <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">Cancel</button>
              <button onClick={handleCreate} disabled={saving || !canSubmit}
                className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5">
                {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Plus size={16} />} Create
              </button>
            </div>
          </div>
        </div>
      )}
    </HRPage>
  );
}
