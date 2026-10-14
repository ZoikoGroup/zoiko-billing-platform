import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// BUG-11.11: Payment Reports KPI amounts were text-2xl whitespace-nowrap in
// 4-up cards with no min-w-0, so large values overflowed the card. They now
// truncate inside an overflow-safe card with the full value kept in `title`.

const m = vi.hoisted(() => ({ pay: vi.fn() }));
vi.mock("../../../service/billingService", () => {
  const empty = () => Promise.resolve({ items: [], total: 0 });
  return {
    paymentApi: { list: (...a) => m.pay(...a) }, refundApi: { list: empty },
    invoiceApi: { list: empty }, creditNoteApi: { list: empty }, writeOffApi: { list: empty },
    dunningApi: { listCases: empty }, collectionApi: { listCases: empty },
  };
});
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));
vi.mock("../utils/CurrencyContext", () => ({ useCurrency: () => ({ baseCurrency: "USD" }) }));
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

import PaymentReportsPage from "./reports";
import { formatCurrency } from "../../../utils/locale";

const BIG = "123456789012.34";

beforeEach(() => {
  vi.clearAllMocks();
  m.pay.mockResolvedValue({
    items: [{ id: 1, amount: BIG, status: "cleared", currency: "USD", payment_date: new Date().toISOString().slice(0, 10) }],
    total: 1,
  });
});
afterEach(() => cleanup());

describe("BUG-11.11 Payment reports KPI overflow", () => {
  it("keeps the full large amount accessible and overflow-safe", async () => {
    render(<MemoryRouter><PaymentReportsPage /></MemoryRouter>);
    await screen.findByText("Total Collected");
    const full = formatCurrency(Number(BIG), "USD");
    expect(full).toContain("123,456,789,012.34");
    const values = await screen.findAllByTitle(full);
    expect(values.length).toBeGreaterThanOrEqual(2); // Total Collected + Net Cash Flow
    values.forEach((el) => {
      expect(el).toHaveTextContent(full);
      expect(el.className).toContain("truncate");
      expect(el.className).toContain("xl:text-2xl");
      expect(el.className).not.toContain("whitespace-nowrap");
      expect(el.parentElement.className).toContain("min-w-0");
    });
  });
});
