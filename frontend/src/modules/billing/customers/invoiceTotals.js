// Pure helpers for the Customer Reports Overview totals.
// Extracted from reports.jsx so the "₹0.00" regression (reading the wrong
// invoice amount field) is unit-testable without rendering the page.
//
// The invoice list API returns `total_amount` (snake_case), never `total` or
// `amount`. Reading the wrong field parses every invoice to 0, which made the
// Overview "Total Revenue" / "Outstanding" cards render ₹0.00.

export function invoiceTotal(inv) {
  return parseFloat(inv.total_amount || inv.total || inv.amount || 0);
}

export function computeInvoiceTotals(invoices) {
  const paid = invoices.filter((i) => i.status === "paid");
  const unpaid = invoices.filter((i) => i.status === "sent" || i.status === "partially_paid");
  const overdue = invoices.filter((i) => i.status === "overdue");

  const totalRevenue = paid.reduce((s, i) => s + invoiceTotal(i), 0);
  const totalOutstanding =
    unpaid.reduce((s, i) => s + invoiceTotal(i), 0) +
    overdue.reduce((s, i) => s + invoiceTotal(i), 0);

  const revenueByCustomer = invoices.reduce((acc, inv) => {
    const cid = inv.customer_id || inv.customerId;
    const cname = inv.customer_name || inv.customerName || `Customer #${cid}`;
    if (!cid) return acc;
    if (!acc[cid]) acc[cid] = { name: cname, revenue: 0, count: 0 };
    acc[cid].revenue += invoiceTotal(inv);
    acc[cid].count += 1;
    return acc;
  }, {});

  return {
    paidCount: paid.length,
    unpaidCount: unpaid.length,
    overdueCount: overdue.length,
    totalRevenue,
    totalOutstanding,
    revenueByCustomer,
  };
}
