import { describe, it, expect, vi, beforeEach } from "vitest";
import { apiFetch, setSession, clearSession, getAccessToken } from "./client";

// Regression coverage for Mandatory Fix 5 (Phase 3 architecture remediation).
// api/client.js backs LoginPage/AuthContext/ProtectedRoute — the core login
// and session-protection surface. These tests pin: an unauthenticated login
// request works with no MFA gate, a 401 on an authenticated call silently
// refreshes and retries, and a rejected refresh fails closed (session cleared).

function jsonResponse(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("api/client.js", () => {
  it("login: a valid credential POST completes with no MFA step and stores the full session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        access_token: "tok-1",
        refresh_token: "ref-1",
        user: { id: 1, role: "super_admin", organization_id: null },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const data = await apiFetch("/api/auth/login", {
      method: "POST",
      body: { email: "nikhil@zoikogroup.com", password: "x" },
    });
    setSession(data);

    expect(getAccessToken()).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1); // one request — no separate MFA round trip
  });

  it("on a 401, silently refreshes and retries the original request once", async () => {
    setSession({ access_token: "expired", refresh_token: "ref-1", user: { id: 1 } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "new-tok", refresh_token: "ref-1" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await apiFetch("/api/super-admin/dashboard/stats");

    expect(result).toEqual({ ok: true });
    expect(getAccessToken()).toBe("new-tok");
  });

  it("on a rejected refresh, clears the session (fails closed)", async () => {
    setSession({ access_token: "expired", refresh_token: "revoked", user: { id: 1 } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, {}))
      .mockResolvedValueOnce(jsonResponse(401, {}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/super-admin/dashboard/stats")).rejects.toBeTruthy();
    expect(getAccessToken()).toBeNull();
  });

  it("logout clears the session and a subsequent re-login repopulates it", () => {
    setSession({ access_token: "a", refresh_token: "r", user: { id: 1 } });
    clearSession();
    expect(getAccessToken()).toBeNull();
    setSession({ access_token: "a2", refresh_token: "r2", user: { id: 2 } });
    expect(getAccessToken()).toBe("a2");
  });
});
