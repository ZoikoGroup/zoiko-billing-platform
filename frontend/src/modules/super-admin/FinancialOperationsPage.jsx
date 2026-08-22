import React, { useCallback, useEffect, useState } from "react";
import {
  CircleDollarSign,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  RefreshCw,
  CreditCard,
  TrendingDown,
  ShieldCheck,
  Clock,
  BarChart3,
} from "lucide-react";
import { getFinancialOperationsSummary } from "../../service/commandCenterService";
import { PageHeader, Button } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatCurrency(strAmount) {
  const n = parseFloat(strAmount || "0");
  if (isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "decimal",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

// ── Composite integrity state badge ──────────────────────────────────────────

function IntegrityBadge({ state }) {
  if (state === "VERIFIED")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-700">
        <CheckCircle2 size={12} /> VERIFIED
      </span>
    );
  if (state === "FAILED")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-bold text-rose-700">
        <AlertTriangle size={12} /> FAILED
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-bold text-amber-700">
      <HelpCircle size={12} /> UNKNOWN
    </span>
  );
}

// ── Individual section cards ──────────────────────────────────────────────────

function F1BillingsCard({ billings }) {
  const invoiced = parseFloat(billings?.invoiced_amount || "0");
  const collected = parseFloat(billings?.collected_amount || "0");
  const collectionRate = invoiced > 0 ? Math.round((collected / invoiced) * 100) : null;

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <div className="flex items-center justify-between border-b border-slate-100 pb-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-50">
            <CircleDollarSign size={16} className="text-brand-600" />
          </div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">
            F1 · Billings & Collections
          </h3>
        </div>
        {collectionRate !== null && (
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-bold ${
              collectionRate >= 95
                ? "bg-emerald-100 text-emerald-700"
                : collectionRate >= 80
                ? "bg-amber-100 text-amber-700"
                : "bg-rose-100 text-rose-700"
            }`}
          >
            {collectionRate}% collected
          </span>
        )}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
            Total Invoices
          </p>
          <p className="mt-1 text-2xl font-extrabold text-slate-900">
            {billings?.total_invoices ?? "—"}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
            Invoiced
          </p>
          <p className="mt-1 text-lg font-extrabold text-slate-900">
            {formatCurrency(billings?.invoiced_amount)}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-100 bg-emerald-50 p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">
            Collected
          </p>
          <p className="mt-1 text-lg font-extrabold text-emerald-800">
            {formatCurrency(billings?.collected_amount)}
          </p>
        </div>
        <div
          className={`rounded-2xl border p-4 ${
            (billings?.overdue_count ?? 0) > 0
              ? "border-red-100 bg-red-50"
              : "border-slate-100 bg-slate-50"
          }`}
        >
          <p
            className={`text-[10px] font-bold uppercase tracking-wider ${
              (billings?.overdue_count ?? 0) > 0 ? "text-red-700" : "text-slate-600"
            }`}
          >
            Overdue ({billings?.overdue_count ?? 0})
          </p>
          <p
            className={`mt-1 text-lg font-extrabold ${
              (billings?.overdue_count ?? 0) > 0 ? "text-red-800" : "text-slate-900"
            }`}
          >
            {formatCurrency(billings?.overdue_amount)}
          </p>
        </div>
      </div>
      <p className="mt-4 text-xs text-slate-500">
        Domain B aggregate across all tenant organizations via authoritative billing read models. Currency
        amounts are raw database values — no exchange-rate normalization applied.
      </p>
    </div>
  );
}

function F2RecoveryCard({ recovery }) {
  const failedCount = recovery?.failed_payments_count ?? 0;
  const dunningStatus = recovery?.dunning_cycle_status ?? "UNKNOWN";

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <div className="flex items-center justify-between border-b border-slate-100 pb-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-50">
            <CreditCard size={16} className="text-amber-600" />
          </div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">
            F2 · Payment Recovery
          </h3>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-bold ${
            dunningStatus.startsWith("ACTIVE")
              ? "bg-amber-100 text-amber-800"
              : dunningStatus.startsWith("IDLE")
              ? "bg-blue-100 text-blue-800"
              : "bg-slate-100 text-slate-700"
          }`}
        >
          Dunning: {dunningStatus}
        </span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-4">
        <div
          className={`rounded-2xl border p-4 ${
            failedCount > 0 ? "border-red-100 bg-red-50" : "border-slate-100 bg-slate-50"
          }`}
        >
          <p
            className={`text-[10px] font-bold uppercase tracking-wider ${
              failedCount > 0 ? "text-red-700" : "text-slate-600"
            }`}
          >
            Failed Payments
          </p>
          <p
            className={`mt-1 text-3xl font-extrabold ${
              failedCount > 0 ? "text-red-800" : "text-slate-900"
            }`}
          >
            {failedCount}
          </p>
          {failedCount > 0 && (
            <p className="mt-1 text-xs text-red-600">
              In recovery queue — retry schedule active
            </p>
          )}
        </div>
        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
            Dunning Engine Status
          </p>
          <p
            className={`mt-1 text-lg font-extrabold ${
              dunningStatus.startsWith("ACTIVE")
                ? "text-amber-800"
                : dunningStatus.startsWith("IDLE")
                ? "text-blue-800"
                : "text-slate-700"
            }`}
          >
            {dunningStatus}
          </p>
          <p className="mt-1 text-xs text-slate-500">Standard 45-day cycle</p>
        </div>
      </div>

      <p className="mt-4 text-xs text-slate-500">
        Failed payments are eligible for automatic retry. Dunning state is evaluated per
        subscription billing cycle.
      </p>
    </div>
  );
}

