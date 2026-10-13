import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

// Security finding during the BUG-02 investigation: api.js dispatches
// AUTH_INVALID_EVENT when a session expires/is revoked, but nothing listened,
// so the module-level tenant caches (org detail, Zoiko subscription, billing
// config -- none keyed by user) survived into the next sign-in on the same tab.
// They must be cleared on session-invalid, on login and on logout.

const m = vi.hoisted(() => ({ org: vi.fn(), sub: vi.fn(), cfg: vi.fn(), global: vi.fn() }));
vi.mock("../service/orgAdminService", () => ({ invalidateOrganizationDetailsCache: () => m.org() }));
vi.mock("../service/platformSelfServiceApi", () => ({ invalidateZoikoSubscriptionCache: () => m.sub() }));
vi.mock("../service/billingService", () => ({ invalidateConfigCache: () => m.cfg() }));
vi.mock("../service/billingConfigCache", () => ({ invalidateGlobalBillingConfig: () => m.global() }));

import { AuthProvider, useAuth } from "./AuthContext";
import { AUTH_INVALID_EVENT } from "../service/api";

let auth;
function Capture() {
  auth = useAuth();
  return <div data-testid="user">{auth.user ? auth.user.email : "none"}</div>;
}
const allCleared = (times) => {
  for (const fn of [m.org, m.sub, m.cfg, m.global]) expect(fn).toHaveBeenCalledTimes(times);
};

beforeEach(() => { vi.clearAllMocks(); try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ } });
afterEach(() => cleanup());

describe("AuthContext clears tenant caches", () => {
  it("when the API reports the session invalid", async () => {
    render(<AuthProvider><Capture /></AuthProvider>);
    await act(async () => { await auth.login({ email: "a@org-a.test", role: "org_admin" }); });
    vi.clearAllMocks();
    act(() => { window.dispatchEvent(new CustomEvent(AUTH_INVALID_EVENT, { detail: { reason: "expired" } })); });
    allCleared(1);
    expect(screen.getByTestId("user")).toHaveTextContent("none");
  });

  it("on every login, so a new account never reuses the previous tenant's data", async () => {
    render(<AuthProvider><Capture /></AuthProvider>);
    await act(async () => { await auth.login({ email: "b@org-b.test", role: "billing_admin" }); });
    allCleared(1);
    expect(screen.getByTestId("user")).toHaveTextContent("b@org-b.test");
  });

  it("on logout (unchanged)", async () => {
    render(<AuthProvider><Capture /></AuthProvider>);
    await act(async () => { await auth.logout(); });
    allCleared(1);
  });

  it("stops listening after unmount", () => {
    const { unmount } = render(<AuthProvider><Capture /></AuthProvider>);
    unmount();
    window.dispatchEvent(new CustomEvent(AUTH_INVALID_EVENT, { detail: {} }));
    allCleared(0);
  });
});
