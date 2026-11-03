import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Billing history uses the shared table: cards on phones, a table on
// desktop, same cells and empty states. Mocks as in
// billing-history.b7.hardening.test.jsx.

if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};
const m = vi.hoisted(() => ({ invList: vi.fn(), payList: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  invoiceApi: { list: (...a) => m.invList(...a) },
  paymentApi: { list: (...a) => m.payList(...a) },
  settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }), get: () => Promise.resolve({}) },
}));

import BillingHistoryPage from "./billing-history";

const INVOICES = [
  { id: 1, invoice_number: "INV-0001", customer_name: "Acme Corp", total_amount: 120, status: "paid", due_date: "2026-01-31", paid_at: "2026-01-20" },
  { id: 2, invoice_number: "INV-0002", customer_name: "Globex", total_amount: 80, status: "sent", due_date: "2026-02-28" },
];

const originalMatchMedia = window.matchMedia;
function emulatePhone() {
  window.matchMedia = (query) => ({
    matches: query === "(max-width: 767.98px)" || query === "(max-width: 639.98px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.invList.mockResolvedValue({ items: INVOICES, total: 2 });
  m.payList.mockResolvedValue({ items: [], total: 0 });
});
afterEach(() => { cleanup(); window.matchMedia = originalMatchMedia; });

describe("Billing history (shared table)", () => {
  it("desktop: a table with the invoice cells", async () => {
    render(<MemoryRouter><BillingHistoryPage /></MemoryRouter>);
    expect(await screen.findByText("INV-0001")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
  });

  it("phones: one card per invoice, no table", async () => {
    emulatePhone();
    render(<MemoryRouter><BillingHistoryPage /></MemoryRouter>);
    expect(await screen.findByText("INV-0001")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("INV-0002").closest("li")).not.toBeNull();
  });

  it("empty with a filter set shows the message and Clear filters", async () => {
    m.invList.mockResolvedValue({ items: [], total: 0 });
    render(<MemoryRouter><BillingHistoryPage /></MemoryRouter>);
    expect(await screen.findByText("No invoices found")).toBeInTheDocument();
    expect(screen.getByText("No invoices have been created yet")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search billing history"), { target: { value: "ZZZ" } });
    expect(await screen.findByText("No invoices match your filters")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Clear filters" }).length).toBeGreaterThan(1));
  });
});
