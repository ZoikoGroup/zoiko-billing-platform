import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter } from "../test/renderWithRouter";

// Draft invoice action bar on phones: the primary (Finalize) stays visible
// and full width; Cancel invoice and Recalculate move into a "⋯" menu that
// opens upward. Desktop keeps all three buttons. Mocks copied from
// invoice-detail.test.jsx.

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock("../../../service/billingService", () => ({
  governedTaxApi: { invoiceSummary: vi.fn(() => Promise.resolve({ governed: false })), requestQuote: vi.fn() },
  invoiceApi: {
    get: vi.fn(),
    listItems: vi.fn(() => Promise.resolve([])),
    listStatusHistory: vi.fn(() => Promise.resolve([])),
    getTimeline: vi.fn(() => Promise.resolve({ entries: [] })),
    listCommunications: vi.fn(() => Promise.resolve([])),
    finalize: vi.fn(() => Promise.resolve({})),
    recalculate: vi.fn(() => Promise.resolve({})),
    create: vi.fn(),
    bulkSetItems: vi.fn(() => Promise.resolve({})),
  },
  auditApi: { list: vi.fn(() => Promise.resolve([])) },
  paymentApi: { create: vi.fn(), allocate: vi.fn() },
}));

import InvoiceDetailPage from "./invoice-detail";
import { invoiceApi } from "../../../service/billingService";

const DRAFT = {
  id: 7, invoice_number: "INV-0007", status: "draft", customer_id: 42,
  currency: "USD", issue_date: "2026-01-01", due_date: "2026-01-31",
  subtotal: 500, tax_amount: 0, total_amount: 500, balance_due: 500,
};

const originalMatchMedia = window.matchMedia;
function emulatePhone() {
  window.matchMedia = (query) => ({
    matches: query === "(max-width: 639.98px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  });
}

async function renderDraft() {
  renderWithRouter(<InvoiceDetailPage />, { routePath: "/billing/invoices/:id", initialEntries: ["/billing/invoices/7"] });
  await waitFor(() => expect(screen.getByRole("heading", { name: /INV-0007/ })).toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  invoiceApi.get.mockResolvedValue(DRAFT);
});
afterEach(() => { window.matchMedia = originalMatchMedia; });

describe("Draft invoice action bar", () => {
  it("phones: Finalize stays visible and calls finalize", async () => {
    emulatePhone();
    await renderDraft();
    const bar = screen.getByText("Balance due").closest("div.fixed");
    expect(within(bar).queryByRole("button", { name: "Recalculate" })).not.toBeInTheDocument();
    fireEvent.click(within(bar).getByRole("button", { name: "Finalize" }));
    await waitFor(() => expect(invoiceApi.finalize).toHaveBeenCalledWith("7"));
  });

  it("phones: the menu holds Cancel invoice and Recalculate with the same actions", async () => {
    emulatePhone();
    await renderDraft();
    const bar = screen.getByText("Balance due").closest("div.fixed");
    fireEvent.click(within(bar).getByRole("button", { name: "More actions" }));
    const menu = within(bar).getByRole("menu");
    expect(menu.className).toMatch(/bottom-full/);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Recalculate" }));
    await waitFor(() => expect(invoiceApi.recalculate).toHaveBeenCalledWith("7"));

    fireEvent.click(within(bar).getByRole("button", { name: "More actions" }));
    fireEvent.click(within(within(bar).getByRole("menu")).getByRole("menuitem", { name: "Cancel invoice" }));
    expect(await screen.findByRole("dialog", { name: /Cancel Invoice/i })).toBeInTheDocument();
  });

  it("desktop keeps Finalize, Cancel and Recalculate as buttons", async () => {
    await renderDraft();
    const bar = screen.getByText("Balance due").closest("div.fixed");
    for (const name of ["Finalize", "Cancel", "Recalculate"]) {
      expect(within(bar).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(bar).queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
  });
});
