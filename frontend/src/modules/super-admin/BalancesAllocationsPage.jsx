import React, { useCallback, useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import {
  listAllocationExceptions,
  listCreditApplications,
} from "../../service/commandCenterService";
import { PageHeader, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";
import { OrganizationLink, CurrencyTotals, CountChips, SupportAccessNote, rowsOf } from "./PrivacyCells";
import { StaleSectionNote, TenantAggregateTable, TENANT_LIST_LIMIT, settleSections } from "./FinancialSummaryCards";
import useLiveRefresh, { LiveRefreshStatus } from "./useLiveRefresh";

const EXCEPTION_TYPE_LABELS = { over_allocated: "over-allocated invoices" };

const ALLOCATION_EXCEPTION_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <OrganizationLink organizationId={r.organization_id} name={r.organization_name} /> },
  {
    key: "exception_count_by_type",
    label: "Exceptions by Type",
    render: (r) => (
      <CountChips
        counts={r.exception_count_by_type}
        labelFor={(k) => EXCEPTION_TYPE_LABELS[k] || String(k).replaceAll("_", " ")}
      />
    ),
  },
];

const CREDIT_APPLICATION_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <OrganizationLink organizationId={r.organization_id} name={r.organization_name} /> },
  { key: "count_by_status", label: "Applications", render: (r) => <CountChips counts={r.count_by_status} /> },
  { key: "total_by_currency", label: "Total Applied", numeric: true, render: (r) => <CurrencyTotals totals={r.total_by_currency} /> },
];

// `embedded` drops this page's own PageHeader and padding when it is mounted
// as a tab of the Financial Operations hub, whose header already titles it.
export default function BalancesAllocationsPage({ embedded = false, refreshSignal = 0 } = {}) {
  const [exceptions, setExceptions] = useState(null);
  const [applications, setApplications] = useState(null);
  const [errors, setErrors] = useState({});

  // This page opens on its own subject: allocation exceptions (the F4 card it
  // used to open with lives on the hub's Overview).
  const load = useCallback(
    (signal) =>
      Promise.allSettled([
        listAllocationExceptions(TENANT_LIST_LIMIT),
        listCreditApplications(TENANT_LIST_LIMIT),
      ]).then((results) => {
        if (signal?.aborted) return;
        const nextErrors = settleSections(
          results,
          [["exceptions", setExceptions], ["applications", setApplications]],
          ["Failed to load allocation exceptions.", "Failed to load credit applications."]
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
          title="Balances & Allocations"
          description="Payment-allocation integrity (no invoice may have more payment allocated than its total) and the credit-note application ledger, across every tenant."
          icon={Landmark}
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
          icon={Landmark}
          title="Allocation Exceptions"
          description="Tenants with invoices that have more payment allocated than the invoice total — always a ledger error, never a legitimate state. Counts per exception type only."
        >
          {errors.exceptions && !exceptions ? (
            <ErrorState title="Unable to load allocation exceptions" message={errors.exceptions} onRetry={() => refresh()} />
          ) : (
            <>
              {errors.exceptions && <StaleSectionNote message={errors.exceptions} onRetry={refresh} />}
              <TenantAggregateTable
                rows={rowsOf(exceptions)}
                columns={ALLOCATION_EXCEPTION_COLUMNS}
                limit={TENANT_LIST_LIMIT}
                emptyIcon={Landmark}
                emptyTitle="No allocation exceptions"
                emptyMessage="Every invoice's allocated payments are within its total amount."
              />
              <SupportAccessNote />
            </>
          )}
        </SectionCard>

        <SectionCard
          variant="standard"
          accent="brand"
          icon={Landmark}
          title="Credit Note Applications"
          description="Credit notes applied against invoices, per tenant, with totals per currency."
        >
          {errors.applications && !applications ? (
            <ErrorState title="Unable to load credit applications" message={errors.applications} onRetry={() => refresh()} />
          ) : (
            <>
              {errors.applications && <StaleSectionNote message={errors.applications} onRetry={refresh} />}
              <TenantAggregateTable
                rows={rowsOf(applications)}
                columns={CREDIT_APPLICATION_COLUMNS}
                limit={TENANT_LIST_LIMIT}
                emptyIcon={Landmark}
                emptyTitle="No credit note applications yet"
                emptyMessage="Credit notes applied against invoices will appear here."
              />
              <SupportAccessNote />
            </>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
