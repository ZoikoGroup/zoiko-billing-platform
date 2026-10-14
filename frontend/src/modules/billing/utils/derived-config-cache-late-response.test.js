import { describe, it, expect, vi, beforeEach } from "vitest";

// Tenant isolation (Phase 15 review of the cache consumers): billingConfigCache
// refuses to CACHE a response from before an invalidation, but it still hands
// that response back to its own caller. CurrencyContext and TerminologyContext
// keep their own module-level values derived from it, so they must not write
// the previous organization's currency / terminology into the next session.

const m = vi.hoisted(() => ({ getConfig: vi.fn(), token: "token-a" }));
vi.mock("../../../service/billingService", () => ({ settingsApi: { getConfig: (...a) => m.getConfig(...a) } }));
vi.mock("../../../service/sessionStorage", () => ({ getAccessToken: () => m.token }));

import { invalidateGlobalBillingConfig } from "../../../service/billingConfigCache";
import { loadGlobalCurrency, getOrgBaseCurrency } from "./CurrencyContext";
import { loadGlobalTerminology, getOrgTerminology } from "./TerminologyContext";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const CASES = [
  ["currency", loadGlobalCurrency, getOrgBaseCurrency, { base_currency: "INR" }, { base_currency: "EUR" }, "INR", "EUR"],
  ["terminology", loadGlobalTerminology, getOrgTerminology, { relationship_terminology: "patient" }, { relationship_terminology: "member" }, "patient", "member"],
];

beforeEach(() => {
  m.getConfig.mockReset();
  m.token = null;                    // reset both derived caches without a refetch
  invalidateGlobalBillingConfig();
  m.token = "token-a";
});

describe.each(CASES)("%s derived cache", (_name, load, read, configA, configB, valueA, valueB) => {
  it("ignores the previous session's late response after the next session has loaded", async () => {
    const a = deferred();
    m.getConfig.mockReturnValueOnce(a.promise).mockResolvedValueOnce(configB);
    const oldCaller = load();          // org A's load is in flight
    m.token = "token-b";
    invalidateGlobalBillingConfig();   // account switch: re-resolves for org B
    await vi.waitFor(() => expect(read()).toBe(valueB));
    a.resolve(configA);                // org A's response finally lands
    await oldCaller;
    expect(read()).toBe(valueB);
    await expect(load()).resolves.toBe(valueB);
  });

  it("ignores the previous session's late response while the next session is still loading", async () => {
    const a = deferred();
    const b = deferred();
    m.getConfig.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const oldCaller = load();
    m.token = "token-b";
    invalidateGlobalBillingConfig();
    a.resolve(configA);
    await oldCaller;
    expect(read()).not.toBe(valueA);
    b.resolve(configB);
    await expect(load()).resolves.toBe(valueB);
    expect(m.getConfig).toHaveBeenCalledTimes(2);
  });

  it("still caches normally within one session", async () => {
    m.getConfig.mockResolvedValueOnce(configA);
    await expect(load()).resolves.toBe(valueA);
    await expect(load()).resolves.toBe(valueA);
    expect(m.getConfig).toHaveBeenCalledTimes(1);
  });
});
