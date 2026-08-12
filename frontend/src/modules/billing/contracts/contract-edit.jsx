import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Save, Loader2, AlertCircle, Package, Plus, Trash2, Search, CheckCircle, FileText, Calendar, CreditCard, FileEdit, AlertTriangle } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { contractApi, productApi, pricingApi, settingsApi } from "../../../service/billingService";
import { formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { getCurrencySelectOptions } from "../../../utils/currency";

const BILLING_PERIODS = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "semi_annual", label: "Semi-Annually" },
  { value: "annual", label: "Annually" },
];

const INITIAL_ITEM = {
  id: Date.now(),
  line_number: 1,
  product_id: undefined,
  product_name: "",
  description: "",
  quantity: 1,
  unit_price: 0,
  discount_percentage: 0,
  tax_percentage: 0,
  is_tax_inclusive: false,
  pricing_plan_id: null,
  base_price: null,
  resolved_price: null,
  price_source: null,
  available_plans: null,
  needs_plan_selection: false,
};

export default function ContractEditPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    contract_name: "",
    contract_number: "",
    start_date: "",
    end_date: "",
    notice_period_days: 30,
    auto_renew: false,
    renewal_term_days: "",
    currency: "",
    billing_period: "monthly",
    billing_day: 1,
    notes: "",
    terms: "",
  });
  const [items, setItems] = useState([]);
  const [originalItems, setOriginalItems] = useState([]);
  const [contractStatus, setContractStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [productSearch, setProductSearch] = useState("");
  const [productResults, setProductResults] = useState([]);
  const [productSearching, setProductSearching] = useState(false);
  const [showAmendmentModal, setShowAmendmentModal] = useState(false);
  const [amendmentForm, setAmendmentForm] = useState({
    effective_date: new Date().toISOString().split("T")[0],
    reason: "",
  });
  const [pendingAmendmentData, setPendingAmendmentData] = useState(null);
  const [originalForm, setOriginalForm] = useState(null);
  const [defaultCurrency, setDefaultCurrency] = useState("");

  const fetchContract = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let currencyFallback = "";
      try {
        const settings = await settingsApi.get();
        if (settings?.default_currency) {
          currencyFallback = settings.default_currency;
          setDefaultCurrency(currencyFallback);
        }
      } catch { /* use empty fallback */ }

      const cData = await contractApi.get(id);
      setContractStatus(cData.status);
      const f = {
        contract_name: cData.contract_name || "",
        contract_number: cData.contract_number || "",
        start_date: cData.start_date || "",
        end_date: cData.end_date || "",
        notice_period_days: cData.notice_period_days || 30,
        auto_renew: cData.auto_renew || false,
        renewal_term_days: cData.renewal_term_days || "",
        currency: cData.currency || currencyFallback,
        billing_period: cData.billing_period || "monthly",
        billing_day: cData.billing_day || 1,
        notes: cData.notes || "",
        terms: cData.terms || "",
      };
      setForm(f);
      setOriginalForm(JSON.parse(JSON.stringify(f)));

      try {
        const itemsData = await contractApi.getItems(id);
        const arr = extractArray(itemsData).map((it, idx) => ({
          ...it,
          id: it.id || Date.now() + idx,
          line_number: it.line_number || idx + 1,
        }));
        setItems(arr);
        setOriginalItems(JSON.parse(JSON.stringify(arr)));
      } catch {
        setItems([]);
        setOriginalItems([]);
      }
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load contract");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchContract(); }, [fetchContract]);

  const totals = useMemo(() => {
    let subtotal = 0;
    let totalDiscount = 0;
    let totalTax = 0;
    items.forEach((item) => {
      const qty = parseFloat(item.quantity || 0);
      const price = parseFloat(item.unit_price || 0);
      const disc = parseFloat(item.discount_percentage || 0);
      const tax = parseFloat(item.tax_percentage || 0);
      const lineSubtotal = qty * price;
      const lineDiscount = lineSubtotal * (disc / 100);
      const lineNet = lineSubtotal - lineDiscount;
      const lineTax = lineNet * (tax / 100);
      subtotal += lineSubtotal;
      totalDiscount += lineDiscount;
      totalTax += lineTax;
    });
    return {
      subtotal,
      totalDiscount,
      totalTax,
      total: subtotal - totalDiscount + totalTax,
    };
  }, [items]);

  useEffect(() => {
    setForm((p) => ({ ...p, value: totals.total }));
  }, [totals.total]);

  const searchProducts = useCallback(async (term) => {
    if (!term.trim()) { setProductResults([]); return; }
    setProductSearching(true);
    try {
      const data = await productApi.list({ search: term, per_page: 10 });
      setProductResults(Array.isArray(data) ? data : data?.items || data?.data || []);
    } catch { setProductResults([]); }
    finally { setProductSearching(false); }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => searchProducts(productSearch), 300);
    return () => clearTimeout(timer);
  }, [productSearch, searchProducts]);

  const handleProductSelect = async (p) => {
    let plans = [];
    try {
      const planData = await pricingApi.listByProduct(p.id);
      plans = Array.isArray(planData) ? planData : planData?.items || [];
    } catch (planListErr) {
      /* Pricing plans lookup failed */
    }

    let itemUpdates = {
      product_id: p.id,
      product_name: p.name,
      description: p.description || p.name,
      tax_percentage: parseFloat(p.tax_percentage || 0),
      is_tax_inclusive: p.tax_inclusive || false,
    };

    if (plans.length === 1) {
      try {
        const resp = await pricingApi.resolvePrice({ product_id: p.id, pricing_plan_id: plans[0].id });
        itemUpdates.unit_price = parseFloat(resp.resolved_price ?? resp.unit_price ?? 0);
        itemUpdates.pricing_plan_id = resp.pricing_plan_id ?? plans[0].id;
        itemUpdates.base_price = resp.base_price ?? null;
        itemUpdates.resolved_price = resp.resolved_price ?? resp.unit_price ?? null;
        itemUpdates.price_source = resp.price_source ?? "pricing_plan";
        itemUpdates.available_plans = null;
        itemUpdates.needs_plan_selection = false;
      } catch {
        itemUpdates.unit_price = parseFloat(p.default_price || 0);
        itemUpdates.pricing_plan_id = plans[0].id;
        itemUpdates.base_price = parseFloat(p.default_price || 0);
        itemUpdates.resolved_price = parseFloat(plans[0].unit_price || 0);
        itemUpdates.price_source = "pricing_plan";
      }
    } else if (plans.length === 0) {
      try {
        const resp = await pricingApi.resolvePrice({ product_id: p.id });
        itemUpdates.unit_price = parseFloat(resp.resolved_price ?? resp.unit_price ?? p.default_price ?? 0);
        itemUpdates.pricing_plan_id = null;
        itemUpdates.base_price = resp.base_price ?? parseFloat(p.default_price || 0);
        itemUpdates.resolved_price = resp.resolved_price ?? resp.unit_price ?? null;
        itemUpdates.price_source = resp.price_source ?? "catalog";
      } catch {
        itemUpdates.unit_price = parseFloat(p.default_price || 0);
        itemUpdates.base_price = parseFloat(p.default_price || 0);
        itemUpdates.resolved_price = parseFloat(p.default_price || 0);
        itemUpdates.price_source = "catalog";
      }
      itemUpdates.available_plans = null;
      itemUpdates.needs_plan_selection = false;
    } else {
      itemUpdates.unit_price = 0;
      itemUpdates.pricing_plan_id = null;
      itemUpdates.base_price = parseFloat(p.default_price || 0);
      itemUpdates.resolved_price = null;
      itemUpdates.price_source = null;
      itemUpdates.available_plans = plans;
      itemUpdates.needs_plan_selection = true;
    }

    setItems((cur) => {
      const idx = cur.findIndex((i) => !i.product_id);
      if (idx >= 0) {
        return cur.map((i, i2) => i2 === idx ? { ...i, ...itemUpdates } : i);
      }
      return [...cur, {
        id: Date.now(),
        line_number: cur.length + 1,
        quantity: 1,
        discount_percentage: 0,
        ...itemUpdates,
      }];
    });
    setProductResults([]);
    setProductSearch("");
  };

  const handlePlanSelect = async (itemId, planId) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    const params = { product_id: item.product_id };
    if (planId) params.pricing_plan_id = planId;
    try {
      const resp = await pricingApi.resolvePrice(params);
      setItems((cur) =>
        cur.map((i) =>
          i.id === itemId
            ? {
                ...i,
                unit_price: parseFloat(resp.resolved_price ?? resp.unit_price ?? 0),
                pricing_plan_id: resp.pricing_plan_id ?? planId ?? null,
                base_price: resp.base_price ?? null,
                resolved_price: resp.resolved_price ?? resp.unit_price ?? null,
                price_source: resp.price_source ?? (planId ? "pricing_plan" : "catalog"),
                needs_plan_selection: false,
              }
            : i
        )
      );
    } catch (planChangeErr) {
      /* Plan change price resolution failed */
    }
  };

  const updateLineItem = (itemId, field, value) => {
    setItems((cur) =>
      cur.map((i) => (i.id === itemId ? { ...i, [field]: value } : i))
    );
  };

  const removeLineItem = (itemId) => {
    setItems((cur) => {
      const filtered = cur.filter((i) => i.id !== itemId);
      return filtered.map((i, idx) => ({ ...i, line_number: idx + 1 }));
    });
  };

  const addLineItem = () => {
    setItems((cur) => [
      ...cur,
      { ...INITIAL_ITEM, id: Date.now(), line_number: cur.length + 1 },
    ]);
  };

  const buildPayload = () => ({
    contract_name: form.contract_name,
    start_date: form.start_date,
    end_date: form.end_date || undefined,
    notice_period_days: parseInt(form.notice_period_days || 30),
    auto_renew: form.auto_renew,
    renewal_term_days: form.renewal_term_days ? parseInt(form.renewal_term_days) : undefined,
    value: parseFloat(form.value || 0),
    currency: form.currency,
    billing_period: form.billing_period,
    billing_day: parseInt(form.billing_day || 1),
    notes: form.notes || undefined,
    terms: form.terms || undefined,
  });

  const buildItemsPayload = () =>
    items
      .filter((i) => i.description && i.quantity && i.unit_price)
      .map((i, idx) => ({
        product_id: i.product_id ? Number(i.product_id) : undefined,
        description: i.description,
        quantity: parseFloat(i.quantity || 1),
        unit_price: parseFloat(i.unit_price || 0),
        discount_percentage: parseFloat(i.discount_percentage || 0),
        tax_percentage: parseFloat(i.tax_percentage || 0),
        is_tax_inclusive: i.is_tax_inclusive || false,
        pricing_plan_id: i.pricing_plan_id || undefined,
        base_price: i.base_price != null ? parseFloat(i.base_price) : undefined,
        resolved_price: i.resolved_price != null ? parseFloat(i.resolved_price) : undefined,
        price_source: i.price_source || undefined,
      }));

  const detectMaterialChanges = () => {
    if (!originalForm) return { hasChanges: false, changedFields: [], previousValues: {}, newValues: {} };
    const changedFields = [];
    const previousValues = {};
    const newValues = {};
    const materialFields = [
      "contract_name", "start_date", "end_date", "notice_period_days",
      "auto_renew", "renewal_term_days", "currency", "billing_period",
      "billing_day", "notes", "terms",
    ];
    for (const field of materialFields) {
      const ov = String(originalForm[field] ?? "");
      const nv = String(form[field] ?? "");
      if (ov !== nv) {
        changedFields.push(field);
        previousValues[field] = originalForm[field];
        newValues[field] = form[field];
      }
    }
    const origStr = JSON.stringify(originalItems.map(({ id, ...rest }) => rest));
    const curStr = JSON.stringify(items.map(({ id, ...rest }) => rest));
    if (origStr !== curStr) {
      changedFields.push("items");
    }
    return { hasChanges: changedFields.length > 0, changedFields, previousValues, newValues };
  };

  const performSave = async () => {
    await contractApi.update(id, buildPayload());
    const itemsPayload = buildItemsPayload();
    if (itemsPayload.length > 0) {
      await contractApi.setItems(id, { items: itemsPayload });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      if (contractStatus === "active") {
        const changes = detectMaterialChanges();
        if (changes.hasChanges) {
          setPendingAmendmentData(changes);
          setShowAmendmentModal(true);
          setSaving(false);
          return;
        }
      }
      await performSave();
      setSuccess("Contract updated successfully");
      setTimeout(() => navigate(`/billing/contracts/${id}`), 1200);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to update contract");
    } finally {
      setSaving(false);
    }
  };

  const handleAmendmentSave = async () => {
    if (!amendmentForm.effective_date || !pendingAmendmentData) return;
    setSaving(true);
    setError(null);
    try {
      await contractApi.createAmendment(id, {
        amendment_date: new Date().toISOString().split("T")[0],
        effective_date: amendmentForm.effective_date,
        reason: amendmentForm.reason || "Contract edited",
        previous_values: pendingAmendmentData.previousValues,
        new_values: pendingAmendmentData.newValues,
      });
      await performSave();
      setShowAmendmentModal(false);
      setAmendmentForm({ effective_date: new Date().toISOString().split("T")[0], reason: "" });
      setPendingAmendmentData(null);
      setSuccess("Contract updated with amendment recorded");
      setTimeout(() => navigate(`/billing/contracts/${id}`), 1200);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to create amendment");
    } finally {
      setSaving(false);
    }
  };

  const currencyOptions = useMemo(() => getCurrencySelectOptions(), []);

  const inputClass = "w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand-300";
  const labelClass = "block text-sm font-medium text-slate-700 mb-1";

  if (loading) {
    return (
      <HRPage title="Edit Contract" subtitle="Loading...">
        <div className="flex items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin text-brand-600" />
        </div>
      </HRPage>
    );
  }

  return (
    <HRPage
      title={`Edit ${form.contract_name || form.contract_number || "Contract"}`}
      subtitle={<span className="text-slate-400">ID: {id}</span>}
      actions={
        <button onClick={() => navigate(`/billing/contracts/${id}`)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
      }
    >
      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}
      {success && (
        <div className="mb-6 p-4 rounded-lg bg-green-50 border border-green-200 text-sm text-green-700 flex items-center gap-2">
          <CheckCircle className="h-4 w-4 flex-shrink-0" /> {success}
        </div>
      )}

      <div className="space-y-8">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><FileText size={16} className="text-brand-500" /> Contract Details</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className={labelClass}>Contract Name</label>
              <input type="text" value={form.contract_name} onChange={(e) => setForm((p) => ({ ...p, contract_name: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Contract Number</label>
              <input type="text" value={form.contract_number} disabled className={`${inputClass} bg-slate-50 text-slate-500`} />
            </div>
            <div>
              <label className={labelClass}>Currency</label>
              <select value={form.currency} onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))} className={inputClass}>
                {currencyOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><Calendar size={16} className="text-brand-500" /> Dates & Schedule</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className={labelClass}>Start Date</label>
              <input type="date" value={form.start_date} onChange={(e) => setForm((p) => ({ ...p, start_date: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>End Date</label>
              <input type="date" value={form.end_date} onChange={(e) => setForm((p) => ({ ...p, end_date: e.target.value }))} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Notice Period (days)</label>
              <input type="number" value={form.notice_period_days} onChange={(e) => setForm((p) => ({ ...p, notice_period_days: e.target.value }))} className={inputClass} min="0" />
            </div>
            <div>
              <label className={labelClass}>Billing Period</label>
              <select value={form.billing_period} onChange={(e) => setForm((p) => ({ ...p, billing_period: e.target.value }))} className={inputClass}>
                {BILLING_PERIODS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
            <div>
              <label className={labelClass}>Billing Day</label>
              <input type="number" value={form.billing_day} onChange={(e) => setForm((p) => ({ ...p, billing_day: e.target.value }))} className={inputClass} min="1" max="31" />
            </div>
            <div className="flex items-center gap-3 pt-6">
              <input type="checkbox" id="auto_renew" checked={form.auto_renew} onChange={(e) => setForm((p) => ({ ...p, auto_renew: e.target.checked }))} className="h-4 w-4 text-brand-600 border-gray-300 rounded" />
              <label htmlFor="auto_renew" className="text-sm text-slate-700">Auto-renew</label>
            </div>
            {form.auto_renew && (
              <div>
                <label className={labelClass}>Renewal Term (days)</label>
                <input type="number" value={form.renewal_term_days} onChange={(e) => setForm((p) => ({ ...p, renewal_term_days: e.target.value }))} className={inputClass} min="1" placeholder="365" />
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><Package size={16} className="text-brand-500" /> Products ({items.length})</h3>
            <button onClick={addLineItem} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
              <Plus size={12} /> Add Item
            </button>
          </div>

          <div className="relative mb-4">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input type="text" placeholder="Search products to add..." value={productSearch} onChange={(e) => setProductSearch(e.target.value)} className={`${inputClass} pl-9`} />
            {productSearching && <div className="absolute right-3 top-1/2 -translate-y-1/2"><Loader2 size={16} className="animate-spin text-brand-500" /></div>}
            {productResults.length > 0 && (
              <div className="absolute z-20 mt-1 w-full border border-slate-200 rounded-xl bg-white shadow-lg max-h-48 overflow-y-auto">
                {productResults.map((p) => (
                  <button key={p.id} onClick={() => handleProductSelect(p)} className="w-full p-3 hover:bg-slate-50 border-b border-slate-100 last:border-b-0 text-left transition-colors">
                    <div className="font-medium text-sm text-slate-800">{p.name}</div>
                    <div className="text-xs text-slate-500">{formatDisplayCurrency(p.default_price, form.currency)}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {items.length === 0 ? (
            <div className="text-center py-8 text-slate-400">
              <Package size={32} className="mx-auto mb-2 text-slate-300" />
              <p className="text-sm">No products. Search above to add.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead>
                  <tr className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                    <th className="text-left py-3 px-3 w-12">#</th>
                    <th className="text-left py-3 px-3">Description</th>
                    <th className="text-right py-3 px-3 w-20">Qty</th>
                    <th className="text-right py-3 px-3 w-28">Unit Price</th>
                    <th className="text-right py-3 px-3 w-20">Disc %</th>
                    <th className="text-right py-3 px-3 w-20">Tax %</th>
                    <th className="text-right py-3 px-3 w-28">Total</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((item) => {
                    const qty = parseFloat(item.quantity || 0);
                    const price = parseFloat(item.unit_price || 0);
                    const disc = parseFloat(item.discount_percentage || 0);
                    const tax = parseFloat(item.tax_percentage || 0);
                    const lineTotal = qty * price * (1 - disc / 100) * (1 + tax / 100);
                    return (
                      <React.Fragment key={item.id}>
                      <tr className="text-sm text-gray-900 hover:bg-slate-50">
                        <td className="py-2 px-3 text-gray-400">{item.line_number}</td>
                        <td className="py-2 px-3">
                          <input type="text" value={item.description} onChange={(e) => updateLineItem(item.id, "description", e.target.value)} className="w-full px-2 py-1 border border-slate-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-brand/30" />
                        </td>
                        <td className="py-2 px-3">
                          <input type="number" value={item.quantity} onChange={(e) => updateLineItem(item.id, "quantity", e.target.value)} className="w-full px-2 py-1 border border-slate-200 rounded text-sm text-right focus:outline-none focus:ring-1 focus:ring-brand/30" min="0" step="0.01" />
                        </td>
                        <td className="py-2 px-3">
                          <input type="number" value={item.unit_price} onChange={(e) => updateLineItem(item.id, "unit_price", e.target.value)} className="w-full px-2 py-1 border border-slate-200 rounded text-sm text-right focus:outline-none focus:ring-1 focus:ring-brand/30" min="0" step="0.01" />
                        </td>
                        <td className="py-2 px-3">
                          <input type="number" value={item.discount_percentage} onChange={(e) => updateLineItem(item.id, "discount_percentage", e.target.value)} className="w-full px-2 py-1 border border-slate-200 rounded text-sm text-right focus:outline-none focus:ring-1 focus:ring-brand/30" min="0" max="100" step="0.01" />
                        </td>
                        <td className="py-2 px-3">
                          <input type="number" value={item.tax_percentage} onChange={(e) => updateLineItem(item.id, "tax_percentage", e.target.value)} className="w-full px-2 py-1 border border-slate-200 rounded text-sm text-right focus:outline-none focus:ring-1 focus:ring-brand/30" min="0" max="100" step="0.01" />
                        </td>
                        <td className="py-2 px-3 text-right font-medium">{formatDisplayCurrency(lineTotal, form.currency)}</td>
                        <td className="py-2 px-1">
                          <button onClick={() => removeLineItem(item.id)} className="p-1 text-red-400 hover:text-red-600 transition-colors" aria-label="Remove line item">
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                      {item.needs_plan_selection && item.available_plans && (
                        <tr>
                          <td colSpan={8} className="py-2 px-3 bg-brand-50">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-medium text-brand-700 mr-1">Select Plan:</span>
                              <button onClick={() => handlePlanSelect(item.id, null)}
                                className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                                  item.price_source === "catalog"
                                    ? "bg-brand-600 text-white border-brand-600"
                                    : "bg-white text-brand-700 border-brand-200 hover:bg-brand-100"
                                }`}>
                                Catalog Price
                              </button>
                              {item.available_plans.map((plan) => (
                                <button key={plan.id} onClick={() => handlePlanSelect(item.id, plan.id)}
                                  className={`px-3 py-1 text-xs rounded-full border transition-colors ${
                                    item.pricing_plan_id === plan.id
                                      ? "bg-brand-600 text-white border-brand-600"
                                      : "bg-white text-brand-700 border-brand-200 hover:bg-brand-100"
                                  }`}>
                                  {plan.name || plan.plan_name || `Plan ${plan.id}`}
                                </button>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><CreditCard size={16} className="text-brand-500" /> Pricing Summary</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-slate-50 rounded-xl p-4 text-center">
              <p className="text-xs text-slate-500 uppercase tracking-wider">Subtotal</p>
              <p className="text-lg font-bold text-slate-800 mt-1">{formatDisplayCurrency(totals.subtotal, form.currency)}</p>
            </div>
            <div className="bg-slate-50 rounded-xl p-4 text-center">
              <p className="text-xs text-slate-500 uppercase tracking-wider">Discount</p>
              <p className="text-lg font-bold text-red-500 mt-1">-{formatDisplayCurrency(totals.totalDiscount, form.currency)}</p>
            </div>
            <div className="bg-slate-50 rounded-xl p-4 text-center">
              <p className="text-xs text-slate-500 uppercase tracking-wider">Tax</p>
              <p className="text-lg font-bold text-slate-800 mt-1">+{formatDisplayCurrency(totals.totalTax, form.currency)}</p>
            </div>
            <div className="bg-brand-50 rounded-xl p-4 text-center border border-brand-200">
              <p className="text-xs text-brand-600 uppercase tracking-wider font-medium">Total</p>
              <p className="text-xl font-bold text-brand-700 mt-1">{formatDisplayCurrency(totals.total, form.currency)}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Notes & Terms</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Notes</label>
              <textarea value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} className={`${inputClass} h-24 resize-none`} placeholder="Internal notes..." />
            </div>
            <div>
              <label className={labelClass}>Terms & Conditions</label>
              <textarea value={form.terms} onChange={(e) => setForm((p) => ({ ...p, terms: e.target.value }))} className={`${inputClass} h-24 resize-none`} placeholder="Terms and conditions..." />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pb-8">
          <button onClick={() => navigate(`/billing/contracts/${id}`)} className="px-6 py-2.5 border border-slate-300 rounded-xl text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving} className="px-6 py-2.5 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors inline-flex items-center gap-2">
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Save Changes
          </button>
        </div>
      </div>

      {showAmendmentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setShowAmendmentModal(false); setPendingAmendmentData(null); }}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle size={20} className="text-amber-500" />
              <h3 className="text-lg font-semibold text-gray-900">Active Contract Requires Amendment</h3>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              This contract is <strong>ACTIVE</strong>. Material changes require an amendment record.
              Provide a reason and effective date to create an amendment.
            </p>
            {pendingAmendmentData && pendingAmendmentData.changedFields.length > 0 && (
              <div className="mb-4 p-3 bg-slate-50 rounded-lg">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Changed Fields</p>
                <div className="flex flex-wrap gap-1">
                  {pendingAmendmentData.changedFields.map((f) => (
                    <span key={f} className="px-2 py-0.5 bg-brand-50 text-brand-700 text-xs rounded-full capitalize">{f}</span>
                  ))}
                </div>
              </div>
            )}
            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Effective Date</label>
                <input type="date" value={amendmentForm.effective_date}
                  onChange={(e) => setAmendmentForm((f) => ({ ...f, effective_date: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Amendment Reason</label>
                <textarea value={amendmentForm.reason} onChange={(e) => setAmendmentForm((f) => ({ ...f, reason: e.target.value }))}
                  rows={3} placeholder="Reason for changes..."
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => { setShowAmendmentModal(false); setPendingAmendmentData(null); }}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
              <button onClick={handleAmendmentSave} disabled={!amendmentForm.effective_date || saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileEdit className="h-4 w-4" />} Save with Amendment
              </button>
            </div>
          </div>
        </div>
      )}
    </HRPage>
  );
}
