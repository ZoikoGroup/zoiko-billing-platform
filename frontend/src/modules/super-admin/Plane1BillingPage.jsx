import React, { useCallback, useEffect, useState } from "react";
import {
  CreditCard,
  FileWarning,
  Landmark,
  Receipt,
  TrendingUp,
  UserCheck,
  Building2,
} from "lucide-react";
import { getSaasCommercialReporting } from "../../service/commercialService";
import { PageHeader, DataTable } from "../../components/billing-ui";
import {
  DashboardStatCard,
  DashboardStatCardSkeleton,
  ErrorState,
  Spinner,
} from "../../components/billing-shared";
import {
  SUBSCRIPTION_STATUS_OPTIONS,
  ACCOUNT_STATUS_OPTIONS,
  formatDateTime,
} from "./constants";

function labelFor(options, value) {
  const match = (options || []).find((o) => o.value === value);
  return match ? match.label : value;
}

function StatusCountTable({ title, counts, options }) {
  const entries = Object.entries(counts || {});
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">{title}</h3>
      <p className="mt-1 text-xs text-slate-500">{total} row(s) — real database counts.</p>
      <ul className="mt-4 space-y-2">
        {entries.map(([status, count]) => (
          <li key={status} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-slate-600">{labelFor(options, status)}</span>
            <span className="font-semibold text-slate-800 tabular-nums">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Phase 3F F7/F8 — honest NOT IMPLEMENTED panel. No Plane 1 invoice/payment
// processor exists in the schema (acceptance items REC-01 / PAY-01 / PAY-02);
// these surfaces must never render fabricated rows or amounts.
function NotImplementedPanel({ icon: Icon, title, message }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-4">
      <Icon size={18} className="mt-0.5 shrink-0 text-slate-400" />
      <div>
        <p className="text-sm font-bold text-slate-700">{title} — not implemented</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">{message}</p>
      </div>
    </div>
  );
}

export default function Plane1BillingPage() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getSaasCommercialReporting()
      .then(setReport)
      .catch((e) => setError(e?.message || "Failed to load SaaS reporting."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const mrr = report?.mrr;
  const planColumns = React.useMemo(
    () => [
      { key: "plan_code", label: "Plan code", render: (r) => <span className="font-medium text-slate-700">{r.plan_code}</span> },
      { key: "plan_name", label: "Plan name", render: (r) => r.plan_name || "—" },
      {
        key: "open_subscriptions",
        label: "Open subscriptions",
        align: "right",
        render: (r) => <span className="tabular-nums font-semibold text-slate-800">{r.open_subscriptions}</span>,
      },
    ],
    []
  );

  function mrrValue() {
    if (!mrr) return "—";
    if (mrr.state === "unknown") return "UNKNOWN";
    if (mrr.state === "multi_currency") return `${mrr.currencies.length} currencies`;
    const amount = Number(mrr.amount ?? 0);
    return amount.toLocaleString("en-US", { style: "currency", currency: mrr.currencies[0]?.currency || "USD" });
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Plane 1 Billing & Reporting"
        description="PLANE 1 · Zoiko→Tenant SaaS money surfaces. Counts and MRR are computed server-side from real rows only — nothing on this page is estimated."
        icon={Landmark}
        meta={report ? `Generated ${formatDateTime(report.generated_at)}` : undefined}
      />

      <div className="mt-6 space-y-8">
        {loading && !report ? (
          <>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)}
            </div>
            <Spinner />
          </>
        ) : error && !report ? (
          <ErrorState message={error} onRetry={load} title="Unable to load SaaS reporting" />
        ) : report ? (
          <>
            {/* ── F10 honest reporting read model ─────────────────────── */}
            <section aria-labelledby="saas-reporting-heading">
              <h2 id="saas-reporting-heading" className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-800">
                SaaS Reporting
              </h2>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
                <DashboardStatCard
                  title="Commercial Accounts"
                  value={report.accounts.total}
                  subtitle="All-time rows by account status"
                  icon={Building2}
                  color="from-brand to-brand-hover"
                />
                <DashboardStatCard
                  title="Open Subscriptions"
                  value={report.subscriptions.total_open}
                  subtitle={`${report.subscriptions.total_ever} ever created`}
                  icon={UserCheck}
                  color="from-emerald-500 to-emerald-600"
                />
                <DashboardStatCard
                  title="MRR"
                  value={mrrValue()}
                  subtitle={
                    mrr?.state === "computed"
                      ? `Priced published versions only · ${mrr.coverage.open_subscriptions_priced}/${mrr.coverage.open_subscriptions_total} open priced`
                      : mrr?.state === "multi_currency"
                        ? "Per-currency totals below — no cross-currency total is fabricated"
                        : "UNKNOWN — no priced published catalog version backs any open subscription"
                  }
                  icon={TrendingUp}
                  color="from-blue-500 to-blue-600"
                />
                <DashboardStatCard
                  title="Plans With Published Price"
                  value={mrr?.coverage.plans_with_published_price ?? 0}
                  subtitle="Price book coverage for MRR computation"
                  icon={Receipt}
                  color="from-slate-500 to-slate-600"
                />
              </div>

              {mrr?.basis && (
                <p className="mt-3 rounded-2xl border border-slate-200 bg-white px-5 py-3 text-xs leading-relaxed text-slate-600">
                  <span className="font-semibold text-slate-800">MRR basis: </span>{mrr.basis}
                  {mrr.currencies.length > 0 && (
                    <span className="ml-2 inline-flex flex-wrap gap-x-4">
                      {mrr.currencies.map((c) => (
                        <span key={c.currency} className="tabular-nums">
                          {c.currency}:{" "}
                          {Number(c.monthly_amount).toLocaleString("en-US", { style: "currency", currency: c.currency })}
                          {" "}
                          ({c.subscriptions} sub{c.subscriptions === 1 ? "" : "s"})
                        </span>
                      ))}
                    </span>
                  )}
                </p>
              )}

              <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
                <StatusCountTable
                  title="Subscriptions by status"
                  counts={report.subscriptions.by_status}
                  options={SUBSCRIPTION_STATUS_OPTIONS}
                />
                <StatusCountTable
                  title="Accounts by status"
                  counts={report.accounts.by_status}
                  options={ACCOUNT_STATUS_OPTIONS}
                />
              </div>

              <div className="mt-5">
                <DataTable
                  columns={planColumns}
                  data={report.subscriptions.open_by_plan}
                  loading={false}
                  emptyTitle="No open subscriptions on any plan"
                  emptyMessage="Open subscriptions appear here grouped by plan with real counts."
                  minWidth={480}
                />
              </div>

                      <ul className="mt-4 list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-600">
                {report.honesty_notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </section>

            {/* ── F7/F8 honest NOT IMPLEMENTED surfaces ───────────────── */}
            <section aria-labelledby="plane1-money-heading">
              <h2 id="plane1-money-heading" className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-800">
                Invoices, Payments & Collections
              </h2>
              <div className="space-y-3">
                <NotImplementedPanel
                  icon={Receipt}
                  title="SaaS invoices"
                  message="Zoiko has no Plane 1 invoicing engine yet — there is no invoice model or processor behind this surface, so no invoice rows can be shown. Acceptance item PAY-01 tracks the build."
                />
                <NotImplementedPanel
                  icon={CreditCard}
                  title="SaaS payments"
                  message="No payment processor is wired to Plane 1 charges. Until one exists, any payment listing here would be fabricated, so none is rendered. Acceptance item PAY-02 tracks the build."
                />
                <NotImplementedPanel
                  icon={FileWarning}
                  title="Collections & dunning outcomes"
                  message="The N1 failed-payment schedule advances subscription states only; no collections ledger exists for Plane 1. Reconciliation remains FAIL by declaration (REC-01)."
                />
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
