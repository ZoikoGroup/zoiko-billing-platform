import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { User, FileText, Package, Calculator, Eye, Send,
  ChevronRight, ChevronLeft, Plus, Trash2, X, CheckCircle,
  Calendar, Loader2, Search, AlertCircle,
  Hash, CreditCard } from "lucide-react"
import {
  contractApi, customerApi, productApi, pricingApi, settingsApi, quoteApi
} from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate, extractArray } from "../../../utils/billing-helpers";
import { getCurrencySelectOptions } from "../../../utils/currency";
import { CalculationEngine } from "../utils/calculation-engine";
import { useTerminology } from "../utils/TerminologyContext";
import { ProductSelector, BulkProductPickerModal } from "../../../components/billing-shared";

const STEPS = [
  { id: 1, label: "Customer / Quote", icon: User, description: "Select customer or accepted quotation" },
  { id: 2, label: "Contract Details", icon: FileText, description: "Contract name, dates, terms" },
  { id: 3, label: "Products", icon: Package, description: "Products & services" },
  { id: 4, label: "Pricing Review", icon: Calculator, description: "Review pricing & totals" },
  { id: 5, label: "Billing Schedule", icon: Calendar, description: "Billing period, day, auto-renew" },
  { id: 6, label: "Preview", icon: Eye, description: "Review complete contract" },
  { id: 7, label: "Actions", icon: Send, description: "Save draft or activate" },
];

const INITIAL_FORM = {
  customer_id: "",
  customer_name: "",
  customer_email: "",
  customer_phone: "",
  billing_address: "",
  shipping_address: "",
  quotation_id: "",
  quotation_number: "",
  contract_number: "",
  contract_name: "",
  status: "draft",
  start_date: "",
  end_date: "",
  notice_period_days: 30,
  auto_renew: false,
  renewal_term_days: "",
  value: 0,
  currency: "",
  billing_period: "monthly",
  billing_day: 1,
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
  available_plans: null,
  needs_plan_selection: false,
};

const BILLING_PERIODS = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "semi_annual", label: "Semi-Annually" },
  { value: "annual", label: "Annually" },
];

const PAYMENT_TERMS = [
  { value: "due_on_receipt", label: "Due on Receipt" },
  { value: "net_7", label: "Net 7" },
  { value: "net_15", label: "Net 15" },
  { value: "net_30", label: "Net 30" },
  { value: "net_45", label: "Net 45" },
  { value: "net_60", label: "Net 60" },
  { value: "net_90", label: "Net 90" },
];

