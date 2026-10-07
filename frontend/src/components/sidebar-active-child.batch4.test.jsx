import { describe, it, expect, vi } from "vitest";

// B4-04: on /billing/products/categories both "Product List" and "Categories"
// were highlighted, because each child matched by path prefix on its own.

vi.mock("../context/AuthContext", () => ({ useAuth: () => ({}) }));
vi.mock("../hooks/useCockpitStatus", () => ({ default: () => ({}) }));

import { activeChildHref } from "./BillingShell";

const products = [
  { label: "Product List", href: "/billing/products" },
  { label: "Categories", href: "/billing/products/categories" },
];

describe("B4-04 sidebar: one current child", () => {
  it("the most specific matching link wins", () => {
    expect(activeChildHref(products, "/billing/products/categories", "")).toBe("/billing/products/categories");
  });

  it("the parent list stays current on its own and its detail pages", () => {
    expect(activeChildHref(products, "/billing/products", "")).toBe("/billing/products");
    expect(activeChildHref(products, "/billing/products/42", "")).toBe("/billing/products");
  });

  it("no match outside the section", () => {
    expect(activeChildHref(products, "/billing/invoices", "")).toBeNull();
  });
});
