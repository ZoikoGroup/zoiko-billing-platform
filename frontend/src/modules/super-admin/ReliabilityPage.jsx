import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity,
  Database,
  Zap,
  HelpCircle,
  CheckCircle2,
  XCircle,
  ClipboardList,
  ClipboardCheck,
  RefreshCw,
} from "lucide-react";
import { api } from "../../service/api";
import { getJobTelemetry } from "../../service/privilegedAccessService";
import { PageHeader, Button, SearchInput, HubTabs, SectionCard } from "../../components/billing-ui";
import { ErrorState } from "../../components/billing-shared";
import { formatDateTime } from "./constants";
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
 *
 * The same rule governs this page's own two fetches: a failed job-telemetry
 * call renders a real error state with a retry, never the "no job runs
 * recorded yet" empty state — an unreachable endpoint is not evidence of an
 * idle scheduler (see CommandCenterHubPage's `sourceErrors` pattern for the
 * same signal).
 *
 * The former /super-admin/reliability/data-quality route is now a redirect in
 * App.jsx: it always rendered a permanent "not implemented" placeholder, and
 * there are no data-quality checks anywhere in this codebase to put behind
 * it. Nothing reachable from the current UI linked to it.
 */

const FRESHNESS_STYLES = {
  fresh: { className: "text-emerald-700", icon: CheckCircle2, label: "Fresh" },
  stale: { className: "text-amber-600", icon: HelpCircle, label: "Stale" },
  unknown: { className: "text-slate-500", icon: HelpCircle, label: "Unknown" },
};

// Worst-first ordering for the job list, so a stopped or failing job is the
// first thing read rather than the twentieth. Mirrors the P0-first convention
// used by the Command Center's AttentionModule.
const JOB_SEVERITY_ORDER = { failed: 0, unknown: 1, stale: 2, fresh: 3 };
const JOB_SEVERITY_STYLES = {
  failed: { chip: "bg-red-100 text-red-700", label: "failed" },
  unknown: { chip: "bg-slate-100 text-slate-600", label: "unknown" },
  stale: { chip: "bg-amber-100 text-amber-700", label: "stale" },
  fresh: { chip: "bg-emerald-100 text-emerald-700", label: "healthy" },
};

function jobSeverity(job) {
  if (job.last_status === "failed") return "failed";
  if (job.freshness === "unknown") return "unknown";
  if (job.freshness === "stale") return "stale";
  return "fresh";
}

