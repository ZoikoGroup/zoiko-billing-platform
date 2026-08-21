/**
 * components/billing-ui.jsx
 * -------------------------
 * Enterprise UI primitives for the Zoiko Billing product. These are the
 * shared building blocks behind the premium SaaS redesign and implement the
 * design system defined in `index.css` (orange brand tokens, 8pt spacing,
 * consistent radius/shadow). Every Billing page should be composed from
 * these primitives so the whole product renders as one design language.
 *
 * Exports: Button, PageHeader, ExecutiveSummary, StatGroup, DataTable,
 *          Stepper, StickyFooter, Modal, SearchInput, Field, Select,
 *          ActivityTimeline, CommunicationHistory
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  Search,
  X,
  Check,
  Inbox,
  ArrowUp,
  ArrowDown,
  Mail,
  CreditCard,
  RotateCcw,
  Undo2,
  Ban,
  MessageSquare,
  FileCheck,
  RefreshCw,
  Clock,
  Paperclip,
} from "lucide-react";

/* ------------------------------------------------------------------ *
 * Button
 * ------------------------------------------------------------------ */

const BUTTON_VARIANTS = {
  primary:
    "bg-linear-to-r from-brand to-brand-hover text-white shadow-sm hover:shadow-lg border-transparent",
  secondary:
    "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:border-slate-300",
  ghost: "bg-transparent border-transparent text-slate-600 hover:bg-slate-100",
  danger: "bg-red-50 border border-red-200 text-red-700 hover:bg-red-100",
};

const BUTTON_SIZES = {
  sm: "px-3 py-1.5 text-xs gap-1.5 rounded-lg",
  md: "px-4 py-2.5 text-sm gap-2 rounded-xl",
};

