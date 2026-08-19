import { useState, useEffect, useCallback } from "react";
import { Save, RefreshCw, AlertCircle, CheckCircle, Globe, Shield, Plus, X, Trash2 } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { taxApi, settingsApi } from "../../../service/billingService";
import { extractArray } from "../../../utils/billing-helpers";

const TAX_RULE_OPTIONS = [
  { value: "standard", label: "Standard Rate" },
  { value: "reduced", label: "Reduced Rate" },
  { value: "zero", label: "Zero Rate" },
  { value: "exempt", label: "Exempt" },
];

const JURISDICTION_TYPES = [
  { value: "country", label: "Country" },
  { value: "state", label: "State / Province" },
  { value: "county", label: "County" },
  { value: "city", label: "City" },
  { value: "region", label: "Region" },
];

export default function TaxConfigurationPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const [taxRates, setTaxRates] = useState([]);
  const [jurisdictions, setJurisdictions] = useState([]);
  const [exemptions, setExemptions] = useState([]);

  const [newExemption, setNewExemption] = useState({ name: "", description: "", tax_rate_id: "", jurisdiction: "" });
  const [newJurisdiction, setNewJurisdiction] = useState({ name: "", type: "country", tax_rule: "standard" });

  const fetchData = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      const [ratesRes, settingsRes] = await Promise.allSettled([
        taxApi.list({ per_page: 100, taxable_type: "both" }),
        settingsApi.get(),
      ]);

      if (ratesRes.status === "fulfilled") {
        const items = extractArray(ratesRes.value);
        setTaxRates(items);
        // Derive jurisdiction list from rate jurisdictions as defaults (only if nothing saved yet)
        if (settingsRes.status !== "fulfilled" || !settingsRes.value?.tax_profiles?.length) {
          const juris = [...new Set(items.map((r) => r.jurisdiction).filter(Boolean))].map((j) => ({
            id: j,
            name: j,
            type: "country",
            tax_rule: "standard",
          }));
          setJurisdictions(juris);
        }
      }

      // Load saved jurisdictions/exemptions from tax_profiles JSON
      if (settingsRes.status === "fulfilled") {
        const profiles = settingsRes.value?.tax_profiles || [];
        const savedJuris = profiles.find((p) => p?.type === "jurisdictions");
        const savedExemptions = profiles.find((p) => p?.type === "exemptions");
        if (savedJuris?.data?.length) setJurisdictions(savedJuris.data);
        if (savedExemptions?.data?.length) setExemptions(savedExemptions.data);
      }
    } catch (err) {
      setError(err.message || "Failed to load tax configuration");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const addExemption = () => {
    if (!newExemption.name) return;
    setExemptions((prev) => [...prev, { ...newExemption, id: Date.now() }]);
    setNewExemption({ name: "", description: "", tax_rate_id: "", jurisdiction: "" });
    setSaved(false);
  };

  const removeExemption = (id) => {
    setExemptions((prev) => prev.filter((e) => e.id !== id));
    setSaved(false);
  };

  const addJurisdiction = () => {
    if (!newJurisdiction.name) return;
    setJurisdictions((prev) => [...prev, { ...newJurisdiction, id: Date.now() }]);
    setNewJurisdiction({ name: "", type: "country", tax_rule: "standard" });
    setSaved(false);
  };

  const removeJurisdiction = (id) => {
    setJurisdictions((prev) => prev.filter((j) => j.id !== id));
    setSaved(false);
  };

  // FIX (BUG 2): Was incorrectly calling taxApi.update({jurisdictions, exemptions}) which
  // mapped to PUT /tax-rates/[object Object]. Now correctly uses settingsApi.update() to
  // persist jurisdiction and exemption config into the tax_profiles JSON column.
  const handleSave = async () => {
    setSaving(true); setError(null);
    try {
      await settingsApi.update({
        tax_profiles: [
          { type: "jurisdictions", data: jurisdictions },
          { type: "exemptions", data: exemptions },
        ],
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.message || "Failed to save configuration");
    } finally { setSaving(false); }
  };

  if (loading) {
    return (
      <HRPage title="Tax Configuration" subtitle="Configure tax settings">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      </HRPage>
    );
  }

  return (
    <HRPage title="Tax Configuration" subtitle="Configure tax settings">

      <div className="flex items-center justify-between mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 flex-1">
          <div className="bg-white rounded-3xl border border-slate-200 p-4">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Jurisdictions</p>
            <p className="text-2xl font-bold text-slate-900 mt-1">{jurisdictions.length}</p>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200 p-4">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Tax Rules</p>
            <p className="text-2xl font-bold text-slate-900 mt-1">{jurisdictions.filter((j) => j.tax_rule !== "standard").length + (taxRates.length > 0 ? 1 : 0)}</p>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200 p-4">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Exemptions</p>
            <p className="text-2xl font-bold text-slate-900 mt-1">{exemptions.length}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 ml-4">
          {saved && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-emerald-700 bg-emerald-50 rounded-lg">
              <CheckCircle className="h-4 w-4" /> Saved
            </span>
          )}
          <button onClick={fetchData}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button onClick={handleSave} disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50">
            {saving ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" /> : <Save className="h-4 w-4" />}
            Save Changes
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="space-y-6">
        <div className="bg-white border border-slate-200 rounded-3xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-r from-brand to-brand-hover text-white flex items-center justify-center">
              <Globe size={20} />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-800">Tax Jurisdictions</h3>
              <p className="text-xs text-slate-500 mt-0.5">Manage tax jurisdictions and their default rules</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <input type="text" placeholder="Jurisdiction name" value={newJurisdiction.name}
              onChange={(e) => setNewJurisdiction((p) => ({ ...p, name: e.target.value }))}
              className="flex-1 min-w-[200px] px-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            <select value={newJurisdiction.type} onChange={(e) => setNewJurisdiction((p) => ({ ...p, type: e.target.value }))}
              className="px-4 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
              {JURISDICTION_TYPES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <select value={newJurisdiction.tax_rule} onChange={(e) => setNewJurisdiction((p) => ({ ...p, tax_rule: e.target.value }))}
              className="px-4 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
              {TAX_RULE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button onClick={addJurisdiction} disabled={!newJurisdiction.name}
              className="flex items-center gap-1 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50">
              <Plus size={16} /> Add
            </button>
          </div>

          {jurisdictions.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-4">No jurisdictions configured. Add one above.</p>
          ) : (
            <div className="space-y-2">
              {jurisdictions.map((j, i) => (
                <div key={j.id || i} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <Globe size={16} className="text-brand-500" />
                    <span className="text-sm font-medium text-slate-800">{j.name}</span>
                    <span className="text-xs text-slate-400 capitalize">({j.type})</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      j.tax_rule === "standard" ? "bg-blue-100 text-blue-700" :
                      j.tax_rule === "reduced" ? "bg-amber-100 text-amber-700" :
                      j.tax_rule === "zero" ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-600"
                    }`}>{j.tax_rule}</span>
                  </div>
                  <button onClick={() => removeJurisdiction(j.id)} className="p-1 text-slate-400 hover:text-red-600">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-3xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-r from-brand to-brand-hover text-white flex items-center justify-center">
              <Shield size={20} />
            </div>
            <div>
              <h3 className="text-base font-semibold text-slate-800">Tax Exemptions</h3>
              <p className="text-xs text-slate-500 mt-0.5">Define customer or product exemptions from certain taxes</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-4">
            <input type="text" placeholder="Exemption name" value={newExemption.name}
              onChange={(e) => setNewExemption((p) => ({ ...p, name: e.target.value }))}
              className="flex-1 min-w-[180px] px-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            <input type="text" placeholder="Description" value={newExemption.description}
              onChange={(e) => setNewExemption((p) => ({ ...p, description: e.target.value }))}
              className="flex-1 min-w-[180px] px-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            <select value={newExemption.tax_rate_id} onChange={(e) => setNewExemption((p) => ({ ...p, tax_rate_id: e.target.value }))}
              className="px-4 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
              <option value="">No specific rate</option>
              {taxRates.filter((r) => r.is_active !== false).map((r) => (
                <option key={r.id} value={r.id}>{r.name} ({parseFloat(r.rate || 0).toFixed(2)}%)</option>
              ))}
            </select>
            <button onClick={addExemption} disabled={!newExemption.name}
              className="flex items-center gap-1 px-4 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50">
              <Plus size={16} /> Add
            </button>
          </div>

          {exemptions.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-4">No exemptions configured. Add one above.</p>
          ) : (
            <div className="space-y-2">
              {exemptions.map((e, i) => (
                <div key={e.id || i} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <X size={16} className="text-amber-500" />
                    <span className="text-sm font-medium text-slate-800">{e.name}</span>
                    {e.description && <span className="text-xs text-slate-400">{e.description}</span>}
                    {e.tax_rate_id && (
                      <span className="text-xs text-brand-600 font-medium">
                        Rate: {taxRates.find((r) => String(r.id) === String(e.tax_rate_id))?.name || `#${e.tax_rate_id}`}
                      </span>
                    )}
                  </div>
                  <button onClick={() => removeExemption(e.id)} className="p-1 text-slate-400 hover:text-red-600">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </HRPage>
  );
}
