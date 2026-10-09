import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// B14 dual-role: Billing Admins see organization details read-only here. The
// address/registration fields came only from the billing configuration, so
// details an Organization Admin saved on the Organization page never showed.
// Billing configuration still wins when it has a value.

const m = vi.hoisted(() => ({ config: vi.fn(), org: vi.fn() }));
vi.mock("../../context/AuthContext", () => ({ useAuth: () => ({ user: { id: 2, role: "billing_admin" }, role: "billing_admin" }) }));
vi.mock("../../service/billingConfigCache", () => ({ loadGlobalBillingConfig: (...a) => m.config(...a) }));
vi.mock("../../service/orgAdminService", () => ({ getOrganizationDetails: (...a) => m.org(...a) }));

import WorkspaceOrganizationPage from "./WorkspaceOrganizationPage";

const ORG = { name: "Acme Org", code: "ACME", status: "active", legal_name: "Acme Holdings Pvt Ltd", city: "Pune", state: "MH", postal_code: "411001", country: "India",
  tax_no: "27AAAPL1234C1ZV", registration_number: "U72200MH2020PTC123456", fiscal_year_start: "04-01", fiscal_year_end: "03-31", currency: "INR", timezone: "Asia/Kolkata" };

beforeEach(() => { vi.clearAllMocks(); m.org.mockResolvedValue(ORG); });
afterEach(() => cleanup());

describe("Billing Admin organization view", () => {
  it("shows organization-record details when the billing configuration has none", async () => {
    m.config.mockResolvedValue({});
    render(<MemoryRouter><WorkspaceOrganizationPage /></MemoryRouter>);
    for (const v of ["Acme Holdings Pvt Ltd", "Pune", "411001", "27AAAPL1234C1ZV", "U72200MH2020PTC123456"]) {
      expect((await screen.findAllByText(v)).length).toBeGreaterThan(0);
    }
    // Billing Admins may edit the billing-config company profile, not the organization record.
    expect(screen.queryByRole("button", { name: /edit organization/i })).toBeNull();
  });

  it("billing configuration values still take precedence", async () => {
    m.config.mockResolvedValue({ city: "Mumbai" });
    render(<MemoryRouter><WorkspaceOrganizationPage /></MemoryRouter>);
    expect((await screen.findAllByText("Mumbai")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Pune")).toBeNull();
  });
});
