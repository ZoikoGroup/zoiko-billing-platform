import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

const m = vi.hoisted(() => ({
  details: vi.fn(),
  status: vi.fn(),
  onboarding: vi.fn(),
  sync: vi.fn(),
  disconnect: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("../../service/orgAdminService", () => ({
  getOrganizationDetails: (...a) => m.details(...a),
  updateOrganizationDetails: vi.fn(),
}));

vi.mock("../../service/billingService", () => ({
  stripeConnectApi: {
    getStatus: (...a) => m.status(...a),
    getOnboardingUrl: (...a) => m.onboarding(...a),
    sync: (...a) => m.sync(...a),
    disconnect: (...a) => m.disconnect(...a),
    completeOAuth: (...a) => m.complete(...a),
  },
}));

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ user: { role: "org_admin" } }),
}));

import OrgAdminOrganizationPage from "./OrganizationPage";

const mockOrg = {
  name: "Acme Corp",
  code: "ACM001",
  status: "active",
  currency: "USD",
  timezone: "UTC",
  industry: "Software",
  address: "123 Tech Way",
  city: "San Francisco",
  state: "CA",
  country: "US",
  total_customers: 10,
  active_customers: 8,
  billing_admins: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.details.mockResolvedValue(mockOrg);
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("OrganizationPage Stripe Connect Bug Fixes & UI Corrections", () => {
  it("renders empty account details consistently when not connected", async () => {
    m.status.mockResolvedValue({
      connected: false,
      status: "pending_onboarding",
      environment: "test",
      connect_configured: true,
      connected_account_id: null,
      country: null,
      default_currency: null,
      charges_enabled: false,
      payouts_enabled: false,
    });

    render(<OrgAdminOrganizationPage />);

    expect(await screen.findByText("Stripe Payments")).toBeInTheDocument();
    const stripeSection = screen.getByText("Stripe Payments").closest(".stripe-panel");
    const scope = within(stripeSection);

    expect(scope.getByText("Account ID")).toBeInTheDocument();
    expect(scope.getByText("Country")).toBeInTheDocument();
    expect(scope.getByText("Default Currency")).toBeInTheDocument();
    expect(scope.getByText("Charges")).toBeInTheDocument();
    expect(scope.getByText("Payouts")).toBeInTheDocument();
    expect(scope.getAllByText("Disabled")).toHaveLength(2); // Charges & Payouts
  });

  it("handles Connect Stripe button click and triggers onboarding with current origin and path", async () => {
    m.status.mockResolvedValue({
      connected: false,
      status: "pending_onboarding",
      environment: "test",
      connect_configured: true,
    });
    m.onboarding.mockResolvedValue({
      url: "https://connect.stripe.com/oauth/authorize?client_id=ca_123",
    });

    const originalLocation = window.location;
    delete window.location;
    window.location = {
      ...originalLocation,
      origin: "https://app.zoikobilling.com",
      pathname: "/organization-admin/organization",
      search: "",
      href: "",
    };

    render(<OrgAdminOrganizationPage />);

    const connectBtn = await screen.findByRole("button", { name: /connect stripe/i });
    fireEvent.click(connectBtn);

    await waitFor(() => {
      expect(m.onboarding).toHaveBeenCalledWith("https://app.zoikobilling.com/organization-admin/organization");
    });

    window.location = originalLocation;
  });

  it("displays inline error banner when onboarding URL generation fails", async () => {
    m.status.mockResolvedValue({
      connected: false,
      status: "pending_onboarding",
      environment: "test",
      connect_configured: true,
    });
    m.onboarding.mockRejectedValue({
      detail: "Stripe Connect is not available yet. Please contact Zoiko support to enable it.",
    });

    render(<OrgAdminOrganizationPage />);

    const connectBtn = await screen.findByRole("button", { name: /connect stripe/i });
    fireEvent.click(connectBtn);

    const alerts = await screen.findAllByText("Stripe Connect is not available yet. Please contact Zoiko support to enable it.");
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });

  it("handles OAuth redirect error parameter gracefully and surfaces it in the card", async () => {
    window.history.replaceState(
      {},
      "",
      "/organization-admin/organization?error=access_denied&error_description=The+user+denied+your+request"
    );
    m.status.mockResolvedValue({
      connected: false,
      status: "pending_onboarding",
      environment: "test",
      connect_configured: true,
    });

    render(<OrgAdminOrganizationPage />);

    const alerts = await screen.findAllByText(/Stripe connection was not completed: The user denied your request/i);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(m.complete).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("shows ready badge and connected details when Stripe is active", async () => {
    m.status.mockResolvedValue({
      connected: true,
      status: "active",
      environment: "live",
      connect_configured: true,
      connected_account_id: "acct_1HxyzLive987",
      country: "US",
      default_currency: "USD",
      charges_enabled: true,
      payouts_enabled: true,
      connected_at: "2026-05-01T10:00:00Z",
    });

    render(<OrgAdminOrganizationPage />);

    expect(await screen.findByText("Ready for payments")).toBeInTheDocument();
    expect(screen.getByText("acct_1HxyzLive987")).toBeInTheDocument();
    expect(screen.getByText("Live mode")).toBeInTheDocument();
    expect(screen.getAllByText("Enabled")).toHaveLength(2); // Charges & Payouts
    expect(screen.getByRole("button", { name: /refresh status/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
  });
});
