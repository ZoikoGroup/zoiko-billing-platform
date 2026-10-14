import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// B1 (/billing/refunds -> New Refund): "Select a customer, the refund source
// and an amount" appeared after entering only an amount, and the Payment
// field showed nothing. Payment options legitimately depend on the chosen
// customer; the defects were (a) one generic message that never said WHICH
// field was missing and (b) a customer-list failure swallowed silently,
// leaving an empty Customer dropdown with no explanation.

const m = vi.hoisted(() => ({ refundList: vi.fn(), create: vi.fn(), sources: vi.fn(), customerList: vi.fn(), customerGet: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  refundApi: {
    list: (...a) => m.refundList(...a), create: (...a) => m.create(...a),
    getDashboardStats: () => Promise.resolve({}), listRefundableSources: (...a) => m.sources(...a),
  },
  customerApi: { list: (...a) => m.customerList(...a), get: (...a) => m.customerGet(...a) },
  invoiceApi: { list: vi.fn().mockResolvedValue({ items: [] }), get: vi.fn() },
  creditNoteApi: { list: vi.fn().mockResolvedValue({ items: [] }) },
}));
if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};

import RefundsPage from "./refunds";

const CUSTOMER = { id: 11, display_name: "Globex Corp", currency: "USD", credit_balance: 0 };
const PAYMENT = { id: 501, payment_number: "PAY-501", currency: "USD", amount: 100, reserved_amount: 0, refundable_amount: 100 };
const sources = (over = {}) => ({ payments: [], invoices: [], credit_notes: [], credit_balance: { currency: "USD", balance: 0, reserved_amount: 0, refundable_amount: 0 }, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  m.refundList.mockResolvedValue({ items: [], total: 0 });
  m.create.mockResolvedValue({ id: 1 });
  m.customerList.mockResolvedValue({ items: [CUSTOMER] });
  m.customerGet.mockResolvedValue(CUSTOMER);
  m.sources.mockResolvedValue(sources({ payments: [PAYMENT] }));
});
afterEach(() => cleanup());

const openForm = async () => {
  render(<MemoryRouter><RefundsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("button", { name: /new refund/i }));
};
const pickCustomer = async () => {
  await waitFor(() => expect(screen.getByRole("option", { name: "Globex Corp" })).toBeInTheDocument());
  fireEvent.change(screen.getByLabelText(/^Customer/), { target: { value: "11" } });
  await waitFor(() => expect(m.sources).toHaveBeenCalledWith("11"));
};
const create = () => fireEvent.click(screen.getByRole("button", { name: /^Create$/ }));

describe("B1 New Refund", () => {
  it("amount only: says the customer is missing (the reported scenario) and creates nothing", async () => {
    await openForm();
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: "10" } });
    create();
    expect(await screen.findByText("Select a customer.")).toBeInTheDocument();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("Payment is disabled with a hint until a customer is chosen, then lists that customer's payments", async () => {
    await openForm();
    expect(screen.getByLabelText(/^Payment/)).toBeDisabled();
    expect(screen.getByText(/Select a customer to see their refundable payments/)).toBeInTheDocument();
    await pickCustomer();
    expect(await screen.findByRole("option", { name: /PAY-501/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Payment/)).not.toBeDisabled();
  });

  it("customer with no eligible payments: clear empty state and a specific message", async () => {
    m.sources.mockResolvedValue(sources());
    await openForm();
    await pickCustomer();
    expect(await screen.findByText(/No refundable payments are available for this customer/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: "10" } });
    create();
    expect(await screen.findByText(/This customer has no refundable payments/)).toBeInTheDocument();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("missing amount is named specifically", async () => {
    await openForm();
    await pickCustomer();
    await screen.findByRole("option", { name: /PAY-501/ });
    fireEvent.change(screen.getByLabelText(/^Payment/), { target: { value: "501" } });
    create();
    expect(await screen.findByText("Enter the refund amount.")).toBeInTheDocument();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("customer list failure shows an error with Retry instead of an empty dropdown", async () => {
    m.customerList.mockRejectedValueOnce(new Error("Couldn't reach the server")).mockResolvedValueOnce({ items: [CUSTOMER] });
    await openForm();
    expect(await screen.findByText(/Unable to load customers/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
    expect(await screen.findByRole("option", { name: "Globex Corp" })).toBeInTheDocument();
    expect(screen.queryByText(/Unable to load customers/)).toBeNull();
  });

  it("valid form sends customer, payment, amount and the payment's currency once (double click → one request)", async () => {
    let resolve; m.create.mockImplementation(() => new Promise((r) => { resolve = r; }));
    await openForm();
    await pickCustomer();
    await screen.findByRole("option", { name: /PAY-501/ });
    fireEvent.change(screen.getByLabelText(/^Payment/), { target: { value: "501" } });
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: "25" } });
    create(); create();
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    const body = m.create.mock.calls[0][0];
    expect(body).toMatchObject({ customer_id: 11, refund_source: "payment", payment_id: 501, amount: 25, currency: "USD" });
    expect(body.idempotency_key).toBeTruthy();
    resolve({ id: 9 });
  });
});
