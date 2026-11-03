import React, { useEffect, useRef, useState } from "react";
import { NAVY_SURFACE } from "../../components/billing-ui";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Crosshair,
  Gauge,
  Mail,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { useCommandCenter } from "../../context/CommandCenterContext";
import usePolling from "../../hooks/usePolling";
import { getApiTelemetry, getEmailDeliveryOverview, getTriageSummary } from "../../service/commandCenterService";
import LaunchReadinessPage from "./LaunchReadinessPage";
import { formatPercent } from "../../utils/billing-helpers";

/**
 * ZB-SA-CMD-003 §22 — the Command Center hub: one page that answers "what
 * needs me right now?" across all five lenses and routes the operator to
 * the authoritative lens for each concern. It composes ONLY the real
 * sources their dedicated lenses use (attention engine, triage summary,
 * API telemetry) — no parallel data path, no fixture data.
 *
 * Redesigned to match the super-admin platform dashboard design language:
 * navy command-hero banner, Section/Card/KpiTile components, staggered
 * entrance motion and honest per-source loading states.
 */

const POLL_INTERVAL_MS = 60000;

const LENSES = [
  {
    name: "Triage & Attention",
    lensKey: "triage",
    href: "/super-admin/triage",
    icon: Crosshair,
    description:
      "Incidents, failed jobs and integrity signals ranked by severity, with response-time clocks.",
  },
  {
    name: "Commercial",
    lensKey: "commercial",
    href: "/super-admin/organizations",
    icon: TrendingUp,
    description:
      "Customer accounts, plans, platform subscriptions and entitlements. Revenue is shown per currency, never converted and summed.",
  },
  {
    name: "Financial Operations",
    lensKey: "financial",
    href: "/super-admin/financial-operations",
    icon: Activity,
    description:
      "Tenant billing in motion — invoices, payment recovery, revenue leakage and ledger integrity.",
  },
  {
    name: "Reliability",
    lensKey: "reliability",
    href: "/super-admin/reliability",
    icon: Gauge,
    description:
      "Background job health, processing failures and API latency / error rates.",
  },
  {
    name: "Governance & Security",
    lensKey: "governance",
    href: "/super-admin/governance",
    icon: ShieldCheck,
    description:
      "Approval queue (two-person review), privileged support sessions and the audit trail.",
  },
];

