import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  BarChart3, RefreshCw, Users, TrendingUp, Clock, FileText,
} from "lucide-react"
import { collectionApi, invoiceApi } from "../../../service/billingService";
import { formatDisplayCurrency, extractArray } from "../../../utils/billing-helpers";
import { sumInBaseCurrency } from "../../../utils/currency-conversion";
import { useCurrency } from "../utils/CurrencyContext";
import {
  ErrorState, DashboardHeader, DashboardStatCard, DashboardStatCardSkeleton,
  DASHBOARD_KPI_GRID, StatusBadge, DOMAIN_ACCENTS,
} from "../../../components/billing-shared";
import { Button, DataTable } from "../../../components/billing-ui";

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
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      if (!loading) setRefreshing(true);
      const [caseData, invData, aging, queue] = await Promise.all([
        collectionApi.listCases({ per_page: 50 }),
        invoiceApi.list({ per_page: 50, status: "sent" }).catch(() => ({ items: [] })),
        collectionApi.getAgingBuckets().catch(() => null),
        collectionApi.getCollectionsQueue().catch(() => undefined),
      ]);
      setCases(extractArray(caseData));
      setInvoices(extractArray(invData));
      // The backend returns aging as a dict (legacy "0_30"/"31_60"/... keys
      // for API consumers that pre-date this report) plus a `buckets` array
      // shaped for this exact table — use that directly rather than running
      // the whole dict through extractArray (which can't coerce a
      // dict-of-dicts into the array this UI needs).
      setAgingData(aging?.buckets && Array.isArray(aging.buckets) ? aging.buckets : null);
      // undefined sentinel = endpoint failed (→ "not available");
      // empty array = endpoint succeeded but queue is genuinely empty.
      setQueueData(queue === undefined ? null : extractArray(queue));
      setLastUpdated(new Date());
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load data");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  /* Derived summary metrics. Computed over the fetched windows (latest 50
     cases / latest 50 sent invoices), so they are indicative of recent
     activity rather than all-time totals — disclosed in the caption below. */
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

  const activeCases = cases.filter((c) => c.status !== "resolved" && c.status !== "closed");

  const caseColumns = [
    {
      key: "case_number",
      label: "Case",
      render: (c) => <span className="font-medium text-slate-900">{c.case_number || `#${c.id}`}</span>,
    },
    {
      key: "customer_name",
      label: "Customer",
      render: (c) => <span>{c.customer_name || `#${c.customer_id}`}</span>,
    },
    {
      key: "total_outstanding",
      label: "Outstanding",
      align: "right",
      render: (c) => <span className="font-medium whitespace-nowrap">{formatDisplayCurrency(c.total_outstanding, c.currency)}</span>,
    },
    {
      key: "status",
      label: "Status",
      render: (c) => <StatusBadge status={c.status} />,
    },
    {
      key: "actions",
      label: "Actions",
      align: "right",
      render: (c) => (
        <button type="button" onClick={() => navigate(`/billing/collections/${c.id}`)} aria-label={`View collections case ${c.case_number || c.id}`}
          className="inline-flex items-center gap-1 rounded-lg bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand-600 transition-colors hover:bg-brand-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50">
          <FileText className="h-3.5 w-3.5" /> View
        </button>
      ),
    },
  ];

  const queueColumns = [
    {
      key: "priority",
      label: "Priority",
      render: (item) => (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          item.priority === "urgent" ? "bg-red-100 text-red-700" :
          item.priority === "high" ? "bg-orange-100 text-orange-700" :
          "bg-blue-100 text-blue-700"
        }`}>
          {item.priority || "Normal"}
        </span>
      ),
    },
    {
      key: "case_number",
      label: "Case",
      render: (item) => <span className="font-medium text-slate-900">{item.case_number || `#${item.id}`}</span>,
    },
    {
      key: "customer_name",
      label: "Customer",
      render: (item) => <span>{item.customer_name || `#${item.customer_id}`}</span>,
    },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      render: (item) => <span className="font-medium whitespace-nowrap">{formatDisplayCurrency(item.total_outstanding || item.amount, item.currency)}</span>,
    },
    {
      key: "days_overdue",
      label: "Days Overdue",
      render: (item) => <span>{item.days_overdue || 0}d</span>,
    },
  ];

  const agingColumns = [
    {
      key: "bucket",
      label: "Bucket",
      render: (bucket, i) => (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
          bucket.name === "Current" ? "bg-emerald-100 text-emerald-700" :
          bucket.name?.includes("31") || bucket.name?.includes("61") ? "bg-amber-100 text-amber-700" :
          "bg-red-100 text-red-700"
        }`}>
          {bucket.name || bucket.bucket || `Bucket ${i + 1}`}
        </span>
      ),
    },
    {
      key: "count",
      label: "Count",
      align: "right",
      render: (bucket) => <span className="font-medium">{bucket.count || 0}</span>,
    },
    {
      key: "total_amount",
      label: "Total Amount",
      align: "right",
      render: (bucket) => <span className="font-medium whitespace-nowrap">{formatDisplayCurrency(bucket.total_amount || bucket.amount || 0)}</span>,
    },
    {
      key: "percentage",
      label: "Percentage",
      align: "right",
      render: (bucket) => <span>{bucket.percentage || 0}%</span>,
    },
  ];

  if (error && !loading && cases.length === 0) {
    return (
      <div className="space-y-8">
        <DashboardHeader
          title="Collections & Receivables"
          subtitle="Combined collections and receivables management"
          icon={BarChart3}
          iconGradient={DOMAIN_ACCENTS.collections.chip}
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Collections", href: "/billing/collections/dashboard" }, {}]}
          lastUpdated={lastUpdated}
          onRefresh={fetchData}
          refreshing={refreshing}
        />
        <ErrorState message={error} onRetry={fetchData} />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <DashboardHeader
        title="Collections & Receivables"
        subtitle="Monitor and manage collections activities"
        icon={BarChart3}
        iconGradient={DOMAIN_ACCENTS.collections.chip}
        crumbs={[{ label: "Billing", href: "/billing" }, { label: "Collections", href: "/billing/collections/dashboard" }, {}]}
        lastUpdated={lastUpdated}
        onRefresh={fetchData}
        refreshing={refreshing}
      />

      {/* Server-backed KPIs */}
      <div>
        <div className={DASHBOARD_KPI_GRID}>
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)
          ) : (
            <>
              <DashboardStatCard title="In Collections" value={totalInCollections.toLocaleString()} subtitle={`${formatDisplayCurrency(totalOutstanding, baseCurrency)} outstanding`} icon={Users} color={DOMAIN_ACCENTS.collections.chip} />
              <DashboardStatCard title="Recovery Rate" value={`${recoveryRate}%`} subtitle={`${resolvedCount} resolved case${resolvedCount === 1 ? "" : "s"}`} icon={TrendingUp} color="from-emerald-500 to-teal-500" />
              <DashboardStatCard title="Avg Days Outstanding" value={`${avgDaysOutstanding}d`} icon={Clock} color="from-amber-500 to-orange-500" />
            </>
          )}
        </div>
        {!loading && (
          <p className="mt-2 text-xs text-slate-400">
            Based on the latest {cases.length} collection case{cases.length === 1 ? "" : "s"} and {invoices.length} sent invoice{invoices.length === 1 ? "" : "s"}.
          </p>
        )}
      </div>

      <div className="-mt-4 flex items-center gap-2">
        <Button variant="secondary" onClick={() => navigate("/billing/promise-to-pay")}>Promise to Pay</Button>
        <Button variant="secondary" onClick={() => navigate("/billing/collections/dashboard")}>Dashboard</Button>
        <Button variant="ghost" onClick={fetchData} loading={refreshing} icon={RefreshCw}>Refresh</Button>
      </div>

      <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white card-shadow">
        <div className="border-b border-slate-200">
          <div className="flex" role="tablist" aria-label="Collections and receivables views">
            {tabs.map((tab) => (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)} role="tab"
                aria-selected={activeTab === tab.key}
                className={`border-b-2 px-5 py-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 ${
                  activeTab === tab.key
                    ? "border-brand-600 text-brand-700"
                    : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"
                }`}>
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6">
          {activeTab === "overview" && (
            <DataTable
              columns={caseColumns}
              data={activeCases}
              loading={loading}
              minWidth={720}
              stickyHeader={false}
              emptyIcon={BarChart3}
              emptyTitle="No active collections cases"
              emptyMessage="Escalated dunning cases will appear here."
            />
          )}

          {activeTab === "queue" && (
            !queueData ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <BarChart3 className="mb-2 h-8 w-8 text-slate-300" />
                <p className="text-sm text-slate-500">Queue data not available</p>
              </div>
            ) : (
              <DataTable
                columns={queueColumns}
                data={Array.isArray(queueData) ? queueData : []}
                loading={loading}
                minWidth={720}
                stickyHeader={false}
                emptyIcon={BarChart3}
                emptyTitle="Queue is empty"
                emptyMessage="No receivables are currently prioritized for collections."
              />
            )
          )}

          {activeTab === "aging" && (
            !agingData ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <BarChart3 className="mb-2 h-8 w-8 text-slate-300" />
                <p className="text-sm text-slate-500">Aging data not available</p>
              </div>
            ) : (
              <DataTable
                columns={agingColumns}
                data={agingData}
                minWidth={640}
                stickyHeader={false}
                rowKey={(b, i) => `${b.name || b.bucket || i}`}
                emptyIcon={BarChart3}
                emptyTitle="No aging data available"
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}
