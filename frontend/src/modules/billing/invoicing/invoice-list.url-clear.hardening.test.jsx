import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, render, fireEvent } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

// Hardening: a ?status= deep link only seeds the filter. Once the user picks
// another status or clears filters, the URL must drop ?status= -- otherwise a
// reload (or a shared link) brings back the filter the user just removed.

vi.mock("../../../service/billingService", () => ({
  invoiceApi: { list: vi.fn(), finalize: vi.fn(), markSent: vi.fn(), sendEmail: vi.fn(), cancel: vi.fn(), bulkDelete: vi.fn() },
}));

import { invoiceApi } from "../../../service/billingService";
import InvoicingPage from "./invoice-list";

const inv = (id, n, status) => ({ id, invoice_number: n, status, issue_date: "2026-08-08", due_date: "2026-09-07", total_amount: 100, balance_due: 100, currency: "INR", customer_name: "ZBV" });

let location;
function LocationProbe() { location = useLocation(); return null; }
const renderAt = (url) => render(<MemoryRouter initialEntries={[url]}><InvoicingPage /><LocationProbe /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  invoiceApi.list.mockResolvedValue({ items: [inv(1, "INV-1", "sent")], total: 1 });
});

describe("Invoice list: user status choice supersedes ?status=", () => {
  it("choosing the All chip removes ?status= from the URL and refetches unfiltered", async () => {
    renderAt("/billing/invoices?status=overdue");
    await waitFor(() => expect(invoiceApi.list).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /^All$/ }));
    await waitFor(() => expect(location.search).not.toMatch(/status=/));
    await waitFor(() => expect(invoiceApi.list.mock.calls.at(-1)[0].status).toBeUndefined());
  });

  it("choosing another chip replaces the deep-link status (URL no longer says overdue)", async () => {
    renderAt("/billing/invoices?status=overdue");
    await waitFor(() => expect(invoiceApi.list).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /^Paid$/ }));
    await waitFor(() => expect(location.search).not.toMatch(/status=overdue/));
    await waitFor(() => expect(invoiceApi.list.mock.calls.at(-1)[0].status).toBe("paid"));
  });
});
