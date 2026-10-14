import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Section 4 (performance): the dashboard no longer waits for its slowest
// request. Each widget renders when its own data arrives, below-the-fold
// widgets load lazily, and in-flight requests are capped.

if (typeof global.ResizeObserver === "undefined") {
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const h = vi.hoisted(() => ({ calls: [], pending: {}, inflight: 0, maxInflight: 0, mode: "controlled" }));

vi.mock("../../../service/billingService", () => {
  // Every call is recorded; "controlled" mode returns a promise the test settles.
  const make = (name, immediate) => (...args) => {
    h.calls.push(name);
    if (immediate !== undefined && h.mode === "mixed") return Promise.resolve(immediate);
    h.inflight += 1;
    h.maxInflight = Math.max(h.maxInflight, h.inflight);
    return new Promise((resolve, reject) => {
      (h.pending[name] ||= []).push({ resolve: (v) => { h.inflight -= 1; resolve(v); }, reject: (e) => { h.inflight -= 1; reject(e); }, args });
    });
  };
  return {
    dashboardApi: { getFull: make("getFull"), getPaymentTrend: make("getPaymentTrend") },
    invoiceApi: { list: make("invoiceList") },
    paymentApi: { list: make("paymentList"), getTotalCollected: vi.fn() },
    customerApi: { list: make("customerList") },
    subscriptionApi: { listActive: make("subsActive"), getReporting: make("reporting") },
    contractApi: { listActive: make("contractsActive"), listExpiring: make("contractsExpiring") },
    collectionApi: { getAgingBuckets: make("aging") },
    auditApi: { list: make("audit") },
    productApi: { list: make("products") },
    settingsApi: { getHealth: make("health") },
  };
});

vi.mock("../utils/CurrencyContext", () => ({
  useCurrency: () => ({ baseCurrency: "USD", currencySymbol: "$", formatCurrency: (v) => `$${v}` }),
}));
vi.mock("../utils/DateRangeContext", () => ({
  useBillingDateRange: () => ({
    range: "all", setRange: () => {}, customStart: "", customEnd: "", applyCustomRange: () => {}, reset: () => {},
    dateRange: {},
  }),
}));
vi.mock("../products/catalog-onboarding", () => ({ default: () => null }));

import Dashboard from "./dashboard";

const FULL = {
  kpis: { total_revenue: 123456, outstanding_amount: 100, paid_amount: 50, collections: 1000, total_invoices: 4, monthly_growth: 5 },
  monthly_revenue: [],
  invoice_summary: {},
};

const settle = async (name, value, i = 0) => {
  await act(async () => { h.pending[name][i].resolve(value); });
};

class FakeIO {
  static instances = [];
  constructor(cb) { this.cb = cb; this.nodes = []; FakeIO.instances.push(this); }
  observe(n) { this.nodes.push(n); }
  unobserve() {}
  disconnect() { this.nodes = []; }
  fire() { this.cb(this.nodes.map((target) => ({ target, isIntersecting: true }))); }
}

const renderDashboard = () => render(<MemoryRouter><Dashboard /></MemoryRouter>);

beforeEach(() => {
  h.calls = []; h.pending = {}; h.inflight = 0; h.maxInflight = 0; h.mode = "controlled";
  FakeIO.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIO);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Settle every request that has been sent so far (not already settled), except
// the names listed in `except`. Newly dequeued requests are picked up by looping.
const drain = async (except = []) => {
  for (let round = 0; round < 6; round += 1) {
    let any = false;
    for (const [name, list] of Object.entries(h.pending)) {
      if (except.includes(name)) continue;
      for (const item of list) {
        if (item.done) continue;
        item.done = true;
        any = true;
        const value = name === "getFull" ? FULL
          : name === "getPaymentTrend" ? { payment_trend: [] }
          : name === "reporting" ? { mrr: 10, arr: 120, reporting_currency: "USD" }
          : { items: [] };
        await act(async () => { item.resolve(value); });
      }
    }
    if (!any) break;
  }
};

describe("dashboard progressive loading", () => {
  it("renders the headline KPI as soon as getFull resolves, before slower requests", async () => {
    renderDashboard();
    expect(screen.getByLabelText("Loading dashboard")).toBeInTheDocument();

    await settle("getFull", FULL);

    // Total Revenue is on screen while payments, customers, subscriptions... are all still pending.
    await waitFor(() => expect(screen.getByText("Total Revenue")).toBeInTheDocument());
    expect(screen.queryByLabelText("Loading dashboard")).not.toBeInTheDocument();
    expect(screen.queryByText("MRR")).not.toBeInTheDocument();

    // Everything except the (slow) subscription reporting call completes.
    await drain(["reporting"]);
    await waitFor(() => expect(h.pending.reporting).toHaveLength(1));
    expect(screen.getByText("Avg Invoice")).toBeInTheDocument();
    expect(screen.queryByText("MRR")).not.toBeInTheDocument();

    await settle("reporting", { mrr: 10, arr: 120, reporting_currency: "USD" });
    await waitFor(() => expect(screen.getByText("MRR")).toBeInTheDocument());
  });

  it("a failed request degrades without blanking the rest of the page", async () => {
    renderDashboard();
    await settle("getFull", FULL);
    await drain(["reporting"]);
    await waitFor(() => expect(h.pending.reporting).toHaveLength(1));
    await act(async () => { h.pending.reporting[0].reject(new Error("boom")); });
    await waitFor(() => expect(screen.getByText("MRR")).toBeInTheDocument());
    expect(screen.getByText("Total Revenue")).toBeInTheDocument();
  });

  it("caps in-flight requests at 6 and sends the headline request first", async () => {
    renderDashboard();
    await act(async () => {});
    expect(h.calls[0]).toBe("getFull");
    expect(h.calls).toHaveLength(6);
    expect(h.maxInflight).toBe(6);
    await drain();
    expect(h.calls.length).toBeGreaterThan(6);
    expect(h.maxInflight).toBeLessThanOrEqual(6);
  });

  it("defers audit/aging until scrolled into view", async () => {
    renderDashboard();
    await drain();
    await act(async () => {});
    expect(h.calls).not.toContain("audit");
    expect(h.calls).not.toContain("aging");

    const observers = FakeIO.instances.filter((o) => o.nodes.length > 0);
    expect(observers.length).toBeGreaterThan(0);
    await act(async () => { observers.forEach((o) => o.fire()); });
    await waitFor(() => expect(h.calls).toContain("audit"));
  });
});
