import React, { useCallback, useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import {
  getFinancialOperationsSummary,
  listAllocationExceptions,
  listCreditApplications,
} from "../../service/commandCenterService";
import { PageHeader, DataTable } from "../../components/billing-ui";
import { ErrorState, Spinner, EmptyState } from "../../components/billing-shared";
import { F4LeakageCard } from "./FinancialOperationsPage";

function money(strAmount) {
  const n = parseFloat(strAmount || "0");
  if (isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const ALLOCATION_EXCEPTION_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <span className="font-medium text-slate-800">{r.organization_name}</span> },
  { key: "invoice_number", label: "Invoice", render: (r) => <span className="font-semibold text-brand-600">{r.invoice_number}</span> },
  { key: "total_amount", label: "Invoice Total", render: (r) => <span className="text-slate-700">{money(r.total_amount)} <span className="text-[10px] text-slate-400">{r.currency}</span></span> },
  {
    key: "allocated_amount",
    label: "Allocated",
    render: (r) => (
      <span className="font-semibold text-red-700">
        {money(r.allocated_amount)} <span className="text-[10px] font-normal text-slate-400">{r.currency}</span>
      </span>
    ),
  },
  {
    key: "overage",
    label: "Overage",
    render: (r) => (
      <span className="font-semibold text-red-700">
        {money(String(parseFloat(r.allocated_amount) - parseFloat(r.total_amount)))}
      </span>
    ),
  },
];

const CREDIT_APPLICATION_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <span className="font-medium text-slate-800">{r.organization_name}</span> },
  { key: "credit_note_number", label: "Credit Note", render: (r) => <span className="font-semibold text-brand-600">{r.credit_note_number}</span> },
  { key: "invoice_number", label: "Applied to Invoice", render: (r) => <span className="text-slate-700">{r.invoice_number}</span> },
  { key: "amount", label: "Amount", render: (r) => <span className="font-semibold text-slate-800">{money(r.amount)} <span className="text-[10px] font-normal text-slate-400">{r.currency}</span></span> },
  { key: "created_at", label: "Applied At", render: (r) => <span className="text-slate-500">{formatDateTime(r.created_at)}</span> },
];

export default function BalancesAllocationsPage() {
  const [leakage, setLeakage] = useState(null);
  const [exceptions, setExceptions] = useState(null);
  const [applications, setApplications] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const nextErrors = {};
    Promise.allSettled([
      getFinancialOperationsSummary(),
      listAllocationExceptions(50),
      listCreditApplications(50),
    ]).then(([summaryRes, excRes, appRes]) => {
      if (summaryRes.status === "fulfilled") setLeakage(summaryRes.value.leakage);
      else nextErrors.leakage = summaryRes.reason?.message || "Failed to load leakage summary.";

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
      <div className="p-4 sm:p-6 lg:p-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Balances & Allocations"
        description="Payment-allocation integrity invariant (PaymentAllocation ≤ Invoice.total_amount) and the credit-note application ledger, across every tenant."
        icon={Landmark}
      />

      <div className="mt-6 grid grid-cols-1 gap-6">
        {errors.leakage ? (
          <ErrorState title="Unable to load leakage summary" message={errors.leakage} onRetry={load} />
        ) : (
          <F4LeakageCard leakage={leakage} />
        )}

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">Allocation Exceptions</h3>
          <p className="mt-1 text-xs text-slate-500">
            Invoices where PaymentAllocation totals exceed the invoice's own total_amount — a real ledger
            integrity failure, never a legitimate state.
          </p>
          <div className="mt-4">
            {errors.exceptions ? (
              <ErrorState title="Unable to load allocation exceptions" message={errors.exceptions} onRetry={load} />
            ) : (exceptions?.items || []).length === 0 ? (
              <EmptyState icon={Landmark} title="No allocation exceptions" message="Every invoice's allocated payments are within its total amount." />
            ) : (
              <DataTable
                columns={ALLOCATION_EXCEPTION_COLUMNS}
                data={exceptions.items}
                rowKey={(r) => r.invoice_id}
                minWidth={900}
              />
            )}
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">Credit Note Applications</h3>
          <p className="mt-1 text-xs text-slate-500">The ledger of which credit note reduced which invoice's balance, and by how much.</p>
          <div className="mt-4">
            {errors.applications ? (
              <ErrorState title="Unable to load credit applications" message={errors.applications} onRetry={load} />
            ) : (applications?.items || []).length === 0 ? (
              <EmptyState icon={Landmark} title="No credit note applications yet" message="Credit notes applied against invoices will appear here." />
            ) : (
              <DataTable
                columns={CREDIT_APPLICATION_COLUMNS}
                data={applications.items}
                rowKey={(r) => r.application_id}
                minWidth={900}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
