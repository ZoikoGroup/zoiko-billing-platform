import { useCallback, useEffect, useState } from "react";

/**
 * Run `cb` once the browser is idle (requestIdleCallback), or shortly after
 * first paint via setTimeout where it is unavailable. Returns a cancel fn.
 */
export function scheduleIdle(cb, { timeout = 2000, fallbackDelay = 100 } = {}) {
  if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(cb, { timeout });
    return () => {
      if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(id);
    };
  }
  const id = setTimeout(cb, fallbackDelay);
  return () => clearTimeout(id);
}

/**
 * useDeferredLoad({ strategy, rootMargin, enabled })
 *
 * Returns { ref, triggered, trigger }. `triggered` flips to true (and stays
 * true) when:
 *  - strategy "visible" (default): the element given `ref` scrolls into view
 *    (IntersectionObserver). Without IntersectionObserver it triggers at once.
 *  - strategy "idle": the browser is idle after first paint.
 *  - strategy "either": whichever happens first.
 * `ref` is a callback ref, so it works with conditionally rendered nodes.
 */
export default function useDeferredLoad({ strategy = "visible", rootMargin = "300px", enabled = true } = {}) {
  const [triggered, setTriggered] = useState(false);
  const [node, setNode] = useState(null);
  const trigger = useCallback(() => setTriggered(true), []);

  useEffect(() => {
    if (!enabled || triggered) return undefined;
    const cleanups = [];
    if (strategy === "idle" || strategy === "either") {
      cleanups.push(scheduleIdle(trigger));
    }
    if (strategy === "visible" || strategy === "either") {
      if (typeof IntersectionObserver === "undefined") {
        trigger();
      } else if (node) {
        const observer = new IntersectionObserver(
          (entries) => {
            if (entries.some((e) => e.isIntersecting)) {
              trigger();
              observer.disconnect();
            }
          },
          { rootMargin }
        );
        observer.observe(node);
        cleanups.push(() => observer.disconnect());
      }
    }
    return () => cleanups.forEach((fn) => fn());
  }, [enabled, triggered, strategy, rootMargin, node, trigger]);

  return { ref: setNode, triggered, trigger };
}

export { useDeferredLoad };
