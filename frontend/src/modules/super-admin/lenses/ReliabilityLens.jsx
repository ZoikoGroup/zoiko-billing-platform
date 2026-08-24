import React, { useEffect, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock, HelpCircle, Server, Database, Radio } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getApiTelemetry, getConfigurationInventory } from "../../../service/commandCenterService";
import { api } from "../../../service/api";
import { useAuth } from "../../../context/AuthContext";
import { canReadReliabilityTelemetry, canReadConfiguration } from "../../../config/roles";

// R1/R2 status → display mapping. Every status value here must trace to a real
// backend signal or an honest absence-of-signal declaration — never a fabricated
// "Healthy"/"Configured"/"Connected" default. See
// docs/SUPER_ADMIN_PHASE3_ARCHITECTURE_REMEDIATION_REPORT.md Mandatory Fix 3.
const STATUS_STYLE = {
  HEALTHY: "text-emerald-700",
  CONFIGURED: "text-emerald-700",
  DEGRADED: "text-amber-600",
  FAILED: "text-rose-700",
  NOT_CONFIGURED: "text-amber-600",
  NOT_MONITORED: "text-amber-600",
  UNKNOWN: "text-amber-600",
  CHECKING: "text-slate-500",
};

function StatusIcon({ status }) {
  if (status === "HEALTHY" || status === "CONFIGURED") return <CheckCircle2 size={10} />;
  if (status === "FAILED") return <AlertTriangle size={10} />;
  return <HelpCircle size={10} />;
}

