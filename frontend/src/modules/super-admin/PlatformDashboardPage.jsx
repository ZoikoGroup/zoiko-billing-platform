import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  FileText,
  HelpCircle,
  Layers,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

import { useCommandCenter } from "../../context/CommandCenterContext";
import {
  listPlatformAuditLogs,
  getSaasCommercialReporting,
  listOrganizations,
} from "../../service/commercialService";
import { getTriageSummary, getFinancialOperationsSummary } from "../../service/commandCenterService";
import { DashboardChartErrorBoundary } from "../../components/billing-shared";
import usePolling from "../../hooks/usePolling";
import useDeferredLoad from "../../hooks/useDeferredLoad";
import { createRequestQueue } from "../../utils/requestQueue";
import {
  ORG_ACCOUNT_STATUS,
  ORG_ACCOUNT_STATUS_ORDER,
  OrgAccountStatusBadge,
  TrialProgressBar,
  formatTrialRemaining,
} from "./constants";

const POLL_INTERVAL_MS = 60000;
// Headline sources run first; below-the-fold sources are deferred and queued
// behind them. At most 6 requests are ever in flight.
const MAX_CONCURRENT_REQUESTS = 6;
const PRIORITY_HEADLINE = 100;
const PRIORITY_DEFERRED = 10;
// Organization cards shown on the dashboard; the full directory is one click away.
const ORG_CARD_LIMIT = 9;

// ── Small presentation helpers ───────────────────────────────────────────────

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

