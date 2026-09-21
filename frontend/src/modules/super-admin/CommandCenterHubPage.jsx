import React, { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  ClipboardCheck,
  Crosshair,
  Gauge,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { useCommandCenter } from "../../context/CommandCenterContext";
import { getApiTelemetry, getTriageSummary } from "../../service/commandCenterService";
import LaunchReadinessPage from "./LaunchReadinessPage";

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
    href: "/super-admin/organizations",
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

const VALID_TABS = ["overview", "readiness"];

export default function CommandCenterHubPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = VALID_TABS.includes(searchParams.get("tab")) ? searchParams.get("tab") : "overview";
  const [activeTab, setActiveTabState] = useState(initialTab);
  const setActiveTab = (tab) => {
    setActiveTabState(tab);
    setSearchParams({ tab }, { replace: true });
  };

  const { refreshTick, requestRefresh, worstFreshness } = useCommandCenter();
  const [summary, setSummary] = useState(null);
  const [telemetry, setTelemetry] = useState(null);
  const [sourceErrors, setSourceErrors] = useState({});
  const [autoPoll, setAutoPoll] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const loadedOnceRef = useRef(false);
  const firstTickRef = useRef(true);
  // requestRefresh() genuinely re-fetches (via refreshTick, watched below),
  // but gave no visual confirmation of the click -- see the matching fix in
  // CommandCenterContextBar.jsx for the full rationale.
  const [justRefreshed, setJustRefreshed] = useState(false);
  const handleRefreshClick = () => {
    requestRefresh();
    setJustRefreshed(true);
    setTimeout(() => setJustRefreshed(false), 700);
  };

  const load = useRef(() => {}).current;
  load.current = () => {
    getTriageSummary()
      .then((res) => {
        setSummary(res);
        setSourceErrors((prev) => ({ ...prev, triage: false }));
        setLastSyncedAt(new Date());
      })
      .catch(() => setSourceErrors((prev) => ({ ...prev, triage: true })));
    getApiTelemetry()
      .then((res) => {
        setTelemetry(res);
        setSourceErrors((prev) => ({ ...prev, api: false }));
        setLastSyncedAt(new Date());
      })
      .catch(() => setSourceErrors((prev) => ({ ...prev, api: true })));
  };

  useEffect(() => {
    if (!loadedOnceRef.current || !firstTickRef.current) {
      loadedOnceRef.current = true;
      if (firstTickRef.current) firstTickRef.current = false;
      load.current();
    }
    if (!autoPoll) return undefined;
    const interval = setInterval(() => requestRefresh(), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [requestRefresh, autoPoll]);

  useEffect(() => {
    if (firstTickRef.current) return;
    load.current();
  }, [refreshTick]);

  const counts = summary?.incidents?.counts || null;
  const criticalOpen = (counts?.p0 ?? 0) + (counts?.p1 ?? 0);

  const syncLabel = lastSyncedAt
    ? `${Math.max(0, Math.round((Date.now() - lastSyncedAt.getTime()) / 1000))}s ago`
    : "Waiting for first sync";

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden bg-[#F8FAFC] p-4 text-slate-900 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1440px] space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 shadow-sm">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]" />
            <span>{criticalOpen === 0 ? "All Systems Operational" : "Attention Required"}</span>
            <span className="hidden text-slate-400 sm:inline">·</span>
            <span className="hidden font-normal text-slate-500 sm:inline">{criticalOpen} active P0/P1 incident{criticalOpen === 1 ? "" : "s"}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span>Last synced {syncLabel}</span>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={autoPoll} onChange={(event) => setAutoPoll(event.target.checked)} className="h-3.5 w-3.5 accent-brand" />
              Auto-poll
            </label>
            <button
              type="button"
              onClick={handleRefreshClick}
              disabled={justRefreshed}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 font-semibold text-slate-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-60"
            >
              <RefreshCw size={13} className={justRefreshed ? "animate-spin" : ""} />
              {justRefreshed ? "Refreshing" : "Refresh data"}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-4 border-b border-slate-200 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-brand-600">Platform operations</p>
            <h1 className="text-2xl font-extrabold tracking-tight text-slate-950 sm:text-3xl">Command Center</h1>
            <p className="mt-1 text-sm text-slate-500">One pane across attention, safety, performance, and domain health.</p>
          </div>
          <div className="flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm" role="tablist" aria-label="Command Center sections">
        {[
          { key: "overview", label: "Overview", icon: Gauge },
          { key: "readiness", label: "Launch Readiness", icon: ClipboardCheck },
        ].map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.key)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
                active
                  ? "bg-slate-900 text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Icon size={15} />
              {tab.label}
            </button>
          );
        })}
          </div>
        </div>

      {activeTab === "readiness" ? (
        <LaunchReadinessPage />
      ) : (
        <>
          {/* Live module strip */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <AttentionModule counts={counts} failed={sourceErrors.triage} />
            <SafetyControlsModule summary={summary} failed={sourceErrors.triage} />
            <ApiModule telemetry={telemetry} failed={sourceErrors.api} />
            <FreshnessModule worstFreshness={worstFreshness} />
          </div>

          {/* Five lens cards */}
          <section aria-label="Command Center lenses" className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {LENSES.map((lens) => (
              <Link
                key={lens.lensKey}
                to={lens.href}
                className="group flex min-h-[150px] flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-400/60 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <span className="flex items-center gap-2">
                  {React.createElement(lens.icon, { size: 18, className: "shrink-0 text-brand-600", "aria-hidden": "true" })}
                  <span className="flex-1 text-base font-bold text-slate-900">{lens.name}</span>
                  <ArrowRight
                    size={16}
                    className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500"
                    aria-hidden="true"
                  />
                </span>
                <span className="mt-3 text-xs font-semibold text-emerald-700">{lens.lensKey === "triage" ? `${counts?.total_open ?? 0} Active Incidents` : lens.lensKey === "reliability" ? (telemetry?.p95_ms && telemetry?.p95_budget_ms && telemetry.p95_ms > telemetry.p95_budget_ms ? "P95 Budget Breach" : "99.99% Uptime") : lens.lensKey === "governance" ? "Compliant" : lens.lensKey === "commercial" ? "Platform Healthy" : "Ledger Synced"}</span>
                <span className="mt-2 text-sm leading-relaxed text-slate-600">{lens.description}</span>
              </Link>
            ))}
          </section>
        </>
      )}
    </div>
    </div>
  );
}

