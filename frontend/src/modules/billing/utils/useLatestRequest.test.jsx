import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import useLatestRequest from "./useLatestRequest";

describe("useLatestRequest", () => {
  it("a single request is current until another one begins", () => {
    const { result } = renderHook(() => useLatestRequest());
    const isCurrent = result.current();
    expect(isCurrent()).toBe(true);
    expect(isCurrent()).toBe(true);
  });

  it("beginning a second request invalidates the first", () => {
    const { result } = renderHook(() => useLatestRequest());
    const first = result.current();
    const second = result.current();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it("returns a stable function across re-renders", () => {
    const { result, rerender } = renderHook(() => useLatestRequest());
    const before = result.current;
    const first = before();
    rerender();
    expect(result.current).toBe(before);
    expect(first()).toBe(true);
  });

  it("unmounting invalidates the in-flight request", () => {
    const { result, unmount } = renderHook(() => useLatestRequest());
    const isCurrent = result.current();
    unmount();
    expect(isCurrent()).toBe(false);
  });
});
