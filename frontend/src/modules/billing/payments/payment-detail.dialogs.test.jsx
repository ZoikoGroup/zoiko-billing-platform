import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the Reverse Allocation / Refund Payment dialogs on
// payment-detail.jsx (rebuilt on the shared billing-ui Modal).

const mockGetPayment = vi.fn();
const mockListAllocations = vi.fn();
const mockDeleteAllocation = vi.fn();
const mockRefundCreate = vi.fn();
const mockRefundSubmit = vi.fn();
const mockNavigate = vi.fn();

vi.mock("../../../service/billingService", () => ({
  paymentApi: {
    get: (...args) => mockGetPayment(...args),
    listAllocations: (...args) => mockListAllocations(...args),
    listAttempts: () => Promise.resolve({ attempts: [] }),
    deleteAllocation: (...args) => mockDeleteAllocation(...args),
    reconcile: vi.fn(),
    updateStatus: vi.fn(),
    allocate: vi.fn(),
  },
  invoiceApi: {
    get: () => Promise.resolve(null),
    list: () => Promise.resolve([]),
  },
  customerApi: { get: () => Promise.resolve(null) },
  auditApi: { list: () => Promise.resolve([]) },
  refundApi: {
    list: () => Promise.resolve([]),
    create: (...args) => mockRefundCreate(...args),
    submit: (...args) => mockRefundSubmit(...args),
  },
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useParams: () => ({ id: "15" }), useNavigate: () => mockNavigate };
});

import PaymentDetailPage from "./payment-detail";

async function loadPage() {
  mockGetPayment.mockResolvedValue({
    id: 15,
    payment_number: "PAY-0015",
    status: "cleared",
    amount: 200,
    currency: "USD",
    customer_id: 3,
  });
  mockListAllocations.mockResolvedValue([
    { id: 77, invoice_id: 21, invoice_number: "INV-0021", amount: 100, status: "completed" },
  ]);
  render(
    <MemoryRouter>
      <PaymentDetailPage />
    </MemoryRouter>
  );
  await screen.findByRole("heading", { name: "Payment PAY-0015" });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PaymentDetailPage dialogs", () => {
  it("Reverse (allocation row) opens Reverse Allocation; Confirm Reversal calls deleteAllocation and closes", async () => {
    mockDeleteAllocation.mockResolvedValue({});
    await loadPage();

    fireEvent.click(screen.getByRole("button", { name: /Allocation/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Reverse$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Reverse Allocation" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Confirm Reversal/i }));

    await waitFor(() => expect(mockDeleteAllocation).toHaveBeenCalledWith(77));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel closes the Reverse Allocation dialog without calling the API", async () => {
    await loadPage();

    fireEvent.click(screen.getByRole("button", { name: /Allocation/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Reverse$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Reverse Allocation" });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Cancel$/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockDeleteAllocation).not.toHaveBeenCalled();
  });

  it("Refund Payment creates + submits a partial refund, closes, and navigates to the refund", async () => {
    mockRefundCreate.mockResolvedValue({ id: 99 });
    mockRefundSubmit.mockResolvedValue({});
    await loadPage();

    fireEvent.click(screen.getByRole("button", { name: /Refund Payment/i }));
    const dialog = await screen.findByRole("dialog", { name: "Refund Payment" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Partial Refund/i }));
    expect(within(dialog).getByRole("button", { name: /Process Refund/i })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "50" } });
    fireEvent.change(within(dialog).getByPlaceholderText(/Optional reason/i), { target: { value: "Overcharge" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Process Refund/i }));

    await waitFor(() =>
      expect(mockRefundCreate).toHaveBeenCalledWith({
        customer_id: 3,
        payment_id: 15,
        refund_number: "auto",
        refund_type: "partial",
        amount: 50,
        currency: "USD",
        reason: "Overcharge",
      })
    );
    await waitFor(() => expect(mockRefundSubmit).toHaveBeenCalledWith(99, "Overcharge"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockNavigate).toHaveBeenCalledWith("/billing/refunds/99");
  });
});
