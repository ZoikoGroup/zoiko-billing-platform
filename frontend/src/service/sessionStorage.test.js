import { describe, it, expect, beforeEach } from "vitest";
import {
  getAccessToken,
  getRefreshToken,
  getStoredUser,
  setStoredUser,
  setStoredSession,
  clearStoredSession,
} from "./sessionStorage";

// Regression coverage for Mandatory Fix 5 (Phase 3 architecture remediation):
// api/client.js and service/api.js used to read/write the same three
// localStorage keys independently. This is now the single storage
// implementation both delegate to — these tests pin its exact contract.

beforeEach(() => localStorage.clear());

describe("sessionStorage", () => {
  it("round-trips a full session (login)", () => {
    setStoredSession({ accessToken: "a1", refreshToken: "r1", user: { id: 1, role: "super_admin" } });
    expect(getAccessToken()).toBe("a1");
    expect(getRefreshToken()).toBe("r1");
    expect(getStoredUser()).toEqual({ id: 1, role: "super_admin" });
  });

  it("a partial write (access-token-only refresh) never blanks an existing refresh token or user", () => {
    setStoredSession({ accessToken: "a1", refreshToken: "r1", user: { id: 1 } });
    setStoredSession({ accessToken: "a2" }); // token refresh — no refreshToken/user in the response
    expect(getAccessToken()).toBe("a2");
    expect(getRefreshToken()).toBe("r1");
    expect(getStoredUser()).toEqual({ id: 1 });
  });

  it("clears the entire session on logout", () => {
    setStoredSession({ accessToken: "a1", refreshToken: "r1", user: { id: 1 } });
    clearStoredSession();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(getStoredUser()).toBeNull();
  });

  it("supports re-login after logout", () => {
    setStoredSession({ accessToken: "a1", refreshToken: "r1", user: { id: 1 } });
    clearStoredSession();
    setStoredSession({ accessToken: "a2", refreshToken: "r2", user: { id: 2 } });
    expect(getAccessToken()).toBe("a2");
    expect(getStoredUser()).toEqual({ id: 2 });
  });

  it("returns null (never throws) for a corrupted stored user value", () => {
    localStorage.setItem("zoiko_billing_user", "{not json");
    expect(getStoredUser()).toBeNull();
  });
});
