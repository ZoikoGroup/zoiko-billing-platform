import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

// B14 (/organization-admin/organization): "after clicking Edit Organization
// I must select a field every time before entering anything", "the edit form
// does not show everything", and page UI. The form exposed 5 of the ~17
// fields the API returns and accepts, opened with nothing focused, and sent
// every field (blanking untouched ones was only avoided by luck).

const m = vi.hoisted(() => ({ details: vi.fn(), update: vi.fn(), role: { value: "org_admin" } }));
vi.mock("../../service/orgAdminService", () => ({
  getOrganizationDetails: (...a) => m.details(...a),
  updateOrganizationDetails: (...a) => m.update(...a),
}));
vi.mock("../../service/billingService", () => ({
  stripeConnectApi: {
    getStatus: () => Promise.resolve({ connected: false, status: "pending_onboarding", connect_configured: false }),
    getOnboardingUrl: vi.fn(), sync: vi.fn(), disconnect: vi.fn(), completeOAuth: vi.fn(),
  },
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: () => ({ user: { role: m.role.value } }) }));

import OrgAdminOrganizationPage, { orgFormChanges, orgToForm, validateOrgForm } from "./OrganizationPage";

const ORG = {
  name: "Acme Org", code: "ACME", status: "active", created_at: "2026-01-01T00:00:00Z",
  legal_name: "Acme Holdings Pvt Ltd", industry: "Software", email: "billing@acme.example", phone: "+91 98 7654 3210",
  website: "https://acme.example", address: "1 Main St", city: "Pune", state: "MH", postal_code: "411001", country: "India",
  currency: "INR", timezone: "Asia/Kolkata", fiscal_year_start: "04-01", fiscal_year_end: "03-31",
  tax_no: "27AAAPL1234C1ZV", registration_number: "U72200MH2020PTC123456",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.role.value = "org_admin";
  m.details.mockResolvedValue({ ...ORG });
  m.update.mockResolvedValue({});
});
afterEach(() => cleanup());

const openEdit = async () => {
  render(<OrgAdminOrganizationPage />);
  fireEvent.click(await screen.findByRole("button", { name: /edit organization/i }));
  return screen.getByRole("dialog", { name: /edit organization/i });
};

describe("B14-A typing and focus", () => {
  it("opens with the cursor already in Organization Name (no click needed)", async () => {
    await openEdit();
    expect(document.activeElement).toBe(screen.getByLabelText("Organization Name"));
  });

  it("several fields accept continuous typing without losing focus or remounting", async () => {
    await openEdit();
    for (const label of ["Legal Name", "Email", "City"]) {
      const input = screen.getByLabelText(label);
      input.focus();
      let v = "";
      for (const ch of "abc") {
        v += ch;
        fireEvent.change(screen.getByLabelText(label), { target: { value: v } });
        expect(screen.getByLabelText(label)).toBe(input);
      }
      expect(document.activeElement).toBe(input);
    }
  });
});

describe("B14-B fields", () => {
  it("every API-supported field is shown with its saved value; system fields are read-only", async () => {
    const dialog = await openEdit();
    const expectations = {
      "Organization Name": "Acme Org", "Legal Name": "Acme Holdings Pvt Ltd", Industry: "Software",
      Email: "billing@acme.example", Phone: "+91 98 7654 3210", Website: "https://acme.example",
      "Street Address": "1 Main St", City: "Pune", "State / Region": "MH", "Postal Code": "411001", Country: "India",
      Currency: "INR", Timezone: "Asia/Kolkata", "Fiscal Year Start": "04-01", "Fiscal Year End": "03-31",
      "Tax ID": "27AAAPL1234C1ZV", "Registration Number": "U72200MH2020PTC123456",
    };
    for (const [label, value] of Object.entries(expectations)) expect(within(dialog).getByLabelText(label)).toHaveValue(value);
    const readOnly = within(dialog).getByLabelText("Read-only organization details");
    expect(readOnly).toHaveTextContent("ACME");
    expect(within(dialog).queryByLabelText(/organization code/i)).toBeNull();
  });

  it("the overview shows the same fields", async () => {
    render(<OrgAdminOrganizationPage />);
    for (const v of ["Acme Holdings Pvt Ltd", "billing@acme.example", "Pune", "27AAAPL1234C1ZV", "U72200MH2020PTC123456"]) {
      expect(await screen.findByText(v)).toBeInTheDocument();
    }
  });
});

describe("B14 save behaviour", () => {
  it("sends only changed fields; a cleared optional field is sent as null", async () => {
    await openEdit();
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "+91 11 2222 3333" } });
    fireEvent.change(screen.getByLabelText("Website"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    expect(m.update.mock.calls[0][0]).toEqual({ phone: "+91 11 2222 3333", website: null });
  });

  it("invalid email / fiscal date are caught before the API, next to the field", async () => {
    await openEdit();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "not-an-email" } });
    fireEvent.change(screen.getByLabelText("Fiscal Year Start"), { target: { value: "13-40" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Use MM-DD, e.g. 04-01.")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
    expect(m.update).not.toHaveBeenCalled();
  });

  it("a failed save keeps the dialog and the user's input; the page keeps the saved value", async () => {
    m.update.mockRejectedValueOnce(new Error("Email: value is not a valid email address"));
    await openEdit();
    fireEvent.change(screen.getByLabelText("Legal Name"), { target: { value: "New Legal Ltd" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not a valid email/);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Legal Name")).toHaveValue("New Legal Ltd");
  });

  it("double-clicking Save sends one request; success refreshes from the server", async () => {
    let resolve; m.update.mockImplementation(() => new Promise((r) => { resolve = r; }));
    await openEdit();
    fireEvent.change(screen.getByLabelText("Industry"), { target: { value: "Fintech" } });
    const save = screen.getByRole("button", { name: /save changes/i });
    fireEvent.click(save); fireEvent.click(save);
    expect(m.update).toHaveBeenCalledTimes(1);
    m.details.mockResolvedValue({ ...ORG, industry: "Fintech" });
    resolve({});
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.details).toHaveBeenCalledTimes(2);
  });

  it("Cancel discards edits; reopening shows the saved values", async () => {
    await openEdit();
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "Mumbai" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /edit organization/i }));
    expect(screen.getByLabelText("City")).toHaveValue("Pune");
    expect(m.update).not.toHaveBeenCalled();
  });

  it("billing admins get no edit control", async () => {
    m.role.value = "billing_admin";
    render(<OrgAdminOrganizationPage />);
    expect(await screen.findByText("Acme Holdings Pvt Ltd")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit organization/i })).toBeNull();
  });
});

describe("B14 helpers mirror the backend", () => {
  it("orgFormChanges trims, upper-cases currency and never nulls the name", () => {
    const original = orgToForm(ORG);
    expect(orgFormChanges({ ...original, currency: "usd", name: "  Acme Org  " }, original)).toEqual({ currency: "USD" });
    expect(validateOrgForm({ ...original, name: " " }).name).toBeTruthy();
    expect(validateOrgForm({ ...original, postal_code: "x".repeat(21) }).postal_code).toBeTruthy();
  });
});