/** Counts a number up from its previous value — skipped for reduced motion. */
function useCountUp(target, duration = 700) {
  const [value, setValue] = useState(typeof target === "number" ? target : 0);
  const fromRef = useRef(0);
  useEffect(() => {
    if (typeof target !== "number" || !Number.isFinite(target)) return undefined;
    if (prefersReducedMotion() || typeof requestAnimationFrame === "undefined") {
      setValue(target);
      fromRef.current = target;
      return undefined;
    }
    const from = fromRef.current;
    const start = performance.now();
    let frame;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (t < 1) frame = requestAnimationFrame(step);
      else fromRef.current = target;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);
  return value;
}

function AnimatedNumber({ value }) {
  const shown = useCountUp(typeof value === "number" ? value : null);
  if (typeof value !== "number") return <>{value ?? "—"}</>;
  return <>{shown.toLocaleString()}</>;
}

function relativeTime(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return null;
  const minutes = Math.floor((Date.now() - ts) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const AVATAR_TONES = [
  "from-brand-500 to-indigo-500",
  "from-emerald-500 to-teal-500",
  "from-violet-500 to-fuchsia-500",
  "from-amber-500 to-orange-500",
  "from-sky-500 to-cyan-500",
  "from-rose-500 to-pink-500",
];

function initialsOf(name) {
  const words = (name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

function OrgAvatar({ name, seed, size = "h-11 w-11 text-sm" }) {
  const tone = AVATAR_TONES[Math.abs(Number(seed) || 0) % AVATAR_TONES.length];
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-2xl bg-linear-to-br font-bold text-white shadow-sm ${tone} ${size}`} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

const isTrial = (o) => o.account_status === "trial";

/** Higher = needs a Super Admin's eye sooner (cards are ordered by this). */
function attentionScore(o) {
  let score = 0;
  if ((o.open_incident_count || 0) > 0) score += 100 + o.open_incident_count;
  if (o.account_status === "past_due") score += 80;
  if (o.account_status === "suspended") score += 60;
  if (isTrial(o) && o.trial_ends_at) {
    const days = (new Date(o.trial_ends_at).getTime() - Date.now()) / 86400000;
    if (days <= 7) score += 50 - Math.max(0, days);
  }
  return score;
}

function PulseBlock({ className = "", innerRef }) {
  return <div ref={innerRef} className={`animate-pulse rounded-3xl border border-slate-200 bg-slate-100/70 ${className}`} aria-hidden="true" />;
}

/** Section wrapper: title row + staggered fade-up on first render. */
function Section({ title, subtitle, icon: Icon, action, delay = 0, children }) {
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
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
        {action}
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

function LinkButton({ onClick, children }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700 hover:underline">
      {children} <ArrowRight size={13} />
    </button>
  );
}

// ── Hero ──────────────────────────────────────────────────────────────────────

function HeroStat({ icon: Icon, label, value, hint }) {
  return (
    <div className="rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-sm transition hover:bg-white/15">
      <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-white/75">
        <Icon size={14} /> {label}
      </span>
      <span className="mt-2 block text-3xl font-extrabold tracking-tight text-white">
        <AnimatedNumber value={value} />
      </span>
      {hint && <span className="mt-0.5 block truncate text-[11px] text-white/70">{hint}</span>}
    </div>
  );
}

function Hero({ statusLabel, critical, lastUpdated, refreshing, onRefresh, stats }) {
  return (
    <div className="pd-rise relative overflow-hidden rounded-[2rem] bg-linear-to-br from-slate-950 via-blue-900 to-blue-700 p-6 text-white shadow-[0_20px_50px_-20px_rgba(15,23,42,0.55)] sm:p-8">
      {/* Decorative depth — purely visual. */}
      <div className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-white/10 blur-3xl" aria-hidden="true" />
      <div className="pointer-events-none absolute -bottom-28 left-1/3 h-72 w-72 rounded-full bg-blue-400/20 blur-3xl" aria-hidden="true" />
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{ backgroundImage: "radial-gradient(circle at 1px 1px, white 1px, transparent 0)", backgroundSize: "22px 22px" }}
        aria-hidden="true"
      />

      <div className="relative flex flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-white/80">
              {greeting()} · {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
            </p>
            <h1 className="mt-1 text-3xl font-extrabold tracking-tight sm:text-4xl">Platform Overview</h1>
            <p className="mt-1 max-w-xl text-sm text-white/80">Every organization on Zoiko Billing — accounts, plans, trials and platform health at a glance.</p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <span
              role="status"
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ${
                critical ? "bg-rose-500/90 text-white" : "bg-white/15 text-white"
              }`}
            >
              <span className="relative flex h-2.5 w-2.5">
                <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${critical ? "bg-white" : "bg-emerald-300"}`} />
                <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${critical ? "bg-white" : "bg-emerald-300"}`} />
              </span>
              {statusLabel}
            </span>
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/90 transition hover:bg-white/20"
            >
              <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} />
              {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Refresh"}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((s) => (
            <HeroStat key={s.label} {...s} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Organizations ─────────────────────────────────────────────────────────────

function StatusDonut({ counts, onSelect }) {
  const data = ORG_ACCOUNT_STATUS_ORDER.map((key) => ({ key, name: ORG_ACCOUNT_STATUS[key].label, value: counts?.[key] || 0, color: ORG_ACCOUNT_STATUS[key].hex }));
  const total = data.reduce((a, d) => a + d.value, 0);
  const visible = data.filter((d) => d.value > 0);
  return (
    <Card className="flex h-full flex-col">
      <h3 className="text-sm font-bold text-slate-800">Account status</h3>
      <p className="text-xs text-slate-500">All organizations by where their account stands</p>
      <div className="relative mx-auto mt-3 h-48 w-48" aria-label="Organizations by account status">
        <DashboardChartErrorBoundary>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={visible.length ? visible : [{ key: "none", name: "No organizations", value: 1, color: "#E2E8F0" }]}
                dataKey="value"
                innerRadius="68%"
                outerRadius="100%"
                paddingAngle={visible.length > 1 ? 3 : 0}
                stroke="none"
                onClick={(d) => d?.key && d.key !== "none" && onSelect(d.key)}
                className="cursor-pointer"
              >
                {(visible.length ? visible : [{ color: "#E2E8F0" }]).map((d, i) => (
                  <Cell key={i} fill={d.color} />
                ))}
              </Pie>
              {visible.length > 0 && <Tooltip formatter={(v, n) => [`${v} organization${v === 1 ? "" : "s"}`, n]} />}
            </PieChart>
          </ResponsiveContainer>
        </DashboardChartErrorBoundary>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-extrabold text-slate-900"><AnimatedNumber value={total} /></span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">organizations</span>
        </div>
      </div>
      <ul className="mt-4 space-y-1">
        {data.map((d) => (
          <li key={d.key}>
            <button
              type="button"
              onClick={() => onSelect(d.key)}
              className={`group flex w-full items-center justify-between rounded-xl px-2.5 py-1.5 text-left text-sm transition hover:bg-slate-50 ${d.value === 0 ? "opacity-50" : ""}`}
            >
              <span className="flex items-center gap-2 text-slate-700">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: d.color }} aria-hidden="true" />
                {d.name}
              </span>
              <span className="flex items-center gap-2">
                <span className="font-bold text-slate-900">{d.value}</span>
                <span className="w-9 text-right text-[11px] text-slate-400">{total ? Math.round((d.value / total) * 100) : 0}%</span>
                <ChevronRight size={13} className="text-slate-300 group-hover:text-slate-500" />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function OrgCard({ org, onOpen, index }) {
  const trial = isTrial(org) ? formatTrialRemaining(org.trial_ends_at, org.subscription_status, org.recovery_ends_at) : null;
  const active = org.active_users || 0;
  const totalUsers = org.total_users || 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="pd-rise group flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-4 text-left transition duration-200 hover:-translate-y-1 hover:border-brand-200 hover:shadow-[0_14px_30px_-12px_rgba(79,70,229,0.35)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      style={{ animationDelay: `${120 + index * 45}ms` }}
      aria-label={`Open ${org.organization_name}`}
    >
      <div className="flex items-start gap-3">
        <OrgAvatar name={org.organization_name} seed={org.id} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 break-words text-sm font-bold leading-snug text-slate-900" title={org.organization_name}>
            {org.organization_name}
          </p>
          <p className="truncate text-[11px] text-slate-400">
            {org.organization_code}
            {org.country ? ` · ${org.country}` : ""}
          </p>
        </div>
        <ChevronRight size={16} className="mt-1 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500" />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <OrgAccountStatusBadge value={org.account_status} />
        {org.subscription_plan_name || org.subscription_plan_code ? (
          <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
            {org.subscription_plan_name || org.subscription_plan_code}
          </span>
        ) : null}
        {(org.open_incident_count || 0) > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-600">
            <AlertTriangle size={11} /> {org.open_incident_count}
          </span>
        )}
      </div>

      <div className="mt-auto pt-3">
        {trial ? (
          <TrialProgressBar trial={trial} />
        ) : (
          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span className="flex items-center gap-1"><Users size={12} /> {active}/{totalUsers} users active</span>
            <span>{relativeTime(org.last_activity_at) ? `Active ${relativeTime(org.last_activity_at)}` : `Joined ${relativeTime(org.created_at) || "—"}`}</span>
          </div>
        )}
      </div>
    </button>
  );
}

function PlanMix({ orgs }) {
  const rows = useMemo(() => {
    const byPlan = new Map();
    for (const o of orgs) {
      const key = o.subscription_plan_name || o.subscription_plan_code || "No plan";
      byPlan.set(key, (byPlan.get(key) || 0) + 1);
    }
    return Array.from(byPlan, ([plan, count]) => ({ plan, count })).sort((a, b) => b.count - a.count);
  }, [orgs]);
  const max = Math.max(1, ...rows.map((r) => r.count));
  const tones = ["bg-brand-500", "bg-indigo-500", "bg-violet-500", "bg-sky-500", "bg-emerald-500", "bg-slate-400"];
  return (
    <Card className="h-full">
      <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Layers size={15} className="text-brand-600" /> Plan mix</h3>
      <p className="text-xs text-slate-500">Organizations per plan</p>
      {rows.length === 0 ? (
        <p className="mt-6 text-center text-xs text-slate-400">No organizations yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.slice(0, 6).map((r, i) => (
            <li key={r.plan}>
              <div className="flex items-center justify-between text-xs">
                <span className="truncate font-medium text-slate-700" title={r.plan}>{r.plan}</span>
                <span className="font-bold text-slate-900">{r.count}</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                <div className={`pd-bar h-full rounded-full ${r.plan === "No plan" ? "bg-slate-300" : tones[i % tones.length]}`} style={{ width: `${(r.count / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MiniList({ title, icon: Icon, emptyText, items }) {
  return (
    <Card className="h-full">
      <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Icon size={15} className="text-brand-600" /> {title}</h3>
      {items.length === 0 ? (
        <p className="mt-6 text-center text-xs text-slate-400">{emptyText}</p>
      ) : (
        <ul className="mt-3 space-y-1">{items}</ul>
      )}
    </Card>
  );
}

function MiniListRow({ org, detail, onOpen }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-slate-50">
        <OrgAvatar name={org.organization_name} seed={org.id} size="h-8 w-8 text-[11px]" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-slate-800" title={org.organization_name}>{org.organization_name}</span>
          <span className="block truncate text-[11px] text-slate-500">{detail}</span>
        </span>
        <ChevronRight size={14} className="shrink-0 text-slate-300 group-hover:text-slate-500" />
      </button>
    </li>
  );
}

// ── Billing & operations ─────────────────────────────────────────────────────

function KpiTile({ icon: Icon, tone, label, value, hint, onClick, delay }) {
  const tones = {
    brand: "from-brand-500 to-indigo-500",
    blue: "from-sky-500 to-blue-500",
    amber: "from-amber-400 to-orange-500",
    red: "from-rose-500 to-red-500",
    emerald: "from-emerald-500 to-teal-500",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="pd-rise group rounded-3xl border border-slate-200/80 bg-white p-5 text-left shadow-[0_4px_24px_rgba(15,23,42,0.04)] transition duration-200 hover:-translate-y-1 hover:shadow-[0_14px_30px_-12px_rgba(15,23,42,0.18)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className={`flex h-10 w-10 items-center justify-center rounded-2xl bg-linear-to-br text-white shadow-sm ${tones[tone]}`}>
        <Icon size={18} />
      </span>
      <span className="mt-4 block text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      <span className="mt-1 block text-2xl font-extrabold text-slate-900"><AnimatedNumber value={value} /></span>
      <span className="mt-0.5 flex items-center justify-between text-[11px] text-slate-500">
        <span className="truncate">{hint}</span>
        <ArrowRight size={13} className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500" />
      </span>
    </button>
  );
}

const SEVERITY_STYLES = {
  P0: "bg-red-600 text-white",
  P1: "bg-orange-500 text-white",
  P2: "bg-amber-400 text-slate-900",
  P3: "bg-slate-300 text-slate-800",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PlatformDashboardPage() {
  const navigate = useNavigate();
  const { requestRefresh, refreshTick, periodDateFrom, attentionCounts, worstFreshness } = useCommandCenter();

  const [triageData, setTriageData] = useState(null);
  const [finops, setFinops] = useState(null);
  const [mrr, setMrr] = useState(null);
  const [activity, setActivity] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [orgTotal, setOrgTotal] = useState(null);
  const [statusCounts, setStatusCounts] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [sourceErrors, setSourceErrors] = useState({});
  // Each source applies its own result as soon as it arrives; `ready[key]`
  // flips once that source has settled (success or failure).
  const [ready, setReady] = useState({});
  const [inFlight, setInFlight] = useState(0);
  const queueRef = useRef(null);
  if (queueRef.current === null) queueRef.current = createRequestQueue(MAX_CONCURRENT_REQUESTS);
  const seqRef = useRef({});
  const mountedRef = useRef(true);

  const activityDeferred = useDeferredLoad({ strategy: "visible" });
  const deferredRef = useRef({});
  deferredRef.current = { activity: activityDeferred.triggered };

  const firstTickRef = useRef(true);
  const loadAllRef = useRef(() => {});

  const startSource = useCallback((key) => {
    const defs = {
      orgs: [PRIORITY_HEADLINE, () => listOrganizations({ skip: 0, limit: 200 }), "Organizations unavailable", (v) => {
        setOrgs(v?.organizations || []);
        setOrgTotal(v ? v.total ?? (v.organizations || []).length : null);
        setStatusCounts(v?.status_counts || null);
      }],
      triage: [PRIORITY_HEADLINE, () => getTriageSummary(), "Triage unavailable", (v) => setTriageData(v)],
      finops: [PRIORITY_HEADLINE, () => getFinancialOperationsSummary(), "Financial operations unavailable", (v) => setFinops(v)],
      mrr: [PRIORITY_HEADLINE, () => getSaasCommercialReporting(), "Commercial reporting unavailable", (v) => setMrr(v?.mrr ?? null)],
      activity: [PRIORITY_DEFERRED, () => listPlatformAuditLogs({ limit: 8, date_from: periodDateFrom }), "Activity unavailable", (v) => setActivity(v ? v.logs || [] : null)],
    };
    const [priority, call, fallbackMessage, apply] = defs[key];
    const id = (seqRef.current[key] = (seqRef.current[key] || 0) + 1);
    setInFlight((n) => n + 1);
    return queueRef.current.run(call, { priority }).then(
      (v) => ({ v, message: null }),
      (e) => ({ v: null, message: e?.message || fallbackMessage }),
    ).then(({ v, message }) => {
      if (!mountedRef.current) return;
      setInFlight((n) => Math.max(0, n - 1));
      if (id !== seqRef.current[key]) return;
      apply(v);
      setLastUpdated(new Date());
      setSourceErrors((prev) => {
        if (message) return { ...prev, [key]: message };
        if (!(key in prev)) return prev;
        const { [key]: _cleared, ...rest } = prev;
        return rest;
      });
      setReady((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
    });
  }, [periodDateFrom]);

  const loadAll = useCallback(() => {
    const keys = ["orgs", "triage", "finops", "mrr"];
    if (deferredRef.current.activity) keys.push("activity");
    keys.forEach((k) => startSource(k));
  }, [startSource]);

  useEffect(() => {
    mountedRef.current = true;
    const queue = queueRef.current;
    return () => {
      mountedRef.current = false;
      queue.clear();
    };
  }, []);

  useEffect(() => { if (activityDeferred.triggered) startSource("activity"); }, [activityDeferred.triggered]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => { loadAllRef.current = loadAll; }, [loadAll]);

  usePolling(() => requestRefresh({ auto: true }), POLL_INTERVAL_MS);

  useEffect(() => {
    if (firstTickRef.current) {
      firstTickRef.current = false;
      return;
    }
    loadAllRef.current();
  }, [refreshTick]);

  // ── Derived values (every figure traces to a real backend signal) ──────
  const incidents = triageData?.incidents?.top_items || [];
  const pipeline = triageData?.pipeline_stages || [];
  const controls = triageData?.safety_controls || [];
  const schedulerEnabled = triageData?.scheduler_enabled ?? false;

  const p0 = triageData?.incidents?.counts?.p0 ?? 0;
  const p1 = triageData?.incidents?.counts?.p1 ?? 0;
  const criticalCount = attentionCounts ? (attentionCounts.p0 || 0) + (attentionCounts.p1 || 0) : p0 + p1;

  const totalInvoices = finops?.billings?.total_invoices ?? 0;
  const overdueCount = finops?.billings?.overdue_count ?? 0;
  const failedPayments = finops?.recovery?.failed_payments_count ?? 0;
  const consistency = finops?.consistency;
  const invoicesChecked = consistency?.total_invoices_checked ?? 0;
  const integrityState =
    consistency?.state === "VERIFIED" && invoicesChecked > 0 ? "VERIFIED" : consistency?.state === "FAILED" ? "FAILED" : "UNKNOWN";

  const sourceErrorCount = Object.keys(sourceErrors).length;
  const telemetryStale = worstFreshness === "stale" || worstFreshness === "unknown";

  const fleetTotal = statusCounts ? Object.values(statusCounts).reduce((a, b) => a + b, 0) : orgTotal;

  function formatMrr() {
    if (!mrr) return "—";
    if (mrr.state === "unknown") return "Unknown";
    if (mrr.state === "multi_currency") return `${mrr.currencies.length} currencies`;
    return Number(mrr.amount ?? 0).toLocaleString("en-US", {
      style: "currency",
      currency: mrr.currencies[0]?.currency || "USD",
      maximumFractionDigits: 0,
    });
  }

  const featuredOrgs = useMemo(
    () =>
      [...orgs]
        .sort((a, b) => attentionScore(b) - attentionScore(a) || new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .slice(0, ORG_CARD_LIMIT),
    [orgs]
  );
  const trialsEnding = useMemo(
    () => orgs.filter((o) => isTrial(o) && o.trial_ends_at).sort((a, b) => new Date(a.trial_ends_at) - new Date(b.trial_ends_at)).slice(0, 5),
    [orgs]
  );
  const newest = useMemo(
    () => [...orgs].filter((o) => o.created_at).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5),
    [orgs]
  );

  const openOrg = (id) => navigate(`/super-admin/organizations/${id}`);
  const openStatus = (status) => navigate(`/super-admin/organizations?status=${status}`);
  const r = ready;

  const statusLabel = criticalCount > 0
    ? `${criticalCount} critical incident${criticalCount === 1 ? "" : "s"} open`
    : sourceErrorCount > 0
    ? "Partial visibility"
    : "All systems operational";

  return (
    <div className="w-full max-w-full space-y-8 overflow-x-hidden pb-24">
      <style>{DASHBOARD_STYLES}</style>

      <Hero
        statusLabel={statusLabel}
        critical={criticalCount > 0}
        lastUpdated={lastUpdated}
        refreshing={inFlight > 0}
        onRefresh={() => requestRefresh({ auto: false })}
        stats={[
          { icon: Building2, label: "Organizations", value: r.orgs ? fleetTotal ?? 0 : "—", hint: "On the platform" },
          { icon: Sparkles, label: "On trial", value: r.orgs ? statusCounts?.trial ?? 0 : "—", hint: `${trialsEnding.filter((o) => (new Date(o.trial_ends_at) - Date.now()) / 86400000 <= 7).length} ending within 7 days` },
          { icon: CheckCircle2, label: "Paying", value: r.orgs ? statusCounts?.active ?? 0 : "—", hint: "Active subscriptions" },
          { icon: TrendingUp, label: "Run rate", value: r.mrr ? formatMrr() : "—", hint: "Monthly, from published prices" },
        ]}
      />

      {sourceErrorCount > 0 && (
        <p role="alert" className="flex items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs font-medium text-amber-800">
          <AlertTriangle size={14} /> {sourceErrorCount} data source{sourceErrorCount > 1 ? "s" : ""} couldn't be reached — the affected panels show what was last loaded.
        </p>
      )}

      <Section
        title="Organizations"
        subtitle="Who is on the platform and where each account stands"
        icon={Building2}
        delay={80}
        action={<LinkButton onClick={() => navigate("/super-admin/organizations")}>View all organizations</LinkButton>}
      >
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
          {!r.orgs ? <PulseBlock className="h-96" /> : <StatusDonut counts={statusCounts} onSelect={openStatus} />}
          <div className="xl:col-span-2">
            {!r.orgs ? (
              <PulseBlock className="h-96" />
            ) : featuredOrgs.length === 0 ? (
              <Card className="flex h-full flex-col items-center justify-center py-14 text-center">
                <Building2 size={32} className="text-slate-300" />
                <p className="mt-2 text-sm font-semibold text-slate-700">No organizations yet</p>
                <p className="text-xs text-slate-500">Organizations appear here as soon as they register.</p>
              </Card>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                  {featuredOrgs.map((org, i) => (
                    <OrgCard key={org.id} org={org} index={i} onOpen={() => openOrg(org.id)} />
                  ))}
                </div>
                {(fleetTotal ?? 0) > featuredOrgs.length && (
                  <p className="mt-3 text-center text-xs text-slate-500">
                    Showing the {featuredOrgs.length} that most need attention, then the newest, of {fleetTotal} organizations ·{" "}
                    <button type="button" onClick={() => navigate("/super-admin/organizations")} className="font-semibold text-brand-600 hover:underline">
                      see the full directory
                    </button>
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {!r.orgs ? <PulseBlock className="h-56" /> : <PlanMix orgs={orgs} />}
          {!r.orgs ? <PulseBlock className="h-56" /> : (
            <MiniList
              title="Trials ending soon"
              icon={Clock}
              emptyText="No organization is on a trial."
              items={trialsEnding.map((o) => (
                <MiniListRow
                  key={o.id}
                  org={o}
                  detail={formatTrialRemaining(o.trial_ends_at, o.subscription_status, o.recovery_ends_at)?.label}
                  onOpen={() => openOrg(o.id)}
                />
              ))}
            />
          )}
          {!r.orgs ? <PulseBlock className="h-56" /> : (
            <MiniList
              title="Newest organizations"
              icon={Sparkles}
              emptyText="No organizations yet."
              items={newest.map((o) => (
                <MiniListRow
                  key={o.id}
                  org={o}
                  detail={`Joined ${relativeTime(o.created_at) || "—"} · ${ORG_ACCOUNT_STATUS[o.account_status]?.label || "No plan"}`}
                  onOpen={() => openOrg(o.id)}
                />
              ))}
            />
          )}
        </div>
      </Section>

      <Section title="Billing health" subtitle="Invoices and payments across every tenant" icon={CreditCard} delay={160}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {!r.finops ? (
            [0, 1, 2, 3].map((i) => <PulseBlock key={i} className="h-40" />)
          ) : (
            <>
              <KpiTile icon={FileText} tone="blue" label="Invoices issued" value={totalInvoices} hint="Across all organizations" onClick={() => navigate("/super-admin/financial-operations")} delay={180} />
              <KpiTile icon={Clock} tone={overdueCount > 0 ? "red" : "emerald"} label="Overdue invoices" value={overdueCount} hint={overdueCount > 0 ? "Need collections follow-up" : "Everything is current"} onClick={() => navigate("/super-admin/financial-operations")} delay={220} />
              <KpiTile icon={CreditCard} tone={failedPayments > 0 ? "amber" : "emerald"} label="Failed payments" value={failedPayments} hint={`Dunning: ${finops?.recovery?.dunning_cycle_status || "not configured"}`} onClick={() => navigate("/super-admin/financial-operations")} delay={260} />
              <KpiTile
                icon={integrityState === "VERIFIED" ? ShieldCheck : integrityState === "FAILED" ? ShieldAlert : HelpCircle}
                tone={integrityState === "VERIFIED" ? "emerald" : integrityState === "FAILED" ? "red" : "amber"}
                label="Ledger integrity"
                value={integrityState === "VERIFIED" ? "Verified" : integrityState === "FAILED" ? "Failed" : "Unknown"}
                hint={`${invoicesChecked.toLocaleString()} invoices checked`}
                onClick={() => navigate("/super-admin/financial-operations")}
                delay={300}
              />
            </>
          )}
        </div>
      </Section>

      <Section title="Operations" subtitle="Incidents, safety controls and background processing" icon={Activity} delay={240}>
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
          {!r.triage ? <PulseBlock className="h-64 xl:col-span-2" /> : (
            <Card className="xl:col-span-2">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><AlertTriangle size={15} className="text-brand-600" /> Attention queue</h3>
                <LinkButton onClick={() => navigate("/super-admin/triage")}>Open triage</LinkButton>
              </div>
              {incidents.length === 0 ? (
                <div className="mt-4 flex items-center gap-3 rounded-2xl bg-linear-to-r from-emerald-50 to-teal-50 px-4 py-6 text-sm font-semibold text-emerald-800">
                  <CheckCircle2 size={20} className="shrink-0 text-emerald-500" /> Nothing needs attention — every monitored signal is within tolerance.
                </div>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100">
                  {incidents.slice(0, 5).map((item) => (
                    <li key={item.id}>
                      <button type="button" onClick={() => navigate("/super-admin/triage")} className="group flex w-full items-start gap-3 py-2.5 text-left">
                        <span className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${SEVERITY_STYLES[item.severity] || SEVERITY_STYLES.P3}`}>{item.severity}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-slate-800 group-hover:text-brand-700">{item.title}</span>
                          {item.description && <span className="block truncate text-xs text-slate-500">{item.description}</span>}
                        </span>
                        <ChevronRight size={14} className="mt-1 shrink-0 text-slate-300 group-hover:text-slate-500" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {!r.triage ? <PulseBlock className="h-64" /> : (
            <Card>
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Zap size={15} className="text-brand-600" /> Safety controls</h3>
                <LinkButton onClick={() => navigate("/super-admin/kill-switch")}>Manage</LinkButton>
              </div>
              {controls.length === 0 ? (
                <p className="mt-6 text-center text-xs text-slate-400">No circuit breakers loaded.</p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {controls.slice(0, 5).map((c) => (
                    <li key={c.scope} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2 text-xs">
                      <span className="min-w-0 truncate font-medium text-slate-700" title={c.display_name}>{c.display_name}</span>
                      <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${c.enabled ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${c.enabled ? "bg-emerald-500" : "bg-amber-500"}`} />
                        {c.enabled ? "Normal" : "Paused"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {!r.triage ? <PulseBlock className="h-56 xl:col-span-2" /> : (
            <Card className="xl:col-span-2">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><Activity size={15} className="text-brand-600" /> Processing pipeline</h3>
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${schedulerEnabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                  {schedulerEnabled ? "Scheduler active" : "Scheduler off"}
                </span>
              </div>
              {pipeline.length === 0 ? (
                <p className="mt-6 text-center text-xs text-slate-400">No background job has reported yet.</p>
              ) : (
                <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {pipeline.slice(0, 8).map((stage) => {
                    const stale = stage.freshness === "stale" || stage.freshness === "unknown";
                    const failed = stage.last_status === "failed" || (stage.failure_count_24h || 0) > 0;
                    const tone = stale ? "border-amber-200 bg-amber-50/60" : failed ? "border-red-200 bg-red-50/60" : "border-emerald-100 bg-emerald-50/40";
                    return (
                      <div key={stage.job_name} className={`rounded-2xl border p-3 ${tone}`}>
                        <span className="block truncate text-[11px] font-semibold text-slate-600" title={stage.job_name}>{stage.display_name || stage.job_name}</span>
                        <span className="mt-1 block text-xl font-extrabold text-slate-900">{stage.run_count_24h ?? 0}</span>
                        <span className="block text-[10px] text-slate-500">runs / 24h</span>
                        <span className={`mt-1 block text-[10px] font-bold ${stale ? "text-amber-700" : failed ? "text-red-600" : "text-emerald-600"}`}>
                          {stale ? "Stale" : failed ? `${stage.failure_count_24h} failed` : "Healthy"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          )}

          {!r.activity ? <PulseBlock innerRef={activityDeferred.ref} className="h-56" /> : (
            <Card>
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-bold text-slate-800"><FileText size={15} className="text-brand-600" /> Recent activity</h3>
                <LinkButton onClick={() => navigate("/super-admin/audit-logs")}>All</LinkButton>
              </div>
              {!activity || activity.length === 0 ? (
                <p className="mt-6 text-center text-xs text-slate-400">No platform events in this period.</p>
              ) : (
                <ol className="relative mt-3 space-y-3 border-l border-slate-200 pl-4">
                  {activity.slice(0, 6).map((log) => (
                    <li key={log.id} className="relative">
                      <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand-500" aria-hidden="true" />
                      <p className="text-xs text-slate-700">
                        <span className="font-semibold">{String(log.action).toLowerCase().replace(/_/g, " ")}</span>
                        <span className="text-slate-500"> · {log.entity_type}</span>
                      </p>
                      <p className="text-[11px] text-slate-400">
                        {log.actor_email || "System"} · {relativeTime(log.created_at)}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          )}
        </div>
      </Section>

      <p className="pd-rise flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-slate-400" style={{ animationDelay: "320ms" }}>
        <span className="inline-flex items-center gap-1">
          <span className={`h-1.5 w-1.5 rounded-full ${telemetryStale ? "bg-amber-400" : "bg-emerald-400"}`} />
          Background telemetry {telemetryStale ? "stale" : "fresh"}
        </span>
        <span>Auto-refreshes every minute</span>
      </p>
    </div>
  );
}

// Entrance motion (fade + rise, staggered by inline animation-delay) and the
// grow-in for plan-mix bars. Both are disabled for reduced-motion users.
const DASHBOARD_STYLES = `
  @keyframes pd-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @keyframes pd-grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  .pd-rise { animation: pd-rise .5s cubic-bezier(.22,1,.36,1) both; }
  .pd-bar { transform-origin: left; animation: pd-grow .8s cubic-bezier(.22,1,.36,1) both; }
  @media (prefers-reduced-motion: reduce) { .pd-rise, .pd-bar { animation: none; } }
`;
