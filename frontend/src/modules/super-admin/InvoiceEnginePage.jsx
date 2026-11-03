import React, { useCallback, useEffect, useState } from "react";
import { Receipt, Mail, CheckCircle2, AlertTriangle, Ban } from "lucide-react";
import {
  getInvoiceStatusDistribution,
  getInvoiceDeliveryDiagnostics,
} from "../../service/commandCenterService";
import { PageHeader, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner, StatusBadge } from "../../components/billing-shared";
import { INVOICE_STATUS_OPTIONS } from "./constants";
import { StaleSectionNote, settleSections } from "./FinancialSummaryCards";
import useLiveRefresh, { LiveRefreshStatus } from "./useLiveRefresh";

function DeliveryTile({ icon: Icon, label, value, total, tone }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
      <div className="flex items-center gap-2">
        <Icon size={14} className={tone} />
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-600">{label}</p>
      </div>
      <p className="mt-1 text-2xl font-extrabold tabular-nums text-slate-900">{value}</p>
      <p className="text-[11px] text-slate-500">{total > 0 ? `${pct}% of ${total} emails` : "No invoice emails yet"}</p>
    </div>
  );
}

// `embedded` drops this page's own PageHeader and padding when it is mounted
// as a tab of the Financial Operations hub, whose header already titles it.
// `refreshSignal` is bumped by the hub's header Refresh button.
export default function InvoiceEnginePage({ embedded = false, refreshSignal = 0 } = {}) {
  const [distribution, setDistribution] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [errors, setErrors] = useState({});

  // The F1 Billings & Collections card that used to close this page is gone:
  // it is now the top strip of the hub's single Overview tab.
  const load = useCallback(
    (signal) =>
      Promise.allSettled([getInvoiceStatusDistribution(), getInvoiceDeliveryDiagnostics()]).then((results) => {
        if (signal?.aborted) return;
        const nextErrors = settleSections(
          results,
          [["distribution", setDistribution], ["delivery", setDelivery]],
          ["Failed to load invoice status distribution.", "Failed to load delivery diagnostics."]
        );
        setErrors(nextErrors);
        const failed = Object.values(nextErrors);
        if (failed.length) throw new Error(failed[0]);
      }),
    []
  );

  const live = useLiveRefresh(load);
  const { refresh } = live;
  useEffect(() => {
    if (refreshSignal) refresh();
  }, [refreshSignal, refresh]);

  if (!live.hasLoaded) {
    return (
      <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
        <Spinner />
      </div>
    );
  }

  const orderedBuckets = INVOICE_STATUS_OPTIONS.map((opt) => {
    const bucket = distribution?.buckets?.find((b) => b.status === opt.value);
    return { ...opt, count: bucket?.count ?? 0 };
  });
  // Zero-count buckets stay visible for context, but only while at least one
  // invoice exists.
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

      <LiveRefreshStatus
        className={embedded ? "mb-4" : "mt-4"}
        lastUpdated={live.lastUpdated}
        refreshing={live.refreshing}
        refreshError={live.refreshError}
        onRefresh={refresh}
      />

      <div className={`grid grid-cols-1 gap-6 ${embedded ? "" : "mt-4"}`}>
        {errors.distribution && !distribution ? (
          <ErrorState title="Unable to load status distribution" message={errors.distribution} onRetry={() => refresh()} />
        ) : (
          <SectionCard
            variant="hero"
            accent="brand"
            icon={Receipt}
            title="Invoice Status Distribution"
            description={`Every invoice on the platform, grouped by lifecycle status${distribution ? ` — ${distribution.total_invoices} invoice(s) tracked` : ""}.`}
          >
            {errors.distribution && <StaleSectionNote message={errors.distribution} onRetry={refresh} />}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {/* Counts only. The endpoint's per-status `total_amount` is
                  SUM(total_amount) over every currency at once
                  (financial_operations_detail_service.py
                  invoice_status_distribution), so showing it would add
                  dollars to euros. Per-currency money lives on Overview. */}
              {hasInvoices && orderedBuckets.map((b) => (
                <div key={b.value} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                  <StatusBadge status={b.value} options={INVOICE_STATUS_OPTIONS} />
                  <p className="mt-2 text-xl font-extrabold tabular-nums text-slate-900">{b.count}</p>
                  <p className="text-[11px] text-slate-500">invoice{b.count === 1 ? "" : "s"}</p>
                </div>
              ))}
              {!hasInvoices && (
                <p className="text-xs text-slate-500">No invoices exist on the platform yet.</p>
              )}
            </div>
            {hasInvoices && (
              <p className="mt-3 text-[11px] text-slate-500">
                Amounts per status are not shown because they would mix currencies — see Overview for
                per-currency invoiced, collected and overdue totals.
              </p>
            )}
          </SectionCard>
        )}

        {errors.delivery && !delivery ? (
          <ErrorState title="Unable to load delivery diagnostics" message={errors.delivery} onRetry={() => refresh()} />
        ) : (
          <SectionCard
            variant="standard"
            title="Delivery Diagnostics"
            description="Invoice emails sent to customers across every tenant, by delivery outcome."
          >
            {errors.delivery && <StaleSectionNote message={errors.delivery} onRetry={refresh} />}
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