export default function ContractCreateWizardPage({ onClose, onCreated }) {
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
  const [quotationSearch, setQuotationSearch] = useState("");
  const [quotationResults, setQuotationResults] = useState([]);
  const [quotationSearching, setQuotationSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [orgSettings, setOrgSettings] = useState({ contract_prefix: "CTR-" });
  const [quotationItems, setQuotationItems] = useState([]);
  const [exchangeRates, setExchangeRates] = useState({});

  useEffect(() => {
    loadOrgSettings();
    if (!form.contract_number) {
      const ts = Date.now().toString(36).toUpperCase();
      setForm((p) => ({ ...p, contract_number: `${orgSettings.contract_prefix || "CTR-"}${ts}` }));
    }
    if (!form.start_date) {
      setForm((p) => ({ ...p, start_date: new Date().toISOString().split("T")[0] }));
    }
    if (!form.end_date) {
      const d = new Date();
      d.setFullYear(d.getFullYear() + 1);
      setForm((p) => ({ ...p, end_date: d.toISOString().split("T")[0] }));
    }
  }, []);

  const loadOrgSettings = async () => {
    try {
      const data = await settingsApi.get();
      setOrgSettings(data);
      setForm((p) => {
        const next = { ...p };
        if (data.default_currency) {
          next.currency = data.default_currency;
        }
        if (!p.contract_number) {
          const ts = Date.now().toString(36).toUpperCase();
          next.contract_number = `${data.contract_prefix || "CTR-"}${ts}`;
        }
        return next;
      });
    } catch (err) { console.error("[ContractCreate] Failed to init form:", err); }
  };

  const searchCustomers = useCallback(async (term) => {
    if (!term.trim()) { setCustomerResults([]); return; }
    setCustomerSearching(true);
    try {
      const data = await customerApi.search(term, 10);
      setCustomerResults(Array.isArray(data) ? data : data?.items || data?.data || []);
    } catch (err) { console.error("[ContractCreate] Customer search failed:", err); setCustomerResults([]); }
    finally { setCustomerSearching(false); }
  }, []);

  useEffect(() => {
    if (step !== 1) return;
    const timer = setTimeout(() => searchCustomers(customerSearch), 300);
    return () => clearTimeout(timer);
  }, [customerSearch, step, searchCustomers]);

  const handleCustomerSelect = async (c) => {
    const full = await customerApi.get(c.id);
    const currency = full.currency || orgSettings?.default_currency || "";
    setForm((p) => ({
      ...p,
      customer_id: full.id,
      customer_name: full.display_name || full.company_name,
      customer_email: full.email || "",
      customer_phone: full.phone || "",
      billing_address: full.billing_address || "",
      shipping_address: full.shipping_address || "",
      currency,
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
    if (step !== 3) return;
    const timer = setTimeout(() => searchProducts(productSearch), 300);
    return () => clearTimeout(timer);
  }, [productSearch, step, searchProducts]);

  const handleProductSelect = async (p) => {
    let basePrice = parseFloat(p.default_price || 0);
    let unitPrice = basePrice;
    let pricingPlanId = null;
    let priceSource = "catalog";
    let resolvedPrice = basePrice;
    let availablePlans = null;
    let needsPlanSelection = false;
    try {
      const plans = await pricingApi.listByProduct(p.id);
      const active = Array.isArray(plans) ? plans : plans?.items || [];
      if (active.length === 1) {
        try {
          const resolveRes = await pricingApi.resolvePrice({ product_id: p.id, pricing_plan_id: active[0].id });
          resolvedPrice = parseFloat(resolveRes.resolved_price ?? resolveRes.unit_price ?? active[0].unit_price ?? basePrice);
          basePrice = parseFloat(resolveRes.base_price ?? basePrice);
          pricingPlanId = resolveRes.pricing_plan_id ?? active[0].id;
          priceSource = resolveRes.price_source ?? "pricing_plan";
          unitPrice = resolvedPrice;
        } catch {
          const planPrice = parseFloat(active[0].unit_price ?? basePrice);
          resolvedPrice = planPrice;
          unitPrice = planPrice;
          pricingPlanId = active[0].id;
          priceSource = "pricing_plan";
        }
      } else if (active.length === 0) {
        try {
          const resolveRes = await pricingApi.resolvePrice({ product_id: p.id });
          resolvedPrice = parseFloat(resolveRes.resolved_price ?? resolveRes.unit_price ?? basePrice);
          basePrice = parseFloat(resolveRes.base_price ?? basePrice);
          pricingPlanId = resolveRes.pricing_plan_id ?? null;
          priceSource = resolveRes.price_source ?? "catalog";
          unitPrice = resolvedPrice;
        } catch (resolveErr) {
          /* Price resolution failed for catalog-only product */
        }
      } else {
        availablePlans = active;
        needsPlanSelection = true;
        unitPrice = 0;
        resolvedPrice = null;
        pricingPlanId = null;
        priceSource = null;
      }
    } catch (prodErr) {
      /* Product pricing lookup failed */
    }
    const itemFields = {
      product_id: p.id,
      product_name: p.name,
      product_type: p.product_type || "service",
      description: p.description || p.name,
      quantity: 1,
      unit_price: unitPrice,
      discount_percentage: parseFloat(p.default_discount || 0),
      tax_percentage: parseFloat(p.tax_percentage || 0),
      is_tax_inclusive: p.tax_inclusive || false,
      pricing_plan_id: pricingPlanId,
      base_price: basePrice,
      resolved_price: resolvedPrice,
      price_source: priceSource,
      available_plans: availablePlans,
      needs_plan_selection: needsPlanSelection,
      billing_period: p.billing_period || p.billing_frequency || "monthly",
      included_hours: p.included_hours || "",
      overage_rate: p.overage_rate || "",
    };
    setItems((cur) => {
      const idx = cur.findIndex((i) => !i.product_id);
      if (idx >= 0) {
        return cur.map((i, i2) => i2 === idx ? { ...i, ...itemFields } : i);
      }
      return [...cur, { id: Date.now(), line_number: cur.length + 1, ...itemFields }];
    });
    setProductResults([]);
    setProductSearch("");
  };

  // Resolves pricing for one product without touching component state — used by the
  // bulk "Add Selected" flow so each selected product becomes its own new line item
  // (mirrors the pricing branches in handleProductSelect, kept separate so the
  // existing single-select path above is never at risk of regressing).
  const resolveProductPricing = async (p, quantity = 1) => {
    let basePrice = parseFloat(p.default_price || 0);
    let unitPrice = basePrice;
    let pricingPlanId = null;
    let priceSource = "catalog";
    let resolvedPrice = basePrice;
    let availablePlans = null;
    let needsPlanSelection = false;
    const plans = await pricingApi.listByProduct(p.id);
    const active = Array.isArray(plans) ? plans : plans?.items || [];
    if (active.length === 1) {
      try {
        const resolveRes = await pricingApi.resolvePrice({ product_id: p.id, pricing_plan_id: active[0].id, quantity });
        resolvedPrice = parseFloat(resolveRes.resolved_price ?? resolveRes.unit_price ?? active[0].unit_price ?? basePrice);
        basePrice = parseFloat(resolveRes.base_price ?? basePrice);
        pricingPlanId = resolveRes.pricing_plan_id ?? active[0].id;
        priceSource = resolveRes.price_source ?? "pricing_plan";
        unitPrice = resolvedPrice;
      } catch {
        const planPrice = parseFloat(active[0].unit_price ?? basePrice);
        resolvedPrice = planPrice;
        unitPrice = planPrice;
        pricingPlanId = active[0].id;
        priceSource = "pricing_plan";
      }
    } else if (active.length === 0) {
      try {
        const resolveRes = await pricingApi.resolvePrice({ product_id: p.id, quantity });
        resolvedPrice = parseFloat(resolveRes.resolved_price ?? resolveRes.unit_price ?? basePrice);
        basePrice = parseFloat(resolveRes.base_price ?? basePrice);
        pricingPlanId = resolveRes.pricing_plan_id ?? null;
        priceSource = resolveRes.price_source ?? "catalog";
        unitPrice = resolvedPrice;
      } catch (resolveErr) {
        /* Price resolution failed for catalog-only product */
      }
    } else {
      availablePlans = active;
      needsPlanSelection = true;
      unitPrice = 0;
      resolvedPrice = null;
      pricingPlanId = null;
      priceSource = null;
    }
    return {
      product_id: p.id,
      product_name: p.name,
      product_type: p.product_type || "service",
      description: p.description || p.name,
      quantity,
      unit_price: unitPrice,
      discount_percentage: parseFloat(p.default_discount || 0),
      tax_percentage: parseFloat(p.tax_percentage || 0),
      is_tax_inclusive: p.tax_inclusive || false,
      pricing_plan_id: pricingPlanId,
      base_price: basePrice,
      resolved_price: resolvedPrice,
      price_source: priceSource,
      available_plans: availablePlans,
      needs_plan_selection: needsPlanSelection,
      billing_period: p.billing_period || p.billing_frequency || "monthly",
      included_hours: p.included_hours || "",
      overage_rate: p.overage_rate || "",
    };
  };

  const handleAddSelectedProducts = async () => {
    if (selectedProducts.length === 0 || addingProducts) return;
    setAddingProducts(true);
    setProductAddWarning(null);
    const idBase = Date.now();
    const newItems = [];
    const failedProducts = [];
    const failedNames = [];
    for (let i = 0; i < selectedProducts.length; i++) {
      const product = selectedProducts[i];
      try {
        const data = await resolveProductPricing(product);
        newItems.push({ ...INITIAL_ITEM, ...data, id: idBase + i + 1 });
      } catch (err) {
        failedProducts.push(product);
        const reason = err?.detail || err?.message || "Could not resolve pricing";
        failedNames.push(`${product.name || `Product #${product.id}`} (${reason})`);
      }
    }
    if (newItems.length > 0) {
      setItems((cur) => [...cur, ...newItems].map((item, idx) => ({ ...item, line_number: idx + 1 })));
    }
    // Keep failed products selected so the user can retry without re-searching.
    setSelectedProducts(failedProducts);
    if (failedNames.length > 0) {
      setProductAddWarning(`Could not add ${failedNames.length} product${failedNames.length > 1 ? "s" : ""}: ${failedNames.join(", ")}`);
    }
    setAddingProducts(false);
  };

  // Workflow B — Enterprise Bulk Product Selection. Reuses resolveProductPricing
  // (same function Quick Add's own bulk-select path uses above); the only
  // difference is each product here carries the quantity chosen in the picker.
  const handleBulkPickerAdd = async (itemsWithQuantity) => {
    if (itemsWithQuantity.length === 0) return;
    setAddingProducts(true);
    setProductAddWarning(null);
    const idBase = Date.now();
    const newItems = [];
    const failedNames = [];
    for (let i = 0; i < itemsWithQuantity.length; i++) {
      const product = itemsWithQuantity[i];
      try {
        const data = await resolveProductPricing(product, Number(product.quantity) || 1);
        newItems.push({ ...INITIAL_ITEM, ...data, id: idBase + i + 1 });
      } catch (err) {
        const reason = err?.detail || err?.message || "Could not resolve pricing";
        failedNames.push(`${product.name || `Product #${product.id}`} (${reason})`);
      }
    }
    if (newItems.length > 0) {
      setItems((cur) => [...cur, ...newItems].map((item, idx) => ({ ...item, line_number: idx + 1 })));
    }
    if (failedNames.length > 0) {
      setProductAddWarning(`Could not add ${failedNames.length} product${failedNames.length > 1 ? "s" : ""}: ${failedNames.join(", ")}`);
    }
    setAddingProducts(false);
  };

  const handlePlanSelect = async (itemId, plan) => {
    const item = items.find((i) => i.id === itemId);
    if (!item) return;
    try {
      const params = { product_id: item.product_id };
      if (plan && plan.id) {
        params.pricing_plan_id = plan.id;
      }
      const resolveRes = await pricingApi.resolvePrice(params);
      setItems((cur) => cur.map((i) => i.id === itemId ? {
        ...i,
        unit_price: parseFloat(resolveRes.resolved_price ?? resolveRes.unit_price ?? 0),
        resolved_price: parseFloat(resolveRes.resolved_price ?? resolveRes.unit_price ?? null),
        base_price: parseFloat(resolveRes.base_price ?? i.base_price ?? 0),
        pricing_plan_id: resolveRes.pricing_plan_id ?? (plan && plan.id) ?? null,
        price_source: resolveRes.price_source ?? (plan ? "pricing_plan" : "catalog"),
        needs_plan_selection: false,
        available_plans: null,
      } : i));
    } catch (planResolveErr) {
      /* Plan price resolution failed */
    }
  };

  const addLineItem = () => {
    setItems((cur) => [...cur, { ...INITIAL_ITEM, id: Date.now(), line_number: cur.length + 1 }]);
  };

  const updateLineItem = (itemId, field, value) => {
    setItems((cur) => cur.map((i) => i.id === itemId ? { ...i, [field]: value } : i));
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

  const searchQuotations = useCallback(async (term) => {
    if (!term.trim()) { setQuotationResults([]); return; }
    setQuotationSearching(true);
    try {
      const data = await quoteApi.list({ search_term: term, status: "accepted", per_page: 10 });
      const accepted = extractArray(data).filter((q) => q.status === "accepted");
      setQuotationResults(accepted);
    } catch {
      setQuotationResults([]);
    } finally {
      setQuotationSearching(false);
    }
  }, []);

  useEffect(() => {
    if (step !== 1) return;
    const timer = setTimeout(() => searchQuotations(quotationSearch), 300);
    return () => clearTimeout(timer);
  }, [quotationSearch, step, searchQuotations]);

  const handleQuotationSelect = async (q) => {
    setForm((p) => ({
      ...p,
      quotation_id: q.id,
      quotation_number: q.quote_number,
      customer_id: q.customer_id,
      contract_name: q.subject || `Contract from ${q.quote_number}`,
      value: parseFloat(q.total_amount || 0),
      currency: q.currency || orgSettings?.default_currency || "",
    }));
    if (q.customer_id) {
      const c = await customerApi.get(q.customer_id).catch(() => null);
      if (c) {
        const currency = q.currency || c.currency || orgSettings?.default_currency || "";
        setForm((p) => ({
          ...p,
          customer_name: c.display_name || c.company_name || `${singular} #${c.id}`,
          customer_email: c.email || "",
          customer_phone: c.phone || "",
          billing_address: c.billing_address || "",
          shipping_address: c.shipping_address || "",
          currency,
        }));
      }
    }
    const itemsResponse = await quoteApi.listItems(q.id).catch(() => ({ items: [] }));
    const qItems = extractArray(itemsResponse);
    setQuotationItems(qItems);
    const prods = qItems.map((item, idx) => ({
      id: Date.now() + idx,
      line_number: idx + 1,
      product_id: item.product_id,
      product_name: item.product_name || item.product?.name || item.description || "",
      description: item.description,
      quantity: parseFloat(item.quantity || 1),
      unit_price: parseFloat(item.unit_price || 0),
      discount_percentage: parseFloat(item.discount_percentage || 0),
      tax_percentage: parseFloat(item.tax_percentage || 0),
      is_tax_inclusive: item.is_tax_inclusive || false,
      pricing_plan_id: item.pricing_plan_id || null,
      base_price: item.base_price != null ? parseFloat(item.base_price) : null,
      resolved_price: item.resolved_price != null ? parseFloat(item.resolved_price) : null,
      price_source: item.price_source || null,
      available_plans: null,
      needs_plan_selection: false,
    }));
    setItems(prods);
    setQuotationResults([]);
    setQuotationSearch("");
  };

  const validateStep = (s) => {
    if (s === 1 && !form.customer_id) { setError("Please select a customer"); return false; }
    if (s === 2 && (!form.contract_name || !form.start_date)) { setError("Contract name and start date are required"); return false; }
    if (s === 3 && items.length === 0) { setError("Add at least one product"); return false; }
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
    quotation_id: form.quotation_id ? Number(form.quotation_id) : undefined,
    contract_number: form.contract_number,
    contract_name: form.contract_name,
    status: form.status,
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

  const buildItemsPayload = () => items
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

  const submit = async (activateAfter = false) => {
    setLoading(true); setError(null);
    try {
      const contract = await contractApi.create(buildPayload());
      const itemsPayload = buildItemsPayload();
      if (itemsPayload.length > 0) {
        await contractApi.setItems(contract.id, { items: itemsPayload });
      }
      if (activateAfter) {
        await contractApi.activate(contract.id);
      }
      onCreated?.(contract);
      onClose?.();
      navigate(`/billing/contracts/${contract.id}`);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to create contract");
    } finally { setLoading(false); }
  };

  const renderStep = () => {
    switch (step) {
      case 1: return renderCustomerStep();
      case 2: return renderDetailsStep();
      case 3: return renderItemsStep();
      case 4: return renderPricingStep();
      case 5: return renderBillingStep();
      case 6: return renderPreviewStep();
      case 7: return renderActionsStep();
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
        <div className="border border-slate-200 rounded-lg overflow-hidden bg-white max-h-60 overflow-y-auto shadow-md">
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

      <div className="mt-8 pt-6 border-t border-slate-100">
        <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><FileText size={20} className="text-brand-500" /> Accepted Quotation (Optional)</h3>
        <div className="relative mt-3">
          <Hash size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search accepted quotations..."
            value={quotationSearch}
            onChange={(e) => setQuotationSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </div>
        {quotationSearching && <div className="flex justify-center py-4"><Loader2 size={24} className="animate-spin text-brand-600" /></div>}
        {quotationResults.length > 0 && (
          <div className="border border-slate-200 rounded-lg overflow-hidden bg-white mt-1 max-h-60 overflow-y-auto shadow-md">
            {quotationResults.map((q) => (
              <button
                key={q.id}
                onClick={() => handleQuotationSelect(q)}
                className="w-full p-3 hover:bg-slate-50 border-b border-slate-100 last:border-b-0 text-left transition-colors flex items-center justify-between"
              >
                <div>
                  <div className="font-medium text-slate-800">{q.quote_number} — {q.subject || "No Subject"}</div>
                  <div className="text-xs text-slate-500 mt-1">{singular} #{q.customer_id}</div>
                </div>
                <div className="text-sm font-semibold text-brand-600">{formatDisplayCurrency(q.total_amount, q.currency || orgSettings?.default_currency || "")}</div>
              </button>
            ))}
          </div>
        )}
        {form.quotation_id && (
          <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <p className="font-medium text-slate-800">{form.quotation_number}</p>
              <button onClick={() => { setForm((p) => ({ ...p, quotation_id: "", quotation_number: "", value: 0 })); setQuotationItems([]); }} className="text-xs text-blue-600 hover:text-blue-800">Clear</button>
            </div>
            <div className="grid grid-cols-4 gap-3 text-sm">
              <div><span className="text-xs text-slate-500">Total</span><p className="font-medium">{formatDisplayCurrency(form.value, form.currency)}</p></div>
              <div><span className="text-xs text-slate-500">Items</span><p className="font-medium">{quotationItems.length}</p></div>
              <div><span className="text-xs text-slate-500">Currency</span><p className="font-medium">{form.currency}</p></div>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Contract Number *</label>
          <input type="text" value={form.contract_number}
            onChange={(e) => setForm((p) => ({ ...p, contract_number: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Start Date *</label>
          <input type="date" value={form.start_date}
            onChange={(e) => setForm((p) => ({ ...p, start_date: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </div>
      </div>
    </div>
  );

  const renderDetailsStep = () => (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><FileText size={20} className="text-brand-500" /> Contract Details</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Contract Name *</label>
          <input type="text" value={form.contract_name}
            onChange={(e) => setForm((p) => ({ ...p, contract_name: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">End Date</label>
          <input type="date" value={form.end_date}
            onChange={(e) => setForm((p) => ({ ...p, end_date: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Currency</label>
        <select value={form.currency} onChange={(e) => setForm((p) => ({ ...p, currency: e.target.value }))}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
          {getCurrencySelectOptions().map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Notice Period (days)</label>
          <input type="number" min="0" value={form.notice_period_days}
            onChange={(e) => setForm((p) => ({ ...p, notice_period_days: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Auto Renew</label>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={form.auto_renew}
              onChange={(e) => setForm((p) => ({ ...p, auto_renew: e.target.checked }))}
              className="rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
            <span className="text-sm text-slate-600">Enable auto-renewal</span>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Renewal Term (days)</label>
          <input type="number" min="1" value={form.renewal_term_days}
            onChange={(e) => setForm((p) => ({ ...p, renewal_term_days: e.target.value }))}
            disabled={!form.auto_renew}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:bg-slate-50" />
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Notes (Internal)</label>
        <textarea value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
          rows={2} placeholder="Internal notes..." className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
      </div>
      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Terms & Conditions</label>
        <textarea value={form.terms} onChange={(e) => setForm((p) => ({ ...p, terms: e.target.value }))}
          rows={3} placeholder="Payment terms, delivery terms, validity..." className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
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
          <button onClick={() => setProductAddWarning(null)} className="text-amber-600 hover:text-amber-800 shrink-0">
            <X size={14} />
          </button>
        </div>
      )}

      {items.length === 0 && !form.quotation_id && (
        <div className="text-center py-12 border-2 border-dashed border-slate-200 rounded-lg">
          <Package size={48} className="mx-auto mb-3 text-slate-300" />
          <p className="text-slate-500">No line items yet. Select a product above or add manually below.</p>
        </div>
      )}
      {items.length > 0 && (
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
                      {item.price_source && <span className="text-xs text-brand-500 bg-brand-50 px-2 py-0.5 rounded">{item.price_source === "pricing_plan" ? "Plan" : "Catalog"}</span>}
                    </div>
                    {item.needs_plan_selection && item.available_plans && (
                      <div className="mb-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                        <p className="text-xs font-medium text-amber-700 mb-2">Select a pricing plan for this product:</p>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => handlePlanSelect(item.id, null)}
                            className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
                          >
                            Catalog Price ({formatDisplayCurrency(item.base_price, form.currency)})
                          </button>
                          {item.available_plans.map((plan) => (
                            <button
                              key={plan.id}
                              onClick={() => handlePlanSelect(item.id, plan)}
                              className="px-3 py-1.5 text-xs font-medium bg-white border border-brand-200 text-brand-700 rounded-lg hover:bg-brand-50 transition-colors"
                            >
                              {plan.name} ({formatDisplayCurrency(plan.unit_price, form.currency)})
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Qty</label>
                        <input type="number" min="0.01" step="0.01" value={item.quantity}
                          onChange={(e) => updateLineItem(item.id, "quantity", e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Unit Price</label>
                        <input type="number" min="0" step="0.01" value={item.unit_price}
                          onChange={(e) => updateLineItem(item.id, "unit_price", e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Discount %</label>
                        <input type="number" min="0" max="100" step="0.1" value={item.discount_percentage}
                          onChange={(e) => updateLineItem(item.id, "discount_percentage", e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">Tax %</label>
                        <input type="number" min="0" max="100" step="0.1" value={item.tax_percentage}
                          onChange={(e) => updateLineItem(item.id, "tax_percentage", e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                      </div>
                      <div className="md:col-span-2">
                        <label className="block text-xs text-slate-500 mb-1">Description</label>
                        <input type="text" value={item.description}
                          onChange={(e) => updateLineItem(item.id, "description", e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
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
                  <button onClick={() => removeLineItem(item.id)} className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Remove" aria-label="Remove line item"><Trash2 size={18} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
        <div className="flex justify-between text-sm text-slate-600 mb-1">
          <span>Contract Value (from products)</span>
          <span className="font-medium text-slate-800">{formatDisplayCurrency(totals.total, form.currency)}</span>
        </div>
        <div className="flex justify-between text-sm font-medium border-t border-slate-200 pt-2 mt-1">
          <span>Total Items</span>
          <span>{items.length}</span>
        </div>
      </div>
      <div className="flex justify-end">
        <button onClick={addLineItem} className="px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm font-medium hover:bg-slate-200 flex items-center gap-2">
          <Plus size={16} /> Add Product
        </button>
      </div>
    </div>
  );

  const renderPricingStep = () => (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><Calculator size={20} className="text-brand-500" /> Pricing Summary</h3>
      <div className="bg-white border border-slate-200 rounded-lg p-6">
        <div className="space-y-3">
          <div className="flex justify-between text-sm"><span className="text-slate-500">Subtotal ({items.length} items)</span><span className="font-medium text-slate-800">{formatDisplayCurrency(totals.subtotal, form.currency)}</span></div>
          {totals.itemDisc > 0 && <div className="flex justify-between text-sm"><span className="text-slate-500">Item Discounts</span><span className="font-medium text-red-500">-{formatDisplayCurrency(totals.itemDisc, form.currency)}</span></div>}
          <div className="flex justify-between text-sm"><span className="text-slate-500">Contract Discount ({form.discount_percentage}%)</span><span className="font-medium text-red-500">-{formatDisplayCurrency(totals.quoteDisc, form.currency)}</span></div>
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
          <div><span className="text-slate-500">Start:</span> <span className="font-medium ml-2">{formatDisplayDate(form.start_date)}</span></div>
          <div><span className="text-slate-500">End:</span> <span className="font-medium ml-2">{formatDisplayDate(form.end_date) || "—"}</span></div>
          <div><span className="text-slate-500">Quotation:</span> <span className="font-medium ml-2">{form.quotation_number || "—"}</span></div>
        </div>
      </div>
    </div>
  );

  const renderBillingStep = () => (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><Calendar size={20} className="text-brand-500" /> Billing Schedule</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Billing Period *</label>
          <select value={form.billing_period} onChange={(e) => setForm((p) => ({ ...p, billing_period: e.target.value }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
            {BILLING_PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Billing Day *</label>
          <input type="number" min="1" max="31" value={form.billing_day}
            onChange={(e) => setForm((p) => ({ ...p, billing_day: Math.min(31, Math.max(1, parseInt(e.target.value) || 1)) }))}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">Next Billing Date</label>
          <input type="date" value={form.start_date}
            className="w-full px-4 py-2.5 border border-slate-300 rounded-lg text-sm bg-slate-50" readOnly />
        </div>
      </div>
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><CreditCard size={16} className="text-brand-500" /> Schedule Preview</h3>
        <div className="space-y-3">
          <p className="text-sm text-slate-600">Invoices will be generated on day <strong>{form.billing_day}</strong> of each <strong>{form.billing_period}</strong> period.</p>
          <p className="text-sm text-slate-600">First invoice: <strong>{formatDisplayDate(form.start_date)}</strong></p>
          {form.end_date && <p className="text-sm text-slate-600">Last invoice period ends: <strong>{formatDisplayDate(form.end_date)}</strong></p>}
          {form.auto_renew && <p className="text-sm text-slate-600 text-emerald-600">✓ Auto-renewal enabled (every {form.renewal_term_days || "Not set"} days)</p>}
        </div>
      </div>
    </div>
  );

  const renderPreviewStep = () => (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><Eye size={20} className="text-brand-500" /> Preview Contract</h3>
      <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
        <div className="bg-slate-50 border-b border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-2xl font-bold text-slate-900">CONTRACT</div>
              <div className="text-sm text-slate-500 mt-1">#{form.contract_number}</div>
            </div>
            <div className="text-right">
              <p className="text-sm text-slate-500">Status: Draft</p>
              <p className="text-xs text-slate-400 mt-1">Valid: {formatDisplayDate(form.start_date)} — {formatDisplayDate(form.end_date) || "Ongoing"}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div><span className="text-slate-500">{singular}</span><div className="font-medium">{form.customer_name}</div></div>
            <div><span className="text-slate-500">Currency</span><div className="font-medium">{form.currency}</div></div>
            <div><span className="text-slate-500">Billing</span><div className="font-medium capitalize">{form.billing_period}</div></div>
            <div><span className="text-slate-500">Total</span><div className="font-medium">{formatDisplayCurrency(totals.total, form.currency)}</div></div>
          </div>
        </div>
        <div className="p-6">
          <div className="mb-6 p-4 bg-slate-50 rounded-lg">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">{singular}</p>
            <p className="font-medium text-slate-800">{form.customer_name}</p>
            {form.customer_email && <p className="text-sm text-slate-500">{form.customer_email}</p>}
            {form.customer_phone && <p className="text-sm text-slate-500">{form.customer_phone}</p>}
          </div>
          {form.contract_name && (
            <div className="mb-4">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Contract Name</p>
              <p className="text-sm text-slate-700">{form.contract_name}</p>
            </div>
          )}
          {items.length > 0 && (
            <div className="overflow-x-auto mb-4">
              <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-500 border-b border-slate-200">
                  <th className="py-2">#</th><th className="py-2">Description</th><th className="py-2 text-right">Qty</th><th className="py-2 text-right">Price</th><th className="py-2 text-right">Disc%</th><th className="py-2 text-right">Tax%</th><th className="py-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item, idx) => {
                  const t = calcItem(item);
                  return (
                    <tr key={item.id}>
                      <td className="py-3">{idx + 1}</td>
                      <td className="py-3 font-medium">{item.description}</td>
                      <td className="py-3 text-right text-slate-600">{item.quantity}</td>
                      <td className="py-3 text-right text-slate-600">{formatDisplayCurrency(item.unit_price, form.currency)}</td>
                      <td className="py-3 text-right text-slate-500">{item.discount_percentage > 0 ? `${item.discount_percentage}%` : "—"}</td>
                      <td className="py-3 text-right text-slate-500">{item.tax_percentage > 0 ? `${item.tax_percentage}%` : "—"}</td>
                      <td className="py-3 text-right font-medium">{formatDisplayCurrency(t.total, form.currency)}</td>
                    </tr>
                  );
                })}
              </tbody>
              </table>
            </div>
          )}
          <div className="border-t border-slate-200 pt-3 ml-auto w-64">
            <div className="flex justify-between text-sm text-slate-600 mb-1"><span>Subtotal</span><span>{formatDisplayCurrency(totals.subtotal, form.currency)}</span></div>
            {totals.itemDisc > 0 && <div className="flex justify-between text-sm text-red-500 mb-1"><span>Item Discounts</span><span>-{formatDisplayCurrency(totals.itemDisc, form.currency)}</span></div>}
            <div className="flex justify-between text-sm text-slate-600 mb-1"><span>Contract Discount ({form.discount_percentage}%)</span><span className="text-red-500">-{formatDisplayCurrency(totals.quoteDisc, form.currency)}</span></div>
            <div className="flex justify-between text-sm text-slate-600 mb-1"><span>Tax</span><span>{formatDisplayCurrency(totals.itemTax, form.currency)}</span></div>
            <div className="flex justify-between text-base font-bold text-slate-800 border-t border-slate-200 pt-2 mt-1"><span>Total</span><span>{formatDisplayCurrency(totals.total, form.currency)}</span></div>
          </div>
          {form.terms && (
            <div className="mt-6 p-4 bg-slate-50 rounded-lg">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Terms & Conditions</p>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{form.terms}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderActionsStep = () => (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2"><Send size={20} className="text-brand-500" /> Finalize Contract</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg p-6 hover:border-brand-200 transition-colors cursor-pointer" onClick={() => submit(false)}>
          <div className="flex items-center gap-3 mb-3">
            <div className="p-3 bg-slate-100 rounded-lg"><FileText size={24} className="text-slate-600" /></div>
            <div>
              <div className="font-semibold text-slate-800">Save as Draft</div>
              <div className="text-sm text-slate-500">Create contract in DRAFT status for review</div>
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
              <div className="font-semibold text-slate-800">Save & Activate</div>
              <div className="text-sm text-slate-500">Create and activate contract immediately</div>
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
            <li>Draft: Contract saved with DRAFT status. You can edit later from the list.</li>
            <li>Activate: Contract status changes to ACTIVE. Billing schedule starts.</li>
            <li>After activation: Generate invoices from the contract detail page.</li>
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
              <h1 className="text-xl font-bold text-slate-900">Create Contract</h1>
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
                  title={s.description}
                >
                  {idx + 1 < step ? <CheckCircle size={14} /> : <s.icon size={14} />}
                  <span>{s.id === 1 ? `${singular} / Quote` : s.label}</span>
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
                <button onClick={() => submit(true)} disabled={loading} className="px-6 py-2.5 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors">{loading ? <Loader2 size={16} className="animate-spin inline mr-1" /> : ""}Save & Activate</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}