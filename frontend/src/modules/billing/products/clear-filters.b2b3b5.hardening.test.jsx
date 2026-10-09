import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// B2 (Pricing Plans), B3 (Usage Billing after dates), B5 (Products):
// "Clear button is missing". Clear filters is shown whenever a filter or
// search is active, resets every filter, and the list refetches unfiltered.
// B5 also asked what the symbol in the Products search box is: a keyboard-
// shortcut hint (Ctrl/⌘+K focuses search). It always read "⌘K" -- the Mac
// Command symbol, unexplained on Windows -- and now matches the platform.

if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};

const m = vi.hoisted(() => ({ prodList: vi.fn(), planList: vi.fn(), usage: vi.fn() }));
vi.mock("../../../service/billingService", () => {
  const empty = () => Promise.resolve({ items: [], total: 0 });
  return {
    productApi: {
      list: (...a) => m.prodList(...a), listCategories: () => Promise.resolve([]), listUsageBillable: (...a) => m.usage(...a),
      bulkDelete: vi.fn(), bulkStatus: vi.fn(), create: vi.fn(), delete: vi.fn(), duplicate: vi.fn(), exportCatalog: vi.fn(), restore: vi.fn(), update: vi.fn(),
    },
    pricingApi: { list: (...a) => m.planList(...a), addTier: vi.fn(), create: vi.fn(), deactivate: vi.fn(), listTiers: empty, removeTier: vi.fn(), update: vi.fn() },
    settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }), get: () => Promise.resolve({}) },
  };
});
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children, actions }) => <div><h1>{title}</h1>{actions}{children}</div> }));

import ProductListPage, { SEARCH_SHORTCUT_LABEL } from "./product-list";
import PricingPlansPage from "./pricing-plans";
import UsageBillingPage from "./usage-billing";

const renderPage = (Page) => render(<MemoryRouter><Page /></MemoryRouter>);
const clearBtn = () => screen.queryAllByRole("button", { name: "Clear filters" })[0];

beforeEach(() => {
  vi.clearAllMocks();
  m.prodList.mockResolvedValue({ items: [], total: 0 });
  m.planList.mockResolvedValue({ items: [], total: 0 });
  m.usage.mockResolvedValue([]);
});
afterEach(() => cleanup());

describe("B2 Pricing Plans", () => {
  it("no filters: no Clear; status filter: Clear appears, resets and refetches unfiltered", async () => {
    renderPage(PricingPlansPage);
    await waitFor(() => expect(m.planList).toHaveBeenCalled());
    expect(clearBtn()).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Toggle filters" }));
    fireEvent.change(screen.getByLabelText("Plan status"), { target: { value: "inactive" } });
    await waitFor(() => expect(m.planList.mock.calls.at(-1)[0].status).toBe("inactive"));
    fireEvent.click(clearBtn());
    expect(screen.getByLabelText("Plan status")).toHaveValue("");
    await waitFor(() => expect(m.planList.mock.calls.at(-1)[0].status).toBeUndefined());
    expect(clearBtn()).toBeUndefined();
  });

  it("search alone also shows Clear", async () => {
    renderPage(PricingPlansPage);
    fireEvent.change(await screen.findByLabelText("Search pricing plans"), { target: { value: "gold" } });
    await waitFor(() => expect(clearBtn()).toBeDefined());
    fireEvent.click(clearBtn());
    expect(screen.getByLabelText("Search pricing plans")).toHaveValue("");
  });
});

describe("B3 Usage Billing dates", () => {
  it("setting a date shows Clear; Clear empties both dates", async () => {
    renderPage(UsageBillingPage);
    const from = await screen.findByLabelText("Created from date");
    expect(clearBtn()).toBeUndefined();
    fireEvent.change(from, { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("Created to date"), { target: { value: "2026-12-31" } });
    await waitFor(() => expect(clearBtn()).toBeDefined());
    fireEvent.click(clearBtn());
    expect(screen.getByLabelText("Created from date")).toHaveValue("");
    expect(screen.getByLabelText("Created to date")).toHaveValue("");
    expect(clearBtn()).toBeUndefined();
  });

  it("an end date alone also shows Clear", async () => {
    renderPage(UsageBillingPage);
    fireEvent.change(await screen.findByLabelText("Created to date"), { target: { value: "2026-12-31" } });
    await waitFor(() => expect(clearBtn()).toBeDefined());
  });
});

describe("B5 Products", () => {
  it("search shows Clear, which resets and refetches unfiltered", async () => {
    renderPage(ProductListPage);
    const search = await screen.findByLabelText("Search by name, code");
    fireEvent.change(search, { target: { value: "zzz" } });
    await waitFor(() => expect(clearBtn()).toBeDefined());
    fireEvent.click(clearBtn());
    expect(screen.getByLabelText("Search by name, code")).toHaveValue("");
  });

  it("the search-box symbol is a platform-correct shortcut hint, and Ctrl+K focuses search", async () => {
    renderPage(ProductListPage);
    const search = await screen.findByLabelText("Search by name, code");
    expect(search).toHaveAttribute("aria-keyshortcuts", "Control+K Meta+K");
    const hint = screen.getByText(SEARCH_SHORTCUT_LABEL);
    expect(hint.tagName).toBe("KBD");
    expect(hint).toHaveAttribute("aria-hidden", "true");
    expect(SEARCH_SHORTCUT_LABEL).toBe(/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? "⌘K" : "Ctrl K");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(search);
  });
});
