import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter } from "../test/renderWithRouter";
import { axe } from "../../../test/a11y";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("../../../service/billingService", () => ({
  paymentApi: {
    list: vi.fn(),
    listMethods: vi.fn(() => Promise.resolve([])),
    create: vi.fn(),
    allocate: vi.fn(),
    updateStatus: vi.fn(),
  },
  invoiceApi: {
    list: vi.fn(() => Promise.resolve({ items: [] })),
  },
  customerApi: {
    search: vi.fn(() => Promise.resolve([])),
    get: vi.fn(),
  },
  creditNoteApi: {
    list: vi.fn(() => Promise.resolve({ items: [] })),
  },
}));

import PaymentListPage from "./payment-list";
import { paymentApi, customerApi, invoiceApi } from "../../../service/billingService";

const PAYMENTS = [
  { id: 1, payment_number: "PAY-001", amount: 500, currency: "USD", status: "cleared", payment_date: "2026-01-05T00:00:00Z", customer_name: "Acme Corp" },
  { id: 2, payment_number: "PAY-002", amount: 120, currency: "USD", status: "pending", payment_date: "2026-01-06T00:00:00Z", customer_name: "Globex" },
];

const CUSTOMER = { id: 7, display_name: "Acme Corp", company_name: "Acme Corp", email: "billing@acme.com" };

beforeEach(() => {
  vi.clearAllMocks();
  paymentApi.list.mockResolvedValue({ items: PAYMENTS, total: PAYMENTS.length });
  paymentApi.listMethods.mockResolvedValue([]);
  customerApi.search.mockResolvedValue([]);
  invoiceApi.list.mockResolvedValue({ items: [] });
});

// The "Record Payment" toolbar button stays mounted behind the modal (it's
// only hidden by an overlay, not removed), and the modal's own submit button
// reads "Record Payment" too — so every wizard query is scoped to the modal
// dialog itself rather than the whole document.
function getModal() {
  return screen.getByRole("heading", { name: "Record Payment" }).closest("div").parentElement;
}

async function openWizardAndSelectCustomer() {
  fireEvent.click(screen.getByRole("button", { name: /record payment/i }));
  await screen.findByRole("heading", { name: "Record Payment" });
  const modal = getModal();
  customerApi.search.mockResolvedValue([CUSTOMER]);
  fireEvent.change(within(modal).getByPlaceholderText(/search customers by name/i), { target: { value: "Acme" } });
  const option = await within(modal).findByRole("button", { name: /^Acme Corp/ });
  fireEvent.click(option);
  await waitFor(() => expect(within(modal).getByText("billing@acme.com")).toBeInTheDocument());
  return modal;
}

