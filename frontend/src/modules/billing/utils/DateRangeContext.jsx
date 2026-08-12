import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "zoiko_billing_date_range";
const DEFAULT_RANGE = "last_30_days";

export const DASHBOARD_DATE_RANGE_OPTIONS = [
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

function toIso(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve a preset (or custom) date-range bucket into concrete ISO
 * date_from/date_to bounds, computed purely client-side so the same
 * vocabulary works against every backend endpoint that accepts
 * date_from/date_to (they all take precedence over any period enum).
 */
export function resolveDateRange(range, customStart, customEnd) {
  const today = new Date();
  const todayIso = toIso(today);

  switch (range) {
    case "today":
      return { date_from: todayIso, date_to: todayIso };
    case "yesterday": {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const yIso = toIso(yesterday);
      return { date_from: yIso, date_to: yIso };
    }
    case "last_7_days": {
      const start = new Date(today);
      start.setDate(start.getDate() - 6);
      return { date_from: toIso(start), date_to: todayIso };
    }
    case "last_30_days": {
      const start = new Date(today);
      start.setDate(start.getDate() - 29);
      return { date_from: toIso(start), date_to: todayIso };
    }
    case "this_month": {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      return { date_from: toIso(start), date_to: todayIso };
    }
    case "last_month": {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      return { date_from: toIso(start), date_to: toIso(end) };
    }
    case "this_quarter": {
      const quarterMonth = Math.floor(today.getMonth() / 3) * 3;
      const start = new Date(today.getFullYear(), quarterMonth, 1);
      return { date_from: toIso(start), date_to: todayIso };
    }
    case "financial_year": {
      // Organization fiscal window (April 1 - today, Indian convention).
      const fyStartYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
      const start = new Date(fyStartYear, 3, 1);
      return { date_from: toIso(start), date_to: todayIso };
    }
    case "this_year": {
      const start = new Date(today.getFullYear(), 0, 1);
      return { date_from: toIso(start), date_to: todayIso };
    }
    case "custom":
      return { date_from: customStart || undefined, date_to: customEnd || undefined };
    default:
      return { date_from: undefined, date_to: undefined };
  }
}

function loadPersisted() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (raw && typeof raw === "object" && raw.range) return raw;
  } catch (err) { console.error("[DateRange] Failed to parse persisted range:", err); }
  return { range: DEFAULT_RANGE, customStart: "", customEnd: "" };
}

let globalState = loadPersisted();
const listeners = new Set();

function persist(next) {
  globalState = next;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch (err) { console.error("[DateRange] Failed to persist range:", err); }
  listeners.forEach((fn) => fn(next));
}

/**
 * Shared, persisted date-range filter for every Billing dashboard.
 * Reads/writes a single module-wide bucket (range/customStart/customEnd)
 * so switching dashboards keeps the same selected range, and a page
 * remount (navigate away and back) restores the last selection.
 */
export function useBillingDateRange() {
  const [state, setState] = useState(globalState);

  useEffect(() => {
    const handler = (next) => setState(next);
    listeners.add(handler);
    return () => { listeners.delete(handler); };
  }, []);

  const setRange = useCallback((range) => {
    persist({ ...globalState, range });
  }, []);

  const setCustomStart = useCallback((customStart) => {
    persist({ ...globalState, customStart });
  }, []);

  const setCustomEnd = useCallback((customEnd) => {
    persist({ ...globalState, customEnd });
  }, []);

  const applyCustomRange = useCallback((customStart, customEnd) => {
    persist({ range: "custom", customStart, customEnd });
  }, []);

  const reset = useCallback(() => {
    persist({ range: DEFAULT_RANGE, customStart: "", customEnd: "" });
  }, []);

  const dateRange = resolveDateRange(state.range, state.customStart, state.customEnd);

  return {
    range: state.range,
    setRange,
    customStart: state.customStart,
    setCustomStart,
    customEnd: state.customEnd,
    setCustomEnd,
    applyCustomRange,
    dateRange,
    reset,
  };
}
