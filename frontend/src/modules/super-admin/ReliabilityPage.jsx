import React, { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Activity, Database, HelpCircle, CheckCircle2, XCircle, ClipboardList, ClipboardCheck } from "lucide-react";
import { api } from "../../service/api";
import { getJobTelemetry } from "../../service/privilegedAccessService";
import { PageHeader } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";
import TriagePage from "./TriagePage";
import ProductionAcceptancePage from "./ProductionAcceptancePage";

/**
 * ZB-SA-CMD-003 §12 Lens 4 — Reliability.
 *
 * Honest about what exists: "Service Health" here is the real /health
 * liveness check (DB connectivity) — the only service-health signal this
 * platform actually produces today. "Integration Health" and "SLO / Error
 * Budget" modules are NOT rendered as fabricated green tiles; there is no
 * payment-gateway/tax/accounting connector abstraction and no SLO policy
 * engine in this codebase to report on. Queues & Jobs links to the
 * existing Tenant Health page rather than duplicating its telemetry UI.
 */

const FRESHNESS_STYLES = {
  fresh: { className: "text-emerald-700", icon: CheckCircle2, label: "Fresh" },
  stale: { className: "text-amber-600", icon: HelpCircle, label: "Stale" },
  unknown: { className: "text-slate-500", icon: HelpCircle, label: "Unknown" },
};

// This hub ("System Health" in the flat Reporting sidebar section) also
// absorbs two standalone lenses as in-page tabs, deep-linkable via ?tab=.
// Their own standalone routes (/super-admin/reliability/incidents,
// /super-admin/reliability/reprocessing, /super-admin/production-readiness)
// keep working unchanged — this hub just offers a second path to the same
// components.
const HUB_TABS = [
  { key: "health", label: "System Health", icon: Activity },
  { key: "incidents", label: "Incidents & Processing Failures", icon: ClipboardList },
  { key: "release-control", label: "Release Control", icon: ClipboardCheck },
];
const VALID_HUB_TABS = HUB_TABS.map((t) => t.key);

export default function ReliabilityPage() {
  const location = useLocation();
  const isDataQuality = location.pathname === "/super-admin/reliability/data-quality";

  const [searchParams, setSearchParams] = useSearchParams();
  const initialHubTab = VALID_HUB_TABS.includes(searchParams.get("tab")) ? searchParams.get("tab") : "health";
  const [activeHubTab, setActiveHubTabState] = useState(initialHubTab);
  const setActiveHubTab = useCallback(
    (key) => {
      setActiveHubTabState(key);
      setSearchParams({ tab: key }, { replace: true });
    },
    [setSearchParams]
  );

  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    Promise.allSettled([api.get("/health", { auth: false }), getJobTelemetry()]).then(([h, j]) => {
      if (h.status === "fulfilled") setHealth(h.value);
      else setHealthError(h.reason?.message || "Unable to reach the health endpoint.");
      if (j.status === "fulfilled") setJobs(j.value.jobs || []);
      setLoading(false);
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  const failing = (jobs || []).filter((j) => j.last_status === "failed" || j.freshness === "unknown");

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title={isDataQuality ? "Data Quality" : "Reliability"}
        description={
          isDataQuality
            ? "Data-quality checks for tenant and billing records — completeness, consistency and validation issues."
            : "Service health, background job health and freshness. Integration health and SLO/error-budget modules are not shown — no connector abstraction or SLO policy engine exists yet in this codebase (see docs/SUPER_ADMIN_CURRENT_STATE.md)."
        }
        icon={Activity}
      />

      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="System Health sections">
        {HUB_TABS.map((hubTab) => {
          const Icon = hubTab.icon;
          const active = activeHubTab === hubTab.key;
          return (
            <button
              key={hubTab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveHubTab(hubTab.key)}
              className={`inline-flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-sm font-semibold transition-colors ${
                active
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Icon size={15} />
              {hubTab.label}
            </button>
          );
        })}
      </div>

      {activeHubTab === "incidents" ? (
        <div className="mt-6">
          <TriagePage showReprocessing />
        </div>
      ) : activeHubTab === "release-control" ? (
        <div className="mt-6">
          <ProductionAcceptancePage />
        </div>
      ) : isDataQuality ? (
        <div className="mt-6 rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-8">
          <div className="flex flex-col items-center text-center">
            <HelpCircle className="mb-3 h-10 w-10 text-slate-300" />
            <p className="text-sm font-semibold text-slate-700">Not available on this platform</p>
            <p className="mt-2 max-w-lg text-xs text-slate-500">
              Data quality checks are not implemented yet — there is no data-quality-specific backend
              (validation rules, consistency checks, completeness scoring) anywhere in this codebase. The
              database-connectivity and job-freshness signals shown on the System Health page are a
              different, unrelated concept and are intentionally not repeated here under a "Data Quality"
              heading, since that would misrepresent what they measure.
            </p>
          </div>
        </div>
      ) : loading ? (
        <div className="mt-6"><Spinner /></div>
      ) : (
        <div className="mt-6 space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-5">
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-600">
                <Database size={14} /> Database Connectivity
              </p>
              {healthError ? (
                <ErrorState message={healthError} title="Health check unreachable" />
              ) : (
                <p className={`mt-1 flex items-center gap-2 text-xl font-extrabold ${health?.database === "connected" ? "text-emerald-700" : "text-red-600"}`}>
                  {health?.database === "connected" ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
                  {health?.database === "connected" ? "Connected" : "Unavailable"}
                </p>
              )}
            </div>
            <Link to="/super-admin/tenant-health" className="rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-brand-300 hover:shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Queues & Jobs</p>
              <p className="mt-1 text-sm font-semibold text-slate-800">
                {failing.length > 0 ? `${failing.length} job(s) need attention →` : "All tracked jobs healthy →"}
              </p>
            </Link>
          </div>

          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <p className="mb-3 text-sm font-bold text-slate-700">Job Freshness Summary</p>
            {!jobs || jobs.length === 0 ? (
              <p className="text-xs text-slate-500">No job runs recorded yet — expected while the scheduler is disabled or hasn't completed a first run.</p>
            ) : (
              <div className="space-y-2">
                {jobs.map((job) => {
                  const style = FRESHNESS_STYLES[job.freshness] || FRESHNESS_STYLES.unknown;
                  const Icon = style.icon;
                  return (
                    <div key={job.job_name} className="flex items-center justify-between border-b border-slate-100 py-2 text-sm last:border-0">
                      <span className="font-medium text-slate-700">{job.display_name || job.job_name}</span>
                      <span className={`flex items-center gap-1.5 text-xs font-semibold ${style.className}`}>
                        <Icon size={13} /> {style.label}
                        {job.expected_interval_minutes ? ` (every ${job.expected_interval_minutes}m)` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
