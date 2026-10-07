import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, cleanup, waitFor } from "@testing-library/react";

// On return from the Stripe Connect OAuth callback (?code=&state=), the
// completeOAuth response is the fresh status. The initial GET status used to
// run in parallel and, if it returned later, overwrote "connected" with a
// stale "not connected".

const m = vi.hoisted(() => ({
  details: vi.fn(), status: vi.fn(), complete: vi.fn(),
}));
vi.mock("../../service/orgAdminService", () => ({
  getOrganizationDetails: (...a) => m.details(...a),
  updateOrganizationDetails: vi.fn(),
}));
vi.mock("../../service/billingService", () => ({
  stripeConnectApi: {
    getStatus: (...a) => m.status(...a), getOnboardingUrl: vi.fn(),
    sync: vi.fn(), disconnect: vi.fn(), completeOAuth: (...a) => m.complete(...a),
  },
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: () => ({ user: { role: "org_admin" } }) }));

import OrgAdminOrganizationPage from "./OrganizationPage";

const org = { name: "Acme Org", code: "ACME", status: "active", currency: "INR", timezone: "UTC", industry: "", address: "" };
const CONNECTED = { connected: true, status: "active", environment: "test", connect_configured: true, connected_account_id: "acct_123" };
const NOT_CONNECTED = { connected: false, status: "pending_onboarding", environment: "test", connect_configured: true };

beforeEach(() => {
  vi.clearAllMocks();
  m.details.mockResolvedValue(org);
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("OrganizationPage Stripe OAuth callback", () => {
  it("keeps the completeOAuth status even if a slower status GET would resolve later", async () => {
    window.history.replaceState({}, "", "/org/organization?code=ac_1&state=st_1");
    let resolveStatus;
    m.status.mockImplementation(() => new Promise((r) => { resolveStatus = r; }));
    m.complete.mockResolvedValue(CONNECTED);

    render(<OrgAdminOrganizationPage />);

    await waitFor(() => expect(m.complete).toHaveBeenCalledWith("ac_1", "st_1"));
    expect(await screen.findByText("acct_123")).toBeInTheDocument();

    // A stale GET (if one was started) resolving now must not flip the card.
    if (resolveStatus) await act(async () => { resolveStatus(NOT_CONNECTED); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("acct_123")).toBeInTheDocument();
    expect(m.status).not.toHaveBeenCalled();
    // Callback params are cleaned from the URL.
    expect(window.location.search).toBe("");
  });

  it("falls back to the regular status GET when the OAuth exchange fails", async () => {
    window.history.replaceState({}, "", "/org/organization?code=ac_1&state=st_1");
    m.complete.mockRejectedValue(new Error("bad state"));
    m.status.mockResolvedValue(NOT_CONNECTED);

    render(<OrgAdminOrganizationPage />);
    await waitFor(() => expect(m.status).toHaveBeenCalledTimes(1));
  });

  it("without callback params, loads status via GET only", async () => {
    m.status.mockResolvedValue(NOT_CONNECTED);
    render(<OrgAdminOrganizationPage />);
    await waitFor(() => expect(m.status).toHaveBeenCalledTimes(1));
    expect(m.complete).not.toHaveBeenCalled();
  });
});
