import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Crosshair,
  Gauge,
  HelpCircle,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import ModuleState from "../../components/ModuleState";
import { PageHeader } from "../../components/billing-ui";
import { useCommandCenter } from "../../context/CommandCenterContext";
import { getApiTelemetry, getTriageSummary } from "../../service/commandCenterService";

/**
 * ZB-SA-CMD-003 §22 — the Command Center hub: one page that answers "what
 * needs me right now?" across all five lenses and routes the operator to
 * the authoritative lens for each concern. It composes ONLY the real
 * sources their dedicated lenses use (attention engine, triage summary,
 * API telemetry) — no parallel data path, no fixture data.
 *
 * Every module on this page renders its §13 state via <ModuleState>:
 * loading / zero / stale / unknown / error are distinct and honest.
 */

const POLL_INTERVAL_MS = 60000;

const LENSES = [
  {
    name: "Triage & Attention",
    lensKey: "triage",
    href: "/super-admin/triage",
    icon: Crosshair,
    description:
      "Severity-ranked attention queue with SLA clocks — incidents, job failures, integrity signals.",
  },
  {
    name: "Commercial",
    lensKey: "commercial",
    href: "/super-admin/commercial/accounts",
    icon: TrendingUp,
    description:
      "Domain A — accounts, plans, platform subscriptions, entitlements. Per-currency MRR, never FX-summed.",
  },
  {
    name: "Financial Operations",
    lensKey: "financial",
    href: "/super-admin/financial-operations",
    icon: Activity,
    description:
      "Domain B money-in-motion — billings, recovery, leakage and ledger-integrity composite state.",
  },
  {
    name: "Reliability",
    lensKey: "reliability",
    href: "/super-admin/reliability",
    icon: Gauge,
    description:
      "Domain C telemetry — job health, processing failures, API latency/error window.",
  },
  {
    name: "Governance & Security",
    lensKey: "governance",
    href: "/super-admin/governance",
    icon: ShieldCheck,
    description:
      "Attention lifecycle, approval queue (maker-checker), privileged sessions, audit evidence.",
  },
];

function fmtPct(value) {
  return value == null ? "—" : `${(value * 100).toFixed(2)}%`;
}

