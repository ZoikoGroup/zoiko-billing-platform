import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, CheckCircle2, XCircle, Clock3, RefreshCw } from "lucide-react";
import { getTenantHealthOverview, getJobTelemetry } from "../../service/privilegedAccessService";
import { PageHeader, DataTable } from "../../components/billing-ui";
import { ErrorState, EmptyState, StatusBadge } from "../../components/billing-shared";
import { formatDateTime, displayValue, LIFECYCLE_STATE_BADGES, LifecycleStateBadge } from "./constants";

/**
 * Domain C (Tenant Telemetry) — ZB-SA-P3 Phase 3D.
 *
 * Every value on this page is a count, a state or a timestamp served by
 * GET /super-admin/telemetry/tenant-health (plus the job feed). Nothing is a
 * monetary amount, nothing is derived client-side, and there is no invented
 * "health score" — evidence counters are shown as-is (ZB-SA-CMD-003 §8).
 */

const SEVERITY_BADGES = {
  p0: { label: "P0", color: "bg-red-100 text-red-700" },
  p1: { label: "P1", color: "bg-orange-100 text-orange-700" },
  p2: { label: "P2", color: "bg-amber-100 text-amber-700" },
  p3: { label: "P3", color: "bg-slate-100 text-slate-600" },
};

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

function SeverityBadge({ value }) {
  if (!value) return <span className="text-xs text-slate-400">—</span>;
  const option = SEVERITY_BADGES[value] || { label: value.toUpperCase(), color: "bg-slate-100 text-slate-600" };
  return <StatusBadge status={value} options={[{ value, ...option }]} />;
}

function KpiCard({ label, value, tone = "text-slate-900" }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold ${tone}`}>{value}</p>
    </div>
  );
}

export default function TenantHealthPage() {
  const [overview, setOverview] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [schedulerEnabled, setSchedulerEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    Promise.all([getTenantHealthOverview(), getJobTelemetry()])
      .then(([healthRes, jobRes]) => {
        setOverview(healthRes);
        setJobs(jobRes.jobs || []);
        setSchedulerEnabled(!!jobRes.scheduler_enabled);
      })
      .catch((e) => setError(e?.message || "Failed to load tenant telemetry."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const navigate = useNavigate();

  const columns = [
    {
      key: "organization_name",
      label: "Organization",
      render: (row) => (
        <button type="button" onClick={() => navigate(`/super-admin/organizations/${row.id}`)} className="text-left">
          <span className="block font-medium text-brand-600 hover:text-brand-700">{row.organization_name}</span>
          <span className="block text-xs text-slate-500">{row.organization_code}</span>
        </button>
      ),
    },
    { key: "lifecycle_state", label: "Lifecycle", render: (row) => <LifecycleStateBadge value={row.lifecycle_state} /> },
    {
      key: "users",
      label: "Users",
      render: (row) => (
        <span className="text-sm text-slate-700">
          {row.active_users}/{row.total_users}
          {row.suspended_users > 0 && <span className="ml-1 text-xs text-red-600">({row.suspended_users} off)</span>}
        </span>
      ),
    },
    {
      key: "open_incident_count",
      label: "Open Incidents",
      render: (row) =>
        row.open_incident_count > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="font-bold text-slate-800">{row.open_incident_count}</span>
            <SeverityBadge value={row.worst_open_severity} />
          </span>
        ) : (
          <span className="text-xs text-slate-400">None</span>
        ),
    },
    { key: "last_incident_at", label: "Last Incident", width: 170, render: (row) => formatDateTime(row.last_incident_at) },
    { key: "last_activity_at", label: "Last Activity", width: 170, render: (row) => formatDateTime(row.last_activity_at) },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Tenant Health"
        description={
          <>
            Cross-tenant operational telemetry (Domain C) — lifecycle states, user counts, open incidents and job health.
            Counts and states only: never monetary amounts, never cross-tenant financial totals, never an invented score.
          </>
        }
        icon={Activity}
        meta={overview ? `${overview.summary.total_organizations} organization(s) · plane ${overview.plane}` : ""}
        actions={
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        }
      />

      {error && (
        <div className="mt-6 rounded-2xl border border-red-200 bg-white">
          <ErrorState message={error} onRetry={load} title="Unable to load tenant telemetry" />
        </div>
      )}

      {overview && !error && (
        <>
          {/* ── Fleet summary ────────────────────────────────────────── */}
          <section aria-label="Fleet summary" className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Open Incidents" value={overview.summary.open_incident_total} tone={overview.summary.open_incident_total > 0 ? "text-red-600" : "text-emerald-700"} />
            <KpiCard label="Jobs With Failures (24h)" value={overview.summary.jobs_with_failures_24h} tone={overview.summary.jobs_with_failures_24h > 0 ? "text-red-600" : "text-slate-900"} />
            <KpiCard label="Jobs Not Fresh" value={overview.summary.jobs_not_fresh} tone={overview.summary.jobs_not_fresh > 0 ? "text-amber-600" : "text-slate-900"} />
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
              <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-slate-600">Organizations by Lifecycle</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {Object.entries(LIFECYCLE_STATE_BADGES).map(([state, meta]) => (
                  <span key={state} className="inline-flex items-center gap-1.5 text-xs">
                    <StatusBadge status={state} options={[{ value: state, ...meta }]} />
                    <strong className="text-slate-800">{overview.summary.counts_by_lifecycle_state?.[state] ?? 0}</strong>
                  </span>
                ))}
              </div>
            </div>
          </section>

          {/* ── Per-tenant operational rows ──────────────────────────── */}
          <section aria-label="Organizations" className="mt-8">
            <div className="mb-3 flex items-center gap-2 px-1">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-600">Tenant Operational View</h2>
              <span className="h-px flex-1 bg-slate-200/70" />
            </div>
            <DataTable
              columns={columns}
              data={overview.organizations}
              loading={loading}
              rowKey={(row) => row.id}
              emptyTitle="No organizations yet"
              emptyMessage="Operational rows will appear here as organizations are provisioned."
              minWidth={880}
            />
          </section>

          {/* ── Background job health ────────────────────────────────── */}
          <section aria-label="Background job health" className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <p className="mb-1 text-sm font-bold text-slate-700">Background Job Health</p>
            {!schedulerEnabled && (
              <p className="mb-3 text-xs text-amber-600">
                The recurring-billing scheduler is currently disabled
                (ENABLE_RECURRING_BILLING_SCHEDULER=false) — no job runs are expected until it is enabled.
              </p>
            )}
            {jobs.length === 0 ? (
              <EmptyState
                icon={Clock3}
                title="No job runs recorded yet"
                message="This is expected while the scheduler is disabled or has not completed its first run — not a fabricated healthy state."
              />
            ) : (
              <div className="space-y-2">
                {jobs.map((job) => (
                  <div key={job.job_name} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 py-2.5 text-sm last:border-0">
                    <div>
                      <span className="font-semibold text-slate-800">{job.display_name || job.job_name}</span>
                      <span className="ml-2 text-xs text-slate-500">last run {formatDateTime(job.last_started_at)}</span>
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
          </section>
        </>
      )}
    </div>
  );
}
