import React from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  Lock,
  RefreshCw,
} from "lucide-react";
import { Spinner } from "./billing-shared";

/**
 * ZB-SA-CMD-003 §13 — the module state system. Every Command Center module
 * must be able to say which of these states it is in, and this component is
 * the single shared rendering for them:
 *
 *   loading           — query in flight (first load only; refreshes never
 *                       flash this over good data)
 *   zero              — a TRUE ZERO from real data ("0 open items" is a
 *                       finding, never hidden)
 *   not_configured    — the capability genuinely has no backing data source
 *                       yet (SLOs, webhook telemetry) — never faked
 *   fresh             — data present and within its freshness threshold
 *   stale             — data present but older than its freshness threshold
 *   unknown           — the system cannot currently tell (empty DB,
 *                       telemetry reset) — UNKNOWN is never rendered as
 *                       healthy or as zero
 *   partial           — some sources answered, others failed
 *   error             — the module's own fetch failed (isolated: siblings
 *                       keep their own states)
 *   permission_denied — caller lacks the capability for this module
 */

export const MODULE_STATES = {
  loading: {
    label: "Loading…",
    className: "border-slate-200 bg-slate-50 text-slate-600",
    chipClassName: "bg-slate-100 text-slate-600",
  },
  zero: {
    label: "Zero",
    className: "border-emerald-200 bg-emerald-50/60 text-emerald-800",
    chipClassName: "bg-emerald-100 text-emerald-700",
  },
  not_configured: {
    label: "Not configured",
    className: "border-amber-300 bg-amber-50 text-amber-900",
    chipClassName: "bg-amber-100 text-amber-800",
  },
  fresh: {
    label: "Fresh",
    className: "border-emerald-200 bg-white text-slate-700",
    chipClassName: "bg-emerald-100 text-emerald-700",
  },
  stale: {
    label: "Stale",
    className: "border-amber-300 bg-amber-50/60 text-amber-900",
    chipClassName: "bg-amber-100 text-amber-800",
  },
  unknown: {
    label: "Unknown",
    className: "border-indigo-200 bg-indigo-50/50 text-indigo-900",
    chipClassName: "bg-indigo-100 text-indigo-700",
  },
  partial: {
    label: "Partial",
    className: "border-amber-300 bg-amber-50/60 text-amber-900",
    chipClassName: "bg-amber-100 text-amber-800",
  },
  error: {
    label: "Error",
    className: "border-red-200 bg-red-50/60 text-red-800",
    chipClassName: "bg-red-100 text-red-700",
  },
  permission_denied: {
    label: "Permission required",
    className: "border-indigo-200 bg-indigo-50/50 text-indigo-900",
    chipClassName: "bg-indigo-100 text-indigo-700",
  },
};

const STATE_ICONS = {
  not_configured: HelpCircle,
  zero: CheckCircle2,
  fresh: CheckCircle2,
  stale: AlertTriangle,
  unknown: HelpCircle,
  partial: AlertTriangle,
  error: AlertTriangle,
  permission_denied: Lock,
};

const DEFAULT_DETAIL = {
  loading: "Fetching live platform data.",
  zero: "Real data confirms: nothing matches. A true zero is a finding.",
  not_configured:
    "No backing data source exists for this module yet — reported honestly rather than faked.",
  fresh: "Data is present and within its freshness threshold.",
  stale: "Data is older than its freshness threshold — treat with caution.",
  unknown:
    "The system cannot currently determine a value. Unknown is never rendered as healthy or as zero.",
  partial: "Some underlying sources did not answer; shown figures cover only what did.",
  error: "This module's data fetch failed. Other modules are unaffected.",
  permission_denied:
    "Your platform role does not include the capability this module requires.",
};

export default function ModuleState({
  status = "unknown",
  title,
  detail,
  asOf,
  onRetry,
  compact = false,
  className = "",
}) {
  const meta = MODULE_STATES[status] || MODULE_STATES.unknown;
  const Icon = STATE_ICONS[meta.label === "Zero" ? "zero" : status] || STATE_ICONS.unknown;
  // undefined → fall back to the state's default explanation; an explicit
  // null or string is honored verbatim.
  const resolvedDetail = detail === undefined ? DEFAULT_DETAIL[status] || "" : detail;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-xl border ${meta.className} ${compact ? "px-3 py-2" : "px-4 py-3"} ${className}`}
    >
      <div className="flex items-center gap-2">
        {status === "loading" ? (
          <Spinner />
        ) : (
          React.createElement(Icon, { size: 14, "aria-hidden": "true" })
        )}
        <span className="text-sm font-semibold">{title || meta.label}</span>
        <span
          className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${meta.chipClassName}`}
        >
          {meta.label}
        </span>
      </div>
      {(resolvedDetail || asOf) && !compact && (
        <p className="mt-1 text-xs leading-relaxed opacity-80">
          {resolvedDetail}
          {resolvedDetail && asOf ? " " : ""}
          {asOf && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <Clock size={11} className="inline" aria-hidden="true" />
              {asOf}
            </span>
          )}
        </p>
      )}
      {onRetry && (status === "error" || status === "partial") && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 inline-flex items-center gap-1 rounded-lg border border-current/30 px-2 py-1 text-xs font-semibold hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <RefreshCw size={12} aria-hidden="true" /> Retry
        </button>
      )}
    </div>
  );
}

export function ModuleStateChip({ status }) {
  const meta = MODULE_STATES[status] || MODULE_STATES.unknown;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${meta.chipClassName}`}
    >
      {meta.label}
    </span>
  );
}
