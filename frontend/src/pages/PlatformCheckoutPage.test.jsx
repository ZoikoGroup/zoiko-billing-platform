import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const { publicPlatformInvoiceApi } = vi.hoisted(() => ({
  publicPlatformInvoiceApi: { getView: vi.fn(), checkout: vi.fn() },
}));
vi.mock("../service/platformPublicService", () => ({ publicPlatformInvoiceApi }));

import PlatformCheckoutPage, { checkoutErrorView } from "./PlatformCheckoutPage";

const renderPage = (initialEntry = "/platform-invoice/test_tok_123/checkout") =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/platform-invoice/:token/checkout" element={<PlatformCheckoutPage />} />
        <Route path="/platform-invoice/checkout" element={<PlatformCheckoutPage />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PlatformCheckoutPage", () => {
  describe("checkoutErrorView helper", () => {
    it("maps 404 to Payment Link Not Valid", () => {
      const view = checkoutErrorView({ status: 404, message: "Invoice not found or link expired" });
      expect(view.title).toBe("Payment Link Not Valid");
      expect(view.linkInvalid).toBe(true);
      expect(view.message).toBe("Invoice not found or link expired");
      expect(view.hint).toContain("This payment link has expired or was replaced");
    });

    it("maps 400 unconfigured Stripe to Checkout Unavailable", () => {
      const view = checkoutErrorView({
        status: 400,
        message: "Online payment is not available yet. Please contact Zoiko support to complete payment.",
      });
      expect(view.title).toBe("Checkout Unavailable");
      expect(view.message).toContain("Online payment is not available yet");
      expect(view.hint).toContain("Online payment isn't set up yet for this account");
    });

    it("maps 400 invoice status error to This Invoice Can't Be Paid Online", () => {
      const view = checkoutErrorView({
        status: 400,
        message: "Invoice cannot be paid in status paid",
      });
      expect(view.title).toBe("This Invoice Can't Be Paid Online");
      expect(view.message).toBe("Invoice cannot be paid in status paid");
      expect(view.hint).toContain("Check the invoice status");
    });

    it("maps generic/unknown failure to fallback view", () => {
      const view = checkoutErrorView({ status: 500, message: "Server error" });
      expect(view.title).toBe("Checkout Unavailable");
      expect(view.message).toBe("Server error");
      expect(view.hint).toContain("Please try again shortly");
    });
  });

  describe("component rendering and navigation", () => {
    it("renders starting state and calls checkout with token from URL", async () => {
      publicPlatformInvoiceApi.checkout.mockReturnValue(new Promise(() => {})); // pending
      renderPage("/platform-invoice/my_custom_token/checkout");

      expect(screen.getByText(/starting checkout…/i)).toBeInTheDocument();
      expect(screen.getByText(/you'll be taken to stripe to complete your payment securely/i)).toBeInTheDocument();
      expect(publicPlatformInvoiceApi.checkout).toHaveBeenCalledWith("my_custom_token");
    });

    it("redirects when checkout returns checkout_url", async () => {
      const originalLocation = window.location;
      delete window.location;
      window.location = { href: "" };

      publicPlatformInvoiceApi.checkout.mockResolvedValue({
        checkout_url: "https://checkout.stripe.com/pay/cs_test_session_123",
      });

      renderPage("/platform-invoice/tok_abc/checkout");

      await waitFor(() => {
        expect(window.location.href).toBe("https://checkout.stripe.com/pay/cs_test_session_123");
      });

      window.location = originalLocation;
    });

    it("displays error when token is not found (404)", async () => {
      publicPlatformInvoiceApi.checkout.mockRejectedValue({
        status: 404,
        detail: "Invoice not found or link expired",
      });

      renderPage("/platform-invoice/invalid_tok/checkout");

      expect(await screen.findByRole("heading", { name: "Payment Link Not Valid" })).toBeInTheDocument();
      expect(screen.getByText("Invoice not found or link expired")).toBeInTheDocument();
      expect(screen.getByText(/this payment link has expired or was replaced/i)).toBeInTheDocument();
      // Retry button is hidden for definitive linkInvalid
      expect(screen.queryByRole("button", { name: /try again/i })).not.toBeInTheDocument();
      // Back to invoice link is also hidden for invalid token
      expect(screen.queryByRole("link", { name: /back to invoice/i })).not.toBeInTheDocument();
    });

    it("displays Checkout Unavailable when Stripe is unconfigured (400)", async () => {
      publicPlatformInvoiceApi.checkout.mockRejectedValue({
        status: 400,
        detail: "Online payment is not available yet. Please contact Zoiko support to complete payment.",
      });

      renderPage("/platform-invoice/valid_tok/checkout");

      expect(await screen.findByRole("heading", { name: "Checkout Unavailable" })).toBeInTheDocument();
      expect(screen.getByText(/online payment is not available yet/i)).toBeInTheDocument();
      expect(screen.getByText(/online payment isn't set up yet for this account/i)).toBeInTheDocument();
      // Retry and Back to invoice are present
      expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
      const backLink = screen.getByRole("link", { name: /back to invoice/i });
      expect(backLink).toBeInTheDocument();
      expect(backLink).toHaveAttribute("href", "/platform-invoice/valid_tok");
    });

    it("handles missing token gracefully", async () => {
      renderPage("/platform-invoice/checkout");

      expect(await screen.findByRole("heading", { name: "Payment Link Not Valid" })).toBeInTheDocument();
      expect(screen.getByText("Invalid invoice link.")).toBeInTheDocument();
    });
  });
});