describe("PaymentListPage", () => {
  it("shows a loading state before data arrives", async () => {
    let resolveList;
    paymentApi.list.mockReturnValue(new Promise((res) => { resolveList = res; }));
    renderWithRouter(<PaymentListPage />);
    expect(screen.getByLabelText(/loading content/i)).toBeInTheDocument();
    resolveList({ items: [], total: 0 });
    await waitFor(() => expect(screen.queryByLabelText(/loading content/i)).not.toBeInTheDocument());
  });

  it("renders the payment list with real data", async () => {
    renderWithRouter(<PaymentListPage />);
    await waitFor(() => expect(screen.getByText("PAY-001")).toBeInTheDocument());
    expect(screen.getByText("PAY-002")).toBeInTheDocument();
  });

  it("has no accessibility violations once the list has loaded (axe-core)", async () => {
    const { container } = renderWithRouter(<PaymentListPage />);
    await waitFor(() => expect(screen.getByText("PAY-001")).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows an empty state when there are no payments", async () => {
    paymentApi.list.mockResolvedValue({ items: [], total: 0 });
    renderWithRouter(<PaymentListPage />);
    await waitFor(() => expect(screen.getByText(/no payments/i)).toBeInTheDocument());
  });

  it("shows an error state when the API call fails", async () => {
    paymentApi.list.mockRejectedValue(new Error("Network error"));
    renderWithRouter(<PaymentListPage />);
    await waitFor(() => expect(screen.getByText("Network error")).toBeInTheDocument());
  });

  it("Record Payment dialog has no accessibility violations (axe-core)", async () => {
    renderWithRouter(<PaymentListPage />);
    await waitFor(() => expect(screen.getByText("PAY-001")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /record payment/i }));
    await screen.findByRole("heading", { name: "Record Payment" });
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it("requires a customer and a positive amount before Continue is enabled", async () => {
    renderWithRouter(<PaymentListPage />);
    await waitFor(() => expect(screen.getByText("PAY-001")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /record payment/i }));
    await screen.findByRole("heading", { name: "Record Payment" });
    const modal = getModal();

    const continueBtn = within(modal).getByRole("button", { name: /continue/i });
    expect(continueBtn).toBeDisabled();
  });

  it("rejects an allocation that exceeds the invoice balance (overpayment)", async () => {
    const outstandingInvoice = { id: 501, invoice_number: "INV-501", status: "sent", total_amount: 300, paid_amount: 0, currency: "USD" };
    invoiceApi.list.mockResolvedValue({ items: [outstandingInvoice] });

    renderWithRouter(<PaymentListPage />);
    await waitFor(() => expect(screen.getByText("PAY-001")).toBeInTheDocument());
    const modal = await openWizardAndSelectCustomer();

    // Selecting the outstanding invoice suggests an allocation equal to its
    // full $300 balance (and sets the payment amount to match).
    fireEvent.click(await within(modal).findByRole("button", { name: /INV-501/i }));
    await waitFor(() => expect(within(modal).getByRole("button", { name: /continue/i })).not.toBeDisabled());

    fireEvent.click(within(modal).getByRole("button", { name: /continue/i })); // -> step 2 (Allocation)
    await waitFor(() => expect(within(modal).getByRole("spinbutton")).toBeInTheDocument());

    // Push the allocation above the $300 balance.
    fireEvent.change(within(modal).getByRole("spinbutton"), { target: { value: "400" } });

    fireEvent.click(within(modal).getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(within(modal).getByText(/allocation amount cannot exceed invoice balance/i)).toBeInTheDocument());
    // Blocked — still on step 2 (the allocation input is still present), payment never submitted.
    expect(within(modal).getByRole("spinbutton")).toBeInTheDocument();
    expect(paymentApi.create).not.toHaveBeenCalled();
  });

  it("records a payment successfully and shows a confirmation before navigating", async () => {
    paymentApi.create.mockResolvedValue({ id: 55 });
    renderWithRouter(<PaymentListPage />);
    await waitFor(() => expect(screen.getByText("PAY-001")).toBeInTheDocument());
    const modal = await openWizardAndSelectCustomer();

    fireEvent.change(within(modal).getByRole("spinbutton"), { target: { value: "250" } });
    fireEvent.click(within(modal).getByRole("button", { name: /continue/i })); // step 2
    await waitFor(() => expect(within(modal).getAllByText(/allocation/i).length).toBeGreaterThan(0));
    fireEvent.click(within(modal).getByRole("button", { name: /continue/i })); // step 3
    await waitFor(() => expect(within(modal).getAllByText(/review/i).length).toBeGreaterThan(0));
    fireEvent.click(within(modal).getByRole("button", { name: /continue/i })); // step 4
    await waitFor(() => expect(within(modal).getByRole("button", { name: /^record payment$/i })).toBeInTheDocument());

    fireEvent.click(within(modal).getByRole("button", { name: /^record payment$/i }));

    await waitFor(() => expect(paymentApi.create).toHaveBeenCalledTimes(1));
    const payload = paymentApi.create.mock.calls[0][0];
    expect(payload.customer_id).toBe(7);
    expect(payload.amount).toBe(250);
    await waitFor(() => expect(within(modal).getByText(/payment recorded successfully/i)).toBeInTheDocument());
    // The component navigates 1.2s after success via setTimeout; wait it out
    // here so that pending timer can't fire mid-flight during a later test
    // (it previously leaked into "shows an error..." and made it flaky).
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/billing/payments/55"), { timeout: 2000 });
  });

  it("shows an error and does not record when the API call fails", async () => {
    paymentApi.create.mockRejectedValue({ message: "Gateway declined" });
    renderWithRouter(<PaymentListPage />);
    await waitFor(() => expect(screen.getByText("PAY-001")).toBeInTheDocument());
    const modal = await openWizardAndSelectCustomer();

    fireEvent.change(within(modal).getByRole("spinbutton"), { target: { value: "250" } });
    fireEvent.click(within(modal).getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(within(modal).getAllByText(/allocation/i).length).toBeGreaterThan(0));
    fireEvent.click(within(modal).getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(within(modal).getAllByText(/review/i).length).toBeGreaterThan(0));
    fireEvent.click(within(modal).getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(within(modal).getByRole("button", { name: /^record payment$/i })).toBeInTheDocument());

    fireEvent.click(within(modal).getByRole("button", { name: /^record payment$/i }));

    await waitFor(() => expect(within(modal).getByText("Gateway declined")).toBeInTheDocument());
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
