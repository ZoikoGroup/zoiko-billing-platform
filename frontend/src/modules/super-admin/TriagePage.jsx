import React, { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRightCircle,
  BellOff,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  Eye,
  HelpCircle,
  Power,
  RefreshCw,
  RotateCcw,
  UserPlus,
} from "lucide-react";
import {
  getTriageSummary,
  acknowledgeAttentionItem,
  assignAttentionItem,
  transitionAttentionItem,
  suppressAttentionItem,
} from "../../service/commandCenterService";
import { getJobTelemetry, retryJob } from "../../service/privilegedAccessService";
import { Button, Field, FORM_CONTROL_CLASS, Modal, PageHeader, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";
import { useAuth } from "../../context/AuthContext";
import { ATTENTION_ACTIONS, formatDateTime } from "./constants";

const SEVERITY_BADGES = {
  p0: "bg-rose-100 text-rose-800 border-rose-200",
  p1: "bg-orange-100 text-orange-800 border-orange-200",
  p2: "bg-amber-100 text-amber-800 border-amber-200",
  p3: "bg-slate-100 text-slate-700 border-slate-200",
};

const STATUS_BADGES = {
  open: "bg-rose-50 text-rose-700 border-rose-200",
  acknowledged: "bg-amber-50 text-amber-700 border-amber-200",
  assigned: "bg-blue-50 text-blue-700 border-blue-200",
  mitigating: "bg-purple-50 text-purple-700 border-purple-200",
  monitoring: "bg-indigo-50 text-indigo-700 border-indigo-200",
  resolved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  closed: "bg-slate-50 text-slate-600 border-slate-200",
  suppressed: "bg-slate-100 text-slate-500 border-slate-200",
};

const {
  acknowledge: CAN_ACKNOWLEDGE,
  assign: CAN_ASSIGN,
  mitigate: CAN_MITIGATE,
  monitor: CAN_MONITOR,
  resolve: CAN_RESOLVE,
  suppress: CAN_SUPPRESS,
} = ATTENTION_ACTIONS;

const SUPPRESS_DURATIONS = [
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 240, label: "4 hours" },
  { value: 1440, label: "24 hours" },
];

const PIPELINE_STAGE_MAPPINGS = [
  { stage: "Usage", job_name: "recurring_billing_job", label: "Usage ingestion & metering" },
  { stage: "Rating", job_name: "recurring_billing_job", label: "Rating engine" },
  { stage: "Invoice generation", job_name: "recurring_billing_job", label: "Invoice finalization" },
  { stage: "Delivery", job_name: "overdue_invoice_job", label: "Invoice dispatch & notifications" },
  { stage: "Payment", job_name: "dunning_process_job", label: "Payment capture & retries" },
  { stage: "Settlement", job_name: "promise_to_pay_check_job", label: "Settlement & collections" },
  { stage: "Reconciliation", job_name: "financial_consistency_job", label: "Reconciliation & ledger integrity" },
];

// Failing is checked before staleness: a job that ran and failed is the more
// specific (and more urgent) signal than "hasn't run recently".
function stageHealth(job) {
  if (!job) return "unknown";
  if (job.last_status === "failed" || job.failure_count_24h > 0) return "failing";
  if (job.freshness === "stale") return "stale";
  if (job.freshness === "unknown") return "unknown";
  return "ok";
}

const STAGE_CHIPS = {
  failing: { className: "border-rose-200 bg-rose-50 text-rose-700", icon: AlertTriangle },
  stale: { className: "border-amber-200 bg-amber-50 text-amber-800", icon: Clock },
  unknown: { className: "border-slate-200 bg-slate-50 text-slate-600", icon: HelpCircle },
  ok: { className: "border-emerald-200 bg-emerald-50 text-emerald-700", icon: CheckCircle2 },
};

function stageLabel(health, job) {
  if (health === "failing") return `${job.failure_count_24h || 1} failed (24h)`;
  if (health === "stale") return "Overdue";
  if (health === "unknown") return job ? "No recent runs" : "Not tracked";
  return `Healthy · ${job.run_count_24h || 0} runs (24h)`;
}

