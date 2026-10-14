import { describe, it, expect, vi } from "vitest";

// Batch 3 / D: pricing dashboard KPIs. Product and plan ids are integers in the
// API (PricingPlanResponse.product_id: int), and the old "without plans" check
// compared against String(id) too, so every product was reported as having no
// pricing plan.

vi.mock("../../../service/billingService", () => ({
  pricingApi: {}, productApi: {}, subscriptionApi: {}, currencyPricingApi: {}, discountApi: {},
}));

import { pricingCoverage, averagePlanPrice } from "./dashboard";

const products = [{ id: 1 }, { id: 2 }, { id: 3 }];

describe("D. Pricing coverage", () => {
  it("integer ids: products with plans are not reported as uncovered", () => {
    const c = pricingCoverage(products, [{ product_id: 1 }, { product_id: 2 }, { product_id: 2 }]);
    expect(c.uncovered.map((p) => p.id)).toEqual([3]);
    expect(c.covered).toHaveLength(2);
    expect(c.pct).toBe("66.7");
  });

  it("plans for products outside the catalog or with no product never push coverage past 100%", () => {
    const c = pricingCoverage([{ id: 1 }], [{ product_id: 1 }, { product_id: 99 }, { product_id: null }]);
    expect(c.pct).toBe("100.0");
    expect(c.covered).toHaveLength(1);
  });

  it("string and integer ids match each other", () => {
    expect(pricingCoverage([{ id: "5" }], [{ product_id: 5 }]).uncovered).toHaveLength(0);
  });

  it("empty catalog is 0%", () => {
    expect(pricingCoverage([], [{ product_id: 1 }]).pct).toBe("0.0");
  });
});

describe("D. Avg plan price", () => {
  it("flags mixed currencies instead of presenting an unconverted average as base currency", () => {
    const r = averagePlanPrice([{ unit_price: "10", currency: "USD" }, { unit_price: "30", currency: "EUR" }], "USD");
    expect(r.avg).toBe(20);
    expect(r.mixedCurrencies).toBe(true);
  });

  it("single currency (missing currency = base) is not flagged", () => {
    const r = averagePlanPrice([{ unit_price: "10", currency: "usd" }, { unit_price: "20" }], "USD");
    expect(r.mixedCurrencies).toBe(false);
    expect(r.avg).toBe(15);
  });
});
