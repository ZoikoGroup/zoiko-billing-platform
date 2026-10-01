import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter } from "../test/renderWithRouter";
import { axe } from "../../../test/a11y";

vi.mock("../../../service/billingService", () => ({
  customerApi: {
    list: vi.fn(),
    getKPI: vi.fn(() => Promise.resolve(null)),
    create: vi.fn(),
    update: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
    suspend: vi.fn(),
    bulkDelete: vi.fn(),
    exportData: vi.fn(),
  },
  settingsApi: {
    getConfig: vi.fn(() => Promise.resolve({ base_currency: "USD" })),
  },
}));

import CustomerListPage from "./customer-list";
import { customerApi } from "../../../service/billingService";

const CUSTOMERS = [
  { id: 1, display_name: "Acme Corp", company_name: "Acme Corporation Ltd", email: "billing@acme.com", status: "active", customer_type: "business", currency: "USD", created_at: "2026-01-01T00:00:00Z", outstanding_balance: 0, total_revenue: 5000, credit_limit: 1000 },
  { id: 2, display_name: "Globex", company_name: "Globex Industries Inc", email: "ap@globex.com", status: "suspended", customer_type: "business", currency: "USD", created_at: "2026-02-01T00:00:00Z", outstanding_balance: 250, total_revenue: 1200, credit_limit: 500 },
];

// The create/edit modal renders each field as <div><label>Label</label><input/></div>
// with no htmlFor/id association (a real gap — see docs/ACCESSIBILITY_TEST_STRATEGY.md),
// so getByLabelText can't resolve them. Locate by the label's sibling instead.
function fieldByLabel(container, labelPattern) {
  const label = within(container).getByText(labelPattern);
  return label.parentElement.querySelector("input, select, textarea");
}

beforeEach(() => {
  vi.clearAllMocks();
  customerApi.list.mockResolvedValue({ items: CUSTOMERS, total: CUSTOMERS.length });
  customerApi.getKPI.mockResolvedValue(null);
});

