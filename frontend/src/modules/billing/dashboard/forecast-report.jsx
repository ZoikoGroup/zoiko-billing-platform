import { useState, useEffect, useCallback, useMemo } from "react";
import {
  BarChart3,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { dashboardApi, invoiceApi, paymentApi, subscriptionApi } from "../../../service/billingService";
import { extractArray } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { formatCurrency } from "../../../utils/locale";
import { Spinner, EmptyState, DashboardHeader } from "../../../components/billing-shared";
import { downloadCSV, downloadExcel, downloadJSON } from "../../../utils/export-helpers";

function simpleLinearRegression(data) {
  const n = data.length;
  if (n < 2) return { slope: 0, intercept: data[0]?.y ?? 0, r2: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  data.forEach((p) => {
    sumX += p.x;
    sumY += p.y;
    sumXY += p.x * p.y;
    sumX2 += p.x * p.x;
  });
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n, r2: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  const meanY = sumY / n;
  let ssRes = 0, ssTot = 0;
  data.forEach((p) => {
    const predicted = slope * p.x + intercept;
    ssRes += (p.y - predicted) ** 2;
    ssTot += (p.y - meanY) ** 2;
  });
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { slope, intercept, r2 };
}

function getMonthLabel(date) {
  return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

export default function ForecastReport() {
  const { baseCurrency } = useCurrency();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [revenueData, setRevenueData] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [payments, setPayments] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [currentMRR, setCurrentMRR] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const results = await Promise.allSettled([
        dashboardApi.getMonthlyRevenue(12),
        invoiceApi.list({ per_page: 500 }),
        paymentApi.list({ per_page: 500 }),
        subscriptionApi.list({ per_page: 200 }),
        subscriptionApi.getReporting(),
      ]);
      const safe = (r, transform) => r.status === "fulfilled" ? (transform ? transform(r.value) : r.value) : [];
      setRevenueData(safe(results[0], extractArray));
      setInvoices(safe(results[1], extractArray));
      setPayments(safe(results[2], extractArray));
      setSubscriptions(safe(results[3], extractArray));
      setCurrentMRR(results[4].status === "fulfilled" && results[4].value?.mrr != null ? parseFloat(results[4].value.mrr) : null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err?.message || "Failed to load forecast data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const monthlyMetrics = useMemo(() => {
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = addMonths(now, -i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      months.push({ key, label: getMonthLabel(d), revenue: 0, mrr: 0, collected: 0 });
    }

    if (revenueData.length > 0) {
      revenueData.forEach((r) => {
        const period = r.month || r.period || "";
        const match = months.find((m) => period.startsWith(m.key));
        if (match) match.revenue += parseFloat(r.revenue || r.amount || 0);
      });
    }

    invoices.forEach((inv) => {
      const d = inv.issue_date || inv.created_at || "";
      if (!d) return;
      const period = d.slice(0, 7);
      const match = months.find((m) => m.key === period);
      if (match && (inv.status === "paid" || inv.status === "pending" || inv.status === "unpaid")) {
        match.collected += parseFloat(inv.total || inv.amount || 0);
      }
    });

    payments.forEach((p) => {
      const d = p.payment_date || p.created_at || "";
      if (!d) return;
      const period = d.slice(0, 7);
      const match = months.find((m) => m.key === period);
      if (match) match.collected += parseFloat(p.amount || 0);
    });

    // Anchor the trend on the real, authoritative MRR from
    // subscriptionApi.getReporting() (the same monthly-normalized,
    // currency-aware figure used on the Subscriptions Reports page) rather
    // than an arbitrary "revenue * 0.8" guess. There's no historical MRR
    // series to draw on, so earlier months are estimated by scaling the
    // current MRR by that month's share of the latest month's revenue —
    // an approximation, but one grounded in a real current data point
    // instead of a made-up ratio.
    const latestRevenue = months[months.length - 1]?.revenue || 0;
    months.forEach((m) => {
      if (currentMRR != null) {
        m.mrr = latestRevenue > 0 ? currentMRR * (m.revenue / latestRevenue) : currentMRR;
      } else {
        const activeSubs = subscriptions.filter((s) => s.status === "active");
        const avgSubRevenue = activeSubs.length > 0
          ? activeSubs.reduce((s, sub) => s + parseFloat(sub.unit_price || sub.amount || sub.price || 0), 0) / activeSubs.length
          : 0;
        m.mrr = m.revenue > 0 ? m.revenue * 0.8 : avgSubRevenue * activeSubs.length;
      }
    });

    return months;
  }, [revenueData, invoices, payments, subscriptions, currentMRR]);

  const forecast = useMemo(() => {
    const revenuePoints = monthlyMetrics.map((m, i) => ({ x: i, y: m.revenue }));
    const mrrPoints = monthlyMetrics.map((m, i) => ({ x: i, y: m.mrr }));
    const collectedPoints = monthlyMetrics.map((m, i) => ({ x: i, y: m.collected }));

    const revenueReg = simpleLinearRegression(revenuePoints);
    const mrrReg = simpleLinearRegression(mrrPoints);
    const collectedReg = simpleLinearRegression(collectedPoints);

    const now = new Date();
    const forecastMonths = [];
    const combinedChart = monthlyMetrics.map((m) => ({
      name: m.label,
      Revenue: Math.round(m.revenue * 100) / 100,
      MRR: Math.round(m.mrr * 100) / 100,
      Forecast: null,
      "MRR Forecast": null,
    }));

    for (let i = 1; i <= 6; i++) {
      const idx = 12 + i - 1;
      const d = addMonths(now, i);
      const label = getMonthLabel(d);
      const rev = Math.max(0, revenueReg.slope * idx + revenueReg.intercept);
      const mrr = Math.max(0, mrrReg.slope * idx + mrrReg.intercept);
      const coll = Math.max(0, collectedReg.slope * idx + collectedReg.intercept);
      forecastMonths.push({ month: label, revenue: rev, mrr, collected: coll });
      combinedChart.push({
        name: label,
        Revenue: null,
        MRR: null,
        Forecast: Math.round(rev * 100) / 100,
        "MRR Forecast": Math.round(mrr * 100) / 100,
      });
    }

    const totalHistoricRevenue = monthlyMetrics.reduce((s, m) => s + m.revenue, 0);
    const totalForecastRevenue = forecastMonths.reduce((s, m) => s + m.revenue, 0);
    const avgGrowth = monthlyMetrics.length >= 2
      ? ((monthlyMetrics[monthlyMetrics.length - 1].mrr - monthlyMetrics[0].mrr) / Math.max(monthlyMetrics[0].mrr, 1)) * 100
      : 0;
    const projectedMRR = forecastMonths.length > 0 ? forecastMonths[forecastMonths.length - 1].mrr : 0;
    const confidence = Math.min(100, Math.max(0, Math.round(revenueReg.r2 * 100)));

    return { forecastMonths, combinedChart, totalHistoricRevenue, totalForecastRevenue, avgGrowth, projectedMRR, confidence };
  }, [monthlyMetrics]);

  const handleExportCSV = useCallback(() => {
    const headers = ["Month", "Forecast Revenue", "Forecast MRR", "Expected Collections"];
    const rows = forecast.forecastMonths.map((m) => [m.month, m.revenue.toFixed(2), m.mrr.toFixed(2), m.collected.toFixed(2)]);
    downloadCSV(rows, headers, `forecast-report-${new Date().toISOString().slice(0, 10)}.csv`);
  }, [forecast]);

  const handleExportExcel = useCallback(() => {
    const headers = ["Month", "Forecast Revenue", "Forecast MRR", "Expected Collections"];
    const rows = forecast.forecastMonths.map((m) => [m.month, m.revenue, m.mrr, m.collected]);
    downloadExcel(rows, headers, `forecast-report-${new Date().toISOString().slice(0, 10)}.xlsx`, "Forecast");
  }, [forecast]);

  const handleExportJSON = useCallback(() => {
    downloadJSON({ monthlyMetrics, forecast: forecast.forecastMonths }, `forecast-report-${new Date().toISOString().slice(0, 10)}.json`);
  }, [monthlyMetrics, forecast]);

  const headerProps = {
    title: "Forecast Report",
    subtitle: "Revenue and MRR forecast projections",
    icon: BarChart3,
    iconGradient: "from-[#2563EB] to-[#1D4ED8]",
    lastUpdated,
    refreshing,
    onRefresh: () => { setRefreshing(true); fetchData().finally(() => setRefreshing(false)); },
    onExportCSV: handleExportCSV,
    onExportExcel: handleExportExcel,
    onExportJSON: handleExportJSON,
  };

  if (loading) {
    return (
      <div className="bg-transparent text-slate-800 p-6 font-sans min-h-screen space-y-8">
        <DashboardHeader {...headerProps} />
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-transparent text-slate-800 p-6 font-sans min-h-screen space-y-8">
        <DashboardHeader {...headerProps} />
        <EmptyState icon={BarChart3} title="Unable to load forecast" message={error} actionLabel="Retry" onAction={fetchData} />
      </div>
    );
  }

  return (
    <div className="bg-transparent text-slate-800 p-6 font-sans min-h-screen space-y-8">
      <DashboardHeader {...headerProps} />
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          <div className="bg-white rounded-3xl border border-slate-200 p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Forecasted 6-Month Revenue</p>
            <p className="text-xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(forecast.totalForecastRevenue, baseCurrency)}</p>
            <p className="text-xs text-slate-500 mt-0.5">Next 6 months</p>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200 p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Growth Trend</p>
            <p className={`text-xl font-bold mt-1 ${forecast.avgGrowth >= 0 ? "text-emerald-700" : "text-red-500"}`}>
              {forecast.avgGrowth >= 0 ? "+" : ""}{forecast.avgGrowth.toFixed(1)}%
            </p>
            <p className="text-xs text-slate-500 mt-0.5">12-month MRR change</p>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200 p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Expected MRR (6 months)</p>
            <p className="text-xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatCurrency(forecast.projectedMRR, baseCurrency)}</p>
            <p className="text-xs text-slate-500 mt-0.5">Monthly recurring revenue</p>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200 p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <p className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Confidence</p>
            <p className="text-xl font-bold text-slate-900 mt-1">{forecast.confidence}%</p>
            <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  forecast.confidence >= 70 ? "bg-emerald-500" : forecast.confidence >= 40 ? "bg-amber-500" : "bg-red-400"
                }`}
                style={{ width: `${forecast.confidence}%` }}
              />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <h3 className="text-sm font-semibold text-slate-800 mb-4">Revenue & MRR Forecast</h3>
          <ResponsiveContainer width="100%" height={380}>
            <LineChart data={forecast.combinedChart} margin={{ top: 10, right: 30, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v) => v != null ? formatCurrency(v, baseCurrency) : "—"} />
              <Legend />
              <Line type="monotone" dataKey="Revenue" stroke="#2563EB" strokeWidth={2} dot={false} connectNulls={false} name="Revenue (Historical)" />
              <Line type="monotone" dataKey="Forecast" stroke="#2563EB" strokeWidth={2} strokeDasharray="8 4" dot={false} connectNulls={false} name="Revenue (Forecast)" />
              <Line type="monotone" dataKey="MRR" stroke="#10b981" strokeWidth={2} dot={false} connectNulls={false} name="MRR (Historical)" />
              <Line type="monotone" dataKey="MRR Forecast" stroke="#10b981" strokeWidth={2} strokeDasharray="8 4" dot={false} connectNulls={false} name="MRR (Forecast)" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <h3 className="text-sm font-semibold text-slate-800 mb-4">Monthly Breakdown</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
<thead>
                <tr className="border-b border-slate-200">
                  <th scope="col" className="text-left py-3 px-4 text-xs font-semibold text-slate-500 uppercase">Month</th>
                  <th scope="col" className="text-right py-3 px-4 text-xs font-semibold text-slate-500 uppercase">Revenue</th>
                  <th scope="col" className="text-right py-3 px-4 text-xs font-semibold text-slate-500 uppercase">MRR</th>
                  <th scope="col" className="text-right py-3 px-4 text-xs font-semibold text-slate-500 uppercase">Expected Collections</th>
                </tr>
              </thead>
              <tbody>
                {monthlyMetrics.map((m) => (
                  <tr key={m.key} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="py-3 px-4 font-medium text-slate-800">{m.label}</td>
                    <td className="py-3 px-4 text-right text-slate-700">{formatCurrency(m.revenue, baseCurrency)}</td>
                    <td className="py-3 px-4 text-right text-slate-700">{formatCurrency(m.mrr, baseCurrency)}</td>
                    <td className="py-3 px-4 text-right text-slate-700">{formatCurrency(m.collected, baseCurrency)}</td>
                  </tr>
                ))}
                {forecast.forecastMonths.map((m, i) => (
                  <tr key={`f-${i}`} className="border-b border-slate-100 bg-brand-50/30 hover:bg-brand-50/60">
                    <td className="py-3 px-4 font-medium text-brand-700">{m.month} (est.)</td>
                    <td className="py-3 px-4 text-right text-brand-700">{formatCurrency(m.revenue, baseCurrency)}</td>
                    <td className="py-3 px-4 text-right text-brand-700">{formatCurrency(m.mrr, baseCurrency)}</td>
                    <td className="py-3 px-4 text-right text-brand-700">{formatCurrency(m.collected, baseCurrency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
