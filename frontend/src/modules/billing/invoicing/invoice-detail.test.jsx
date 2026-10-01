import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter } from "../test/renderWithRouter";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("../../../service/billingService", () => ({
  invoiceApi: {
    get: vi.fn(),
    listItems: vi.fn(() => Promise.resolve([])),
    listStatusHistory: vi.fn(() => Promise.resolve([])),
    getTimeline: vi.fn(() => Promise.resolve({ entries: [] })),
    listCommunications: vi.fn(() => Promise.resolve([])),
    create: vi.fn(),
    bulkSetItems: vi.fn(() => Promise.resolve({})),
  },
  auditApi: {
    list: vi.fn(() => Promise.resolve([])),
  },
  paymentApi: {
    create: vi.fn(),
    allocate: vi.fn(),
  },
}));

import InvoiceDetailPage from "./invoice-detail";
import { invoiceApi } from "../../../service/billingService";

const INVOICE = {
  id: 7, invoice_number: "INV-0007", status: "sent", customer_id: 42,
  currency: "USD", issue_date: "2026-01-01", due_date: "2026-01-31",
  subtotal: 500, tax_amount: 0, total_amount: 500, balance_due: 500,
};

function renderDetail() {
  return renderWithRouter(<InvoiceDetailPage />, {
    routePath: "/billing/invoices/:id",
    initialEntries: ["/billing/invoices/7"],
  });
}

async function openDuplicateModal() {
  renderDetail();
  await waitFor(() => expect(screen.getByRole("heading", { name: /INV-0007/ })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Duplicate invoice" })); // aria-label on the trigger
  return screen.getByRole("dialog", { name: "Duplicate Invoice" });
}

beforeEach(() => {
  vi.clearAllMocks();
  invoiceApi.get.mockResolvedValue(INVOICE);
});

describe("InvoiceDetailPage — Duplicate Invoice", () => {
  it("shows the Subscription Limit Reached panel (not silence, not the raw key) when the monthly invoice limit is reached", async () => {
    invoiceApi.create.mockRejectedValue(Object.assign(new Error("'billing.invoice.monthly_limit' limit (1000) exceeded."), {
      status: 403,
      code: "SUBSCRIPTION_LIMIT_REACHED",
      entity: "invoice",
      currentUsage: 1000,
      limit: 1000,
      remaining: 0,
      planName: "Professional",
    }));

    const dialog = await openDuplicateModal();
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate Invoice" }));

    await waitFor(() => expect(within(dialog).getByText(/invoice limit reached/i)).toBeInTheDocument());
    expect(within(dialog).queryByText(/billing\.invoice\.monthly_limit/)).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringContaining("/billing/invoices/"), expect.anything());
    // The modal must stay open on failure — it used to close before the
    // request even resolved, silently swallowing this error entirely.
    expect(screen.getByRole("heading", { name: "Duplicate Invoice" })).toBeInTheDocument();
  });

  it("shows a plain error banner (not the limit panel) for a non-entitlement duplicate failure, and stays open", async () => {
    invoiceApi.create.mockRejectedValue(new Error("Network error"));

    const dialog = await openDuplicateModal();
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate Invoice" }));

    await waitFor(() => expect(within(dialog).getByText("Network error")).toBeInTheDocument());
    expect(within(dialog).queryByText(/limit reached/i)).not.toBeInTheDocument();
  });

  it("duplicates successfully and navigates to the new invoice", async () => {
    invoiceApi.create.mockResolvedValue({ id: 8 });

    const dialog = await openDuplicateModal();
    fireEvent.click(within(dialog).getByRole("button", { name: "Duplicate Invoice" }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/billing/invoices/8"));
  });
});
