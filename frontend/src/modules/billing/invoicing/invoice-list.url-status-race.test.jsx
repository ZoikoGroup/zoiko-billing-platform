import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Production (07 Oct): clicking the Invoice Dashboard's "Overdue Count" card
// opened /billing/invoices?status=overdue but listed EVERY invoice. The list
// started with statusFilter "" and fired an unfiltered request, then a second
// filtered one once the URL effect ran; the unfiltered response arrived last
// and won. The first request must use the URL status, and a stale response
// must never overwrite a newer one.

vi.mock("../../../service/billingService", () => ({
  invoiceApi: { list: vi.fn(), finalize: vi.fn(), markSent: vi.fn(), sendEmail: vi.fn(), cancel: vi.fn(), bulkDelete: vi.fn() },
}));

import { invoiceApi } from "../../../service/billingService";
import InvoicingPage from "./invoice-list";

const inv = (id, n, status) => ({ id, invoice_number: n, status, issue_date: "2026-08-08", due_date: "2026-09-07", total_amount: 100, balance_due: 100, currency: "INR", customer_name: "ZBV" });
const ALL = { items: [inv(1, "INV-OVERDUE", "sent"), inv(2, "INV-PAID", "paid"), inv(3, "INV-DRAFT", "draft")], total: 3 };
const OVERDUE = { items: [inv(1, "INV-OVERDUE", "sent")], total: 1 };

const renderAt = (url) => render(<MemoryRouter initialEntries={[url]}><InvoicingPage /></MemoryRouter>);

beforeEach(() => vi.clearAllMocks());

describe("Invoice list ?status= from a KPI link", () => {
  it("the very first request already carries the URL status", async () => {
    invoiceApi.list.mockResolvedValue(OVERDUE);
    renderAt("/billing/invoices?status=overdue");
    await waitFor(() => expect(invoiceApi.list).toHaveBeenCalled());
    expect(invoiceApi.list.mock.calls[0][0].status).toBe("overdue");
    expect(invoiceApi.list.mock.calls.every((c) => c[0].status === "overdue")).toBe(true);
  });

  it("a slow unfiltered response cannot replace the filtered list", async () => {
    let resolveSlow;
    invoiceApi.list.mockImplementation((params) => (params.status
      ? Promise.resolve(OVERDUE)
      : new Promise((r) => { resolveSlow = () => r(ALL); })));
    renderAt("/billing/invoices?status=overdue");
    expect((await screen.findAllByText("INV-OVERDUE")).length).toBeGreaterThan(0);
    if (resolveSlow) resolveSlow();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("INV-PAID")).toBeNull();
    expect(screen.queryByText("INV-DRAFT")).toBeNull();
  });
});
