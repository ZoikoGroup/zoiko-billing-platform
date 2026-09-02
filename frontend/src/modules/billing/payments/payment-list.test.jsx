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
