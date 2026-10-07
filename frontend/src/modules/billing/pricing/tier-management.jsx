import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Tag, Layers, Plus, X, AlertCircle, RefreshCw, Trash2 } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { pricingApi } from "../../../service/billingService";
import { loadGlobalBillingConfig } from "../../../service/billingConfigCache";
import { Spinner, ErrorState, EmptyState } from "../../../components/billing-shared";
import { extractArray } from "../../../utils/billing-helpers";
import { formatCurrency } from "../../../utils/currency";

// The fields a tier actually has (PlanTierCreate / PlanTier): a quantity band
// and its price. The form previously also asked for Name, Type and Priority --
// none of which exist on the backend, so they were silently discarded (Name was
// even required) -- while the real flat_fee was always sent as 0.
const BLANK_TIER = { from_quantity: "", to_quantity: "", unit_price: "", flat_fee: "" };

const inputCls = "w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30";

const isWhole = (v) => /^\d+$/.test(String(v).trim());
const isMoney = (v) => /^\d+(\.\d{1,4})?$/.test(String(v).trim());

// Mirrors PlanTierCreate so problems show inline; the backend stays authoritative.
export function validateTier(t) {
  if (!isWhole(t.from_quantity) || Number(t.from_quantity) < 1) return "Min units must be a whole number of 1 or more.";
  if (t.to_quantity !== "") {
    if (!isWhole(t.to_quantity)) return "Max units must be a whole number, or blank for no upper limit.";
    if (Number(t.to_quantity) <= Number(t.from_quantity)) return "Max units must be greater than min units.";
  }
  if (t.unit_price === "" || !isMoney(t.unit_price)) return "Enter a unit price of 0 or more.";
  if (t.flat_fee !== "" && !isMoney(t.flat_fee)) return "Flat fee must be 0 or more.";
  return null;
}

