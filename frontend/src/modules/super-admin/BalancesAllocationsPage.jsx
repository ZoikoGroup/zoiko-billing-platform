import React, { useCallback, useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import {
  listAllocationExceptions,
  listCreditApplications,
} from "../../service/commandCenterService";
import { PageHeader, DataTable, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner, EmptyState } from "../../components/billing-shared";
import { OrganizationLink, CurrencyTotals, CountChips, SupportAccessNote, rowsOf } from "./PrivacyCells";

const ALLOCATION_EXCEPTION_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <OrganizationLink organizationId={r.organization_id} name={r.organization_name} /> },
  { key: "exception_count_by_type", label: "Exceptions by Type", render: (r) => <CountChips counts={r.exception_count_by_type} /> },
];

const CREDIT_APPLICATION_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <OrganizationLink organizationId={r.organization_id} name={r.organization_name} /> },
  { key: "count_by_status", label: "Applications by Status", render: (r) => <CountChips counts={r.count_by_status} /> },
  { key: "total_by_currency", label: "Total Applied", numeric: true, render: (r) => <CurrencyTotals totals={r.total_by_currency} /> },
];

// `embedded` drops this page's own PageHeader and padding when it is mounted
// as a tab of the Financial Operations hub, whose header already titles it.
export default function BalancesAllocationsPage({ embedded = false } = {}) {
  const [exceptions, setExceptions] = useState(null);
  const [applications, setApplications] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  // This page used to open with the F4 Revenue Leakage card — neither a
  // balance nor an allocation figure, and already on the hub's Overview. It now
  // opens on its own subject: allocation exceptions.
  const load = useCallback(() => {
    setLoading(true);
    const nextErrors = {};
    Promise.allSettled([
      listAllocationExceptions(50),
      listCreditApplications(50),
    ]).then(([excRes, appRes]) => {
      if (excRes.status === "fulfilled") setExceptions(excRes.value);
      else nextErrors.exceptions = excRes.reason?.message || "Failed to load allocation exceptions.";

      if (appRes.status === "fulfilled") setApplications(appRes.value);
      else nextErrors.applications = appRes.reason?.message || "Failed to load credit applications.";

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
          title="Balances & Allocations"
          description="Payment-allocation integrity invariant (PaymentAllocation ≤ Invoice.total_amount) and the credit-note application ledger, across every tenant."
          icon={Landmark}
          accent="brand"
        />
      )}

      <div className={`grid grid-cols-1 gap-6 ${embedded ? "" : "mt-6"}`}>
        <SectionCard
          variant="hero"
          accent="brand"
          icon={Landmark}
          title="Allocation Exceptions"
          description="Tenants with invoices whose PaymentAllocation totals exceed the invoice total — a real ledger integrity failure, never a legitimate state. Counts per exception type only."
        >
          {errors.exceptions ? (
            <ErrorState title="Unable to load allocation exceptions" message={errors.exceptions} onRetry={load} />
          ) : rowsOf(exceptions).length === 0 ? (
            <EmptyState icon={Landmark} title="No allocation exceptions" message="Every invoice's allocated payments are within its total amount." />
          ) : (
            <DataTable
              columns={ALLOCATION_EXCEPTION_COLUMNS}
              data={rowsOf(exceptions)}
              rowKey={(r) => r.organization_id}
              minWidth={560}
            />
          )}
          <SupportAccessNote />
        </SectionCard>

        <SectionCard
          variant="standard"
          accent="brand"
          icon={Landmark}
          title="Credit Note Applications"
          description="Credit note applications per tenant, by status, with totals per currency."
        >
          {errors.applications ? (
            <ErrorState title="Unable to load credit applications" message={errors.applications} onRetry={load} />
          ) : rowsOf(applications).length === 0 ? (
            <EmptyState icon={Landmark} title="No credit note applications yet" message="Credit notes applied against invoices will appear here." />
          ) : (
            <DataTable
              columns={CREDIT_APPLICATION_COLUMNS}
              data={rowsOf(applications)}
              rowKey={(r) => r.organization_id}
              minWidth={560}
            />
          )}
          <SupportAccessNote />
        </SectionCard>
      </div>
    </div>
  );
}
