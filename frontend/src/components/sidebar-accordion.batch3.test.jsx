import { describe, it, expect, vi } from "vitest";

// Batch 3 / E: billing sidebar accordion. The original Batch 3 fix: the toggle
// decided open/closed from the render-time state instead of the value passed
// to the updater, so two toggles queued in one render (double-click) did not
// cancel out.
// BUG-11.1 (approved decision D1): the sidebar is now SINGLE-EXPAND -- opening
// a section closes the previously open one, and after navigation the section
// containing the current route is the open one. (This file previously pinned
// multi-open as a product decision; that decision was reversed.)

vi.mock("../context/AuthContext", () => ({ useAuth: () => ({}) }));
vi.mock("../hooks/useCockpitStatus", () => ({ default: () => ({}) }));

import { sectionExpandedIn, toggleSectionIn, expandedSectionLabel } from "./BillingShell";

const invoicing = { label: "Invoicing", children: [{ label: "Invoices", href: "/billing/invoices" }] };
const payments = { label: "Payments", children: [{ label: "Payments", href: "/billing/payments" }] };
const tax = { label: "Tax", children: [{ label: "Tax Rates", href: "/billing/tax/rates" }] };
const SECTIONS = [invoicing, payments, tax];

const open = (choice, section, path) => sectionExpandedIn(choice, section, path, "", SECTIONS);
const toggle = (choice, section, path) => toggleSectionIn(choice, section, path, "", SECTIONS);

describe("E. Sidebar section toggling", () => {
  it("a section containing the current route starts open; others start closed", () => {
    expect(open(null, invoicing, "/billing/invoices")).toBe(true);
    expect(open(null, payments, "/billing/invoices")).toBe(false);
  });

  it("two queued toggles cancel out (updater uses its own snapshot)", () => {
    const once = toggle(null, payments, "/billing/invoices");
    expect(open(once, payments, "/billing/invoices")).toBe(true);
    const twice = toggle(once, payments, "/billing/invoices");
    expect(open(twice, payments, "/billing/invoices")).toBe(false);
  });

  it("the route's own section can be collapsed, and opening another leaves it closed", () => {
    let s = toggle(null, invoicing, "/billing/invoices");
    expect(open(s, invoicing, "/billing/invoices")).toBe(false);
    s = toggle(s, payments, "/billing/invoices");
    expect(open(s, payments, "/billing/invoices")).toBe(true);
    expect(open(s, invoicing, "/billing/invoices")).toBe(false);
  });
});

describe("BUG-11.1 — single-expand", () => {
  it("opening a second section closes the first", () => {
    let s = toggle(null, payments, "/billing");
    s = toggle(s, invoicing, "/billing");
    expect(open(s, payments, "/billing")).toBe(false);
    expect(open(s, invoicing, "/billing")).toBe(true);
    s = toggle(s, tax, "/billing");
    expect(SECTIONS.filter((sec) => open(s, sec, "/billing")).map((sec) => sec.label)).toEqual(["Tax"]);
  });

  it("opening another section closes the active route's section", () => {
    const s = toggle(null, payments, "/billing/invoices");
    expect(open(s, invoicing, "/billing/invoices")).toBe(false);
    expect(open(s, payments, "/billing/invoices")).toBe(true);
  });

  it("never reports more than one open section", () => {
    let s = null;
    for (const sec of [payments, tax, invoicing, payments, tax]) {
      s = toggle(s, sec, "/billing/invoices");
      expect(SECTIONS.filter((x) => open(s, x, "/billing/invoices")).length).toBeLessThanOrEqual(1);
    }
  });

  it("after navigation the section containing the new route is the open one (links, back/forward, drawer reopen)", () => {
    // User opened Tax while on Invoices, then navigated to Payments: a choice
    // made on another route is ignored (no flash of the old section). The
    // component additionally clears the choice on every navigation, so going
    // back to Invoices shows Invoicing -- see the component tests below.
    const s = toggle(null, tax, "/billing/invoices");
    expect(expandedSectionLabel(s, SECTIONS, "/billing/payments", "")).toBe("Payments");
    // A route outside every section collapses all.
    expect(expandedSectionLabel(s, SECTIONS, "/billing", "")).toBeNull();
  });

  it("when links in two sections match, the most specific one decides", () => {
    const products = { label: "Products", children: [{ label: "Product List", href: "/billing/products" }] };
    const plans = { label: "Plans", children: [{ label: "Pricing Plans", href: "/billing/products/pricing-plans" }] };
    expect(expandedSectionLabel(null, [products, plans], "/billing/products/pricing-plans", "")).toBe("Plans");
    expect(expandedSectionLabel(null, [products, plans], "/billing/products/7", "")).toBe("Products");
  });

  it("a nested child route keeps its parent section open", () => {
    expect(open(null, invoicing, "/billing/invoices/123")).toBe(true);
    expect(open(null, payments, "/billing/invoices/123")).toBe(false);
  });
});
