import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  CHUNK_RELOAD_KEY,
  CHUNK_RELOAD_GUARD_MS,
  handlePreloadError,
  installChunkReloadRecovery,
  isChunkLoadError,
} from "./chunkReloadRecovery";

const preloadEvent = () => new Event("vite:preloadError", { cancelable: true });

describe("vite:preloadError recovery", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  it("reloads once and cancels Vite's rethrow", () => {
    const reload = vi.fn();
    const event = preloadEvent();
    expect(handlePreloadError(event, { reload, now: () => 1_000_000 })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBe("1000000");
  });

  it("never reloads twice inside the guard window, and lets the error through", () => {
    const reload = vi.fn();
    let t = 1_000_000;
    const now = () => t;
    handlePreloadError(preloadEvent(), { reload, now });
    t += CHUNK_RELOAD_GUARD_MS - 1;
    const second = preloadEvent();
    expect(handlePreloadError(second, { reload, now })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(second.defaultPrevented).toBe(false);
  });

  it("allows another reload once the guard window has passed", () => {
    const reload = vi.fn();
    let t = 1_000_000;
    const now = () => t;
    handlePreloadError(preloadEvent(), { reload, now });
    t += CHUNK_RELOAD_GUARD_MS + 1;
    handlePreloadError(preloadEvent(), { reload, now });
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when sessionStorage is unavailable (no loop guard)", () => {
    const reload = vi.fn();
    const storage = { getItem: () => { throw new Error("blocked"); }, setItem: () => {} };
    expect(handlePreloadError(preloadEvent(), { storage, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps path, query and hash and leaves auth storage untouched", () => {
    window.history.pushState({}, "", "/billing/invoices?status=open#row-42");
    const before = window.location.href;
    window.localStorage.setItem("token", "abc");
    window.localStorage.setItem("user", '{"id":1}');
    window.sessionStorage.setItem("auth", "keep-me");

    const reload = vi.fn();
    handlePreloadError(preloadEvent(), { reload });

    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe(before);
    expect(window.localStorage.getItem("token")).toBe("abc");
    expect(window.localStorage.getItem("user")).toBe('{"id":1}');
    expect(window.sessionStorage.getItem("auth")).toBe("keep-me");
    expect(window.localStorage.length).toBe(2);
  });

  it("installs on the target and can be removed", () => {
    const target = new EventTarget();
    const uninstall = installChunkReloadRecovery(target);
    // Guard already set, so the installed listener must not reload or cancel.
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
    const event = preloadEvent();
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    uninstall();
  });
});

describe("isChunkLoadError", () => {
  it.each([
    "Failed to fetch dynamically imported module: https://app.zoikobilling.com/assets/AssistantPanel-abc.js",
    "error loading dynamically imported module",
    "Importing a module script failed.",
    "Unable to preload CSS for /assets/index-abc.css",
  ])("recognises %s", (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it("ignores ordinary errors", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
