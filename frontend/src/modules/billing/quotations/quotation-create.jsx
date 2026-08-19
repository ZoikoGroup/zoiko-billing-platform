import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { User, Package, FileText, Calculator, Eye, Send,
  ChevronRight, ChevronLeft, Plus, Trash2, X, CheckCircle, Loader2, Search, AlertCircle, Percent } from "lucide-react"
import {
  quoteApi, customerApi, productApi, pricingApi, settingsApi
} from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate } from "../../../utils/billing-helpers";
import { getCurrencySelectOptions } from "../../../utils/currency";
import { CalculationEngine } from "../utils/calculation-engine";
import { useTerminology } from "../utils/TerminologyContext";
import { ProductSelector, BulkProductPickerModal } from "../../../components/billing-shared";

const STEPS = [
  { id: 1, label: "Customer", icon: User, description: "Select customer & addresses" },
  { id: 2, label: "Details", icon: FileText, description: "Subject, currency, dates, validity" },
  { id: 3, label: "Items", icon: Package, description: "Products, quantities, pricing" },
  { id: 4, label: "Pricing", icon: Calculator, description: "Review totals & discounts" },
  { id: 5, label: "Preview", icon: Eye, description: "Review complete quotation" },
  { id: 6, label: "Actions", icon: Send, description: "Save draft or send" },
];

const INITIAL_FORM = {
  customer_id: "",
  customer_name: "",
  customer_email: "",
  customer_phone: "",
  billing_address: "",
  shipping_address: "",
  quote_number: "",
  subject: "",
  valid_until: "",
  currency: "",
  discount_percentage: 0,
  notes: "",
  terms: "",
};

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
  pricing_currency: null,
  pricing_model: null,
  tier_info: null,
  available_plans: null,
  needs_plan_selection: false,
  original_currency: null,
  original_amount: null,
  exchange_rate: null,
  quote_currency: null,
  converted_amount: null,
};