function humanizeAction(action) {
  if (!action) return "Event";
  return String(action).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function shortTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Pill({ className, children }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-extrabold uppercase ${className}`}>
      {children}
    </span>
  );
}

function isSlaBreached(item) {
  return Boolean(item.sla_ack_deadline && !item.acknowledged_at && new Date() > new Date(item.sla_ack_deadline));
}

function IncidentCard({ item, onOpen }) {
  const breached = isSlaBreached(item);
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="block w-full rounded-2xl border border-slate-100 bg-slate-50 p-4 text-left transition hover:border-slate-300 hover:bg-white hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill className={SEVERITY_BADGES[item.severity] || SEVERITY_BADGES.p3}>{item.severity}</Pill>
            <Pill className={STATUS_BADGES[item.status] || STATUS_BADGES.open}>{item.status}</Pill>
            {breached && <Pill className="border-rose-600 bg-rose-600 text-white">SLA breach</Pill>}
          </div>
          <p className="mt-1.5 truncate text-sm font-bold text-slate-900">{item.title}</p>
          {item.description && <p className="mt-0.5 line-clamp-1 text-xs text-slate-600">{item.description}</p>}
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
            <span>{item.source}</span>
            <span>Opened {shortTime(item.opened_at)}</span>
            {item.occurrence_count > 1 && <span>Seen ×{item.occurrence_count}</span>}
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-bold text-brand-600">
          Details <ChevronRight size={14} />
        </span>
      </div>
    </button>
  );
}

/**
 * Detail + actions for one attention item. Form state lives here so it resets
 * every time a different incident is opened (it used to be page-level state
 * that carried a half-typed reason over to the next incident).
 */
function IncidentModal({ item, currentUserId, onClose, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [resolutionCode, setResolutionCode] = useState("");
  const [suppressReason, setSuppressReason] = useState("");
  const [suppressMinutes, setSuppressMinutes] = useState(60);

  const run = async (key, fn) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onChanged();
      onClose();
    } catch (e) {
      setError(e?.message || "The action failed. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  const status = item.status;
  const anyBusy = busy !== null;

  return (
    <Modal
      open
      onClose={onClose}
      title={item.title}
      description={`${item.source} · #${item.id}`}
      icon={ClipboardList}
      size="md"
      footer={<Button variant="secondary" onClick={onClose} disabled={anyBusy}>Close</Button>}
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill className={SEVERITY_BADGES[item.severity] || SEVERITY_BADGES.p3}>{item.severity}</Pill>
          <Pill className={STATUS_BADGES[status] || STATUS_BADGES.open}>{status}</Pill>
          {isSlaBreached(item) && <Pill className="border-rose-600 bg-rose-600 text-white">SLA breach</Pill>}
        </div>

        {error && (
          <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
            {error}
          </div>
        )}

        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-2xl border border-slate-100 bg-slate-50 p-4 text-xs sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="font-semibold text-slate-500">Description</dt>
            <dd className="mt-0.5 text-slate-800">{item.description || "No description provided."}</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500">Source</dt>
            <dd className="mt-0.5 break-all text-slate-800">{item.source} ({item.source_key})</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500">Occurrences</dt>
            <dd className="mt-0.5 text-slate-800">{item.occurrence_count}</dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-500">Opened</dt>
            <dd className="mt-0.5 text-slate-800">{formatDateTime(item.opened_at)}</dd>
          </div>
          {item.sla_ack_deadline && (
            <div>
              <dt className="font-semibold text-slate-500">Acknowledge by</dt>
              <dd className="mt-0.5 text-slate-800">{formatDateTime(item.sla_ack_deadline)}</dd>
            </div>
          )}
          {item.owner_user_id && (
            <div>
              <dt className="font-semibold text-slate-500">Owner</dt>
              <dd className="mt-0.5 text-slate-800">
                {item.owner_user_id === currentUserId ? "You" : `User #${item.owner_user_id}`}
              </dd>
            </div>
          )}
          {item.correlation_id && (
            <div className="sm:col-span-2">
              <dt className="font-semibold text-slate-500">Correlation ID</dt>
              <dd className="mt-0.5 break-all font-mono text-slate-800">{item.correlation_id}</dd>
            </div>
          )}
        </dl>

        <div className="space-y-4">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Next steps</p>
          <div className="flex flex-wrap gap-2">
            {CAN_ACKNOWLEDGE.includes(status) && (
              <Button
                size="sm"
                variant="primary"
                icon={CheckCircle2}
                loading={busy === "ack"}
                disabled={anyBusy}
                onClick={() => run("ack", () => acknowledgeAttentionItem(item.id))}
              >
                Acknowledge
              </Button>
            )}
            {CAN_ASSIGN.includes(status) && currentUserId && item.owner_user_id !== currentUserId && (
              <Button
                size="sm"
                variant="secondary"
                icon={UserPlus}
                loading={busy === "assign"}
                disabled={anyBusy}
                onClick={() => run("assign", () => assignAttentionItem(item.id, currentUserId))}
              >
                Assign to me
              </Button>
            )}
            {CAN_MITIGATE.includes(status) && (
              <Button
                size="sm"
                variant="secondary"
                icon={ArrowRightCircle}
                loading={busy === "mitigate"}
                disabled={anyBusy}
                onClick={() => run("mitigate", () => transitionAttentionItem(item.id, "mitigating"))}
              >
                Start mitigating
              </Button>
            )}
            {CAN_MONITOR.includes(status) && (
              <Button
                size="sm"
                variant="secondary"
                icon={Eye}
                loading={busy === "monitor"}
                disabled={anyBusy}
                onClick={() => run("monitor", () => transitionAttentionItem(item.id, "monitoring"))}
              >
                Move to monitoring
              </Button>
            )}
          </div>

          {CAN_RESOLVE.includes(status) && (
            <form
              className="space-y-2 rounded-2xl border border-emerald-100 bg-emerald-50/40 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (resolutionCode.trim()) run("resolve", () => transitionAttentionItem(item.id, "resolved", resolutionCode.trim()));
              }}
            >
              <Field label="Resolve with a resolution code" htmlFor="incident-resolution" hint="Recorded on the audit trail, e.g. restarted_worker or config_fixed.">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    id="incident-resolution"
                    value={resolutionCode}
                    onChange={(e) => setResolutionCode(e.target.value)}
                    placeholder="restarted_worker"
                    className={`${FORM_CONTROL_CLASS} flex-1`}
                  />
                  <Button type="submit" variant="primary" icon={CheckCircle2} loading={busy === "resolve"} disabled={anyBusy || !resolutionCode.trim()}>
                    Resolve
                  </Button>
                </div>
              </Field>
            </form>
          )}

          {CAN_SUPPRESS.includes(status) && (
            <form
              className="space-y-3 rounded-2xl border border-slate-200 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (suppressReason.trim()) run("suppress", () => suppressAttentionItem(item.id, suppressReason.trim(), Number(suppressMinutes)));
              }}
            >
              <p className="text-xs font-semibold text-slate-700">Snooze this alert</p>
              <p className="text-[11px] text-slate-500">Suppression is time-bound — the item re-opens automatically when it expires.</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  aria-label="Reason for suppression"
                  value={suppressReason}
                  onChange={(e) => setSuppressReason(e.target.value)}
                  placeholder="Reason (required)"
                  className={`${FORM_CONTROL_CLASS} flex-1`}
                />
                <select
                  aria-label="Suppression duration"
                  value={suppressMinutes}
                  onChange={(e) => setSuppressMinutes(Number(e.target.value))}
                  className={`${FORM_CONTROL_CLASS} sm:w-36`}
                >
                  {SUPPRESS_DURATIONS.map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
                <Button type="submit" variant="secondary" icon={BellOff} loading={busy === "suppress"} disabled={anyBusy || !suppressReason.trim()}>
                  Suppress
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
    </Modal>
  );
}

