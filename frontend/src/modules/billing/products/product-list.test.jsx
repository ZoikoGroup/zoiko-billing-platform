import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// QA defect #4 (/billing/products): "In Add Product Category not showing
// any options" -- the product's own Category dropdown in the "Add Product"
// modal (not the Add-Category admin page). Same root cause as #10/#11 per
// the master defect report §3.9: category creation silently 422'd (missing
// required `code`), so no organization ever had categories to show here.
// That's fixed on categories.jsx; this test proves the *consumer* side --
// ProductListPage's "Add Product" Category dropdown -- correctly renders
// whatever productApi.listCategories() returns.

const mockProductList = vi.fn();
const mockListCategories = vi.fn();

vi.mock("../../../service/billingService", () => ({
  productApi: {
    list: (...args) => mockProductList(...args),
    listCategories: (...args) => mockListCategories(...args),
  },
}));

vi.mock("./import-wizard", () => ({ default: () => null }));

if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function scrollToPolyfill() {};
}

import ProductListPage from "./product-list";

const CATEGORY = { id: 5, name: "Networking" };

function renderPage() {
  return render(
    <MemoryRouter>
      <ProductListPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockProductList.mockResolvedValue({ items: [], total: 0 });
  mockListCategories.mockResolvedValue([CATEGORY]);
});

describe("Add Product — Category dropdown (defect #4)", () => {
  it("renders the org's categories as options in the New Product modal", async () => {
    renderPage();
    await waitFor(() => expect(mockProductList).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Add Product" }));
    await screen.findByText("New Product");
    await waitFor(() => expect(mockListCategories).toHaveBeenCalled());

    // The "Category" <label> has no htmlFor/id pairing with its <select> (a
    // pre-existing, separate a11y gap out of scope here), so locate the
    // control via the DOM instead of getByLabelText.
    await waitFor(() => {
      const categoryLabel = screen.getByText("Category");
      const categorySelect = categoryLabel.parentElement.querySelector("select");
      expect(categorySelect.querySelector(`option[value="${CATEGORY.id}"]`)).not.toBeNull();
    });
  });
});
