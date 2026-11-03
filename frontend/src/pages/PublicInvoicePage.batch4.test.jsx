import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// B4-07: the public invoice page offered an active "Pay … with Stripe" button
// even when the public view reported card payments as not configured, so the
// customer's click could only fail.

const m = vi.hoisted(() => ({ getView: vi.fn(), createCheckout: vi.fn() }));
vi.mock("../service/billingService", () => ({
  publicInvoiceApi: { getView: (...a) => m.getView(...a), createCheckout: (...a) => m.createCheckout(...a) },
}));

import PublicInvoicePage from "./PublicInvoicePage";

const view = (configured, payable = true) => ({
  invoice_number: "INV-46", status: "sent", currency: "USD",
  total_amount: "100.00", balance_due: "100.00", items: [],
  company: { name: "Acme Ltd", support_email: "billing@acme.example", billing_address: "London" },
  payment: { payable, balance_due: "100.00", stripe: { configured, publishable_key: null } },
});

const renderPage = () => render(
  <MemoryRouter initialEntries={["/invoice/tok46"]}>
    <Routes><Route path="/invoice/:id" element={<PublicInvoicePage />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("B4-07 public invoice payment availability", () => {
  it("card payments not configured: shows a disabled Pay button with setup guidance", async () => {
    m.getView.mockResolvedValue(view(false));
    renderPage();
    expect(await screen.findByText(/issuer must connect and activate stripe/i)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /pay online.*unavailable/i })).toBeDisabled();
    expect(m.createCheckout).not.toHaveBeenCalled();
  });

  it("card payments configured: Pay button is offered", async () => {
    m.getView.mockResolvedValue(view(true));
    renderPage();
    expect(await screen.findByRole("button", { name: /with stripe/i })).toBeEnabled();
    expect(screen.queryByText(/isn't available for this invoice yet/i)).toBeNull();
    expect(screen.getByRole("img", { name: "Zoiko Billing" })).toHaveAttribute("src", "/zoiko-billing-logo-sm.png");
    expect(screen.getByRole("heading", { name: "From" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "billing@acme.example" })).toHaveAttribute("href", "mailto:billing@acme.example");
  });

  it("starts Stripe Checkout for the invoice's secure public token", async () => {
    m.getView.mockResolvedValue(view(true));
    m.createCheckout.mockResolvedValue({ configured: false, message: "Stripe is temporarily unavailable." });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /with stripe/i }));
    expect(await screen.findByText(/stripe is temporarily unavailable/i)).toBeInTheDocument();
    expect(m.createCheckout).toHaveBeenCalledWith("tok46");
  });

  it("does not offer payment when the invoice is not in a payable state", async () => {
    m.getView.mockResolvedValue(view(true, false));
    renderPage();
    expect(await screen.findByRole("heading", { name: "INV-46" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /with stripe/i })).toBeNull();
  });
});
