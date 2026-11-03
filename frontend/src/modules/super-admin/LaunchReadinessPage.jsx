import React, { useCallback, useEffect, useRef, useState } from "react";
import { ClipboardCheck, CheckCircle2, XCircle, AlertTriangle, HelpCircle, RefreshCw } from "lucide-react";
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

// Plain-language reading of the overall verdict (the service's rule: any
// FAIL -> FAIL; any WARNING/UNKNOWN -> WARNING; otherwise PASS).
const OVERALL_COPY = {
  PASS: "Every check passed.",
  FAIL: "At least one check failed — resolve the failing items before launch.",
  WARNING: "No check failed, but some need attention or could not be verified here.",
  UNKNOWN: "The overall state could not be determined.",
};

const STATUS_ORDER = ["FAIL", "WARNING", "UNKNOWN", "PASS"];
const FILTER_LABELS = { FAIL: "Failed", WARNING: "Warnings", UNKNOWN: "Unverified", PASS: "Passed" };

export default function LaunchReadinessPage() {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState(null);
  const seqRef = useRef(0);

  // Takes no arguments on purpose — wired straight to onClick handlers.
  const load = useCallback(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    api.get("/api/super-admin/launch-readiness")
      .then((res) => {
        if (seq === seqRef.current) setReport(res);
      })
      .catch((e) => {
        if (seq === seqRef.current) setError(e?.message || "Failed to load Launch Readiness.");
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false);
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  const items = Array.isArray(report?.items) ? report.items : [];
  const overallStyle = report ? STATUS_STYLES[report.overall_status] || STATUS_STYLES.UNKNOWN : null;
  const countsByStatus = items.reduce((acc, item) => {
    const key = STATUS_STYLES[item.status] ? item.status : "UNKNOWN";
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  // Worst first so failing checks are never buried under passing ones.
  const rank = (status) => {
    const idx = STATUS_ORDER.indexOf(status);
    return idx === -1 ? STATUS_ORDER.indexOf("UNKNOWN") : idx;
  };
  const visibleItems = items
    .filter((item) => !filter || (STATUS_STYLES[item.status] ? item.status : "UNKNOWN") === filter)
    .sort((a, b) => rank(a.status) - rank(b.status));

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Launch Readiness"
        description="Real checks against the Command Center's own operational state — database, secrets, MFA step-up status, audit logging, scheduler health, CORS, open P0/P1 attention, and internal financial consistency. UNKNOWN means genuinely not verifiable here (e.g. accessibility, performance), never a hidden PASS."
        icon={ClipboardCheck}
        meta={report ? `${items.length} check${items.length === 1 ? "" : "s"}` : null}
        actions={
          <Button variant="secondary" icon={RefreshCw} onClick={() => load()} loading={loading && Boolean(report)} disabled={loading}>
            Re-run checks
          </Button>
        }
      />

      <div className="mt-6">
        {loading && !report ? (
          <Spinner />
        ) : error && !report ? (
          <ErrorState message={error} onRetry={() => load()} title="Unable to load Launch Readiness" />
        ) : report ? (
          <div className="space-y-4">
            {error && (
              <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
                Couldn't re-run the checks: {error} Showing the previous results.
              </p>
            )}
            <div className="rounded-3xl border-2 border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.03)]">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Overall Status</p>
              <p className={`mt-1 flex items-center gap-2 text-2xl font-extrabold ${overallStyle.className}`}>
                <overallStyle.icon size={26} /> {report.overall_status}
              </p>
              <p className="mt-1 text-sm text-slate-500">{OVERALL_COPY[report.overall_status] || OVERALL_COPY.UNKNOWN}</p>
              {items.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter checks by result">
                  <button
                    type="button"
                    aria-pressed={!filter}
                    onClick={() => setFilter(null)}
                    className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${!filter ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                  >
                    All {items.length}
                  </button>
                  {STATUS_ORDER.filter((status) => countsByStatus[status]).map((status) => (
                    <button
                      key={status}
                      type="button"
                      aria-pressed={filter === status}
                      onClick={() => setFilter(filter === status ? null : status)}
                      className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${filter === status ? "border-brand-500 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                    >
                      {FILTER_LABELS[status]} {countsByStatus[status]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-3xl border border-slate-200 bg-white shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
              {items.length === 0 ? (
                <p className="p-6 text-center text-sm text-slate-500">The server returned no readiness checks.</p>
              ) : (
                visibleItems.map((item, idx) => {
                  const style = STATUS_STYLES[item.status] || STATUS_STYLES.UNKNOWN;
                  const Icon = style.icon;
                  return (
                    <div key={item.id} className={`flex flex-wrap items-start justify-between gap-3 p-5 ${idx > 0 ? "border-t border-slate-100" : ""}`}>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                          <Icon size={16} className={`shrink-0 ${style.className}`} /> {item.criterion}
                          <span className="text-xs font-normal text-slate-500">({item.id})</span>
                        </p>
                        {item.evidence && <p className="mt-1 text-xs text-slate-500">{item.evidence}</p>}
                      </div>
                      <StatusPill status={item.status} />
                    </div>
                  );
                })
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