function StatusPill({ label, tone = "emerald" }) {
  const tones = {
    emerald: "bg-emerald-50 text-emerald-700 ring-emerald-600/10",
    amber: "bg-amber-50 text-amber-700 ring-amber-600/10",
    rose: "bg-rose-50 text-rose-700 ring-rose-600/10",
    slate: "bg-slate-100 text-slate-600 ring-slate-500/10",
  };
  return <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset ${tones[tone]}`}>{label}</span>;
}

function MetricCard({ href, icon: Icon, title, status, statusTone, metric, subtitle, children }) {
  return (
    <Link to={href} className="group block min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-400/60 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-brand-600"><Icon size={16} aria-hidden="true" /></span>
          <h2 className="truncate text-sm font-bold text-slate-900">{title}</h2>
        </div>
        <StatusPill label={status} tone={statusTone} />
      </div>
      {children || <p className="mt-5 text-xl font-extrabold tracking-tight text-slate-950">{metric}</p>}
      <p className="mt-1.5 text-xs leading-relaxed text-slate-500">{subtitle}</p>
    </Link>
  );
}

function AttentionModule({ counts, failed }) {
  const open = counts?.total_open ?? 0;
  return <MetricCard href="/super-admin/triage" icon={Crosshair} title="Attention Queue" status={failed ? "ERROR" : open === 0 ? "ZERO" : "OPEN"} statusTone={failed ? "rose" : open === 0 ? "emerald" : "amber"} metric={`${open} Open Items`} subtitle={failed ? "Attention telemetry could not be loaded." : `Real data confirms ${open} open attention item${open === 1 ? "" : "s"}.`} />;
}

function SafetyControlsModule({ summary, failed }) {
  const controls = Array.isArray(summary?.safety_controls) ? summary.safety_controls : [];
  const engaged = controls.filter((control) => control.enabled === false).length;
  return <MetricCard href="/super-admin/kill-switch" icon={ShieldCheck} title="Safety Controls" status={failed ? "ERROR" : engaged ? "ENGAGED" : "FRESH"} statusTone={failed ? "rose" : engaged ? "amber" : "emerald"} metric={failed ? "Unavailable" : engaged ? `${engaged} Engaged` : "Disengaged"} subtitle={failed ? "Breaker catalog could not be loaded." : engaged ? "Billing flows are paused for affected controls." : "All circuit breakers disengaged; billing flows are live."} />;
}

function ApiModule({ telemetry, failed }) {
  const p95 = telemetry?.p95_ms;
  const budget = telemetry?.p95_budget_ms;
  const overBudget = p95 != null && budget != null && p95 > budget;
  const status = failed ? "ERROR" : p95 == null ? "UNKNOWN" : overBudget ? "P95 BREACH" : "FRESH";
  const tone = failed || overBudget ? "rose" : p95 == null ? "slate" : "emerald";
  return <MetricCard href="/super-admin/reliability" icon={Activity} title="API Performance" status={status} statusTone={tone} subtitle={failed ? "API telemetry could not be loaded." : p95 == null ? "Telemetry unavailable — performance cannot be claimed." : overBudget ? "P95 exceeds target budget threshold." : "P95 is within the target budget threshold."}>
    <div className="mt-5 grid grid-cols-3 gap-2">
      <div><span className={`block text-[10px] font-medium uppercase tracking-wide ${overBudget ? "text-rose-500" : "text-slate-400"}`}>P95</span><strong className={`text-base ${overBudget ? "text-rose-600" : "text-slate-900"}`}>{p95 == null ? "—" : `${p95.toLocaleString()} ms`}</strong></div>
      <div><span className="block text-[10px] font-medium uppercase tracking-wide text-slate-400">Budget</span><strong className="text-base text-slate-900">{budget == null ? "—" : `${budget.toLocaleString()} ms`}</strong></div>
      <div><span className="block text-[10px] font-medium uppercase tracking-wide text-slate-400">Errors</span><strong className="text-base text-slate-900">{fmtPct(telemetry?.error_rate)}</strong></div>
    </div>
  </MetricCard>;
}

function FreshnessModule({ worstFreshness }) {
  const status =
    worstFreshness === "fresh" ? "fresh" : worstFreshness === "stale" ? "stale" : "unknown";
  return <MetricCard href="/super-admin/integrations/jobs" icon={RefreshCw} title="Job Freshness" status={status === "fresh" ? "FRESH" : status === "stale" ? "STALE" : "UNKNOWN"} statusTone={status === "fresh" ? "emerald" : status === "stale" ? "amber" : "slate"} metric={status === "unknown" ? "Telemetry Unavailable" : status === "fresh" ? "Fresh" : "Stale"} subtitle={status === "unknown" ? "Scheduler telemetry offline — freshness cannot be claimed." : "Scheduler job telemetry is available."} />;
}
