import { createElement, useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

/**
 * Background live refresh for the Financial Operations hub tabs.
 *
 *   const { lastUpdated, refreshing, refreshError, refresh, hasLoaded } =
 *     useLiveRefresh(load, { intervalMs: 45000, enabled: true, paused: false });
 *
 * `load(signal)` performs the fetch and applies the result itself; it must
 * return a promise and should skip its setState calls when `signal.aborted`
 * is true. The hook aborts the previous in-flight load whenever a newer one
 * starts (and on unmount), so a slow, out-of-order response can never
 * overwrite fresher data.
 *
 * - The first load runs on mount (when `enabled`).
 * - The interval ticks only while `document.visibilityState === "visible"`;
 *   returning to the page (visibilitychange → visible, or window focus)
 *   refreshes immediately unless a load finished in the last few seconds.
 * - `paused` (e.g. a mutation in flight) suppresses the timer and the
 *   focus refresh; an explicit `refresh()` call always runs, so callers
 *   refresh straight after their mutation settles.
 * - A failed load keeps whatever the caller already has on screen; it only
 *   sets `refreshError`. Callers show a full error state when `!hasLoaded`
 *   and an inline "couldn't refresh" note otherwise (see LiveRefreshStatus).
 *
 * The timer and listeners are torn down on unmount, which is also what stops
 * a hub tab's refresh when another tab becomes active (the hub only mounts
 * the active tab).
 */
const FOCUS_REFRESH_MIN_GAP_MS = 5000;

function isDocumentVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export default function useLiveRefresh(load, { intervalMs = 45000, enabled = true, paused = false } = {}) {
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  // Refs so the timer/listeners always see the latest load/paused without
  // being torn down and re-armed on every render.
  const loadRef = useRef(load);
  loadRef.current = load;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const controllerRef = useRef(null);
  const lastFinishedRef = useRef(0);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setRefreshing(true);
    return Promise.resolve()
      .then(() => loadRef.current(controller.signal))
      .then(
        () => {
          if (controller.signal.aborted || !mountedRef.current) return;
          setLastUpdated(new Date());
          setRefreshError(null);
        },
        (err) => {
          if (controller.signal.aborted || !mountedRef.current) return;
          setRefreshError(err?.message || "Refresh failed.");
        }
      )
      .finally(() => {
        if (controller.signal.aborted || !mountedRef.current) return;
        lastFinishedRef.current = Date.now();
        controllerRef.current = null;
        setRefreshing(false);
        setHasLoaded(true);
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  // Initial load.
  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const backgroundRefresh = () => {
      if (pausedRef.current || controllerRef.current || !isDocumentVisible()) return;
      refresh();
    };
    const id = setInterval(backgroundRefresh, intervalMs);
    const onReturn = () => {
      if (!isDocumentVisible()) return;
      if (Date.now() - lastFinishedRef.current < FOCUS_REFRESH_MIN_GAP_MS) return;
      backgroundRefresh();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [enabled, intervalMs, refresh]);

  return { lastUpdated, refreshing, refreshError, refresh, hasLoaded };
}

function formatAgo(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function formatClock(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Small "Updated Xs ago · Refresh" stamp for a live tab. When the latest
 * background refresh failed (and older data is still on screen) it reads
 * "Couldn't refresh — showing data from HH:MM · Retry" instead.
 * Built with createElement so this module can stay a plain .js file.
 */
export function LiveRefreshStatus({ lastUpdated, refreshing, refreshError, onRefresh, className = "" }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const linkClass =
    "inline-flex items-center gap-1 rounded-md font-semibold text-brand-600 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 disabled:cursor-not-allowed disabled:opacity-60";
  const button = createElement(
    "button",
    { type: "button", onClick: () => onRefresh?.(), disabled: refreshing, className: linkClass },
    createElement(RefreshCw, { size: 12, className: refreshing ? "animate-spin" : "", "aria-hidden": "true" }),
    refreshError && lastUpdated ? "Retry" : refreshing ? "Refreshing…" : "Refresh"
  );

  let text;
  let tone = "text-slate-500";
  if (refreshError && lastUpdated) {
    text = `Couldn't refresh — showing data from ${formatClock(lastUpdated)}`;
    tone = "text-amber-700";
  } else if (lastUpdated) {
    text = `Updated ${formatAgo(now - lastUpdated.getTime())}`;
  } else {
    text = refreshing ? "Loading…" : "Not loaded yet";
  }

  return createElement(
    "div",
    {
      className: `flex flex-wrap items-center gap-2 text-[11px] ${tone} ${className}`,
      "data-testid": "live-refresh-status",
    },
    createElement("span", { role: refreshError && lastUpdated ? "status" : undefined }, text),
    createElement("span", { "aria-hidden": "true", className: "text-slate-300" }, "·"),
    button
  );
}