function F3IntegrityCard({ consistency }) {
  const state = consistency?.state ?? "UNKNOWN";
  const totalInvoices = consistency?.total_invoices_checked ?? 0;
  const overAllocated = consistency?.over_allocated_count ?? 0;
  const underAllocatedInfo = consistency?.under_allocated_paid_count_informational ?? 0;

  const isVerified = state === "VERIFIED" && totalInvoices > 0;
  const isFailed = state === "FAILED";
  const stateLabel = isVerified ? "VERIFIED" : isFailed ? "FAILED" : "UNKNOWN";

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <div className="flex items-center justify-between border-b border-slate-100 pb-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100">
            <ShieldCheck size={16} className="text-slate-600" />
          </div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">
            F3 · Reconciliation & Integrity
          </h3>
        </div>
        <IntegrityBadge state={stateLabel} />
      </div>

      <div className="mt-5 flex items-start gap-4 rounded-2xl border border-slate-100 bg-slate-50 p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white">
          {isVerified ? (
            <CheckCircle2 size={22} className="text-emerald-600" />
          ) : isFailed ? (
            <AlertTriangle size={22} className="text-rose-600" />
          ) : (
            <HelpCircle size={22} className="text-amber-500" />
          )}
        </div>
        <div className="min-w-0 flex-1 text-xs">
          <p className="font-bold text-slate-900">
            {isVerified
              ? "Ledger Allocation Integrity Verified"
              : isFailed
              ? "Integrity Check Failed — Over-allocated Payments Detected"
              : totalInvoices === 0
              ? "No invoice data — verification state cannot be determined"
              : "Verification state unknown — check data freshness"}
          </p>
          <p className="mt-1 text-slate-600">
            Invoices checked: <strong>{totalInvoices}</strong> · Over-allocated:{" "}
            <strong className={overAllocated > 0 ? "text-red-700" : "text-slate-900"}>
              {overAllocated}
            </strong>
          </p>
          {isFailed && consistency?.over_allocated_examples?.length > 0 && (
            <div className="mt-2 space-y-1">
              <p className="font-semibold text-slate-700">Examples:</p>
              {consistency.over_allocated_examples.slice(0, 3).map((ex) => (
                <p key={ex.invoice_id} className="text-slate-600">
                  Invoice #{ex.invoice_number} — total: {ex.total_amount}, allocated:{" "}
                  {ex.allocated_amount}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
        <span>
          Scope: <strong className="text-slate-700">Internal PaymentAllocation vs Invoice.total_amount</strong>
        </span>
        <span>
          Processor/bank reconciliation:{" "}
          <strong className="text-amber-700">Not integrated (ISS-017)</strong>
        </span>
      </div>

      {underAllocatedInfo > 0 && (
        <p className="mt-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          <strong>Informational:</strong> {underAllocatedInfo} PAID invoice(s) show under-allocation.
          This may be explained by credit note adjustments and is not treated as a failure.
        </p>
      )}
    </div>
  );
}

function F4LeakageCard({ leakage }) {
  const overAllocated = leakage?.over_allocated_count ?? 0;
  const underAllocated = leakage?.under_allocated_paid_count ?? 0;
  const unbilledUsage = leakage?.unbilled_usage_anomalies ?? 0;
  const activeCredits = leakage?.active_credit_notes_count ?? 0;
  const hasAnomaly = overAllocated > 0 || unbilledUsage > 0;

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <div className="flex items-center justify-between border-b border-slate-100 pb-4">
        <div className="flex items-center gap-2">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-xl ${
              hasAnomaly ? "bg-rose-50" : "bg-slate-100"
            }`}
          >
            <TrendingDown size={16} className={hasAnomaly ? "text-rose-600" : "text-slate-500"} />
          </div>
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">
            F4 · Revenue Leakage
          </h3>
        </div>
        {hasAnomaly && (
          <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-1 text-xs font-bold text-rose-700">
            <AlertTriangle size={11} /> Anomalies Detected
          </span>
        )}
      </div>
      <div className="mt-5 space-y-2.5">
        {[
          {
            label: "Over-allocated Invoices",
            value: overAllocated,
            danger: overAllocated > 0,
            note: "PaymentAllocation exceeds Invoice total — integrity failure",
          },
          {
            label: "Under-allocated Paid Invoices (Informational)",
            value: underAllocated,
            danger: false,
            note: "May be explained by credit notes; not a failure signal",
          },
          {
            label: "Unbilled Usage Anomalies",
            value: unbilledUsage,
            danger: unbilledUsage > 0,
            note: "Usage rated but not yet invoiced",
          },
          {
            label: "Active Credit Notes (Outstanding)",
            value: activeCredits,
            danger: false,
            note: "Issued credit notes not yet fully applied",
          },
        ].map(({ label, value, danger, note }) => (
          <div
            key={label}
            className={`flex items-center justify-between rounded-xl border px-3.5 py-2.5 ${
              danger && value > 0
                ? "border-red-100 bg-red-50"
                : "border-slate-100 bg-slate-50"
            }`}
          >
            <div>
              <span
                className={`text-xs font-medium ${
                  danger && value > 0 ? "text-red-800" : "text-slate-700"
                }`}
              >
                {label}
              </span>
              <p className="text-[10px] text-slate-500">{note}</p>
            </div>
            <span
              className={`text-sm font-extrabold ${
                danger && value > 0 ? "text-red-700" : "text-slate-900"
              }`}
            >
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FinancialOperationsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshedAt, setRefreshedAt] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getFinancialOperationsSummary()
      .then((res) => {
        setData(res);
        setRefreshedAt(new Date());
      })
      .catch((e) => setError(e?.message || "Failed to load financial operations summary."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Financial Operations"
        description="Plane 2 tenant revenue operations — F1 Billings & Collections, F2 Payment Recovery, F3 Reconciliation & Integrity, F4 Revenue Leakage. All values sourced from real billing read models."
        icon={BarChart3}
        meta={
          refreshedAt
            ? `Refreshed ${refreshedAt.toLocaleTimeString()}`
            : null
        }
        actions={
          <Button
            variant="secondary"
            icon={RefreshCw}
            onClick={load}
            loading={loading}
          >
            Refresh
          </Button>
        }
      />

      {/* Domain isolation notice */}
      <div className="mt-4 flex items-start gap-3 rounded-2xl border border-blue-100 bg-blue-50 p-4 text-xs text-blue-800">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-blue-600" />
        <span>
          <strong>Domain B — Tenant Revenue Operations.</strong> Access to this view requires
          platform-level authentication. Monetary amounts are tenant aggregate counts and are NOT exposed
          to tenant users. Domain A (Platform Commercial / Plane 1) is architecturally isolated.
        </span>
      </div>

      {loading && !data ? (
        <div className="mt-8">
          <Spinner />
        </div>
      ) : error ? (
        <div className="mt-6">
          <ErrorState
            message={error}
            onRetry={load}
            title="Unable to load financial operations"
          />
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-6">
          <F1BillingsCard billings={data?.billings} />
          <F2RecoveryCard recovery={data?.recovery} />
          <F3IntegrityCard consistency={data?.consistency} />
          <F4LeakageCard leakage={data?.leakage} />
        </div>
      )}
    </div>
  );
}