// Module-level components: declaring these INSIDE the page (as before) gave
// them a new identity on every render, so each keystroke unmounted and
// remounted the modal and the input lost focus after every letter.
function AddTierModal({ open, values, onChange, onCancel, onSubmit, loading, error }) {
  if (!open) return null;
  const set = (key) => (e) => onChange({ ...values, [key]: e.target.value });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="add-tier-title"
        className="bg-white rounded-3xl p-6 sm:p-8 w-full max-w-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h2 id="add-tier-title" className="text-xl font-bold text-slate-800">Add Tier</h2>
          <button onClick={onCancel} aria-label="Close" className="p-1 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
        </div>
        {error && (
          <div role="alert" className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <AlertCircle size={16} className="shrink-0" />{error}
          </div>
        )}
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="tier-from" className="block text-sm font-medium text-slate-700 mb-1">Min Units *</label>
              <input id="tier-from" type="number" min="1" step="1" value={values.from_quantity} onChange={set("from_quantity")} className={inputCls} />
            </div>
            <div>
              <label htmlFor="tier-to" className="block text-sm font-medium text-slate-700 mb-1">Max Units</label>
              <input id="tier-to" type="number" min="1" step="1" value={values.to_quantity} onChange={set("to_quantity")}
                placeholder="No limit" aria-describedby="tier-to-hint" className={inputCls} />
              <p id="tier-to-hint" className="mt-1 text-xs text-slate-500">Leave blank for no upper limit.</p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="tier-price" className="block text-sm font-medium text-slate-700 mb-1">Unit Price *</label>
              <input id="tier-price" type="number" step="0.01" min="0" value={values.unit_price} onChange={set("unit_price")} className={inputCls} />
            </div>
            <div>
              <label htmlFor="tier-fee" className="block text-sm font-medium text-slate-700 mb-1">Flat Fee</label>
              <input id="tier-fee" type="number" step="0.01" min="0" value={values.flat_fee} onChange={set("flat_fee")}
                placeholder="0.00" className={inputCls} />
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-8">
          <button onClick={onCancel} disabled={loading} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl disabled:opacity-50">Cancel</button>
          <button onClick={onSubmit} disabled={loading}
            className="px-6 py-2 bg-linear-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">
            {loading ? "Adding..." : "Add Tier"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmRemoveModal({ tier, label, onCancel, onConfirm, loading, error }) {
  if (!tier) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="remove-tier-title"
        className="bg-white rounded-3xl p-6 sm:p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-4">
          <div className="h-10 w-10 shrink-0 rounded-full bg-red-100 flex items-center justify-center"><AlertCircle size={20} className="text-red-600" /></div>
          <div>
            <h2 id="remove-tier-title" className="text-lg font-bold text-slate-800">Remove Tier</h2>
            <p className="text-sm text-slate-500">Are you sure you want to remove <strong>{label}</strong>?</p>
          </div>
        </div>
        {error && <p role="alert" className="mb-2 text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onCancel} disabled={loading} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl disabled:opacity-50">Cancel</button>
          <button onClick={onConfirm} disabled={loading}
            className="px-6 py-2 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-50">
            {loading ? "Removing..." : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}

const tierLabel = (tier, idx) => `Tier ${idx + 1} (${tier.from_quantity}${tier.to_quantity != null ? `–${tier.to_quantity}` : "+"} units)`;

export default function TierManagementPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const planIdFromUrl = searchParams.get("plan_id") || "";

  const [plans, setPlans] = useState([]);
  const [plansError, setPlansError] = useState(null);
  const [selectedPlanId, setSelectedPlanId] = useState(planIdFromUrl);
  const [selectedPlanName, setSelectedPlanName] = useState("");
  const [tiers, setTiers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [showAddModal, setShowAddModal] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState(null);
  const [newTier, setNewTier] = useState(BLANK_TIER);

  const [confirmRemove, setConfirmRemove] = useState(null);
  const [removeLoading, setRemoveLoading] = useState(false);
  const [removeError, setRemoveError] = useState(null);
  const [orgCurrency, setOrgCurrency] = useState("");

  useEffect(() => {
    loadGlobalBillingConfig().then((res) => {
      const cfg = res?.data || res;
      if (cfg?.default_currency) setOrgCurrency(cfg.default_currency);
    }).catch((err) => console.error("[TierManagement] Failed to load config:", err));
  }, []);

  useEffect(() => {
    pricingApi.list({ per_page: 100 }).then((data) => {
      setPlans(extractArray(data));
      setPlansError(null);
    }).catch((err) => setPlansError(err?.message || "Failed to load pricing plans"));
  }, []);

  useEffect(() => {
    if (selectedPlanId) {
      // selectedPlanId originates from a URL query param (?plan_id=4), so
      // it's always a string, while plan.id from the API is a number --
      // the strict === here never matched, so arriving via a direct/shared
      // link silently never resolved a plan name even though fetchTiers
      // (which passes selectedPlanId straight to the API, no comparison)
      // worked fine.
      const found = plans.find((p) => String(p.id) === String(selectedPlanId));
      setSelectedPlanName(found ? found.name : "");
    } else {
      setSelectedPlanName("");
    }
  }, [selectedPlanId, plans]);

  const fetchTiers = useCallback(async () => {
    if (!selectedPlanId) {
      setTiers([]);
      setLoading(false);
      return;
    }
    try {
      setError(null);
      setRefreshing(true);
      const data = await pricingApi.listTiers(selectedPlanId);
      const items = data.items || data.data || data || [];
      setTiers(Array.isArray(items) ? items : []);
    } catch (err) {
      setError(err.message || "Failed to load tiers");
      setTiers([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedPlanId]);

  useEffect(() => { fetchTiers(); }, [fetchTiers]);

  const handlePlanChange = (id) => {
    setSelectedPlanId(id);
    setSearchParams(id ? { plan_id: id } : {}, { replace: true });
    setLoading(true);
  };

  // Every open and every cancel starts from an empty form: Cancel used to
  // only hide the modal, so the abandoned input (and any old error) came back.
  const openAddModal = () => { setNewTier(BLANK_TIER); setFormError(null); setShowAddModal(true); };
  const closeAddModal = () => {
    if (formLoading) return;
    setShowAddModal(false); setNewTier(BLANK_TIER); setFormError(null);
  };

  const handleAddTier = async () => {
    const problem = validateTier(newTier);
    if (problem) { setFormError(problem); return; }
    setFormLoading(true); setFormError(null);
    try {
      await pricingApi.addTier(selectedPlanId, {
        pricing_plan_id: parseInt(selectedPlanId, 10),
        from_quantity: parseInt(newTier.from_quantity, 10),
        to_quantity: newTier.to_quantity !== "" ? parseInt(newTier.to_quantity, 10) : null,
        unit_price: Number(newTier.unit_price),
        flat_fee: newTier.flat_fee !== "" ? Number(newTier.flat_fee) : 0,
      });
      setShowAddModal(false);
      setNewTier(BLANK_TIER);
      fetchTiers();
    } catch (err) {
      setFormError(err?.detail || err?.message || "Failed to add tier");
    } finally {
      setFormLoading(false);
    }
  };

  const openRemove = (tier, idx) => { setRemoveError(null); setConfirmRemove({ tier, label: tierLabel(tier, idx) }); };
  const closeRemove = () => { if (!removeLoading) { setConfirmRemove(null); setRemoveError(null); } };

  const handleRemoveTier = async () => {
    setRemoveLoading(true);
    try {
      await pricingApi.removeTier(selectedPlanId, confirmRemove.tier.id);
      setConfirmRemove(null);
      fetchTiers();
    } catch (err) {
      // Shown in the dialog: the page-level error is only rendered when the
      // table is empty, so a failed removal used to be invisible.
      setRemoveError(err?.detail || err?.message || "Failed to remove tier");
    } finally {
      setRemoveLoading(false);
    }
  };

  return (
    <HRPage title="Tier Management" subtitle="Manage pricing tiers per plan">

      <div className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden mb-6">
        <div className="p-6 border-b border-slate-100">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Layers size={20} className="shrink-0 text-slate-500" aria-hidden="true" />
              <div className="relative w-full max-w-xs">
                <select value={selectedPlanId} onChange={(e) => handlePlanChange(e.target.value)} aria-label="Pricing plan"
                  className="appearance-none w-full px-4 py-2.5 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">Select a pricing plan...</option>
                  {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <svg className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={fetchTiers} disabled={refreshing || !selectedPlanId} aria-label="Refresh tiers"
                className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50">
                <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
              </button>
              <button onClick={openAddModal} disabled={!selectedPlanId}
                className="flex items-center gap-2 px-5 py-2.5 bg-linear-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">
                <Plus size={18} /> Add Tier
              </button>
            </div>
          </div>
          {plansError && (
            <p role="alert" className="mt-3 text-sm text-red-600">Couldn't load pricing plans: {plansError}</p>
          )}
        </div>

        {!selectedPlanId ? (
          <div className="p-12">
            <EmptyState icon={Layers} title="Select a plan" message="Choose a pricing plan above to view and manage its tiers." />
          </div>
        ) : loading ? (
          <div className="p-12" role="status" aria-label="Loading tiers"><Spinner /></div>
        ) : error && tiers.length === 0 ? (
          <ErrorState message={error} onRetry={fetchTiers} />
        ) : tiers.length === 0 ? (
          <div className="p-12">
            <EmptyState icon={Tag} title="No tiers yet" message={`Add pricing tiers to "${selectedPlanName}".`} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Tier</th>
                  <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Charge</th>
                  <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Min Units</th>
                  <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Max Units</th>
                  <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Unit Price</th>
                  {/* This column always showed flat_fee but was labelled "Priority". */}
                  <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Flat Fee</th>
                  <th scope="col" className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {tiers.map((tier, idx) => (
                  <tr key={tier.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-linear-to-br from-brand to-brand-hover text-white flex items-center justify-center text-xs font-bold" aria-hidden="true">
                          {idx + 1}
                        </div>
                        <span className="font-medium text-slate-800">{"Tier " + (idx + 1)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium capitalize bg-slate-100 text-slate-700">
                        {parseFloat(tier.flat_fee) > 0 ? (parseFloat(tier.unit_price) > 0 ? "Hybrid" : "Flat Fee") : "Per Unit"}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-right text-slate-600">{tier.from_quantity ?? "—"}</td>
                    <td className="px-4 py-4 text-right text-slate-600">{tier.to_quantity ?? "No limit"}</td>
                    <td className="px-4 py-4 text-right font-medium text-slate-800">
                      {tier.unit_price != null ? formatCurrency(tier.unit_price, tier.currency || orgCurrency) : "—"}
                    </td>
                    <td className="px-4 py-4 text-right text-slate-600">{parseFloat(tier.flat_fee) > 0 ? formatCurrency(tier.flat_fee, tier.currency || orgCurrency) : "—"}</td>
                    <td className="px-4 py-4 text-right">
                      <button onClick={() => openRemove(tier, idx)} aria-label={`Remove tier ${idx + 1}`}
                        className="p-2 rounded-lg hover:bg-red-50 text-slate-500 hover:text-red-600 transition-colors" title="Remove">
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <AddTierModal open={showAddModal} values={newTier} onChange={setNewTier} onCancel={closeAddModal}
        onSubmit={handleAddTier} loading={formLoading} error={formError} />
      <ConfirmRemoveModal tier={confirmRemove?.tier} label={confirmRemove?.label} onCancel={closeRemove}
        onConfirm={handleRemoveTier} loading={removeLoading} error={removeError} />
    </HRPage>
  );
}
