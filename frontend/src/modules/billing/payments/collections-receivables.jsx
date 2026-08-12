import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { BarChart3, RefreshCw,
  FileText, TrendingUp, Clock, Users } from "lucide-react"
import HRPage from "../../../components/HRPage";
import { collectionApi, invoiceApi } from "../../../service/billingService";
import { formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { sumInBaseCurrency } from "../../../utils/currency-conversion";
import { useCurrency } from "../utils/CurrencyContext";
import { ErrorState } from "../../../components/billing-shared";

function getStatusStyle(status) {
  const map = {
    open: "bg-blue-100 text-blue-700",
    in_progress: "bg-amber-100 text-amber-700",
    resolved: "bg-emerald-100 text-emerald-700",
    closed: "bg-slate-100 text-slate-500",
    escalated: "bg-red-100 text-red-700",
  };
  return map[status] || "bg-gray-100 text-gray-600";
}

export default function CollectionsReceivablesPage() {
  const navigate = useNavigate();
  const { baseCurrency } = useCurrency();

  const [activeTab, setActiveTab] = useState("overview");
  const [cases, setCases] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [agingData, setAgingData] = useState(null);
  const [queueData, setQueueData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [caseData, invData, aging, queue] = await Promise.all([
        collectionApi.listCases({ per_page: 50 }),
        invoiceApi.list({ per_page: 50, status: "sent" }).catch(() => ({ items: [] })),
        collectionApi.getAgingBuckets().catch(() => null),
        collectionApi.getCollectionsQueue().catch(() => null),
      ]);
      setCases(extractArray(caseData));
      setInvoices(extractArray(invData));
      // The backend returns aging as a dict (legacy "0_30"/"31_60"/... keys
      // for API consumers that pre-date this report) plus a `buckets` array
      // shaped for this exact table — use that directly rather than running
      // the whole dict through extractArray (which can't coerce a
      // dict-of-dicts into the array this UI needs).
      setAgingData(aging?.buckets && Array.isArray(aging.buckets) ? aging.buckets : null);
      setQueueData(extractArray(queue));
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const totalInCollections = cases.filter((c) => c.status !== "resolved" && c.status !== "closed").length;
  const resolvedCount = cases.filter((c) => c.status === "resolved").length;
  const totalOutstanding = sumInBaseCurrency(invoices, baseCurrency).total;
  const recoveryRate = cases.length > 0 ? Math.round((resolvedCount / cases.length) * 100) : 0;
  const avgDaysOutstanding = invoices.length > 0
    ? Math.round(invoices.reduce((s, inv) => {
        if (!inv.due_date) return s;
        const diff = Math.floor((new Date() - new Date(inv.due_date)) / (1000 * 60 * 60 * 24));
        return s + Math.max(0, diff);
      }, 0) / invoices.length)
    : 0;

  const tabs = [
    { key: "overview", label: "Overview" },
    { key: "queue", label: "Collections Queue" },
    { key: "aging", label: "Aging Summary" },
  ];

  if (loading) {
    return (
      <HRPage title="Collections & Receivables" subtitle="Combined collections and receivables management">
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      </HRPage>
    );
  }

  if (error) {
    return (
      <HRPage title="Collections & Receivables" subtitle="Error loading data">
        <ErrorState message={error} onRetry={fetchData} />
      </HRPage>
    );
  }

  return (
    <HRPage
      title="Collections & Receivables"
      subtitle="Monitor and manage collections activities"
      actions={
        <div className="flex items-center gap-2">
          <button onClick={() => navigate("/billing/promise-to-pay")}
            className="px-3 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
            Promise to Pay
          </button>
          <button onClick={() => navigate("/billing/collections/dashboard")}
            className="px-3 py-2 text-sm font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50">
            Dashboard
          </button>
          <button onClick={refreshAll} disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5 min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 mb-2">
            <Users className="h-5 w-5 text-brand-500 shrink-0" />
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider truncate">In Collections</p>
          </div>
          <p className="text-xl font-bold text-gray-900 whitespace-nowrap">{totalInCollections}</p>
          <p className="text-xs text-gray-400 mt-1 whitespace-nowrap" title={formatDisplayCurrency(totalOutstanding, baseCurrency)}>{formatDisplayCurrency(totalOutstanding, baseCurrency)} outstanding</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5 min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="h-5 w-5 text-emerald-500 shrink-0" />
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider truncate">Recovery Rate</p>
          </div>
          <p className="text-xl font-bold text-emerald-600 whitespace-nowrap">{recoveryRate}%</p>
          <p className="text-xs text-gray-400 mt-1">{resolvedCount} resolved cases</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5 min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-5 w-5 text-amber-500 shrink-0" />
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wider truncate">Avg Days Outstanding</p>
          </div>
          <p className="text-xl font-bold text-amber-600 whitespace-nowrap">{avgDaysOutstanding}d</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200">
        <div className="border-b border-gray-200">
          <div className="flex">
            {tabs.map((tab) => (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.key
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
                }`}>
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6">
          {activeTab === "overview" && (
            <div className="space-y-6">
              <h3 className="text-base font-semibold text-gray-900">Active Collections Cases</h3>
              {cases.filter((c) => c.status !== "resolved" && c.status !== "closed").length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <BarChart3 className="h-8 w-8 text-gray-300 mb-2" />
                  <p className="text-sm text-gray-500">No active collections cases</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase">Case</th>
                        <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase">Customer</th>
                        <th className="text-right py-3 px-4 font-medium text-gray-500 text-xs uppercase">Outstanding</th>
                        <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase">Status</th>
                        <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cases.filter((c) => c.status !== "resolved" && c.status !== "closed").map((c) => (
                        <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-3 px-4 font-medium text-gray-900">{c.case_number || `#${c.id}`}</td>
                          <td className="py-3 px-4 text-gray-600">{c.customer_name || `#${c.customer_id}`}</td>
                          <td className="py-3 px-4 text-right font-medium text-gray-900">{formatDisplayCurrency(c.total_outstanding, c.currency)}</td>
                          <td className="py-3 px-4">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getStatusStyle(c.status)}`}>
                              {c.status ? c.status.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()) : "Unknown"}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <button onClick={() => navigate(`/billing/collections/${c.id}`)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-brand-600 bg-brand-50 rounded-lg hover:bg-brand-100">
                              <FileText className="h-3.5 w-3.5" /> View
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeTab === "queue" && (
            <div className="space-y-4">
              <h3 className="text-base font-semibold text-gray-900">Collections Queue</h3>
              {!queueData ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <BarChart3 className="h-8 w-8 text-gray-300 mb-2" />
                  <p className="text-sm text-gray-500">Queue data not available</p>
                </div>
              ) : Array.isArray(queueData) && queueData.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <BarChart3 className="h-8 w-8 text-gray-300 mb-2" />
                  <p className="text-sm text-gray-500">Queue is empty</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase">Priority</th>
                        <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase">Case</th>
                        <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase">Customer</th>
                        <th className="text-right py-3 px-4 font-medium text-gray-500 text-xs uppercase">Amount</th>
                        <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase">Days Overdue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(Array.isArray(queueData) ? queueData : []).map((item, i) => (
                        <tr key={item.id || i} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-3 px-4">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                              item.priority === "urgent" ? "bg-red-100 text-red-700" :
                              item.priority === "high" ? "bg-orange-100 text-orange-700" :
                              "bg-blue-100 text-blue-700"
                            }`}>
                              {item.priority || "Normal"}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-medium text-gray-900">{item.case_number || `#${item.id}`}</td>
                          <td className="py-3 px-4 text-gray-600">{item.customer_name || `#${item.customer_id}`}</td>
                          <td className="py-3 px-4 text-right font-medium text-gray-900">{formatDisplayCurrency(item.total_outstanding || item.amount, item.currency)}</td>
                          <td className="py-3 px-4 text-gray-600">{item.days_overdue || 0}d</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {activeTab === "aging" && (
            <div className="space-y-4">
              <h3 className="text-base font-semibold text-gray-900">Aging Summary</h3>
              {!agingData ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <BarChart3 className="h-8 w-8 text-gray-300 mb-2" />
                  <p className="text-sm text-gray-500">Aging data not available</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left py-3 px-4 font-medium text-gray-500 text-xs uppercase">Bucket</th>
                        <th className="text-right py-3 px-4 font-medium text-gray-500 text-xs uppercase">Count</th>
                        <th className="text-right py-3 px-4 font-medium text-gray-500 text-xs uppercase">Total Amount</th>
                        <th className="text-right py-3 px-4 font-medium text-gray-500 text-xs uppercase">Percentage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.isArray(agingData) ? agingData.map((bucket, i) => (
                        <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                          <td className="py-3 px-4 font-medium text-gray-900">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                              bucket.name === "Current" ? "bg-emerald-100 text-emerald-700" :
                              bucket.name?.includes("31") || bucket.name?.includes("61") ? "bg-amber-100 text-amber-700" :
                              "bg-red-100 text-red-700"
                            }`}>
                              {bucket.name || bucket.bucket || `Bucket ${i + 1}`}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right text-gray-900 font-medium">{bucket.count || 0}</td>
                          <td className="py-3 px-4 text-right text-gray-900 font-medium">{formatDisplayCurrency(bucket.total_amount || bucket.amount || 0)}</td>
                          <td className="py-3 px-4 text-right text-gray-600">{bucket.percentage || 0}%</td>
                        </tr>
                      )) : (
                        <tr>
                          <td colSpan={4} className="py-8 text-center text-gray-500">
                            <div className="flex flex-col items-center">
                              <BarChart3 className="h-8 w-8 text-gray-300 mb-2" />
                              <p className="text-sm">No aging data available</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </HRPage>
  );
}
