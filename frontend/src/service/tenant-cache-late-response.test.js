import { describe, it, expect, vi, beforeEach } from "vitest";

// Tenant isolation (Phase 13 review of the AuthContext cache fix): clearing a
// cache on logout / session expiry is not enough if a request from the
// PREVIOUS session is still in flight. When it resolves afterwards it must not
// write the previous organization's data back into the cache (and its cleanup
// must not cancel the new session's own in-flight request).

const m = vi.hoisted(() => ({ get: vi.fn(), getConfig: vi.fn() }));
vi.mock("./api", () => ({ api: { get: (...a) => m.get(...a) } }));
vi.mock("./billingService", () => ({ settingsApi: { getConfig: (...a) => m.getConfig(...a) } }));

import { getOrganizationDetails, invalidateOrganizationDetailsCache } from "./orgAdminService";
import { getZoikoSubscriptionCached, invalidateZoikoSubscriptionCache } from "./platformSelfServiceApi";
import { loadGlobalBillingConfig, invalidateGlobalBillingConfig } from "./billingConfigCache";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const CASES = [
  ["organization details", getOrganizationDetails, invalidateOrganizationDetailsCache, m.get],
  ["Zoiko subscription", getZoikoSubscriptionCached, invalidateZoikoSubscriptionCache, m.get],
  ["global billing config", loadGlobalBillingConfig, invalidateGlobalBillingConfig, m.getConfig],
];

beforeEach(() => {
  m.get.mockReset();
  m.getConfig.mockReset();
  invalidateOrganizationDetailsCache();
  invalidateZoikoSubscriptionCache();
  invalidateGlobalBillingConfig();
});

describe.each(CASES)("%s cache", (_name, load, invalidate, fetchMock) => {
  it("a late response from the previous session does not repopulate the cache", async () => {
    const old = deferred();
    fetchMock.mockReturnValueOnce(old.promise);
    const oldCaller = load();                  // org A's request is in flight
    invalidate();                              // logout / session expiry
    old.resolve({ tenant: "A" });              // ...and it lands afterwards
    await expect(oldCaller).resolves.toEqual({ tenant: "A" });   // its own caller still gets its answer

    fetchMock.mockResolvedValueOnce({ tenant: "B" });
    await expect(load()).resolves.toEqual({ tenant: "B" });       // the next session refetches
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("the previous request's cleanup does not cancel the new session's in-flight request", async () => {
    const old = deferred();
    const fresh = deferred();
    fetchMock.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const oldCaller = load();
    invalidate();
    const b1 = load();                          // new session starts its own request
    old.resolve({ tenant: "A" });
    await oldCaller;
    const b2 = load();                          // must join B's in-flight request, not start a third
    fresh.resolve({ tenant: "B" });
    await expect(b1).resolves.toEqual({ tenant: "B" });
    await expect(b2).resolves.toEqual({ tenant: "B" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a late response cannot overwrite the new account's already-cached data", async () => {
    const old = deferred();
    fetchMock.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ tenant: "B" });
    const oldCaller = load();
    invalidate();
    await expect(load()).resolves.toEqual({ tenant: "B" });     // B's cache is populated first
    old.resolve({ tenant: "A" });                               // then A's request finally lands
    await oldCaller;
    await expect(load()).resolves.toEqual({ tenant: "B" });     // still B, served from cache
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("still caches normally within one session", async () => {
    fetchMock.mockResolvedValueOnce({ tenant: "A" });
    await load();
    await expect(load()).resolves.toEqual({ tenant: "A" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
