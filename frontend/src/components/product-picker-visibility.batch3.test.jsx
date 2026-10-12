import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Batch 3 / H: "Prev / Next / Clear Selection not visible" on invoice create.
// jsdom has no layout, so the geometry is asserted through the classes that
// produce it: the picker list height is viewport-relative (the fixed 448px
// list pushed the controls below the 85vh modal's fold), the selection footer
// is sticky inside the modal's scroll area, Clear Selection is a real button,
// and the shell reserves room under every page for the floating assistant
// launcher that covered the wizard's bottom-right Next button.

if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollIntoView = HTMLElement.prototype.scrollIntoView || function noop() {};
}

import { BulkProductPickerModal } from "./billing-shared";

const products = Array.from({ length: 20 }, (_, i) => ({
  id: `p${i}`, name: `Product ${i}`, sku: `SKU-${i}`, unit_price: 10, currency: "USD", product_type: "product", is_active: true,
}));

afterEach(() => cleanup());

function renderPicker() {
  const fetchProducts = vi.fn().mockResolvedValue({ items: products, total: 45, pages: 3 });
  render(<BulkProductPickerModal open onClose={() => {}} fetchProducts={fetchProducts} fetchCategories={() => Promise.resolve([])} onAddSelected={() => {}} />);
  return fetchProducts;
}

describe("H. Bulk product picker controls stay reachable", () => {
  it("is a labelled dialog with Prev/Next pagination", async () => {
    const fetchProducts = renderPicker();
    expect(screen.getByRole("dialog", { name: "Add Products / Services" })).toBeInTheDocument();
    await waitFor(() => expect(fetchProducts).toHaveBeenCalled());
    const next = await screen.findByRole("button", { name: /Next/ });
    expect(screen.getByRole("button", { name: /Prev/ })).toBeDisabled();
    expect(next).toBeEnabled();
    fireEvent.click(next);
    await waitFor(() => expect(fetchProducts.mock.calls.at(-1)[0].page).toBe(2));
  });

  it("list height is viewport-relative, not a fixed 448px", async () => {
    renderPicker();
    const list = await screen.findByRole("listbox");
    expect(list.className).toContain("max-h-[40vh]");
    expect(list.className).not.toContain("max-h-112");
  });

  it("Clear Selection is a visible bordered button in a sticky footer", async () => {
    renderPicker();
    await screen.findByText("Product 0");
    const clear = screen.getByRole("button", { name: "Clear Selection" });
    expect(clear).toBeDisabled();
    expect(clear.className).toMatch(/\bborder\b/);
    expect(clear.parentElement.parentElement.className).toContain("sticky");
    fireEvent.click(screen.getByRole("button", { name: /Select All/ }));
    expect(clear).toBeEnabled();
    fireEvent.click(clear);
    expect(clear).toBeDisabled();
  });
});

describe("H. Shell leaves room for the floating assistant launcher", () => {
  it("page content area has bottom padding clearing the fixed launcher", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "BillingShell.jsx"), "utf8");
    expect(src).toMatch(/fixed bottom-6 right-6/);
    expect(src).toMatch(/min-w-0 max-w-full overflow-x-hidden px-4 pt-6 pb-24/);
  });
});
