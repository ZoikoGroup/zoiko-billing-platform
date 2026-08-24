import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  api,
  setSession,
  clearSession,
  getAccessToken,
  AUTH_INVALID_EVENT,
  getTokenExpiryMs,
} from "./api";

// Regression coverage for Mandatory Fix 5 (Phase 3 architecture remediation):
// session/request behavior for refresh, 401, 403, expired-session,
// logout, and re-login must be preserved exactly as documented —
// normal login/requests are never blocked by MFA, a transient refresh
// failure must NOT tear down a still-possibly-valid session, and a truly
// rejected refresh must fail closed (clear session, notify, deny).
//
// Plus coverage for the proactive-refresh transport fix: an expired or
// near-expiry access token is refreshed BEFORE the data call fires (via the
// same single-flight promise), instead of every parallel call bouncing off a
// 401 first. The reactive path remains as the safety net.

function jsonResponse(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: () => Promise.resolve(body),
  });
}

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/=+$/g, "");
}

function makeJwt(expSecondsFromNow) {
  return `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({
    exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
  })}.signature`;
}

function makeResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("service/api.js — authenticated requests", () => {
  it("attaches the bearer token from storage on an authenticated request", async () => {
    setSession({ accessToken: "tok-1", refreshToken: "ref-1", user: { id: 1 } });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.get("/api/super-admin/dashboard/stats");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer tok-1");
  });

  it("on a 401, silently refreshes once and retries the original request (session preserved)", async () => {
    setSession({ accessToken: "expired", refreshToken: "ref-1", user: { id: 1 } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { detail: "expired" })) // original request
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "new-tok", refresh_token: "ref-1" })) // /api/auth/refresh
      .mockResolvedValueOnce(jsonResponse(200, { data: "ok" })); // retried original request
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.get("/api/super-admin/dashboard/stats");

    expect(result).toEqual({ data: "ok" });
    expect(getAccessToken()).toBe("new-tok");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("on a refresh that is explicitly rejected (401/403), clears the session, notifies, and fails closed", async () => {
    setSession({ accessToken: "expired", refreshToken: "revoked", user: { id: 1 } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, {})) // original request
      .mockResolvedValueOnce(jsonResponse(401, { detail: "refresh token revoked" })); // /api/auth/refresh rejected
    vi.stubGlobal("fetch", fetchMock);

    const listener = vi.fn();
    window.addEventListener(AUTH_INVALID_EVENT, listener);

    await expect(api.get("/api/super-admin/dashboard/stats")).rejects.toMatchObject({
      status: 401,
      authInvalid: true,
    });
    expect(getAccessToken()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(AUTH_INVALID_EVENT, listener);
  });

  it("on a transient refresh failure (network error), does NOT tear down a possibly-valid session", async () => {
    setSession({ accessToken: "expired", refreshToken: "ref-1", user: { id: 1 } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, {})) // original request
      .mockRejectedValueOnce(new Error("network down")); // /api/auth/refresh — transient
    vi.stubGlobal("fetch", fetchMock);

    // The transient-failure path returns invalidSession:false and the caller's
    // original 401 response is used as-is — the refresh token itself is preserved.
    await expect(api.get("/api/super-admin/dashboard/stats")).rejects.toBeTruthy();
    expect(getRefreshTokenDirect()).toBe("ref-1");
  });

  it("does not attempt a refresh on a 403 (capability-denied) response — fails immediately", async () => {
    setSession({ accessToken: "tok-1", refreshToken: "ref-1", user: { id: 1 } });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, { detail: "forbidden" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.get("/api/super-admin/settings")).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no refresh attempt, no retry
  });

  it("logout clears the full session", () => {
    setSession({ accessToken: "tok-1", refreshToken: "ref-1", user: { id: 1 } });
    clearSession();
    expect(getAccessToken()).toBeNull();
  });

  it("supports re-login (a fresh setSession after logout) and a subsequent request uses the new token", async () => {
    setSession({ accessToken: "old", refreshToken: "old-r", user: { id: 1 } });
    clearSession();
    setSession({ accessToken: "new", refreshToken: "new-r", user: { id: 2 } });

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await api.get("/api/super-admin/dashboard/stats");

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer new");
  });
});

function getRefreshTokenDirect() {
  return localStorage.getItem("zoiko_billing_refresh");
}

describe("getTokenExpiryMs", () => {
  it("parses the exp claim into epoch ms", () => {
    const expSec = Math.floor(Date.now() / 1000) + 120;
    expect(getTokenExpiryMs(makeJwt(120))).toBeCloseTo(expSec * 1000, -1);
  });

  it("returns null for garbage or exp-less tokens instead of throwing", () => {
    expect(getTokenExpiryMs(null)).toBeNull();
    expect(getTokenExpiryMs("garbage")).toBeNull();
    expect(getTokenExpiryMs(`${b64url({ alg: "none" })}.${b64url({ sub: "x" })}.sig`)).toBeNull();
  });
});

describe("proactive refresh before request", () => {
  it("refreshes an already-expired token BEFORE the data call and sends the new bearer", async () => {
    localStorage.setItem("zoiko_billing_access", makeJwt(-60)); // expired a minute ago
    localStorage.setItem("zoiko_billing_refresh", "refresh-token-1");

    const newToken = makeJwt(3600);
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/api/auth/refresh")) {
        return makeResponse({ access_token: newToken });
      }
      return makeResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const data = await api.get("/api/super-admin/attention/counts");

    expect(data).toEqual({ ok: true });
    // Refresh happened exactly once, and BEFORE the data request.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/auth/refresh");
    const [, dataOpts] = fetchMock.mock.calls[1];
    expect(dataOpts.headers.Authorization).toBe(`Bearer ${newToken}`);
    // New access token persisted for subsequent calls.
    expect(localStorage.getItem("zoiko_billing_access")).toBe(newToken);
  });

  it("does NOT refresh when the token is comfortably valid", async () => {
    setSession({ accessToken: makeJwt(1800), refreshToken: "refresh-token-2" });

    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await api.get("/api/super-admin/attention/counts");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("/api/auth/refresh");
  });

  it("coalesces concurrent stale-token callers onto one refresh", async () => {
    localStorage.setItem("zoiko_billing_access", makeJwt(-10));
    localStorage.setItem("zoiko_billing_refresh", "refresh-token-3");

    const newToken = makeJwt(3600);
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/api/auth/refresh")) {
        await new Promise((r) => setTimeout(r, 5)); // simulate latency
        return makeResponse({ access_token: newToken });
      }
      return makeResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([api.get("/a"), api.get("/b"), api.get("/c")]);

    const refreshCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/api/auth/refresh")
    );
    expect(refreshCalls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 refresh + 3 data calls
  });

  it("keeps the reactive 401 path working when the token has no parsable expiry", async () => {
    setSession({ accessToken: "unparseable-token", refreshToken: "refresh-token-4" });

    const fetchMock = vi.fn(async (url, opts = {}) => {
      if (String(url).includes("/api/auth/refresh")) {
        return makeResponse({ access_token: makeJwt(3600) });
      }
      const authHeader = opts.headers?.Authorization || "";
      if (authHeader.endsWith("unparseable-token")) {
        return makeResponse({ detail: "Not authenticated" }, 401);
      }
      return makeResponse({ recovered: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const data = await api.get("/api/super-admin/audit-logs");
    expect(data).toEqual({ recovered: true });

    const refreshCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/api/auth/refresh")
    );
    expect(refreshCalls).toHaveLength(1);
  });
});