export default function CommandCenterHubPage() {
  const { refreshTick, requestRefresh, worstFreshness } = useCommandCenter();
  const [summary, setSummary] = useState(null);
  const [telemetry, setTelemetry] = useState(null);
  const [sourceErrors, setSourceErrors] = useState({});
  const loadedOnceRef = useRef(false);
  const firstTickRef = useRef(true);

  const load = useRef(() => {}).current;
  load.current = () => {
    getTriageSummary()
      .then((res) => {
        setSummary(res);
        setSourceErrors((prev) => ({ ...prev, triage: false }));
      })
      .catch(() => setSourceErrors((prev) => ({ ...prev, triage: true })));
    getApiTelemetry()
      .then((res) => {
        setTelemetry(res);
        setSourceErrors((prev) => ({ ...prev, api: false }));
      })
      .catch(() => setSourceErrors((prev) => ({ ...prev, api: true })));
  };

  useEffect(() => {
    if (!loadedOnceRef.current || !firstTickRef.current) {
      loadedOnceRef.current = true;
      if (firstTickRef.current) firstTickRef.current = false;
      load.current();
    }
    const interval = setInterval(() => requestRefresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [requestRefresh]);

  useEffect(() => {
    if (firstTickRef.current) return;
    load.current();
  }, [refreshTick]);

  const counts = summary?.incidents?.counts || null;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <PageHeader
        title="Command Center"
        subtitle="One pane across all five lenses. Every module states exactly how it knows what it knows."
        actions={
          <button
            type="button"
            onClick={() => requestRefresh()}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Refresh
          </button>
        }
      />

      {/* Live module strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <AttentionModule counts={counts} failed={sourceErrors.triage} />
        <SafetyControlsModule summary={summary} failed={sourceErrors.triage} />
        <ApiModule telemetry={telemetry} failed={sourceErrors.api} />
        <FreshnessModule worstFreshness={worstFreshness} />
      </div>

      {/* Five lens cards */}
      <section aria-label="Command Center lenses" className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {LENSES.map((lens, idx) => (
          <Link
            key={lens.lensKey}
            to={lens.href}
            className="group flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand-300 hover:shadow-md focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <span className="flex items-center gap-2">
              {React.createElement(lens.icon, { size: 18, className: "text-brand-600 shrink-0", "aria-hidden": "true" })}
              <span className="flex-1 text-base font-bold text-slate-900">{lens.name}</span>
              <ArrowRight
                size={16}
                className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500"
                aria-hidden="true"
              />
            </span>
            <span className="mt-2 text-sm leading-relaxed text-slate-600">{lens.description}</span>
          </Link>
        ))}
      </section>
    </div>
  );
}

function AttentionModule({ counts, failed }) {
  let status = "loading";
  let detail;
  if (failed) {
    status = "error";
    detail = "Attention counts could not be loaded — open the Triage lens directly.";
  } else if (counts) {
    const open = counts.total_open ?? 0;
    status = open === 0 ? "zero" : "fresh";
    detail =
      open === 0
        ? "Real data confirms: 0 open attention items."
        : `P0 ${counts.p0} · P1 ${counts.p1} · P2 ${counts.p2} · P3 ${counts.p3}` +
          ((counts.sla_breaches ?? 0) > 0 ? ` · ${counts.sla_breaches} SLA breach(es)` : "");
  }
  return (
    <Link to="/super-admin/triage" className="block rounded-xl focus-visible:ring-2 focus-visible:ring-brand-500">
      <ModuleState
        status={status}
        title="Attention Queue"
        detail={detail}
        asOf={
          counts && counts.total_open != null
            ? `${counts.total_open} open item${counts.total_open === 1 ? "" : "s"}`
            : undefined
        }
      />
    </Link>
  );
}

function SafetyControlsModule({ summary, failed }) {
  let status = "loading";
  let engaged = null;
  if (failed) {
    status = "error";
  } else if (summary) {
    const controls = Array.isArray(summary.safety_controls) ? summary.safety_controls : [];
    engaged = controls.filter((c) => c.enabled === false);
    status = "fresh";
  }
  return (
    <Link to="/super-admin/kill-switch" className="block rounded-xl focus-visible:ring-2 focus-visible:ring-brand-500">
      <ModuleState
        status={status}
        title="Safety Controls"
        detail={
          status === "fresh"
            ? engaged && engaged.length > 0
              ? `${engaged.length} breaker(s) currently ENGAGED — charging is paused for affected flows.`
              : "All circuit breakers disengaged; billing flows are live."
            : status === "error"
              ? "Breaker catalog could not be loaded — open Kill Switch directly."
              : undefined
        }
      />
    </Link>
  );
}

function ApiModule({ telemetry, failed }) {
  const MODULE_STATES = {
    loading: { label: "Loading…", className: "border-slate-200 bg-slate-50 text-slate-600", chipClassName: "bg-slate-100 text-slate-600", Icon: RefreshCw },
    error:   { label: "Error",     className: "border-red-200 bg-red-50/60 text-red-800",       chipClassName: "bg-red-100 text-red-700",     Icon: AlertTriangle },
    unknown: { label: "Unknown",   className: "border-indigo-200 bg-indigo-50/50 text-indigo-900", chipClassName: "bg-indigo-100 text-indigo-700", Icon: HelpCircle },
    stale:   { label: "Stale",     className: "border-amber-300 bg-amber-50/60 text-amber-900", chipClassName: "bg-amber-100 text-amber-800",  Icon: AlertTriangle },
    fresh:   { label: "Fresh",     className: "border-emerald-200 bg-white text-slate-700",    chipClassName: "bg-emerald-100 text-emerald-700", Icon: CheckCircle2 },
  };

  let stateKey = "loading";
  let errorMsg;
  if (failed) {
    stateKey = "error";
    errorMsg = "API telemetry could not be loaded.";
  } else if (telemetry) {
    const p95 = telemetry.p95_ms;
    const budget = telemetry.p95_budget_ms;
    if (p95 == null) {
      stateKey = "unknown";
    } else if (budget != null && p95 > budget) {
      stateKey = "stale";
    } else {
      stateKey = "fresh";
    }
  }

  const meta = MODULE_STATES[stateKey];
  const p95 = telemetry?.p95_ms;
  const budget = telemetry?.p95_budget_ms;
  const overBudget = p95 != null && budget != null && p95 > budget;
  const hasData = p95 != null;

  const detailText =
    stateKey === "error"
      ? errorMsg
      : stateKey === "unknown"
        ? "No samples in the sliding window yet (single-process telemetry resets on restart)."
        : null;

  const sloNote = telemetry?.slo?.status === "NOT_CONFIGURED"
    ? "SLOs/error budgets: NOT CONFIGURED (only the p95 budget is enforced)."
    : null;

  return (
    <Link to="/super-admin/reliability" className="block rounded-xl focus-visible:ring-2 focus-visible:ring-brand-500">
      <div className={`rounded-xl border px-4 py-3 ${meta.className}`}>
        <div className="flex items-center gap-2">
          <meta.Icon size={14} aria-hidden="true" />
          <span className="text-sm font-semibold">API Performance</span>
          <span className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${meta.chipClassName}`}>
            {meta.label}
          </span>
        </div>
        {detailText && (
          <p className="mt-1 text-xs leading-relaxed opacity-80">{detailText}</p>
        )}
        {hasData && (
          <div className={`mt-2 grid grid-cols-3 gap-2 rounded-lg px-3 py-2 text-[11px] ${
            overBudget ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-600"
          }`}>
            <div>
              <span className="block text-[9px] font-medium uppercase tracking-wide opacity-60">p95</span>
              <span className="font-semibold">{p95.toLocaleString()} ms</span>
            </div>
            <div>
              <span className="block text-[9px] font-medium uppercase tracking-wide opacity-60">Budget</span>
              <span className="font-semibold">{budget?.toLocaleString() ?? "—"} ms</span>
            </div>
            <div>
              <span className="block text-[9px] font-medium uppercase tracking-wide opacity-60">Errors</span>
              <span className="font-semibold">{fmtPct(telemetry?.error_rate)}</span>
            </div>
          </div>
        )}
        {sloNote && (
          <p className="mt-1.5 flex items-center gap-1 text-[10px] leading-snug opacity-60">
            <HelpCircle size={11} aria-hidden="true" /> {sloNote}
          </p>
        )}
      </div>
    </Link>
  );
}

function FreshnessModule({ worstFreshness }) {
  const status =
    worstFreshness === "fresh" ? "fresh" : worstFreshness === "stale" ? "stale" : "unknown";
  return (
    <Link to="/super-admin/integrations/jobs" className="block rounded-xl focus-visible:ring-2 focus-visible:ring-brand-500">
      <ModuleState
        status={status}
        title="Job Freshness"
        detail={
          status === "unknown"
            ? "Scheduler telemetry unavailable or jobs have never run — freshness cannot be claimed."
            : undefined
        }
      />
    </Link>
  );
}
