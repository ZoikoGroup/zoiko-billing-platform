import { useState, useEffect, useCallback } from "react";
import { BarChart3, RefreshCw, Zap, DollarSign, Activity, Calendar, Search } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { productApi } from "../../../service/billingService";
import { formatDisplayDate, extractArray } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { Spinner, ErrorState, EmptyState } from "../../../components/billing-shared";

function StatusBadge({ status }) {
  const styles = { active: "bg-emerald-100 text-emerald-700", inactive: "bg-gray-100 text-gray-600" };
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${styles[status] || "bg-slate-100 text-slate-600"}`}>
      {status || "unknown"}
    </span>
  );
}

export default function UsageBillingPage() {
  const { formatCurrency, baseCurrency } = useCurrency();
  const [usageProducts, setUsageProducts] = useState([]);
  const [allProducts, setAllProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState({ from: "", to: "" });

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

  const mergedProducts = [...new Map(
    [...usageProducts, ...allProducts].map((p) => [p.id, p])
  ).values()].filter((p) => {
    const matchesSearch = !search || p.name?.toLowerCase().includes(search.toLowerCase()) || (p.code || "").toLowerCase().includes(search.toLowerCase());
    const createdAt = p.created_at ? new Date(p.created_at) : null;
    const from = dateRange.from ? new Date(`${dateRange.from}T00:00:00`) : null;
    const to = dateRange.to ? new Date(`${dateRange.to}T23:59:59`) : null;
    const matchesDate = (!from && !to) || (createdAt && (!from || createdAt >= from) && (!to || createdAt <= to));
    return matchesSearch && matchesDate;
  });

  const activeUsageProducts = mergedProducts.filter((p) => p.status === "active");
  const totalBaseValue = activeUsageProducts.reduce((s, p) => s + parseFloat(p.default_price || 0), 0);
  const activeCurrencies = [...new Set(activeUsageProducts.map((p) => p.currency || baseCurrency))];
  const subscribableCount = mergedProducts.filter((p) => p.is_subscribable).length;

  if (loading) {
    return (
      <HRPage title="Usage Billing" subtitle="Manage usage-based billing products">
        <Spinner />
      </HRPage>
    );
  }

  if (error && mergedProducts.length === 0) {
    return (
      <HRPage title="Usage Billing" subtitle="Manage usage-based billing products">
        <ErrorState message={error} onRetry={fetchData} />
      </HRPage>
    );
  }

  return (
    <HRPage title="Usage Billing" subtitle="Manage usage-based billing products">

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Usage Products</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">{mergedProducts.length}</p>
              <p className="text-xs text-gray-400 mt-1">{activeUsageProducts.length} active</p>
            </div>
            <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-amber-100">
              <BarChart3 className="h-5 w-5 text-amber-600" />
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Active Products</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">{activeUsageProducts.length}</p>
              <p className="text-xs text-gray-400 mt-1">{mergedProducts.length ? ((activeUsageProducts.length / mergedProducts.length) * 100).toFixed(0) : 0}% of total</p>
            </div>
            <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-emerald-100">
              <Zap className="h-5 w-5 text-emerald-600" />
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Base Value</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">{totalBaseValue > 0 ? (activeCurrencies.length === 1 ? formatCurrency(totalBaseValue, activeCurrencies[0]) : "Mixed currencies") : "—"}</p>
              <p className="text-xs text-gray-400 mt-1">Sum of active product prices</p>
            </div>
            <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-blue-100">
              <DollarSign className="h-5 w-5 text-blue-600" />
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Subscribable</p>
              <p className="text-2xl font-bold text-gray-900 mt-1">{subscribableCount}</p>
              <p className="text-xs text-gray-400 mt-1">{subscribableCount > 0 ? "Bill via subscription" : "Pay-as-you-go"}</p>
            </div>
            <div className="h-10 w-10 rounded-lg flex items-center justify-center bg-brand-100">
              <Activity className="h-5 w-5 text-brand-600" />
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-3xl shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-semibold text-slate-800">Usage-Based Products</h3>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input type="text" placeholder="Search..." value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search usage products"
                  className="w-48 pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div className="flex items-center gap-2">
                <Calendar size={14} className="text-slate-400" />
                <input type="date" value={dateRange.from} onChange={(e) => setDateRange((p) => ({ ...p, from: e.target.value }))}
                  aria-label="Filter from date"
                  className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                <span className="text-slate-400 text-sm">—</span>
                <input type="date" value={dateRange.to} onChange={(e) => setDateRange((p) => ({ ...p, to: e.target.value }))}
                  aria-label="Filter to date"
                  className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <button onClick={() => { setRefreshing(true); fetchData(); }} disabled={refreshing}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50">
                <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
              </button>
            </div>
          </div>
        </div>

        {mergedProducts.length === 0 ? (
          <div className="p-6">
            <EmptyState icon={BarChart3} title="No usage-based products" message="Usage-based products will appear here once created with type 'Usage'." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Product</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Code</th>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Unit / Meter</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-slate-500 uppercase tracking-wider">Unit Price</th>
                  <th className="px-6 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">Billing Model</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {mergedProducts.map((product) => (
                  <tr key={product.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-amber-100 flex items-center justify-center">
                          <Activity className="h-4 w-4 text-amber-600" />
                        </div>
                        <div>
                          <p className="font-medium text-slate-800">{product.name || "Unnamed"}</p>
                          {product.description && <p className="text-xs text-slate-400 line-clamp-1">{product.description}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600 font-mono">{product.code || "—"}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">
                      {product.unit_label || "—"}
                    </td>
                    <td className="px-6 py-4 text-right font-medium text-slate-800">{formatCurrency(product.default_price || 0, product.currency || baseCurrency)}</td>
                    <td className="px-6 py-4 text-center"><StatusBadge status={product.status} /></td>
                    <td className="px-6 py-4 text-center">
                      <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                        <Zap size={12} /> {product.is_subscribable ? "Subscribable" : "Pay-as-you-go"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="px-6 py-3 border-t border-slate-100 bg-slate-50/50 flex items-center justify-between">
          <p className="text-xs text-slate-400">{mergedProducts.length} usage-based product(s)</p>
          {dateRange.from && dateRange.to && (
            <p className="text-xs text-slate-400">
              Filtering by: {formatDisplayDate(dateRange.from)} — {formatDisplayDate(dateRange.to)}
            </p>
          )}
        </div>
      </div>
    </HRPage>
  );
}