export default function QuotationCreateWizardPage({ onClose, onCreated }) {
  const navigate = useNavigate();
  const { singular } = useTerminology();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(INITIAL_FORM);
  const [items, setItems] = useState([INITIAL_ITEM]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [customerSearching, setCustomerSearching] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [productResults, setProductResults] = useState([]);
  const [productSearching, setProductSearching] = useState(false);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [addingProducts, setAddingProducts] = useState(false);
  const [productAddWarning, setProductAddWarning] = useState(null);
  const [showBulkPicker, setShowBulkPicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [orgSettings, setOrgSettings] = useState({ quote_prefix: "QT-" });
  const exchangeRateCache = useRef(new Map());

  useEffect(() => {
    loadOrgSettings();
    if (!form.quote_number) {
      const ts = Date.now().toString(36).toUpperCase();
      setForm((p) => ({ ...p, quote_number: `${orgSettings.quote_prefix || "QT-"}${ts}` }));
    }
    if (!form.valid_until) {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      setForm((p) => ({ ...p, valid_until: d.toISOString().split("T")[0] }));
    }
  }, []);

  const loadOrgSettings = async () => {
    try {
      const data = await settingsApi.get();
      setOrgSettings(data);
      const orgCurrency = data?.base_currency || data?.default_currency;
      if (orgCurrency) {
        setForm((p) => ({ ...p, currency: p.currency || orgCurrency }));
      }
      if (!form.quote_number) {
        const ts = Date.now().toString(36).toUpperCase();
        setForm((p) => ({ ...p, quote_number: `${data.quote_prefix || "QT-"}${ts}` }));
      }
    } catch (err) { console.error("[QuoteCreate] Failed to init form:", err); }
  };

  const searchCustomers = useCallback(async (term) => {
    if (!term.trim()) { setCustomerResults([]); return; }
    setCustomerSearching(true);
    try {
      const data = await customerApi.search(term, 10);
      setCustomerResults(Array.isArray(data) ? data : data?.items || data?.data || []);
    } catch (err) { console.error("[QuoteCreate] Customer search failed:", err); setCustomerResults([]); }
    finally { setCustomerSearching(false); }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => searchCustomers(customerSearch), 300);
    return () => clearTimeout(timer);
  }, [customerSearch, searchCustomers]);

  const handleCustomerSelect = async (c) => {
    const full = await customerApi.get(c.id);
    setForm((p) => ({
      ...p,
      customer_id: full.id,
      customer_name: full.display_name || full.company_name,
      customer_email: full.email || "",
      customer_phone: full.phone || "",
      billing_address: full.billing_address || "",
      shipping_address: full.shipping_address || "",
      currency: full.currency || orgSettings?.base_currency || orgSettings?.default_currency || p.currency,
    }));
    setCustomerResults([]);
    setCustomerSearch("");
  };

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

  const resolveCurrencyConversion = async (productCurrency, rawPrice) => {
    if (!productCurrency || !form.currency) return {};
    const pc = productCurrency.toUpperCase();
    const fc = form.currency.toUpperCase();
    if (pc === fc) return {};
    const cacheKey = `${pc}:${fc}`;
    const cached = exchangeRateCache.current.get(cacheKey);
    if (cached) {
      const converted = Math.round(rawPrice * cached * 100) / 100;
      return {
        original_currency: pc,
        original_amount: rawPrice,
        exchange_rate: cached,
        quote_currency: fc,
        converted_amount: converted,
        unit_price: converted,
      };
    }
    try {
      const rateData = await settingsApi.getExchangeRatePair(pc, fc);
      const rate = rateData && Number(rateData.rate) > 0 ? Number(rateData.rate) : null;
      if (rate) {
        exchangeRateCache.current.set(cacheKey, rate);
        const converted = Math.round(rawPrice * rate * 100) / 100;
        return {
          original_currency: pc,
          original_amount: rawPrice,
          exchange_rate: rate,
          quote_currency: fc,
          converted_amount: converted,
          unit_price: converted,
        };
      }
    } catch (err) { console.error("[QuoteCreate] Price conversion failed:", err); }
    return {};
  };

  const buildItemBase = (p, resolved, active) => ({
    product_id: p.id, product_name: p.name, product_type: p.product_type || "service",
    description: p.description || p.name,
    unit_price: resolved.resolved_price ?? 0,
    discount_percentage: parseFloat(p.default_discount || 0),
    tax_percentage: parseFloat(p.tax_percentage || 0),
    is_tax_inclusive: p.tax_inclusive || false,
    pricing_plan_id: resolved.pricing_plan_id,
    base_price: resolved.base_price,
    resolved_price: resolved.resolved_price,
    price_source: resolved.price_source,
    pricing_currency: resolved.currency || p.currency || null,
    pricing_model: resolved.pricing_model || null,
    tier_info: resolved.tier_info || null,
    billing_period: p.billing_period || p.billing_frequency || "monthly",
    included_hours: p.included_hours || "",
    overage_rate: p.overage_rate || "",
  });

  const handleProductSelect = async (p) => {
    try {
      const plans = await pricingApi.listByProduct(p.id);
      const active = Array.isArray(plans) ? plans : plans?.items || [];
      if (active.length > 1) {
        setItems((cur) => {
          const idx = cur.findIndex((i) => !i.product_id);
          if (idx >= 0) return cur.map((i, i2) => i2 === idx ? {
            ...i, product_id: p.id, product_name: p.name, product_type: p.product_type || "service",
            description: p.description || p.name, unit_price: 0,
            tax_percentage: parseFloat(p.tax_percentage || 0), is_tax_inclusive: p.tax_inclusive || false,
            pricing_plan_id: null, base_price: parseFloat(p.default_price || 0),
            resolved_price: null, price_source: null, pricing_currency: p.currency || null,
            pricing_model: null, tier_info: null, available_plans: active, needs_plan_selection: true,
            billing_period: p.billing_period || p.billing_frequency || "monthly",
            included_hours: p.included_hours || "", overage_rate: p.overage_rate || "",
          } : i);
          return cur;
        });
      } else {
        const resolved = active.length === 1
          ? await pricingApi.resolvePrice({ product_id: p.id, pricing_plan_id: active[0].id, quantity: 1 })
          : await pricingApi.resolvePrice({ product_id: p.id, quantity: 1 });
        const rawPrice = Number(resolved.resolved_price || 0);
        const productCurrency = resolved.currency || p.currency || form.currency;
        const conv = await resolveCurrencyConversion(productCurrency, rawPrice);
        const base = buildItemBase(p, resolved, active);
        const itemData = { ...base, ...conv };
        setItems((cur) => {
          const idx = cur.findIndex((i) => !i.product_id);
          if (idx >= 0) return cur.map((i, i2) => i2 === idx ? { ...i, ...itemData } : i);
          return cur;
        });
      }
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to resolve pricing");
    }
    setProductResults([]);
    setProductSearch("");
  };

  // Resolves pricing for one product without touching component state — used by the
  // bulk "Add Selected" flow so each selected product becomes its own new line item
  // (mirrors the pricing branches in handleProductSelect, kept separate so the
  // existing single-select path above is never at risk of regressing).
  const resolveProductPricing = async (p, quantity = 1) => {
    const plans = await pricingApi.listByProduct(p.id);
    const active = Array.isArray(plans) ? plans : plans?.items || [];
    const shared = {
      product_id: p.id, product_name: p.name, product_type: p.product_type || "service",
      description: p.description || p.name,
      quantity,
      tax_percentage: parseFloat(p.tax_percentage || 0),
      is_tax_inclusive: p.tax_inclusive || false,
      billing_period: p.billing_period || p.billing_frequency || "monthly",
      included_hours: p.included_hours || "",
      overage_rate: p.overage_rate || "",
    };
    if (active.length > 1) {
      return {
        ...shared,
        unit_price: 0,
        pricing_plan_id: null,
        base_price: parseFloat(p.default_price || 0),
        resolved_price: null,
        price_source: null,
        pricing_currency: p.currency || null,
        pricing_model: null,
        tier_info: null,
        available_plans: active,
        needs_plan_selection: true,
      };
    }
    const planId = active.length === 1 ? active[0].id : undefined;
    // Quantity is forwarded to resolvePrice (not hardcoded) since tiered/volume
    // pricing plans resolve a different unit rate depending on the quantity —
    // reuses the same PriceResolver-backed endpoint Quick Add already uses.
    const resolved = await pricingApi.resolvePrice(
      planId ? { product_id: p.id, pricing_plan_id: planId, quantity } : { product_id: p.id, quantity }
    );
    const rawPrice = Number(resolved.resolved_price || 0);
    const productCurrency = resolved.currency || p.currency || form.currency;
    const conv = await resolveCurrencyConversion(productCurrency, rawPrice);
    return {
      ...shared,
      unit_price: conv.unit_price ?? rawPrice,
      discount_percentage: parseFloat(p.default_discount || 0),
      pricing_plan_id: resolved.pricing_plan_id,
      base_price: resolved.base_price,
      resolved_price: resolved.resolved_price,
      price_source: resolved.price_source,
      pricing_currency: resolved.currency || p.currency || null,
      pricing_model: resolved.pricing_model || null,
      tier_info: resolved.tier_info || null,
      ...conv,
    };
  };

  const handleAddSelectedProducts = async () => {
    if (selectedProducts.length === 0 || addingProducts) return;
    setAddingProducts(true);
    setProductAddWarning(null);
    const idBase = Date.now();
    const results = await Promise.all(selectedProducts.map(async (product, i) => {
      try {
        const data = await resolveProductPricing(product);
        return { item: { ...INITIAL_ITEM, ...data, id: idBase + i + 1 } };
      } catch (err) {
        const reason = err?.detail || err?.message || "Could not resolve pricing";
        return { failed: product, reason };
      }
    }));
    const newItems = results.filter((r) => r.item).map((r) => r.item);
    const failed = results.filter((r) => r.failed);
    if (newItems.length > 0) {
      setItems((cur) => {
        // Drop untouched empty placeholder rows so the phantom "default line"
        // never rides along with a bulk add.
        const kept = cur.filter((i) => i.product_id || (i.description && i.description.trim()));
        return [...kept, ...newItems].map((item, idx) => ({ ...item, line_number: idx + 1 }));
      });
    }
    // Keep failed products selected so the user can retry without re-searching.
    setSelectedProducts(failed.map((f) => f.failed));
    if (failed.length > 0) {
      setProductAddWarning(`Could not add ${failed.length} product${failed.length > 1 ? "s" : ""}: ${failed.map((f) => `${f.failed.name || `Product #${f.failed.id}`} (${f.reason})`).join(", ")}`);
    }
    setAddingProducts(false);
  };

  // Workflow B — Enterprise Bulk Product Selection. Same resolveProductPricing
  // used by Quick Add's own bulk-select path above; the only difference is each
  // product here carries the quantity the user chose in the picker before adding.
  const handleBulkPickerAdd = async (itemsWithQuantity) => {
    if (itemsWithQuantity.length === 0) return;
    setAddingProducts(true);
    setProductAddWarning(null);
    const idBase = Date.now();
    const results = await Promise.all(itemsWithQuantity.map(async (product, i) => {
      try {
        const data = await resolveProductPricing(product, Number(product.quantity) || 1);
        return { item: { ...INITIAL_ITEM, ...data, id: idBase + i + 1 } };
      } catch (err) {
        const reason = err?.detail || err?.message || "Could not resolve pricing";
        return { failed: product, reason };
      }
    }));
    const newItems = results.filter((r) => r.item).map((r) => r.item);
    const failed = results.filter((r) => r.failed);
    if (newItems.length > 0) {
      setItems((cur) => {
        const kept = cur.filter((i) => i.product_id || (i.description && i.description.trim()));
        return [...kept, ...newItems].map((item, idx) => ({ ...item, line_number: idx + 1 }));
      });
    }
    if (failed.length > 0) {
      setProductAddWarning(`Could not add ${failed.length} product${failed.length > 1 ? "s" : ""}: ${failed.map((f) => `${f.failed.name || `Product #${f.failed.id}`} (${f.reason})`).join(", ")}`);
    }
    setAddingProducts(false);
  };

  const handlePlanSelect = async (itemId, productId, planId, quantity) => {
    try {
      const params = planId
        ? { product_id: productId, pricing_plan_id: planId, quantity: quantity || 1 }
        : { product_id: productId, quantity: quantity || 1 };
      const resolved = await pricingApi.resolvePrice(params);
      const rawPrice = Number(resolved.resolved_price || 0);
      const productCurrency = resolved.currency || form.currency;
      const conv = await resolveCurrencyConversion(productCurrency, rawPrice);
      setItems((cur) => cur.map((i) => i.id === itemId ? {
        ...i,
        unit_price: conv.unit_price ?? rawPrice,
        pricing_plan_id: resolved.pricing_plan_id,
        base_price: resolved.base_price,
        resolved_price: resolved.resolved_price,
        price_source: resolved.price_source,
        pricing_currency: resolved.currency || i.pricing_currency,
        pricing_model: resolved.pricing_model || null,
        tier_info: resolved.tier_info || null,
        needs_plan_selection: false,
        ...conv,
      } : i));
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to resolve price");
    }
  };

  const addLineItem = () => {
    setItems((cur) => [...cur, { ...INITIAL_ITEM, id: Date.now(), line_number: cur.length + 1 }]);
  };

  const updateLineItem = (itemId, field, value) => {
    setItems((cur) => {
      const updated = cur.map((i) => i.id === itemId
        ? { ...i, [field]: value, ...(field === "unit_price" && i.product_id ? { price_source: "negotiated" } : {}) }
        : i);
      const item = updated.find((i) => i.id === itemId);
      if (item && field === "quantity" && item.pricing_plan_id && item.pricing_model &&
          ["tiered", "volume", "graduated"].includes(item.pricing_model)) {
        const qty = parseFloat(value || 1);
        pricingApi.resolvePrice({
          product_id: item.product_id,
          pricing_plan_id: item.pricing_plan_id,
          quantity: qty,
        }).then((resolved) => {
          setItems((cur2) => cur2.map((i) => i.id === itemId ? {
            ...i,
            unit_price: resolved.resolved_price,
            resolved_price: resolved.resolved_price,
            tier_info: resolved.tier_info || i.tier_info,
          } : i));
        }).catch((err) => console.error("[QuoteCreate] Failed to resolve price:", err));
      }
      return updated;
    });
  };

  const removeLineItem = (itemId) => {
    if (items.length <= 1) return;
    setItems((cur) => cur.filter((i) => i.id !== itemId).map((i, idx) => ({ ...i, line_number: idx + 1 })));
  };

  // Delegates to the shared CalculationEngine (same engine the invoice wizard
  // uses) so line-item math — including tax-inclusive pricing — always matches
  // the backend, instead of a separately-maintained local reimplementation.
  const calcItem = (item) => {
    const r = CalculationEngine.calculateLineItem(
      item.quantity || 1,
      item.unit_price || 0,
      item.discount_percentage || 0,
      0,
      item.tax_percentage || 0,
      1.0,
      item.is_tax_inclusive || false,
    );
    return {
      lineTotal: r.originalSubtotal,
      discAmt: r.originalDiscount,
      afterDisc: r.originalTaxableAmount,
      taxAmt: r.originalTaxAmount,
      total: r.originalLineTotal,
    };
  };

  const totals = useMemo(() => {
    const subtotal = items.reduce((s, i) => s + parseFloat(i.quantity || 1) * parseFloat(i.unit_price || 0), 0);
    const itemDisc = items.reduce((s, i) => s + calcItem(i).discAmt, 0);
    const quoteDiscPct = parseFloat(form.discount_percentage || 0);
    const quoteDisc = subtotal * quoteDiscPct / 100;
    const totalDisc = itemDisc + quoteDisc;
    const afterDisc = subtotal - totalDisc;
    const itemTax = items.reduce((s, i) => s + calcItem(i).taxAmt, 0);
    return { subtotal, itemDisc, quoteDisc, totalDisc, afterDisc, itemTax, total: afterDisc + itemTax };
  }, [items, form.discount_percentage]);

  const validateStep = (s) => {
    if (s === 1 && !form.customer_id) { setError("Please select a customer"); return false; }
    if (s === 2 && !form.quote_number) { setError("Quote number is required"); return false; }
    if (s === 3 && items.length === 0) { setError("Add at least one line item"); return false; }
    if (s === 3 && items.some((i) => !i.description || !i.quantity || !i.unit_price)) {
      setError("All items need description, quantity, and unit price");
      return false;
    }
    return true;
  };

  const handleNext = () => {
    if (validateStep(step)) { setError(null); setStep((s) => Math.min(s + 1, STEPS.length)); }
  };

  const handlePrev = () => setStep((s) => Math.max(s - 1, 1));

  const buildPayload = () => ({
    customer_id: Number(form.customer_id),
    quote_number: form.quote_number,
    subject: form.subject || undefined,
    valid_until: form.valid_until || undefined,
    currency: form.currency,
    discount_percentage: parseFloat(form.discount_percentage || 0),
    notes: form.notes || undefined,
    terms: form.terms || undefined,
  });

  const buildItemsPayload = () => items
    .filter((i) => i.description && i.quantity && i.unit_price)
    .map((i, idx) => ({
      line_number: idx + 1,
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
      original_currency: i.original_currency || undefined,
      original_amount: i.original_amount != null ? parseFloat(i.original_amount) : undefined,
      exchange_rate: i.exchange_rate != null ? parseFloat(i.exchange_rate) : undefined,
      quote_currency: i.quote_currency || undefined,
      converted_amount: i.converted_amount != null ? parseFloat(i.converted_amount) : undefined,
    }));

  const submit = async (sendAfter = false) => {
    setLoading(true); setError(null);
    try {
      const quote = await quoteApi.create(buildPayload());
      const itemPayload = buildItemsPayload();
      if (itemPayload.length > 0) {
        await quoteApi.addItems(quote.id, itemPayload);
      }
      await quoteApi.recalculate(quote.id);
      if (sendAfter) {
        await quoteApi.send(quote.id);
      }
      onCreated?.(quote);
      onClose?.();
      navigate(`/billing/quotations/${quote.id}`);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to create quotation");
    } finally { setLoading(false); }
  };

  const renderStep = () => {
    switch (step) {
      case 1: return renderCustomerStep();
      case 2: return renderDetailsStep();
      case 3: return renderItemsStep();
      case 4: return renderPricingStep();
      case 5: return renderPreviewStep();
      case 6: return renderActionsStep();
      default: return null;
    }
  };

  const renderCustomerStep = () => (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><User size={20} className="text-brand-500" /> Select {singular}</h3>
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          placeholder={`Search ${singular.toLowerCase()} by name, email, or company...`}
          value={customerSearch}
          onChange={(e) => setCustomerSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-3 border border-slate-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
      </div>
      {customerSearching && <div className="flex justify-center py-4"><Loader2 size={24} className="animate-spin text-brand-600" /></div>}
      {customerResults.length > 0 && (
        <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
          {customerResults.map((c) => (
            <button
              key={c.id}
              onClick={() => handleCustomerSelect(c)}
              className="w-full p-4 hover:bg-slate-50 border-b border-slate-100 last:border-b-0 text-left transition-colors"
            >
              <div className="font-medium text-slate-800">{c.display_name || c.company_name}</div>
              <div className="text-sm text-slate-500 mt-1">{c.email || c.phone || c.customer_code}</div>
            </button>
          ))}
        </div>
      )}
      {form.customer_id && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="flex items-center gap-3">
            <CheckCircle size={24} className="text-green-500" />
            <div>
              <div className="font-medium text-green-800">{form.customer_name}</div>
              <div className="text-sm text-green-600">{form.customer_email} • {form.currency}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const renderDetailsStep = () => (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><FileText size={20} className="text-brand-500" /> Quotation Details</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Quote Number *</label>
          <input type="text" value={form.quote_number}
            onChange={(e) => setForm((p) => ({ ...p, quote_number: e.target.value }))}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Valid Until</label>
          <input type="date" value={form.valid_until}
            onChange={(e) => setForm((p) => ({ ...p, valid_until: e.target.value }))}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Subject</label>
        <input type="text" placeholder="Brief description..." value={form.subject}
          onChange={(e) => setForm((p) => ({ ...p, subject: e.target.value }))}
          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Currency</label>
          <select value={form.currency} onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))}
            className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            {getCurrencySelectOptions().map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Discount %</label>
          <div className="relative max-w-xs">
            <Percent size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input type="number" min="0" max="100" step="0.1" value={form.discount_percentage}
              onChange={(e) => setForm((p) => ({ ...p, discount_percentage: parseFloat(e.target.value) || 0 }))}
              className="w-full pl-9 pr-4 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </div>
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Notes (Internal)</label>
        <textarea value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
          rows={2} placeholder="Internal notes..." className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Terms & Conditions</label>
        <textarea value={form.terms} onChange={(e) => setForm((p) => ({ ...p, terms: e.target.value }))}
          rows={3} placeholder="Payment terms, delivery terms, validity..." className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
      </div>
    </div>
  );

  const renderItemsStep = () => (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><Package size={20} className="text-brand-500" /> Products & Services</h3>
        <button type="button" onClick={() => setShowBulkPicker(true)}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-brand-200 text-brand-700 bg-brand-50 text-sm font-medium hover:bg-brand-100 transition-colors">
          <Package size={16} /> Add Products / Services
        </button>
      </div>
      <ProductSelector
        onSelect={(product) => handleProductSelect(product)}
        onSelectionChange={setSelectedProducts}
        onAddSelected={handleAddSelectedProducts}
        fetchProducts={(params) => productApi.list(params)}
        fetchProductById={(id) => productApi.get(id)}
        fetchCategories={(params) => productApi.listCategories(params)}
        formatPrice={(p) => formatDisplayCurrency(p.default_price || 0, form.currency)}
        multiSelect={true}
        selectedProducts={selectedProducts}
        invoiceCurrency={form.currency}
        placeholder="Search products by name, SKU, code, or category..."
      />
      <BulkProductPickerModal
        open={showBulkPicker}
        onClose={() => setShowBulkPicker(false)}
        fetchProducts={(params) => productApi.list(params)}
        fetchCategories={(params) => productApi.listCategories(params)}
        onAddSelected={handleBulkPickerAdd}
        formatPrice={(p) => formatDisplayCurrency(p.default_price || 0, form.currency)}
        invoiceCurrency={form.currency}
      />
      {addingProducts && (
        <p className="text-xs text-slate-500 flex items-center gap-1.5">
          <Loader2 size={12} className="animate-spin" /> Adding selected products…
        </p>
      )}
      {productAddWarning && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span className="flex-1">{productAddWarning}</span>
          <button onClick={() => setProductAddWarning(null)} className="text-amber-600 hover:text-amber-800 shrink-0" aria-label="Dismiss warning">
            <X size={14} />
          </button>
        </div>
      )}
      {items.length === 0 ? (
        <div className="text-center py-12 border-2 border-dashed border-slate-200 rounded-lg">
          <Package size={48} className="mx-auto mb-3 text-slate-300" />
          <p className="text-slate-500">No line items yet. Select a product above or add manually below.</p>
        </div>
      ) : (
        <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
          {items.map((item) => {
            const t = calcItem(item);
            return (
              <div key={item.id} className="p-4">
                    <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-medium text-slate-800">{item.product_name || item.description}</span>
                      {item.product_id && <span className="text-xs text-slate-400 bg-slate-100 px-2 py-0.5 rounded">Product</span>}
                      {item.price_source && <span className={`text-xs px-2 py-0.5 rounded ${item.price_source === "catalog" ? "bg-blue-100 text-blue-600" : item.price_source === "pricing_plan" ? "bg-green-100 text-green-600" : "bg-amber-100 text-amber-600"}`}>{item.price_source}</span>}
                    </div>
                    {item.needs_plan_selection && item.available_plans?.length > 1 && (
                      <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                        <label className="block text-xs font-medium text-amber-700 mb-2">
                          Multiple pricing plans available — select one:
                        </label>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => handlePlanSelect(item.id, item.product_id, null)}
                            className="px-4 py-2 text-sm border border-slate-300 rounded-lg bg-white hover:bg-brand-50 hover:border-brand-200 transition-colors text-slate-700"
                          >
                            Catalog Price ({formatDisplayCurrency(item.base_price || 0, item.pricing_currency || form.currency)})
                          </button>
                          {item.available_plans.map((plan) => {
                            const isTiered = ["tiered", "volume", "graduated"].includes(plan.pricing_model);
                            const planCurrency = plan.currency || item.pricing_currency || form.currency;
                            return (
                              <button
                                key={plan.id}
                                onClick={() => handlePlanSelect(item.id, item.product_id, plan.id)}
                                className="px-4 py-2 text-sm border border-slate-300 rounded-lg bg-white hover:bg-brand-50 hover:border-brand-200 transition-colors text-slate-700"
                              >
                                <span className="font-medium">{plan.name}</span>
                                {isTiered ? (
                                  <span className="ml-1 text-slate-500">(Tiered — select qty to see price)</span>
                                ) : plan.unit_price != null ? (
                                  <span className="ml-1 text-slate-500">({formatDisplayCurrency(plan.unit_price, planCurrency)}/{plan.billing_period})</span>
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {item.pricing_currency && form.currency && item.pricing_currency.toUpperCase() !== form.currency.toUpperCase() && (
                      <div className="mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                        Pricing is in {item.pricing_currency}. Amounts shown in {form.currency} using exchange rate {item.exchange_rate ? `(${Number(item.exchange_rate).toFixed(4)})` : "(converted at save time)"}.
                      </div>
                    )}
                    {item.tier_info && item.pricing_plan_id && (
                      <div className="mb-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
                        {item.tier_info.message || (
                          <>
                            {item.tier_info.tier_count} tier(s) configured
                            {item.tier_info.applied_tier && (
                              <> — applied: {formatDisplayCurrency(item.tier_info.applied_tier.unit_price, item.pricing_currency || form.currency)}/unit</>
                            )}
                            {item.tier_info.price_range && (
                              <> — range: {formatDisplayCurrency(item.tier_info.price_range.min, item.pricing_currency || form.currency)} to {formatDisplayCurrency(item.tier_info.price_range.max, item.pricing_currency || form.currency)}</>
                            )}
                            {item.tier_info.effective_per_unit != null && item.tier_info.total_for_quantity != null && (
                              <> — total: {formatDisplayCurrency(item.tier_info.total_for_quantity, item.pricing_currency || form.currency)} ({item.tier_info.effective_per_unit.toFixed(2)}/unit avg)</>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Qty</label>
                        <input type="number" min="0.01" step="0.01" value={item.quantity}
                          onChange={(e) => updateLineItem(item.id, "quantity", e.target.value)}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Unit Price</label>
                        <input type="number" min="0" step="0.01" value={item.unit_price}
                          onChange={(e) => updateLineItem(item.id, "unit_price", e.target.value)}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Discount %</label>
                        <input type="number" min="0" max="100" step="0.1" value={item.discount_percentage}
                          onChange={(e) => updateLineItem(item.id, "discount_percentage", e.target.value)}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Tax %</label>
                        <input type="number" min="0" max="100" step="0.1" value={item.tax_percentage}
                          onChange={(e) => updateLineItem(item.id, "tax_percentage", e.target.value)}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-xs text-slate-500 mb-1">Description</label>
                        <input type="text" value={item.description}
                          onChange={(e) => updateLineItem(item.id, "description", e.target.value)}
                          className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                      </div>
                    </div>
                    {item.product_type === "retainer" && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2 p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                        <div>
                          <label className="block text-xs font-medium text-amber-700 mb-1">Billing Period</label>
                          <select value={item.billing_period || "monthly"} onChange={(e) => updateLineItem(item.id, "billing_period", e.target.value)}
                            className="w-full px-3 py-2 border border-amber-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 bg-white">
                            <option value="monthly">Monthly</option>
                            <option value="quarterly">Quarterly</option>
                            <option value="semi_annual">Semi-Annual</option>
                            <option value="annual">Annual</option>
                            <option value="one_time">One-Time</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-amber-700 mb-1">Included Hours</label>
                          <input type="number" min="0" step="1" value={item.included_hours || ""} onChange={(e) => updateLineItem(item.id, "included_hours", e.target.value)}
                            className="w-full px-3 py-2 border border-amber-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 bg-white" placeholder="e.g. 40" />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-amber-700 mb-1">Overage Rate</label>
                          <input type="number" min="0" step="0.01" value={item.overage_rate || ""} onChange={(e) => updateLineItem(item.id, "overage_rate", e.target.value)}
                            className="w-full px-3 py-2 border border-amber-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 bg-white" placeholder="Per hour" />
                        </div>
                      </div>
                    )}
                    {item.product_type === "subscription" && (
                      <div className="mt-2 p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg">
                        <label className="block text-xs font-medium text-emerald-700 mb-1">Billing Cycle</label>
                        <select value={item.billing_period || "monthly"} onChange={(e) => updateLineItem(item.id, "billing_period", e.target.value)}
                          className="w-full px-3 py-2 border border-emerald-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 bg-white sm:w-1/3">
                          <option value="monthly">Monthly</option>
                          <option value="quarterly">Quarterly</option>
                          <option value="semi_annual">Semi-Annual</option>
                          <option value="annual">Annual</option>
                        </select>
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-3 mt-3 text-sm text-slate-600">
                      <span>Line: {formatDisplayCurrency(t.lineTotal, form.currency)}</span>
                      <span className="text-red-500">Disc: -{formatDisplayCurrency(t.discAmt, form.currency)}</span>
                      <span className="text-slate-500">Tax: {formatDisplayCurrency(t.taxAmt, form.currency)}</span>
                      <span className="font-medium text-slate-800">Total: {formatDisplayCurrency(t.total, form.currency)}</span>
                    </div>
                  </div>
                  <button onClick={() => removeLineItem(item.id)} className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Remove" aria-label={`Remove line item ${item.product_name || item.description || ""}`.trim()}><Trash2 size={18} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <button onClick={addLineItem} className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border-2 border-dashed border-slate-300 rounded-lg text-slate-600 hover:border-brand-400 hover:text-brand-600 hover:bg-brand-50 transition-colors">
        <Plus size={18} /> Add Line Item Manually
      </button>
    </div>
  );

  const renderPricingStep = () => (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><Calculator size={20} className="text-brand-500" /> Pricing Summary</h3>
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="space-y-3">
          <div className="flex justify-between text-sm"><span className="text-slate-500">Subtotal ({items.length} items)</span><span className="font-medium text-slate-800">{formatDisplayCurrency(totals.subtotal, form.currency)}</span></div>
          {totals.itemDisc > 0 && <div className="flex justify-between text-sm"><span className="text-slate-500">Item Discounts</span><span className="font-medium text-red-500">-{formatDisplayCurrency(totals.itemDisc, form.currency)}</span></div>}
          <div className="flex justify-between text-sm"><span className="text-slate-500">Quote Discount ({form.discount_percentage}%)</span><span className="font-medium text-red-500">-{formatDisplayCurrency(totals.quoteDisc, form.currency)}</span></div>
          <div className="flex justify-between text-sm"><span className="text-slate-500">Total Discount</span><span className="font-medium text-red-500">-{formatDisplayCurrency(totals.totalDisc, form.currency)}</span></div>
          <div className="flex justify-between text-sm"><span className="text-slate-500">After Discount</span><span className="font-medium text-slate-800">{formatDisplayCurrency(totals.afterDisc, form.currency)}</span></div>
          <div className="flex justify-between text-sm"><span className="text-slate-500">Tax</span><span className="font-medium text-slate-800">{formatDisplayCurrency(totals.itemTax, form.currency)}</span></div>
          <div className="flex justify-between text-lg font-bold text-slate-800 border-t border-slate-200 pt-3"><span>Grand Total</span><span>{formatDisplayCurrency(totals.total, form.currency)}</span></div>
        </div>
      </div>
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
        <h4 className="font-medium text-slate-700 mb-2">{singular} Info</h4>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div><span className="text-slate-500">Name:</span> <span className="font-medium ml-2">{form.customer_name}</span></div>
          <div><span className="text-slate-500">Email:</span> <span className="font-medium ml-2">{form.customer_email}</span></div>
          <div><span className="text-slate-500">Currency:</span> <span className="font-medium ml-2">{form.currency}</span></div>
          <div><span className="text-slate-500">Valid Until:</span> <span className="font-medium ml-2">{formatDisplayDate(form.valid_until)}</span></div>
        </div>
      </div>
    </div>
  );

  const renderPreviewStep = () => (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><Eye size={20} className="text-brand-500" /> Preview Quotation</h3>
      <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
        <div className="bg-slate-50 border-b border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-2xl font-bold text-slate-900">{form.quote_number}</div>
              <div className="text-slate-500 mt-1">{form.subject || "Quotation"}</div>
            </div>
            <div className="text-right">
              <div className="text-sm text-slate-500">Status</div>
              <span className="px-3 py-1 bg-slate-100 text-slate-700 rounded-full text-sm font-medium">DRAFT</span>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div><span className="text-slate-500">{singular}</span><div className="font-medium">{form.customer_name}</div></div>
            <div><span className="text-slate-500">Currency</span><div className="font-medium">{form.currency}</div></div>
            <div><span className="text-slate-500">Valid Until</span><div className="font-medium">{formatDisplayDate(form.valid_until)}</div></div>
            <div><span className="text-slate-500">Items</span><div className="font-medium">{items.length}</div></div>
          </div>
        </div>
        <div className="p-6">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th className="pb-2">#</th><th className="pb-2">Description</th><th className="pb-2 text-right">Qty</th><th className="pb-2 text-right">Price</th><th className="pb-2 text-right">Disc%</th><th className="pb-2 text-right">Tax%</th><th className="pb-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item, idx) => {
                  const t = calcItem(item);
                  return (
                    <tr key={item.id}>
                      <td className="py-3">{idx + 1}</td>
                      <td className="py-3 font-medium">{item.description}</td>
                      <td className="py-3 text-right">{item.quantity}</td>
                      <td className="py-3 text-right">{formatDisplayCurrency(item.unit_price, form.currency)}</td>
                      <td className="py-3 text-right">{item.discount_percentage}%</td>
                      <td className="py-3 text-right">{item.tax_percentage}%</td>
                      <td className="py-3 text-right font-medium">{formatDisplayCurrency(t.total, form.currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-6 bg-slate-50 rounded-lg p-4 space-y-2">
            <div className="flex justify-between text-sm"><span className="text-slate-500">Subtotal</span><span className="font-medium">{formatDisplayCurrency(totals.subtotal, form.currency)}</span></div>
            {totals.itemDisc > 0 && <div className="flex justify-between text-sm"><span className="text-slate-500">Item Discounts</span><span className="font-medium text-red-500">-{formatDisplayCurrency(totals.itemDisc, form.currency)}</span></div>}
            <div className="flex justify-between text-sm"><span className="text-slate-500">Quote Discount ({form.discount_percentage}%)</span><span className="font-medium text-red-500">-{formatDisplayCurrency(totals.quoteDisc, form.currency)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-slate-500">Tax</span><span className="font-medium">{formatDisplayCurrency(totals.itemTax, form.currency)}</span></div>
            <div className="flex justify-between text-lg font-bold text-slate-800 border-t border-slate-200 pt-2"><span>Total</span><span>{formatDisplayCurrency(totals.total, form.currency)}</span></div>
          </div>
          {form.terms && (
            <div className="mt-6 p-4 bg-slate-50 rounded-lg">
              <div className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Terms & Conditions</div>
              <div className="text-sm text-slate-700 whitespace-pre-wrap">{form.terms}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderActionsStep = () => (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><Send size={20} className="text-brand-500" /> Finalize Quotation</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg p-6 hover:border-brand-200 transition-colors cursor-pointer" onClick={() => submit(false)}>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-3 bg-slate-100 rounded-lg"><FileText size={24} className="text-slate-600" /></div>
            <div>
              <div className="font-semibold text-slate-800">Save as Draft</div>
              <div className="text-sm text-slate-500">Create quotation in DRAFT status for review</div>
            </div>
          </div>
          <div className="space-y-2 text-sm text-slate-600">
            <div className="flex justify-between"><span>{singular}</span><span className="font-medium">{form.customer_name}</span></div>
            <div className="flex justify-between"><span>Items</span><span className="font-medium">{items.length}</span></div>
            <div className="flex justify-between"><span>Currency</span><span className="font-medium">{form.currency}</span></div>
            <div className="flex justify-between text-lg font-bold text-slate-800 border-t border-slate-200 pt-2"><span>Total</span><span>{formatDisplayCurrency(totals.total, form.currency)}</span></div>
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-6 hover:border-brand-200 transition-colors cursor-pointer" onClick={() => submit(true)}>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-3 bg-brand-100 rounded-lg"><Send size={24} className="text-brand-600" /></div>
            <div>
              <div className="font-semibold text-slate-800">Save & Send</div>
              <div className="text-sm text-slate-500">Create and send quotation to customer</div>
            </div>
          </div>
          <div className="space-y-2 text-sm text-slate-600">
            <div className="flex justify-between"><span>{singular}</span><span className="font-medium">{form.customer_name}</span></div>
            <div className="flex justify-between"><span>Items</span><span className="font-medium">{items.length}</span></div>
            <div className="flex justify-between"><span>Currency</span><span className="font-medium">{form.currency}</span></div>
            <div className="flex justify-between text-lg font-bold text-brand-600 border-t border-slate-200 pt-2"><span>Total</span><span>{formatDisplayCurrency(totals.total, form.currency)}</span></div>
          </div>
        </div>
      </div>
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
        <div className="text-sm text-slate-600">
          <p className="font-medium text-slate-800 mb-1">What happens next:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>Draft: Quotation saved with DRAFT status. You can edit later from the list.</li>
            <li>Send: Quotation status changes to SENT. {singular} can accept/reject.</li>
            <li>After acceptance: Convert to Invoice from the detail page.</li>
          </ul>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-bold text-slate-900">Create Quotation</h1>
              <p className="text-sm text-slate-500">Step {step} of {STEPS.length}</p>
            </div>
            {step > 1 && <button onClick={handlePrev} className="px-4 py-2 border border-slate-300 rounded-lg text-sm hover:bg-slate-50 transition-colors"><ChevronLeft size={16} className="inline mr-1" /> Back</button>}
          </div>
          <div className="flex items-center gap-1 overflow-x-auto pb-2" role="navigation" aria-label="Wizard steps">
            {STEPS.map((s, idx) => (
              <div key={s.id} className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => idx + 1 < step && setStep(idx + 1)}
                  disabled={idx + 1 > step}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${idx + 1 === step ? "bg-brand-600 text-white ring-2 ring-brand-200" : idx + 1 < step ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-400 cursor-not-allowed"}`}
                  aria-current={idx + 1 === step ? "step" : undefined}
                  title={s.description || s.label}
                >
                  {idx + 1 < step ? <CheckCircle size={14} /> : <s.icon size={14} />}
                  <span>{s.id === 1 ? singular : s.label}</span>
                </button>
                {idx < STEPS.length - 1 && <ChevronRight size={14} className={`mx-1 ${idx + 1 < step ? "text-green-400" : "text-slate-300"}`} />}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="max-w-6xl mx-auto px-4 py-8">
        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3 text-red-700" role="alert">
            <AlertCircle size={20} /> {error}
            <button onClick={() => setError(null)} className="ml-auto text-red-500 hover:text-red-700" aria-label="Dismiss error"><X size={18} /></button>
          </div>
        )}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 md:p-8">
          {renderStep()}
        </div>
        <div className="mt-6 flex items-center justify-between">
          <button onClick={handlePrev} disabled={step === 1} className="px-6 py-2.5 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"><ChevronLeft size={16} className="inline mr-1" /> Back</button>
          <div className="flex gap-3">
            {step < STEPS.length && <button onClick={handleNext} disabled={loading} className="px-6 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors">Next <ChevronRight size={16} className="inline ml-1" /></button>}
            {step === STEPS.length && (
              <>
                <button onClick={() => submit(false)} disabled={loading} className="px-6 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 transition-colors">{loading ? <Loader2 size={16} className="animate-spin inline mr-1" /> : ""}Save as Draft</button>
                <button onClick={() => submit(true)} disabled={loading} className="px-6 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors">{loading ? <Loader2 size={16} className="animate-spin inline mr-1" /> : ""}Save & Send</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}