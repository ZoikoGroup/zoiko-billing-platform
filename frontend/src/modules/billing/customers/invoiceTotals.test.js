import { describe, it, expect } from "vitest";
import { computeInvoiceTotals, invoiceTotal } from "./invoiceTotals";

// Mirrors the reported scenario: 1 Paid (₹500) + 4 Unpaid (₹1,800) invoices.
const SAMPLE = [
  { id: 1, customer_id: 10, customer_name: "Acme", status: "paid", total_amount: "500.00", total: 0, amount: 0 },
  { id: 2, customer_id: 11, customer_name: "Gok", status: "sent", total_amount: "600.00", total: 0, amount: 0 },
  { id: 3, customer_id: 11, customer_name: "Gok", status: "partially_paid", total_amount: "400.00", total: 0, amount: 0 },
  { id: 4, customer_id: 12, customer_name: "Beta", status: "sent", total_amount: "500.00", total: 0, amount: 0 },
  { id: 5, customer_id: 12, customer_name: "Beta", status: "overdue", total_amount: "300.00", total: 0, amount: 0 },
];

describe("computeInvoiceTotals (Customer Reports Overview)", () => {
  it("reads total_amount so Overview totals are never ₹0.00", () => {
    const t = computeInvoiceTotals(SAMPLE);
    // 1 paid @500 → revenue; 4 unsettled (600+400+500+300) → outstanding 1800.
    expect(t.totalRevenue).toBeCloseTo(500, 2);
    expect(t.totalOutstanding).toBeCloseTo(1800, 2);
    expect(t.paidCount).toBe(1);
    expect(t.unpaidCount).toBe(3); // sent (2) + partially_paid (1)
    expect(t.overdueCount).toBe(1);
  });

  it("matches the Billing History sum for the same invoices", () => {
    // Billing History totals = sum of total_amount grouped by settled state.
    const billingHistoryRevenue = SAMPLE.filter((i) => i.status === "paid")
      .reduce((s, i) => s + parseFloat(i.total_amount), 0);
    const billingHistoryOutstanding = SAMPLE.filter(
      (i) => i.status === "sent" || i.status === "partially_paid" || i.status === "overdue",
    ).reduce((s, i) => s + parseFloat(i.total_amount), 0);

    const t = computeInvoiceTotals(SAMPLE);
    expect(t.totalRevenue).toBeCloseTo(billingHistoryRevenue, 2);
    expect(t.totalOutstanding).toBeCloseTo(billingHistoryOutstanding, 2);
  });

  it("prefers total_amount over the legacy total/amount fields", () => {
    // If the wrong fields were used, revenue would be 0 and outstanding 0.
    const t = computeInvoiceTotals(SAMPLE);
    expect(invoiceTotal(SAMPLE[0])).toBeCloseTo(500, 2);
    expect(t.totalRevenue).not.toBe(0);
    expect(t.totalOutstanding).not.toBe(0);
  });

  it("aggregates revenue by customer", () => {
    const t = computeInvoiceTotals(SAMPLE);
    // Gok: 600 (sent) + 400 (partially_paid) = 1000 across 2 invoices.
    expect(t.revenueByCustomer[11].revenue).toBeCloseTo(1000, 2);
    expect(t.revenueByCustomer[11].count).toBe(2);
  });
});
