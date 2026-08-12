import { Component, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle, AlertTriangle, Check, CheckCircle, Minus, RefreshCw, Search, Star, Clock, X, ChevronDown, Calendar, Download, ChevronRight, ChevronLeft, TrendingUp, TrendingDown, FileText, Sparkles } from "lucide-react";
import { AreaChart, Area, ResponsiveContainer } from "recharts";
import { formatCompactMoney, formatCompactNumber } from "../utils/billing-helpers";
import { ExecutiveSummary } from "./billing-ui";

export function formatLastUpdated(value, options = { hour: "2-digit", minute: "2-digit" }) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], options);
}

export function Spinner() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="h-8 w-8 rounded-full border-4 border-slate-200 border-t-brand animate-spin" />
    </div>
  );
}

export function SkeletonBlock({ className = "" }) {
  return <div className={`animate-pulse rounded-xl bg-slate-200/80 ${className}`} />;
}

export function PageSkeleton({ rows = 5 }) {
  return (
    <div className="space-y-4" aria-label="Loading content">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SkeletonBlock className="h-24" />
        <SkeletonBlock className="h-24" />
        <SkeletonBlock className="h-24" />
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <SkeletonBlock className="mb-4 h-10" />
        <div className="space-y-3">
          {Array.from({ length: rows }).map((_, idx) => <SkeletonBlock key={idx} className="h-12" />)}
        </div>
      </div>
    </div>
  );
}

export function SuccessMessage({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800" role="status" aria-live="polite">
      <CheckCircle size={18} className="mt-0.5 shrink-0" />
      <span className="flex-1">{message}</span>
      {onDismiss && <button type="button" onClick={onDismiss} className="text-emerald-600 hover:text-emerald-800" aria-label="Dismiss success message"><X size={16} /></button>}
    </div>
  );
}

export function ErrorState({ message, onRetry, title }) {
  const content = (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div className="h-16 w-16 rounded-full bg-red-100 text-red-600 flex items-center justify-center mb-4"><AlertCircle size={32} /></div>
      {title && <h3 className="text-xl font-bold text-slate-800 mb-2">{title}</h3>}
      <p className="text-sm text-slate-600 mb-6 max-w-md">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-1.5 px-6 py-3 bg-linear-to-r from-brand to-brand-hover text-white rounded-xl font-medium hover:shadow-lg">
          <RefreshCw size={18} /> Try Again
        </button>
      )}
    </div>
  );
  return content;
}

