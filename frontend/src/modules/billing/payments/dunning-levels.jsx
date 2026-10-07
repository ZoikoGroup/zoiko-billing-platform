import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Trash2, Loader2, AlertCircle, X, Layers, Pencil, CheckCircle, Save } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { dunningApi } from "../../../service/billingService";
import { formatDisplayCurrency } from "../../../utils/billing-helpers";
import { ErrorState, useConfirmationDialog } from "../../../components/billing-shared";

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

const formFromLevel = (l) => ({
  level_number: String(l.level_number ?? ""),
  name: l.name || "",
  min_days_overdue: l.min_days_overdue != null ? String(l.min_days_overdue) : "",
  max_days_overdue: l.max_days_overdue != null ? String(l.max_days_overdue) : "",
  action_type: l.action_type || "email_reminder",
  action_template: l.action_template || "",
  fee_amount: l.fee_amount != null ? String(l.fee_amount) : "0",
  fee_percentage: l.fee_percentage != null ? String(l.fee_percentage) : "0",
});

const isWholeNumber = (v) => /^\d+$/.test(String(v ?? "").trim());

// Returns the first problem with the form, or null. The backend schema has
// no range checks on these fields, so without this a negative fee or a max
// below the min would be saved as-is.
export function validateDunningLevelForm(form, { isEdit = false } = {}) {
  if (!isEdit && (!isWholeNumber(form.level_number) || Number(form.level_number) < 1)) {
    return "Level number must be a whole number of 1 or more.";
  }
  if (!String(form.name || "").trim()) return "Name is required.";
  if (String(form.name).trim().length > 100) return "Name must be 100 characters or fewer.";
  if (!isWholeNumber(form.min_days_overdue)) return "Min days overdue must be a whole number (0 or more).";
  if (form.max_days_overdue !== "" && form.max_days_overdue != null) {
    if (!isWholeNumber(form.max_days_overdue)) return "Max days overdue must be a whole number, or blank for unlimited.";
    if (Number(form.max_days_overdue) < Number(form.min_days_overdue)) return "Max days overdue can't be less than min days overdue.";
  }
  const fee = Number(form.fee_amount || 0);
  if (!Number.isFinite(fee) || fee < 0) return "Flat fee can't be negative.";
  const pct = Number(form.fee_percentage || 0);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return "Fee percentage must be between 0 and 100.";
  return null;
}

const inputClass = "block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30";

