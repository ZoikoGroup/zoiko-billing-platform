import React, { useCallback, useEffect, useState } from "react";
import { Receipt, Mail, CheckCircle2, AlertTriangle, Ban } from "lucide-react";
import {
  getFinancialOperationsSummary,
  getInvoiceStatusDistribution,
  getInvoiceDeliveryDiagnostics,
} from "../../service/commandCenterService";
import { PageHeader } from "../../components/billing-ui";
import { ErrorState, Spinner, StatusBadge } from "../../components/billing-shared";
import { INVOICE_STATUS_OPTIONS } from "./constants";
import { F1BillingsCard } from "./FinancialOperationsPage";

function money(strAmount) {
  const n = parseFloat(strAmount || "0");
  if (isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function DeliveryTile({ icon: Icon, label, value, total, tone }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
      <div className="flex items-center gap-2">
        <Icon size={14} className={tone} />
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-600">{label}</p>
      </div>
      <p className="mt-1 text-2xl font-extrabold text-slate-900">{value}</p>
      <p className="text-[11px] text-slate-500">{total > 0 ? `${pct}% of ${total} communications` : "No communications yet"}</p>
    </div>
  );
}

export default function InvoiceEnginePage() {
  const [billings, setBillings] = useState(null);
  const [distribution, setDistribution] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const nextErrors = {};
    Promise.allSettled([
      getFinancialOperationsSummary(),
      getInvoiceStatusDistribution(),
      getInvoiceDeliveryDiagnostics(),
    ]).then(([billingsRes, distRes, deliveryRes]) => {
      if (billingsRes.status === "fulfilled") setBillings(billingsRes.value.billings);
      else nextErrors.billings = billingsRes.reason?.message || "Failed to load billings summary.";

      if (distRes.status === "fulfilled") setDistribution(distRes.value);
      else nextErrors.distribution = distRes.reason?.message || "Failed to load invoice status distribution.";

      if (deliveryRes.status === "fulfilled") setDelivery(deliveryRes.value);
      else nextErrors.delivery = deliveryRes.reason?.message || "Failed to load delivery diagnostics.";

      setErrors(nextErrors);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <Spinner />
      </div>
    );
  }

  const orderedBuckets = INVOICE_STATUS_OPTIONS.map((opt) => {
    const bucket = distribution?.buckets?.find((b) => b.status === opt.value);
    return { ...opt, count: bucket?.count ?? 0, total_amount: bucket?.total_amount ?? "0" };
  }).filter((b) => b.count > 0 || distribution);

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Invoice Engine"
        description="Platform-wide invoice lifecycle: status distribution across every tenant and outbound delivery health. All values are real database aggregates."
        icon={Receipt}
        meta={distribution ? `${distribution.total_invoices} invoice(s) tracked` : null}
      />

      <div className="mt-6 grid grid-cols-1 gap-6">
        {errors.distribution ? (
          <ErrorState title="Unable to load status distribution" message={errors.distribution} onRetry={load} />
        ) : (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">Invoice Status Distribution</h3>
            <p className="mt-1 text-xs text-slate-500">Every invoice on the platform, grouped by lifecycle status.</p>
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {orderedBuckets.map((b) => (
                <div key={b.value} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                  <StatusBadge status={b.value} options={INVOICE_STATUS_OPTIONS} />
                  <p className="mt-2 text-xl font-extrabold text-slate-900">{b.count}</p>
                  <p className="text-[11px] text-slate-500">{money(b.total_amount)} total</p>
                </div>
              ))}
              {orderedBuckets.length === 0 && (
                <p className="text-xs text-slate-400">No invoices exist on the platform yet.</p>
              )}
            </div>
          </div>
        )}

        {errors.delivery ? (
          <ErrorState title="Unable to load delivery diagnostics" message={errors.delivery} onRetry={load} />
        ) : (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">Delivery Diagnostics</h3>
            <p className="mt-1 text-xs text-slate-500">
              Outbound invoice communications (email dispatch) across every tenant, by delivery outcome.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <DeliveryTile icon={Mail} label="Sent" value={delivery?.sent ?? 0} total={delivery?.total ?? 0} tone="text-slate-500" />
              <DeliveryTile icon={CheckCircle2} label="Delivered" value={delivery?.delivered ?? 0} total={delivery?.total ?? 0} tone="text-emerald-600" />
              <DeliveryTile icon={AlertTriangle} label="Failed" value={delivery?.failed ?? 0} total={delivery?.total ?? 0} tone="text-red-600" />
              <DeliveryTile icon={Ban} label="Bounced" value={delivery?.bounced ?? 0} total={delivery?.total ?? 0} tone="text-orange-500" />
            </div>
          </div>
        )}

        {errors.billings ? (
          <ErrorState title="Unable to load billings summary" message={errors.billings} onRetry={load} />
        ) : (
          <F1BillingsCard billings={billings} />
        )}
      </div>
    </div>
  );
}
