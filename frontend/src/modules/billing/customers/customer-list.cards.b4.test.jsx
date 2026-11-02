import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter } from "../test/renderWithRouter";

// Customer list on phones: one card per customer instead of the 13-column
// table, with the same selection, bulk actions, sort and open handlers.
// Mocks copied from customer-list.test.jsx.

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => ({ ...(await vi.importActual("react-router-dom")), useNavigate: () => mockNavigate }));
vi.mock("../../../service/billingService", () => ({
  customerApi: {
    list: vi.fn(), getKPI: vi.fn(() => Promise.resolve(null)), create: vi.fn(), update: vi.fn(),
    activate: vi.fn(() => Promise.resolve({})), deactivate: vi.fn(), suspend: vi.fn(), bulkDelete: vi.fn(), exportData: vi.fn(),
  },
  settingsApi: { getConfig: vi.fn(() => Promise.resolve({ base_currency: "USD" })) },
}));

import CustomerListPage from "./customer-list";
import { customerApi } from "../../../service/billingService";

const CUSTOMERS = [
  { id: 1, display_name: "Acme Corp", company_name: "Acme Corporation Ltd", email: "billing@acme.com", status: "active", customer_type: "business", currency: "USD", created_at: "2026-01-01T00:00:00Z", outstanding_balance: 0, total_revenue: 5000, credit_limit: 1000 },
  { id: 2, display_name: "Globex", company_name: "Globex Industries Inc", email: "ap@globex.com", status: "suspended", customer_type: "business", currency: "USD", created_at: "2026-02-01T00:00:00Z", outstanding_balance: 250, total_revenue: 1200, credit_limit: 500 },
];

const originalMatchMedia = window.matchMedia;
function emulatePhone() {
  window.matchMedia = (query) => ({
    matches: query === "(max-width: 639.98px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  customerApi.list.mockResolvedValue({ items: CUSTOMERS, total: CUSTOMERS.length });
});
afterEach(() => { window.matchMedia = originalMatchMedia; });

describe("Customer list cards (phones)", () => {
  it("renders one card per customer and no table", async () => {
    emulatePhone();
    renderWithRouter(<CustomerListPage />);
    await screen.findByText("Acme Corp");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem").filter((li) => li.querySelector("dl"))).toHaveLength(2);
    expect(screen.getByText("billing@acme.com")).toBeInTheDocument();
  });

  it("selecting a card shows the bulk bar and Activate acts on the selection", async () => {
    emulatePhone();
    renderWithRouter(<CustomerListPage />);
    await screen.findByText("Acme Corp");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Acme Corp" }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Activate/ }));
    await waitFor(() => expect(customerApi.activate).toHaveBeenCalledWith(1));
  });

  it("Select all selects every card", async () => {
    emulatePhone();
    renderWithRouter(<CustomerListPage />);
    await screen.findByText("Acme Corp");
    fireEvent.click(screen.getByRole("checkbox", { name: /Select all/ }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
  });

  it("the sort menu re-queries with the chosen field and direction", async () => {
    emulatePhone();
    renderWithRouter(<CustomerListPage />);
    await screen.findByText("Acme Corp");
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "created_at:desc" } });
    await waitFor(() => expect(customerApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: "created_at", sort_order: "desc" })));
  });

  it("the name and View open the customer", async () => {
    emulatePhone();
    renderWithRouter(<CustomerListPage />);
    await screen.findByText("Acme Corp");
    const card = screen.getByText("Acme Corp").closest("li");
    fireEvent.click(within(card).getByRole("button", { name: "View Acme Corp" }));
    expect(mockNavigate).toHaveBeenCalledWith("/billing/customers/1");
  });
});
