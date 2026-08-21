import React, { useCallback, useEffect, useState } from "react";
import { Activity, Building2, CheckCircle2, XCircle, Clock3 } from "lucide-react";
import { getOrganizationTelemetry, getJobTelemetry } from "../../service/privilegedAccessService";
import { PageHeader } from "../../components/billing-ui";
import { ErrorState, Spinner, EmptyState } from "../../components/billing-shared";
import { formatDateTime } from "./constants";

/**
 * Domain C (Tenant Telemetry) — cross-tenant OPERATIONAL health only.
 * Every number on this page is a count, a status or a timestamp; nothing
 * here is a monetary amount or a per-tenant financial breakdown
 * (ZB-SA-CMD-003 §8). "Queue age" / "connector state" are intentionally
 * absent — this platform has no real message queue or gateway-connector
 * abstraction to report on honestly today.
 */

const JOB_STATUS_STYLES = {
  succeeded: { icon: CheckCircle2, className: "text-emerald-700", label: "Succeeded" },
  failed: { icon: XCircle, className: "text-red-600", label: "Failed" },
  running: { icon: Clock3, className: "text-amber-600", label: "Running" },
};

function JobStatusIndicator({ status }) {
  const style = JOB_STATUS_STYLES[status] || { icon: Clock3, className: "text-slate-500", label: "No runs yet" };
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-semibold ${style.className}`}>
      <Icon size={15} /> {style.label}
    </span>
  );
}

export default function TenantHealthPage() {
  const [orgHealth, setOrgHealth] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [schedulerEnabled, setSchedulerEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([getOrganizationTelemetry(), getJobTelemetry()])
      .then(([orgRes, jobRes]) => {
        setOrgHealth(orgRes);
        setJobs(jobRes.jobs || []);
        setSchedulerEnabled(!!jobRes.scheduler_enabled);
      })
      .catch((e) => setError(e?.message || "Failed to load tenant telemetry."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Tenant Health"
        description="Cross-tenant operational telemetry (Domain C) — counts, job status and health classifications only. No cross-tenant financial totals are ever shown here."
        icon={Activity}
      />

      <div className="mt-6 space-y-6">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState message={error} onRetry={load} title="Unable to load tenant telemetry" />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-600">
                  <Building2 size={14} /> Total Organizations
                </p>
                <p className="mt-1 text-2xl font-extrabold text-slate-900">{orgHealth?.total_organizations ?? "—"}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Active</p>
                <p className="mt-1 text-2xl font-extrabold text-emerald-700">{orgHealth?.active_organizations ?? "—"}</p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Suspended</p>
                <p className="mt-1 text-2xl font-extrabold text-amber-600">{orgHealth?.suspended_organizations ?? "—"}</p>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
              <p className="mb-1 text-sm font-bold text-slate-700">Background Job Health</p>
              {!schedulerEnabled && (
                <p className="mb-3 text-xs text-amber-600">
                  The recurring-billing scheduler is currently disabled
                  (ENABLE_RECURRING_BILLING_SCHEDULER=false) — no job runs are expected until it is enabled.
                </p>
              )}
              {jobs && jobs.length === 0 ? (
                <EmptyState
                  icon={Clock3}
                  title="No job runs recorded yet"
                  message="This is expected while the scheduler is disabled or has not completed its first run — not a fabricated healthy state."
                />
              ) : (
                <div className="space-y-2">
                  {(jobs || []).map((job) => (
                    <div key={job.job_name} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 py-2.5 text-sm last:border-0">
                      <div>
                        <span className="font-semibold text-slate-800">{job.display_name || job.job_name}</span>
                        <span className="ml-2 text-xs text-slate-500">
                          last run {formatDateTime(job.last_started_at)}
                        </span>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-xs text-slate-500">
                          {job.run_count_24h} runs / {job.failure_count_24h} failures (24h)
                        </span>
                        <JobStatusIndicator status={job.last_status} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
