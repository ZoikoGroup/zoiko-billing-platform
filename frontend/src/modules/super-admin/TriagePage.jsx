import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  HelpCircle,
  Power,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  UserX,
  X,
} from "lucide-react";
import {
  getTriageSummary,
  acknowledgeAttentionItem,
  assignAttentionItem,
  transitionAttentionItem,
  suppressAttentionItem,
  listAttentionItems,
} from "../../service/commandCenterService";
import { PageHeader } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";

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

const PIPELINE_STAGE_MAPPINGS = [
  { stage: "Usage", job_name: "recurring_billing_job", label: "Usage Ingestion & Metering" },
  { stage: "Rating", job_name: "recurring_billing_job", label: "Rating Engine" },
  { stage: "Invoice Generation", job_name: "recurring_billing_job", label: "Invoice Finalization" },
  { stage: "Delivery", job_name: "overdue_invoice_job", label: "Invoice Dispatch & Notifications" },
  { stage: "Payment", job_name: "dunning_process_job", label: "Payment Capture & Retries" },
  { stage: "Settlement", job_name: "promise_to_pay_check_job", label: "Settlement & Collections" },
  { stage: "Reconciliation", job_name: "financial_consistency_job", label: "Reconciliation & Ledger Integrity" },
];

export default function TriagePage() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedIncident, setSelectedIncident] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState(null);

  // Form states for incident actions
  const [resolutionCode, setResolutionCode] = useState("");
  const [suppressReason, setSuppressReason] = useState("");
  const [suppressMinutes, setSuppressMinutes] = useState(60);

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

  const handleAcknowledge = async (item) => {
    setActionLoading(true);
    setActionError(null);
    try {
      await acknowledgeAttentionItem(item.id);
      load();
      setSelectedIncident(null);
    } catch (e) {
      setActionError(e?.message || "Failed to acknowledge incident.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleTransition = async (item, toStatus) => {
    setActionLoading(true);
    setActionError(null);
    try {
      await transitionAttentionItem(item.id, toStatus, resolutionCode || undefined);
      load();
      setSelectedIncident(null);
      setResolutionCode("");
    } catch (e) {
      setActionError(e?.message || "Failed to transition incident status.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSuppress = async (item) => {
    if (!suppressReason) {
      setActionError("Suppression reason is required.");
      return;
    }
    setActionLoading(true);
    setActionError(null);
    try {
      await suppressAttentionItem(item.id, suppressReason, Number(suppressMinutes));
      load();
      setSelectedIncident(null);
      setSuppressReason("");
    } catch (e) {
      setActionError(e?.message || "Failed to suppress incident.");
    } finally {
      setActionLoading(false);
    }
  };

  const incidents = summary?.incidents;
  const pipelineStages = summary?.pipeline_stages || [];
  const engagedBreakers = (summary?.safety_controls || []).filter((b) => !b.enabled);
  const criticalEvents = summary?.critical_events || [];

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PageHeader
          title="Triage & Operational Incidents"
          description="Real-time incident response, 7-stage processing pipeline telemetry, circuit breaker safety controls, and critical audit stream."
          icon={ClipboardList}
        />
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-700 shadow-sm transition hover:bg-slate-50"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          Refresh Triage
        </button>
      </div>

      {loading ? (
        <div className="py-12 flex justify-center">
          <Spinner />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} title="Triage unavailable" />
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {/* T1: Live Incidents */}
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)] flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between border-b border-slate-100 pb-4">
                <div className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${incidents?.top_items?.length > 0 ? "bg-rose-500 animate-pulse" : "bg-emerald-500"}`} />
                  <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">T1 · Live Incidents</h3>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-extrabold text-rose-700">
                    {incidents?.counts?.p0 || 0} P0 · {incidents?.counts?.p1 || 0} P1
                  </span>
                  {(incidents?.counts?.sla_breaches ?? 0) > 0 && (
                    <span className="rounded-full bg-rose-600 px-2.5 py-0.5 text-xs font-extrabold text-white">
                      {incidents.counts.sla_breaches} SLA Breaches
                    </span>
                  )}
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {(!incidents?.top_items?.length) ? (
                  <div className="py-8 text-center">
                    <CheckCircle2 size={32} className="mx-auto text-emerald-500 mb-2" />
                    <p className="text-sm font-bold text-slate-800">All services operating normally</p>
                    <p className="text-xs text-slate-600">Zero active P0–P3 incidents detected.</p>
                  </div>
                ) : (
                  incidents.top_items.map((item) => {
                    const isSlaBreached = item.sla_ack_deadline && new Date() > new Date(item.sla_ack_deadline) && !item.acknowledged_at;
                    return (
                      <div
                        key={item.id}
                        onClick={() => setSelectedIncident(item)}
                        className="cursor-pointer rounded-2xl border border-slate-100 bg-slate-50 p-4 transition hover:border-slate-300 hover:shadow-sm"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className={`rounded-md border px-2 py-0.5 text-[10px] font-extrabold uppercase ${SEVERITY_BADGES[item.severity] || SEVERITY_BADGES.p3}`}>
                                {item.severity}
                              </span>
                              <span className={`rounded-md border px-2 py-0.5 text-[10px] font-extrabold uppercase ${STATUS_BADGES[item.status] || STATUS_BADGES.open}`}>
                                {item.status}
                              </span>
                              {isSlaBreached && (
                                <span className="rounded-md bg-rose-600 px-2 py-0.5 text-[10px] font-extrabold uppercase text-white">
                                  SLA Breach
                                </span>
                              )}
                              <span className="font-bold text-slate-900 truncate">{item.title}</span>
                            </div>
                            <p className="mt-1 text-xs text-slate-600 line-clamp-1">{item.description}</p>
                            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
                              <span>Source: <strong className="text-slate-800">{item.source}</strong></span>
                              <span>Occurrences: <strong className="text-slate-800">{item.occurrence_count}</strong></span>
                              <span>Correlation: <code className="font-mono">{item.correlation_id.slice(0, 8)}</code></span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 text-xs font-bold text-brand-600 hover:text-brand-800"
                          >
                            Inspect <ChevronRight size={14} />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-100 text-xs text-slate-600 flex justify-between items-center">
              <span>Attention Engine v3.0 · Server-enforced SLA clocks</span>
              <span className="font-semibold">{incidents?.counts?.total_open ?? 0} total open</span>
            </div>
          </div>

          {/* T2: Processing Pipeline (7 Stages) */}
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">T2 · Processing Pipeline (7 Stages)</h3>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${summary?.scheduler_enabled ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>
                Scheduler {summary?.scheduler_enabled ? "Active" : "Disabled"}
              </span>
            </div>

            <div className="mt-4 space-y-2.5">
              {PIPELINE_STAGE_MAPPINGS.map((mapping, idx) => {
                const job = pipelineStages.find((j) => j.job_name === mapping.job_name);
                const isStale = !job || job.freshness === "stale" || job.freshness === "unknown";
                const isFailing = job && (job.failure_count_24h > 0 || job.last_status === "failed");

                return (
                  <div key={mapping.stage} className="flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3 text-xs">
                    <div className="flex items-center gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[11px] font-extrabold text-slate-700">
                        {idx + 1}
                      </span>
                      <div>
                        <span className="font-bold text-slate-900">{mapping.stage}</span>
                        <span className="ml-2 text-slate-600 text-[11px]">{mapping.label}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      {isStale ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2.5 py-0.5 text-[10px] font-extrabold text-amber-800">
                          <HelpCircle size={12} /> UNKNOWN (Stale)
                        </span>
                      ) : isFailing ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 border border-rose-200 px-2.5 py-0.5 text-[10px] font-extrabold text-rose-700">
                          <AlertTriangle size={12} /> {job.failure_count_24h} Failed (24h)
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 text-[10px] font-extrabold text-emerald-700">
                          <CheckCircle2 size={12} /> Operational ({job?.run_count_24h || 0} runs)
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* T3: Safety Controls (Circuit Breakers) */}
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">T3 · Safety Controls &amp; Circuit Breakers</h3>
              <Link
                to="/super-admin/kill-switch"
                className="text-xs font-bold text-brand-600 hover:text-brand-800"
              >
                Manage Breakers →
              </Link>
            </div>

            <div className="mt-4 space-y-3">
              {engagedBreakers.length === 0 ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 text-xs text-emerald-900">
                  <div className="flex items-center gap-2 font-bold">
                    <CheckCircle2 size={16} className="text-emerald-600" />
                    All Circuit Breakers Active (Traffic Allowed)
                  </div>
                  <p className="mt-1 text-emerald-800 text-[11px]">
                    No pause controls currently engaged. Processing pipelines are unrestricted.
                  </p>
                </div>
              ) : (
                engagedBreakers.map((b) => (
                  <div key={b.scope} className="rounded-2xl border border-rose-200 bg-rose-50/60 p-4 text-xs text-rose-900">
                    <div className="flex items-center justify-between">
                      <span className="font-bold flex items-center gap-1.5">
                        <Power size={14} className="text-rose-600" /> {b.display_name} — PAUSED
                      </span>
                      {b.expires_at && (
                        <span className="inline-flex items-center gap-1 rounded bg-rose-200/60 px-2 py-0.5 text-[10px] font-bold text-rose-900">
                          <Clock size={10} /> Auto-expires: {new Date(b.expires_at).toLocaleTimeString()}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-rose-800 text-[11px]">{b.reason || "Paused for maintenance."}</p>
                  </div>
                ))
              )}

              <div className="space-y-2 pt-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Active Breaker Inventory</p>
                {(summary?.safety_controls || []).map((c) => (
                  <div key={c.scope} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3.5 py-2 text-xs">
                    <span className="font-medium text-slate-800">{c.display_name}</span>
                    <span className={`font-extrabold ${c.enabled ? "text-emerald-700" : "text-rose-700"}`}>
                      {c.enabled ? "ACTIVE" : "PAUSED"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* T4: Critical Event Stream */}
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">T4 · Critical Event Stream</h3>
              <Link
                to="/super-admin/audit-logs"
                className="text-xs font-bold text-brand-600 hover:text-brand-800"
              >
                Full Audit Trail →
              </Link>
            </div>

            <div className="mt-4 space-y-2.5">
              {criticalEvents.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-600">No platform audit entries recorded yet.</p>
              ) : (
                criticalEvents.map((evt) => (
                  <div key={evt.id} className="flex items-center justify-between gap-3 border-b border-slate-100 py-2.5 text-xs last:border-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-900">{evt.action.replace(/_/g, " ").toUpperCase()}</span>
                        <span className="text-slate-600">on {evt.entity_type} {evt.entity_id ? `#${evt.entity_id}` : ""}</span>
                      </div>
                      <p className="text-[11px] text-slate-600 truncate mt-0.5">
                        Actor: {evt.actor_email || "System"} {evt.reason ? `· ${evt.reason}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-[10px] font-mono text-slate-600">
                      {new Date(evt.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Incident Detail / Action Modal */}
      {selectedIncident && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-md border px-2 py-0.5 text-[10px] font-extrabold uppercase ${SEVERITY_BADGES[selectedIncident.severity]}`}>
                    {selectedIncident.severity}
                  </span>
                  <span className={`rounded-md border px-2 py-0.5 text-[10px] font-extrabold uppercase ${STATUS_BADGES[selectedIncident.status]}`}>
                    {selectedIncident.status}
                  </span>
                  <span className="text-xs font-mono text-slate-600">#{selectedIncident.id}</span>
                </div>
                <h3 className="mt-2 text-base font-bold text-slate-900">{selectedIncident.title}</h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedIncident(null)}
                className="rounded-full p-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              >
                <X size={18} />
              </button>
            </div>

            {actionError && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                {actionError}
              </div>
            )}

            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 space-y-2 text-xs">
              <p><strong className="text-slate-800">Description:</strong> {selectedIncident.description || "No description provided."}</p>
              <p><strong className="text-slate-800">Source:</strong> {selectedIncident.source} ({selectedIncident.source_key})</p>
              <p><strong className="text-slate-800">Occurrences:</strong> {selectedIncident.occurrence_count}</p>
              <p><strong className="text-slate-800">Opened At:</strong> {new Date(selectedIncident.opened_at).toLocaleString()}</p>
              <p><strong className="text-slate-800">Correlation ID:</strong> <code className="font-mono">{selectedIncident.correlation_id}</code></p>
              {selectedIncident.sla_ack_deadline && (
                <p><strong className="text-slate-800">SLA Ack Target:</strong> {new Date(selectedIncident.sla_ack_deadline).toLocaleString()}</p>
              )}
            </div>

            {/* Incident Actions */}
            <div className="space-y-3 pt-2">
              <p className="text-xs font-bold uppercase tracking-wider text-slate-600">Operator Actions</p>
              <div className="flex flex-wrap gap-2">
                {selectedIncident.status === "open" && (
                  <button
                    type="button"
                    disabled={actionLoading}
                    onClick={() => handleAcknowledge(selectedIncident)}
                    className="rounded-xl bg-slate-900 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-slate-800"
                  >
                    Acknowledge
                  </button>
                )}

                {["open", "acknowledged"].includes(selectedIncident.status) && (
                  <button
                    type="button"
                    disabled={actionLoading}
                    onClick={() => handleTransition(selectedIncident, "mitigating")}
                    className="rounded-xl bg-purple-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-purple-700"
                  >
                    Mark Mitigating
                  </button>
                )}

                {["mitigating", "monitoring"].includes(selectedIncident.status) && (
                  <div className="flex items-center gap-2 w-full pt-2">
                    <input
                      type="text"
                      placeholder="Resolution code (e.g. restart_job_passed)..."
                      value={resolutionCode}
                      onChange={(e) => setResolutionCode(e.target.value)}
                      className="flex-1 rounded-xl border border-slate-200 px-3 py-1.5 text-xs focus:border-slate-400 focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={actionLoading || !resolutionCode}
                      onClick={() => handleTransition(selectedIncident, "resolved")}
                      className="rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                    >
                      Resolve
                    </button>
                  </div>
                )}
              </div>

              {/* Suppress section */}
              {["open", "acknowledged"].includes(selectedIncident.status) && (
                <div className="pt-3 border-t border-slate-100 space-y-2">
                  <span className="text-[11px] font-bold text-slate-700">Suppress Alert Temporarily</span>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Reason for suppression..."
                      value={suppressReason}
                      onChange={(e) => setSuppressReason(e.target.value)}
                      className="flex-1 rounded-xl border border-slate-200 px-3 py-1.5 text-xs focus:border-slate-400 focus:outline-none"
                    />
                    <select
                      value={suppressMinutes}
                      onChange={(e) => setSuppressMinutes(Number(e.target.value))}
                      className="rounded-xl border border-slate-200 px-2 py-1.5 text-xs"
                    >
                      <option value={30}>30m</option>
                      <option value={60}>1h</option>
                      <option value={240}>4h</option>
                      <option value={1440}>24h</option>
                    </select>
                    <button
                      type="button"
                      disabled={actionLoading || !suppressReason}
                      onClick={() => handleSuppress(selectedIncident)}
                      className="rounded-xl border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                    >
                      Suppress
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
