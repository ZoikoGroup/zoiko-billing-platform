import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

// BUG-15: the Customer Dashboard "Over Credit Limit" card opens
// /billing/customers?over_credit_limit=1. The list sends the flag to the
// server (which applies the KPI's own predicate), shows a removable chip, and
// Clear removes it together with any ?status= deep link in one URL update.

const m = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  customerApi: {
    list: (...a) => m.list(...a), getKPI: () => Promise.resolve(null), create: vi.fn(), update: vi.fn(),
    activate: vi.fn(), deactivate: vi.fn(), suspend: vi.fn(), bulkDelete: vi.fn(), exportData: vi.fn(),
  },
  settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }) },
}));

import CustomerListPage from "./customer-list";

function Probe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.search}</div>;
}
const renderAt = (url) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes><Route path="/billing/customers" element={<><CustomerListPage /><Probe /></>} /></Routes>
  </MemoryRouter>
);
const lastParams = () => m.list.mock.calls.at(-1)[0];

beforeEach(() => {
  vi.clearAllMocks();
  m.list.mockResolvedValue({ items: [], total: 0 });
});
afterEach(() => cleanup());

describe("BUG-15 customer list ?over_credit_limit=1", () => {
  it("sends the server filter and shows a removable chip", async () => {
    renderAt("/billing/customers?over_credit_limit=1");
    await waitFor(() => expect(m.list).toHaveBeenCalled());
    expect(lastParams().over_credit_limit).toBe(true);
    expect(screen.getByText("Over credit limit")).toBeInTheDocument();
  });

  it("without the flag nothing extra is sent", async () => {
    renderAt("/billing/customers");
    await waitFor(() => expect(m.list).toHaveBeenCalled());
    expect(lastParams().over_credit_limit).toBeUndefined();
    expect(screen.queryByText("Over credit limit")).not.toBeInTheDocument();
  });

  it("removing the chip reloads the unfiltered list", async () => {
    renderAt("/billing/customers?over_credit_limit=1");
    fireEvent.click(await screen.findByRole("button", { name: "Remove filter: Over credit limit" }));
    await waitFor(() => expect(lastParams().over_credit_limit).toBeUndefined());
    expect(screen.getByTestId("location").textContent).toBe("");
  });

  it("Clear removes it together with a ?status= deep link", async () => {
    renderAt("/billing/customers?status=active&over_credit_limit=1");
    await waitFor(() => expect(lastParams()).toMatchObject({ over_credit_limit: true, status: "active" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(lastParams().over_credit_limit).toBeUndefined());
    expect(lastParams().status).toBeUndefined();
    expect(screen.getByTestId("location").textContent).toBe("");
  });
});
