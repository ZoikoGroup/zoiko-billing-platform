import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// This suite covers PaymentListPage's "Record Payment" wizard — the single
// place on this page that writes money: it creates a payment (paymentApi.create)
// and, when an invoice was selected, allocates it against that invoice
// (paymentApi.allocate). We verify the happy path calls create with the
// expected shape, that client-side amount validation actually blocks
// submission, and that the multi-step wizard structure itself gates the
// create call (only the step-4 "Record Payment" button invokes it).

const mockPaymentList = vi.fn();
const mockPaymentCreate = vi.fn();
const mockPaymentAllocate = vi.fn();
const mockPaymentListMethods = vi.fn();
const mockPaymentUpdateStatus = vi.fn();
const mockPaymentGetDashboardStats = vi.fn();
const mockInvoiceList = vi.fn();
const mockInvoiceGet = vi.fn();
const mockCustomerSearch = vi.fn();
const mockCustomerGet = vi.fn();
const mockCreditNoteList = vi.fn();

vi.mock("../../../service/billingService", () => ({
  paymentApi: {
    list: (...args) => mockPaymentList(...args),
    create: (...args) => mockPaymentCreate(...args),
    allocate: (...args) => mockPaymentAllocate(...args),
    listMethods: (...args) => mockPaymentListMethods(...args),
    updateStatus: (...args) => mockPaymentUpdateStatus(...args),
    getDashboardStats: (...args) => mockPaymentGetDashboardStats(...args),
  },
  invoiceApi: {
    list: (...args) => mockInvoiceList(...args),
    get: (...args) => mockInvoiceGet(...args),
  },
  customerApi: {
    search: (...args) => mockCustomerSearch(...args),
    get: (...args) => mockCustomerGet(...args),
  },
  creditNoteApi: {
    list: (...args) => mockCreditNoteList(...args),
  },
  // useCurrency() falls back to this on mount when no currency is cached yet;
  // stub it so the async lookup resolves quietly instead of hitting a real
  // network call from jsdom.
  settingsApi: {
    getConfig: () => Promise.resolve({ base_currency: "USD" }),
  },
}));

// jsdom does not implement Element.scrollTo; some shared billing components
// invoke it defensively. Polyfill so rendering the full page is valid.
if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollTo =
    HTMLElement.prototype.scrollTo || function scrollToPolyfill() {};
}

import PaymentListPage from "./payment-list";

const CUSTOMER = {
  id: 42,
  display_name: "Acme Corp",
  email: "acme@example.com",
  phone: "555-1000",
  currency: "USD",
};

function renderPage() {
  return render(
    <MemoryRouter>
      <PaymentListPage />
    </MemoryRouter>
  );
}

function setDefaultMocks() {
  mockPaymentList.mockResolvedValue({ items: [], total: 0 });
  mockPaymentCreate.mockResolvedValue({ id: 999 });
  mockPaymentAllocate.mockResolvedValue({ amount: 0 });
  mockPaymentListMethods.mockResolvedValue([]);
  mockPaymentUpdateStatus.mockResolvedValue({});
  mockPaymentGetDashboardStats.mockResolvedValue({
    cleared_amount: 0, cleared_count: 0, avg_payment_value: 0,
    refunded_amount: 0, refunded_count: 0,
    outstanding_amount: 0, pending_count: 0,
    avg_per_day: 0, avg_per_day_window_days: 30, cleared_amount_last_30_days: 0,
  });
  mockInvoiceList.mockResolvedValue({ items: [] });
  mockInvoiceGet.mockResolvedValue({});
  mockCustomerSearch.mockResolvedValue([CUSTOMER]);
  mockCustomerGet.mockResolvedValue(CUSTOMER);
  mockCreditNoteList.mockResolvedValue({ items: [] });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  setDefaultMocks();
});

async function openWizardAndSelectCustomer() {
  await waitFor(() => expect(mockPaymentList).toHaveBeenCalled());
  await screen.findByRole("heading", { name: "Payments" });

  fireEvent.click(screen.getByRole("button", { name: "Record Payment" }));
  await screen.findByText("Select Customer");

  const searchBox = screen.getByPlaceholderText(/search customers by name, email, or phone/i);
  fireEvent.change(searchBox, { target: { value: "Acme" } });

  await waitFor(() => expect(mockCustomerSearch).toHaveBeenCalledWith("Acme", 10), { timeout: 2000 });

  const result = await screen.findByText("Acme Corp");
  fireEvent.click(result);

  // Selecting a customer triggers loadCustomerData (invoice/credit/payment/method lookups).
  await waitFor(() => expect(mockPaymentListMethods).toHaveBeenCalledWith(42));
}

