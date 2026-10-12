import { describe, it, expect, vi } from "vitest";
import { Suspense } from "react";
import { render, screen } from "@testing-library/react";
import { lazyRoute, registerRoutePreloads, prefetchRoute, prefetchHandlers } from "./routePrefetch";
import { ContentSkeleton } from "./components/BillingShell";

describe("routePrefetch", () => {
  it("calls the loader once and ignores unknown paths and errors", async () => {
    const loader = vi.fn(() => Promise.resolve({ default: () => null }));
    const Page = lazyRoute(loader);
    registerRoutePreloads([{ path: "/x", element: <Page /> }]);
    prefetchRoute("/unknown");
    prefetchRoute("/x?tab=1");
    prefetchHandlers("/x").onMouseEnter();
    prefetchHandlers("/x").onFocus();
    expect(loader).toHaveBeenCalledTimes(1);

    const bad = lazyRoute(() => Promise.reject(new Error("net")));
    expect(() => bad.preload().catch(() => {})).not.toThrow();
  });

  it("skeleton shows while a lazy child suspends", async () => {
    let resolve;
    const Page = lazyRoute(() => new Promise((r) => { resolve = r; }));
    render(<Suspense fallback={<ContentSkeleton />}><Page /></Suspense>);
    expect(screen.getByRole("status")).toBeTruthy();
    resolve({ default: () => <div>loaded</div> });
    expect(await screen.findByText("loaded")).toBeTruthy();
  });
});