function formatAge(date) {
  if (!date) return null;
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// This hub ("System Health" in the flat Reporting sidebar section) also
// absorbs two standalone lenses as in-page tabs, deep-linkable via ?tab=.
// Their own standalone routes (/super-admin/reliability/incidents,
// /super-admin/reliability/reprocessing, /super-admin/production-readiness)
// keep working unchanged — this hub just offers a second path to the same
// components, rendered with `embedded` so only the hub's header shows.
//
// Each tab carries its own title/description: the header used to branch on the
// URL path only, so clicking a tab left a header describing a different tab
// sitting directly above the embedded page's own header.
const HUB_TABS = [
  {
    key: "health",
    label: "System Health",
    icon: Activity,
    title: "System Health",
    description:
      "Service health, background job health and freshness. Integration health and SLO/error-budget modules are not shown — no connector abstraction or SLO policy engine exists yet in this codebase (see docs/SUPER_ADMIN_CURRENT_STATE.md).",
  },
  {
    key: "incidents",
    label: "Incidents & Processing Failures",
    icon: ClipboardList,
    title: "Incidents & Processing Failures",
    description:
      "Real-time incident response, 7-stage processing pipeline telemetry, circuit-breaker safety controls, and retry of failed background jobs.",
  },
  {
    key: "release-control",
    label: "Release Control",
    icon: ClipboardCheck,
    title: "Release Control",
    description:
      "The ZB-COM-BILL-001 §26 mandatory production acceptance checklist — a point-in-time architecture assessment, not live monitoring.",
  },
];
const VALID_HUB_TABS = HUB_TABS.map((t) => t.key);

function FreshnessStamp({ checkedAt, latencyMs }) {
  const age = formatAge(checkedAt);
  if (!age) return null;
  return (
    <p className="mt-2 text-xs text-slate-500">
      Checked {age}
      {latencyMs != null && ` · responded in ${latencyMs} ms`}
    </p>
  );
}

function CountChip({ count, severity }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${JOB_SEVERITY_STYLES[severity].chip}`}>
      {count} {JOB_SEVERITY_STYLES[severity].label}
    </span>
  );
}

export default function ReliabilityPage() {
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
  const activeTabMeta = HUB_TABS.find((t) => t.key === activeHubTab) || HUB_TABS[0];

  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState(null);
  const [healthCheckedAt, setHealthCheckedAt] = useState(null);
  const [healthLatencyMs, setHealthLatencyMs] = useState(null);
  const [jobs, setJobs] = useState(null);
  const [jobsError, setJobsError] = useState(null);
  const [jobsCheckedAt, setJobsCheckedAt] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [jobFilter, setJobFilter] = useState("");
  // Ticks only while the health tab is on screen so the "as of" stamps keep
  // counting up, without re-fetching or leaving a timer running behind the
  // other two tabs. The value itself is never read — re-render is the point.
  const [, setClockTick] = useState(0);

  const load = useCallback(async ({ background = false } = {}) => {
    // A background refresh keeps the previous snapshot on screen (no skeleton
    // flash) but still disables the button and shows "Refreshing…".
    if (background) setRefreshing(true);
    else setLoading(true);
    setHealthError(null);
    setJobsError(null);

    const healthStartedAt = Date.now();
    const [h, j] = await Promise.allSettled([
      api.get("/health", { auth: false }),
      getJobTelemetry(),
    ]);
    setHealthLatencyMs(Date.now() - healthStartedAt);

    if (h.status === "fulfilled") {
      setHealth(h.value);
      setHealthCheckedAt(new Date());
    } else {
      setHealth(null);
      setHealthCheckedAt(null);
      setHealthError(h.reason?.message || "Unable to reach the health endpoint.");
    }

    if (j.status === "fulfilled") {
      setJobs(j.value?.jobs || []);
      setJobsCheckedAt(new Date());
    } else {
      // Never leave `jobs` null on failure: null is the "not loaded yet" value
      // the render below would otherwise describe as "no job runs recorded
      // yet" — a fabricated explanation for what is actually a failed fetch.
      setJobs([]);
      setJobsCheckedAt(null);
      setJobsError(j.reason?.message || "Unable to reach the job telemetry endpoint.");
    }

    setLoading(false);
    setRefreshing(false);
    setClockTick((tick) => tick + 1);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (activeHubTab !== "health") return undefined;
    const id = setInterval(() => setClockTick((tick) => tick + 1), 5000);
    return () => clearInterval(id);
  }, [activeHubTab]);

  const handleRefresh = useCallback(() => {
    load({ background: true });
  }, [load]);

  const counts = useMemo(() => {
    const tally = { failed: 0, unknown: 0, stale: 0, fresh: 0 };
    for (const job of jobs || []) tally[jobSeverity(job)] += 1;
    return tally;
  }, [jobs]);

  const visibleJobs = useMemo(() => {
    const ordered = [...(jobs || [])].sort((a, b) => {
      const bySeverity = JOB_SEVERITY_ORDER[jobSeverity(a)] - JOB_SEVERITY_ORDER[jobSeverity(b)];
      if (bySeverity !== 0) return bySeverity;
      return String(a.display_name || a.job_name).localeCompare(String(b.display_name || b.job_name));
    });
    const needle = jobFilter.trim().toLowerCase();
    if (!needle) return ordered;
    return ordered.filter((job) =>
      `${job.display_name || ""} ${job.job_name || ""}`.toLowerCase().includes(needle)
    );
  }, [jobs, jobFilter]);

  const failing = (jobs || []).filter((job) => jobSeverity(job) !== "fresh");
  const dbConnected = health?.database === "connected";
  const redisConnected = health?.redis === "connected";

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title={activeTabMeta.title}
        description={activeTabMeta.description}
        icon={Activity}
        accent="teal"
        meta={activeHubTab === "health" && healthCheckedAt ? `Last checked ${formatAge(healthCheckedAt)}` : null}
        actions={
          <Button variant="secondary" icon={RefreshCw} loading={loading || refreshing} onClick={handleRefresh}>
            {loading || refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />

      <HubTabs tabs={HUB_TABS} active={activeHubTab} onChange={setActiveHubTab} label="System Health sections" accent="teal" />

      {activeHubTab === "incidents" ? (
        <div className="mt-6">
          <TriagePage showReprocessing embedded />
        </div>
      ) : activeHubTab === "release-control" ? (
        <div className="mt-6">
          <ProductionAcceptancePage embedded />
        </div>
      ) : loading ? (
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="h-32 animate-pulse rounded-2xl border border-slate-200 bg-white/60" aria-hidden="true" />
          <div className="h-32 animate-pulse rounded-2xl border border-slate-200 bg-white/60" aria-hidden="true" />
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SectionCard variant="hero" accent="teal" icon={Database} title="Database Connectivity">
              {healthError ? (
                <ErrorState message={healthError} onRetry={handleRefresh} title="Health check unreachable" />
              ) : (
                <>
                  <p className={`flex items-center gap-2 text-xl font-extrabold ${dbConnected ? "text-emerald-700" : "text-red-600"}`}>
                    {dbConnected ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
                    {dbConnected ? "Connected" : "Unavailable"}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {health?.status
                      ? `Service reports "${health.status}".`
                      : "The health endpoint returned no status field."}
                  </p>
                  <FreshnessStamp checkedAt={healthCheckedAt} latencyMs={healthLatencyMs} />
                </>
              )}
            </SectionCard>

            {/* Not fatal when disconnected — every cached read falls back to
                a process-local cache automatically — but this is the only
                place in the product that surfaces whether a deployed
                REDIS_URL is actually connected, instead of requiring a log
                grep. A "Not connected" reading here after a Redis deploy
                means dashboard reads are still uncached / not shared across
                instances. */}
            {!healthError && health?.redis && (
              <SectionCard variant="standard" accent="teal" icon={Zap} title="Cache (Redis)">
                <p className={`flex items-center gap-2 text-xl font-extrabold ${redisConnected ? "text-emerald-700" : "text-amber-600"}`}>
                  {redisConnected ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
                  {redisConnected ? "Connected" : "Not connected"}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {redisConnected
                    ? "Dashboard reads across this hub are served from Redis, shared across every backend instance."
                    : "Falling back to a per-instance in-process cache — set REDIS_URL on this deployment to share cached reads across instances."}
                </p>
              </SectionCard>
            )}

            <SectionCard variant="hero" accent="teal" title="Queues & Jobs">
              {jobsError ? (
                <>
                  <p className="text-sm font-semibold text-red-600">Job telemetry unavailable</p>
                  <p className="mt-1 text-xs text-slate-500">
                    The scheduler telemetry endpoint could not be reached, so job health cannot be claimed — this is a
                    failed request, not an idle scheduler. Retry to re-request it.
                  </p>
                  <div className="mt-3">
                    <Button size="sm" variant="secondary" icon={RefreshCw} onClick={handleRefresh}>
                      Retry
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <Link
                    to="/super-admin/tenant-health"
                    className="block text-sm font-semibold text-slate-800 hover:text-brand-700"
                  >
                    {failing.length > 0 ? `${failing.length} job(s) need attention →` : "All tracked jobs healthy →"}
                  </Link>
                  <FreshnessStamp checkedAt={jobsCheckedAt} />
                </>
              )}
            </SectionCard>
          </div>

          <SectionCard
            variant="standard"
            title="Job Freshness Summary"
            actions={
              jobs !== null && !jobsError ? (
                <div className="flex flex-wrap gap-1.5" aria-label="Job health counts">
                  <CountChip count={counts.failed} severity="failed" />
                  <CountChip count={counts.stale} severity="stale" />
                  <CountChip count={counts.unknown} severity="unknown" />
                  <CountChip count={counts.fresh} severity="fresh" />
                </div>
              ) : null
            }
          >
            {jobsError ? (
              <div className="rounded-2xl border border-slate-200">
                <ErrorState
                  message={jobsError}
                  onRetry={handleRefresh}
                  title="Job telemetry could not be loaded"
                />
              </div>
            ) : jobs === null ? (
              <p className="text-xs text-slate-500">Loading job telemetry…</p>
            ) : jobs.length === 0 ? (
              <p className="text-xs text-slate-500">
                No job runs recorded yet — the telemetry request succeeded and the scheduler has no run history to report
                (expected while the scheduler is disabled or before its first run).
              </p>
            ) : (
              <>
                {/* 15 recurring jobs are registered in core/scheduler.py today and the
                    list grows with each new one, so a filter earns its space here
                    rather than scrolling past 15 rows to spot a stopped job. */}
                {jobs.length > 10 && (
                  <div className="mb-3 max-w-xs">
                    <SearchInput
                      value={jobFilter}
                      onChange={setJobFilter}
                      placeholder="Filter jobs…"
                      aria-label="Filter jobs by name"
                    />
                  </div>
                )}
                {visibleJobs.length === 0 ? (
                  <p className="text-xs text-slate-500">No job matches “{jobFilter}”.</p>
                ) : (
                  <div className="space-y-2">
                    {visibleJobs.map((job) => {
                      const severity = jobSeverity(job);
                      const style = FRESHNESS_STYLES[job.freshness] || FRESHNESS_STYLES.unknown;
                      const FreshnessIcon = style.icon;
                      return (
                        <div
                          key={job.job_name}
                          className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 py-2 text-sm last:border-0"
                        >
                          <span className="min-w-0">
                            <span className="font-medium text-slate-700">{job.display_name || job.job_name}</span>
                            {job.last_error && <span className="mt-0.5 block text-xs text-red-600">{job.last_error}</span>}
                            {job.last_started_at && (
                              <span className="mt-0.5 block text-[11px] text-slate-400">
                                Last run {formatDateTime(job.last_started_at)}
                              </span>
                            )}
                          </span>
                          <span
                            className={`flex items-center gap-1.5 text-xs font-semibold ${
                              severity === "failed" ? "text-red-600" : style.className
                            }`}
                          >
                            {severity === "failed" ? <XCircle size={13} /> : <FreshnessIcon size={13} />}{" "}
                            {severity === "failed" ? "Failed" : style.label}
                            {job.expected_interval_minutes ? ` (every ${job.expected_interval_minutes}m)` : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </SectionCard>
        </div>
      )}
    </div>
  );
}