describe("CustomerListPage", () => {
  it("shows a loading state before data arrives", async () => {
    let resolveList;
    customerApi.list.mockReturnValue(new Promise((res) => { resolveList = res; }));
    renderWithRouter(<CustomerListPage />);
    expect(screen.getByLabelText(/loading content/i)).toBeInTheDocument();
    resolveList({ items: [], total: 0 });
    await waitFor(() => expect(screen.queryByLabelText(/loading content/i)).not.toBeInTheDocument());
  });

  it("renders the customer list with real data once loaded", async () => {
    renderWithRouter(<CustomerListPage />);
    await waitFor(() => expect(screen.getByText("Acme Corp")).toBeInTheDocument());
    expect(screen.getByText("Globex")).toBeInTheDocument();
    expect(screen.getByText("billing@acme.com")).toBeInTheDocument();
    // Real API params were sent, not a hardcoded/faked call
    expect(customerApi.list).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, per_page: 15, sort_by: "company_name", sort_order: "asc" })
    );
  });

  it("has no accessibility violations once the list has loaded (axe-core)", async () => {
    const { container } = renderWithRouter(<CustomerListPage />);
    await waitFor(() => expect(screen.getByText("Acme Corp")).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows an empty state when there are no customers", async () => {
    customerApi.list.mockResolvedValue({ items: [], total: 0 });
    renderWithRouter(<CustomerListPage />);
    await waitFor(() => expect(screen.getByText(/add your first/i)).toBeInTheDocument());
  });

  it("shows an error state with retry when the API call fails", async () => {
    customerApi.list.mockRejectedValue(new Error("Network error"));
    renderWithRouter(<CustomerListPage />);
    await waitFor(() => expect(screen.getByText("Network error")).toBeInTheDocument());
    const retry = screen.getByRole("button", { name: /try again/i });

    customerApi.list.mockResolvedValue({ items: CUSTOMERS, total: CUSTOMERS.length });
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText("Acme Corp")).toBeInTheDocument());
  });

  it("blocks customer creation without a company name or a valid email", async () => {
    renderWithRouter(<CustomerListPage />);
    await waitFor(() => expect(screen.getByText("Acme Corp")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /new customer/i }));
    const dialog = screen.getByRole("heading", { name: /^New Customer$/i }).closest("div").parentElement;

    // Company name required, so the Create button starts disabled.
    const createBtn = within(dialog).getByRole("button", { name: /^create/i });
    expect(createBtn).toBeDisabled();

    fireEvent.change(fieldByLabel(dialog, /company name/i), { target: { value: "New Co" } });
    expect(createBtn).not.toBeDisabled();

    fireEvent.click(createBtn);
    // Email is required too — the handler bails out with a form error and
    // never calls the API with an incomplete payload.
    await waitFor(() => expect(screen.getByText(/email is required/i)).toBeInTheDocument());
    expect(customerApi.create).not.toHaveBeenCalled();
  });

  it("creates a customer with a valid payload and refreshes the list", async () => {
    customerApi.create.mockResolvedValue({ id: 3 });
    renderWithRouter(<CustomerListPage />);
    await waitFor(() => expect(screen.getByText("Acme Corp")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /new customer/i }));
    const dialog = screen.getByRole("heading", { name: /^New Customer$/i }).closest("div").parentElement;
    fireEvent.change(fieldByLabel(dialog, /company name/i), { target: { value: "New Co" } });
    fireEvent.change(fieldByLabel(dialog, /^email/i), { target: { value: "new@co.com" } });

    fireEvent.click(within(dialog).getByRole("button", { name: /^create/i }));

    await waitFor(() => expect(customerApi.create).toHaveBeenCalledTimes(1));
    const payload = customerApi.create.mock.calls[0][0];
    expect(payload.company_name).toBe("New Co");
    expect(payload.email).toBe("new@co.com");
    // Refetches after a successful create so the new customer shows up.
    await waitFor(() => expect(customerApi.list).toHaveBeenCalledTimes(2));
  });

  describe("entitlement limit reached on create", () => {
    // Shape produced by service/api.js's apiRequest for a
    // SUBSCRIPTION_LIMIT_REACHED response — see api.js's isEntitlementLimitError
    // and the "preserves the structured ... payload" test in api.test.js.
    const LIMIT_ERROR = Object.assign(new Error("'org.entity.max' limit (2) exceeded."), {
      status: 403,
      code: "SUBSCRIPTION_LIMIT_REACHED",
      entity: "customer",
      currentUsage: 5,
      limit: 2,
      remaining: 0,
      planName: "Professional",
    });

    async function openCreateModalAndSubmit() {
      renderWithRouter(<CustomerListPage />);
      await waitFor(() => expect(screen.getByText("Acme Corp")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("button", { name: /new customer/i }));
      const dialog = screen.getByRole("heading", { name: /^New Customer$/i }).closest("div").parentElement;
      fireEvent.change(fieldByLabel(dialog, /company name/i), { target: { value: "New Co" } });
      fireEvent.change(fieldByLabel(dialog, /^email/i), { target: { value: "new@co.com" } });
      fireEvent.click(within(dialog).getByRole("button", { name: /^create/i }));
      return dialog;
    }

    it("shows the Subscription Limit Reached panel instead of a raw 403 or the technical entitlement key", async () => {
      customerApi.create.mockRejectedValue(LIMIT_ERROR);
      const dialog = await openCreateModalAndSubmit();

      await waitFor(() => expect(within(dialog).getByText(/customer limit reached/i)).toBeInTheDocument());
      expect(within(dialog).queryByText(/org\.entity\.max/)).not.toBeInTheDocument();
      expect(within(dialog).queryByText(/403/)).not.toBeInTheDocument();
      expect(within(dialog).queryByText(/failed to create customer/i)).not.toBeInTheDocument();
    });

    it("displays the plan name, current usage, and limit accurately", async () => {
      customerApi.create.mockRejectedValue(LIMIT_ERROR);
      const dialog = await openCreateModalAndSubmit();

      await waitFor(() => expect(within(dialog).getByText(/professional/i)).toBeInTheDocument());
      expect(within(dialog).getByText(/current usage/i)).toBeInTheDocument();
      expect(within(dialog).getByText("5")).toBeInTheDocument();
    });

    it("words the already-over-limit case accurately instead of claiming remaining capacity", async () => {
      // Existing usage (5) is already above the limit (2) — matches the real
      // demo-org condition (see ENTITLEMENT INVESTIGATION report).
      customerApi.create.mockRejectedValue(LIMIT_ERROR);
      const dialog = await openCreateModalAndSubmit();

      await waitFor(() =>
        expect(within(dialog).getByText(/already above the current plan limit/i)).toBeInTheDocument()
      );
      expect(within(dialog).queryByText(/0 remaining/i)).not.toBeInTheDocument();
      expect(within(dialog).queryByText(/5 \/ 2/)).not.toBeInTheDocument(); // not a "usage / limit" framing when over
    });

    it("does not render a subscription-management action (no org-admin route exists) and Close dismisses the panel", async () => {
      customerApi.create.mockRejectedValue(LIMIT_ERROR);
      const dialog = await openCreateModalAndSubmit();
      await waitFor(() => expect(within(dialog).getByText(/customer limit reached/i)).toBeInTheDocument());

      expect(within(dialog).queryByRole("button", { name: /view subscription/i })).not.toBeInTheDocument();

      fireEvent.click(within(dialog).getByRole("button", { name: /^close$/i }));
      await waitFor(() => expect(within(dialog).queryByText(/customer limit reached/i)).not.toBeInTheDocument());
      // Entered form data survives dismissing the limit panel.
      expect(fieldByLabel(dialog, /company name/i).value).toBe("New Co");
    });

    it("a non-entitlement create failure still shows the plain generic error banner", async () => {
      customerApi.create.mockRejectedValue(new Error("Duplicate customer code"));
      const dialog = await openCreateModalAndSubmit();

      await waitFor(() => expect(within(dialog).getByText("Duplicate customer code")).toBeInTheDocument());
      expect(within(dialog).queryByText(/limit reached/i)).not.toBeInTheDocument();
    });
  });
});
