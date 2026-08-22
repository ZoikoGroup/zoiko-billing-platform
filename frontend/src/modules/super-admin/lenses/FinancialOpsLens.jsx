import React, { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  CreditCard,
  HelpCircle,
  RefreshCw,
  ShieldCheck,
  TrendingDown,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getFinancialOperationsSummary } from "../../../service/commandCenterService";
import { Spinner } from "../../../components/billing-shared";

function IntegrityBadge({ state }) {
  if (state === "VERIFIED")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
        <CheckCircle2 size={10} /> VERIFIED
      </span>
    );
  if (state === "FAILED")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700">
        <AlertTriangle size={10} /> FAILED
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
      <HelpCircle size={10} /> UNKNOWN
    </span>
  );
}

export default function FinancialOpsLens() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getFinancialOperationsSummary()
      .then(setData)
      .catch((e) => setError(e?.message || "Failed to load financial operations."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Derive composite integrity state
  const consistency = data?.consistency;
  const totalInvoices = consistency?.total_invoices_checked ?? 0;
  const isVerified = consistency?.state === "VERIFIED" && totalInvoices > 0;
  const isFailed = consistency?.state === "FAILED";
  const stateLabel = isVerified ? "VERIFIED" : isFailed ? "FAILED" : "UNKNOWN";

  if (loading) {
    return (
      <div className="flex min-h-48 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
        {error}
        <button type="button" onClick={load} className="ml-3 font-semibold underline">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* F1: Billings & Collections */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div className="flex items-center gap-2">
            <CircleDollarSign size={15} className="text-brand-600" />
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">F1 · Billings & Collections</h3>
          </div>
          <button
            type="button"
            onClick={() => navigate("/super-admin/financial-operations")}
            className="text-xs font-bold text-brand-600 hover:text-brand-800"
          >
            Detail →
          </button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">Total Invoices</span>
            <p className="mt-1 text-xl font-extrabold text-slate-900">{data?.billings?.total_invoices ?? 0}</p>
          </div>
          <div className={`rounded-2xl border p-3 ${(data?.billings?.overdue_count ?? 0) > 0 ? "border-red-100 bg-red-50" : "border-slate-100 bg-slate-50"}`}>
            <span className={`text-[10px] font-bold uppercase tracking-wider ${(data?.billings?.overdue_count ?? 0) > 0 ? "text-red-700" : "text-slate-600"}`}>Overdue</span>
            <p className={`mt-1 text-xl font-extrabold ${(data?.billings?.overdue_count ?? 0) > 0 ? "text-red-800" : "text-slate-900"}`}>
              {data?.billings?.overdue_count ?? 0}
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-500">Domain B aggregate via authoritative billing read models.</p>
      </div>

      {/* F2: Payment Recovery */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div className="flex items-center gap-2">
            <CreditCard size={15} className="text-amber-600" />
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">F2 · Payment Recovery</h3>
          </div>
          <button
            type="button"
            onClick={() => navigate("/super-admin/financial-operations")}
            className="text-xs font-bold text-brand-600 hover:text-brand-800"
          >
            Detail →
          </button>
        </div>
        <div className="mt-4 flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 p-3">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">Failed Payments</span>
            <p className={`mt-1 text-2xl font-extrabold ${(data?.recovery?.failed_payments_count ?? 0) > 0 ? "text-red-700" : "text-slate-900"}`}>
              {data?.recovery?.failed_payments_count ?? 0}
            </p>
          </div>
          <span
            className={`rounded-full px-2.5 py-1 text-xs font-bold ${
              (data?.recovery?.dunning_cycle_status || "").startsWith("ACTIVE")
                ? "bg-amber-100 text-amber-800"
                : (data?.recovery?.dunning_cycle_status || "").startsWith("IDLE")
                ? "bg-blue-100 text-blue-800"
                : "bg-slate-100 text-slate-700"
            }`}
          >
            {data?.recovery?.dunning_cycle_status || "NOT CONFIGURED"}
          </span>
        </div>
      </div>


      {/* F3: Reconciliation & Integrity */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div className="flex items-center gap-2">
            <ShieldCheck size={15} className="text-slate-600" />
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">F3 · Reconciliation & Integrity</h3>
          </div>
          <IntegrityBadge state={stateLabel} />
        </div>
        <div className="mt-4 flex items-start gap-4 rounded-2xl border border-slate-100 bg-slate-50 p-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white">
            {isVerified ? (
              <CheckCircle2 size={18} className="text-emerald-600" />
            ) : isFailed ? (
              <AlertTriangle size={18} className="text-rose-600" />
            ) : (
              <HelpCircle size={18} className="text-amber-500" />
            )}
          </div>
          <div className="text-xs">
            <p className="font-bold text-slate-900">
              {isVerified
                ? "Ledger Allocation Integrity Verified"
                : isFailed
                ? "Integrity Check Failed"
                : "Verification State Unknown"}
            </p>
            <p className="mt-0.5 text-slate-600">
              Invoices checked: <strong>{totalInvoices}</strong> · Over-allocated:{" "}
              <strong className={consistency?.over_allocated_count > 0 ? "text-red-700" : ""}>{consistency?.over_allocated_count ?? 0}</strong>
            </p>
            <p className="mt-0.5 text-slate-500">Internal allocation check only — ISS-017 still open.</p>
          </div>
        </div>
      </div>

      {/* F4: Revenue Leakage */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div className="flex items-center gap-2">
            <TrendingDown size={15} className={(data?.leakage?.over_allocated_count ?? 0) > 0 ? "text-rose-600" : "text-slate-500"} />
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">F4 · Revenue Leakage</h3>
          </div>
          {(data?.leakage?.over_allocated_count ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-700">
              <AlertTriangle size={9} /> Anomalies
            </span>
          )}
        </div>
        <div className="mt-4 space-y-2 text-xs">
          {[
            {
              label: "Over-allocated Invoices",
              value: data?.leakage?.over_allocated_count ?? 0,
              danger: (data?.leakage?.over_allocated_count ?? 0) > 0,
            },
            {
              label: "Under-allocated Paid (Info)",
              value: data?.leakage?.under_allocated_paid_count ?? 0,
              danger: false,
            },
            {
              label: "Active Credit Notes",
              value: data?.leakage?.active_credit_notes_count ?? 0,
              danger: false,
            },
          ].map(({ label, value, danger }) => (
            <div
              key={label}
              className={`flex items-center justify-between rounded-xl border px-3 py-2 ${danger && value > 0 ? "border-red-100 bg-red-50" : "border-slate-100 bg-slate-50"}`}
            >
              <span className={danger && value > 0 ? "text-red-700" : "text-slate-700"}>{label}</span>
              <span className={`font-bold ${danger && value > 0 ? "text-red-700" : "text-slate-900"}`}>{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
