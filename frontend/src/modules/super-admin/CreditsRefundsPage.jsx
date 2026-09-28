import React, { useCallback, useEffect, useState } from "react";
import { Undo2 } from "lucide-react";
import {
  listCreditNotesAdmin,
  listRefundsAdmin,
  listWriteOffsAdmin,
} from "../../service/commandCenterService";
import { PageHeader, DataTable, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner, EmptyState, StatusBadge } from "../../components/billing-shared";
import { CREDIT_NOTE_STATUS_OPTIONS, REFUND_STATUS_OPTIONS, WRITE_OFF_STATUS_OPTIONS } from "./constants";

function money(strAmount) {
  const n = parseFloat(strAmount || "0");
  if (isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function StatusDistributionStrip({ distribution, options }) {
  if (!distribution || distribution.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {distribution.map((d) => (
        <span key={d.status} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px]">
          <StatusBadge status={d.status} options={options} />
          <span className="font-semibold text-slate-700">{d.count}</span>
        </span>
      ))}
    </div>
  );
}

const CREDIT_NOTE_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <span className="font-medium text-slate-800">{r.organization_name}</span> },
  { key: "customer_name", label: "Customer", render: (r) => <span className="text-slate-600">{r.customer_name}</span> },
  { key: "credit_note_number", label: "Credit Note", render: (r) => <span className="font-semibold text-brand-600">{r.credit_note_number}</span> },
  { key: "credit_note_type", label: "Type", render: (r) => <span className="text-xs capitalize text-slate-600">{r.credit_note_type.replaceAll("_", " ")}</span> },
  { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} options={CREDIT_NOTE_STATUS_OPTIONS} /> },
  { key: "total_amount", label: "Total", numeric: true, render: (r) => <span className="font-semibold text-slate-800">{money(r.total_amount)} <span className="text-[10px] font-normal text-slate-400">{r.currency}</span></span> },
  { key: "remaining_amount", label: "Remaining", numeric: true, render: (r) => <span className="text-slate-700">{money(r.remaining_amount)}</span> },
  { key: "issue_date", label: "Issued", render: (r) => <span className="text-slate-500">{formatDate(r.issue_date)}</span> },
];

const REFUND_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <span className="font-medium text-slate-800">{r.organization_name}</span> },
  { key: "customer_name", label: "Customer", render: (r) => <span className="text-slate-600">{r.customer_name}</span> },
  { key: "refund_number", label: "Refund", render: (r) => <span className="font-semibold text-brand-600">{r.refund_number}</span> },
  { key: "refund_type", label: "Type", render: (r) => <span className="text-xs capitalize text-slate-600">{r.refund_type.replaceAll("_", " ")}</span> },
  { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} options={REFUND_STATUS_OPTIONS} /> },
  { key: "amount", label: "Amount", numeric: true, render: (r) => <span className="font-semibold text-slate-800">{money(r.amount)} <span className="text-[10px] font-normal text-slate-400">{r.currency}</span></span> },
  { key: "reason", label: "Reason", render: (r) => <span className="text-xs text-slate-500">{r.reason || "—"}</span> },
  { key: "created_at", label: "Created", render: (r) => <span className="text-slate-500">{formatDate(r.created_at)}</span> },
];

const WRITE_OFF_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <span className="font-medium text-slate-800">{r.organization_name}</span> },
  { key: "customer_name", label: "Customer", render: (r) => <span className="text-slate-600">{r.customer_name}</span> },
  { key: "write_off_number", label: "Write-off", render: (r) => <span className="font-semibold text-brand-600">{r.write_off_number}</span> },
  { key: "write_off_type", label: "Type", render: (r) => <span className="text-xs capitalize text-slate-600">{r.write_off_type.replaceAll("_", " ")}</span> },
  { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} options={WRITE_OFF_STATUS_OPTIONS} /> },
  { key: "amount", label: "Amount", numeric: true, render: (r) => <span className="font-semibold text-slate-800">{money(r.amount)} <span className="text-[10px] font-normal text-slate-400">{r.currency}</span></span> },
  { key: "reason", label: "Reason", render: (r) => <span className="text-xs text-slate-500">{r.reason || "—"}</span> },
  { key: "created_at", label: "Created", render: (r) => <span className="text-slate-500">{formatDate(r.created_at)}</span> },
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
          description="Issued credit notes, their type, and how much remains unapplied."
        >
          {errors.creditNotes ? (
            <ErrorState title="Unable to load credit notes" message={errors.creditNotes} onRetry={load} />
          ) : (
            <>
              <StatusDistributionStrip distribution={creditNotes?.status_distribution} options={CREDIT_NOTE_STATUS_OPTIONS} />
              {(creditNotes?.items || []).length === 0 ? (
                <EmptyState icon={Undo2} title="No credit notes yet" message="Credit notes issued to customers will appear here." />
              ) : (
                <DataTable columns={CREDIT_NOTE_COLUMNS} data={creditNotes.items} rowKey={(r) => r.credit_note_id} minWidth={840} />
              )}
            </>
          )}
        </SectionCard>

        <SectionCard
          variant="standard"
          accent="brand"
          icon={Undo2}
          title="Refunds"
          description="Cash refunds across every tenant, by status and origin."
        >
          {errors.refunds ? (
            <ErrorState title="Unable to load refunds" message={errors.refunds} onRetry={load} />
          ) : (
            <>
              <StatusDistributionStrip distribution={refunds?.status_distribution} options={REFUND_STATUS_OPTIONS} />
              {(refunds?.items || []).length === 0 ? (
                <EmptyState icon={Undo2} title="No refunds yet" message="Refunds issued to customers will appear here." />
              ) : (
                <DataTable columns={REFUND_COLUMNS} data={refunds.items} rowKey={(r) => r.refund_id} minWidth={840} />
              )}
            </>
          )}
        </SectionCard>

        <SectionCard
          variant="standard"
          accent="brand"
          icon={Undo2}
          title="Write-offs"
          description="Bad-debt and adjustment write-offs — collection given up on, distinct from a refund."
        >
          {errors.writeOffs ? (
            <ErrorState title="Unable to load write-offs" message={errors.writeOffs} onRetry={load} />
          ) : (
            <>
              <StatusDistributionStrip distribution={writeOffs?.status_distribution} options={WRITE_OFF_STATUS_OPTIONS} />
              {(writeOffs?.items || []).length === 0 ? (
                <EmptyState icon={Undo2} title="No write-offs yet" message="Bad-debt or adjustment write-offs will appear here." />
              ) : (
                <DataTable columns={WRITE_OFF_COLUMNS} data={writeOffs.items} rowKey={(r) => r.write_off_id} minWidth={840} />
              )}
            </>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
