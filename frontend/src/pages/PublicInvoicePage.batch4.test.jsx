import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// B4-07: the public invoice page offered an active "Pay … with Stripe" button
// even when the public view reported card payments as not configured, so the
// customer's click could only fail.

const m = vi.hoisted(() => ({ getView: vi.fn(), createCheckout: vi.fn() }));
vi.mock("../service/billingService", () => ({
  publicInvoiceApi: { getView: (...a) => m.getView(...a), createCheckout: (...a) => m.createCheckout(...a) },
}));

import PublicInvoicePage from "./PublicInvoicePage";

const view = (configured) => ({
  invoice_number: "INV-46", status: "sent", currency: "USD",
  total_amount: "100.00", balance_due: "100.00", items: [], company: { name: "Acme" },
  payment: { payable: true, balance_due: "100.00", stripe: { configured, publishable_key: null } },
});

const renderPage = () => render(
  <MemoryRouter initialEntries={["/invoice/tok46"]}>
    <Routes><Route path="/invoice/:id" element={<PublicInvoicePage />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("B4-07 public invoice payment availability", () => {
  it("card payments not configured: no Pay button, an honest note instead", async () => {
    m.getView.mockResolvedValue(view(false));
    renderPage();
    expect(await screen.findByText(/online card payment isn't available for this invoice yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /with stripe/i })).toBeNull();
    expect(m.createCheckout).not.toHaveBeenCalled();
  });

  it("card payments configured: Pay button is offered", async () => {
    m.getView.mockResolvedValue(view(true));
    renderPage();
    expect(await screen.findByRole("button", { name: /with stripe/i })).toBeEnabled();
    expect(screen.queryByText(/isn't available for this invoice yet/i)).toBeNull();
  });
});