export function EmptyState({ icon: Icon, title, message, actionLabel, onAction }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center">
      {Icon && <Icon className="mb-3 h-10 w-10 text-slate-300" />}
      <p className="mb-1 text-sm font-semibold text-slate-700">{title}</p>
      {message && <p className="max-w-sm text-xs text-slate-500">{message}</p>}
      {actionLabel && onAction && (
        <button type="button" onClick={onAction} className="mt-4 inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-hover focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2">
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/**
 * Shared status pill — renders a colored badge from a per-page `options`
 * list of `{ value, label, color }`, matching the pattern most Billing list
 * pages already hand-roll locally. `icon` (a component) is optional.
 */
export function StatusBadge({ status, options, icon: Icon, fallbackColor = "bg-gray-100 text-gray-700" }) {
  const option = options?.find((o) => o.value === status);
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${option?.color || fallbackColor}`}>
      {Icon && <Icon size={12} />}
      {option?.label || status || "unknown"}
    </span>
  );
}

/**
 * Shared numbered pagination bar — the Prev/window-of-10/Next pattern used
 * identically across every Billing list page. `children` renders as the
 * left-side summary text (e.g. "42 total customer(s)") so each caller keeps
 * its own wording.
 */
export function Pagination({ page, totalPages, onPageChange, children }) {
  if (totalPages <= 1) return null;
  const safePage = Math.min(Math.max(1, page), totalPages);
  return (
    <div className="flex justify-between items-center px-6 py-4 border-t border-slate-100">
      <span className="text-xs text-slate-400">{children}</span>
      <div className="flex gap-1">
        <button onClick={() => onPageChange(Math.max(1, safePage - 1))} disabled={safePage <= 1}
          className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50 transition-colors">Prev</button>
        {Array.from({ length: Math.min(totalPages, 10) }, (_, i) => {
          const start = Math.max(1, Math.min(safePage - 5, totalPages - 9));
          const pageNum = start + i;
          if (pageNum > totalPages) return null;
          return (
            <button key={pageNum} onClick={() => onPageChange(pageNum)}
              className={`px-3 py-1.5 text-xs border rounded-lg transition-colors ${pageNum === safePage ? "bg-brand text-white border-brand" : "border-slate-200 hover:bg-slate-50"}`}>
              {pageNum}
            </button>
          );
        })}
        <button onClick={() => onPageChange(Math.min(totalPages, safePage + 1))} disabled={safePage >= totalPages}
          className="px-3 py-1.5 text-xs border border-slate-200 rounded-lg disabled:opacity-40 hover:bg-slate-50 transition-colors">Next</button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- *
 * Standard dashboard primitives — shared across every Billing dashboard
 * (Invoice Dashboard is the reference implementation these were lifted from)
 * ---------------------------------------------------------------------- */

export const DASHBOARD_KPI_GRID = "grid gap-5 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4";
export const DASHBOARD_CHART_GRID = "grid gap-6 xl:grid-cols-2 items-stretch";
export const DASHBOARD_CHART_GRID_3 = "grid gap-6 md:grid-cols-2 xl:grid-cols-3 items-stretch";
export const DASHBOARD_TIME_RANGES = ["week", "month", "quarter", "year"];

const DASHBOARD_DATE_RANGE_OPTIONS_DEFAULT = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7_days", label: "Last 7 Days" },
  { value: "last_30_days", label: "Last 30 Days" },
  { value: "this_month", label: "This Month" },
  { value: "last_month", label: "Last Month" },
  { value: "this_quarter", label: "This Quarter" },
  { value: "financial_year", label: "Financial Year" },
  { value: "custom", label: "Custom Range" },
];

/**
 * Single date-range selector — a compact dropdown that shows only the
 * currently selected preset ("Last 30 Days ▾") and expands to the full
 * preset list plus the custom start/end pickers. Replaces the old row of
 * mutually-exclusive buttons; props are unchanged so every caller keeps
 * working.
 */
export function DashboardDateRangeFilter({
  range,
  onRangeChange,
  customStart,
  customEnd,
  onApplyCustom,
  onResetCustom,
  options = DASHBOARD_DATE_RANGE_OPTIONS_DEFAULT,
  className = "",
}) {
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(customStart || "");
  const [draftEnd, setDraftEnd] = useState(customEnd || "");
  const containerRef = useRef(null);

  useEffect(() => { setDraftStart(customStart || ""); }, [customStart]);
  useEffect(() => { setDraftEnd(customEnd || ""); }, [customEnd]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = options.find((o) => o.value === range);
  const selectedLabel = selected?.label || (range === "custom" ? "Custom Range" : "All Time");

  const selectRange = (value) => {
    onRangeChange(value);
    if (value !== "custom") setOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select date range"
        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
      >
        <Calendar size={15} className="text-brand-500" />
        <span className="whitespace-nowrap">{selectedLabel}</span>
        <ChevronDown size={15} className={`text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div role="listbox" aria-label="Date range presets"
          className="absolute right-0 z-50 mt-2 w-60 rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={range === opt.value}
              onClick={() => selectRange(opt.value)}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                range === opt.value ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {opt.label}
              {range === opt.value && <Check size={14} className="text-brand-600" />}
            </button>
          ))}

          {range === "custom" && (
            <div className="mt-1 border-t border-slate-100 pt-2">
              <div className="flex items-center gap-1.5 px-1">
                <input type="date" value={draftStart} max={draftEnd || undefined} onChange={(e) => setDraftStart(e.target.value)}
                  className="w-full min-w-0 rounded-lg border border-slate-200 px-2 py-1.5 text-xs focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  aria-label="Custom range start date" />
                <span className="text-xs text-slate-400">to</span>
                <input type="date" value={draftEnd} min={draftStart || undefined} onChange={(e) => setDraftEnd(e.target.value)}
                  className="w-full min-w-0 rounded-lg border border-slate-200 px-2 py-1.5 text-xs focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
                  aria-label="Custom range end date" />
              </div>
              <div className="mt-2 flex items-center gap-1.5 px-1">
                <button type="button"
                  onClick={() => { if (onApplyCustom) { onApplyCustom(draftStart, draftEnd); setOpen(false); } }}
                  disabled={!draftStart || !draftEnd}
                  className="flex-1 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed">
                  Apply
                </button>
                <button type="button"
                  onClick={() => { setDraftStart(""); setDraftEnd(""); onResetCustom?.(); }}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50">
                  Reset
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DashboardHeader({
  title,
  subtitle,
  icon: Icon,
  iconGradient = "from-[#FF7A00] to-[#FF5500]",
  crumbs = [],
  primaryAction,
  lastUpdated,
  onRefresh,
  refreshing,
  onExportCSV,
  onExportJSON,
  onExportExcel,
  timeRange,
  onTimeRangeChange,
  timeRanges = DASHBOARD_TIME_RANGES,
  dateRange,
  onDateRangeChange,
  customStart,
  customEnd,
  onApplyCustomRange,
  onResetDateRange,
  dateRangeOptions,
}) {
  return (
    <div className="rounded-3xl bg-white border border-slate-200 p-6 md:p-8 shadow-[0_4px_20px_rgba(0,0,0,0.03)]">
      {crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1.5 text-xs font-medium text-slate-400">
          {crumbs.map((crumb, idx) => {
            const isLast = idx === crumbs.length - 1;
            return (
              <span key={crumb.label + idx} className="inline-flex items-center gap-1.5">
                {idx > 0 && <ChevronRight size={13} className="text-slate-300" />}
                {!isLast && crumb.href ? (
                  <a href={crumb.href} className="transition-colors hover:text-brand-600" onClick={(e) => e.preventDefault()}>
                    {crumb.label}
                  </a>
                ) : (
                  <span className={isLast ? "font-semibold text-slate-600" : ""}>{crumb.label}</span>
                )}
              </span>
            );
          })}
        </nav>
      )}
      <div className="flex flex-col gap-5 xl:flex-row xl:flex-nowrap xl:items-center xl:justify-between xl:gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            {Icon && (
              <div className={`h-10 w-10 rounded-2xl bg-gradient-to-r ${iconGradient} text-white flex items-center justify-center shadow-sm shrink-0`}>
                <Icon size={22} />
              </div>
            )}
            <div>
              <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight dark:text-white">{title}</h1>
              {subtitle && <p className="text-slate-500 text-sm mt-0.5 dark:text-slate-400">{subtitle}</p>}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 no-print xl:flex-nowrap xl:justify-end">
          {dateRange && onDateRangeChange ? (
            <DashboardDateRangeFilter
              range={dateRange}
              onRangeChange={onDateRangeChange}
              customStart={customStart}
              customEnd={customEnd}
              onApplyCustom={onApplyCustomRange}
              onResetCustom={onResetDateRange}
              options={dateRangeOptions}
              className="shrink-0 xl:min-w-40"
            />
          ) : timeRange && onTimeRangeChange ? (
            <div className="flex items-center gap-2 flex-wrap shrink-0">
              {timeRanges.map((range) => (
                <button key={range} onClick={() => onTimeRangeChange(range)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                    timeRange === range ? "bg-brand text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}>
                  {range.charAt(0).toUpperCase() + range.slice(1)}
                </button>
              ))}
            </div>
          ) : null}

          {onRefresh && (
            <button onClick={onRefresh} disabled={refreshing}
              className="shrink-0 px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-200 hover:bg-slate-100 text-slate-700 text-xs font-medium transition-colors disabled:opacity-50 flex items-center gap-1.5 shadow-sm"
              aria-label="Refresh dashboard">
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
              <span>Refresh</span>
            </button>
          )}

          <div className="relative shrink-0">
            <ExportMenu onExportCSV={onExportCSV} onExportJSON={onExportJSON} onExportExcel={onExportExcel} />
          </div>

          {primaryAction && <div className="shrink-0 whitespace-nowrap">{primaryAction}</div>}
        </div>
      </div>

      {formatLastUpdated(lastUpdated) && (
        <p className="mt-3 text-xs text-slate-400 no-print">
          <span className="font-medium text-slate-500">Updated:</span> {formatLastUpdated(lastUpdated)}
        </p>
      )}
    </div>
  );
}

/**
 * BusinessInsights — the "Business Insights" section every Billing
 * dashboard leads with, right under the header. Thin wrapper over
 * `ExecutiveSummary` (billing-ui.jsx) so every dashboard shares one
 * heading + pill-strip implementation instead of hand-rolling the section.
 * `items` is `[{ text, tone?: 'up'|'down'|'neutral'|'warning', icon? }]`
 * built from data the page already fetched — never a new API call.
 */
export function BusinessInsights({ items = [], title = "Business Insights" }) {
  if (!items.length) return null;
  return (
    <section aria-label={title} className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Sparkles size={14} className="text-brand-500" />
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">{title}</h2>
      </div>
      <ExecutiveSummary items={items} />
    </section>
  );
}

const ACTION_TONES = {
  danger: { icon: "text-red-600 bg-red-50 border-red-200", ring: "hover:border-red-300" },
  warning: { icon: "text-amber-600 bg-amber-50 border-amber-200", ring: "hover:border-amber-300" },
  neutral: { icon: "text-slate-500 bg-slate-100 border-slate-200", ring: "hover:border-slate-300" },
};

const PRIORITY_BADGES = {
  high: "bg-red-50 text-red-700 border-red-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  low: "bg-slate-100 text-slate-500 border-slate-200",
};

const PRIORITY_LABELS = { high: "High", medium: "Medium", low: "Low" };

const ActionCenterRow = memo(function ActionCenterRow({ icon: Icon = AlertTriangle, title, description, tone = "neutral", priority, href, actionLabel = "Review", onClick }) {
  const navigate = useNavigate();
  const handleClick = onClick || (href ? () => navigate(href) : undefined);
  const toneClasses = ACTION_TONES[tone] || ACTION_TONES.neutral;
  return (
    <div className={`flex items-center gap-3 rounded-2xl border border-transparent px-3 py-2.5 transition-colors ${toneClasses.ring} hover:bg-slate-50/70`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${toneClasses.icon}`}>
        <Icon size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-sm font-semibold text-slate-800" title={title}>
          <span className="truncate">{title}</span>
          {priority && (
            <span className={`shrink-0 inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${PRIORITY_BADGES[priority] || PRIORITY_BADGES.low}`}>
              {PRIORITY_LABELS[priority] || priority}
            </span>
          )}
        </p>
        {description && <p className="truncate text-xs text-slate-400" title={description}>{description}</p>}
      </div>
      {handleClick && (
        <button
          type="button"
          onClick={handleClick}
          className="shrink-0 inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-600 transition-colors hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
        >
          {actionLabel} <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
});

/**
 * ActionCenter — the "what needs my attention right now" section every
 * Billing dashboard leads with, right after Business Insights. Unlike
 * `BusinessInsights` (a pill-strip of narrative facts), this renders an
 * actionable row list, each linking to an existing filtered view — never
 * a new route. `items` must be built from data the page already fetched;
 * when a dashboard only has aggregate counts (not itemized records), each
 * row is still valid as a count + link (e.g. "3 credit notes awaiting
 * approval → Review"), it just isn't a per-record row.
 * `items`: `[{ icon, title, description?, tone?: 'danger'|'warning'|'neutral', priority?: 'high'|'medium'|'low', href, actionLabel? }]`
 */
export function ActionCenter({ title = "Action Center", items = [] }) {
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <AlertTriangle size={15} className="text-brand-500" />
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">{title}</h2>
        <span className="h-px flex-1 bg-slate-200/70" />
      </div>
      {items.length > 0 ? (
        <div className="divide-y divide-slate-100 rounded-3xl border border-slate-200 bg-white p-2 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          {items.map((item, idx) => (
            <ActionCenterRow key={item.title + idx} {...item} />
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-600">
            <CheckCircle size={16} />
          </span>
          <p className="text-sm font-medium text-slate-600">All caught up — nothing needs your attention right now.</p>
        </div>
      )}
    </section>
  );
}

/**
 * QuickActions — module-specific shortcut tiles, generalized from the
 * `QuickActionTile` pattern the main Billing dashboard introduced.
 * `actions` is `[{ icon, label, hint?, href }]`; every href must be an
 * existing route — this component only renders navigation, it never
 * introduces new routes.
 */
const QuickActionTile = memo(function QuickActionTile({ icon: Icon, label, hint, href, onClick }) {
  const navigate = useNavigate();
  const handleClick = onClick || (href ? () => navigate(href) : undefined);
  return (
    <button
      type="button"
      onClick={handleClick}
      className="group flex flex-col items-start gap-2.5 rounded-2xl border border-slate-200 bg-slate-50/60 p-4 text-left transition-all hover:border-brand/40 hover:bg-white hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-brand-500 shadow-sm transition-colors group-hover:border-brand group-hover:bg-brand group-hover:text-white">
        <Icon size={17} />
      </span>
      <span>
        <span className="block text-sm font-semibold text-slate-700">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-slate-400">{hint}</span>}
      </span>
    </button>
  );
});

export function QuickActions({ title = "Quick Actions", actions = [] }) {
  if (!actions.length) return null;
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">{title}</h2>
        <span className="h-px flex-1 bg-slate-200/70" />
      </div>
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 xl:grid-cols-4">
        {actions.map((action, idx) => (
          <QuickActionTile key={action.label + idx} {...action} />
        ))}
      </div>
    </section>
  );
}

export function DashboardStatCard({
  title,
  value,
  icon: Icon,
  color = "from-brand to-brand-hover",
  trend,
  trendValue,
  subtitle,
  href,
  onClick,
  currency,
  compact = true,
  sparkline,
}) {
  const navigate = useNavigate();
  const handleClick = onClick || (href ? () => navigate(href) : undefined);
  const interactive = Boolean(handleClick);

  const displayValue = useMemo(() => {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (!compact) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
      return currency ? formatCompactMoney(value, currency) : formatCompactNumber(value);
    }
    if (value === null || value === undefined || (typeof value === "number" && Number.isNaN(value))) {
      return "—";
    }
    return value;
  }, [value, compact, currency]);

  const fullValue = typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : value;
  const sparklineData = useMemo(
    () => (sparkline && sparkline.length > 1 ? sparkline.map((v, i) => ({ i, v })) : null),
    [sparkline]
  );

  return (
    <div
      className={`bg-white border border-slate-200 rounded-3xl p-5 transition-all shadow-[0_4px_20px_rgba(0,0,0,0.02)] min-w-0 h-full ${
        interactive ? "cursor-pointer hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-[0_8px_30px_rgba(0,0,0,0.08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50" : ""
      }`}
      onClick={handleClick}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={interactive ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleClick(); } } : undefined}
      aria-label={interactive ? `${title}: ${fullValue}` : undefined}
    >
      <div className="flex justify-between items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-slate-500 text-xs font-semibold uppercase tracking-wider truncate">{title}</p>
          <h3
            className="text-xl lg:text-2xl font-extrabold text-slate-800 mt-2 leading-tight truncate"
            title={fullValue}
          >
            {displayValue}
          </h3>
          {trend ? (
            <span
              title={trendValue}
              className={`inline-flex items-center gap-1 mt-2 text-xs font-semibold rounded-full px-2 py-0.5 border ${
                trend === "up"
                  ? "text-emerald-700 bg-emerald-50 border-emerald-200"
                  : trend === "down"
                  ? "text-red-700 bg-red-50 border-red-200"
                  : "text-slate-600 bg-slate-50 border-slate-200"
              }`}
            >
              {trend === "up" ? <TrendingUp size={12} /> : trend === "down" ? <TrendingDown size={12} /> : <Minus size={12} />}
              <span className="truncate">{trendValue}</span>
            </span>
          ) : subtitle ? (
            <p className="mt-2 text-xs text-slate-400 truncate">{subtitle}</p>
          ) : null}
        </div>
        <div className={`h-10 w-10 rounded-xl bg-linear-to-r ${color} text-white flex items-center justify-center shrink-0 ml-3 shadow-sm`}>
          <Icon size={20} />
        </div>
      </div>
      {sparklineData && (
        <div className="mt-3 h-8 w-full" aria-hidden="true">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={sparklineData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`sparkline-${title}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="currentColor" stopOpacity={0.25} className="text-brand-500" />
                  <stop offset="95%" stopColor="currentColor" stopOpacity={0} className="text-brand-500" />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="v" stroke="#FF7A00" strokeWidth={1.5} fill={`url(#sparkline-${title})`} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

export function DashboardStatCardSkeleton() {
  return (
    <div className="bg-white border border-slate-200 rounded-3xl p-5 animate-pulse h-full" aria-hidden="true">
      <div className="flex justify-between items-center">
        <div className="flex-1 min-w-0">
          <div className="h-3 bg-slate-200 rounded w-24 mb-3" />
          <div className="h-7 bg-slate-200 rounded w-32 mb-2" />
          <div className="h-3 bg-slate-200 rounded w-20" />
        </div>
        <div className="h-12 w-12 rounded-2xl bg-slate-200 shrink-0 ml-3" />
      </div>
    </div>
  );
}

export function DashboardChartCardSkeleton() {
  return (
    <div className="bg-white border border-slate-200 rounded-3xl p-6 animate-pulse h-full" aria-hidden="true">
      <div className="h-5 bg-slate-200 rounded w-40 mb-6" />
      <div className="h-64 bg-slate-100 rounded-lg" />
    </div>
  );
}

export class DashboardChartErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return (
        <div role="alert" aria-live={this.props.ariaLive || "polite"} className="flex flex-col items-center justify-center h-64 bg-slate-50/50 rounded-xl border border-slate-100 p-6 text-center">
          <FileText className="h-8 w-8 text-slate-300 mb-2" />
          <p className="text-slate-500 text-sm font-medium">No chart data available</p>
          <p className="text-slate-400 text-xs mt-1">Data will populate automatically when available</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export function DashboardChartCard({ title, children, className = "", action }) {
  return (
    <div className={`bg-white border border-slate-200 rounded-3xl p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)] h-full flex flex-col min-w-0 ${className}`}>
      <div className="flex items-center justify-between mb-6 gap-3">
        <h2 className="text-lg font-bold text-slate-800 truncate">{title}</h2>
        {action}
      </div>
      <div className="flex-1 min-w-0 min-h-0">{children}</div>
    </div>
  );
}

export function DashboardEmptyPanel({ title, message, icon: Icon = FileText, ctaText, onCtaClick, steps = [] }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[220px] py-8 px-4 bg-slate-50/70 rounded-2xl border border-slate-200/80 text-center">
      <div className="h-12 w-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mb-3 shadow-xs">
        <Icon className="h-6 w-6 text-slate-400" />
      </div>
      {title && <p className="text-slate-800 text-base font-bold mb-1">{title}</p>}
      <p className="text-slate-500 text-xs font-normal max-w-xs leading-relaxed mb-4">{message}</p>
      {(ctaText || steps.length > 0) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {ctaText && onCtaClick && (
            <button onClick={onCtaClick}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#FF7A00] hover:bg-[#FF5500] text-white text-xs font-semibold rounded-xl shadow-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2">
              {ctaText}
            </button>
          )}
          {steps.map((step) => {
            const StepIcon = step.icon;
            return (
              <button key={step.label} onClick={step.onClick}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-white border border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 text-xs font-semibold rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2">
                {StepIcon && <StepIcon size={13} className="text-slate-400" />}
                {step.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function exportDashboardToCsv(data, filename) {
  const flatten = (obj, prefix = "") => {
    let result = {};
    for (const [key, val] of Object.entries(obj)) {
      const k = prefix ? `${prefix}_${key}` : key;
      if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        Object.assign(result, flatten(val, k));
      } else {
        result[k] = Array.isArray(val) ? JSON.stringify(val) : val;
      }
    }
    return result;
  };
  const items = Array.isArray(data) ? data : [data];
  const flat = items.map(flatten);
  if (flat.length === 0) return;
  const headers = [...new Set(flat.flatMap(Object.keys))];
  const csv = [headers.join(","), ...flat.map((row) => headers.map((h) => `"${(row[h] ?? "").toString().replace(/"/g, '""')}"`).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function exportDashboardToJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

const FAVORITES_KEY = "zoiko_product_favorites";
const RECENT_KEY = "zoiko_product_recent";
const MAX_RECENT = 8;
const MAX_FAVORITES = 20;

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; }
}
function saveJson(key, data) { try { localStorage.setItem(key, JSON.stringify(data)); } catch {} }

export function useProductFavorites() {
  const [favorites, setFavorites] = useState(() => loadJson(FAVORITES_KEY, []));
  const toggle = useCallback((productId) => {
    setFavorites((prev) => {
      const next = prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId].slice(-MAX_FAVORITES);
      saveJson(FAVORITES_KEY, next);
      return next;
    });
  }, []);
  const isFavorite = useCallback((productId) => favorites.includes(productId), [favorites]);
  return { favorites, toggle, isFavorite };
}

export function useRecentProducts() {
  const [recent, setRecent] = useState(() => loadJson(RECENT_KEY, []));
  const add = useCallback((product) => {
    setRecent((prev) => {
      const filtered = prev.filter((p) => p.id !== product.id);
      const next = [{ id: product.id, name: product.name, default_price: product.default_price, currency: product.currency, product_type: product.product_type }, ...filtered].slice(0, MAX_RECENT);
      saveJson(RECENT_KEY, next);
      return next;
    });
  }, []);
  const clear = useCallback(() => { setRecent([]); saveJson(RECENT_KEY, []); }, []);
  return { recent, add, clear };
}

const PRODUCT_TYPE_BADGE_COLORS = {
  service: "bg-blue-100 text-blue-700", good: "bg-emerald-100 text-emerald-700",
  subscription: "bg-brand-100 text-brand-700", usage: "bg-amber-100 text-amber-700",
  retainer: "bg-indigo-100 text-indigo-700", other: "bg-slate-100 text-slate-600",
};

const PRODUCT_TYPE_FILTER_OPTIONS = [
  { value: "service", label: "Service" },
  { value: "good", label: "Product" },
  { value: "subscription", label: "Subscription" },
  { value: "usage", label: "Usage-Based" },
  { value: "retainer", label: "Retainer" },
  { value: "other", label: "Other" },
];

const ProductRow = memo(function ProductRow({ rowRef, product, selected, favorite, multiSelect, onActivate, onToggleFavorite, onArrowKey, formatPrice, showQuantityInput, quantity, onQuantityChange }) {
  const badge = PRODUCT_TYPE_BADGE_COLORS[product.product_type] || PRODUCT_TYPE_BADGE_COLORS.other;
  return (
    <button ref={rowRef} type="button"
      className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-inset ${selected ? "bg-brand-50" : "hover:bg-slate-50"}`}
      onClick={onActivate}
      onKeyDown={onArrowKey}
      role="option" aria-selected={selected}>
      {multiSelect && (
        <input type="checkbox" checked={selected} readOnly tabIndex={-1}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand/30 shrink-0 pointer-events-none" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-800 truncate">{product.name || `Product #${product.id}`}</span>
          {product.product_type && product.product_type !== "other" && (
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${badge}`}>{product.product_type}</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs font-semibold text-slate-700">{formatPrice(product)}</span>
          {product.code && <span className="text-[10px] text-slate-400">#{product.code}</span>}
        </div>
      </div>
      {multiSelect && showQuantityInput && selected && (
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <label className="text-[10px] text-slate-400" htmlFor={`qty-${product.id}`}>Qty</label>
          <input
            id={`qty-${product.id}`}
            type="number"
            min="1"
            step="1"
            value={quantity ?? 1}
            onChange={(e) => onQuantityChange(Math.max(1, Number(e.target.value) || 1))}
            onFocus={(e) => e.stopPropagation()}
            className="w-14 px-1.5 py-1 border border-slate-200 rounded-lg text-xs text-center focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </div>
      )}
      <span onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }} tabIndex={-1}
        className={`p-1 rounded-lg transition-colors shrink-0 ${favorite ? "text-amber-500" : "text-slate-300 hover:text-amber-400"}`}
        aria-label={favorite ? "Remove from favorites" : "Add to favorites"} role="button">
        <Star size={14} fill={favorite ? "currentColor" : "none"} />
      </span>
    </button>
  );
});

export function ProductSelector({
  onSelect,
  onSelectionChange,
  onAddSelected,
  fetchProducts,
  fetchProductById,
  fetchCategories,
  formatPrice: formatPriceProp,
  multiSelect = false,
  selectedProducts = [],
  invoiceCurrency = "",
  orgSettings = null,
  showCategoryFilter = true,
  showFavorites = true,
  showRecent = true,
  compact = false,
  placeholder = "Search products to add...",
  // Enterprise Bulk Selection additions (opt-in, default off — every prop
  // below preserves the exact pre-existing dropdown behavior when unset):
  mode = "dropdown", // "dropdown" (existing, unchanged) | "panel" (always-visible, for embedding in a modal)
  showTypeFilter = false,
  paginated = false,
  showQuantityInput = false,
  perPage = 20,
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [categories, setCategories] = useState([]);
  const [activeCategory, setActiveCategory] = useState("");
  const [activeType, setActiveType] = useState("");
  const [activeTab, setActiveTab] = useState("search");
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [quantities, setQuantities] = useState({});
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const rowRefs = useRef([]);
  const { favorites, toggle: toggleFavorite, isFavorite } = useProductFavorites();
  const { recent, add: addRecent, clear: clearRecent } = useRecentProducts();
  const isPanel = mode === "panel";

  const doFetchCategories = useCallback(async () => {
    if (!fetchCategories) return;
    try {
      const data = await fetchCategories({ per_page: 50 });
      const items = Array.isArray(data) ? data : data?.items || [];
      setCategories(items.filter((c) => c.is_active !== false && c.name));
    } catch {}
  }, [fetchCategories]);

  useEffect(() => {
    if (showCategoryFilter) doFetchCategories();
  }, [showCategoryFilter, doFetchCategories]);

  // Panel mode (the enterprise bulk picker) is meant to be browsable even
  // before typing a search term or picking a category/type — a dropdown
  // instance stays search/category-gated exactly as before.
  useEffect(() => {
    const timer = setTimeout(async () => {
      const term = searchTerm.trim();
      if (!isPanel && !term && !activeCategory && !activeType) { setResults([]); setSearching(false); return; }
      if (!fetchProducts) return;
      setSearching(true);
      try {
        const params = { per_page: paginated ? perPage : 20, is_active: true };
        if (term) params.search_term = term;
        if (activeCategory) params.category_id = activeCategory;
        if (activeType) params.product_type = activeType;
        if (paginated) params.page = page;
        const data = await fetchProducts(params);
        const items = Array.isArray(data) ? data : data?.items || [];
        setResults(items);
        if (paginated) {
          setTotalCount(Number(data?.total ?? items.length));
          setTotalPages(Math.max(1, Number(data?.pages ?? 1)));
        }
      } catch { setResults([]); }
      finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(timer);
  }, [searchTerm, activeCategory, activeType, page, paginated, perPage, fetchProducts, isPanel]);

  // Reset to page 1 whenever the search/category/type filters change so the
  // user isn't stranded on a page number that no longer has results.
  useEffect(() => {
    if (paginated) setPage(1);
  }, [searchTerm, activeCategory, activeType, paginated]);

  useEffect(() => {
    const handleClickOutside = (e) => { if (containerRef.current && !containerRef.current.contains(e.target)) setShowDropdown(false); };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const [favoriteProducts, setFavoriteProducts] = useState([]);
  useEffect(() => {
    if (favorites.length > 0 && showFavorites && fetchProductById) {
      Promise.all(favorites.map((id) => fetchProductById(id).catch(() => null)))
        .then((items) => setFavoriteProducts(items.filter(Boolean)));
    } else { setFavoriteProducts([]); }
  }, [favorites, showFavorites, fetchProductById]);

  const visibleList = useMemo(() => {
    if (activeTab === "favorites") return favoriteProducts;
    if (activeTab === "recent") return recent;
    return results;
  }, [activeTab, results, favoriteProducts, recent]);

  useEffect(() => { rowRefs.current = rowRefs.current.slice(0, visibleList.length); }, [visibleList.length]);

  const handleSingleAdd = useCallback((product) => {
    addRecent(product);
    onSelect?.(product);
    setSearchTerm("");
    setShowDropdown(false);
  }, [addRecent, onSelect]);

  const handleToggleSelect = useCallback((product) => {
    const exists = selectedProducts.some((p) => p.id === product.id);
    const next = exists ? selectedProducts.filter((p) => p.id !== product.id) : [...selectedProducts, product];
    onSelectionChange?.(next);
    if (!exists) addRecent(product);
  }, [selectedProducts, onSelectionChange, addRecent]);

  const handleActivate = useCallback((product) => {
    if (multiSelect) {
      handleToggleSelect(product);
      return;
    }
    if (activeTab === "recent" && fetchProductById) {
      fetchProductById(product.id).then((full) => handleSingleAdd(full || product)).catch(() => handleSingleAdd(product));
    } else {
      handleSingleAdd(product);
    }
  }, [multiSelect, activeTab, fetchProductById, handleSingleAdd, handleToggleSelect]);

  const handleSelectAllVisible = useCallback(() => {
    const merged = [...selectedProducts];
    visibleList.forEach((p) => { if (!merged.some((m) => m.id === p.id)) merged.push(p); });
    onSelectionChange?.(merged);
  }, [selectedProducts, visibleList, onSelectionChange]);

  const handleClearSelection = useCallback(() => onSelectionChange?.([]), [onSelectionChange]);

  const handleAddSelected = useCallback(() => {
    if (selectedProducts.length === 0) return;
    const payload = showQuantityInput
      ? selectedProducts.map((p) => ({ ...p, quantity: quantities[p.id] || 1 }))
      : selectedProducts;
    onAddSelected?.(payload);
    setSearchTerm("");
    setShowDropdown(false);
    if (showQuantityInput) setQuantities({});
  }, [selectedProducts, onAddSelected, showQuantityInput, quantities]);

  const formatPrice = useCallback((p) => {
    if (formatPriceProp) return formatPriceProp(p);
    const price = p.original_price || p.default_price || p.unit_price || 0;
    const currency = p.currency || invoiceCurrency || "USD";
    return `${currency} ${Number(price).toFixed(2)}`;
  }, [formatPriceProp, invoiceCurrency]);

  const focusRow = (index) => {
    const el = rowRefs.current[index];
    if (el) el.focus();
  };

  const handleRowArrowKey = (index) => (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); focusRow(Math.min(visibleList.length - 1, index + 1)); }
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (index === 0) inputRef.current?.focus();
      else focusRow(index - 1);
    } else if (e.key === "Escape") { e.preventDefault(); setShowDropdown(false); inputRef.current?.focus(); }
  };

  const renderRow = (p, i) => (
    <ProductRow key={p.id} rowRef={(el) => { rowRefs.current[i] = el; }} product={p}
      selected={selectedProducts.some((sp) => sp.id === p.id)} favorite={isFavorite(p.id)} multiSelect={multiSelect}
      onActivate={() => handleActivate(p)} onToggleFavorite={() => toggleFavorite(p.id)}
      onArrowKey={handleRowArrowKey(i)} formatPrice={formatPrice}
      showQuantityInput={showQuantityInput} quantity={quantities[p.id]}
      onQuantityChange={(q) => setQuantities((prev) => ({ ...prev, [p.id]: q }))} />
  );

  const noQueryYet = !isPanel && !searchTerm && !activeCategory && !activeType;

  const resultsInner = (
    <>
      {(showCategoryFilter && categories.length > 0) || showTypeFilter ? (
        <div className="border-b border-slate-100">
          {showCategoryFilter && categories.length > 0 && (
            <div className="flex items-center gap-1.5 px-3 py-2 overflow-x-auto">
              <button type="button" onClick={() => { setActiveCategory(""); setActiveTab("search"); }}
                className={`shrink-0 text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${!activeCategory ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
                All Categories
              </button>
              {categories.slice(0, 8).map((cat) => (
                <button key={cat.id} type="button"
                  onClick={() => { setActiveCategory(activeCategory === cat.id ? "" : cat.id); setActiveTab("search"); }}
                  className={`shrink-0 text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${activeCategory === cat.id ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
                  {cat.name}
                </button>
              ))}
            </div>
          )}
          {showTypeFilter && (
            <div className="flex items-center gap-1.5 px-3 py-2 overflow-x-auto">
              <button type="button" onClick={() => { setActiveType(""); setActiveTab("search"); }}
                className={`shrink-0 text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${!activeType ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
                All Types
              </button>
              {PRODUCT_TYPE_FILTER_OPTIONS.map((t) => (
                <button key={t.value} type="button"
                  onClick={() => { setActiveType(activeType === t.value ? "" : t.value); setActiveTab("search"); }}
                  className={`shrink-0 text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${activeType === t.value ? "bg-brand-100 text-brand-700" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {(showFavorites || showRecent) && !searchTerm && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-slate-100">
          <button type="button" onClick={() => setActiveTab("search")}
            className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${activeTab === "search" ? "bg-brand-100 text-brand-700" : "text-slate-500 hover:bg-slate-100"}`}>
            <Search size={10} /> Browse
          </button>
          {showFavorites && (
            <button type="button" onClick={() => setActiveTab("favorites")}
              className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${activeTab === "favorites" ? "bg-amber-100 text-amber-700" : "text-slate-500 hover:bg-slate-100"}`}>
              <Star size={10} fill={activeTab === "favorites" ? "currentColor" : "none"} /> Favorites
            </button>
          )}
          {showRecent && (
            <button type="button" onClick={() => setActiveTab("recent")}
              className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${activeTab === "recent" ? "bg-blue-100 text-blue-700" : "text-slate-500 hover:bg-slate-100"}`}>
              <Clock size={10} /> Recent
            </button>
          )}
        </div>
      )}

      <div className={isPanel ? "max-h-112 overflow-y-auto" : "max-h-64 overflow-y-auto"} role="listbox" aria-multiselectable={multiSelect}>
        {activeTab === "search" && noQueryYet && (
          <div className="px-3 py-4 text-center text-xs text-slate-400">Type to search products or select a category above</div>
        )}
        {activeTab === "search" && !noQueryYet && searching && (
          <div className="px-3 py-4 text-center text-xs text-slate-400">Searching...</div>
        )}
        {activeTab === "search" && !noQueryYet && !searching && results.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-slate-400">No products found</div>
        )}
        {activeTab === "search" && !searching && results.map((p, i) => renderRow(p, i))}

        {activeTab === "favorites" && favoriteProducts.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-slate-400">No favorite products yet. Star products to add them here.</div>
        )}
        {activeTab === "favorites" && favoriteProducts.map((p, i) => renderRow(p, i))}

        {activeTab === "recent" && recent.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-slate-400">No recently used products.</div>
        )}
        {activeTab === "recent" && recent.map((p, i) => renderRow(p, i))}
      </div>

      {paginated && activeTab === "search" && results.length > 0 && (
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-slate-100 text-xs text-slate-500">
          <span>{totalCount} product{totalCount === 1 ? "" : "s"} · page {page} of {totalPages}</span>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-200 font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed">
              <ChevronLeft size={12} /> Prev
            </button>
            <button type="button" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-slate-200 font-medium hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed">
              Next <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}

      {multiSelect && (
        <div className="px-3 py-2 border-t border-slate-100 bg-brand-50/50 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-brand-700">{selectedProducts.length} selected</span>
            <button type="button" onClick={handleSelectAllVisible} disabled={visibleList.length === 0}
              className="text-xs text-brand-600 hover:text-brand-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed">
              Select All ({visibleList.length})
            </button>
            <button type="button" onClick={handleClearSelection} disabled={selectedProducts.length === 0}
              className="text-xs text-slate-500 hover:text-slate-700 font-medium disabled:opacity-40 disabled:cursor-not-allowed">
              Clear Selection
            </button>
          </div>
          <button type="button" onClick={handleAddSelected} disabled={selectedProducts.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            Add Selected
          </button>
        </div>
      )}
    </>
  );

  return (
    <div ref={containerRef} className={isPanel ? "" : "relative"}>
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input ref={inputRef} type="search" value={searchTerm}
          onChange={(e) => { setSearchTerm(e.target.value); setShowDropdown(true); setActiveTab("search"); }}
          onFocus={() => setShowDropdown(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setShowDropdown(false);
            else if (e.key === "ArrowDown") { e.preventDefault(); focusRow(0); }
            else if (e.key === "Enter" && !multiSelect && results.length === 1) { e.preventDefault(); handleSingleAdd(results[0]); }
          }}
          placeholder={placeholder}
          className="w-full pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 bg-white"
          aria-label="Search products by name, SKU, code, or category" aria-expanded={showDropdown} aria-controls="product-selector-results" />
        {searching && <RefreshCw size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-brand-500 animate-spin" />}
        {!searching && searchTerm && (
          <button type="button" onClick={() => { setSearchTerm(""); setResults([]); }} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" aria-label="Clear search">
            <X size={14} />
          </button>
        )}
      </div>

      {isPanel ? (
        <div id="product-selector-results" className="mt-2 w-full bg-white border border-slate-200 rounded-xl overflow-hidden">
          {resultsInner}
        </div>
      ) : (
        showDropdown && (
          <div id="product-selector-results" className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
            {resultsInner}
          </div>
        )
      )}
    </div>
  );
}

// Enterprise Bulk Product Selection (Workflow B). A dedicated "Add Products /
// Services" entry point, additional to — never a replacement for — the
// existing inline Quick Add search box (Workflow A). Reuses ProductSelector
// for all search/filter/pagination/pricing-adjacent logic rather than
// duplicating it; this component only supplies the modal chrome and owns the
// in-progress selection state so callers just need `onAddSelected`.
export function BulkProductPickerModal({
  open,
  onClose,
  fetchProducts,
  fetchCategories,
  onAddSelected,
  formatPrice,
  invoiceCurrency = "",
  title = "Add Products / Services",
}) {
  const [selectedProducts, setSelectedProducts] = useState([]);

  if (!open) return null;

  const handleClose = () => { setSelectedProducts([]); onClose?.(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={handleClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <h2 className="text-lg font-bold text-slate-900">{title}</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Search the catalog, check the items you need, set quantities, then add them all as editable line items.
              {selectedProducts.length > 0 && <span className="ml-1 font-medium text-brand-600">{selectedProducts.length} selected</span>}
            </p>
          </div>
          <button type="button" onClick={handleClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="px-6 py-4 overflow-y-auto flex-1">
          <ProductSelector
            mode="panel"
            multiSelect
            paginated
            showTypeFilter
            showQuantityInput
            showFavorites={false}
            showRecent={false}
            perPage={20}
            selectedProducts={selectedProducts}
            onSelectionChange={setSelectedProducts}
            onAddSelected={(items) => { onAddSelected?.(items); setSelectedProducts([]); onClose?.(); }}
            fetchProducts={fetchProducts}
            fetchCategories={fetchCategories}
            formatPrice={formatPrice}
            invoiceCurrency={invoiceCurrency}
            placeholder="Search products or services by name, SKU, or category..."
          />
        </div>
      </div>
    </div>
  );
}

export function useConfirmationDialog() {
  const resolverRef = useRef(null);
  const [options, setOptions] = useState(null);

  const confirm = useCallback((nextOptions) => new Promise((resolve) => {
    resolverRef.current = resolve;
    setOptions({
      title: "Confirm action",
      message: "Are you sure you want to continue?",
      confirmLabel: "Confirm",
      cancelLabel: "Cancel",
      tone: "danger",
      ...nextOptions,
    });
  }), []);

  const close = useCallback((result) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  const ConfirmationDialog = options ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4" role="dialog" aria-modal="true" aria-labelledby="billing-confirm-title">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className={`mb-4 flex h-11 w-11 items-center justify-center rounded-full ${options.tone === "danger" ? "bg-red-100 text-red-600" : "bg-brand-100 text-brand-600"}`}>
          <AlertCircle size={22} />
        </div>
        <h2 id="billing-confirm-title" className="text-lg font-bold text-slate-900">{options.title}</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">{options.message}</p>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" onClick={() => close(false)}
            className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
            {options.cancelLabel}
          </button>
          <button type="button" onClick={() => close(true)}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors ${
              options.tone === "danger" ? "bg-red-600 hover:bg-red-700" : "bg-brand-600 hover:bg-brand-700"
            }`}>
            {options.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, ConfirmationDialog };
}

const DATE_RANGE_OPTIONS = [
  { value: "all_time", label: "All Time" },
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7_days", label: "Last 7 Days" },
  { value: "last_30_days", label: "Last 30 Days" },
  { value: "this_month", label: "This Month" },
  { value: "last_month", label: "Last Month" },
  { value: "this_quarter", label: "This Quarter" },
  { value: "this_year", label: "This Year" },
  { value: "custom", label: "Custom Range" },
];

export function DateRangeFilter({ value, onChange, customStart, customEnd, onCustomStartChange, onCustomEndChange, className = "" }) {
  const isCustom = value === "custom";
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <div className="relative">
        <Calendar size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <select value={value} onChange={(e) => onChange(e.target.value)}
          className="appearance-none rounded-lg border border-slate-200 bg-white pl-8 pr-8 py-2 text-xs font-medium text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100 cursor-pointer"
          aria-label="Date range">
          {DATE_RANGE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
        <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
      </div>
      {isCustom && (
        <>
          <input type="date" value={customStart || ""} onChange={(e) => onCustomStartChange?.(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100" aria-label="Start date" />
          <span className="text-xs text-slate-400">to</span>
          <input type="date" value={customEnd || ""} onChange={(e) => onCustomEndChange?.(e.target.value)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100" aria-label="End date" />
        </>
      )}
    </div>
  );
}

export function useDateRange(defaultRange = "all_time") {
  const [range, setRange] = useState(defaultRange);
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const value = useMemo(() => ({ range, customStart, customEnd }), [range, customStart, customEnd]);
  return { range, setRange, customStart, setCustomStart, customEnd, setCustomEnd, dateRange: value };
}

export function ExportMenu({ onExportCSV, onExportJSON, onExportExcel, className = "" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const hasAny = onExportCSV || onExportJSON || onExportExcel;
  if (!hasAny) return null;

  return (
    <div className={`relative ${className}`} ref={ref}>
      <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors" aria-label="Export data">
        <Download size={14} /> Export
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 w-40 bg-white border border-slate-200 rounded-xl shadow-lg py-1 overflow-hidden">
          {onExportCSV && (
            <button type="button" onClick={() => { onExportCSV(); setOpen(false); }} className="w-full px-4 py-2 text-xs text-slate-700 hover:bg-slate-50 text-left flex items-center gap-2">
              <span className="w-5 h-5 rounded bg-emerald-100 text-emerald-600 flex items-center justify-center text-[10px] font-bold">CSV</span> CSV
            </button>
          )}
          {onExportJSON && (
            <button type="button" onClick={() => { onExportJSON(); setOpen(false); }} className="w-full px-4 py-2 text-xs text-slate-700 hover:bg-slate-50 text-left flex items-center gap-2">
              <span className="w-5 h-5 rounded bg-blue-100 text-blue-600 flex items-center justify-center text-[10px] font-bold">JSON</span> JSON
            </button>
          )}
          {onExportExcel && (
            <button type="button" onClick={() => { onExportExcel(); setOpen(false); }} className="w-full px-4 py-2 text-xs text-slate-700 hover:bg-slate-50 text-left flex items-center justify-center gap-2">
              <span className="w-5 h-5 rounded bg-green-100 text-green-600 flex items-center justify-center text-[10px] font-bold">XLS</span> Excel
            </button>
          )}
        </div>
      )}
    </div>
  );
}
