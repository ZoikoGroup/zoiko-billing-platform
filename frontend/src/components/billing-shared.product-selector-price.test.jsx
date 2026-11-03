import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ProductSelector } from "./billing-shared";

// ProductSelector's built-in price label (used when no formatPrice prop is
// passed, e.g. the pricing-plans screens) read `original_price ||
// default_price || 0`. original_price is the optional list price and arrives
// as the string "0.00" on most products, which is truthy -- so the catalog
// price was hidden behind 0.00, and a product with no price also showed 0.00.

const product = (overrides) => ({ id: 1, name: "Website Audit", code: "AUD", currency: "INR", product_type: "service", ...overrides });

async function renderWithProducts(products, props = {}) {
  const fetchProducts = vi.fn().mockResolvedValue({ items: products, total: products.length });
  const onSelect = vi.fn();
  render(
    <ProductSelector compact showFavorites={false} showRecent={false}
      fetchProducts={fetchProducts} onSelect={onSelect} placeholder="Search products" {...props} />
  );
  const input = screen.getByPlaceholderText("Search products");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "a" } });
  const options = await screen.findAllByRole("option", {}, { timeout: 2000 });
  return { options, onSelect, fetchProducts };
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ProductSelector default price label", () => {
  it("shows the catalog price when original_price is the string \"0.00\"", async () => {
    const { options } = await renderWithProducts([product({ default_price: "1500.00", original_price: "0.00" })]);
    expect(options[0]).toHaveTextContent("INR 1500.00");
    expect(options[0]).not.toHaveTextContent("INR 0.00");
  });

  it("shows the catalog price, not the list price, when both are set", async () => {
    const { options } = await renderWithProducts([product({ default_price: "1200.00", original_price: "1500.00" })]);
    expect(options[0]).toHaveTextContent("INR 1200.00");
    expect(options[0]).not.toHaveTextContent("1500.00");
  });

  it("handles numeric and string prices alike", async () => {
    const { options } = await renderWithProducts([
      product({ id: 1, name: "Numeric", default_price: 249.5 }),
      product({ id: 2, name: "String", default_price: "249.50" }),
    ]);
    expect(options[0]).toHaveTextContent("INR 249.50");
    expect(options[1]).toHaveTextContent("INR 249.50");
  });

  it("keeps a configured zero price as 0.00", async () => {
    const { options } = await renderWithProducts([product({ default_price: "0.00", original_price: "999.00" })]);
    expect(options[0]).toHaveTextContent("INR 0.00");
  });

  it("falls back to unit_price when default_price is absent", async () => {
    const { options } = await renderWithProducts([product({ unit_price: "75.00" })]);
    expect(options[0]).toHaveTextContent("INR 75.00");
  });

  it("shows no price, not 0.00, for missing or invalid prices", async () => {
    const { options } = await renderWithProducts([
      product({ id: 1, name: "Missing", default_price: null, original_price: "0.00" }),
      product({ id: 2, name: "Invalid", default_price: "abc" }),
      product({ id: 3, name: "Empty", default_price: "" }),
    ]);
    for (const option of options) {
      expect(option).toHaveTextContent("—");
      expect(option).not.toHaveTextContent(/0\.00|NaN/);
    }
  });

  it("uses invoiceCurrency when the product has no currency", async () => {
    const { options } = await renderWithProducts([product({ currency: null, default_price: "10.00" })], { invoiceCurrency: "USD" });
    expect(options[0]).toHaveTextContent("USD 10.00");
  });

  it("still defers entirely to a custom formatPrice", async () => {
    const formatPrice = vi.fn((p) => `custom:${p.original_price}`);
    const { options } = await renderWithProducts([product({ default_price: "1500.00", original_price: "0.00" })], { formatPrice });
    expect(options[0]).toHaveTextContent("custom:0.00");
    expect(formatPrice).toHaveBeenCalled();
  });

  it("selecting a product still passes the full product to onSelect", async () => {
    const audit = product({ default_price: "1500.00", original_price: "0.00" });
    const { options, onSelect, fetchProducts } = await renderWithProducts([audit]);
    expect(fetchProducts).toHaveBeenCalledWith(expect.objectContaining({ search_term: "a", is_active: true }));
    fireEvent.click(options[0]);
    expect(onSelect).toHaveBeenCalledWith(audit);
  });
});
