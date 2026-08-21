import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  HelpCircle,
  Power,
  ScrollText,
  ShieldAlert,
} from "lucide-react";
import { getTriageSummary } from "../../service/commandCenterService";
import { PageHeader } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";

/**
 * ZB-SA-CMD-003 §11 — Triage lens.
 *
 * One read-only pane composing the four sections the spec requires:
 * incidents (Attention Engine), pipeline stages (job telemetry), safety
 * controls (circuit-breaker catalog) and critical events (platform audit,
 * redacted to action/entity/actor/time). Every section is fetched from the
 * single /triage/summary endpoint, which itself reads the SAME sources as
 * the dedicated pages — nothing here is a parallel or fabricated data path.
 *
 * Read-only by design: triage.read holders observe; lifecycle actions
 * (acknowledge/assign/transition/suppress, breaker toggles) live on their
 * own capability-gated pages.
 */

const SEVERITY_STYLES = {
  p0: "bg-red-100 text-red-800 border-red-200",
  p1: "bg-orange-100 text-orange-800 border-orange-200",
  p2: "bg-amber-100 text-amber-800 border-amber-200",
  p3: "bg-slate-100 text-slate-700 border-slate-200",
};

const FRESHNESS_STYLES = {
  fresh: { className: "text-emerald-700", icon: CheckCircle2, label: "Fresh" },
  stale: { className: "text-amber-600", icon: HelpCircle, label: "Stale" },
  unknown: { className: "text-slate-500", icon: HelpCircle, label: "Unknown" },
};

function SectionCard({ title, icon: Icon, children, action }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <div className="mb-4 flex items-center justify-between">
        <p className="flex items-center gap-2 text-sm font-bold text-slate-700">
          <Icon size={16} className="text-slate-500" /> {title}
        </p>
        {action}
      </div>
      {children}
    </div>
  );
}

function EmptyLine({ children }) {
  return <p className="text-xs text-slate-500">{children}</p>;
}

