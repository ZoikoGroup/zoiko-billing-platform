import { lazy } from "react";

// Route -> loader registry shared by App.jsx's lazy() declarations and the
// sidebar. lazyRoute() memoises the import() promise, so a hover/focus
// prefetch and the later React.lazy() render reuse the very same chunk load.
const loaders = new Map();

export function lazyRoute(loader) {
  let promise;
  const load = () => {
    if (!promise) {
      promise = Promise.resolve(loader()).catch((err) => {
        promise = undefined; // allow a retry after a transient network error
        throw err;
      });
    }
    return promise;
  };
  const Component = lazy(load);
  Component.preload = load;
  return Component;
}

// routes: [{ path, element }] where element is <LazyComponent /> (anything
// whose type has no .preload is skipped, e.g. wrapped elements / redirects).
export function registerRoutePreloads(routes) {
  for (const { path, element } of routes) {
    const preload = element && element.type && element.type.preload;
    if (typeof preload === "function") loaders.set(path, preload);
  }
}

export function prefetchRoute(href) {
  if (!href || typeof href !== "string") return;
  const path = href.split(/[?#]/)[0];
  const load = loaders.get(path);
  if (!load) return;
  try {
    load().catch(() => {});
  } catch {
    // ignore - prefetch is best-effort
  }
}

export const prefetchHandlers = (href) => ({
  onMouseEnter: () => prefetchRoute(href),
  onFocus: () => prefetchRoute(href),
});

export function __resetRoutePrefetchForTests() {
  loaders.clear();
}
