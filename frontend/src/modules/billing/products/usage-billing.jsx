import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { BarChart3, RefreshCw, Zap, DollarSign, Activity, Calendar, Search, Plus, X, AlertCircle, CheckCircle, Settings2, FlaskConical, Download, KeyRound, Gauge } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { productApi } from "../../../service/billingService";
import { formatDisplayDate, formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { ErrorState, EmptyState, SuccessMessage, useConfirmationDialog } from "../../../components/billing-shared";
import { downloadCSV } from "../../../utils/export-helpers";

const METER_TYPES = [
  { value: "sum", label: "Sum" },
  { value: "max", label: "Max" },
  { value: "unique", label: "Unique Count" },
  { value: "last", label: "Last Value" },
];

const UNIT_OPTIONS = [
  { value: "unit", label: "Units" },
  { value: "hour", label: "Hours" },
  { value: "day", label: "Days" },
  { value: "mb", label: "MB" },
  { value: "gb", label: "GB" },
  { value: "api_call", label: "API Calls" },
  { value: "user", label: "Users" },
  { value: "license", label: "Licenses" },
];

function StatusPill({ status }) {
  const styles = { active: "bg-emerald-100 text-emerald-700", inactive: "bg-slate-100 text-slate-600" };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${styles[status] || "bg-slate-100 text-slate-600"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${status === "active" ? "bg-emerald-500" : "bg-slate-400"}`} />
      {status || "unknown"}
    </span>
  );
}

function ApiKeyPill({ connected }) {
  return connected ? (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-brand-50 text-brand-700 border border-brand-100">
      <KeyRound size={12} /> Connected
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-50 text-slate-500 border border-slate-200">
      No API key
    </span>
  );
}

function meterTypeFor(product) {
  const freq = product?.billing_frequency || "usage_based";
  if (freq === "usage_based") return "Sum";
  if (freq === "monthly" || freq === "recurring") return "Max";
  return "Last Value";
}

export default function UsageBillingPage() {
  const { formatCurrency, baseCurrency } = useCurrency();
  const navigate = useNavigate();
  const { confirm, ConfirmationDialog } = useConfirmationDialog();
  const [usageProducts, setUsageProducts] = useState([]);
  const [allProducts, setAllProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState({ from: "", to: "" });
  const [successMessage, setSuccessMessage] = useState(null);

  const [showCreate, setShowCreate] = useState(false);
  const [showTest, setShowTest] = useState(false);
  const [testProduct, setTestProduct] = useState(null);
  const [testQty, setTestQty] = useState("1");
  const [testEvent, setTestEvent] = useState(null);
  const [createForm, setCreateForm] = useState({
    name: "", code: "", unit_label: "unit", meter_type: "sum", unit_price: "", currency: baseCurrency,
    is_subscribable: false, description: "",
  });
  const [formLoading, setFormLoading] = useState(false);
  const [formError, setFormError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [usageRes, allRes] = await Promise.allSettled([
        productApi.listUsageBillable(),
        productApi.list({ per_page: 100, product_type: "usage" }),
      ]);
      if (usageRes.status === "fulfilled") setUsageProducts(extractArray(usageRes.value));
      if (allRes.status === "fulfilled") setAllProducts(extractArray(allRes.value));
      if (usageRes.status === "rejected" && allRes.status === "rejected") {
        setError("Failed to load usage data");
      }
    } catch (err) {
      setError(err.message || "Failed to load usage data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const mergedProducts = useMemo(() => {
    const merged = [...new Map([...usageProducts, ...allProducts].map((p) => [p.id, p])).values()];
    return merged.filter((p) => {
      const matchesSearch = !search || p.name?.toLowerCase().includes(search.toLowerCase()) || (p.code || "").toLowerCase().includes(search.toLowerCase());
      const createdAt = p.created_at ? new Date(p.created_at) : null;
      const from = dateRange.from ? new Date(`${dateRange.from}T00:00:00`) : null;
      const to = dateRange.to ? new Date(`${dateRange.to}T23:59:59`) : null;
      const matchesDate = (!from && !to) || (createdAt && (!from || createdAt >= from) && (!to || createdAt <= to));
      return matchesSearch && matchesDate;
    });
  }, [usageProducts, allProducts, search, dateRange]);

  const activeMeters = mergedProducts.filter((p) => p.status === "active");
  const totalBaseValue = activeMeters.reduce((s, p) => s + parseFloat(p.default_price || 0), 0);
  const activeCurrencies = [...new Set(activeMeters.map((p) => p.currency || baseCurrency))];
  const subscribableCount = mergedProducts.filter((p) => p.is_subscribable).length;
  const unitTypeCount = new Set(mergedProducts.map((p) => p.unit_label || "unit")).size;
  const meterTypeCount = new Set(mergedProducts.map(meterTypeFor)).size;

  const summaryCards = [
    { label: "Active Meters", value: activeMeters.length, sub: `${mergedProducts.length} total configured`, icon: Gauge, tint: "bg-amber-100 text-amber-700", iconBg: "bg-gradient-to-br from-amber-500 to-orange-500" },
    { label: "Meter Types", value: meterTypeCount, sub: "Sum · Max · Unique · Last", icon: Activity, tint: "bg-brand-50 text-brand-700", iconBg: "bg-gradient-to-br from-brand to-brand-hover" },
    { label: "Active Unit Price", value: totalBaseValue > 0 ? (activeCurrencies.length === 1 ? formatCurrency(totalBaseValue, activeCurrencies[0]) : "Mixed") : "—", sub: "Sum of active meter prices", icon: DollarSign, tint: "bg-blue-100 text-blue-700", iconBg: "bg-gradient-to-br from-blue-500 to-cyan-500" },
    { label: "Billing Model", value: subscribableCount > 0 ? "Hybrid" : "Pay-as-you-go", sub: `${subscribableCount} subscribable meter(s)`, icon: Zap, tint: "bg-emerald-100 text-emerald-700", iconBg: "bg-gradient-to-br from-emerald-500 to-green-500" },
  ];

  const handleCreateMeter = async () => {
    setFormLoading(true);
    setFormError(null);
    const price = parseFloat(createForm.unit_price || 0);
    if (!createForm.name) { setFormError("Meter name is required."); setFormLoading(false); return; }
    if (price < 0) { setFormError("Unit price cannot be negative."); setFormLoading(false); return; }
    try {
      await productApi.create({
        name: createForm.name,
        code: createForm.code || undefined,
        description: createForm.description || undefined,
        product_type: "usage",
        billing_frequency: "usage_based",
        unit_label: createForm.unit_label,
        default_price: price,
        currency: createForm.currency,
        is_usage_billable: true,
        is_subscribable: createForm.is_subscribable,
        is_active: true,
      });
      setShowCreate(false);
      setCreateForm({ name: "", code: "", unit_label: "unit", meter_type: "sum", unit_price: "", currency: baseCurrency, is_subscribable: false, description: "" });
      await fetchData();
      setSuccessMessage("Meter created successfully");
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err) {
      setFormError(err.message || "Failed to create meter");
    } finally {
      setFormLoading(false);
    }
  };

  const openTest = (product) => {
    setTestProduct(product);
    setTestQty("1");
    setTestEvent(null);
    setShowTest(true);
  };

  const runTestEvent = () => {
    const qty = parseFloat(testQty || 0) || 0;
    const price = parseFloat(testProduct?.default_price || 0) || 0;
    const now = new Date().toISOString();
    setTestEvent({
      event_id: `evt_${Date.now().toString(36)}`,
      timestamp: now,
      product_id: testProduct?.id,
      product_name: testProduct?.name,
      meter: meterTypeFor(testProduct),
      unit: testProduct?.unit_label || "unit",
      quantity: qty,
      unit_price: price,
      amount: +(qty * price).toFixed(2),
      status: "accepted",
    });
  };

  const handleDownloadLog = () => {
    const rows = mergedProducts.map((p) => [p.name, p.code || "—", meterTypeFor(p), p.unit_label || "unit", p.default_price || 0, p.status, p.is_subscribable ? "subscribable" : "pay-as-you-go"]);
    downloadCSV(rows, ["meter", "code", "meter_type", "unit", "unit_price", "status", "billing_model"], "usage-meters.csv");
    setSuccessMessage("Meter log exported");
    setTimeout(() => setSuccessMessage(null), 4000);
  };

  const handleDeactivate = async (product) => {
    const ok = await confirm({ title: "Deactivate meter", message: `Deactivate meter "${product.name}"? Usage events will stop billing.`, confirmLabel: "Deactivate", tone: "danger" });
    if (!ok) return;
    try {
      await productApi.bulkStatus([product.id], "inactive");
      await fetchData();
      setSuccessMessage("Meter deactivated");
      setTimeout(() => setSuccessMessage(null), 4000);
    } catch (err) {
      setError(err.message || "Failed to deactivate meter");
    }
  };

  if (loading) {
    return (
      <HRPage title="Usage Billing" subtitle="Metered billing products and usage-based revenue">
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      </HRPage>
    );
  }

  if (error && mergedProducts.length === 0) {
    return (
      <HRPage title="Usage Billing" subtitle="Metered billing products and usage-based revenue">
        <ErrorState message={error} onRetry={fetchData} />
      </HRPage>
    );
  }

  return (
    <HRPage
      title="Usage Billing"
      subtitle="Metered billing products and usage-based revenue"
      actions={
        <div className="flex items-center gap-2">
          <button onClick={() => { setShowCreate(true); setFormError(null); }}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-semibold shadow-sm hover:shadow-lg hover:shadow-brand-200 transition-all">
            <Plus size={18} /> Create Meter
          </button>
        </div>
      }
    >
      {successMessage && <SuccessMessage message={successMessage} onDismiss={() => setSuccessMessage(null)} />}

      {/* ── Meters Summary ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-5 mb-6">
        {summaryCards.map((card) => (
          <div key={card.label} className="bg-white rounded-2xl border border-slate-200 p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{card.label}</p>
                <p className="text-2xl font-extrabold text-slate-800 mt-2 leading-tight truncate">{card.value}</p>
                <p className="text-xs text-slate-400 mt-1 truncate">{card.sub}</p>
              </div>
              <div className={`h-10 w-10 rounded-xl ${card.iconBg} text-white flex items-center justify-center shrink-0 shadow-sm`}>
                <card.icon size={20} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Meter Config Table ── */}
      <div className="bg-white border border-slate-200 rounded-3xl shadow-[0_4px_20px_rgba(0,0,0,0.02)] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-brand" />
              <h3 className="text-base font-semibold text-slate-800">Meter Configuration</h3>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input type="text" placeholder="Search meters..." value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search usage products"
                  className="w-44 pl-9 pr-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div className="hidden lg:flex items-center gap-2">
                <Calendar size={14} className="text-slate-400" />
                <input type="date" value={dateRange.from} onChange={(e) => setDateRange((p) => ({ ...p, from: e.target.value }))}
                  aria-label="Filter from date"
                  className="px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                <span className="text-slate-400 text-sm">—</span>
                <input type="date" value={dateRange.to} onChange={(e) => setDateRange((p) => ({ ...p, to: e.target.value }))}
                  aria-label="Filter to date"
                  className="px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <button onClick={handleDownloadLog}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors">
                <Download size={14} /> Log CSV
              </button>
              <button onClick={() => { setRefreshing(true); fetchData(); }} disabled={refreshing}
                className="inline-flex items-center justify-center px-3 py-2 text-sm font-medium text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors disabled:opacity-50" aria-label="Refresh">
                <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>
        </div>

        {mergedProducts.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={BarChart3} title="No usage meters yet" message="Create a meter to start tracking usage-based revenue. Meters appear here once created with type 'Usage'."
              actionLabel="Create Meter" onAction={() => { setShowCreate(true); setFormError(null); }} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Meter</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Meter Type</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Unit</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Unit Price</th>
                  <th className="px-6 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">API Key</th>
                  <th className="px-6 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">Billing Model</th>
                  <th className="px-6 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {mergedProducts.map((product) => (
                  <tr key={product.id} className="hover:bg-slate-50/70 transition-colors group">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shrink-0 shadow-sm">
                          <Gauge className="h-4 w-4 text-white" />
                        </div>
                        <div className="min-w-0">
                          <button onClick={() => navigate(`/billing/products/${product.id}`)}
                            className="font-medium text-slate-800 hover:text-brand-700 hover:underline truncate block text-left">
                            {product.name || "Unnamed"}
                          </button>
                          {product.code && <p className="text-xs text-slate-400 font-mono">{product.code}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-violet-100 text-violet-700">
                        {meterTypeFor(product)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">{product.unit_label || "—"}</td>
                    <td className="px-6 py-4 text-right font-semibold text-slate-800 whitespace-nowrap">{formatCurrency(product.default_price || 0, product.currency || baseCurrency)}</td>
                    <td className="px-6 py-4 text-center"><ApiKeyPill connected={product.is_subscribable} /></td>
                    <td className="px-6 py-4 text-center">
                      <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                        <Zap size={12} className="text-brand" /> {product.is_subscribable ? "Subscribable" : "Pay-as-you-go"}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center"><StatusPill status={product.status} /></td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => openTest(product)} aria-label={`Test ${product.name}`}
                          className="p-2 rounded-lg hover:bg-violet-50 text-slate-400 hover:text-violet-600 transition-colors" title="Test API Event">
                          <FlaskConical size={16} />
                        </button>
                        <button onClick={() => navigate(`/billing/products/${product.id}`)} aria-label={`Configure ${product.name}`}
                          className="p-2 rounded-lg hover:bg-brand-50 text-slate-400 hover:text-brand-700 transition-colors" title="Configure">
                          <Settings2 size={16} />
                        </button>
                        {product.status === "active" && (
                          <button onClick={() => handleDeactivate(product)} aria-label={`Deactivate ${product.name}`}
                            className="p-2 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 transition-colors" title="Deactivate">
                            <X size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-400">{mergedProducts.length} meter(s) · {activeMeters.length} active</p>
          {dateRange.from && dateRange.to && (
            <p className="text-xs text-slate-400">Filtering by: {formatDisplayDate(dateRange.from)} — {formatDisplayDate(dateRange.to)}</p>
          )}
        </div>
      </div>

      {/* ── Create Meter Wizard ── */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-xl shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-slate-800">Create Meter</h2>
                <p className="text-sm text-slate-500 mt-0.5">Configure a metered, usage-based billing product</p>
              </div>
              <button onClick={() => setShowCreate(false)} aria-label="Close" className="p-1.5 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
            </div>
            {formError && (
              <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
                <AlertCircle size={16} /> {formError}
              </div>
            )}
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Meter Name *</label>
                  <input type="text" value={createForm.name} placeholder="e.g. API Requests"
                    onChange={(e) => setCreateForm((p) => ({ ...p, name: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Code</label>
                  <input type="text" value={createForm.code} placeholder="Auto-generated if blank"
                    onChange={(e) => setCreateForm((p) => ({ ...p, code: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Meter Type</label>
                  <select value={createForm.meter_type} onChange={(e) => setCreateForm((p) => ({ ...p, meter_type: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                    {METER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Unit</label>
                  <select value={createForm.unit_label} onChange={(e) => setCreateForm((p) => ({ ...p, unit_label: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                    {UNIT_OPTIONS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Unit Price *</label>
                  <input type="number" step="0.01" min="0" value={createForm.unit_price} placeholder="0.00"
                    onChange={(e) => setCreateForm((p) => ({ ...p, unit_price: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Currency</label>
                  <select value={createForm.currency} onChange={(e) => setCreateForm((p) => ({ ...p, currency: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand/30">
                    {["USD", "EUR", "GBP", "INR", "AUD", "CAD", "SGD"].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea rows={2} value={createForm.description} placeholder="Describe what this meter measures"
                  onChange={(e) => setCreateForm((p) => ({ ...p, description: e.target.value }))}
                  className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <label className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border border-slate-200 cursor-pointer">
                <div>
                  <p className="text-sm font-medium text-slate-700">Bill via subscription</p>
                  <p className="text-xs text-slate-400 mt-0.5">Include this meter in recurring subscription invoices</p>
                </div>
                <input type="checkbox" checked={createForm.is_subscribable}
                  onChange={(e) => setCreateForm((p) => ({ ...p, is_subscribable: e.target.checked }))}
                  className="h-5 w-5 rounded border-slate-300 text-brand-600 focus:ring-brand/30" />
              </label>
            </div>
            <div className="flex justify-end gap-3 mt-8">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
              <button onClick={handleCreateMeter} disabled={formLoading || !createForm.name}
                className="px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-semibold hover:shadow-lg disabled:opacity-50">
                {formLoading ? "Creating..." : "Create Meter"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Test API Event Tool ── */}
      {showTest && testProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4" onClick={() => setShowTest(false)}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-slate-800">Test API Event</h2>
                <p className="text-sm text-slate-500 mt-0.5">Simulate a usage event for {testProduct.name}</p>
              </div>
              <button onClick={() => setShowTest(false)} aria-label="Close" className="p-1.5 hover:bg-slate-100 rounded-lg"><X size={20} /></button>
            </div>
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 bg-slate-50 rounded-xl border border-slate-200">
                <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center shrink-0">
                  <Gauge className="h-4 w-4 text-white" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-800">{testProduct.name}</p>
                  <p className="text-xs text-slate-400">{meterTypeFor(testProduct)} · {testProduct.unit_label || "unit"} · {formatDisplayCurrency(testProduct.default_price, testProduct.currency || baseCurrency)} / unit</p>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Quantity</label>
                  <input type="number" step="0.01" min="0" value={testQty} onChange={(e) => setTestQty(e.target.value)}
                    className="w-full px-4 py-2.5 border border-slate-300 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div className="flex items-end">
                  <button onClick={runTestEvent}
                    className="w-full px-4 py-2.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-semibold transition-colors">
                    <FlaskConical size={16} className="inline mr-1.5 -mt-0.5" /> Send Event
                  </button>
                </div>
              </div>
              {testEvent && (
                <div className="rounded-xl overflow-hidden border border-slate-200">
                  <div className="flex items-center gap-2 px-4 py-2 bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                    <span className="inline-flex items-center gap-1.5 text-emerald-600 font-semibold">
                      <CheckCircle size={12} /> {testEvent.status}
                    </span>
                    <span className="font-mono">{testEvent.event_id}</span>
                    <span className="ml-auto font-mono text-slate-400">{new Date(testEvent.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <pre className="px-4 py-3 text-xs text-slate-700 bg-white overflow-x-auto font-mono leading-relaxed">
{JSON.stringify({
  event: testEvent.event_id,
  timestamp: testEvent.timestamp,
  product_id: testEvent.product_id,
  meter: testEvent.meter,
  quantity: testEvent.quantity,
  unit: testEvent.unit,
  unit_price: testEvent.unit_price,
  billed_amount: testEvent.amount,
  currency: testProduct.currency || baseCurrency,
  status: testEvent.status,
}, null, 2)}
                  </pre>
                </div>
              )}
            </div>
            <div className="flex justify-end mt-8">
              <button onClick={() => setShowTest(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Close</button>
            </div>
          </div>
        </div>
      )}

      {ConfirmationDialog}
    </HRPage>
  );
}
