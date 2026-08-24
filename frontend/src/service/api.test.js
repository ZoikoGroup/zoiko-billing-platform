import { describe, it, expect, vi, beforeEach } from "vitest";
import { api, setSession, clearSession, getAccessToken, AUTH_INVALID_EVENT } from "./api";

// Regression coverage for Mandatory Fix 5 (Phase 3 architecture remediation):
// session/request behavior for refresh, 401, 403, expired-session,
// logout, and re-login must be preserved exactly as documented —
// normal login/requests are never blocked by MFA, a transient refresh
// failure must NOT tear down a still-possibly-valid session, and a truly
// rejected refresh must fail closed (clear session, notify, deny).

function jsonResponse(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
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
