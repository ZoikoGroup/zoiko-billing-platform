import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Crosshair,
  Gauge,
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
            className={`group flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-brand-300 hover:shadow-md focus-visible:ring-2 focus-visible:ring-brand-500 ${
              idx === 0 ? "lg:col-span-2 xl:col-span-1" : ""
            }`}
          >
            <span className="flex items-center gap-2">
              {React.createElement(lens.icon, { size: 18, className: "text-brand-600", "aria-hidden": "true" })}
              <span className="text-base font-bold text-slate-900">{lens.name}</span>
              <ArrowRight
                size={16}
                className="ml-auto text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500"
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
  let status = "loading";
  let detail;
  if (failed) {
    status = "error";
    detail = "API telemetry could not be loaded.";
  } else if (telemetry) {
    const p95 = telemetry.p95_ms;
    const budget = telemetry.p95_budget_ms;
    if (p95 == null) {
      status = "unknown";
      detail = "No samples in the sliding window yet (single-process telemetry resets on restart).";
    } else if (budget != null && p95 > budget) {
      status = "stale";
      detail = `p95 ${p95} ms exceeds the ${budget} ms server budget.`;
    } else {
      status = "fresh";
      detail = `p95 ${p95} ms of ${budget} ms server budget · errors ${fmtPct(telemetry.error_rate)} · ${telemetry.sample_count} samples`;
    }
  }
  return (
    <Link to="/super-admin/reliability" className="block rounded-xl focus-visible:ring-2 focus-visible:ring-brand-500">
      <ModuleState
        status={status}
        title="API Performance"
        detail={detail}
        asOf={
          telemetry?.slo?.status === "NOT_CONFIGURED"
            ? "SLOs/error budgets: NOT CONFIGURED (only the p95 budget is enforced)."
            : undefined
        }
      />
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
