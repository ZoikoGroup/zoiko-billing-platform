import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// B4-11: typing in Edit Organization lost focus after every character
// (EditField was declared inside the page body and remounted each render).
// B4-12: Connect Stripe failed on click when Connect isn't configured.
// B4-13: dialog semantics, validation, and no Edit for billing admins.

const m = vi.hoisted(() => ({
  details: vi.fn(), update: vi.fn(), status: vi.fn(), onboarding: vi.fn(), role: { value: "org_admin" },
}));
vi.mock("../../service/orgAdminService", () => ({
  getOrganizationDetails: (...a) => m.details(...a),
  updateOrganizationDetails: (...a) => m.update(...a),
}));
vi.mock("../../service/billingService", () => ({
  stripeConnectApi: {
    getStatus: (...a) => m.status(...a), getOnboardingUrl: (...a) => m.onboarding(...a),
    sync: vi.fn(), disconnect: vi.fn(), completeOAuth: vi.fn(),
  },
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: () => ({ user: { role: m.role.value } }) }));

import OrgAdminOrganizationPage, { validateOrgForm } from "./OrganizationPage";

const org = { name: "Acme Org", code: "ACME", status: "active", currency: "INR", timezone: "UTC", industry: "", address: "" };

beforeEach(() => {
  vi.clearAllMocks();
  m.role.value = "org_admin";
  m.details.mockResolvedValue(org);
  m.update.mockResolvedValue({});
  m.status.mockResolvedValue({ connected: false, status: "pending_onboarding", environment: "test", connect_configured: true });
});
afterEach(() => cleanup());

const openEdit = async () => {
  render(<OrgAdminOrganizationPage />);
  fireEvent.click(await screen.findByRole("button", { name: /edit organization/i }));
  return screen.getByRole("dialog", { name: /edit organization/i });
};

describe("B4-11 Edit Organization typing", () => {
  it("keeps the same input (and focus) across keystrokes", async () => {
    await openEdit();
    const industry = screen.getByLabelText("Industry");
    industry.focus();
    let typed = "";
    for (const ch of "Fintech") {
      typed += ch;
      fireEvent.change(screen.getByLabelText("Industry"), { target: { value: typed } });
      // A remounted input is a different DOM node and would have dropped focus.
      expect(screen.getByLabelText("Industry")).toBe(industry);
    }
    expect(industry).toHaveValue("Fintech");
    expect(document.activeElement).toBe(industry);
  });
});

describe("B4-13 Edit Organization dialog", () => {
  it("validates the name with the backend rule instead of surfacing a raw 422", async () => {
    await openEdit();
    fireEvent.change(screen.getByLabelText("Organization Name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByText("Organization name is required.")).toBeInTheDocument();
    expect(m.update).not.toHaveBeenCalled();
  });

  it("Escape closes the dialog", async () => {
    await openEdit();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("billing admins get a read-only view (no Edit organization)", async () => {
    m.role.value = "billing_admin";
    render(<OrgAdminOrganizationPage />);
    expect(await screen.findByText("Organization details")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit organization/i })).toBeNull();
  });

  it("validateOrgForm mirrors the backend currency rule", () => {
    expect(validateOrgForm({ name: "A", currency: "US" }).currency).toBeTruthy();
    expect(validateOrgForm({ name: "A", currency: "usd" })).toEqual({});
    expect(validateOrgForm({ name: "A", currency: "" })).toEqual({});
  });
});

describe("B4-12 Connect Stripe availability", () => {
  it("Connect is disabled with an explanation when the platform hasn't enabled Connect", async () => {
    m.status.mockResolvedValue({ connected: false, status: "pending_onboarding", environment: "test", connect_configured: false });
    render(<OrgAdminOrganizationPage />);
    expect(await screen.findByText(/Stripe Connect isn't available on this platform yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /connect stripe/i })).toBeDisabled();
    expect(m.onboarding).not.toHaveBeenCalled();
  });

  it("Connect stays available when configured", async () => {
    render(<OrgAdminOrganizationPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: /connect stripe/i })).toBeEnabled());
  });
});
