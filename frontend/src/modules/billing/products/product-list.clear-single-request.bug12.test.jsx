import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// BUG-12.2 (/billing/products): Clear filters exists (see
// clear-filters.b2b3b5.hardening). The confirmed defect: Clear called
// fetchProducts directly AND its state reset re-ran the fetch effect, so the
// same unfiltered request went out twice. Clear must now send exactly one
// request, with no filter params, on page 1.

const m = vi.hoisted(() => ({ prodList: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  productApi: {
    list: (...a) => m.prodList(...a), listCategories: () => Promise.resolve([]),
    bulkDelete: vi.fn(), bulkStatus: vi.fn(), create: vi.fn(), delete: vi.fn(), duplicate: vi.fn(), exportCatalog: vi.fn(), restore: vi.fn(), update: vi.fn(),
  },
  settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }), get: () => Promise.resolve({}) },
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children, actions }) => <div><h1>{title}</h1>{actions}{children}</div> }));

import ProductListPage from "./product-list";

const FILTER_KEYS = ["search_term", "product_type", "status", "category_id", "currency"];
const lastParams = () => m.prodList.mock.calls.at(-1)[0];

beforeEach(() => {
  vi.clearAllMocks();
  m.prodList.mockResolvedValue({ items: [{ id: 1, name: "Widget", code: "W1", status: "active" }], total: 1 });
});
afterEach(() => cleanup());

describe("BUG-12.2 Products — Clear filters", () => {
  it("sends exactly one unfiltered page-1 request", async () => {
    render(<MemoryRouter><ProductListPage /></MemoryRouter>);
    const search = await screen.findByLabelText("Search by name, code");
    fireEvent.change(search, { target: { value: "zzz" } });
    await waitFor(() => expect(lastParams().search_term).toBe("zzz"), { timeout: 2000 });

    const before = m.prodList.mock.calls.length;
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);

    await waitFor(() => expect(m.prodList.mock.calls.length).toBe(before + 1));
    // Give any stray duplicate a chance to fire before asserting it didn't.
    await new Promise((r) => setTimeout(r, 600));
    expect(m.prodList.mock.calls.length).toBe(before + 1);
    const params = lastParams();
    for (const key of FILTER_KEYS) expect(params[key]).toBeUndefined();
    expect(params.page).toBe(1);
    expect(search).toHaveValue("");
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
  });

  it("with only an un-debounced search typed, Clear resets the box without a request", async () => {
    render(<MemoryRouter><ProductListPage /></MemoryRouter>);
    const search = await screen.findByLabelText("Search by name, code");
    await waitFor(() => expect(m.prodList).toHaveBeenCalled());
    const before = m.prodList.mock.calls.length;
    fireEvent.change(search, { target: { value: "z" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    expect(search).toHaveValue("");
    await new Promise((r) => setTimeout(r, 600));
    expect(m.prodList.mock.calls.length).toBe(before);
    expect(screen.getByText("Widget")).toBeInTheDocument();
  });
});
