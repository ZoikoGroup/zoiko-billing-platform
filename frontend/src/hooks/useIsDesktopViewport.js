import { useEffect, useState } from "react";

/**
 * ZB-SA-CMD-003 §17 — mobile restriction hook. Returns true when the
 * viewport is at least the spec's 768px desktop floor. Privileged write
 * actions (breaker engagement, privileged-access activation) are blocked
 * below it; read-only triage stays available.
 */
export default function useIsDesktopViewport(breakpointPx = 768) {
  const query = `(min-width: ${breakpointPx}px)`;
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e) => setIsDesktop(e.matches);
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener(onChange); // older Safari
    setIsDesktop(mql.matches);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);

  return isDesktop;
}
