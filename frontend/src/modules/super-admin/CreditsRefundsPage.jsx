import React, { useCallback, useEffect, useState } from "react";
import { Undo2 } from "lucide-react";
import {
  listCreditNotesAdmin,
  listRefundsAdmin,
  listWriteOffsAdmin,
} from "../../service/commandCenterService";
import { PageHeader, DataTable, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner, EmptyState, StatusBadge } from "../../components/billing-shared";
import { OrganizationLink, MaskedValue, CurrencyTotals, CountChips, SupportAccessNote, rowsOf } from "./PrivacyCells";
import { CREDIT_NOTE_STATUS_OPTIONS, REFUND_STATUS_OPTIONS, WRITE_OFF_STATUS_OPTIONS } from "./constants";

function StatusDistributionStrip({ distribution, options }) {
  if (!distribution || distribution.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {distribution.map((d) => (
        <span key={d.status} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px]">
          <StatusBadge status={d.status} options={options} />
          <span className="font-semibold text-slate-700"><MaskedValue value={d.count} /></span>
        </span>
      ))}
    </div>
  );
}

const statusLabel = (key) => String(key).replaceAll("_", " ");

const CREDIT_NOTE_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <OrganizationLink organizationId={r.organization_id} name={r.organization_name} /> },
  { key: "count_by_status", label: "Credit Notes by Status", render: (r) => <CountChips counts={r.count_by_status} labelFor={statusLabel} /> },
  { key: "total_by_currency", label: "Total", numeric: true, render: (r) => <CurrencyTotals totals={r.total_by_currency} /> },
];

const REFUND_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <OrganizationLink organizationId={r.organization_id} name={r.organization_name} /> },
  { key: "count_by_status", label: "Refunds by Status", render: (r) => <CountChips counts={r.count_by_status} labelFor={statusLabel} /> },
  { key: "total_by_currency", label: "Total", numeric: true, render: (r) => <CurrencyTotals totals={r.total_by_currency} /> },
];

const WRITE_OFF_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <OrganizationLink organizationId={r.organization_id} name={r.organization_name} /> },
  { key: "count_by_status", label: "Write-offs by Status", render: (r) => <CountChips counts={r.count_by_status} labelFor={statusLabel} /> },
  { key: "total_by_currency", label: "Total", numeric: true, render: (r) => <CurrencyTotals totals={r.total_by_currency} /> },
];

// `embedded` drops this page's own PageHeader and padding when it is mounted
// as a tab of the Financial Operations hub, whose header already titles it.
export default function CreditsRefundsPage({ embedded = false } = {}) {
  const [creditNotes, setCreditNotes] = useState(null);
  const [refunds, setRefunds] = useState(null);
  const [writeOffs, setWriteOffs] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const nextErrors = {};
    Promise.allSettled([
      listCreditNotesAdmin(50),
      listRefundsAdmin(50),
      listWriteOffsAdmin(50),
    ]).then(([cnRes, refundRes, woRes]) => {
      if (cnRes.status === "fulfilled") setCreditNotes(cnRes.value);
      else nextErrors.creditNotes = cnRes.reason?.message || "Failed to load credit notes.";

      if (refundRes.status === "fulfilled") setRefunds(refundRes.value);
      else nextErrors.refunds = refundRes.reason?.message || "Failed to load refunds.";

      if (woRes.status === "fulfilled") setWriteOffs(woRes.value);
      else nextErrors.writeOffs = woRes.reason?.message || "Failed to load write-offs.";

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
          title="Credits, Refunds & Write-offs"
          description="Credit notes, cash refunds, and bad-debt write-offs across every tenant (read-only). Refunds move through their own approval workflow inside each tenant's workspace (pending_approval → approved → processing → completed) — this platform-wide view surfaces status, not action."
          icon={Undo2}
          accent="brand"
        />
      )}

      <div className={`grid grid-cols-1 gap-6 ${embedded ? "" : "mt-6"}`}>
        <SectionCard
          variant="standard"
          accent="brand"
          icon={Undo2}
          title="Credit Notes"
          description="Credit notes per tenant, by status, with totals per currency."
        >
          {errors.creditNotes ? (
            <ErrorState title="Unable to load credit notes" message={errors.creditNotes} onRetry={load} />
          ) : (
            <>
              <StatusDistributionStrip distribution={creditNotes?.status_distribution} options={CREDIT_NOTE_STATUS_OPTIONS} />
              {rowsOf(creditNotes).length === 0 ? (
                <EmptyState icon={Undo2} title="No credit notes yet" message="Credit notes issued to customers will appear here." />
              ) : (
                <DataTable columns={CREDIT_NOTE_COLUMNS} data={rowsOf(creditNotes)} rowKey={(r) => r.organization_id} minWidth={560} />
              )}
              <SupportAccessNote />
            </>
          )}
        </SectionCard>

        <SectionCard
          variant="standard"
          accent="brand"
          icon={Undo2}
          title="Refunds"
          description="Cash refunds per tenant, by status, with totals per currency."
        >
          {errors.refunds ? (
            <ErrorState title="Unable to load refunds" message={errors.refunds} onRetry={load} />
          ) : (
            <>
              <StatusDistributionStrip distribution={refunds?.status_distribution} options={REFUND_STATUS_OPTIONS} />
              {rowsOf(refunds).length === 0 ? (
                <EmptyState icon={Undo2} title="No refunds yet" message="Refunds issued to customers will appear here." />
              ) : (
                <DataTable columns={REFUND_COLUMNS} data={rowsOf(refunds)} rowKey={(r) => r.organization_id} minWidth={560} />
              )}
              <SupportAccessNote />
            </>
          )}
        </SectionCard>

        <SectionCard
          variant="standard"
          accent="brand"
          icon={Undo2}
          title="Write-offs"
          description="Bad-debt and adjustment write-offs per tenant, by status, with totals per currency."
        >
          {errors.writeOffs ? (
            <ErrorState title="Unable to load write-offs" message={errors.writeOffs} onRetry={load} />
          ) : (
            <>
              <StatusDistributionStrip distribution={writeOffs?.status_distribution} options={WRITE_OFF_STATUS_OPTIONS} />
              {rowsOf(writeOffs).length === 0 ? (
                <EmptyState icon={Undo2} title="No write-offs yet" message="Bad-debt or adjustment write-offs will appear here." />
              ) : (
                <DataTable columns={WRITE_OFF_COLUMNS} data={rowsOf(writeOffs)} rowKey={(r) => r.organization_id} minWidth={560} />
              )}
              <SupportAccessNote />
            </>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
