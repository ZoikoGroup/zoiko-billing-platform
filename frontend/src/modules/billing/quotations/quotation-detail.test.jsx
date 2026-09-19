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
  quoteApi: {
    get: vi.fn(),
    listItems: vi.fn(() => Promise.resolve([])),
    convertToInvoice: vi.fn(),
    send: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    cancel: vi.fn(),
    recalculate: vi.fn(),
    duplicate: vi.fn(),
  },
  customerApi: {
    get: vi.fn(() => Promise.resolve({ id: 9, display_name: "Acme Corp" })),
  },
  contractApi: {
    list: vi.fn(() => Promise.resolve({ items: [] })),
  },
  settingsApi: {
    getConfig: vi.fn(() => Promise.resolve({ default_currency: "USD", auto_generate_invoice_number: false })),
  },
}));

import QuotationDetailPage from "./quotation-detail";
import { quoteApi } from "../../../service/billingService";

const ACCEPTED_QUOTE = {
  id: 1, quote_number: "QUO-0001", status: "accepted", customer_id: 9,
  subtotal: 1000, tax_amount: 100, total_amount: 1100, currency: "USD",
};

function renderDetail() {
  return renderWithRouter(<QuotationDetailPage />, {
    routePath: "/billing/quotations/:id",
    initialEntries: ["/billing/quotations/1"],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  quoteApi.get.mockResolvedValue(ACCEPTED_QUOTE);
  quoteApi.listItems.mockResolvedValue([]);
});

describe("QuotationDetailPage", () => {
  it("shows a loading state, then the quotation once loaded", async () => {
    renderDetail();
    expect(screen.getByText(/loading quotation details/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("QUO-0001")).toBeInTheDocument());
  });

  it("has no accessibility violations once loaded (axe-core)", async () => {
    const { container } = renderDetail();
    await waitFor(() => expect(screen.getByText("QUO-0001")).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("shows an error state with retry when the quotation fails to load", async () => {
    quoteApi.get.mockRejectedValue({ message: "Quotation not found" });
    renderDetail();
    await waitFor(() => expect(screen.getByText("Quotation not found")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("converts an accepted quotation to an invoice and navigates to it", async () => {
    quoteApi.convertToInvoice.mockResolvedValue({ id: 501 });
    renderDetail();
    await waitFor(() => expect(screen.getByText("QUO-0001")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /convert to invoice/i }));
    const dialog = screen.getByRole("heading", { name: "Convert to Invoice" }).closest("div").parentElement;

    const convertBtn = within(dialog).getByRole("button", { name: /^convert$/i });
    // invoice_number starts empty, so the confirm button starts disabled.
    expect(convertBtn).toBeDisabled();

    fireEvent.change(within(dialog).getByPlaceholderText("INV-0001"), { target: { value: "INV-9001" } });
    expect(convertBtn).not.toBeDisabled();

    fireEvent.click(convertBtn);

    await waitFor(() => expect(quoteApi.convertToInvoice).toHaveBeenCalledTimes(1));
    expect(quoteApi.convertToInvoice).toHaveBeenCalledWith(
      "1",
      expect.objectContaining({ invoice_number: "INV-9001" })
    );
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/billing/invoices/501"));
  });

  it("does not offer Convert to Invoice for a quotation that isn't accepted", async () => {
    quoteApi.get.mockResolvedValue({ ...ACCEPTED_QUOTE, status: "draft" });
    renderDetail();
    await waitFor(() => expect(screen.getByText("QUO-0001")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /convert to invoice/i })).not.toBeInTheDocument();
  });

  it("surfaces a backend rejection without navigating away", async () => {
    quoteApi.convertToInvoice.mockRejectedValue({ detail: "Quotation already converted" });
    renderDetail();
    await waitFor(() => expect(screen.getByText("QUO-0001")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /convert to invoice/i }));
    const dialog = screen.getByRole("heading", { name: "Convert to Invoice" }).closest("div").parentElement;
    fireEvent.change(within(dialog).getByPlaceholderText("INV-0001"), { target: { value: "INV-9002" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^convert$/i }));

    await waitFor(() => expect(screen.getByText("Quotation already converted")).toBeInTheDocument());
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