function setAmount(value) {
  fireEvent.change(screen.getByLabelText("Amount *"), { target: { value } });
}

function clickContinue() {
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

function clickFinalSubmit() {
  const buttons = screen.getAllByRole("button", { name: "Record Payment" });
  fireEvent.click(buttons[buttons.length - 1]);
}

describe("Record Payment wizard — happy path", () => {
  it("submits a manual payment (no invoice) with the expected fields, exactly once", async () => {
    renderPage();
    await openWizardAndSelectCustomer();

    setAmount("500");
    clickContinue(); // step 1 -> 2 (Allocation)
    await screen.findByText("Payment Allocation");
    clickContinue(); // step 2 -> 3 (Review)
    await screen.findByText("Review Payment");
    clickContinue(); // step 3 -> 4 (Confirm)
    await screen.findByText("Confirm Payment");

    clickFinalSubmit();

    await waitFor(() => expect(mockPaymentCreate).toHaveBeenCalledTimes(1));
    expect(mockPaymentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer_id: 42,
        amount: 500,
        currency: "USD",
        payment_type: "manual", // no invoice selected -> business category is "manual"
        gateway: "bank_transfer", // default payment method maps to this gateway
        exchange_rate: 1,
        gateway_fee: 0,
        payment_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      })
    );

    // No invoice was selected, so there is nothing to allocate.
    expect(mockPaymentAllocate).not.toHaveBeenCalled();
    await screen.findByText(/payment recorded successfully/i);
  });
});

describe("Record Payment wizard — client-side validation", () => {
  it("rejects a negative amount and does not call the create API", async () => {
    renderPage();
    await openWizardAndSelectCustomer();

    // A negative amount is truthy, so the Continue button (disabled only on
    // falsy customer_id/amount) is enabled, but the explicit numeric check
    // inside the Continue handler rejects it.
    setAmount("-50");
    clickContinue();

    await screen.findByText(/please enter a valid payment amount/i);
    // Still on step 1 — Allocation step never rendered.
    expect(screen.queryByText("Payment Allocation")).toBeNull();
    expect(mockPaymentCreate).not.toHaveBeenCalled();
  });

  it("disables Continue and blocks progress while amount is zero", async () => {
    renderPage();
    await openWizardAndSelectCustomer();

    // Amount defaults to 0 with no invoice selected.
    const continueBtn = screen.getByRole("button", { name: "Continue" });
    expect(continueBtn).toBeDisabled();

    fireEvent.click(continueBtn);
    expect(screen.queryByText("Payment Allocation")).toBeNull();
    expect(mockPaymentCreate).not.toHaveBeenCalled();
  });
});

describe("Record Payment wizard — submission is gated by the 4-step wizard", () => {
  it("does not call the create API until the step-4 'Record Payment' button is clicked", async () => {
    renderPage();
    await openWizardAndSelectCustomer();

    setAmount("500");
    clickContinue(); // -> step 2
    await screen.findByText("Payment Allocation");
    expect(mockPaymentCreate).not.toHaveBeenCalled();

    clickContinue(); // -> step 3
    await screen.findByText("Review Payment");
    expect(mockPaymentCreate).not.toHaveBeenCalled();

    clickContinue(); // -> step 4
    await screen.findByText("Confirm Payment");
    // Reaching the Confirm step alone must not submit anything.
    expect(mockPaymentCreate).not.toHaveBeenCalled();

    clickFinalSubmit();
    await waitFor(() => expect(mockPaymentCreate).toHaveBeenCalledTimes(1));
  });
});

