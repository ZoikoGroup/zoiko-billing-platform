import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";

// BUG-12.4 (/billing/products/pricing-plans). Clear filters already existed
// (pricing-plans Clear tests in clear-filters.b2b3b5.hardening). The confirmed
// gap: Product Profile links here with ?product_id=<id>, but the page never
// read the URL, so the list was never narrowed to that product. Now the id is
// sent to GET /pricing-plans, shown as a chip, kept by Clear filters (it is
// route context, not a page filter) and dropped only by the chip's own action.

const m = vi.hoisted(() => ({ planList: vi.fn(), prodList: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  pricingApi: { list: (...a) => m.planList(...a), addTier: vi.fn(), create: vi.fn(), deactivate: vi.fn(), listTiers: () => Promise.resolve([]), removeTier: vi.fn(), update: vi.fn() },
  productApi: { list: (...a) => m.prodList(...a) },
  settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }), get: () => Promise.resolve({}) },
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children, actions }) => <div><h1>{title}</h1>{actions}{children}</div> }));

import ProductPricingPlansPage from "./pricing-plans";

function Probe() {
  const loc = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <div data-testid="location">{loc.pathname}{loc.search}</div>
      <button type="button" onClick={() => navigate(-1)}>test-back</button>
      <button type="button" onClick={() => navigate("/billing/products/pricing-plans?product_id=8")}>test-go-8</button>
    </div>
  );
}

function renderAt(url) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/billing/products/pricing-plans" element={<><ProductPricingPlansPage /><Probe /></>} />
      </Routes>
    </MemoryRouter>
  );
}

const lastParams = () => m.planList.mock.calls.at(-1)[0];
const location = () => screen.getByTestId("location").textContent;

beforeEach(() => {
  vi.clearAllMocks();
  m.planList.mockResolvedValue({ items: [], total: 0 });
  m.prodList.mockResolvedValue({ items: [{ id: 7, name: "Widget Pro" }, { id: 8, name: "Gadget" }] });
});
afterEach(() => cleanup());

describe("BUG-12.4 Pricing Plans honours ?product_id", () => {
  it("initial navigation from Product Profile narrows the list to that product and shows it", async () => {
    renderAt("/billing/products/pricing-plans?product_id=7");
    await waitFor(() => expect(m.planList).toHaveBeenCalled());
    expect(lastParams()).toMatchObject({ product_id: 7, page: 1 });
    expect(await screen.findByText("Product: Widget Pro")).toBeInTheDocument();
  });

  it("without product_id the list is unscoped and no chip shows", async () => {
    renderAt("/billing/products/pricing-plans");
    await waitFor(() => expect(m.planList).toHaveBeenCalled());
    expect(lastParams().product_id).toBeUndefined();
    expect(screen.queryByText(/^Product:/)).not.toBeInTheDocument();
  });

  it("ignores a malformed product_id instead of sending it", async () => {
    renderAt("/billing/products/pricing-plans?product_id=abc");
    await waitFor(() => expect(m.planList).toHaveBeenCalled());
    expect(lastParams().product_id).toBeUndefined();
  });

  it("Refresh keeps the product scope", async () => {
    renderAt("/billing/products/pricing-plans?product_id=7");
    await waitFor(() => expect(m.planList).toHaveBeenCalled());
    const before = m.planList.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(m.planList.mock.calls.length).toBeGreaterThan(before));
    expect(lastParams().product_id).toBe(7);
  });

  it("Clear filters resets the page filters but keeps product_id and unrelated params", async () => {
    renderAt("/billing/products/pricing-plans?product_id=7&from=profile");
    fireEvent.change(await screen.findByLabelText("Search pricing plans"), { target: { value: "gold" } });
    await waitFor(() => expect(lastParams()).toMatchObject({ search_term: "gold", product_id: 7 }));
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    await waitFor(() => expect(lastParams().search_term).toBeUndefined());
    expect(lastParams()).toMatchObject({ product_id: 7, page: 1 });
    expect(screen.getByLabelText("Search pricing plans")).toHaveValue("");
    expect(location()).toBe("/billing/products/pricing-plans?product_id=7&from=profile");
    expect(screen.getByText("Product: Widget Pro")).toBeInTheDocument();
  });

  it("the chip's remove action drops only product_id and reloads unscoped", async () => {
    renderAt("/billing/products/pricing-plans?product_id=7&from=profile");
    fireEvent.click(await screen.findByRole("button", { name: "Show plans for all products" }));
    await waitFor(() => expect(lastParams().product_id).toBeUndefined());
    expect(location()).toBe("/billing/products/pricing-plans?from=profile");
    expect(screen.queryByText(/^Product:/)).not.toBeInTheDocument();
  });

  it("browser navigation between product contexts follows the URL", async () => {
    renderAt("/billing/products/pricing-plans?product_id=7");
    await screen.findByText("Product: Widget Pro");
    fireEvent.click(screen.getByRole("button", { name: "test-go-8" }));
    await waitFor(() => expect(lastParams().product_id).toBe(8));
    expect(await screen.findByText("Product: Gadget")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "test-back" }));
    await waitFor(() => expect(lastParams().product_id).toBe(7));
    expect(await screen.findByText("Product: Widget Pro")).toBeInTheDocument();
  });

  it("falls back to the id when the product is not in the loaded list", async () => {
    renderAt("/billing/products/pricing-plans?product_id=99");
    expect(await screen.findByText("Product: #99")).toBeInTheDocument();
    expect(lastParams().product_id).toBe(99);
  });
});
