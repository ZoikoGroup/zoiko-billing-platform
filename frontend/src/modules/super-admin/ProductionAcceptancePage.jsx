import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardCheck, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { getProductionAcceptanceReport } from "../../service/commercialService";
import { PageHeader, DataTable } from "../../components/billing-ui";
import { ErrorState, Spinner, StatusBadge } from "../../components/billing-shared";
import { ACCEPTANCE_STATUS_OPTIONS, formatDateTime } from "./constants";

const STATUS_ORDER = { FAIL: 0, NOT_CONFIGURED: 1, WARNING: 2, NOT_APPLICABLE: 3, PASS: 4 };

const OVERALL_VERDICT_STYLES = {
  BLOCKED: {
    icon: ShieldAlert,
    wrapper: "border-red-200 bg-red-50 text-red-800",
    iconWrapper: "bg-red-100 text-red-600",
    label: "NOT READY FOR PRODUCTION — BLOCKED",
  },
  CONDITIONAL: {
    icon: ShieldQuestion,
    wrapper: "border-amber-200 bg-amber-50 text-amber-800",
    iconWrapper: "bg-amber-100 text-amber-600",
    label: "CONDITIONALLY READY",
  },
  READY: {
    icon: ShieldCheck,
    wrapper: "border-emerald-200 bg-emerald-50 text-emerald-800",
    iconWrapper: "bg-emerald-100 text-emerald-600",
    label: "READY",
  },
};

export default function ProductionAcceptancePage() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getProductionAcceptanceReport()
      .then(setReport)
      .catch((e) => setError(e?.message || "Failed to load the production acceptance report."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const summary = useMemo(() => {
    if (!report) return null;
    const counts = { PASS: 0, WARNING: 0, FAIL: 0, NOT_CONFIGURED: 0, NOT_APPLICABLE: 0 };
    for (const item of report.items) counts[item.status] = (counts[item.status] || 0) + 1;
    return counts;
  }, [report]);

  const sortedItems = useMemo(() => {
    if (!report) return [];
    return [...report.items].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
  }, [report]);

  const columns = [
    { key: "id", label: "ID", width: 100, render: (row) => <span className="font-mono text-xs font-semibold text-slate-700">{row.id}</span> },
    { key: "criterion", label: "Acceptance Criterion", render: (row) => <span className="text-sm text-slate-700">{row.criterion}</span> },
    { key: "status", label: "Status", render: (row) => <StatusBadge status={row.status} options={ACCEPTANCE_STATUS_OPTIONS} /> },
    { key: "evidence", label: "Evidence", render: (row) => <span className="text-xs text-slate-500">{row.evidence}</span> },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Production Readiness"
        description="ZB-COM-BILL-001 §26 Mandatory Production Acceptance Checklist — a point-in-time architecture assessment, not live monitoring. GO-01 (signed acceptance) remains a governance action this report cannot certify."
        icon={ClipboardCheck}
        meta={report ? `Generated ${formatDateTime(report.generated_at)}` : null}
      />

      <div className="mt-6">
        {loading ? (
          <Spinner />
        ) : error ? (
          <div className="rounded-3xl border border-slate-200 bg-white">
            <ErrorState message={error} onRetry={load} title="Unable to load the production acceptance report" />
          </div>
        ) : (
          <>
            {report?.overall_status ? (
              (() => {
                const verdict = OVERALL_VERDICT_STYLES[report.overall_status] || OVERALL_VERDICT_STYLES.CONDITIONAL;
                const VerdictIcon = verdict.icon;
                return (
                  <div className={`mb-6 flex items-start gap-4 rounded-3xl border p-5 ${verdict.wrapper}`} role="alert">
                    <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${verdict.iconWrapper}`}>
                      <VerdictIcon size={22} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold uppercase tracking-wider">Overall verdict</p>
                      <h2 className="mt-1 text-lg font-extrabold">{verdict.label}</h2>
                      <p className="mt-1.5 text-sm leading-6">{report.summary}</p>
                    </div>
                  </div>
                );
              })()
            ) : null}

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              {ACCEPTANCE_STATUS_OPTIONS.map((opt) => (
                <div key={opt.value} className="rounded-2xl border border-slate-200 bg-white p-4 text-center shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
                  <p className="text-2xl font-extrabold text-slate-800">{summary[opt.value] ?? 0}</p>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-slate-400">{opt.label}</p>
                </div>
              ))}
            </div>

            <div className="mt-6">
              <DataTable columns={columns} data={sortedItems} rowKey={(row) => row.id} minWidth={900} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
