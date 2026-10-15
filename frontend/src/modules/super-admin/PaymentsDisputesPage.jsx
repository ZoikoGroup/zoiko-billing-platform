import React, { useCallback, useEffect, useState } from "react";
import { CreditCard, ShieldOff } from "lucide-react";
import {
  listFailedPayments,
  listDunningCases,
} from "../../service/commandCenterService";
import { PageHeader, DataTable, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner, EmptyState } from "../../components/billing-shared";
import { OrganizationLink, MaskedValue, CurrencyTotals, CountChips, ReasonList, SupportAccessNote, rowsOf } from "./PrivacyCells";

const FAILED_PAYMENT_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <OrganizationLink organizationId={r.organization_id} name={r.organization_name} /> },
  { key: "failed_count", label: "Failed Payments", align: "center", numeric: true, render: (r) => <span className="font-semibold text-slate-800"><MaskedValue value={r.failed_count} label={r.failed_count_label} /></span> },
  { key: "failed_total_by_currency", label: "Failed Total", numeric: true, render: (r) => <CurrencyTotals totals={r.failed_total_by_currency} /> },
  { key: "top_failure_reasons", label: "Top Failure Reasons", render: (r) => <ReasonList reasons={r.top_failure_reasons} /> },
];

const DUNNING_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <OrganizationLink organizationId={r.organization_id} name={r.organization_name} /> },
  { key: "case_count_by_stage", label: "Cases by Stage", render: (r) => <CountChips counts={r.case_count_by_stage} /> },
];

// `embedded` drops this page's own PageHeader and padding when it is mounted
// as a tab of the Financial Operations hub, whose header already titles it.
export default function PaymentsDisputesPage({ embedded = false } = {}) {
  const [failedPayments, setFailedPayments] = useState(null);
  const [dunningCases, setDunningCases] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  // The F2 Payment Recovery card that used to open this page lives only on
  // the hub's Overview tab now, so this page no longer fetches the summary.
  const load = useCallback(() => {
    setLoading(true);
    const nextErrors = {};
    Promise.allSettled([
      listFailedPayments(50),
      listDunningCases(50),
    ]).then(([failedRes, dunningRes]) => {
      if (failedRes.status === "fulfilled") setFailedPayments(failedRes.value);
      else nextErrors.failedPayments = failedRes.reason?.message || "Failed to load failed payments.";

      if (dunningRes.status === "fulfilled") setDunningCases(dunningRes.value);
      else nextErrors.dunningCases = dunningRes.reason?.message || "Failed to load dunning cases.";

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

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      {!embedded && (
        <PageHeader
          title="Payments & Recovery"
          description="Failed payment recovery queue and dunning engine state across every tenant. All values are real database aggregates."
          icon={CreditCard}
          accent="brand"
        />
      )}

      <div className={`grid grid-cols-1 gap-6 ${embedded ? "" : "mt-6"}`}>
        <SectionCard
          variant="hero"
          accent="brand"
          icon={CreditCard}
          title="Failed Payment Recovery Queue"
          description="Failed payments per tenant: counts, totals per currency, and failure-reason categories."
        >
          {errors.failedPayments ? (
            <ErrorState title="Unable to load failed payments" message={errors.failedPayments} onRetry={load} />
          ) : rowsOf(failedPayments).length === 0 ? (
            <EmptyState icon={CreditCard} title="No failed payments" message="Every payment on the platform cleared successfully." />
          ) : (
            <DataTable
              columns={FAILED_PAYMENT_COLUMNS}
              data={rowsOf(failedPayments)}
              rowKey={(r) => r.organization_id}
              minWidth={640}
            />
          )}
          {!errors.failedPayments && <SupportAccessNote />}
        </SectionCard>

        <SectionCard
          variant="standard"
          accent="brand"
          icon={CreditCard}
          title="Dunning Cases"
          description="Open dunning cases per tenant, by escalation stage."
        >
          {errors.dunningCases ? (
            <ErrorState title="Unable to load dunning cases" message={errors.dunningCases} onRetry={load} />
          ) : rowsOf(dunningCases).length === 0 ? (
            <EmptyState icon={CreditCard} title="No active dunning cases" message="No accounts are currently in a dunning cycle." />
          ) : (
            <DataTable
              columns={DUNNING_COLUMNS}
              data={rowsOf(dunningCases)}
              rowKey={(r) => r.organization_id}
              minWidth={640}
            />
          )}
          {!errors.dunningCases && <SupportAccessNote />}
        </SectionCard>

        <SectionCard
          variant="quiet"
          accent="brand"
          icon={ShieldOff}
          title="Chargeback Oversight — Not integrated"
          description="This codebase has no chargeback/dispute data model and no payment-gateway webhook ingestion for chargebacks (Stripe, PayPal, Adyen). Building this section requires a new data model and gateway integration — it is not a UI-only gap."
        />
      </div>
    </div>
  );
}
