import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// BUG-11.4 / 11.13: "Prev, Next & Clear Selection not visible" in the invoice
// product picker. Disabled Clear Selection was opacity-40 (read as missing),
// and Prev/Next unmounted whenever the current page had no rows — including a
// later page that came back empty, which stranded the user.

if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollIntoView = HTMLElement.prototype.scrollIntoView || function noop() {};
}

import { BulkProductPickerModal } from "./billing-shared";

const products = Array.from({ length: 20 }, (_, i) => ({
  id: `p${i}`, name: `Product ${i}`, sku: `SKU-${i}`, unit_price: 10, currency: "USD", product_type: "product", is_active: true,
}));

afterEach(() => cleanup());

const renderPicker = (fetchProducts) =>
  render(<BulkProductPickerModal open onClose={() => {}} fetchProducts={fetchProducts} fetchCategories={() => Promise.resolve([])} onAddSelected={() => {}} />);

describe("BUG-11 product picker controls", () => {
  it("disabled Clear Selection is muted but readable, not faded to opacity-40", async () => {
    renderPicker(vi.fn().mockResolvedValue({ items: products, total: 45, pages: 3 }));
    await screen.findByText("Product 0");
    const clear = screen.getByRole("button", { name: "Clear Selection" });
    expect(clear).toBeDisabled();
    expect(clear.className).not.toContain("opacity-40");
    // slate-600 on slate-100: ~6.9:1, above the 4.5:1 normal-text guideline
    // (slate-500 measured 4.35:1 in the Phase 6 browser check).
    expect(clear.className).toContain("disabled:text-slate-600");
    expect(clear.className).not.toContain("disabled:text-slate-500");
    expect(clear.className).toContain("disabled:cursor-not-allowed");
  });

  it("a later page that returns 0 results keeps Prev available", async () => {
    const fetchProducts = vi.fn(({ page }) => Promise.resolve(
      page === 1 ? { items: products, total: 45, pages: 3 } : { items: [], total: 45, pages: 3 },
    ));
    renderPicker(fetchProducts);
    await screen.findByText("Product 0");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() => expect(fetchProducts.mock.calls.at(-1)[0].page).toBe(2));
    expect(await screen.findByText("No products found")).toBeInTheDocument();
    const prev = screen.getByRole("button", { name: /Prev/ });
    expect(prev).toBeEnabled();
    expect(screen.getByText(/page 2 of 3/)).toBeInTheDocument();
    fireEvent.click(prev);
    await waitFor(() => expect(fetchProducts.mock.calls.at(-1)[0].page).toBe(1));
    expect(await screen.findByText("Product 0")).toBeInTheDocument();
  });

  it("pagination stays mounted while the next page loads", async () => {
    let resolvePage2;
    const fetchProducts = vi.fn(({ page }) => (page === 1
      ? Promise.resolve({ items: products, total: 45, pages: 3 })
      : new Promise((r) => { resolvePage2 = r; })));
    renderPicker(fetchProducts);
    await screen.findByText("Product 0");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText("Searching...")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Prev/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Next/ })).toBeInTheDocument();
    resolvePage2({ items: products.slice(0, 5), total: 45, pages: 3 });
    await waitFor(() => expect(screen.queryByText("Searching...")).toBeNull());
  });

  it("a genuinely empty first-page search hides pagination", async () => {
    renderPicker(vi.fn().mockResolvedValue({ items: [], total: 0, pages: 1 }));
    expect(await screen.findByText("No products found")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Prev/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Next/ })).toBeNull();
  });
});
