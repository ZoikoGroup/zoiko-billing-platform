import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Production audit: Invoice Settings read "Automatically send invoices to
// undefined when finalized" — the page destructured a `pluralLower` field the
// terminology hook doesn't return.

vi.mock("../../../service/billingService", () => ({
  settingsApi: { get: vi.fn().mockResolvedValue({ default_currency: "USD", auto_send_invoices: false }), update: vi.fn() },
  taxApi: { list: vi.fn().mockResolvedValue([]) },
}));

import InvoiceSettingsPage from "./settings";

beforeEach(() => vi.clearAllMocks());

describe("Invoice Settings copy", () => {
  it("auto-send descriptions name the customer term, never 'undefined'", async () => {
    render(<InvoiceSettingsPage />);
    expect(await screen.findByText("Automatically send invoices to customers when finalized")).toBeInTheDocument();
    expect(screen.getByText("Automatically send payment receipts to customers")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\bundefined\b/);
  });
});
