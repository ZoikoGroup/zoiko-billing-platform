import { useEffect, useRef } from "react";

export const MAX_BACKOFF_MS = 5 * 60 * 1000;

const isVisible = () =>
  typeof document === "undefined" || document.visibilityState === "visible";

/**
 * Non-hook scheduler core. Returns { start, stop }.
 *  - pauses while the tab is hidden (no timers, no calls)
 *  - on becoming visible, runs once immediately if data is older than interval
 *  - never overlaps a pending run
 *  - doubles the delay (max 5 min) after consecutive failures, resets on success
 * `run` may return a promise; a rejection / thrown error counts as a failure.
 */
export function createPoller(run, intervalMs, { runImmediately = true, getRun } = {}) {
  let timer = null;
  let pending = false;
  let stopped = true;
  let failures = 0;
  let lastRunAt = 0;

  const call = () => (getRun ? getRun() : run);
  const delay = () => Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS);

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    clear();
    if (stopped || !isVisible()) return;
    timer = setTimeout(tick, delay());
  };

  async function tick() {
    timer = null;
    if (stopped || !isVisible()) return;
    if (pending) {
      schedule();
      return;
    }
    pending = true;
    lastRunAt = Date.now();
    try {
      await call()();
      failures = 0;
    } catch {
      failures += 1;
    } finally {
      pending = false;
      lastRunAt = Date.now();
      schedule();
    }
  }

  const onVisibility = () => {
    if (stopped) return;
    if (!isVisible()) {
      clear();
      return;
    }
    if (pending) return; // schedule() runs when the pending call settles
    if (Date.now() - lastRunAt >= intervalMs) {
      tick();
    } else {
      schedule();
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibility);
      }
      if (runImmediately && isVisible()) {
        tick();
      } else {
        // Treat as fresh when the caller loads its own initial data.
        if (!runImmediately) lastRunAt = Date.now();
        schedule();
      }
    },
    stop() {
      stopped = true;
      clear();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    },
  };
}

/**
 * usePolling(fn, intervalMs, { enabled = true, runImmediately = false })
 * runImmediately defaults to false because callers here load their initial
 * data themselves; the poller only handles subsequent refreshes.
 */
export default function usePolling(fn, intervalMs, { enabled = true, runImmediately = false } = {}) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return undefined;
    const poller = createPoller(null, intervalMs, {
      runImmediately,
      getRun: () => (...args) => fnRef.current?.(...args),
    });
    poller.start();
    return () => poller.stop();
  }, [enabled, intervalMs, runImmediately]);
}

export { usePolling };
