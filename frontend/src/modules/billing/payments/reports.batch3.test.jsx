import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Batch 3 / O: Payment Reports. Every source silently fell back to [] on
// failure (rendering as zeros), the Monthly Trend tooltip formatted the
// payment count as money, and "Outstanding Over Time" plotted collections.

const m = vi.hoisted(() => ({ pay: vi.fn(), refund: vi.fn() }));
vi.mock("../../../service/billingService", () => {
  const empty = () => Promise.resolve({ items: [], total: 0 });
  return {
    paymentApi: { list: (...a) => m.pay(...a) }, refundApi: { list: (...a) => m.refund(...a) },
    invoiceApi: { list: empty }, creditNoteApi: { list: empty }, writeOffApi: { list: empty },
    dunningApi: { listCases: empty }, collectionApi: { listCases: empty },
  };
});
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));
vi.mock("../utils/CurrencyContext", () => ({ useCurrency: () => ({ baseCurrency: "USD" }) }));
if (typeof window !== "undefined" && !window.ResizeObserver) {
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

import PaymentReportsPage, { monthlyTrendTooltip } from "./reports";

beforeEach(() => {
  vi.clearAllMocks();
  m.pay.mockResolvedValue({ items: [], total: 0 });
  m.refund.mockResolvedValue({ items: [], total: 0 });
});
afterEach(() => cleanup());

const renderPage = () => render(<MemoryRouter><PaymentReportsPage /></MemoryRouter>);

describe("O. Payment reports", () => {
  it("names the sources that failed and retries", async () => {
    m.refund.mockRejectedValueOnce(new Error("down"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load: Refunds");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(m.refund).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/Couldn't load:/)).toBeNull());
  });

  it("says when only part of the payments are covered", async () => {
    m.pay.mockResolvedValue({ items: [{ id: 1, amount: "5", status: "cleared", currency: "USD", payment_date: "2026-01-01" }], total: 900 });
    renderPage();
    expect(await screen.findByRole("status")).toHaveTextContent("1 most recent payments of 900");
  });

  it("Monthly Trend tooltip keeps the count as a number", () => {
    const fmt = monthlyTrendTooltip((v) => `$${v}`);
    expect(fmt(7, "Count")).toEqual([7, "Count"]);
    expect(fmt(7, "Collected")).toEqual(["$7", "Collected"]);
  });
});
