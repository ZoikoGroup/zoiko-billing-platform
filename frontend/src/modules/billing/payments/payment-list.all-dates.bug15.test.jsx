import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

// BUG-15: the Customer Dashboard's all-time "Total Revenue" card opens
// /billing/payments?status=cleared&all_dates=1. ?all_dates=1 (the
// useListUrlFilters convention) means "do not apply the shared date range":
// no date_from/date_to is sent, a removable chip says so, and the user's own
// global date range is never changed by the link.

const mockPaymentList = vi.fn();
vi.mock("../../../service/billingService", () => ({
  paymentApi: {
    list: (...args) => mockPaymentList(...args),
    getDashboardStats: () => Promise.resolve({ total_count: 0 }),
    listMethods: () => Promise.resolve([]),
  },
  invoiceApi: { list: () => Promise.resolve({ items: [] }), get: () => Promise.resolve({}) },
  customerApi: { search: () => Promise.resolve([]), get: () => Promise.resolve({}) },
  creditNoteApi: { list: () => Promise.resolve({ items: [] }) },
  settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }) },
}));

if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function scrollToPolyfill() {};
}

import PaymentListPage from "./payment-list";

function Probe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.search}</div>;
}
const renderAt = (url) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes><Route path="/billing/payments" element={<><PaymentListPage /><Probe /></>} /></Routes>
  </MemoryRouter>
);
const lastParams = () => mockPaymentList.mock.calls.at(-1)[0];

beforeEach(() => {
  vi.clearAllMocks();
  try { localStorage.clear(); } catch { /* ignore */ }
  mockPaymentList.mockResolvedValue({ items: [], total: 0 });
});
afterEach(() => cleanup());

describe("BUG-15 payments list ?all_dates=1", () => {
  it("lists cleared payments for all time: no date range is sent", async () => {
    renderAt("/billing/payments?status=cleared&all_dates=1");
    await waitFor(() => expect(mockPaymentList).toHaveBeenCalled());
    expect(lastParams()).toMatchObject({ status: "cleared" });
    expect(lastParams().date_from).toBeUndefined();
    expect(lastParams().date_to).toBeUndefined();
    expect(screen.getByText("All dates (date range not applied)")).toBeInTheDocument();
  });

  it("without the flag the shared date range still applies (unchanged behaviour)", async () => {
    renderAt("/billing/payments?status=cleared");
    await waitFor(() => expect(mockPaymentList).toHaveBeenCalled());
    expect(lastParams().date_from).toBeTruthy();
    expect(lastParams().date_to).toBeTruthy();
    expect(screen.queryByText("All dates (date range not applied)")).not.toBeInTheDocument();
  });

  it("the link does not change the user's saved global date range", async () => {
    renderAt("/billing/payments?status=cleared&all_dates=1");
    await waitFor(() => expect(mockPaymentList).toHaveBeenCalled());
    let saved = null;
    try { saved = localStorage.getItem("zoiko_billing_date_range"); } catch { /* ignore */ }
    expect(saved === null || !/all/i.test(saved)).toBe(true);
  });

  it("removing the chip restores the date range and keeps the status filter", async () => {
    renderAt("/billing/payments?status=cleared&all_dates=1");
    fireEvent.click(await screen.findByRole("button", { name: "Remove filter: All dates (date range not applied)" }));
    await waitFor(() => expect(lastParams().date_from).toBeTruthy());
    expect(lastParams().status).toBe("cleared");
    expect(screen.getByTestId("location").textContent).toBe("?status=cleared");
  });

  it("Clear filters drops both the status and the all-dates flag", async () => {
    renderAt("/billing/payments?status=cleared&all_dates=1");
    await waitFor(() => expect(mockPaymentList).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(lastParams().status).toBeUndefined());
    expect(lastParams().date_from).toBeTruthy();
    expect(screen.getByTestId("location").textContent).toBe("");
  });
});