export default function TriagePage() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

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

  useEffect(() => { load(); }, [load]);

  const incidents = summary?.incidents;
  const engaged = (summary?.safety_controls || []).filter((b) => !b.enabled);

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Triage"
        description="One pane across incidents, pipeline stages, safety controls and critical events. Read-only — lifecycle actions live on their capability-gated pages."
        icon={ClipboardList}
      />

      {loading ? (
        <div className="mt-6"><Spinner /></div>
      ) : error ? (
        <div className="mt-6"><ErrorState message={error} onRetry={load} title="Triage unavailable" /></div>
      ) : (
        <div className="mt-6 grid gap-6 xl:grid-cols-2 items-stretch">
          <SectionCard
            title="Incidents"
            icon={ShieldAlert}
            action={<Link to="/super-admin/governance" className="text-xs font-semibold text-brand-600 hover:underline">Open queue →</Link>}
          >
            <div className="mb-3 flex flex-wrap gap-2 text-xs font-semibold">
              <span className={`rounded-full border px-2.5 py-1 ${SEVERITY_STYLES.p0}`}>P0: {incidents?.counts?.p0 ?? 0}</span>
              <span className={`rounded-full border px-2.5 py-1 ${SEVERITY_STYLES.p1}`}>P1: {incidents?.counts?.p1 ?? 0}</span>
              <span className={`rounded-full border px-2.5 py-1 ${SEVERITY_STYLES.p2}`}>P2: {incidents?.counts?.p2 ?? 0}</span>
              <span className={`rounded-full border px-2.5 py-1 ${SEVERITY_STYLES.p3}`}>P3: {incidents?.counts?.p3 ?? 0}</span>
              {(incidents?.counts?.sla_breaches ?? 0) > 0 && (
                <span className="rounded-full border border-red-300 bg-red-50 px-2.5 py-1 text-red-700">
                  SLA breaches: {incidents.counts.sla_breaches}
                </span>
              )}
            </div>
            {!incidents || (incidents.top_items || []).length === 0 ? (
              <EmptyLine>No open incident items.</EmptyLine>
            ) : (
              <ul className="space-y-2">
                {incidents.top_items.map((item) => (
                  <li key={item.id} className="border-b border-slate-100 pb-2 last:border-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-800">{item.title}</p>
                        <p className="text-xs text-slate-500">
                          {item.source} · occurrences {item.occurrence_count} · status {item.status}
                        </p>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase ${SEVERITY_STYLES[item.severity] || SEVERITY_STYLES.p3}`}>
                        {item.severity}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Pipeline stages"
            icon={ClipboardList}
            action={
              <span className={`text-xs font-semibold ${summary?.scheduler_enabled ? "text-emerald-700" : "text-amber-600"}`}>
                Scheduler {summary?.scheduler_enabled ? "enabled" : "disabled"}
              </span>
            }
          >
            {!summary || (summary.pipeline_stages || []).length === 0 ? (
              <EmptyLine>No job runs recorded yet — expected while the scheduler is disabled or hasn't completed a first run.</EmptyLine>
            ) : (
              <ul className="space-y-2">
                {summary.pipeline_stages.map((job) => {
                  const style = FRESHNESS_STYLES[job.freshness] || FRESHNESS_STYLES.unknown;
                  const Icon = style.icon;
                  const failing = job.failure_count_24h > 0 || job.last_status === "failed";
                  return (
                    <li key={job.job_name} className="flex items-center justify-between border-b border-slate-100 py-2 text-sm last:border-0">
                      <span className="font-medium text-slate-700">{job.display_name || job.job_name}</span>
                      <span className="flex items-center gap-3 text-xs font-semibold">
                        {failing && (
                          <span className="flex items-center gap-1 text-red-600">
                            <AlertTriangle size={13} /> {job.failure_count_24h} failed (24h)
                          </span>
                        )}
                        <span className={`flex items-center gap-1.5 ${style.className}`}>
                          <Icon size={13} /> {style.label}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Safety controls"
            icon={Power}
            action={<Link to="/super-admin/kill-switch" className="text-xs font-semibold text-brand-600 hover:underline">Manage →</Link>}
          >
            {engaged.length === 0 ? (
              <p className="flex items-center gap-2 text-sm font-semibold text-emerald-700">
                <CheckCircle2 size={16} /> All circuit breakers released
              </p>
            ) : (
              <ul className="space-y-2">
                {engaged.map((breaker) => (
                  <li key={breaker.scope} className="border-b border-slate-100 pb-2 last:border-0 last:pb-0">
                    <p className="flex items-center gap-2 text-sm font-semibold text-red-700">
                      <Power size={14} /> {breaker.display_name} — ENGAGED
                    </p>
                    <p className="text-xs text-slate-500">
                      {breaker.reason || "No reason recorded."}
                      {breaker.expires_at ? ` · auto-expires ${new Date(breaker.expires_at).toLocaleString()}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Critical events"
            icon={ScrollText}
            action={<Link to="/super-admin/audit-logs" className="text-xs font-semibold text-brand-600 hover:underline">Full audit trail →</Link>}
          >
            {!summary || (summary.critical_events || []).length === 0 ? (
              <EmptyLine>No platform audit entries yet.</EmptyLine>
            ) : (
              <ul className="space-y-2">
                {summary.critical_events.map((event) => (
                  <li key={event.id} className="border-b border-slate-100 py-2 text-sm last:border-0">
                    <p className="font-medium text-slate-700">
                      {event.action.replace(/_/g, " ").toLowerCase()} — {event.entity_type}
                      {event.entity_id ? ` #${event.entity_id}` : ""}
                    </p>
                    <p className="text-xs text-slate-500">
                      {event.actor_email || "system"} · {new Date(event.created_at).toLocaleString()}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      )}
    </div>
  );
}
