import React, { useCallback, useEffect, useState } from "react";
import { ClipboardCheck, CheckCircle2, XCircle, AlertTriangle, HelpCircle } from "lucide-react";
import { api } from "../../service/api";
import { PageHeader, Button } from "../../components/billing-ui";
import { ErrorState, Spinner, StatusBadge } from "../../components/billing-shared";

/**
 * ZB-SA-CMD-003 §23 — Launch Readiness. Every item below runs a real check
 * server-side (backend/app/modules/super_admin/launch_readiness_service.py)
 * — nothing here is a hardcoded PASS. UNKNOWN is a legitimate, honest
 * result (e.g. accessibility/performance were never measured), never
 * silently upgraded to PASS.
 */

const STATUS_STYLES = {
  PASS: { icon: CheckCircle2, className: "text-emerald-700", badge: "bg-emerald-100 text-emerald-700" },
  FAIL: { icon: XCircle, className: "text-red-600", badge: "bg-red-100 text-red-700" },
  WARNING: { icon: AlertTriangle, className: "text-amber-600", badge: "bg-amber-100 text-amber-700" },
  UNKNOWN: { icon: HelpCircle, className: "text-slate-500", badge: "bg-slate-100 text-slate-500" },
};

function StatusPill({ status }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.UNKNOWN;
  return (
    <StatusBadge status={status} options={[{ value: status, label: status, color: style.badge }]} fallbackColor={style.badge} />
  );
}

export default function LaunchReadinessPage() {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api.get("/api/super-admin/launch-readiness")
      .then(setReport)
      .catch((e) => setError(e?.message || "Failed to load Launch Readiness."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const overallStyle = report ? STATUS_STYLES[report.overall_status] || STATUS_STYLES.UNKNOWN : null;

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Launch Readiness"
        description="Real checks against the Command Center's own operational state — database, secrets, MFA enrollment, audit logging, scheduler health, CORS, open P0/P1 attention, and internal financial consistency. UNKNOWN means genuinely not verifiable here (e.g. accessibility, performance), never a hidden PASS."
        icon={ClipboardCheck}
        actions={<Button variant="secondary" onClick={load}>Re-run checks</Button>}
      />

      <div className="mt-6">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} onRetry={load} title="Unable to load Launch Readiness" />
        ) : (
          <div className="space-y-4">
            <div className="rounded-3xl border-2 border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.03)]">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Overall Status</p>
              <p className={`mt-1 flex items-center gap-2 text-2xl font-extrabold ${overallStyle.className}`}>
                <overallStyle.icon size={26} /> {report.overall_status}
              </p>
            </div>
            <div className="rounded-3xl border border-slate-200 bg-white shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
              {report.items.map((item, idx) => {
                const style = STATUS_STYLES[item.status] || STATUS_STYLES.UNKNOWN;
                const Icon = style.icon;
                return (
                  <div key={item.id} className={`flex flex-wrap items-start justify-between gap-3 p-5 ${idx > 0 ? "border-t border-slate-100" : ""}`}>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                        <Icon size={16} className={style.className} /> {item.criterion}
                        <span className="text-xs font-normal text-slate-500">({item.id})</span>
                      </p>
                      <p className="mt-1 text-xs text-slate-500">{item.evidence}</p>
                    </div>
                    <StatusPill status={item.status} />
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
