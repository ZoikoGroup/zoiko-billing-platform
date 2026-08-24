import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { F1BillingsCard } from "./FinancialOperationsPage";

// Regression coverage for the Phase 3 architecture remediation fix to
// FinancialOperationsPage.jsx: `isMulti` was referenced but never declared,
// crashing every render of the F1 Billings & Collections card. These tests
// pin the three currency_state branches the backend
// (FinancialBillingsSummary, backend/app/modules/super_admin/schemas.py)
// can actually produce, plus the missing-data and no-fabrication cases.

describe("F1BillingsCard", () => {
  it("renders the single-currency state without crashing", () => {
    render(
      <F1BillingsCard
        billings={{
          currency_state: "single_currency",
          currencies: [{ currency: "USD", invoice_count: 3, invoiced_amount: "150.00", collected_amount: "100.00", overdue_amount: "50.00", overdue_count: 1 }],
          overdue_count: 1,
          total_invoices: 3,
          invoiced_amount: "150.00",
          collected_amount: "100.00",
          overdue_amount: "50.00",
        }}
      />
    );
    expect(screen.getByText("SINGLE CURRENCY", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("150.00")).toBeInTheDocument();
    expect(screen.getByText("100.00")).toBeInTheDocument();
  });

  it("renders the multi-currency state without crashing and never shows a combined total", () => {
    render(
      <F1BillingsCard
        billings={{
          currency_state: "multi_currency",
          currencies: [
            { currency: "USD", invoice_count: 2, invoiced_amount: "100.00", collected_amount: "80.00", overdue_amount: "20.00", overdue_count: 1 },
            { currency: "EUR", invoice_count: 1, invoiced_amount: "50.00", collected_amount: "50.00", overdue_amount: "0.00", overdue_count: 0 },
          ],
          overdue_count: 1,
          total_invoices: 3,
        }}
      />
    );
    expect(screen.getByText("MULTI-CURRENCY — NO COMBINED TOTAL", { exact: false })).toBeInTheDocument();
    // Both currency buckets render distinctly...
    expect(screen.getByText("USD")).toBeInTheDocument();
    expect(screen.getByText("EUR")).toBeInTheDocument();
    // ...and no single fabricated combined-currency amount is rendered anywhere.
    expect(screen.queryByText(/^\$?150\.00$/)).not.toBeInTheDocument();
  });

  it("renders the UNKNOWN state (empty platform) without crashing, and never as a fabricated zero", () => {
    render(
      <F1BillingsCard
        billings={{ currency_state: "unknown", currencies: [], overdue_count: 0, total_invoices: 0 }}
      />
    );
    expect(screen.getByText(/No invoice data — totals UNKNOWN/i)).toBeInTheDocument();
    expect(screen.queryByText("0.00")).not.toBeInTheDocument();
  });

  it("does not crash when billings is entirely missing/undefined, and falls back to UNKNOWN", () => {
    render(<F1BillingsCard billings={undefined} />);
    expect(screen.getByText(/No invoice data — totals UNKNOWN/i)).toBeInTheDocument();
  });

  it("does not crash when billings is an empty object", () => {
    render(<F1BillingsCard billings={{}} />);
    expect(screen.getAllByText(/UNKNOWN/i).length).toBeGreaterThan(0);
  });

  it("renders exactly the amounts supplied by the backend — no client-side recomputation", () => {
    // financial metrics remain backend-authoritative: the component must display
    // the exact string the API returned, not reformat/re-derive the underlying number.
    render(
      <F1BillingsCard
        billings={{
          currency_state: "single_currency",
          currencies: [{ currency: "INR", invoice_count: 1, invoiced_amount: "999999.99", collected_amount: "1.00", overdue_amount: "999998.99", overdue_count: 1 }],
          overdue_count: 1,
          total_invoices: 1,
          invoiced_amount: "999999.99",
          collected_amount: "1.00",
          overdue_amount: "999998.99",
        }}
      />
    );
    expect(screen.getByText("999,999.99")).toBeInTheDocument();
    expect(screen.getAllByText("1.00").length).toBeGreaterThan(0);
  });
});
