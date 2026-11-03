import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

// BUG-15 (/billing/customers/dashboard): six KPI cards reported "not working".
// Approved behaviour:
//  - "<period> Revenue" (e.g. "Financial Year Revenue"): cleared payments in
//    the selected period -> /billing/payments?status=cleared (the payments
//    list shares the same global date range).
//  - "Total Revenue" (all time) -> /billing/payments?status=cleared&all_dates=1
//    (the date range is not applied; the user's global range is untouched).
//  - "Over Credit Limit" -> /billing/customers?over_credit_limit=1 (server
//    filter with the KPI's own predicate, see test_customer_over_credit_limit_bug15.py).
//  - "Avg Invoice" opens invoices, its underlying records.
//  - "Avg Collection Period" opens cleared payments, the collection records.
//  - "Avg Revenue/<term>" must NOT link to Customer Reports, which computes a
//    different figure (paid invoices, first 100 records, no currency
//    conversion). It links to its own numerator instead: all-time cleared
//    payments (/billing/payments?status=cleared&all_dates=1), and its
//    subtitle states the formula.

if (typeof global.ResizeObserver === "undefined") {
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

vi.mock("../../../service/billingService", () => ({
  customerApi: {
    getKPI: () => Promise.resolve({
      period_revenue: 1200, period_total_invoices: 3, period_paid_invoices: 2, period_avg_invoice_value: 400,
      period_new_customers: 1, total_customers: 5, active_customers: 4, inactive_customers: 1,
      avg_revenue_per_customer: 240, total_revenue: 5000, outstanding_balance: 300,
      avg_collection_time_days: 12, customers_with_outstanding_balance: 2, customers_over_credit_limit: 1,
    }),
    list: () => Promise.resolve({ items: [] }),
  },
}));

import CustomerDashboardPage from "./customer-dashboard";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}{loc.search}</div>;
}

const renderDashboard = () => render(
  <MemoryRouter initialEntries={["/billing/customers/dashboard"]}>
    <Routes>
      <Route path="/billing/customers/dashboard" element={<CustomerDashboardPage />} />
      <Route path="*" element={<LocationProbe />} />
    </Routes>
  </MemoryRouter>
);
const card = (name) => screen.findByRole("button", { name }, { timeout: 4000 });

afterEach(() => cleanup());

describe("BUG-15 Customer Dashboard KPI cards", () => {
  it.each([
    ["period Revenue", /^(?!Total)[\w\s()]+ Revenue:/, "/billing/payments?status=cleared"],
    ["Total Revenue (all time)", /^Total Revenue:/, "/billing/payments?status=cleared&all_dates=1"],
    ["Over Credit Limit", /^Over Credit Limit:/, "/billing/customers?over_credit_limit=1"],
    ["Avg Revenue (its numerator: all-time cleared payments)", /^Avg Revenue\/Customer:/, "/billing/payments?status=cleared&all_dates=1"],
    ["period Avg Invoice", /^Last 30 Days Avg Invoice:/, "/billing/invoices"],
    ["Avg Collection Period", /^Avg Collection Period:/, "/billing/payments?status=cleared"],
  ])("%s opens its approved destination", async (_label, name, destination) => {
    renderDashboard();
    const el = await card(name);
    expect(el).toHaveAttribute("tabindex", "0");
    fireEvent.click(el);
    expect((await screen.findByTestId("location")).textContent).toBe(destination);
  });

  it.each([
    ["period Revenue", /^(?!Total)[\w\s()]+ Revenue:/, "/billing/payments?status=cleared"],
    ["Total Revenue", /^Total Revenue:/, "/billing/payments?status=cleared&all_dates=1"],
    ["Over Credit Limit", /^Over Credit Limit:/, "/billing/customers?over_credit_limit=1"],
    ["period Avg Invoice", /^Last 30 Days Avg Invoice:/, "/billing/invoices"],
    ["Avg Collection Period", /^Avg Collection Period:/, "/billing/payments?status=cleared"],
  ])("%s is keyboard-operable", async (_label, name, destination) => {
    renderDashboard();
    fireEvent.keyDown(await card(name), { key: "Enter" });
    expect((await screen.findByTestId("location")).textContent).toBe(destination);
  });

  it("Avg Revenue states its basis in the org's own terms", async () => {
    renderDashboard();
    await card(/^Avg Revenue\/Customer:/);
    expect(screen.getByText("Collected revenue ÷ 5 customers (lifetime)")).toBeInTheDocument();
  });

  it("the previously linked cards keep their destinations", async () => {
    renderDashboard();
    fireEvent.click(await card(/^Active:/));
    expect(await screen.findByTestId("location")).toHaveTextContent("/billing/customers?status=active");
  });
});
