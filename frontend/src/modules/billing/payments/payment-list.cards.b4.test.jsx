import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Payment list on phones: one card per payment instead of the 8-column
// table; same selection, sort and open handlers. Mocks as in
// payment-list.test.jsx.

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => ({ ...(await vi.importActual("react-router-dom")), useNavigate: () => mockNavigate }));
const mockPaymentList = vi.fn();
vi.mock("../../../service/billingService", () => ({
  paymentApi: {
    list: (...a) => mockPaymentList(...a), create: vi.fn(), allocate: vi.fn(),
    listMethods: vi.fn(() => Promise.resolve([])), updateStatus: vi.fn(() => Promise.resolve({})),
    getDashboardStats: vi.fn(() => Promise.resolve({ cleared_amount: 0, cleared_count: 0, avg_payment_value: 0, refunded_amount: 0, refunded_count: 0, outstanding_amount: 0, pending_count: 0, avg_per_day: 0, avg_per_day_window_days: 30, cleared_amount_last_30_days: 0 })),
  },
  invoiceApi: { list: vi.fn(() => Promise.resolve([])), get: vi.fn() },
  customerApi: { search: vi.fn(() => Promise.resolve([])), get: vi.fn() },
  creditNoteApi: { list: vi.fn(() => Promise.resolve([])) },
  settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }) },
}));
if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};

import PaymentListPage from "./payment-list";

const PAYMENTS = [
  { id: 11, payment_number: "PAY-0011", customer_name: "Acme Corp", amount: 120, currency: "USD", payment_method: "card", status: "completed", payment_date: "2026-01-20" },
  { id: 12, payment_number: "PAY-0012", customer_name: "Globex", amount: 80, currency: "USD", payment_method: "bank_transfer", status: "pending", payment_date: "2026-02-02" },
];

const originalMatchMedia = window.matchMedia;
function emulatePhone() {
  window.matchMedia = (query) => ({
    matches: query === "(max-width: 639.98px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  });
}

beforeEach(() => { vi.clearAllMocks(); mockPaymentList.mockResolvedValue({ items: PAYMENTS, total: 2 }); });
afterEach(() => { cleanup(); window.matchMedia = originalMatchMedia; });

const renderPage = () => render(<MemoryRouter><PaymentListPage /></MemoryRouter>);

describe("Payment list cards (phones)", () => {
  it("renders one card per payment and no table", async () => {
    emulatePhone();
    renderPage();
    await screen.findByText("PAY-0011");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("PAY-0012").closest("li")).not.toBeNull();
    expect(screen.getByText("Globex")).toBeInTheDocument();
  });

  it("Select all and a card checkbox drive the same selection", async () => {
    emulatePhone();
    renderPage();
    await screen.findByText("PAY-0011");
    const one = screen.getByRole("checkbox", { name: "Select payment PAY-0011" });
    fireEvent.click(one);
    expect(one).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all payments" }));
    expect(screen.getByRole("checkbox", { name: "Select payment PAY-0012" })).toBeChecked();
  });

  it("the sort menu re-queries with the chosen order", async () => {
    emulatePhone();
    renderPage();
    await screen.findByText("PAY-0011");
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "amount:desc" } });
    await waitFor(() => expect(mockPaymentList).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: "amount", sort_order: "desc" }), expect.anything()));
  });

  it("View opens the payment", async () => {
    emulatePhone();
    renderPage();
    await screen.findByText("PAY-0011");
    fireEvent.click(within(screen.getByText("PAY-0011").closest("li")).getByRole("button", { name: "View payment PAY-0011" }));
    expect(mockNavigate).toHaveBeenCalledWith("/billing/payments/11");
  });
});
