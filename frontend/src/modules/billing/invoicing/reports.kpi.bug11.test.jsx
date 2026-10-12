import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// BUG-11.9: Invoicing Reports KPI amounts were text-2xl whitespace-nowrap in
// 4-up cards with no min-w-0, so large values overflowed the card. They now
// truncate inside an overflow-safe card with the full value kept in `title`.

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
import { formatCurrency } from "../../../utils/locale";

const BIG = "123456789012.34";

beforeEach(() => {
  vi.clearAllMocks();
  m.stats.mockResolvedValue({});
  m.invList.mockResolvedValue({
    items: [{ id: 1, invoice_number: "INV-1", status: "sent", total_amount: BIG, balance_due: BIG, currency: "USD", created_at: new Date().toISOString() }],
    total: 1,
  });
  m.cnList.mockResolvedValue({ items: [], total: 0 });
});
afterEach(() => cleanup());

describe("BUG-11.9 Invoicing reports KPI overflow", () => {
  it("keeps the full large amount accessible and overflow-safe", async () => {
    render(<MemoryRouter><InvoicingReportsPage /></MemoryRouter>);
    await screen.findByText("Total Amount");
    const full = formatCurrency(Number(BIG), "USD");
    expect(full).toContain("123,456,789,012.34");
    const values = screen.getAllByTitle(full);
    expect(values.length).toBeGreaterThanOrEqual(2); // Total Amount + Outstanding
    values.forEach((el) => {
      expect(el).toHaveTextContent(full);
      expect(el.className).toContain("truncate");
      expect(el.className).toContain("text-xl");
      expect(el.className).toContain("xl:text-2xl");
      expect(el.className).not.toContain("whitespace-nowrap");
      expect(el.parentElement.className).toContain("min-w-0");
    });
  });
});
