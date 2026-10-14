import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// Data-fetching hardening:
// - invoice dashboard: when the date range changes while the previous
//   range's request is still in flight, the older response (resolving last)
//   must not overwrite the newer range's data.
// - product profile: each tab's list endpoint is fetched once per
//   (product id, tab) change -- no duplicate request from two effects, and a
//   refresh refetches each list exactly once.

const m = vi.hoisted(() => ({
  topCustomers: vi.fn(),
  productGet: vi.fn(),
  pricingList: vi.fn(),
  invoiceList: vi.fn(),
  quoteList: vi.fn(),
  contractList: vi.fn(),
  subscriptionList: vi.fn(),
  auditList: vi.fn(),
}));

vi.mock("../../service/billingService", () => ({
  invoiceApi: {
    getEnterpriseDashboard: vi.fn(() => Promise.resolve({ total_invoices: 0, status_counts: {} })),
    getInvoiceTrend: vi.fn(() => Promise.resolve([])),
    getRevenueTrend: vi.fn(() => Promise.resolve([])),
    getPaymentCollectionTrend: vi.fn(() => Promise.resolve([])),
    getStatusDistribution: vi.fn(() => Promise.resolve([])),
    getMonthlyRevenue: vi.fn(() => Promise.resolve([])),
    getRecentActivity: vi.fn(() => Promise.resolve([])),
    getTopCustomers: (...a) => m.topCustomers(...a),
    list: (...a) => m.invoiceList(...a),
  },
  productApi: {
    get: (...a) => m.productGet(...a),
    listCategories: vi.fn(() => Promise.resolve([])),
  },
  pricingApi: { listByProduct: (...a) => m.pricingList(...a) },
  quoteApi: { list: (...a) => m.quoteList(...a) },
  contractApi: { list: (...a) => m.contractList(...a) },
  subscriptionApi: { list: (...a) => m.subscriptionList(...a) },
  auditApi: { list: (...a) => m.auditList(...a) },
  settingsApi: { getConfig: vi.fn(() => Promise.resolve({ base_currency: "USD" })) },
}));

import InvoiceDashboard from "./invoicing/invoice-dashboard";
import ProductProfilePage from "./products/product-profile";
import { useBillingDateRange } from "./utils/DateRangeContext";

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  m.invoiceList.mockResolvedValue({ items: [], total: 0 });
  m.productGet.mockResolvedValue({ id: 7, name: "Widget Pro", status: "active", type: "service" });
  m.pricingList.mockResolvedValue([]);
  m.quoteList.mockResolvedValue([]);
  m.contractList.mockResolvedValue([]);
  m.subscriptionList.mockResolvedValue([]);
  m.auditList.mockResolvedValue([]);
});
afterEach(() => cleanup());

function RangeSwitcher() {
  const { setRange, reset } = useBillingDateRange();
  return (
    <>
      <button onClick={() => setRange("last_7_days")}>switch-range</button>
      <button onClick={() => reset()}>reset-range</button>
    </>
  );
}

describe("InvoiceDashboard — stale range responses", () => {
  it("drops the previous range's response when it resolves after the new range's", async () => {
    const calls = [];
    m.topCustomers.mockImplementation(() => {
      const d = deferred();
      calls.push(d);
      return d.promise;
    });

    render(
      <MemoryRouter>
        <RangeSwitcher />
        <InvoiceDashboard />
      </MemoryRouter>
    );
    await waitFor(() => expect(calls).toHaveLength(1));

    fireEvent.click(screen.getByText("switch-range"));
    await waitFor(() => expect(calls).toHaveLength(2));

    // New range resolves first, then the OLD range's slow response lands.
    await act(async () => {
      calls[1].resolve([{ customer_id: 2, customer_name: "New Range Co", total_amount: 200, invoice_count: 1 }]);
    });
    expect(await screen.findByText("New Range Co")).toBeInTheDocument();

    await act(async () => {
      calls[0].resolve([{ customer_id: 1, customer_name: "Old Range Co", total_amount: 100, invoice_count: 1 }]);
    });
    // Let any pending state updates flush.
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText("New Range Co")).toBeInTheDocument();
    expect(screen.queryByText("Old Range Co")).toBeNull();

    fireEvent.click(screen.getByText("reset-range"));
  });
});

describe("ProductProfilePage — tab list requests", () => {
  const renderProduct = () => render(
    <MemoryRouter initialEntries={["/billing/products/7"]}>
      <Routes>
        <Route path="/billing/products/:id" element={<ProductProfilePage />} />
      </Routes>
    </MemoryRouter>
  );

  it("fetches each summary list once on load and does not double-fetch the active tab's endpoint", async () => {
    renderProduct();
    await screen.findAllByText("Widget Pro");
    await waitFor(() => expect(m.pricingList).toHaveBeenCalledTimes(1));
    expect(m.invoiceList).toHaveBeenCalledTimes(1);
    expect(m.contractList).toHaveBeenCalledTimes(1);
    expect(m.subscriptionList).toHaveBeenCalledTimes(1);

    // Switching to the Pricing tab fetches pricing exactly once more.
    fireEvent.click(screen.getByRole("button", { name: /^\s*pricing plans\s*$/i }));
    await waitFor(() => expect(m.pricingList).toHaveBeenCalledTimes(2));

    // Refresh while on Pricing: product + each list exactly once (the tab
    // effect and the summary effect used to both fire pricing).
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(m.productGet).toHaveBeenCalledTimes(2));
    await screen.findAllByText("Widget Pro");
    await act(async () => { await Promise.resolve(); });

    expect(m.pricingList).toHaveBeenCalledTimes(3);
    expect(m.invoiceList).toHaveBeenCalledTimes(2);
    expect(m.contractList).toHaveBeenCalledTimes(2);
    expect(m.subscriptionList).toHaveBeenCalledTimes(2);
    expect(m.quoteList).not.toHaveBeenCalled();
  });

  it("an unrelated tab (Quotations) fetches only its own endpoint once", async () => {
    renderProduct();
    await screen.findAllByText("Widget Pro");
    await waitFor(() => expect(m.invoiceList).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: /^\s*quotations\s*$/i }));
    await waitFor(() => expect(m.quoteList).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });

    expect(m.quoteList).toHaveBeenCalledTimes(1);
    expect(m.invoiceList).toHaveBeenCalledTimes(1);
    expect(m.pricingList).toHaveBeenCalledTimes(1);
  });
});