function fmtPct(value) {
  return value == null ? "—" : formatPercent(value * 100, 2);
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const VALID_TABS = ["overview", "readiness"];

// ── Presentation helpers — mirror the platform dashboard design language ──

function Section({ title, subtitle, icon: Icon, delay = 0, children }) {
  return (
    <section className="pd-rise space-y-4" style={{ animationDelay: `${delay}ms` }} aria-label={title}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-extrabold tracking-tight text-slate-900">
            {Icon && (
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                <Icon size={15} />
              </span>
            )}
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 text-xs text-slate-600">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Card({ className = "", children, ...rest }) {
  return (
    <div className={`rounded-3xl border border-slate-200/80 bg-white p-5 shadow-[0_4px_24px_rgba(15,23,42,0.04)] ${className}`} {...rest}>
      {children}
    </div>
  );
}

const TONES = {
  brand: "from-brand-500 to-indigo-500",
  blue: "from-sky-500 to-blue-500",
  amber: "from-amber-400 to-orange-500",
  red: "from-rose-500 to-red-500",
  emerald: "from-emerald-500 to-teal-500",
  // Neutral: "no signal" must not borrow the green of a healthy one.
  slate: "from-slate-400 to-slate-500",
};

function KpiTile({ icon: Icon, tone = "brand", label, value, hint, onClick, delay }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${value}. ${hint}`}
      className={`pd-rise group rounded-3xl border border-slate-200/80 bg-white p-5 text-left shadow-[0_4px_24px_rgba(15,23,42,0.04)] transition duration-200 hover:-translate-y-1 hover:shadow-[0_14px_30px_-12px_rgba(15,23,42,0.18)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className={`flex h-10 w-10 items-center justify-center rounded-2xl bg-linear-to-br text-white shadow-sm ${TONES[tone] || TONES.slate}`}>
        <Icon size={18} />
      </span>
      <span className="mt-4 block text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      <span className="mt-1 block text-2xl font-extrabold text-slate-900">{value}</span>
      <span className="mt-0.5 flex items-center justify-between text-[11px] text-slate-500">
        <span className="truncate">{hint}</span>
        <ArrowRight size={13} className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500" />
      </span>
    </button>
  );
}

export default function CommandCenterHubPage() {
  const navigate = useNavigate();
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
  const [emailDelivery, setEmailDelivery] = useState(null);
  const [sourceErrors, setSourceErrors] = useState({});
  const [autoPoll, setAutoPoll] = useState(true);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const refreshTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(refreshTimerRef.current), []);
  const handleRefreshClick = () => {
    requestRefresh();
    setJustRefreshed(true);
    clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => setJustRefreshed(false), 700);
  };

  // Per-source request sequence: a slow response from an older cycle must
  // never overwrite a newer one (or flip a recovered source back to failed).
  const seqRef = useRef({ triage: 0, api: 0, emailDelivery: 0 });
  const fetchSource = (key, fetcher, setter) => {
    const seq = ++seqRef.current[key];
    fetcher()
      .then((res) => {
        if (seq !== seqRef.current[key]) return;
        setter(res);
        setSourceErrors((prev) => ({ ...prev, [key]: false }));
        setLastSyncedAt(new Date());
      })
      .catch(() => {
        if (seq !== seqRef.current[key]) return;
        setSourceErrors((prev) => ({ ...prev, [key]: true }));
      });
  };

  // One load per refresh tick (mount included). The old pair of effects
  // loaded twice on mount and again on every Auto-poll toggle.
  useEffect(() => {
    fetchSource("triage", getTriageSummary, setSummary);
    fetchSource("api", getApiTelemetry, setTelemetry);
    fetchSource("emailDelivery", getEmailDeliveryOverview, setEmailDelivery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  usePolling(() => requestRefresh({ auto: true }), POLL_INTERVAL_MS, { enabled: autoPoll });

  // ── Derived values (every figure traces to a real backend signal) ──
  // null = not loaded yet (or the source failed before ever loading): shown
  // as "—", never as a reassuring 0.
  const counts = summary?.incidents?.counts || null;
  const criticalOpen = counts ? (counts.p0 ?? 0) + (counts.p1 ?? 0) : null;
  const totalOpen = counts ? counts.total_open ?? 0 : null;

  const controls = Array.isArray(summary?.safety_controls) ? summary.safety_controls : null;
  // enabled=false means the breaker is ENGAGED (that billing path is paused).
  const engaged = controls ? controls.filter((control) => control.enabled === false).length : null;

  const p95 = telemetry?.p95_ms ?? null;
  // An empty telemetry window omits the top-level budget; the SLO block
  // always carries it.
  const budget = telemetry?.p95_budget_ms ?? telemetry?.slo?.p95_budget_ms ?? null;
  const overBudget = p95 != null && budget != null && p95 > budget;

  const health = emailDelivery?.smtp_health;
  const failureRate = emailDelivery?.last_24h?.failure_rate_pct;
  const failedCount = emailDelivery?.last_24h?.failed;

  // Only sources whose LAST attempt failed — a key set to false means the
  // source recovered, so counting keys reported every healthy source as down.
  const sourceErrorCount = Object.values(sourceErrors).filter(Boolean).length;

  const syncLabel = lastSyncedAt
    ? `Last synced ${lastSyncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    : "Waiting for first sync";

  const statusLabel = criticalOpen == null
    ? sourceErrors.triage
      ? "Attention queue unavailable"
      : "Checking status…"
    : criticalOpen > 0
    ? `${criticalOpen} critical incident${criticalOpen === 1 ? "" : "s"} open`
    : sourceErrorCount > 0
    ? "Partial visibility"
    : "No critical incidents open";
  const statusTone = criticalOpen > 0 ? "critical" : criticalOpen === 0 && sourceErrorCount === 0 ? "ok" : "neutral";

  const display = (value) => (value == null ? "—" : value);

  let freshnessValue = "Not tracked";
  let freshnessHint = "Scheduler disabled or job telemetry not available to your role";
  if (worstFreshness === "unknown") {
    freshnessValue = "Unknown";
    freshnessHint = "No job run recorded yet for at least one job";
  } else if (worstFreshness === "stale") {
    freshnessValue = "Stale";
    freshnessHint = "At least one job missed its expected interval";
  } else if (worstFreshness === "fresh") {
    freshnessValue = "Fresh";
    freshnessHint = "Every tracked job ran on schedule";
  }

  let emailValue = "—";
  let emailHint = sourceErrors.emailDelivery ? "Email delivery data unavailable" : "Loading…";
  if (emailDelivery) {
    emailValue = health === "unknown" ? "Unknown" : `${failedCount ?? 0} failed (24h)`;
    emailHint = health === "degraded"
      ? "SMTP failure rate elevated"
      : health === "unknown"
      ? "Not enough recent sends to judge"
      : `Failure rate: ${failureRate == null ? "—" : `${failureRate}%`}`;
  }

  return (
    <div className="min-w-0 max-w-full overflow-x-hidden bg-[#F8FAFC] p-4 text-slate-900 sm:p-6 lg:p-8">
      <style>{DASHBOARD_STYLES}</style>

      {activeTab === "readiness" ? (
        <LaunchReadinessPage />
      ) : (
        <div className="mx-auto max-w-[1440px] space-y-8">

          {/* ── Hero: navy command banner ── */}
        <div className={`pd-rise relative overflow-hidden rounded-[2rem] ${NAVY_SURFACE} p-6 text-white shadow-[0_20px_50px_-20px_rgba(15,23,42,0.55)] sm:p-8`}>
          {/* Decorative depth — purely visual. */}
          <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-white/10 blur-3xl" aria-hidden="true" />
          <div className="pointer-events-none absolute -bottom-28 left-1/3 h-72 w-72 rounded-full bg-blue-400/20 blur-3xl" aria-hidden="true" />

          <div className="relative flex flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-white/80">
                  {greeting()} · {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
                </p>
                <h1 className="mt-1 text-3xl font-extrabold tracking-tight sm:text-4xl">Command Center</h1>
                <p className="mt-1 max-w-xl text-sm text-white/80">One pane across attention, safety, performance, and domain health.</p>
              </div>
              <div className="flex flex-col items-start gap-2 sm:items-end">
                <span
                  role="status"
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ${
                    statusTone === "critical" ? "bg-rose-500/90 text-white" : "bg-white/15 text-white"
                  }`}
                >
                  <span className="relative flex h-2.5 w-2.5">
                    {statusTone !== "neutral" && (
                      <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 motion-reduce:hidden ${statusTone === "critical" ? "bg-white" : "bg-emerald-300"}`} />
                    )}
                    <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${statusTone === "critical" ? "bg-white" : statusTone === "ok" ? "bg-emerald-300" : "bg-white/60"}`} />
                  </span>
                  {statusLabel}
                </span>
                <span className="text-[11px] font-medium text-white/70">{syncLabel}</span>
                <div className="flex items-center gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-medium text-white/90">
                    <input type="checkbox" checked={autoPoll} onChange={(event) => setAutoPoll(event.target.checked)} className="h-3.5 w-3.5 rounded bg-white/20 border-white/30 accent-blue-300" />
                    Auto-poll
                  </label>
                  <button
                    type="button"
                    onClick={handleRefreshClick}
                    disabled={justRefreshed}
                    className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/90 transition hover:bg-white/20 disabled:opacity-60"
                  >
                    <RefreshCw size={13} className={justRefreshed ? "animate-spin" : ""} />
                    {justRefreshed ? "Refreshing" : "Refresh data"}
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm transition hover:bg-white/15">
                <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/75">
                  <Crosshair size={14} /> Critical incidents
                </span>
                <span className="mt-2 block text-3xl font-extrabold tracking-tight text-white" data-testid="hero-critical">{display(criticalOpen)}</span>
                <span className="mt-0.5 block truncate text-[11px] text-white/70">P0/P1 items in the attention queue</span>
              </div>
              <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm transition hover:bg-white/15">
                <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/75">
                  <Activity size={14} /> Open attention items
                </span>
                <span className="mt-2 block text-3xl font-extrabold tracking-tight text-white" data-testid="hero-open">{display(totalOpen)}</span>
                <span className="mt-0.5 block truncate text-[11px] text-white/70">All severities</span>
              </div>
              <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm transition hover:bg-white/15">
                <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/75">
                  <ShieldCheck size={14} /> Breakers engaged
                </span>
                <span className="mt-2 block text-3xl font-extrabold tracking-tight text-white" data-testid="hero-engaged">{display(engaged)}</span>
                <span className="mt-0.5 block truncate text-[11px] text-white/70">Billing paths currently paused</span>
              </div>
              <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm transition hover:bg-white/15">
                <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/75">
                  <Activity size={14} /> API P95
                </span>
                <span className="mt-2 block text-3xl font-extrabold tracking-tight text-white">{p95 == null ? "—" : `${p95.toLocaleString()} ms`}</span>
                <span className="mt-0.5 block truncate text-[11px] text-white/70">
                  {telemetry && p95 == null ? "No requests in the window yet" : budget == null ? "Budget unavailable" : `Budget ${budget.toLocaleString()} ms`}
                </span>
              </div>
            </div>
          </div>
        </div>

        {sourceErrorCount > 0 && (
          <p role="alert" className="pd-rise flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs font-medium text-amber-800" style={{ animationDelay: "300ms" }}>
            <AlertTriangle size={14} className="shrink-0" />
            <span className="flex-1">
              {sourceErrorCount} data source{sourceErrorCount > 1 ? "s" : ""} couldn't be reached — the affected panels show what was last loaded (or "—").
            </span>
            <button type="button" onClick={handleRefreshClick} className="shrink-0 font-semibold underline hover:text-amber-900">
              Retry
            </button>
          </p>
        )}

        {/* ── Live status strip ── */}
        <Section
          title="Live status"
          subtitle="Real-time state across attention, safety, performance and delivery"
          icon={Activity}
          delay={80}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <KpiTile
              icon={Crosshair}
              tone={totalOpen == null ? "slate" : "blue"}
              label="Attention Queue"
              value={totalOpen == null ? "—" : `${totalOpen} open`}
              hint={totalOpen == null && sourceErrors.triage ? "Attention queue unavailable" : "Severity-ranked incidents and signals"}
              onClick={() => navigate("/super-admin/triage")}
              delay={100}
            />
            <KpiTile
              icon={ShieldCheck}
              tone={engaged == null ? "slate" : engaged > 0 ? "amber" : "emerald"}
              label="Safety Controls"
              value={engaged == null ? "—" : engaged > 0 ? `${engaged} engaged` : "None engaged"}
              hint={engaged == null ? "Breaker state unavailable" : engaged > 0 ? "Some billing paths are paused" : "All billing paths running"}
              onClick={() => navigate("/super-admin/kill-switch")}
              delay={140}
            />
            <KpiTile
              icon={Activity}
              tone={p95 == null ? "slate" : overBudget ? "red" : "emerald"}
              label="API Performance"
              value={p95 == null ? "—" : `${p95.toLocaleString()} ms`}
              hint={
                p95 == null
                  ? telemetry ? "No requests measured yet" : sourceErrors.api ? "Telemetry unavailable" : "Loading…"
                  : overBudget ? "P95 exceeds budget" : "P95 within budget"
              }
              onClick={() => navigate("/super-admin/reliability")}
              delay={180}
            />
            <KpiTile
              icon={Mail}
              tone={!emailDelivery || health === "unknown" ? "slate" : health === "degraded" ? "red" : "emerald"}
              label="Email Delivery"
              value={emailValue}
              hint={emailHint}
              onClick={() => navigate("/super-admin/email-delivery")}
              delay={220}
            />
            <KpiTile
              icon={RefreshCw}
              tone={worstFreshness === "stale" ? "amber" : worstFreshness === "fresh" ? "emerald" : "slate"}
              label="Job Freshness"
              value={freshnessValue}
              hint={freshnessHint}
              onClick={() => navigate("/super-admin/integrations/jobs")}
              delay={260}
            />
          </div>
        </Section>

        {/* ── Command lenses ── */}
        <Section
          title="Command lenses"
          subtitle="Route to the authoritative lens for each domain"
          icon={Crosshair}
          delay={320}
        >
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {LENSES.map((lens, index) => {
              const Icon = lens.icon;
              return (
                <Link
                  key={lens.lensKey}
                  to={lens.href}
                  className="pd-rise group block rounded-3xl border border-slate-200/80 bg-white p-5 shadow-[0_4px_24px_rgba(15,23,42,0.04)] transition duration-200 hover:-translate-y-1 hover:border-brand-200 hover:shadow-[0_14px_30px_-12px_rgba(79,70,229,0.35)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                  style={{ animationDelay: `${320 + index * 40}ms` }}
                >
                  <div className="flex items-center justify-between mb-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                      <Icon size={17} aria-hidden="true" />
                    </span>
                    <ArrowRight size={16} className="shrink-0 text-slate-300 group-hover:text-brand-500 transition" aria-hidden="true" />
                  </div>
                  <h3 className="mt-2 text-sm font-bold text-slate-900 group-hover:text-brand-600 transition">{lens.name}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{lens.description}</p>
                </Link>
              );
            })}
          </div>
        </Section>

        </div>
      )}
    </div>
  );
}

// Entrance motion (fade + rise, staggered by inline animation-delay).
const DASHBOARD_STYLES = `
  @keyframes pd-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  .pd-rise { animation: pd-rise .5s cubic-bezier(.22,1,.36,1) both; }
  @media (prefers-reduced-motion: reduce) { .pd-rise { animation: none; } }
`;
