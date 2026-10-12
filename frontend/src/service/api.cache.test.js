import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { api, setSession, clearApiCache, isAbortError, resourceFamily, AUTH_INVALID_EVENT } from "./api";

function res(body, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: () => Promise.resolve(JSON.parse(JSON.stringify(body))),
  });
}

function login(id, org = 1) {
  setSession({ accessToken: `tok-${id}`, refreshToken: `ref-${id}`, user: { id, organization_id: org, role: "org_admin" } });
}

let fetchMock;
beforeEach(() => {
  localStorage.clear();
  clearApiCache();
  vi.useRealTimers();
  fetchMock = vi.fn(() => res({ n: Math.random() }));
  vi.stubGlobal("fetch", fetchMock);
  login(1);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("api in-flight de-duplication", () => {
  it("collapses concurrent identical GETs into one fetch and gives each caller its own object", async () => {
    const [a, b] = await Promise.all([api.get("/api/billing/customers", { params: { page: 1 } }), api.get("/api/billing/customers", { params: { page: 1 } })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    a.n = "mutated";
    expect(b.n).not.toBe("mutated");
  });

  it("does not dedupe different URLs, and does not cache without cacheTtl", async () => {
    await Promise.all([api.get("/api/x?a=1"), api.get("/api/x?a=2")]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await api.get("/api/x?a=1");
    await api.get("/api/x?a=1");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not share between different auth identities", async () => {
    const p1 = api.get("/api/billing/settings");
    localStorage.clear();
    login(2, 9);
    const p2 = api.get("/api/billing/settings");
    await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("api TTL cache", () => {
  it("serves from cache within the TTL and refetches after it", async () => {
    vi.useFakeTimers();
    const a = await api.get("/api/billing/settings", { cacheTtl: 1000 });
    const b = await api.get("/api/billing/settings", { cacheTtl: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    vi.advanceTimersByTime(1001);
    await api.get("/api/billing/settings", { cacheTtl: 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not share cache between identities", async () => {
    await api.get("/api/billing/settings", { cacheTtl: 60000 });
    localStorage.clear();
    login(2, 9);
    await api.get("/api/billing/settings", { cacheTtl: 60000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stale-while-revalidate returns the stale value immediately and refreshes in background", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(() => res({ v: 1 })).mockImplementationOnce(() => res({ v: 2 }));
    expect(await api.get("/api/billing/settings", { cacheTtl: 1000, staleWhileRevalidate: true })).toEqual({ v: 1 });
    vi.advanceTimersByTime(1500);
    expect(await api.get("/api/billing/settings", { cacheTtl: 1000, staleWhileRevalidate: true })).toEqual({ v: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(await api.get("/api/billing/settings", { cacheTtl: 1000, staleWhileRevalidate: true })).toEqual({ v: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("api invalidation", () => {
  it("a mutation to the same resource family clears cached GETs; other families survive", async () => {
    await api.get("/api/billing/settings/config", { cacheTtl: 60000 });
    await api.get("/api/billing/invoices", { cacheTtl: 60000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await api.put("/api/billing/settings/config", { a: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await api.get("/api/billing/invoices", { cacheTtl: 60000 }); // still cached
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await api.get("/api/billing/settings/config", { cacheTtl: 60000 }); // refetched
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("derives resource families", () => {
    expect(resourceFamily("http://h/api/billing/invoices/12?x=1")).toBe("billing/invoices");
    expect(resourceFamily("/api/customers/3")).toBe("customers");
  });

  it("clearApiCache (logout) drops cached data", async () => {
    await api.get("/api/billing/settings", { cacheTtl: 60000 });
    clearApiCache();
    await api.get("/api/billing/settings", { cacheTtl: 60000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an auth-invalid event path clears the cache", async () => {
    await api.get("/api/billing/settings", { cacheTtl: 60000 });
    fetchMock.mockImplementationOnce(() => res({}, 401)).mockImplementation(() => res({}, 401));
    const listener = vi.fn();
    window.addEventListener(AUTH_INVALID_EVENT, listener);
    await expect(api.get("/api/other")).rejects.toMatchObject({ authInvalid: true });
    window.removeEventListener(AUTH_INVALID_EVENT, listener);
    login(1);
    fetchMock.mockImplementation(() => res({ ok: 1 }));
    const before = fetchMock.mock.calls.length;
    await api.get("/api/billing/settings", { cacheTtl: 60000 });
    expect(fetchMock.mock.calls.length).toBe(before + 1);
  });
});

describe("api cancellation", () => {
  it("rejects with a recognisable abort error, with no refresh and no retry", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" })));
    }));
    const p = api.get("/api/billing/invoices", { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    const err = await p.catch((e) => e);
    expect(isAbortError(err)).toBe(true);
    expect(err.name).toBe("AbortError");
    expect(err.status).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/auth/refresh"))).toBe(false);
  });

  it("an already-aborted signal never hits the network", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(api.get("/api/billing/invoices", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborting one caller does not cancel a de-duplicated peer", async () => {
    const controller = new AbortController();
    const p1 = api.get("/api/billing/invoices", { signal: controller.signal });
    const p2 = api.get("/api/billing/invoices");
    controller.abort();
    await p1.catch(() => {});
    await expect(p2).resolves.toBeTruthy();
  });
});
