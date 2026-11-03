import React, { useCallback, useEffect, useState } from "react";
import { CreditCard, ShieldOff } from "lucide-react";
import {
  listFailedPayments,
  listDunningCases,
} from "../../service/commandCenterService";
import { PageHeader, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";
import { OrganizationLink, MaskedValue, CurrencyTotals, CountChips, ReasonList, SupportAccessNote, rowsOf } from "./PrivacyCells";
import { StaleSectionNote, TenantAggregateTable, TENANT_LIST_LIMIT, settleSections } from "./FinancialSummaryCards";
import useLiveRefresh, { LiveRefreshStatus } from "./useLiveRefresh";

const stageLabel = (key) => String(key).replaceAll("_", " ");

const FAILED_PAYMENT_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <OrganizationLink organizationId={r.organization_id} name={r.organization_name} /> },
  { key: "failed_count", label: "Failed Payments", align: "center", numeric: true, render: (r) => <span className="font-semibold text-slate-800"><MaskedValue value={r.failed_count} label={r.failed_count_label} /></span> },
  { key: "failed_total_by_currency", label: "Failed Total", numeric: true, render: (r) => <CurrencyTotals totals={r.failed_total_by_currency} /> },
  { key: "top_failure_reasons", label: "Top Failure Reasons", render: (r) => <ReasonList reasons={r.top_failure_reasons} /> },
];

const DUNNING_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <OrganizationLink organizationId={r.organization_id} name={r.organization_name} /> },
  { key: "case_count_by_stage", label: "Cases by Stage", render: (r) => <CountChips counts={r.case_count_by_stage} labelFor={stageLabel} /> },
];

// `embedded` drops this page's own PageHeader and padding when it is mounted
// as a tab of the Financial Operations hub, whose header already titles it.
export default function PaymentsDisputesPage({ embedded = false, refreshSignal = 0 } = {}) {
  const [failedPayments, setFailedPayments] = useState(null);
  const [dunningCases, setDunningCases] = useState(null);
  const [errors, setErrors] = useState({});

  // The F2 Payment Recovery card that used to open this page lives only on
  // the hub's Overview tab now, so this page no longer fetches the summary.
  const load = useCallback(
    (signal) =>
      Promise.allSettled([listFailedPayments(TENANT_LIST_LIMIT), listDunningCases(TENANT_LIST_LIMIT)]).then((results) => {
        if (signal?.aborted) return;
        const nextErrors = settleSections(
          results,
          [["failedPayments", setFailedPayments], ["dunningCases", setDunningCases]],
          ["Failed to load failed payments.", "Failed to load dunning cases."]
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

      <LiveRefreshStatus
        className={embedded ? "mb-4" : "mt-4"}
        lastUpdated={live.lastUpdated}
        refreshing={live.refreshing}
        refreshError={live.refreshError}
        onRefresh={refresh}
      />

      <div className={`grid grid-cols-1 gap-6 ${embedded ? "" : "mt-4"}`}>
        <SectionCard
          variant="hero"
          accent="brand"
          icon={CreditCard}
          title="Failed Payment Recovery Queue"
          description="Failed payments per tenant: counts, totals per currency, and failure-reason categories."
        >
          {errors.failedPayments && !failedPayments ? (
            <ErrorState title="Unable to load failed payments" message={errors.failedPayments} onRetry={() => refresh()} />
          ) : (
            <>
              {errors.failedPayments && <StaleSectionNote message={errors.failedPayments} onRetry={refresh} />}
              <TenantAggregateTable
                rows={rowsOf(failedPayments)}
                columns={FAILED_PAYMENT_COLUMNS}
                limit={TENANT_LIST_LIMIT}
                minWidth={640}
                emptyIcon={CreditCard}
                emptyTitle="No failed payments"
                emptyMessage="Every payment on the platform cleared successfully."
              />
              <SupportAccessNote />
            </>
          )}
        </SectionCard>

        <SectionCard
          variant="standard"
          accent="brand"
          icon={CreditCard}
          title="Dunning Cases"
          description="Dunning cases per tenant, by escalation stage."
        >
          {errors.dunningCases && !dunningCases ? (
            <ErrorState title="Unable to load dunning cases" message={errors.dunningCases} onRetry={() => refresh()} />
          ) : (
            <>
              {errors.dunningCases && <StaleSectionNote message={errors.dunningCases} onRetry={refresh} />}
              <TenantAggregateTable
                rows={rowsOf(dunningCases)}
                columns={DUNNING_COLUMNS}
                limit={TENANT_LIST_LIMIT}
                minWidth={640}
                emptyIcon={CreditCard}
                emptyTitle="No dunning cases"
                emptyMessage="No accounts are currently in a dunning cycle."
              />
              <SupportAccessNote />
            </>
          )}
        </SectionCard>

        <SectionCard
          variant="quiet"
          accent="brand"
          icon={ShieldOff}
          title="Chargebacks — not available yet"
          description="Chargebacks and payment disputes are not recorded by the platform yet: there is no dispute data model and no Stripe/PayPal/Adyen dispute webhooks are ingested, so this section has nothing to show."
        />
      </div>
    </div>
  );
}
