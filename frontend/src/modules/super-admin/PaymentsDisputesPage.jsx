import React, { useCallback, useEffect, useState } from "react";
import { CreditCard, ShieldOff } from "lucide-react";
import {
  getFinancialOperationsSummary,
  listFailedPayments,
  listDunningCases,
} from "../../service/commandCenterService";
import { PageHeader, DataTable } from "../../components/billing-ui";
import { ErrorState, Spinner, EmptyState, StatusBadge } from "../../components/billing-shared";
import { DUNNING_STATUS_OPTIONS } from "./constants";
import { F2RecoveryCard } from "./FinancialOperationsPage";

function money(strAmount) {
  const n = parseFloat(strAmount || "0");
  if (isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

const FAILED_PAYMENT_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <span className="font-medium text-slate-800">{r.organization_name}</span> },
  { key: "customer_name", label: "Customer", render: (r) => <span className="text-slate-600">{r.customer_name}</span> },
  { key: "amount", label: "Amount", render: (r) => <span className="font-semibold text-slate-800">{money(r.amount)} <span className="text-[10px] font-normal text-slate-400">{r.currency}</span></span> },
  { key: "failure_code", label: "Failure Code", render: (r) => <span className="text-slate-600">{r.failure_code || "—"}</span> },
  { key: "failure_reason", label: "Reason", render: (r) => <span className="text-xs text-slate-500">{r.failure_reason || "—"}</span> },
  { key: "attempt_count", label: "Attempts", align: "center", render: (r) => <span className="text-slate-700">{r.attempt_count}</span> },
  { key: "payment_date", label: "Date", render: (r) => <span className="text-slate-500">{formatDate(r.payment_date)}</span> },
];

const DUNNING_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <span className="font-medium text-slate-800">{r.organization_name}</span> },
  { key: "customer_name", label: "Customer", render: (r) => <span className="text-slate-600">{r.customer_name}</span> },
  { key: "invoice_number", label: "Invoice", render: (r) => <span className="font-semibold text-brand-600">{r.invoice_number || "—"}</span> },
  { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} options={DUNNING_STATUS_OPTIONS} /> },
  { key: "current_level", label: "Level", align: "center", render: (r) => <span className="text-slate-700">{r.current_level}</span> },
  { key: "total_overdue_amount", label: "Overdue Amount", render: (r) => <span className="font-semibold text-slate-800">{money(r.total_overdue_amount)} <span className="text-[10px] font-normal text-slate-400">{r.currency}</span></span> },
  { key: "days_overdue", label: "Days Overdue", align: "center", render: (r) => <span className="font-medium text-red-600">{r.days_overdue}d</span> },
];

export default function PaymentsDisputesPage() {
  const [recovery, setRecovery] = useState(null);
  const [failedPayments, setFailedPayments] = useState(null);
  const [dunningCases, setDunningCases] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    const nextErrors = {};
    Promise.allSettled([
      getFinancialOperationsSummary(),
      listFailedPayments(50),
      listDunningCases(50),
    ]).then(([summaryRes, failedRes, dunningRes]) => {
      if (summaryRes.status === "fulfilled") setRecovery(summaryRes.value.recovery);
      else nextErrors.recovery = summaryRes.reason?.message || "Failed to load recovery summary.";

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
      <div className="p-4 sm:p-6 lg:p-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Payments & Disputes"
        description="Failed payment recovery queue and dunning engine state across every tenant. All values are real database aggregates."
        icon={CreditCard}
      />

      <div className="mt-6 grid grid-cols-1 gap-6">
        {errors.recovery ? (
          <ErrorState title="Unable to load recovery summary" message={errors.recovery} onRetry={load} />
        ) : (
          <F2RecoveryCard recovery={recovery} />
        )}

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">Failed Payment Recovery Queue</h3>
          <p className="mt-1 text-xs text-slate-500">Payments currently in a failed state, eligible for automatic retry.</p>
          <div className="mt-4">
            {errors.failedPayments ? (
              <ErrorState title="Unable to load failed payments" message={errors.failedPayments} onRetry={load} />
            ) : (failedPayments?.items || []).length === 0 ? (
              <EmptyState icon={CreditCard} title="No failed payments" message="Every payment on the platform cleared successfully." />
            ) : (
              <DataTable
                columns={FAILED_PAYMENT_COLUMNS}
                data={failedPayments.items}
                rowKey={(r) => r.payment_id}
                minWidth={900}
              />
            )}
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">Dunning Cases</h3>
          <p className="mt-1 text-xs text-slate-500">Accounts currently progressing through the dunning escalation path.</p>
          <div className="mt-4">
            {errors.dunningCases ? (
              <ErrorState title="Unable to load dunning cases" message={errors.dunningCases} onRetry={load} />
            ) : (dunningCases?.items || []).length === 0 ? (
              <EmptyState icon={CreditCard} title="No active dunning cases" message="No accounts are currently in a dunning cycle." />
            ) : (
              <DataTable
                columns={DUNNING_COLUMNS}
                data={dunningCases.items}
                rowKey={(r) => r.dunning_case_id}
                minWidth={900}
              />
            )}
          </div>
        </div>

        <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-6">
          <div className="flex items-start gap-3">
            <ShieldOff size={18} className="mt-0.5 shrink-0 text-slate-400" />
            <div className="text-xs text-slate-600">
              <p className="font-bold text-slate-700">Dispute & Chargeback Oversight — Not integrated</p>
              <p className="mt-1">
                This codebase has no dispute/chargeback data model and no payment-gateway webhook ingestion for
                disputes (Stripe, PayPal, Adyen). Building this section requires a new data model and gateway
                integration — it is not a UI-only gap.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