function FailedJobsPanel({ jobs, loading, error, onReload }) {
  const [reasons, setReasons] = useState({});
  const [retrying, setRetrying] = useState(null);
  const [messages, setMessages] = useState({});

  const handleRetry = async (jobName) => {
    const reason = (reasons[jobName] || "").trim();
    if (reason.length < 3) {
      setMessages((prev) => ({ ...prev, [jobName]: { type: "error", text: "Enter a reason of at least 3 characters." } }));
      return;
    }
    setRetrying(jobName);
    setMessages((prev) => ({ ...prev, [jobName]: null }));
    try {
      await retryJob(jobName, reason);
      setMessages((prev) => ({ ...prev, [jobName]: { type: "success", text: "Queued for an immediate retry." } }));
      setReasons((prev) => ({ ...prev, [jobName]: "" }));
      onReload();
    } catch (e) {
      setMessages((prev) => ({ ...prev, [jobName]: { type: "error", text: e?.message || "Failed to queue the retry." } }));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <SectionCard
      variant="standard"
      icon={RotateCcw}
      title="Failed jobs"
      description="Background jobs whose most recent run failed. Retrying queues an immediate re-run and is recorded with your reason."
      actions={
        jobs.length > 0 ? (
          <span className="rounded-full bg-rose-100 px-2.5 py-1 text-xs font-bold text-rose-700">{jobs.length} failed</span>
        ) : null
      }
    >
      {loading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : error ? (
        <ErrorState message={error} onRetry={onReload} title="Job health unavailable" />
      ) : jobs.length === 0 ? (
        <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 text-sm text-emerald-800">
          <CheckCircle2 size={16} className="shrink-0 text-emerald-600" />
          No background jobs are currently failing.
        </div>
      ) : (
        <ul className="space-y-3">
          {jobs.map((job) => {
            const message = messages[job.job_name];
            return (
              <li key={job.job_name} className="rounded-2xl border border-rose-200 bg-rose-50/50 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-slate-800">{job.display_name || job.job_name}</p>
                    {job.last_error && <p className="mt-1 max-w-xl break-words text-xs text-rose-700">{job.last_error}</p>}
                    <p className="mt-1 text-[11px] text-slate-500">Last run {formatDateTime(job.last_started_at)}</p>
                  </div>
                  <form
                    className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto"
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleRetry(job.job_name);
                    }}
                  >
                    <input
                      aria-label={`Reason for retrying ${job.display_name || job.job_name}`}
                      value={reasons[job.job_name] || ""}
                      onChange={(e) => setReasons((prev) => ({ ...prev, [job.job_name]: e.target.value }))}
                      placeholder="Reason for retry (required)"
                      className={`${FORM_CONTROL_CLASS} sm:w-64`}
                    />
                    <Button type="submit" size="sm" variant="primary" icon={Power} loading={retrying === job.job_name}>
                      {retrying === job.job_name ? "Queuing…" : "Retry now"}
                    </Button>
                  </form>
                </div>
                {message && (
                  <p className={`mt-2 text-xs font-semibold ${message.type === "success" ? "text-emerald-700" : "text-rose-700"}`}>
                    {message.text}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}

// Route-to-heading mapping: this page is reachable from three distinct
// sidebar entries ("Triage & Attention", "Incidents", "Processing Failures &
// Reprocessing") that all point at the same underlying triage data. The
// heading (and, for the reprocessing route, the failed-jobs panel) changes
// per-route so the page reflects the label the operator actually clicked.
const ROUTE_INCIDENTS = "/super-admin/reliability/incidents";
const ROUTE_REPROCESSING = "/super-admin/reliability/reprocessing";

/**
 * `embedded` drops this page's own PageHeader when it is mounted as a tab of
 * the System Health hub, which renders the tab-aware header itself; leaving it
 * on stacks two headers. The standalone routes (/super-admin/reliability/
 * incidents, /super-admin/reliability/reprocessing, /super-admin/triage) keep
 * the header. `showReprocessing` lets an embedding hub (e.g. the Reliability
 * hub's merged "Incidents & Processing Failures" tab, mounted at a pathname
 * that matches neither dedicated route below) opt into the reprocessing panel
 * explicitly. Standalone routing is untouched — pathname still decides it
 * there.
 */
export default function TriagePage({ showReprocessing, embedded = false } = {}) {
  const location = useLocation();
  const { user } = useAuth();
  const isIncidentsRoute = location.pathname === ROUTE_INCIDENTS;
  const isReprocessingRoute = showReprocessing || location.pathname === ROUTE_REPROCESSING;
  const pageTitle = isReprocessingRoute
    ? "Processing Failures & Reprocessing"
    : isIncidentsRoute
    ? "Incidents"
    : "Triage & Operational Incidents";

  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedIncident, setSelectedIncident] = useState(null);

  // Failed-job reprocessing (only fetched on the reprocessing route — see
  // ROUTE_REPROCESSING above). Reuses the same JobHealthItem data System
  // Health/Job Health already surface.
  const [failedJobs, setFailedJobs] = useState([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    getTriageSummary()
      .then((data) => {
        setSummary(data);
        setError(null);
      })
      .catch((e) => setError(e?.message || "Unable to load the triage summary."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadFailedJobs = useCallback(() => {
    setJobsLoading(true);
    getJobTelemetry()
      .then((data) => {
        // JobRunStatus values are lowercase ("failed") — comparing against
        // "FAILED" silently hid every failed job from this panel.
        const jobs = (data?.jobs || []).filter((j) => String(j.last_status || "").toLowerCase() === "failed");
        setFailedJobs(jobs);
        setJobsError(null);
      })
      .catch((e) => setJobsError(e?.message || "Unable to load job health."))
      .finally(() => setJobsLoading(false));
  }, []);

  useEffect(() => {
    if (isReprocessingRoute) loadFailedJobs();
  }, [isReprocessingRoute, loadFailedJobs]);

  const refreshAll = () => {
    load();
    if (isReprocessingRoute) loadFailedJobs();
  };

  const incidents = summary?.incidents;
  const counts = incidents?.counts;
  const topItems = incidents?.top_items || [];
  const pipelineStages = summary?.pipeline_stages || [];
  const safetyControls = summary?.safety_controls || [];
  const engagedBreakers = safetyControls.filter((b) => !b.enabled);
  const criticalEvents = summary?.critical_events || [];
  const refreshing = loading || jobsLoading;

  return (
    <div className={embedded ? "space-y-6" : "space-y-6 p-4 sm:p-6 lg:p-8"}>
      {embedded ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">
            {summary?.generated_at ? `Snapshot ${formatDateTime(summary.generated_at)}` : "Live incident and pipeline snapshot."}
          </p>
          <Button size="sm" variant="secondary" icon={RefreshCw} loading={refreshing} onClick={refreshAll}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      ) : (
        <PageHeader
          title={pageTitle}
          description="Live incident response, processing pipeline health, circuit-breaker safety controls and the critical audit stream."
          icon={ClipboardList}
          accent="teal"
          actions={
            <Button variant="secondary" icon={RefreshCw} loading={refreshing} onClick={refreshAll}>
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          }
        />
      )}

      {/* At-a-glance numbers so the operator knows the state before reading any list. */}
      {summary && !error && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "Open incidents", value: counts?.total_open ?? 0, tone: (counts?.total_open ?? 0) > 0 ? "text-rose-700" : "text-emerald-700" },
            { label: "P0 / P1", value: `${counts?.p0 ?? 0} / ${counts?.p1 ?? 0}`, tone: (counts?.p0 ?? 0) + (counts?.p1 ?? 0) > 0 ? "text-rose-700" : "text-slate-800" },
            { label: "SLA breaches", value: counts?.sla_breaches ?? 0, tone: (counts?.sla_breaches ?? 0) > 0 ? "text-rose-700" : "text-slate-800" },
            { label: "Breakers paused", value: engagedBreakers.length, tone: engagedBreakers.length > 0 ? "text-amber-700" : "text-slate-800" },
          ].map((stat) => (
            <div key={stat.label} className="rounded-2xl border border-slate-200 bg-white p-4">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{stat.label}</p>
              <p className={`mt-1 text-2xl font-extrabold ${stat.tone}`}>{stat.value}</p>
            </div>
          ))}
        </div>
      )}

      {isReprocessingRoute && (
        <FailedJobsPanel jobs={failedJobs} loading={jobsLoading} error={jobsError} onReload={loadFailedJobs} />
      )}

      {loading && !summary ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} title="Triage unavailable" />
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <SectionCard
            variant="hero"
            accent="teal"
            title={
              <span className="inline-flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${topItems.length > 0 ? "animate-pulse bg-rose-500" : "bg-emerald-500"}`} aria-hidden="true" />
                Live incidents
              </span>
            }
            description="Open attention items, most severe first. Select one to acknowledge, assign, mitigate, resolve or snooze it."
          >
            {topItems.length === 0 ? (
              <div className="py-8 text-center">
                <CheckCircle2 size={32} className="mx-auto mb-2 text-emerald-500" />
                <p className="text-sm font-bold text-slate-800">No open incidents</p>
                <p className="text-xs text-slate-600">Nothing needs attention right now.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {topItems.map((item) => (
                  <IncidentCard key={item.id} item={item} onOpen={setSelectedIncident} />
                ))}
                {(counts?.total_open ?? 0) > topItems.length && (
                  <p className="text-center text-xs text-slate-500">
                    Showing the {topItems.length} most urgent of {counts.total_open} open items.
                  </p>
                )}
              </div>
            )}
          </SectionCard>

          <SectionCard
            variant="standard"
            title="Processing pipeline"
            description="Each billing stage and the background job that drives it."
            actions={
              <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${summary?.scheduler_enabled ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                Scheduler {summary?.scheduler_enabled ? "on" : "off"}
              </span>
            }
          >
            <ol className="space-y-2">
              {PIPELINE_STAGE_MAPPINGS.map((mapping, idx) => {
                const job = pipelineStages.find((j) => j.job_name === mapping.job_name);
                const health = stageHealth(job);
                const chip = STAGE_CHIPS[health];
                const ChipIcon = chip.icon;
                return (
                  <li key={mapping.stage} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-xs">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-extrabold text-slate-700">
                        {idx + 1}
                      </span>
                      <div className="min-w-0">
                        <p className="font-bold text-slate-900">{mapping.stage}</p>
                        <p className="text-[11px] text-slate-500">{mapping.label}</p>
                      </div>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-bold ${chip.className}`}
                      title={job?.last_error || undefined}
                    >
                      <ChipIcon size={12} /> {stageLabel(health, job)}
                    </span>
                  </li>
                );
              })}
            </ol>
          </SectionCard>

          <SectionCard
            variant="standard"
            title="Safety controls"
            description="Platform-wide circuit breakers. A paused control blocks that operation for every tenant."
            actions={
              <Link to="/super-admin/kill-switch" className="text-xs font-bold text-brand-600 hover:text-brand-800">
                Manage →
              </Link>
            }
          >
            <div className="space-y-3">
              {engagedBreakers.length === 0 ? (
                <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 text-xs font-semibold text-emerald-900">
                  <CheckCircle2 size={16} className="shrink-0 text-emerald-600" />
                  No controls are paused — all processing is running normally.
                </div>
              ) : (
                engagedBreakers.map((b) => (
                  <div key={b.scope} className="rounded-2xl border border-rose-200 bg-rose-50/60 p-4 text-xs text-rose-900">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 font-bold">
                        <Power size={14} className="text-rose-600" /> {b.display_name} — paused
                      </span>
                      {b.expires_at && (
                        <span className="inline-flex items-center gap-1 rounded bg-rose-200/60 px-2 py-0.5 text-[10px] font-bold">
                          <Clock size={10} /> Auto-resumes {shortTime(b.expires_at)}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-rose-800">{b.reason || "No reason recorded."}</p>
                  </div>
                ))
              )}

              {safetyControls.length > 0 && (
                <ul className="divide-y divide-slate-100 rounded-xl border border-slate-100">
                  {safetyControls.map((c) => (
                    <li key={c.scope} className="flex items-center justify-between gap-3 px-3.5 py-2 text-xs">
                      <span className="font-medium text-slate-800">{c.display_name}</span>
                      <span className={`inline-flex items-center gap-1.5 font-bold ${c.enabled ? "text-emerald-700" : "text-rose-700"}`}>
                        <span className={`h-2 w-2 rounded-full ${c.enabled ? "bg-emerald-500" : "bg-rose-500"}`} aria-hidden="true" />
                        {c.enabled ? "Running" : "Paused"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </SectionCard>

          <SectionCard
            variant="standard"
            title="Recent platform events"
            description="The latest entries on the platform audit trail."
            actions={
              <Link to="/super-admin/audit-logs" className="text-xs font-bold text-brand-600 hover:text-brand-800">
                Full audit trail →
              </Link>
            }
          >
            {criticalEvents.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-600">No platform audit entries recorded yet.</p>
            ) : (
              <ul>
                {criticalEvents.map((evt) => (
                  <li key={evt.id} className="flex items-start justify-between gap-3 border-b border-slate-100 py-2.5 text-xs last:border-0">
                    <div className="min-w-0 flex-1">
                      <p>
                        <span className="font-bold text-slate-900">{humanizeAction(evt.action)}</span>
                        <span className="text-slate-600"> · {evt.entity_type}{evt.entity_id ? ` #${evt.entity_id}` : ""}</span>
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-500">
                        {evt.actor_email || "System"}{evt.reason ? ` · ${evt.reason}` : ""}
                      </p>
                    </div>
                    <time className="shrink-0 text-[11px] text-slate-500" dateTime={evt.created_at} title={formatDateTime(evt.created_at)}>
                      {shortTime(evt.created_at)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      )}

      {selectedIncident && (
        <IncidentModal
          item={selectedIncident}
          currentUserId={user?.id}
          onClose={() => setSelectedIncident(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