export function Button({
  variant = "secondary",
  size = "md",
  icon: Icon,
  loading = false,
  children,
  className = "",
  ...rest
}) {
  return (
    <button
      type="button"
      disabled={loading || rest.disabled}
      className={`inline-flex items-center justify-center font-semibold transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${
        BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.secondary
      } ${BUTTON_SIZES[size] || BUTTON_SIZES.md} ${className}`}
      {...rest}
    >
      {loading ? (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : Icon ? (
        <Icon size={size === "sm" ? 14 : 16} />
      ) : null}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * PageHeader — breadcrumb + title + description + actions + meta
 * ------------------------------------------------------------------ */

export function PageHeader({
  crumbs = [],
  title,
  description,
  icon: Icon,
  actions,
  meta,
  className = "",
}) {
  return (
    <div className={`rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.03)] md:p-8 ${className}`}>
      {crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-1.5 text-xs font-medium text-slate-500">
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
        <div className="flex min-w-0 items-start gap-4">
          {Icon && (
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-linear-to-r from-brand to-brand-hover text-white shadow-sm">
              <Icon size={22} />
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-900">{title}</h1>
            {description && <p className="mt-1 max-w-2xl text-sm text-slate-500">{description}</p>}
          </div>
        </div>
        {actions}
      </div>
      {meta && <div className="mt-3 text-xs text-slate-500">{meta}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * ExecutiveSummary — intelligent insight strip
 * ------------------------------------------------------------------ */

const INSIGHT_TONES = {
  up: "bg-emerald-50 border-emerald-200 text-emerald-700",
  down: "bg-red-50 border-red-200 text-red-700",
  neutral: "bg-slate-50 border-slate-200 text-slate-600",
  warning: "bg-amber-50 border-amber-200 text-amber-700",
};

export function ExecutiveSummary({ items = [], className = "" }) {
  if (!items.length) return null;
  return (
    <section aria-label="Key insights" className={`rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)] ${className}`}>
      <div className="flex flex-wrap items-center gap-2.5">
        {items.map((item, idx) => {
          const Icon = item.icon || Check;
          const tone = INSIGHT_TONES[item.tone] || INSIGHT_TONES.neutral;
          return (
            <span key={idx} className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold ${tone}`}>
              <Icon size={14} className="shrink-0" />
              <span className="whitespace-nowrap">{item.text}</span>
            </span>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * StatGroup — sectioned KPI panels
 * ------------------------------------------------------------------ */

export function StatGroup({ title, icon: Icon, children, gridClass = "grid gap-5 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4" }) {
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        {Icon && <Icon size={15} className="text-brand-500" />}
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-600">{title}</h2>
        <span className="h-px flex-1 bg-slate-200/70" />
      </div>
      <div className={gridClass}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * DataTable — enterprise table
 * ------------------------------------------------------------------ */

const ALIGN_CLASSES = { left: "text-left", center: "text-center", right: "text-right" };

export function DataTable({
  columns = [],
  data = [],
  loading = false,
  loadingRows = 8,
  rowKey = (row, idx) => row?.id ?? idx,
  onRowClick,
  selectedKeys = [],
  onSelectionChange,
  bulkActions = [],
  sortKey,
  sortDir,
  onSort,
  emptyTitle = "No records found",
  emptyMessage = "No records match your current filters.",
  emptyIcon: EmptyIcon = Inbox,
  emptyAction,
  minWidth = 720,
  stickyHeader = true,
  striped = false,
  dense = false,
  className = "",
}) {
  const allSelected = data.length > 0 && data.every((row) => selectedKeys.includes(rowKey(row)));
  const someSelected = selectedKeys.length > 0 && !allSelected;

  const toggleAll = () => {
    if (!onSelectionChange) return;
    if (allSelected) onSelectionChange([]);
    else onSelectionChange(data.map((row) => rowKey(row)));
  };

  const toggleRow = (key) => {
    if (!onSelectionChange) return;
    onSelectionChange(
      selectedKeys.includes(key) ? selectedKeys.filter((k) => k !== key) : [...selectedKeys, key]
    );
  };

  const SortIcon = ({ col }) => {
    if (!col.sortable) return null;
    const active = sortKey === col.key;
    if (!active) return <ChevronsUpDown size={13} className="ml-1 text-slate-300" />;
    return sortDir === "asc" ? (
      <ArrowUp size={13} className="ml-1 text-brand-500" />
    ) : (
      <ArrowDown size={13} className="ml-1 text-brand-500" />
    );
  };

  return (
    <div className={`overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_4px_20px_rgba(0,0,0,0.02)] ${className}`}>
      {selectedKeys.length > 0 && bulkActions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-brand-100 bg-brand-50/60 px-4 py-2.5">
          <span className="text-xs font-semibold text-brand-700">{selectedKeys.length} selected</span>
          <span className="h-4 w-px bg-brand-200/70" />
          {bulkActions.map((action, idx) => (
            <Button key={idx} size="sm" variant="secondary" icon={action.icon} onClick={() => action.onClick(selectedKeys)}>
              {action.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" icon={X} onClick={() => onSelectionChange?.([])} aria-label="Clear selection">
            Clear
          </Button>
        </div>
      )}

      <div className={`overflow-x-auto ${stickyHeader ? "max-h-[560px] overflow-y-auto" : ""}`}>
        <table className="w-full text-left text-sm" aria-busy={loading}>
          <thead className={stickyHeader ? "sticky top-0 z-10" : ""}>
            <tr className="border-b border-slate-200 bg-slate-50/95 backdrop-blur text-xs uppercase tracking-wider text-slate-600">
              {onSelectionChange && (
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select all rows"
                    checked={allSelected}
                    ref={(el) => { if (el) el.indeterminate = someSelected; }}
                    onChange={toggleAll}
                    className="h-4 w-4 rounded border-slate-300 accent-brand"
                  />
                </th>
              )}
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  style={col.width ? { width: col.width } : undefined}
                  className={`whitespace-nowrap px-4 py-3 font-semibold ${ALIGN_CLASSES[col.align] || ALIGN_CLASSES.left} ${col.headerClassName || ""}`}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => onSort?.(col.key)}
                      className="inline-flex items-center gap-0.5 transition-colors hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
                      aria-label={`Sort by ${col.label}`}
                    >
                      {col.label}
                      <SortIcon col={col} />
                    </button>
                  ) : (
                    col.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: loadingRows }).map((_, i) => (
                  <tr key={`skeleton-${i}`} className="border-b border-slate-100 last:border-0" aria-hidden="true">
                    {onSelectionChange && <td className="px-4 py-3.5" />}
                    {columns.map((col) => (
                      <td key={col.key} className="px-4 py-3.5">
                        <div className="h-4 animate-pulse rounded-md bg-slate-200/80" style={{ width: `${60 + ((i * 7 + col.key.length * 13) % 34)}%` }} />
                      </td>
                    ))}
                  </tr>
                ))
              : data.length === 0
              ? (
                  <tr>
                    <td colSpan={(columns.length + (onSelectionChange ? 1 : 0))}>
                      <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
                        <EmptyIcon className="mb-3 h-10 w-10 text-slate-300" />
                        <p className="mb-1 text-sm font-semibold text-slate-700">{emptyTitle}</p>
                        {emptyMessage && <p className="max-w-sm text-xs text-slate-500">{emptyMessage}</p>}
                        {emptyAction && <div className="mt-4">{emptyAction}</div>}
                      </div>
                    </td>
                  </tr>
                )
              : data.map((row, idx) => {
                  const key = rowKey(row, idx);
                  const selected = selectedKeys.includes(key);
                  return (
                    <tr
                      key={key}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      className={`border-b border-slate-100 last:border-0 transition-colors ${
                        onRowClick ? "cursor-pointer hover:bg-slate-50/70" : "hover:bg-slate-50/40"
                      } ${striped && idx % 2 === 1 ? "bg-slate-50/40" : ""} ${selected ? "bg-brand-50/50" : ""}`}
                    >
                      {onSelectionChange && (
                        <td className="px-4 py-3.5">
                          <input
                            type="checkbox"
                            aria-label="Select row"
                            checked={selected}
                            onChange={() => toggleRow(key)}
                            onClick={(e) => e.stopPropagation()}
                            className="h-4 w-4 rounded border-slate-300 accent-brand"
                          />
                        </td>
                      )}
                      {columns.map((col) => (
                        <td
                          key={col.key}
                          className={`whitespace-nowrap px-4 text-slate-700 ${dense ? "py-2.5" : "py-3.5"} ${ALIGN_CLASSES[col.align] || ALIGN_CLASSES.left}`}
                        >
                          {col.render ? col.render(row, idx) : row[col.key]}
                        </td>
                      ))}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Stepper — multi-step wizard progress
 * ------------------------------------------------------------------ */

export function Stepper({ steps = [], current = 0, onSelect, className = "" }) {
  if (!steps.length) return null;
  return (
    <ol className={`flex items-center ${className}`} aria-label="Wizard progress">
      {steps.map((step, idx) => {
        const isDone = idx < current;
        const isActive = idx === current;
        const clickable = isDone && onSelect;
        return (
          <li key={step.key || step.label} className="flex flex-1 items-center last:flex-none">
            <button
              type="button"
              disabled={!clickable}
              onClick={clickable ? () => onSelect(idx) : undefined}
              className={`flex items-center gap-2.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 rounded-xl ${
                clickable ? "cursor-pointer hover:opacity-80" : "cursor-default"
              }`}
              aria-current={isActive ? "step" : undefined}
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold transition-all ${
                  isActive
                    ? "border-brand bg-brand text-white shadow-md"
                    : isDone
                    ? "border-brand-200 bg-brand-50 text-brand-600"
                    : "border-slate-200 bg-white text-slate-500"
                }`}
              >
                {isDone ? <Check size={14} /> : idx + 1}
              </span>
              <span className={`whitespace-nowrap text-sm font-semibold ${isActive ? "text-slate-900" : isDone ? "text-slate-600" : "text-slate-500"}`}>
                {step.label}
              </span>
            </button>
            {idx < steps.length - 1 && (
              <span className={`mx-3 h-px flex-1 ${idx < current ? "bg-brand-300" : "bg-slate-200"}`} aria-hidden="true" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ *
 * StickyFooter — fixed bottom action bar that reserves its own scroll
 * space. Renders an in-flow spacer sized to its own measured height (plus
 * a small breathing-room buffer) immediately before the fixed bar itself,
 * so whatever content precedes it in the page is never hidden underneath —
 * no per-page padding-bottom guesswork required.
 * ------------------------------------------------------------------ */

const STICKY_FOOTER_FALLBACK_HEIGHT = 96;
const STICKY_FOOTER_BREATHING_ROOM = 24;

export function StickyFooter({ children, className = "", contentClassName = "mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3" }) {
  const barRef = useRef(null);
  const [spacerHeight, setSpacerHeight] = useState(STICKY_FOOTER_FALLBACK_HEIGHT + STICKY_FOOTER_BREATHING_ROOM);

  useEffect(() => {
    const node = barRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect?.height;
      if (measured) setSpacerHeight(Math.ceil(measured) + STICKY_FOOTER_BREATHING_ROOM);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div aria-hidden="true" style={{ height: spacerHeight }} />
      <div
        ref={barRef}
        className={`fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-4px_24px_rgba(0,0,0,0.06)] backdrop-blur lg:left-72 ${className}`}
      >
        <div className={contentClassName}>{children}</div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Modal — consistent, accessible overlay
 * ------------------------------------------------------------------ */

const MODAL_SIZES = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null);
}

export function Modal({
  open,
  onClose,
  title,
  description,
  icon: Icon,
  children,
  footer,
  size = "md",
  closeOnBackdrop = true,
  ariaLabel,
}) {
  const panelRef = useRef(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    // Remember whatever had focus before the modal opened so it can be
    // restored on close (e.g. the "New Organization" button that triggered it).
    triggerRef.current = document.activeElement;

    const onKey = (e) => {
      if (e.key === "Escape") {
        onClose?.();
        return;
      }
      if (e.key !== "Tab") return;
      // Minimal focus trap: keep Tab/Shift+Tab cycling within the panel.
      const focusable = getFocusableElements(panelRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      if (triggerRef.current && typeof triggerRef.current.focus === "function") {
        triggerRef.current.focus();
      }
    };
  }, [open, onClose]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel || title}
    >
      <div
        className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
        onClick={closeOnBackdrop ? onClose : undefined}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl outline-none sm:rounded-3xl ${MODAL_SIZES[size] || MODAL_SIZES.md}`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-5">
          <div className="flex items-start gap-3">
            {Icon && (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                <Icon size={20} />
              </span>
            )}
            <div>
              <h2 className="text-lg font-bold text-slate-900">{title}</h2>
              {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-3 border-t border-slate-100 bg-slate-50/60 px-6 py-4">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ *
 * SearchInput — instant / debounced search
 * ------------------------------------------------------------------ */

export function SearchInput({ value, onChange, placeholder = "Search…", className = "", debounceMs = 300, ...rest }) {
  const [display, setDisplay] = useState(value ?? "");
  const first = useRef(true);

  useEffect(() => {
    if (value !== display) setDisplay(value ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!debounceMs) {
      onChange(display);
      return;
    }
    const t = setTimeout(() => onChange(display), debounceMs);
    return () => clearTimeout(t);
  }, [display, debounceMs]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`relative ${className}`}>
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
      <input
        type="search"
        value={display}
        onChange={(e) => setDisplay(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-8 text-sm text-slate-800 placeholder:text-slate-500 transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
        {...rest}
      />
      {display && (
        <button
          type="button"
          onClick={() => setDisplay("")}
          aria-label="Clear search"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 text-slate-500 hover:text-slate-600"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Field + Select — form primitives
 * ------------------------------------------------------------------ */

export function Field({ label, htmlFor, required, error, hint, children, className = "" }) {
  return (
    <div className={className}>
      {label && (
        <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-600">
          {label}
          {required && <span className="ml-0.5 text-red-500">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="mt-1.5 text-xs font-medium text-red-600" role="alert">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export function Select({ value, onChange, options = [], placeholder = "All", className = "", ...rest }) {
  return (
    <div className={`relative ${className}`}>
      <select
        value={value ?? ""}
        onChange={(e) => onChange?.(e.target.value)}
        className="w-full cursor-pointer appearance-none rounded-xl border border-slate-200 bg-white py-2.5 pl-3.5 pr-9 text-sm text-slate-700 transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
        {...rest}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-500" />
    </div>
  );
}

export { ChevronUp, ChevronDown };

/* ------------------------------------------------------------------ *
 * ActivityTimeline + CommunicationHistory — normalized enterprise
 * activity/communication feeds. Callers map their own already-fetched
 * data (status history, a timeline API, audit logs, email history,
 * etc.) into the flat entry shapes below; these components own icon/
 * tone resolution, dedup, same-timestamp grouping, and the empty
 * state, so every detail page renders activity and communications the
 * same way instead of each re-implementing its own timeline markup.
 * ------------------------------------------------------------------ */

function formatTimelineTimestamp(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const TIMELINE_ICON_RULES = [
  [/email|reminder|open/, Mail],
  [/payment|paid/, CreditCard],
  [/refund/, RotateCcw],
  [/credit/, Undo2],
  [/write.?off|cancel|void/, Ban],
  [/note/, MessageSquare],
  [/creat|draft|sav/, FileCheck],
  [/status/, RefreshCw],
];

function resolveTimelineIcon(eventType = "") {
  const key = String(eventType).toLowerCase();
  const rule = TIMELINE_ICON_RULES.find(([pattern]) => pattern.test(key));
  return rule ? rule[1] : Clock;
}

const TIMELINE_TONE_RULES = [
  [/paid|delivered|allocated|approved|issued/, "bg-emerald-100 text-emerald-700 border-emerald-200"],
  [/sent|email|open/, "bg-blue-100 text-blue-700 border-blue-200"],
  [/overdue|failed|bounced|rejected/, "bg-red-100 text-red-700 border-red-200"],
  [/reminder|partial/, "bg-amber-100 text-amber-700 border-amber-200"],
  [/cancel|void|write.?off/, "bg-slate-100 text-slate-600 border-slate-200"],
];

function resolveTimelineTone(status = "", eventType = "") {
  const key = String(status || eventType).toLowerCase();
  const rule = TIMELINE_TONE_RULES.find(([pattern]) => pattern.test(key));
  return rule ? rule[1] : "bg-brand-50 text-brand-700 border-brand-100";
}

/**
 * entries: Array<{ id, eventType, title, description, timestamp, actor,
 * status, recipient, amount }>. Newest first; entries sharing the exact
 * same timestamp render as one visual group.
 */
export function ActivityTimeline({ entries = [], emptyMessage = "No activity recorded yet." }) {
  const groups = useMemo(() => {
    const seen = new Set();
    const deduped = entries.filter((entry) => {
      if (!entry || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
    const sorted = [...deduped].sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
    const out = [];
    sorted.forEach((entry) => {
      const last = out[out.length - 1];
      if (last && entry.timestamp && last.timestamp === entry.timestamp) {
        last.items.push(entry);
      } else {
        out.push({ timestamp: entry.timestamp, items: [entry] });
      }
    });
    return out;
  }, [entries]);

  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-8 text-center">
        <Clock size={28} className="mx-auto mb-2 text-slate-300" />
        <p className="text-sm font-medium text-slate-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ol className="space-y-4">
      {groups.map((group, gi) => (
        <li key={group.timestamp || gi} className="space-y-2">
          {group.items.map((entry) => {
            const Icon = resolveTimelineIcon(entry.eventType);
            const tone = resolveTimelineTone(entry.status, entry.eventType);
            return (
              <div key={entry.id} className="flex items-start gap-3">
                <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${tone}`}>
                  <Icon size={14} />
                </span>
                <div className="min-w-0 flex-1 rounded-xl border border-slate-100 bg-white px-3.5 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-800">{entry.title}</p>
                    <span className="whitespace-nowrap text-xs text-slate-500">{formatTimelineTimestamp(entry.timestamp)}</span>
                  </div>
                  {entry.description && <p className="mt-0.5 text-xs text-slate-500">{entry.description}</p>}
                  {(entry.actor || entry.recipient || entry.amount !== undefined) && (
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
                      {entry.actor && <span>By {entry.actor}</span>}
                      {entry.recipient && <span>To {entry.recipient}</span>}
                      {entry.amount !== undefined && entry.amount !== null && entry.amount !== "" && <span>{entry.amount}</span>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </li>
      ))}
    </ol>
  );
}

const COMMUNICATION_STATUS_TONE = {
  delivered: "bg-emerald-100 text-emerald-700 border-emerald-200",
  sent: "bg-blue-100 text-blue-700 border-blue-200",
  opened: "bg-violet-100 text-violet-700 border-violet-200",
  failed: "bg-red-100 text-red-700 border-red-200",
  recorded: "bg-slate-100 text-slate-600 border-slate-200",
};

function resolveCommunicationTone(status) {
  return COMMUNICATION_STATUS_TONE[String(status || "").toLowerCase()] || COMMUNICATION_STATUS_TONE.recorded;
}

/**
 * entries: Array<{ id, type, recipient, subject, status, createdAt,
 * sentAt, deliveredAt, openedAt, failedAt, reminderNumber, attachments,
 * providerResponse, preview }>. Fields the backend doesn't populate are
 * simply omitted from the row rather than shown as empty placeholders.
 */
export function CommunicationHistory({ entries = [], emptyMessage = "No communications sent yet." }) {
  if (!entries || entries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 p-8 text-center">
        <Mail size={28} className="mx-auto mb-2 text-slate-300" />
        <p className="text-sm font-medium text-slate-500">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {entries.map((entry) => {
        const status = String(entry.status || "recorded").toLowerCase();
        const tone = resolveCommunicationTone(status);
        return (
          <li key={entry.id} className="rounded-xl border border-slate-100 bg-white p-3.5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${tone}`}>
                    {status}
                  </span>
                  <span className="text-xs font-medium text-slate-500">{entry.type || "Communication"}</span>
                  {entry.reminderNumber && (
                    <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                      Reminder #{entry.reminderNumber}
                    </span>
                  )}
                </div>
                <p className="mt-1 truncate text-sm font-semibold text-slate-800" title={entry.subject || ""}>{entry.subject || "—"}</p>
                <p className="text-xs text-slate-500">To {entry.recipient || "—"}</p>
              </div>
              <span className="whitespace-nowrap text-xs text-slate-500">{formatTimelineTimestamp(entry.createdAt)}</span>
            </div>

            {(entry.sentAt || entry.deliveredAt || entry.openedAt || entry.failedAt) && (
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                {entry.sentAt && <span>Sent {formatTimelineTimestamp(entry.sentAt)}</span>}
                {entry.deliveredAt && <span>Delivered {formatTimelineTimestamp(entry.deliveredAt)}</span>}
                {entry.openedAt && <span>Opened {formatTimelineTimestamp(entry.openedAt)}</span>}
                {entry.failedAt && <span className="font-medium text-red-600">Failed {formatTimelineTimestamp(entry.failedAt)}</span>}
              </div>
            )}

            {entry.preview && <p className="mt-2 text-xs text-slate-500">{entry.preview}</p>}
            {entry.providerResponse && (
              <p className="mt-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-500">Provider: {entry.providerResponse}</p>
            )}
            {Array.isArray(entry.attachments) && entry.attachments.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {entry.attachments.map((att, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">
                    <Paperclip size={11} /> {typeof att === "string" ? att : att?.name || `Attachment ${i + 1}`}
                  </span>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
