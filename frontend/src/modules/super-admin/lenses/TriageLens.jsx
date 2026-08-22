import React from "react";
import { AlertCircle, AlertTriangle, ArrowRight, CheckCircle2, Clock, HelpCircle, ShieldAlert, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router-dom";

export default function TriageLens({ triageData, onRefresh }) {
  const navigate = useNavigate();
  const incidents = triageData?.incidents?.top_items || [];
  const pipeline = triageData?.pipeline_stages || [];
  const controls = triageData?.safety_controls || [];
  const criticalEvents = triageData?.critical_events || [];
  const schedulerEnabled = triageData?.scheduler_enabled ?? false;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* T1: Live Incidents */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div className="flex items-center gap-2">
            <span className={`flex h-2.5 w-2.5 rounded-full ${incidents.length > 0 ? "bg-rose-500 animate-pulse" : "bg-emerald-500"}`} />
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">T1 · Live Incidents</h3>
          </div>
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold text-slate-700">
            {triageData?.incidents?.counts?.p0 || 0} P0 · {triageData?.incidents?.counts?.p1 || 0} P1
          </span>
        </div>

        <div className="mt-4 space-y-3">
          {incidents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <CheckCircle2 size={32} className="text-emerald-500" />
              <p className="mt-2 text-sm font-bold text-slate-800">No active incidents</p>
              <p className="text-xs text-slate-600">All services operating within SLA tolerances.</p>
            </div>
          ) : (
            incidents.slice(0, 4).map((item) => (
              <div key={item.id} className="flex items-start justify-between gap-3 rounded-2xl border border-rose-100 bg-rose-50/40 p-3.5 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-extrabold uppercase text-white">
                      {item.severity}
                    </span>
                    <span className="font-bold text-slate-900 truncate">{item.title}</span>
                  </div>
                  <p className="mt-1 text-slate-600 line-clamp-1">{item.description}</p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate("/super-admin/triage")}
                  className="inline-flex shrink-0 items-center gap-1 font-bold text-rose-700 hover:text-rose-900"
                >
                  Inspect <ArrowRight size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* T2: Processing Pipeline */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">T2 · Processing Pipeline</h3>
          <span className="text-xs font-medium text-slate-600">
            {schedulerEnabled ? "Scheduler Active" : "Scheduler Disabled"}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {pipeline.length === 0 ? (
            <div className="col-span-full py-6 text-center text-xs text-slate-600">
              <HelpCircle size={24} className="mx-auto text-slate-400 mb-1" />
              Pipeline status is <strong className="text-amber-700">UNKNOWN</strong> (Awaiting background telemetry runs).
            </div>
          ) : (
            pipeline.map((stage) => {
              const isStale = stage.freshness === "stale" || stage.freshness === "unknown";
              const hasFailed = stage.last_status === "failed" || (stage.failure_count_24h || 0) > 0;
              return (
                <div key={stage.job_name} className="rounded-xl border border-slate-100 bg-slate-50 p-2.5 text-center">
                  <span className="block text-[11px] font-bold text-slate-700 truncate">{stage.display_name || stage.job_name}</span>
                  <span className="mt-1 block text-sm font-extrabold text-slate-900">
                    {stage.run_count_24h ?? 0} runs
                  </span>
                  <div className="mt-1 flex items-center justify-center gap-1">
                    {isStale ? (
                      <span className="text-[10px] font-bold text-amber-700">UNKNOWN (Stale)</span>
                    ) : hasFailed ? (
                      <span className="inline-flex items-center text-[10px] font-bold text-rose-700">
                        <AlertTriangle size={10} className="mr-0.5" /> {stage.failure_count_24h} failed
                      </span>
                    ) : (
                      <span className="inline-flex items-center text-[10px] font-bold text-emerald-700">
                        <CheckCircle2 size={10} className="mr-0.5" /> Healthy
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* T3: Safety Controls (Circuit Breakers) */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">T3 · Safety Controls</h3>
          <button
            type="button"
            onClick={() => navigate("/super-admin/kill-switch")}
            className="text-xs font-bold text-brand-600 hover:text-brand-800"
          >
            Manage Breakers →
          </button>
        </div>

        <div className="mt-4 space-y-2.5">
          {controls.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-600">No circuit breakers loaded.</p>
          ) : (
            controls.slice(0, 4).map((c) => (
              <div key={c.scope} className="flex items-center justify-between rounded-2xl border border-slate-100 bg-slate-50 px-3.5 py-2.5 text-xs">
                <div>
                  <span className="font-semibold text-slate-800">{c.display_name}</span>
                  {c.expires_at && (
                    <span className="ml-2 inline-flex items-center gap-1 text-[10px] text-amber-700 font-bold">
                      <Clock size={10} /> Auto-expires {new Date(c.expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
                <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-extrabold ${c.enabled ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
                  {c.enabled ? "Active" : "PAUSED"}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* T4: Critical Event Stream */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">T4 · Critical Event Stream</h3>
          <button
            type="button"
            onClick={() => navigate("/super-admin/audit-logs")}
            className="text-xs font-bold text-brand-600 hover:text-brand-800"
          >
            Full Audit Feed →
          </button>
        </div>

        <div className="mt-4 space-y-2.5">
          {criticalEvents.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-600">No critical events recorded recently.</p>
          ) : (
            criticalEvents.slice(0, 4).map((evt) => (
              <div key={evt.id} className="flex items-center justify-between gap-3 border-b border-slate-100 pb-2 text-xs last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-bold text-slate-900">{evt.action}</span>
                    <span className="text-slate-600">on {evt.entity_type}</span>
                  </div>
                  <p className="text-[11px] text-slate-600 truncate">{evt.reason || `By ${evt.actor_email || 'System'}`}</p>
                </div>
                <span className="shrink-0 text-[10px] font-medium text-slate-600">
                  {new Date(evt.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
