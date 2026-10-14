import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import usePolling, { createPoller, MAX_BACKOFF_MS } from "./usePolling";

let visibility = "visible";
const setVisibility = (v) => {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usePolling", () => {
  it("calls fn every interval while visible", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    renderHook(() => usePolling(fn, 1000));
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("runs immediately when runImmediately is set", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    renderHook(() => usePolling(fn, 1000, { runImmediately: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does nothing when disabled", async () => {
    const fn = vi.fn();
    renderHook(() => usePolling(fn, 1000, { enabled: false }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("makes zero calls while the tab is hidden", async () => {
    visibility = "hidden";
    const fn = vi.fn().mockResolvedValue(undefined);
    renderHook(() => usePolling(fn, 1000, { runImmediately: true }));
    await vi.advanceTimersByTimeAsync(10000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("stops polling when hidden and refreshes immediately on visible when stale", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    renderHook(() => usePolling(fn, 1000));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(10000);
    expect(fn).toHaveBeenCalledTimes(1);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not refresh immediately on visible when data is still fresh", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    renderHook(() => usePolling(fn, 1000));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("never overlaps a pending run", async () => {
    let resolve;
    let active = 0;
    let maxActive = 0;
    const fn = vi.fn(() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise((r) => {
        resolve = () => {
          active -= 1;
          r();
        };
      });
    });
    renderHook(() => usePolling(fn, 1000));
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(fn).toHaveBeenCalledTimes(1);
    // visibility flip while pending must not start a second run either
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it("backs off after failures (capped) and resets on success", async () => {
    let fail = true;
    const fn = vi.fn(() => (fail ? Promise.reject(new Error("x")) : Promise.resolve()));
    renderHook(() => usePolling(fn, 1000));
    await vi.advanceTimersByTimeAsync(1000); // call 1 fails -> next in 2000
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // call 2 fails -> next in 4000
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(fn).toHaveBeenCalledTimes(2);
    fail = false;
    await vi.advanceTimersByTimeAsync(1); // call 3 succeeds -> back to 1000
    expect(fn).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("caps the backoff at 5 minutes", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("x")));
    const poller = createPoller(fn, 60000, { runImmediately: false });
    poller.start();
    for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    const before = fn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS);
    expect(fn.mock.calls.length).toBe(before + 1);
    poller.stop();
  });

  it("always calls the latest fn", async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const b = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(({ fn }) => usePolling(fn, 1000), { initialProps: { fn: a } });
    rerender({ fn: b });
    await vi.advanceTimersByTimeAsync(1000);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("cleans up timers and listeners on unmount", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() => usePolling(fn, 1000));
    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
