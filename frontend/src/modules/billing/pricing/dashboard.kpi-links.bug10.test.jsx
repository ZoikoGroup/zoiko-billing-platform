import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

// BUG-10 (/billing/pricing/dashboard): "Avg Plan Price & Revenue Coverage
// CTR's buttons are not working". Both DashboardStatCards had no href/onClick,
// so the shared card rendered them as inert tiles. Approved destinations (D2):
//   Avg Plan Price                          -> /billing/products/pricing-plans
//   Pricing Coverage (was "Revenue Coverage") -> /billing/products
// No filters are added and the metric calculations are untouched.

if (typeof global.ResizeObserver === "undefined") {
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

vi.mock("../../../service/billingService", () => ({
  pricingApi: {
    list: () => Promise.resolve({ items: [
      { id: 1, name: "Basic", price: "10.00", currency: "USD", is_active: true, product_id: 1, pricing_model: "flat_rate" },
      { id: 2, name: "Pro", price: "30.00", currency: "USD", is_active: true, product_id: 1, pricing_model: "flat_rate" },
    ] }),
    listTiers: () => Promise.resolve([]),
  },
  productApi: { list: () => Promise.resolve({ items: [{ id: 1, name: "Widget" }, { id: 2, name: "Gadget" }] }) },
  subscriptionApi: { list: () => Promise.resolve({ items: [] }) },
  currencyPricingApi: { list: () => Promise.resolve({ items: [] }) },
  discountApi: { list: () => Promise.resolve({ items: [] }) },
}));

import PricingDashboardPage from "./dashboard";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname}{loc.search}</div>;
}

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={["/billing/pricing/dashboard"]}>
      <Routes>
        <Route path="/billing/pricing/dashboard" element={<PricingDashboardPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

afterEach(() => cleanup());

describe("BUG-10 — Pricing Dashboard KPI cards navigate", () => {
  it("Avg Plan Price opens Pricing Plans", async () => {
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: /^Avg Plan Price:/ }, { timeout: 4000 }));
    expect(await screen.findByTestId("location")).toHaveTextContent(/^\/billing\/products\/pricing-plans$/);
  });

  it("Pricing Coverage (formerly Revenue Coverage) opens Products", async () => {
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: /^Pricing Coverage:/ }, { timeout: 4000 }));
    expect(await screen.findByTestId("location")).toHaveTextContent(/^\/billing\/products$/);
  });

  it("both cards are keyboard-operable with an accessible name that includes the value", async () => {
    renderDashboard();
    const avg = await screen.findByRole("button", { name: /^Avg Plan Price:/ }, { timeout: 4000 });
    expect(avg).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: /^Pricing Coverage: \d+(\.\d+)?%/ })).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(avg, { key: "Enter" });
    expect(await screen.findByTestId("location")).toHaveTextContent("/billing/products/pricing-plans");
  });
});
