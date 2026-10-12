import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Batch 3 / M: Invoicing Reports. A failed credit-note load was swallowed and
// the Credit Notes card showed a confident 0; the reports silently covered
// only the first 100 invoices.

const m = vi.hoisted(() => ({ invList: vi.fn(), cnList: vi.fn(), stats: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  invoiceApi: { list: (...a) => m.invList(...a), getDashboardStats: (...a) => m.stats(...a) },
  creditNoteApi: { list: (...a) => m.cnList(...a) },
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children, actions }) => <div><h1>{title}</h1>{actions}{children}</div> }));
vi.mock("../utils/CurrencyContext", () => ({ useCurrency: () => ({ baseCurrency: "USD", formatCurrency: (v) => `$${v}` }) }));
vi.mock("../utils/TerminologyContext", () => ({ useTerminology: () => ({ singular: "Customer", plural: "Customers" }) }));
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

import InvoicingReportsPage from "./reports";

const inv = (i) => ({ id: i, invoice_number: `INV-${i}`, status: "sent", total_amount: "10", balance_due: "10", currency: "USD", created_at: new Date().toISOString() });

beforeEach(() => {
  vi.clearAllMocks();
  m.stats.mockResolvedValue({});
  m.invList.mockResolvedValue({ items: [inv(1), inv(2)], total: 2 });
  m.cnList.mockResolvedValue({ items: [], total: 0 });
});
afterEach(() => cleanup());

const renderPage = () => render(<MemoryRouter><InvoicingReportsPage /></MemoryRouter>);

describe("M. Invoicing reports", () => {
  it("credit-note load failure is shown with a retry instead of a 0 total", async () => {
    m.cnList.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ items: [], total: 0 });
    renderPage();
    expect((await screen.findAllByText("Couldn't load credit notes")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(m.cnList).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Couldn't load credit notes")).toBeNull());
    expect(screen.getByText("0 notes")).toBeInTheDocument();
  });

  it("says when the report covers only part of the invoices", async () => {
    m.invList.mockResolvedValue({ items: [inv(1), inv(2)], total: 340 });
    renderPage();
    expect(await screen.findByRole("status")).toHaveTextContent("These reports cover the 2 most recent invoices of 340");
  });

  it("no coverage notice when everything is loaded", async () => {
    renderPage();
    await screen.findByText("Total Invoices");
    expect(screen.queryByText(/most recent invoices of/)).toBeNull();
  });
});
