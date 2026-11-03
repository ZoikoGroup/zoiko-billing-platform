import React, { useCallback, useEffect, useState } from "react";
import { Undo2 } from "lucide-react";
import {
  listCreditNotesAdmin,
  listRefundsAdmin,
  listWriteOffsAdmin,
} from "../../service/commandCenterService";
import { PageHeader, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner, StatusBadge } from "../../components/billing-shared";
import { OrganizationLink, MaskedValue, CurrencyTotals, CountChips, SupportAccessNote, rowsOf } from "./PrivacyCells";
import { CREDIT_NOTE_STATUS_OPTIONS, REFUND_STATUS_OPTIONS, WRITE_OFF_STATUS_OPTIONS } from "./constants";
import { StaleSectionNote, TenantAggregateTable, TENANT_LIST_LIMIT, settleSections } from "./FinancialSummaryCards";
import useLiveRefresh, { LiveRefreshStatus } from "./useLiveRefresh";

function StatusDistributionStrip({ distribution, options }) {
  if (!distribution || distribution.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-2" aria-label="Platform-wide count by status">
      {distribution.map((d) => (
        <span key={d.status} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px]">
          <StatusBadge status={d.status} options={options} />
          <span className="font-semibold tabular-nums text-slate-700"><MaskedValue value={d.count} /></span>
        </span>
      ))}
    </div>
  );
}

// Status chips use the same plain-language labels as the badges above.
const labelFrom = (options) => (key) =>
  options.find((o) => o.value === key)?.label || String(key).replaceAll("_", " ");

const tenantColumns = (statusTitle, options) => [
  { key: "organization_name", label: "Organization", render: (r) => <OrganizationLink organizationId={r.organization_id} name={r.organization_name} /> },
  { key: "count_by_status", label: statusTitle, render: (r) => <CountChips counts={r.count_by_status} labelFor={labelFrom(options)} /> },
  { key: "total_by_currency", label: "Total", numeric: true, render: (r) => <CurrencyTotals totals={r.total_by_currency} /> },
];

const CREDIT_NOTE_COLUMNS = tenantColumns("Credit Notes by Status", CREDIT_NOTE_STATUS_OPTIONS);
const REFUND_COLUMNS = tenantColumns("Refunds by Status", REFUND_STATUS_OPTIONS);
const WRITE_OFF_COLUMNS = tenantColumns("Write-offs by Status", WRITE_OFF_STATUS_OPTIONS);

const SECTIONS = [
  {
    key: "creditNotes",
    title: "Credit Notes",
    description: "Credit notes per tenant, by status, with totals per currency.",
    columns: CREDIT_NOTE_COLUMNS,
    options: CREDIT_NOTE_STATUS_OPTIONS,
    errorTitle: "Unable to load credit notes",
    emptyTitle: "No credit notes yet",
    emptyMessage: "Credit notes issued to customers will appear here.",
  },
  {
    key: "refunds",
    title: "Refunds",
    description: "Cash refunds per tenant, by status, with totals per currency.",
    columns: REFUND_COLUMNS,
    options: REFUND_STATUS_OPTIONS,
    errorTitle: "Unable to load refunds",
    emptyTitle: "No refunds yet",
    emptyMessage: "Refunds issued to customers will appear here.",
  },
  {
    key: "writeOffs",
    title: "Write-offs",
    description: "Bad-debt and adjustment write-offs per tenant, by status, with totals per currency.",
    columns: WRITE_OFF_COLUMNS,
    options: WRITE_OFF_STATUS_OPTIONS,
    errorTitle: "Unable to load write-offs",
    emptyTitle: "No write-offs yet",
    emptyMessage: "Bad-debt or adjustment write-offs will appear here.",
  },
];

// `embedded` drops this page's own PageHeader and padding when it is mounted
// as a tab of the Financial Operations hub, whose header already titles it.
export default function CreditsRefundsPage({ embedded = false, refreshSignal = 0 } = {}) {
  const [creditNotes, setCreditNotes] = useState(null);
  const [refunds, setRefunds] = useState(null);
  const [writeOffs, setWriteOffs] = useState(null);
  const [errors, setErrors] = useState({});
  const data = { creditNotes, refunds, writeOffs };

  const load = useCallback(
    (signal) =>
      Promise.allSettled([
        listCreditNotesAdmin(TENANT_LIST_LIMIT),
        listRefundsAdmin(TENANT_LIST_LIMIT),
        listWriteOffsAdmin(TENANT_LIST_LIMIT),
      ]).then((results) => {
        if (signal?.aborted) return;
        const nextErrors = settleSections(
          results,
          [["creditNotes", setCreditNotes], ["refunds", setRefunds], ["writeOffs", setWriteOffs]],
          ["Failed to load credit notes.", "Failed to load refunds.", "Failed to load write-offs."]
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
          title="Credits, Refunds & Write-offs"
          description="Credit notes, cash refunds, and bad-debt write-offs across every tenant (read-only oversight). Refunds are approved and processed inside each tenant's own workspace — this platform-wide view shows status, not actions."
          icon={Undo2}
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
        {SECTIONS.map((section) => {
          const value = data[section.key];
          const error = errors[section.key];
          return (
            <SectionCard
              key={section.key}
              variant="standard"
              accent="brand"
              icon={Undo2}
              title={section.title}
              description={section.description}
            >
              {error && !value ? (
                <ErrorState title={section.errorTitle} message={error} onRetry={() => refresh()} />
              ) : (
                <>
                  {error && <StaleSectionNote message={error} onRetry={refresh} />}
                  <StatusDistributionStrip distribution={value?.status_distribution} options={section.options} />
                  <TenantAggregateTable
                    rows={rowsOf(value)}
                    columns={section.columns}
                    limit={TENANT_LIST_LIMIT}
                    emptyIcon={Undo2}
                    emptyTitle={section.emptyTitle}
                    emptyMessage={section.emptyMessage}
                  />
                  <SupportAccessNote />
                </>
              )}
            </SectionCard>
          );
        })}
      </div>
    </div>
  );
}
