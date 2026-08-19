import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { Tag, Layers, Plus, X, AlertCircle, RefreshCw, Trash2 } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { pricingApi, settingsApi } from "../../../service/billingService";
import { Spinner, ErrorState, EmptyState } from "../../../components/billing-shared";
import { extractArray } from "../../../utils/billing-helpers";
import { formatCurrency } from "../../../utils/currency";


const TIER_TYPES = [
  { value: "flat", label: "Flat" },
  { value: "volume", label: "Volume" },
  { value: "graduated", label: "Graduated" },
];

export default function TierManagementPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const planIdFromUrl = searchParams.get("plan_id") || "";

  const [plans, setPlans] = useState([]);
  const [selectedPlanId, setSelectedPlanId] = useState(planIdFromUrl);
  const [selectedPlanName, setSelectedPlanName] = useState("");
  const [tiers, setTiers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [showAddModal, setShowAddModal] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState(null);
  const [newTier, setNewTier] = useState({
    name: "", type: "flat", min_units: "", max_units: "", unit_price: "", priority: "",
  });

  const [confirmRemove, setConfirmRemove] = useState(null);
  const [removeLoading, setRemoveLoading] = useState(false);
  const [orgCurrency, setOrgCurrency] = useState("");

  useEffect(() => {
    settingsApi.getConfig().then((res) => {
      const cfg = res?.data || res;
      if (cfg?.default_currency) setOrgCurrency(cfg.default_currency);
    }).catch((err) => console.error("[TierManagement] Failed to load config:", err));
  }, []);

  useEffect(() => {
    pricingApi.list({ per_page: 100 }).then((data) => {
      setPlans(extractArray(data));
    }).catch((err) => console.error("[TierManagement] Failed to load pricing plans:", err));
  }, []);

  useEffect(() => {
    if (selectedPlanId) {
      const found = plans.find((p) => p.id === selectedPlanId);
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
      if (!loading) setRefreshing(true);
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
  }, [selectedPlanId, loading]);

  useEffect(() => { fetchTiers(); }, [fetchTiers]);

  const handlePlanChange = (id) => {
    setSelectedPlanId(id);
    setSearchParams(id ? { plan_id: id } : {}, { replace: true });
    setLoading(true);
  };

  const handleAddTier = async () => {
    setFormLoading(true); setFormError(null);
    try {
      await pricingApi.addTier(selectedPlanId, {
        pricing_plan_id: parseInt(selectedPlanId),
        from_quantity: parseInt(newTier.min_units) || 1,
        to_quantity: newTier.max_units !== "" ? parseInt(newTier.max_units) : null,
        unit_price: parseFloat(newTier.unit_price) || 0,
        flat_fee: 0,
      });
      setShowAddModal(false);
      setNewTier({ name: "", type: "flat", min_units: "", max_units: "", unit_price: "", priority: "" });
      fetchTiers();
    } catch (err) {
      setFormError(err.message || "Failed to add tier");
    } finally {
      setFormLoading(false);
    }
  };

  const handleRemoveTier = async (tierId) => {
    setRemoveLoading(true);
    try {
      await pricingApi.removeTier(selectedPlanId, tierId);
      setConfirmRemove(null);
      fetchTiers();
    } catch (err) {
      setError(err.message || "Failed to remove tier");
    } finally {
      setRemoveLoading(false);
    }
  };

  const AddTierModal = () => {
    if (!showAddModal) return null;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowAddModal(false)}>
        <div className="bg-white rounded-3xl p-8 w-full max-w-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-bold text-slate-800">Add Tier</h2>
            <button onClick={() => setShowAddModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
          </div>
          {formError && (
            <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
              <AlertCircle size={16} />{formError}
            </div>
          )}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Name *</label>
              <input type="text" value={newTier.name} onChange={(e) => setNewTier({ ...newTier, name: e.target.value })}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Type</label>
              <select value={newTier.type} onChange={(e) => setNewTier({ ...newTier, type: e.target.value })}
                className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                {TIER_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Min Units</label>
                <input type="number" min="0" value={newTier.min_units} onChange={(e) => setNewTier({ ...newTier, min_units: e.target.value })}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Max Units</label>
                <input type="number" min="0" value={newTier.max_units} onChange={(e) => setNewTier({ ...newTier, max_units: e.target.value })}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Unit Price *</label>
                <input type="number" step="0.01" min="0" value={newTier.unit_price} onChange={(e) => setNewTier({ ...newTier, unit_price: e.target.value })}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Priority</label>
                <input type="number" min="0" value={newTier.priority} onChange={(e) => setNewTier({ ...newTier, priority: e.target.value })}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-8">
            <button onClick={() => setShowAddModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
            <button onClick={handleAddTier} disabled={formLoading || !newTier.name || !newTier.unit_price}
              className="px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">
              {formLoading ? "Adding..." : "Add Tier"}
            </button>
          </div>
        </div>
      </div>
    );
  };

  const ConfirmRemoveModal = () => {
    if (!confirmRemove) return null;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setConfirmRemove(null)}>
        <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-full bg-red-100 flex items-center justify-center"><AlertCircle size={20} className="text-red-600" /></div>
            <div>
              <h2 className="text-lg font-bold text-slate-800">Remove Tier</h2>
              <p className="text-sm text-slate-500">Are you sure you want to remove <strong>{confirmRemove.name}</strong>?</p>
            </div>
          </div>
          <div className="flex justify-end gap-3 mt-6">
            <button onClick={() => setConfirmRemove(null)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
            <button onClick={() => handleRemoveTier(confirmRemove.id)} disabled={removeLoading}
              className="px-6 py-2 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-50">
              {removeLoading ? "Removing..." : "Remove"}
            </button>
          </div>
        </div>
      </div>
    );
  };

  if (loading && selectedPlanId) {
    return (
      <HRPage title="Tier Management" subtitle="Manage pricing tiers per plan">
        <Spinner />
      </HRPage>
    );
  }

  return (
    <HRPage title="Tier Management" subtitle="Manage pricing tiers per plan">

      <div className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden mb-6">
        <div className="p-6 border-b border-slate-100">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Layers size={20} className="text-slate-400" />
              <div className="relative w-72">
                <select value={selectedPlanId} onChange={(e) => handlePlanChange(e.target.value)}
                  className="appearance-none w-full px-4 py-2.5 pr-8 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                  <option value="">Select a pricing plan...</option>
                  {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <svg className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={fetchTiers} disabled={refreshing || !selectedPlanId} aria-label="Refresh tiers"
                className="p-2.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-50">
                <RefreshCw size={18} className={refreshing ? "animate-spin" : ""} />
              </button>
              <button onClick={() => setShowAddModal(true)} disabled={!selectedPlanId}
                className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg disabled:opacity-50">
                <Plus size={18} /> Add Tier
              </button>
            </div>
          </div>
        </div>

        {!selectedPlanId ? (
          <div className="p-12">
            <EmptyState icon={Layers} title="Select a plan" message="Choose a pricing plan above to view and manage its tiers." />
          </div>
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
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Type</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Min Units</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Max Units</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Unit Price</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Priority</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {tiers.map((tier, idx) => (
                  <tr key={tier.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-gradient-to-br from-brand to-brand-hover text-white flex items-center justify-center text-xs font-bold">
                          {("Tier " + (idx + 1)).charAt(0).toUpperCase()}
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
                    <td className="px-4 py-4 text-right text-slate-600">{tier.to_quantity ?? "—"}</td>
                    <td className="px-4 py-4 text-right font-medium text-slate-800">
                      {tier.unit_price != null ? formatCurrency(tier.unit_price, tier.currency || orgCurrency) : "—"}
                    </td>
                    <td className="px-4 py-4 text-right text-slate-600">{parseFloat(tier.flat_fee) > 0 ? formatCurrency(tier.flat_fee, tier.currency || orgCurrency) : "—"}</td>
                    <td className="px-4 py-4 text-right">
                      <button onClick={() => setConfirmRemove(tier)}
                        className="p-2 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 transition-colors" title="Remove">
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

      <AddTierModal />
      <ConfirmRemoveModal />
    </HRPage>
  );
}
