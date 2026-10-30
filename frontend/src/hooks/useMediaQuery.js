import { useEffect, useState } from "react";

/**
 * True while `query` matches. Shared primitives use it with max-width
 * queries (e.g. "(max-width: 767.98px)") to pick their phone layout, so
 * anywhere matchMedia is missing or never matches — SSR, and the jsdom
 * polyfill in src/test/setup.js — they render their desktop markup.
 */
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const mql = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    if (mql.addEventListener) mql.addEventListener("change", onChange);
    else mql.addListener?.(onChange); // older Safari
    setMatches(mql.matches);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener("change", onChange);
      else mql.removeListener?.(onChange);
    };
  }, [query]);

  return matches;
}

/** Phone layout breakpoints, matching Tailwind's sm and md. */
export const BELOW_SM = "(max-width: 639.98px)";
export const BELOW_MD = "(max-width: 767.98px)";
