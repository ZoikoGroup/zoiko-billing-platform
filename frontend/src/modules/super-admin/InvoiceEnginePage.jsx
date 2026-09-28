import React, { useCallback, useEffect, useState } from "react";
import { Receipt, Mail, CheckCircle2, AlertTriangle, Ban } from "lucide-react";
import {
  getInvoiceStatusDistribution,
  getInvoiceDeliveryDiagnostics,
} from "../../service/commandCenterService";
import { PageHeader, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner, StatusBadge } from "../../components/billing-shared";
import { INVOICE_STATUS_OPTIONS } from "./constants";

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

// `embedded` drops this page's own PageHeader and padding when it is mounted
// as a tab of the Financial Operations hub, whose header already titles it.
export default function InvoiceEnginePage({ embedded = false } = {}) {
  const [distribution, setDistribution] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  // The F1 Billings & Collections card that used to close this page is gone:
  // it is now the top strip of the hub's single Overview tab. Rendering it
  // here too meant an extra /financial-operations request for figures the user
  // had just seen one click away, and gave the same number two homes.
  const load = useCallback(() => {
    setLoading(true);
    const nextErrors = {};
    Promise.allSettled([
      getInvoiceStatusDistribution(),
      getInvoiceDeliveryDiagnostics(),
    ]).then(([distRes, deliveryRes]) => {
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
      <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
        <Spinner />
      </div>
    );
  }

  const orderedBuckets = INVOICE_STATUS_OPTIONS.map((opt) => {
    const bucket = distribution?.buckets?.find((b) => b.status === opt.value);
    return { ...opt, count: bucket?.count ?? 0, total_amount: bucket?.total_amount ?? "0" };
  });
  // Zero-count buckets stay visible for context, but only while at least one
  // invoice exists; the old `|| distribution` filter kept every bucket once
  // data loaded, so the "no invoices" message below could never render.
  const hasInvoices = orderedBuckets.some((b) => b.count > 0);

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      {!embedded && (
        <PageHeader
          title="Invoice Engine"
          description="Platform-wide invoice lifecycle: status distribution across every tenant and outbound delivery health. All values are real database aggregates."
          icon={Receipt}
          meta={distribution ? `${distribution.total_invoices} invoice(s) tracked` : null}
        />
      )}

      <div className={`grid grid-cols-1 gap-6 ${embedded ? "" : "mt-6"}`}>
        {errors.distribution ? (
          <ErrorState title="Unable to load status distribution" message={errors.distribution} onRetry={load} />
        ) : (
          <SectionCard
            variant="hero"
            accent="brand"
            icon={Receipt}
            title="Invoice Status Distribution"
            description={`Every invoice on the platform, grouped by lifecycle status${distribution ? ` — ${distribution.total_invoices} invoice(s) tracked` : ""}.`}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {hasInvoices && orderedBuckets.map((b) => (
                <div key={b.value} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                  <StatusBadge status={b.value} options={INVOICE_STATUS_OPTIONS} />
                  <p className="mt-2 text-xl font-extrabold text-slate-900">{b.count}</p>
                  <p className="text-[11px] text-slate-500">{money(b.total_amount)} total</p>
                </div>
              ))}
              {!hasInvoices && (
                <p className="text-xs text-slate-400">No invoices exist on the platform yet.</p>
              )}
            </div>
          </SectionCard>
        )}

        {errors.delivery ? (
          <ErrorState title="Unable to load delivery diagnostics" message={errors.delivery} onRetry={load} />
        ) : (
          <SectionCard
            variant="standard"
            title="Delivery Diagnostics"
            description="Outbound invoice communications (email dispatch) across every tenant, by delivery outcome."
          >
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <DeliveryTile icon={Mail} label="Sent" value={delivery?.sent ?? 0} total={delivery?.total ?? 0} tone="text-slate-500" />
              <DeliveryTile icon={CheckCircle2} label="Delivered" value={delivery?.delivered ?? 0} total={delivery?.total ?? 0} tone="text-emerald-600" />
              <DeliveryTile icon={AlertTriangle} label="Failed" value={delivery?.failed ?? 0} total={delivery?.total ?? 0} tone="text-red-600" />
              <DeliveryTile icon={Ban} label="Bounced" value={delivery?.bounced ?? 0} total={delivery?.total ?? 0} tone="text-orange-500" />
            </div>
          </SectionCard>
        )}
      </div>
    </div>
  );
}
