import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import useDeferredLoad, { scheduleIdle } from "./useDeferredLoad";

class FakeIO {
  static instances = [];
  constructor(cb, opts) { this.cb = cb; this.opts = opts; this.nodes = []; FakeIO.instances.push(this); }
  observe(n) { this.nodes.push(n); }
  disconnect() { this.disconnected = true; this.nodes = []; }
  emit(isIntersecting) { this.cb(this.nodes.map((target) => ({ target, isIntersecting }))); }
}

function Probe(props) {
  const { ref, triggered } = useDeferredLoad(props);
  return <div ref={ref} data-testid="probe">{triggered ? "loaded" : "waiting"}</div>;
}

beforeEach(() => { FakeIO.instances = []; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("useDeferredLoad", () => {
  it("visible: waits until the element intersects", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    render(<Probe strategy="visible" rootMargin="123px" />);
    expect(screen.getByTestId("probe")).toHaveTextContent("waiting");
    expect(FakeIO.instances[0].opts.rootMargin).toBe("123px");
    await act(async () => FakeIO.instances[0].emit(false));
    expect(screen.getByTestId("probe")).toHaveTextContent("waiting");
    await act(async () => FakeIO.instances[0].emit(true));
    expect(screen.getByTestId("probe")).toHaveTextContent("loaded");
    expect(FakeIO.instances[0].disconnected).toBe(true);
  });

  it("visible: falls back to loading immediately without IntersectionObserver", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<Probe strategy="visible" />);
    await act(async () => {});
    expect(screen.getByTestId("probe")).toHaveTextContent("loaded");
  });

  it("idle: triggers via requestIdleCallback after first paint", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    let idleCb = null;
    vi.stubGlobal("requestIdleCallback", (cb) => { idleCb = cb; return 1; });
    vi.stubGlobal("cancelIdleCallback", () => {});
    render(<Probe strategy="idle" />);
    expect(screen.getByTestId("probe")).toHaveTextContent("waiting");
    expect(FakeIO.instances).toHaveLength(0);
    await act(async () => idleCb());
    expect(screen.getByTestId("probe")).toHaveTextContent("loaded");
  });

  it("idle: falls back to setTimeout when requestIdleCallback is missing", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    render(<Probe strategy="idle" />);
    expect(screen.getByTestId("probe")).toHaveTextContent("waiting");
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(screen.getByTestId("probe")).toHaveTextContent("loaded");
  });

  it("either: whichever comes first wins", async () => {
    vi.stubGlobal("IntersectionObserver", FakeIO);
    vi.stubGlobal("requestIdleCallback", () => 1);
    render(<Probe strategy="either" />);
    await act(async () => FakeIO.instances[0].emit(true));
    expect(screen.getByTestId("probe")).toHaveTextContent("loaded");
  });

  it("enabled=false never triggers", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    render(<Probe strategy="visible" enabled={false} />);
    await act(async () => {});
    expect(screen.getByTestId("probe")).toHaveTextContent("waiting");
  });
});

describe("scheduleIdle", () => {
  it("returns a working canceller for the timeout fallback", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const cb = vi.fn();
    const cancel = scheduleIdle(cb);
    cancel();
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });
});