export default function ReliabilityLens({ telemetry, jobs }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canReadTelemetry = canReadReliabilityTelemetry(user?.platform_role);
  const canReadConfig = canReadConfiguration(user?.platform_role);
  // Phase 4 (G-05) — the SLO card reads REAL measured server-side latency
  // and error rates (core/api_metrics.py). No samples since process start =>
  // UNKNOWN; never a fabricated green number.
  const [apiStats, setApiStats] = useState(null);
  // R1 — real DB liveness signal, same /health check ReliabilityPage.jsx uses.
  const [dbHealth, setDbHealth] = useState({ status: "CHECKING" });
  // R2 — real environment-capability evidence from ConfigurationGovernanceService.
  const [configEntries, setConfigEntries] = useState(null);

  useEffect(() => {
    if (!canReadTelemetry) return undefined;
    let cancelled = false;
    getApiTelemetry()
      .then((res) => { if (!cancelled) setApiStats(res); })
      .catch(() => { if (!cancelled) setApiStats(null); });
    return () => { cancelled = true; };
  }, [canReadTelemetry]);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/health", { auth: false })
      .then((res) => {
        if (cancelled) return;
        setDbHealth({ status: res?.database === "connected" ? "HEALTHY" : "FAILED" });
      })
      .catch(() => { if (!cancelled) setDbHealth({ status: "UNKNOWN" }); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!canReadConfig) return undefined;
    let cancelled = false;
    getConfigurationInventory()
      .then((res) => { if (!cancelled) setConfigEntries(res?.entries || []); })
      .catch(() => { if (!cancelled) setConfigEntries([]); }); // settled, but inconclusive => UNKNOWN below, never CHECKING forever
    return () => { cancelled = true; };
  }, [canReadConfig]);

  const hasSamples = Boolean(apiStats && apiStats.sample_count > 0);
  const errorRatePct =
    apiStats?.error_rate != null ? `${(apiStats.error_rate * 100).toFixed(2)}%` : null;
  const clientRatePct =
    apiStats?.client_error_rate != null ? `${(apiStats.client_error_rate * 100).toFixed(2)}%` : null;

  const jobList = jobs || [];
  const failingJobs = jobList.filter((j) => j.last_status === "failed" || j.freshness === "unknown");

  function configuredCapability(name) {
    if (configEntries === null) return null; // request still in flight — render CHECKING, not a guess
    const entry = configEntries.find((e) => e.name === name);
    if (!entry) return "UNKNOWN"; // settled, but no evidence found for this capability — never fabricated
    return entry.value === "CONFIGURED" ? "CONFIGURED" : "NOT_CONFIGURED";
  }

  // R1: Subsystem Health — ZB-SA-CMD-003 §12 / Phase 2D. Only "Database & Core" has
  // a real backend liveness signal (/health). Every other listed subsystem has no
  // dedicated health read-model in this codebase today, so it is reported honestly
  // as NOT_MONITORED rather than a fabricated "Healthy" default.
  const subsystems = [
    { name: "Database & Core", status: dbHealth.status, signal: "Liveness Check (/health)" },
    { name: "Identity & Auth", status: "NOT_MONITORED", signal: "No dedicated health probe" },
    { name: "Commercial Plans", status: "NOT_MONITORED", signal: "No dedicated health probe" },
    { name: "Subscriptions", status: "NOT_MONITORED", signal: "No dedicated health probe" },
    { name: "Rating Engine", status: "NOT_MONITORED", signal: "Job Telemetry" },
    { name: "Invoicing", status: "NOT_MONITORED", signal: "No dedicated health probe" },
    { name: "Payment Allocation", status: "NOT_MONITORED", signal: "No dedicated health probe" },
    { name: "Ledger", status: "NOT_MONITORED", signal: "Not Monitored" },
    { name: "Reconciliation", status: "NOT_MONITORED", signal: "ISS-017 Blocked" },
    { name: "Notifications", status: "NOT_MONITORED", signal: "Not Monitored" },
    { name: "Webhooks", status: "NOT_MONITORED", signal: "Not Monitored" },
    { name: "Reporting", status: "NOT_MONITORED", signal: "No dedicated health probe" },
  ];

  // R2: Integration Health — sourced from ConfigurationGovernanceService's
  // environment-capability entries (presence-only, real evidence). Integrations
  // with no backend code path at all (tax providers, ERP sync, webhook relay) have
  // nothing to be "configured" — reported as NOT_MONITORED, never green.
  const stripeGateway = canReadConfig ? configuredCapability("stripe.gateway") : null;
  const smtpProvider = canReadConfig ? configuredCapability("smtp.provider") : null;
  const integrations = [
    { name: "Stripe Payment Gateway", status: stripeGateway ?? (canReadConfig ? "CHECKING" : "UNKNOWN") },
    { name: "Tax Providers (Avalara/TaxJar)", status: "NOT_MONITORED" },
    { name: "Accounting / ERP Sync", status: "NOT_MONITORED" },
    { name: "Outbound Webhooks Relay", status: "NOT_MONITORED" },
    { name: "SMTP Email Service", status: smtpProvider ?? (canReadConfig ? "CHECKING" : "UNKNOWN") },
  ];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {/* R1: Subsystem Health */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">R1 · Subsystem Health</h3>
            <p className="text-[11px] text-slate-500">12 platform subsystems — honest monitoring coverage</p>
          </div>
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-700">
            Partial Coverage
          </span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
          {subsystems.map((svc) => (
            <div key={svc.name} className="rounded-xl border border-slate-100 bg-slate-50 p-2 text-center">
              <span className="block font-bold text-slate-800 truncate" title={svc.name}>{svc.name}</span>
              <span
                className={`mt-1 inline-flex items-center gap-0.5 text-[10px] font-extrabold ${STATUS_STYLE[svc.status] || "text-amber-600"}`}
                title={svc.signal}
              >
                <StatusIcon status={svc.status} />
                {svc.status.replace(/_/g, " ")}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* R2: Integration Health */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">R2 · Integration Health</h3>
            <p className="text-[11px] text-slate-500">External connectors &amp; service integrations</p>
          </div>
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-bold text-amber-700">
            Partial Coverage
          </span>
        </div>
        <div className="mt-4 space-y-2 text-xs">
          {integrations.map((item) => (
            <div key={item.name} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
              <span className="font-semibold text-slate-800">{item.name}</span>
              <span className={`inline-flex items-center gap-1 font-bold ${STATUS_STYLE[item.status] || "text-amber-600"}`}>
                <StatusIcon status={item.status} />
                {item.status.replace(/_/g, " ")}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* R3: Queues & Jobs */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">R3 · Background Job Health</h3>
          <button
            type="button"
            onClick={() => navigate("/super-admin/tenant-health")}
            className="text-xs font-bold text-brand-600 hover:text-brand-800"
          >
            Telemetry View →
          </button>
        </div>
        <div className="mt-4 space-y-2.5 text-xs">
          {jobList.length === 0 ? (
            <div className="py-4 text-center text-xs text-slate-600">
              <HelpCircle size={20} className="mx-auto text-slate-400 mb-1" />
              No background job runs recorded yet. (Telemetry is UNKNOWN until first execution).
            </div>
          ) : (
            jobList.slice(0, 4).map((j) => (
              <div key={j.job_name} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50 px-3.5 py-2">
                <span className="font-semibold text-slate-800">{j.display_name || j.job_name}</span>
                <span className="text-slate-600">
                  {j.run_count_24h || 0} runs · {j.failure_count_24h || 0} failures
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* R4: SLO / Error Budget — real measured telemetry (G-05) */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">R4 · API Latency &amp; Errors</h3>
          <span className="text-xs font-semibold text-slate-600">
            /api/super-admin/* · last {hasSamples ? Math.round((apiStats.window_seconds || 0) / 60) : 60} min
          </span>
        </div>
        {!canReadTelemetry ? (
          <div className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-100 bg-amber-50 p-4 text-xs">
            <HelpCircle size={18} className="mt-0.5 shrink-0 text-amber-500" />
            <p className="text-amber-800">
              Not available — your platform role does not include the
              reliability.read capability. Ask a Platform Administrator for access.
            </p>
          </div>
        ) : !hasSamples ? (
          <div className="mt-4 flex items-start gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4 text-xs">
            <HelpCircle size={18} className="mt-0.5 shrink-0 text-amber-500" />
            <p className="text-slate-600">
              UNKNOWN — fewer than one request recorded since process start (telemetry is
              single-process and resets on restart). No fabricated figures are shown.
            </p>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
                p95 / p50 handling
              </span>
              <p
                className={`mt-1 text-xl font-extrabold ${
                  apiStats.p95_ms <= apiStats.p95_budget_ms ? "text-emerald-700" : "text-amber-700"
                }`}
              >
                {apiStats.p95_ms}ms <span className="text-sm font-bold text-slate-500">/ {apiStats.p50_ms}ms</span>
              </p>
              <span className="text-[11px] text-slate-600">
                {apiStats.sample_count} requests · budget {apiStats.p95_budget_ms}ms · max{" "}
                {apiStats.max_ms}ms
              </span>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
                Error rates
              </span>
              <p
                className={`mt-1 text-xl font-extrabold ${
                  apiStats.error_count > 0 ? "text-red-700" : "text-emerald-700"
                }`}
                title={
                  errorRatePct == null
                    ? "No sample carried a known HTTP status — rate not computable."
                    : `${apiStats.error_count} server error(s) over ${apiStats.sample_count} requests.`
                }
              >
                {errorRatePct ?? "UNKNOWN"}
              </p>
              <span className="text-[11px] text-slate-600">
                {clientRatePct != null ? `${clientRatePct} client errors` : "client rate unknown"}
                {apiStats.status_unknown_count > 0 &&
                  ` · ${apiStats.status_unknown_count} sample(s) without status`}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
