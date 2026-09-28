import React, { useCallback, useEffect, useState } from "react";
import { CreditCard, ShieldOff } from "lucide-react";
import {
  listFailedPayments,
  listDunningCases,
} from "../../service/commandCenterService";
import { PageHeader, DataTable, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner, EmptyState, StatusBadge } from "../../components/billing-shared";
import { DUNNING_STATUS_OPTIONS } from "./constants";

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
  { key: "amount", label: "Amount", numeric: true, render: (r) => <span className="font-semibold text-slate-800">{money(r.amount)} <span className="text-[10px] font-normal text-slate-400">{r.currency}</span></span> },
  { key: "failure_code", label: "Failure Code", render: (r) => <span className="text-slate-600">{r.failure_code || "—"}</span> },
  { key: "failure_reason", label: "Reason", render: (r) => <span className="text-xs text-slate-500">{r.failure_reason || "—"}</span> },
  { key: "attempt_count", label: "Attempts", align: "center", numeric: true, render: (r) => <span className="text-slate-700">{r.attempt_count}</span> },
  { key: "payment_date", label: "Date", render: (r) => <span className="text-slate-500">{formatDate(r.payment_date)}</span> },
];

const DUNNING_COLUMNS = [
  { key: "organization_name", label: "Organization", render: (r) => <span className="font-medium text-slate-800">{r.organization_name}</span> },
  { key: "customer_name", label: "Customer", render: (r) => <span className="text-slate-600">{r.customer_name}</span> },
  { key: "invoice_number", label: "Invoice", render: (r) => <span className="font-semibold text-brand-600">{r.invoice_number || "—"}</span> },
  { key: "status", label: "Status", render: (r) => <StatusBadge status={r.status} options={DUNNING_STATUS_OPTIONS} /> },
  { key: "current_level", label: "Level", align: "center", numeric: true, render: (r) => <span className="text-slate-700">{r.current_level}</span> },
  { key: "total_overdue_amount", label: "Overdue Amount", numeric: true, render: (r) => <span className="font-semibold text-slate-800">{money(r.total_overdue_amount)} <span className="text-[10px] font-normal text-slate-400">{r.currency}</span></span> },
  { key: "days_overdue", label: "Days Overdue", align: "center", numeric: true, render: (r) => <span className="font-medium text-red-600">{r.days_overdue}d</span> },
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
          description="Payments currently in a failed state, eligible for automatic retry."
        >
          {errors.failedPayments ? (
            <ErrorState title="Unable to load failed payments" message={errors.failedPayments} onRetry={load} />
          ) : (failedPayments?.items || []).length === 0 ? (
            <EmptyState icon={CreditCard} title="No failed payments" message="Every payment on the platform cleared successfully." />
          ) : (
            <DataTable
              columns={FAILED_PAYMENT_COLUMNS}
              data={failedPayments.items}
              rowKey={(r) => r.payment_id}
              minWidth={840}
            />
          )}
        </SectionCard>

        <SectionCard
          variant="standard"
          accent="brand"
          icon={CreditCard}
          title="Dunning Cases"
          description="Accounts currently progressing through the dunning escalation path."
        >
          {errors.dunningCases ? (
            <ErrorState title="Unable to load dunning cases" message={errors.dunningCases} onRetry={load} />
          ) : (dunningCases?.items || []).length === 0 ? (
            <EmptyState icon={CreditCard} title="No active dunning cases" message="No accounts are currently in a dunning cycle." />
          ) : (
            <DataTable
              columns={DUNNING_COLUMNS}
              data={dunningCases.items}
              rowKey={(r) => r.dunning_case_id}
              minWidth={840}
            />
          )}
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