// QA defect #28: "Refunded", "Outstanding", and "Avg/Day" derived their
// numbers from `payments` -- the current (paginated, date-filtered) table
// page -- instead of the full org dataset. "Avg/Day" additionally divided
// the page's cleared amount by the page's ROW COUNT, which isn't a per-day
// average at all. The fix pulls all four tiles from the new
// paymentApi.getDashboardStats() aggregate; these tests pin that wiring down
// with a page whose rows would produce very different (wrong) numbers if
// the old page-scoped logic were still in effect.
describe("KPI tiles — Refunded/Outstanding/Revenue/Avg-Day come from the dashboard-stats aggregate", () => {
  function tileValueTitle(label) {
    const labelEl = screen.getByText(label);
    const valueEl = labelEl.parentElement.querySelector("p[title]");
    return valueEl && valueEl.getAttribute("title");
  }

  it("renders Refunded/Outstanding/Revenue/Avg-Day from the stats endpoint, not from the current page's rows", async () => {
    // Only 2 rows on this page, neither refunded -- the pre-fix code would
    // have shown Refunded = 0 and Avg/Day = completedAmt / 2.
    mockPaymentList.mockResolvedValue({
      items: [
        { id: 1, status: "cleared", amount: 500, currency: "USD", payment_date: "2024-01-01" },
        { id: 2, status: "pending", amount: 50, currency: "USD", payment_date: "2024-01-02" },
      ],
      total: 2,
    });
    mockPaymentGetDashboardStats.mockResolvedValue({
      cleared_amount: 9000, cleared_count: 30, avg_payment_value: 300,
      refunded_amount: 400, refunded_count: 7,
      outstanding_amount: 1250, pending_count: 3,
      avg_per_day: 42.5, avg_per_day_window_days: 30, cleared_amount_last_30_days: 1275,
    });

    renderPage();
    await waitFor(() => expect(mockPaymentGetDashboardStats).toHaveBeenCalledTimes(1));
    await screen.findByRole("heading", { name: "Payments" });

    expect(tileValueTitle("Refunded")).toBe("7");
    expect(tileValueTitle("Outstanding")).toBe("1,250");
    expect(tileValueTitle("Revenue")).toBe("9,000");
    expect(tileValueTitle("Avg/Day")).toBe("42.5");
  });

  it("Avg/Day stays fixed to the server's 30-day figure regardless of how many rows are on the current page", async () => {
    mockPaymentGetDashboardStats.mockResolvedValue({
      cleared_amount: 3000, cleared_count: 10, avg_payment_value: 300,
      refunded_amount: 0, refunded_count: 0,
      outstanding_amount: 0, pending_count: 0,
      avg_per_day: 100, avg_per_day_window_days: 30, cleared_amount_last_30_days: 3000,
    });

    mockPaymentList.mockResolvedValue({
      items: [{ id: 1, status: "cleared", amount: 10, currency: "USD", payment_date: "2024-01-01" }],
      total: 1,
    });
    renderPage();
    await waitFor(() => expect(mockPaymentGetDashboardStats).toHaveBeenCalledTimes(1));
    await screen.findByRole("heading", { name: "Payments" });
    // Old buggy formula: completedAmt / payments.length = 10 / 1 = 10. Must be 100.
    expect(tileValueTitle("Avg/Day")).toBe("100");
    cleanup();

    mockPaymentList.mockResolvedValue({
      items: Array.from({ length: 10 }, (_, i) => (
        { id: i + 1, status: "cleared", amount: 10, currency: "USD", payment_date: "2024-01-01" }
      )),
      total: 10,
    });
    renderPage();
    await waitFor(() => expect(mockPaymentGetDashboardStats).toHaveBeenCalledTimes(2));
    await screen.findByRole("heading", { name: "Payments" });
    // Old buggy formula would now give 100 / 10 = 10 instead -- a different
    // page size alone must never change this tile.
    expect(tileValueTitle("Avg/Day")).toBe("100");
  });

  it("falls back to page-scoped numbers (not a crash) when the stats endpoint fails", async () => {
    mockPaymentGetDashboardStats.mockRejectedValue(new Error("network error"));
    mockPaymentList.mockResolvedValue({
      items: [{ id: 1, status: "cleared", amount: 500, currency: "USD", payment_date: "2024-01-01" }],
      total: 1,
    });

    renderPage();
    await waitFor(() => expect(mockPaymentGetDashboardStats).toHaveBeenCalledTimes(1));
    await screen.findByRole("heading", { name: "Payments" });

    // No crash, and Avg/Day falls back to 0 rather than a stale/undefined value.
    expect(tileValueTitle("Avg/Day")).toBe("0");
  });
});