export default function DunningLevelsPage() {
  const navigate = useNavigate();
  const [levels, setLevels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  // null = creating a new level; otherwise the level being edited.
  const [editingLevel, setEditingLevel] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(null);
  // A failed list load used to render "No dunning levels configured" under the
  // error banner -- inviting the user to recreate levels that already exist.
  const [loadFailed, setLoadFailed] = useState(false);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const fetchLevels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await dunningApi.listLevels();
      setLevels(Array.isArray(data) ? [...data].sort((a, b) => a.level_number - b.level_number) : []);
      setLoadFailed(false);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load dunning levels");
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchLevels(); }, [fetchLevels]);

  const isEdit = Boolean(editingLevel);

  const openCreate = () => {
    setEditingLevel(null); setForm(emptyForm()); setFormError(null); setShowModal(true);
  };

  const openEdit = (level) => {
    setEditingLevel(level); setForm(formFromLevel(level)); setFormError(null); setShowModal(true);
  };

  const closeModal = () => {
    if (saving) return;
    setShowModal(false); setEditingLevel(null); setFormError(null);
  };

  const flashSuccess = (msg) => {
    setSuccessMessage(msg);
    setTimeout(() => setSuccessMessage(null), 3000);
  };

  const handleSubmit = async () => {
    if (saving) return;
    const problem = validateDunningLevelForm(form, { isEdit });
    if (problem) { setFormError(problem); return; }
    const common = {
      name: form.name.trim(),
      min_days_overdue: Number(form.min_days_overdue),
      action_type: form.action_type,
      action_template: form.action_template || undefined,
      fee_amount: Number(form.fee_amount) || 0,
      fee_percentage: Number(form.fee_percentage) || 0,
    };
    try {
      setSaving(true); setFormError(null);
      if (isEdit) {
        // level_number is deliberately not sent: DunningLevelUpdate has no
        // such field (a level's position is fixed once created). An emptied
        // max is sent as null so "unlimited" can be restored on edit.
        await dunningApi.updateLevel(editingLevel.id, {
          ...common,
          max_days_overdue: form.max_days_overdue !== "" ? Number(form.max_days_overdue) : null,
        });
        flashSuccess(`Level ${editingLevel.level_number} updated.`);
      } else {
        await dunningApi.createLevel({
          ...common,
          level_number: Number(form.level_number),
          max_days_overdue: form.max_days_overdue ? Number(form.max_days_overdue) : undefined,
        });
        flashSuccess(`Level ${form.level_number} created.`);
      }
      setShowModal(false);
      setEditingLevel(null);
      setForm(emptyForm());
      fetchLevels();
    } catch (err) {
      const fallback = isEdit ? "Failed to update dunning level" : "Failed to create dunning level";
      setFormError(err?.status === 403
        ? "You don't have permission to change dunning levels. A billing admin can make this change."
        : (err?.detail || err?.message || fallback));
    } finally {
      setSaving(false);
    }
  };

  // Deleting a level changes which reminders overdue customers receive, and it
  // was a single unconfirmed click on a small icon.
  const handleDelete = async (level) => {
    const ok = await confirm({
      title: "Delete dunning level",
      message: `Delete Level ${level.level_number}${level.name ? ` "${level.name}"` : ""}? Overdue invoices will no longer escalate through this step.`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const id = level.id;
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

  const canSubmit = (isEdit || form.level_number) && form.name && form.min_days_overdue !== "";

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
      {error && !loadFailed && (
        <div role="alert" className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}
      {successMessage && (
        <div role="status" className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-700 flex items-center gap-2">
          <CheckCircle className="h-4 w-4 shrink-0" /> {successMessage}
        </div>
      )}

      <div className="flex justify-end mb-4">
        <button onClick={openCreate} className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-xl hover:bg-brand-700">
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
              ) : loadFailed ? (
                <tr><td colSpan={6} className="px-4 py-8"><ErrorState title="Couldn't load dunning levels" message={error} onRetry={fetchLevels} /></td></tr>
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
                  <td className="px-4 py-4 text-right whitespace-nowrap">
                    <button onClick={() => openEdit(l)} aria-label={`Edit level ${l.level_number}`} title="Edit"
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-brand-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
                      <Pencil size={15} />
                    </button>
                    <button onClick={() => handleDelete(l)} disabled={deleteLoading === l.id} aria-label={`Delete level ${l.level_number}`} title="Delete"
                      className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-red-600 transition-colors disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={closeModal}
          onKeyDown={(e) => { if (e.key === "Escape") closeModal(); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="dunning-level-modal-title"
            className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h3 id="dunning-level-modal-title" className="text-lg font-semibold text-slate-800">
                {isEdit ? `Edit Dunning Level ${editingLevel.level_number}` : "New Dunning Level"}
              </h3>
              <button onClick={closeModal} aria-label="Close" className="p-1 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-600"><X size={18} /></button>
            </div>
            <div className="p-6 space-y-4">
              {formError && <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2"><AlertCircle className="h-4 w-4 shrink-0" /> {formError}</div>}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="dl-level-number" className="block text-xs font-medium text-slate-600 mb-1">Level Number *</label>
                  <input id="dl-level-number" autoFocus={!isEdit} type="number" min="1" value={form.level_number} onChange={(e) => setForm((p) => ({ ...p, level_number: e.target.value }))}
                    readOnly={isEdit} aria-readonly={isEdit || undefined} aria-describedby={isEdit ? "dl-level-number-hint" : undefined}
                    className={`${inputClass} ${isEdit ? "bg-slate-50 text-slate-500 cursor-not-allowed" : ""}`} />
                  {isEdit && <p id="dl-level-number-hint" className="mt-1 text-xs text-slate-500">A level's number can't be changed after it's created.</p>}
                </div>
                <div>
                  <label htmlFor="dl-name" className="block text-xs font-medium text-slate-600 mb-1">Name *</label>
                  <input id="dl-name" autoFocus={isEdit} type="text" maxLength={100} value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="e.g. Friendly Reminder"
                    className={inputClass} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="dl-min" className="block text-xs font-medium text-slate-600 mb-1">Min Days Overdue *</label>
                  <input id="dl-min" type="number" min="0" value={form.min_days_overdue} onChange={(e) => setForm((p) => ({ ...p, min_days_overdue: e.target.value }))}
                    className={inputClass} />
                </div>
                <div>
                  <label htmlFor="dl-max" className="block text-xs font-medium text-slate-600 mb-1">Max Days Overdue</label>
                  <input id="dl-max" type="number" min="0" value={form.max_days_overdue} onChange={(e) => setForm((p) => ({ ...p, max_days_overdue: e.target.value }))} placeholder="Unlimited"
                    className={inputClass} />
                </div>
              </div>
              <div>
                <label htmlFor="dl-action" className="block text-xs font-medium text-slate-600 mb-1">Action Type *</label>
                <select id="dl-action" value={form.action_type} onChange={(e) => setForm((p) => ({ ...p, action_type: e.target.value }))}
                  className={inputClass}>
                  {ACTION_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="dl-fee" className="block text-xs font-medium text-slate-600 mb-1">Flat Fee</label>
                  <input id="dl-fee" type="number" min="0" step="0.01" value={form.fee_amount} onChange={(e) => setForm((p) => ({ ...p, fee_amount: e.target.value }))}
                    className={inputClass} />
                </div>
                <div>
                  <label htmlFor="dl-pct" className="block text-xs font-medium text-slate-600 mb-1">Fee Percentage</label>
                  <input id="dl-pct" type="number" min="0" max="100" step="0.01" value={form.fee_percentage} onChange={(e) => setForm((p) => ({ ...p, fee_percentage: e.target.value }))}
                    className={inputClass} />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200">
              <button onClick={closeModal} disabled={saving} className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50">Cancel</button>
              <button onClick={handleSubmit} disabled={saving || !canSubmit}
                className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5">
                {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : isEdit ? <Save size={16} /> : <Plus size={16} />}
                {saving ? (isEdit ? "Saving…" : "Creating…") : isEdit ? "Save Changes" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
      {ConfirmationDialog}
    </HRPage>
  );
}
