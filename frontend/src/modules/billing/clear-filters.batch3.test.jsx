import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Batch 3 / R, S, T, G: "Clear button is missing after using filters" on
// Customer Billing History, Products, Product Pricing Plans and Usage Billing.
// Each page now shows "Clear filters" only while a filter is active, resets
// every filter (search included), and its empty state distinguishes "nothing
// matches" from "nothing exists".

if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function scrollToPolyfill() {};
}

const m = vi.hoisted(() => ({ invList: vi.fn(), payList: vi.fn(), prodList: vi.fn(), planList: vi.fn(), usage: vi.fn() }));

vi.mock("../../service/billingService", () => {
  const empty = () => Promise.resolve({ items: [], total: 0 });
  return {
    invoiceApi: { list: (...a) => m.invList(...a) },
    paymentApi: { list: (...a) => m.payList(...a) },
    productApi: {
      list: (...a) => m.prodList(...a), listCategories: () => Promise.resolve([]), listUsageBillable: (...a) => m.usage(...a),
      bulkDelete: vi.fn(), bulkStatus: vi.fn(), create: vi.fn(), delete: vi.fn(), duplicate: vi.fn(), exportCatalog: vi.fn(), restore: vi.fn(), update: vi.fn(),
    },
    pricingApi: { list: (...a) => m.planList(...a), addTier: vi.fn(), create: vi.fn(), deactivate: vi.fn(), listTiers: empty, removeTier: vi.fn(), update: vi.fn() },
    settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }), get: () => Promise.resolve({}) },
  };
});
vi.mock("../../components/HRPage", () => ({ default: ({ title, children, actions }) => <div><h1>{title}</h1>{actions}{children}</div> }));

import BillingHistoryPage from "./customers/billing-history";
import ProductListPage from "./products/product-list";
import PricingPlansPage from "./products/pricing-plans";
import UsageBillingPage from "./products/usage-billing";

const renderPage = (Page) => render(<MemoryRouter><Page /></MemoryRouter>);
const last = (fn) => fn.mock.calls.at(-1)?.[0] || {};
const clearBtn = () => screen.queryAllByRole("button", { name: "Clear filters" })[0];

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [m.invList, m.payList, m.prodList, m.planList]) fn.mockResolvedValue({ items: [], total: 0 });
  m.usage.mockResolvedValue([]);
});
afterEach(() => cleanup());

describe("R. Customer billing history", () => {
  it("clears search, status and dates together", async () => {
    renderPage(BillingHistoryPage);
    await waitFor(() => expect(m.invList).toHaveBeenCalled());
    expect(clearBtn()).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Search billing history"), { target: { value: "INV-9" } });
    fireEvent.click(screen.getByRole("button", { name: "Toggle filters" }));
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "paid" } });
    fireEvent.change(screen.getByLabelText("Filter from date"), { target: { value: "2026-01-01" } });
    await waitFor(() => expect(clearBtn()).toBeDefined());
    expect(await screen.findByText("No invoices match your filters")).toBeInTheDocument();
    fireEvent.click(clearBtn());
    expect(screen.getByLabelText("Search billing history")).toHaveValue("");
    expect(await screen.findByText("No invoices have been created yet")).toBeInTheDocument();
    expect(clearBtn()).toBeDisabled();
  });

  it("switching tabs drops an invoice-only status filter", async () => {
    renderPage(BillingHistoryPage);
    await waitFor(() => expect(m.invList).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Toggle filters" }));
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "overdue" } });
    fireEvent.click(screen.getByRole("button", { name: /payments/i }));
    await waitFor(() => expect(m.payList).toHaveBeenCalled());
    expect(last(m.payList).status).toBeUndefined();
  });
});

describe("S. Products", () => {
  it("Clear filters appears with a filter and restores the unfiltered list", async () => {
    renderPage(ProductListPage);
    await waitFor(() => expect(m.prodList).toHaveBeenCalled());
    expect(clearBtn()).toBeUndefined();
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "widget" } });
    await waitFor(() => expect(clearBtn()).toBeDefined());
    expect(await screen.findByText("No products match your filters")).toBeInTheDocument();
    fireEvent.click(clearBtn());
    await waitFor(() => expect(screen.getByText("No products or services yet")).toBeInTheDocument());
    expect(clearBtn()).toBeUndefined();
  });
});

describe("T. Product pricing plans", () => {
  it("clears search, type and status", async () => {
    renderPage(PricingPlansPage);
    await waitFor(() => expect(m.planList).toHaveBeenCalled());
    expect(clearBtn()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Toggle filters" }));
    fireEvent.change(screen.getByLabelText("Plan status"), { target: { value: "inactive" } });
    // The status filter now counts as a filter in the empty state too.
    expect(await screen.findByText("No pricing plans match your filters")).toBeInTheDocument();
    fireEvent.click(clearBtn());
    expect(screen.getByLabelText("Plan status")).toHaveValue("");
    expect(await screen.findByText("No pricing plans yet")).toBeInTheDocument();
  });
});

describe("G. Usage billing", () => {
  it("date filter is available, clearable, and refresh keeps it", async () => {
    renderPage(UsageBillingPage);
    const from = await screen.findByLabelText("Created from date");
    expect(clearBtn()).toBeDisabled();
    fireEvent.change(from, { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("Created to date"), { target: { value: "2026-01-31" } });
    expect(await screen.findByText("No meters match your filters")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(m.usage.mock.calls.length).toBeGreaterThan(2));
    expect(screen.getByLabelText("Created from date")).toHaveValue("2026-01-01"); // refresh keeps the filter
    fireEvent.click(clearBtn());
    expect(screen.getByLabelText("Created from date")).toHaveValue("");
    expect(screen.getByLabelText("Created to date")).toHaveValue("");
    expect(await screen.findByText("No usage meters yet")).toBeInTheDocument();
  });

  it("warns about an inverted range", async () => {
    renderPage(UsageBillingPage);
    fireEvent.change(await screen.findByLabelText("Created from date"), { target: { value: "2026-02-01" } });
    fireEvent.change(screen.getByLabelText("Created to date"), { target: { value: "2026-01-01" } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/start date is after the end date/i);
  });
});
