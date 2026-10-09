import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// B4 (/billing/products/categories): tree rows were mouse-only divs, toggles
// were all named just "Expand"/"Collapse", a fast A→B selection could show
// A's products under B, and a failed product load looked like an empty
// category ("No products in this category").

const m = vi.hoisted(() => ({ listCategories: vi.fn(), productList: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  productApi: {
    listCategories: (...a) => m.listCategories(...a),
    createCategory: vi.fn(), updateCategory: vi.fn(), deleteCategory: vi.fn(),
    list: (...a) => m.productList(...a),
  },
}));
if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};

import CategoriesPage from "./categories";

const LONG = "Enterprise Networking Hardware and Accessories — Long Name";
const TREE = [
  { id: 1, name: "Hardware", status: "active", children_count: 1, children: [{ id: 3, name: LONG, status: "active", children: [], children_count: 0 }] },
  { id: 2, name: "Software", status: "active", children: [], children_count: 0 },
];
const product = (id, name, category_id) => ({ id, name, category_id, product_type: "physical", default_price: 10, currency: "INR", status: "active" });

beforeEach(() => {
  vi.clearAllMocks();
  m.listCategories.mockResolvedValue(TREE);
  m.productList.mockImplementation(({ category_id } = {}) => Promise.resolve({
    items: category_id === 1 ? [product(11, "Router", 1)] : category_id === 2 ? [product(21, "Licence", 2)] : [],
  }));
});
afterEach(() => cleanup());

const renderPage = () => render(<MemoryRouter><CategoriesPage /></MemoryRouter>);
const treeitem = (name) => screen.getAllByRole("treeitem").find((el) => el.getAttribute("title") === name);

describe("B4 Categories tree", () => {
  it("rows are keyboard-operable tree items; toggles name their category", async () => {
    renderPage();
    await screen.findByRole("tree", { name: "Product categories" });
    const hw = treeitem("Hardware");
    expect(hw).toHaveAttribute("tabindex", "0");
    expect(within(hw).getByRole("button", { name: "Expand Hardware" })).toBeInTheDocument();
    fireEvent.keyDown(hw, { key: "ArrowRight" });
    expect(await screen.findByRole("button", { name: "Collapse Hardware" })).toBeInTheDocument();
    expect(treeitem(LONG)).toHaveAttribute("title", LONG); // long names readable on hover
    fireEvent.keyDown(treeitem("Software"), { key: "Enter" });
    await waitFor(() => expect(treeitem("Software")).toHaveAttribute("aria-selected", "true"));
  });

  it("a slow response for the previous category cannot overwrite the current one", async () => {
    let releaseHardware;
    m.productList.mockImplementation(({ category_id }) => (category_id === 1
      ? new Promise((r) => { releaseHardware = () => r({ items: [product(11, "Router", 1)] }); })
      : Promise.resolve({ items: [product(21, "Licence", 2)] })));
    renderPage();
    await screen.findByRole("tree");
    fireEvent.click(treeitem("Hardware"));
    fireEvent.click(treeitem("Software"));
    expect(await screen.findByText("Licence")).toBeInTheDocument();
    releaseHardware?.();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText("Router")).toBeNull();
  });

  it("a failed product load is an error with Retry, not an empty category", async () => {
    let softwareCalls = 0;
    m.productList.mockImplementation(({ category_id }) => {
      if (category_id !== 2) return Promise.resolve({ items: [] });
      softwareCalls += 1;
      return softwareCalls === 1 ? Promise.reject(new Error("Couldn't reach the server")) : Promise.resolve({ items: [product(21, "Licence", 2)] });
    });
    renderPage();
    await screen.findByRole("tree");
    fireEvent.click(treeitem("Software"));
    // Generous timeouts: this runs under the full suite's load.
    expect(await screen.findByText(/Couldn't reach the server/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText(/No products (directly )?in this category/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(await screen.findByText("Licence", {}, { timeout: 5000 })).toBeInTheDocument();
  });
});
