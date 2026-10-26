import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const { publicPlatformInvoiceApi } = vi.hoisted(() => ({
  publicPlatformInvoiceApi: { getView: vi.fn(), checkout: vi.fn() },
}));
vi.mock("../service/platformPublicService", () => ({ publicPlatformInvoiceApi }));

import PublicPlatformInvoicePage from "./PublicPlatformInvoicePage";

const INVOICE = {
  invoice_number: "PINV-000007", status: "issued", currency: "USD", issue_date: "2026-09-17", due_date: null,
  subtotal: "149.00", discount_amount: "0.00", tax_amount: "0.00", total_amount: "149.00", paid_amount: "0.00",
  balance_due: "149.00", recipient_org_name: "software", items: [],
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/platform-invoice/tok"]}>
      <Routes>
        <Route path="/platform-invoice/:token" element={<PublicPlatformInvoicePage />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => vi.clearAllMocks());

describe("PublicPlatformInvoicePage payment action", () => {
  it("offers Pay when online payment is available", async () => {
    publicPlatformInvoiceApi.getView.mockResolvedValue({ ...INVOICE, online_payment_available: true });
    renderPage();
    expect(await screen.findByRole("button", { name: /pay \$149\.00/i })).toBeInTheDocument();
  });

  it("shows payment instructions instead of a dead-end Pay button when it isn't", async () => {
    publicPlatformInvoiceApi.getView.mockResolvedValue({ ...INVOICE, online_payment_available: false });
    renderPage();
    expect(await screen.findByText(/card payment isn't available for this invoice yet/i)).toBeInTheDocument();
    expect(screen.getByText(/quoting PINV-000007/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^pay /i })).not.toBeInTheDocument();
  });
});
