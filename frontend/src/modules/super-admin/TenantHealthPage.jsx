import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Activity, CheckCircle2, XCircle, Clock3, RefreshCw, HelpCircle, Briefcase } from "lucide-react";
import { getTenantHealthOverview, getJobTelemetry } from "../../service/privilegedAccessService";
import { PageHeader, DataTable, Button, HubTabs, SearchInput, Select } from "../../components/billing-ui";
import { ErrorState, EmptyState, StatusBadge } from "../../components/billing-shared";
import { formatDateTime, LIFECYCLE_STATE_BADGES, LifecycleStateBadge } from "./constants";
import { useAuth } from "../../context/AuthContext";
import { canReadReliabilityTelemetry } from "../../config/roles";

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

// The API serializes naive UTC datetimes (no "Z"); read them as UTC so the
// timestamps aren't shifted by the viewer's UTC offset.
function parseServerDate(value) {
  if (!value) return null;
  const text = String(value);
  return new Date(/([zZ]|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
}

const formatServerDateTime = (value) => formatDateTime(parseServerDate(value));

function KpiCard({ label, value, tone = "text-slate-900" }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold ${tone}`}>{value}</p>
    </div>
  );
}

const VALID_TABS = ["health", "jobs"];

const TABS = [
  { key: "health", label: "Tenant Health", icon: Activity },
  { key: "jobs", label: "Background Jobs", icon: Briefcase },
];

const LIFECYCLE_FILTER_OPTIONS = Object.entries(LIFECYCLE_STATE_BADGES).map(([value, meta]) => ({ value, label: meta.label }));

export default function TenantHealthPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = VALID_TABS.includes(searchParams.get("tab")) ? searchParams.get("tab") : "health";
  const [activeTab, setActiveTabState] = useState(initialTab);
  const setActiveTab = useCallback(
    (tab) => {
      setActiveTabState(tab);
      setSearchParams({ tab }, { replace: true });
    },
    [setSearchParams]
  );
  const isJobHealth = activeTab === "jobs";
  const { user } = useAuth();
  const canReadTelemetry = canReadReliabilityTelemetry(user?.platform_role);
  const [overview, setOverview] = useState(null);
  const [jobFeed, setJobFeed] = useState(null); // { jobs, scheduler_enabled } once loaded
  const [loading, setLoading] = useState(true);
  // Two independent sources: a failed job feed must not blank the tenant
  // table (it used to — Promise.all rejected the whole page), and vice versa.
  const [error, setError] = useState("");
  const [jobsError, setJobsError] = useState("");
  const [search, setSearch] = useState("");
  const [lifecycleFilter, setLifecycleFilter] = useState("");
  const seqRef = useRef(0);

  // Takes no arguments on purpose — always invoked as () => load().
  const load = useCallback(() => {
    if (!canReadTelemetry) {
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setError("");
    setJobsError("");
    Promise.allSettled([getTenantHealthOverview(), getJobTelemetry()]).then(([healthRes, jobRes]) => {
      if (seq !== seqRef.current) return;
      if (healthRes.status === "fulfilled") setOverview(healthRes.value);
      else setError(healthRes.reason?.message || "Failed to load tenant telemetry.");
      if (jobRes.status === "fulfilled") {
        setJobFeed({ jobs: jobRes.value?.jobs || [], scheduler_enabled: !!jobRes.value?.scheduler_enabled });
      } else {
        setJobsError(jobRes.reason?.message || "Failed to load background job telemetry.");
      }
      setLoading(false);
    });
  }, [canReadTelemetry]);

  useEffect(() => {
    load();
  }, [load]);

  const navigate = useNavigate();

  const columns = [
    {
      key: "organization_name",
      label: "Organization",
      render: (row) => (
        <button
          type="button"
          onClick={() => navigate(`/super-admin/organizations/${row.id}`)}
          className="rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          <span className="block font-medium text-brand-600 hover:text-brand-700">{row.organization_name}</span>
          <span className="block text-xs text-slate-500">{row.organization_code}</span>
        </button>
      ),
    },
    { key: "lifecycle_state", label: "Lifecycle", render: (row) => <LifecycleStateBadge value={row.lifecycle_state} /> },
    {
      key: "users",
      label: "Active / Total Users",
      render: (row) => (
        <span className="text-sm text-slate-700">
          {row.active_users}/{row.total_users}
          {row.suspended_users > 0 && <span className="ml-1 text-xs text-red-600">({row.suspended_users} suspended)</span>}
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
    { key: "last_incident_at", label: "Last Incident", width: 170, render: (row) => formatServerDateTime(row.last_incident_at) },
    { key: "last_activity_at", label: "Last Activity", width: 170, render: (row) => formatServerDateTime(row.last_activity_at) },
  ];

  const organizations = useMemo(() => overview?.organizations || [], [overview]);
  const filtersActive = Boolean(search.trim() || lifecycleFilter);
  const filteredOrganizations = useMemo(() => {
    const q = search.trim().toLowerCase();
    return organizations.filter((row) => {
      if (lifecycleFilter && row.lifecycle_state !== lifecycleFilter) return false;
      if (!q) return true;
      return (
        String(row.organization_name || "").toLowerCase().includes(q) ||
        String(row.organization_code || "").toLowerCase().includes(q)
      );
    });
  }, [organizations, search, lifecycleFilter]);
  const clearFilters = () => {
    setSearch("");
    setLifecycleFilter("");
  };

  const summary = overview?.summary;
  const fleetSummarySection = summary && (
    <section aria-label="Fleet summary" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard label="Open Incidents" value={summary.open_incident_total} tone={summary.open_incident_total > 0 ? "text-red-600" : "text-emerald-700"} />
      <KpiCard label="Jobs With Failures (24h)" value={summary.jobs_with_failures_24h} tone={summary.jobs_with_failures_24h > 0 ? "text-red-600" : "text-slate-900"} />
      <KpiCard label="Jobs Not Fresh" value={summary.jobs_not_fresh} tone={summary.jobs_not_fresh > 0 ? "text-amber-600" : "text-slate-900"} />
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-slate-600">Organizations by Lifecycle</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {Object.entries(LIFECYCLE_STATE_BADGES).map(([state, meta]) => (
            <span key={state} className="inline-flex items-center gap-1.5 text-xs">
              <StatusBadge status={state} options={[{ value: state, ...meta }]} />
              <strong className="text-slate-800">{summary.counts_by_lifecycle_state?.[state] ?? 0}</strong>
            </span>
          ))}
        </div>
      </div>
    </section>
  );

  const tenantTableSection = overview && (
    <section aria-label="Organizations">
      <div className="mb-3 flex items-center gap-2 px-1">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-600">Tenant Operational View</h2>
        <span className="h-px flex-1 bg-slate-200/70" />
        {filtersActive && (
          <span className="text-xs font-medium text-slate-500">
            {filteredOrganizations.length} of {organizations.length}
          </span>
        )}
      </div>
      {organizations.length > 0 && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search organization name or code"
            className="sm:max-w-sm sm:flex-1"
          />
          <Select
            value={lifecycleFilter}
            onChange={setLifecycleFilter}
            options={LIFECYCLE_FILTER_OPTIONS}
            placeholder="All lifecycle states"
            aria-label="Filter by lifecycle state"
            className="sm:w-56"
          />
          {filtersActive && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button>
          )}
        </div>
      )}
      <DataTable
        columns={columns}
        data={filteredOrganizations}
        rowKey={(row) => row.id}
        emptyTitle={filtersActive ? "No organizations match these filters" : "No organizations yet"}
        emptyMessage={
          filtersActive
            ? "Try a different search term or lifecycle state."
            : "Operational rows will appear here as organizations are provisioned."
        }
        emptyAction={filtersActive ? <Button variant="secondary" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
        minWidth={880}
      />
    </section>
  );

  const jobs = jobFeed?.jobs || [];
  const jobHealthSection = (
    <section aria-label="Background job health" className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <p className="mb-1 text-sm font-bold text-slate-700">Background Job Health</p>
      {jobsError && !jobFeed ? (
        <ErrorState message={jobsError} onRetry={() => load()} title="Unable to load background jobs" />
      ) : !jobFeed ? (
        <p className="py-6 text-center text-sm text-slate-500">Loading job telemetry…</p>
      ) : (
        <>
          {jobsError && (
            <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              Couldn't refresh job telemetry: {jobsError} Showing the last loaded runs.
            </p>
          )}
          {!jobFeed.scheduler_enabled && (
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
                  <div className="min-w-0">
                    <span className="font-semibold text-slate-800">{job.display_name || job.job_name}</span>
                    <span className="ml-2 text-xs text-slate-500">last run {formatServerDateTime(job.last_started_at)}</span>
                    {job.last_status === "failed" && job.last_error && (
                      <span className="mt-0.5 block wrap-break-word text-xs text-red-600">{job.last_error}</span>
                    )}
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
        </>
      )}
    </section>
  );

  const metaParts = [];
  if (summary) metaParts.push(`${summary.total_organizations} organization${summary.total_organizations === 1 ? "" : "s"}`);
  if (jobFeed) metaParts.push(`${jobs.length} background job${jobs.length === 1 ? "" : "s"} tracked`);

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Tenant Health"
        description="Operational health across every tenant — lifecycle states, user counts, open incidents and background job runs. Counts and states only: never money amounts, never a made-up health score."
        icon={Activity}
        meta={metaParts.length ? metaParts.join(" · ") : null}
        actions={
          <Button
            variant="secondary"
            icon={RefreshCw}
            onClick={() => load()}
            loading={loading && Boolean(overview || jobFeed)}
            disabled={loading || !canReadTelemetry}
          >
            Refresh
          </Button>
        }
      />

      <HubTabs tabs={TABS} active={activeTab} onChange={setActiveTab} label="Tenant Health sections" />

      {!canReadTelemetry ? (
        <div className="mt-6 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm">
          <HelpCircle size={18} className="mt-0.5 shrink-0 text-amber-500" />
          <p className="text-amber-800">
            Not available — your platform role does not include the reliability.read capability. Ask a Platform
            Administrator for access.
          </p>
        </div>
      ) : isJobHealth ? (
        <div className="mt-6">{jobHealthSection}</div>
      ) : error && !overview ? (
        <div className="mt-6 rounded-2xl border border-red-200 bg-white">
          <ErrorState message={error} onRetry={() => load()} title="Unable to load tenant telemetry" />
        </div>
      ) : overview ? (
        <div className="mt-6 space-y-8">
          {error && (
            <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
              Couldn't refresh tenant telemetry: {error} Showing the last loaded data.
            </p>
          )}
          {fleetSummarySection}
          {tenantTableSection}
        </div>
      ) : loading ? (
        <div className="mt-6">
          <DataTable columns={columns} data={[]} loading minWidth={880} />
        </div>
      ) : null}
    </div>
  );
}
