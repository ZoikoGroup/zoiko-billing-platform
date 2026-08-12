import { useState, useEffect, useCallback, useMemo } from "react";
import { Users, BarChart3, PieChart as PieChartIcon } from "lucide-react";
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import HRPage from "../../../components/HRPage";
import { customerApi, invoiceApi } from "../../../service/billingService";
import { extractArray } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { formatCurrency } from "../../../utils/locale";
import { Spinner, EmptyState, ExportMenu, DateRangeFilter, useDateRange } from "../../../components/billing-shared";
import { downloadCSV, downloadExcel, downloadJSON, filterByDateRange } from "../../../utils/export-helpers";

const COLORS = ["#FF7A00", "#FF9B4D", "#FFC9A6", "#f59e0b", "#10b981", "#ef4444", "#3b82f6", "#ec4899", "#14b8a6", "#f97316"];
const DEFAULT_MARGIN = 0.3;

export default function CustomerProfitabilityReport() {
  const { baseCurrency } = useCurrency();
  const { range, setRange, customStart, setCustomStart, customEnd, setCustomEnd, dateRange } = useDateRange("all_time");

  const [customers, setCustomers] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [custResult, invResult] = await Promise.allSettled([
        customerApi.list({ per_page: 200 }),
        invoiceApi.list({ per_page: 500 }),
      ]);
      if (custResult.status === "rejected") throw new Error(custResult.reason?.detail || custResult.reason?.message || "Failed to load customers");
      setCustomers(extractArray(custResult.value));
      setInvoices(invResult.status === "fulfilled" ? extractArray(invResult.value) : []);
    } catch (err) {
      setError(err?.message || "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const filteredInvoices = useMemo(() => {
    return filterByDateRange(invoices, "issue_date", range, customStart, customEnd);
  }, [invoices, range, customStart, customEnd]);

  const profitabilityData = useMemo(() => {
    const revenueByCustomer = {};
    filteredInvoices.forEach((inv) => {
      const cid = inv.customer_id || inv.customerId;
      if (!cid) return;
      const name = inv.customer_name || inv.customerName || `Customer #${cid}`;
      if (!revenueByCustomer[cid]) revenueByCustomer[cid] = { id: cid, name, revenue: 0, invoiceCount: 0 };
      revenueByCustomer[cid].revenue += parseFloat(inv.total || inv.amount || 0);
      revenueByCustomer[cid].invoiceCount += 1;
    });

    return Object.values(revenueByCustomer).map((c) => {
      const costs = c.revenue * DEFAULT_MARGIN;
      const profit = c.revenue - costs;
      const margin = c.revenue > 0 ? (profit / c.revenue) * 100 : 0;
      return { ...c, costs, profit, margin };
    }).sort((a, b) => b.revenue - a.revenue);
  }, [filteredInvoices]);

  const kpis = useMemo(() => {
    if (profitabilityData.length === 0) {
      return { mostProfitable: null, leastProfitable: null, avgMargin: 0, totalRevenue: 0 };
    }
    const sorted = [...profitabilityData].sort((a, b) => b.profit - a.profit);
    const avgMargin = profitabilityData.reduce((s, c) => s + c.margin, 0) / profitabilityData.length;
    const totalRevenue = profitabilityData.reduce((s, c) => s + c.revenue, 0);
    return { mostProfitable: sorted[0], leastProfitable: sorted[sorted.length - 1], avgMargin, totalRevenue };
  }, [profitabilityData]);

  const top10 = useMemo(() => profitabilityData.slice(0, 10), [profitabilityData]);

  const pieData = useMemo(() => {
    return profitabilityData.slice(0, 8).map((c) => ({ name: c.name, value: c.revenue }));
  }, [profitabilityData]);

  const handleExportCSV = useCallback(() => {
    const headers = ["Customer", "Revenue", "Est. Costs", "Profit", "Margin %"];
    const rows = profitabilityData.map((c) => [c.name, c.revenue.toFixed(2), c.costs.toFixed(2), c.profit.toFixed(2), c.margin.toFixed(1)]);
    downloadCSV(rows, headers, `customer-profitability-${new Date().toISOString().slice(0, 10)}.csv`);
  }, [profitabilityData]);

  const handleExportExcel = useCallback(() => {
    const headers = ["Customer", "Revenue", "Est. Costs", "Profit", "Margin %"];
    const rows = profitabilityData.map((c) => [c.name, c.revenue, c.costs, c.profit, c.margin]);
    downloadExcel(rows, headers, `customer-profitability-${new Date().toISOString().slice(0, 10)}.xlsx`, "Profitability");
  }, [profitabilityData]);

  const handleExportJSON = useCallback(() => {
    downloadJSON(profitabilityData, `customer-profitability-${new Date().toISOString().slice(0, 10)}.json`);
  }, [profitabilityData]);

  if (loading) {
    return (
      <HRPage title="Customer Profitability Report" subtitle="Analyze revenue and profitability by customer">
        <Spinner />
      </HRPage>
    );
  }

  if (error) {
    return (
      <HRPage title="Customer Profitability Report" subtitle="Analyze revenue and profitability by customer">
        <EmptyState icon={BarChart3} title="Unable to load report" message={error} actionLabel="Retry" onAction={fetchData} />
      </HRPage>
    );
  }

  return (
    <HRPage title="Customer Profitability Report" subtitle="Analyze revenue and profitability by customer">
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <DateRangeFilter
            value={range} onChange={setRange}
            customStart={customStart} customEnd={customEnd}
            onCustomStartChange={setCustomStart} onCustomEndChange={setCustomEnd}
          />
          <ExportMenu
            onExportCSV={handleExportCSV}
            onExportExcel={handleExportExcel}
            onExportJSON={handleExportJSON}
            filename="customer-profitability"
          />
        </div>

        {profitabilityData.length === 0 ? (
          <EmptyState icon={Users} title="No profitability data" message="No customer revenue data found for the selected period." />
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Most Profitable</p>
                <p className="text-xl font-bold text-slate-900 mt-1 truncate" title={kpis.mostProfitable?.name}>{kpis.mostProfitable?.name || "—"}</p>
                <p className="text-xs text-emerald-600 font-semibold mt-0.5">{formatCurrency(kpis.mostProfitable?.profit || 0, baseCurrency)}</p>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Average Margin</p>
                <p className="text-xl font-bold text-slate-900 mt-1">{kpis.avgMargin.toFixed(1)}%</p>
                <p className="text-xs text-slate-400 mt-0.5">Across {profitabilityData.length} customers</p>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Total Revenue</p>
                <p className="text-xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(kpis.totalRevenue, baseCurrency)}</p>
                <p className="text-xs text-slate-400 mt-0.5">{filteredInvoices.length} invoices</p>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Least Profitable</p>
                <p className="text-xl font-bold text-slate-900 mt-1 truncate" title={kpis.leastProfitable?.name}>{kpis.leastProfitable?.name || "—"}</p>
                <p className="text-xs text-red-500 font-semibold mt-0.5">{formatCurrency(kpis.leastProfitable?.profit || 0, baseCurrency)}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
                <h3 className="text-sm font-semibold text-slate-800 mb-4">Top 10 Customers by Revenue</h3>
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart data={top10} layout="vertical" margin={{ left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={100} />
                    <Tooltip formatter={(v) => formatCurrency(v, baseCurrency)} />
                    <Bar dataKey="revenue" fill="#FF7A00" radius={[0, 4, 4, 0]} name="Revenue" />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
                <h3 className="text-sm font-semibold text-slate-800 mb-4">Revenue Distribution</h3>
                {pieData.length === 0 ? (
                  <EmptyState icon={PieChartIcon} title="No data" />
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <PieChart>
                      <Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value"
                        label={({ name, percent }) => percent >= 0.05 ? `${name.substring(0, 12)}${name.length > 12 ? "..." : ""} ${(percent * 100).toFixed(0)}%` : ""}>
                        {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v) => formatCurrency(v, baseCurrency)} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-slate-800">Customer Profitability Details</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200">
                      <th className="text-left py-3 px-3 text-xs font-semibold text-slate-500 uppercase">Customer</th>
                      <th className="text-right py-3 px-3 text-xs font-semibold text-slate-500 uppercase">Revenue</th>
                      <th className="text-right py-3 px-3 text-xs font-semibold text-slate-500 uppercase">Est. Costs</th>
                      <th className="text-right py-3 px-3 text-xs font-semibold text-slate-500 uppercase">Profit</th>
                      <th className="text-right py-3 px-3 text-xs font-semibold text-slate-500 uppercase">Margin %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profitabilityData.map((c) => (
                      <tr key={c.id} className="border-b border-slate-50 hover:bg-slate-50">
                        <td className="py-3 px-3 font-medium text-slate-800">{c.name}</td>
                        <td className="py-3 px-3 text-right text-slate-700">{formatCurrency(c.revenue, baseCurrency)}</td>
                        <td className="py-3 px-3 text-right text-slate-500">{formatCurrency(c.costs, baseCurrency)}</td>
                        <td className="py-3 px-3 text-right font-medium text-slate-800">{formatCurrency(c.profit, baseCurrency)}</td>
                        <td className="py-3 px-3 text-right">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${
                            c.margin >= 50 ? "bg-emerald-100 text-emerald-700" :
                            c.margin >= 20 ? "bg-amber-100 text-amber-700" :
                            "bg-red-100 text-red-700"
                          }`}>
                            {c.margin.toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </HRPage>
  );
}
