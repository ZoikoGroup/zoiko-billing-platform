import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { renderWithRouter } from "./test/renderWithRouter";

// List pages fetch on every filter/search/page change. Several requests can be
// in flight at once and resolve out of order; without a guard an OLDER
// response landing last overwrote the newer one (typing "glo" and then seeing
// every customer again). Only the latest request may update state.

const m = vi.hoisted(() => ({
  customerList: vi.fn(),
  discountList: vi.fn(),
  listUsers: vi.fn(),
  getUserSummary: vi.fn(),
}));

vi.mock("../../service/billingService", () => ({
  customerApi: {
    list: (...a) => m.customerList(...a),
    getKPI: vi.fn(() => Promise.resolve(null)),
    create: vi.fn(), update: vi.fn(), activate: vi.fn(), deactivate: vi.fn(),
    suspend: vi.fn(), bulkDelete: vi.fn(), exportData: vi.fn(),
  },
  discountApi: { list: (...a) => m.discountList(...a), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() },
  settingsApi: {
    getConfig: vi.fn(() => Promise.resolve({ base_currency: "USD", default_currency: "USD" })),
    get: vi.fn(() => Promise.resolve({ default_currency: "USD" })),
  },
}));
vi.mock("../../service/userManagementService", () => ({
  listUsers: (...a) => m.listUsers(...a),
  getUserSummary: (...a) => m.getUserSummary(...a),
  inviteUser: vi.fn(), updateUser: vi.fn(), deactivateUser: vi.fn(), resendInvite: vi.fn(),
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: () => ({ user: { id: 1, role: "org_admin" } }) }));
vi.mock("../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));

import CustomerListPage from "./customers/customer-list";
import DiscountEnginePage from "./pricing/discount-engine";
import OrgAdminUserManagementPage from "../organization-admin/UserManagementPage";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const flush = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  vi.clearAllMocks();
  m.getUserSummary.mockResolvedValue({ total: 2, active: 2, pending: 0, suspended: 0, invited: 0 });
});
afterEach(() => cleanup());

// ── Customer list ────────────────────────────────────────────────────────────
const cust = (id, display_name, status = "active") => ({
  id, display_name, company_name: `${display_name} Ltd`, email: `${id}@x.com`, status, customer_type: "business",
  currency: "USD", created_at: "2026-01-01T00:00:00Z", outstanding_balance: 0, total_revenue: 0, credit_limit: 0,
});

describe("CustomerListPage", () => {
  it("?status=active: the very first request is already filtered", async () => {
    m.customerList.mockResolvedValue({ items: [cust(1, "Acme")], total: 1 });
    renderWithRouter(<CustomerListPage />, { initialEntries: ["/billing/customers?status=active"] });
    await waitFor(() => expect(m.customerList).toHaveBeenCalled());
    expect(m.customerList.mock.calls[0][0].status).toBe("active");
    await flush();
    expect(m.customerList.mock.calls.every((c) => c[0].status === "active")).toBe(true);
  });

  it("a slow older response cannot overwrite the newer search result", async () => {
    m.customerList.mockResolvedValue({ items: [cust(1, "Acme"), cust(2, "Globex")], total: 2 });
    renderWithRouter(<CustomerListPage />, { initialEntries: ["/billing/customers?status=active"] });
    await screen.findByText("Acme");

    // An older request (Refresh, no search) stays pending while a newer
    // search request resolves first.
    const slow = deferred();
    m.customerList.mockImplementation((params) => (params.search_term
      ? Promise.resolve({ items: [cust(2, "Globex")], total: 1 })
      : slow.promise));
    fireEvent.click(screen.getByRole("button", { name: /refresh list/i }));
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "glo" } });
    await waitFor(() => expect(m.customerList.mock.calls.some((c) => c[0].search_term === "glo")).toBe(true));
    await waitFor(() => expect(screen.queryByText("Acme")).toBeNull());
    expect(screen.getByText("Globex")).toBeInTheDocument();

    slow.resolve({ items: [cust(1, "Acme"), cust(2, "Globex")], total: 2 });
    await flush();
    expect(screen.queryByText("Acme")).toBeNull();
    expect(m.customerList.mock.calls.every((c) => c[0].status === "active")).toBe(true);
  });
});

// ── Pricing: discount engine ─────────────────────────────────────────────────
const disc = (id, name) => ({ id, name, code: name.toUpperCase(), discount_type: "coupon", discount_value: 10, value_type: "percentage", currency: "USD", status: "active", is_active: true });

describe("DiscountEnginePage search", () => {
  it("typing 4 characters fires a single (debounced) search request", async () => {
    m.discountList.mockResolvedValue({ items: [disc(1, "Spring")], total: 1, page: 1, per_page: 20, pages: 1 });
    renderWithRouter(<DiscountEnginePage />);
    await screen.findByText("Spring");
    const input = screen.getByPlaceholderText(/search discounts/i);
    for (const v of ["a", "ac", "acm", "acme"]) fireEvent.change(input, { target: { value: v } });
    await waitFor(() => expect(m.discountList.mock.calls.some((c) => c[0].search_term)).toBe(true));
    await flush();
    const searchCalls = m.discountList.mock.calls.filter((c) => c[0].search_term);
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0][0].search_term).toBe("acme");
  });

  it("an older response cannot overwrite the newer search result", async () => {
    const slow = deferred();
    m.discountList.mockImplementation((params) => (params.search_term
      ? Promise.resolve({ items: [disc(2, "Acme Deal")], total: 1, page: 1, per_page: 20, pages: 1 })
      : slow.promise));
    renderWithRouter(<DiscountEnginePage />);
    fireEvent.change(screen.getByPlaceholderText(/search discounts/i), { target: { value: "acme" } });
    await screen.findByText("Acme Deal");
    slow.resolve({ items: [disc(1, "Old Unfiltered")], total: 1, page: 1, per_page: 20, pages: 1 });
    await flush();
    expect(screen.queryByText("Old Unfiltered")).toBeNull();
    expect(screen.getByText("Acme Deal")).toBeInTheDocument();
  });
});

// ── Organization admin: user management ──────────────────────────────────────
const user = (id, first_name) => ({ id, first_name, last_name: "User", email: `${first_name.toLowerCase()}@x.com`, role: "billing_user", is_active: true, is_verified: true });

describe("OrgAdminUserManagementPage search", () => {
  it("an older search response cannot overwrite the newer one", async () => {
    const slow = deferred();
    m.listUsers.mockImplementation(({ search }) => (search
      ? Promise.resolve({ users: [user(2, "Bob")], total: 1 })
      : slow.promise));
    renderWithRouter(<OrgAdminUserManagementPage />);
    await waitFor(() => expect(m.listUsers).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText(/search by name or email/i), { target: { value: "bob" } });
    await screen.findByText("Bob User");
    slow.resolve({ users: [user(1, "Alice"), user(2, "Bob")], total: 2 });
    await flush();
    expect(screen.queryByText("Alice User")).toBeNull();
    expect(screen.getByText("Bob User")).toBeInTheDocument();
  });
});
