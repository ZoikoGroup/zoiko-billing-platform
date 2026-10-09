import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

// Batch 7 BUG-04 / BUG-06: "KPI cards do not work" on
//   /billing/contracts?status=expired  (Expiring Soon, Total Contract Value,
//     Active Value, Monthly Recurring, Annual Recurring)
//   /billing/quotations                (Cancelled/Exp, Total Value)
// Each card is clicked from the reported starting URL; the URL, the list
// request and (for metric cards) the destination must match the card.

if (typeof global.ResizeObserver === "undefined") global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};

const m = vi.hoisted(() => ({ contractList: vi.fn(), quoteList: vi.fn() }));
vi.mock("../../service/billingService", () => {
  const empty = () => Promise.resolve({ items: [], total: 0 });
  return {
    customerApi: { list: empty, get: () => Promise.resolve({}), search: () => Promise.resolve([]) },
    invoiceApi: { list: empty, get: () => Promise.resolve({}) },
    contractApi: {
      list: (...a) => m.contractList(...a), activate: vi.fn(), cancel: vi.fn(), terminate: vi.fn(),
      summary: () => Promise.resolve({ total_count: 5, active_count: 3, expired_count: 1, draft_count: 1, expiring_count: 2, total_value: 900, active_value: 600, mrr: 50, arr: 600 }),
    },
    quoteApi: {
      list: (...a) => m.quoteList(...a), summary: () => Promise.resolve({ total_count: 6, cancelled_count: 1, expired_count: 1, total_value: 1000 }),
      addItems: vi.fn(), cancel: vi.fn(), create: vi.fn(), recalculate: vi.fn(), send: vi.fn(),
    },
    productApi: { list: empty },
    pricingApi: { listByProduct: empty, resolvePrice: vi.fn() },
    settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }) },
  };
});

import ContractListPage from "./contracts/contract-list";
import QuotationListPage from "./quotations/quotation-list";

function LocationProbe() { const l = useLocation(); return <div data-testid="location">{l.pathname}{l.search}</div>; }
const renderAt = (path, url, Page) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path={path} element={<><Page /><LocationProbe /></>} />
      <Route path="/billing/contracts/reports" element={<LocationProbe />} />
    </Routes>
  </MemoryRouter>,
);
const loc = () => screen.getByTestId("location").textContent;
const last = (fn) => fn.mock.calls.at(-1)[0];
const card = (re) => screen.findByRole("button", { name: re }, { timeout: 4000 });

beforeEach(() => { vi.clearAllMocks(); try { localStorage.clear(); } catch { /* ignore */ } m.contractList.mockResolvedValue({ items: [], total: 0 }); m.quoteList.mockResolvedValue({ items: [], total: 0 }); });
afterEach(() => cleanup());

describe("BUG-04 Contracts KPI cards from ?status=expired", () => {
  const start = "/billing/contracts?status=expired";

  it("Expiring Soon (30d): replaces the expired filter with expiring-in-30-days, all-time", async () => {
    renderAt("/billing/contracts", start, ContractListPage);
    fireEvent.click(await card(/^Expiring Soon \(30d\):/));
    await waitFor(() => expect(loc()).toMatch(/expiring=30/));
    expect(loc()).not.toMatch(/status=/);
    await waitFor(() => { const p = last(m.contractList); expect(p.expiring_within_days).toBe(30); expect(p.status).toBeUndefined(); expect(p.date_from).toBeUndefined(); });
  });

  it("Total Contract Value: clears the status filter and lists every contract (all-time)", async () => {
    renderAt("/billing/contracts", start, ContractListPage);
    fireEvent.click(await card(/^Total Contract Value:/));
    await waitFor(() => expect(loc()).not.toMatch(/status=/));
    await waitFor(() => { const p = last(m.contractList); expect(p.status).toBeUndefined(); expect(p.expiring_within_days).toBeUndefined(); expect(p.date_from).toBeUndefined(); });
  });

  it("Active Value: filters to active contracts (all-time)", async () => {
    renderAt("/billing/contracts", start, ContractListPage);
    fireEvent.click(await card(/^Active Value:/));
    await waitFor(() => expect(loc()).toMatch(/status=active/));
    await waitFor(() => { const p = last(m.contractList); expect(p.status).toBe("active"); expect(p.date_from).toBeUndefined(); });
  });

  it.each([["Monthly Recurring"], ["Annual Recurring"]])("%s: opens the contract reports (a metric, not a list filter)", async (title) => {
    renderAt("/billing/contracts", start, ContractListPage);
    fireEvent.click(await card(new RegExp(`^${title}:`)));
    await waitFor(() => expect(loc()).toBe("/billing/contracts/reports"));
  });
});

describe("BUG-06 Quotations KPI cards", () => {
  for (const start of ["/billing/quotations", "/billing/quotations?status=sent"]) {
    it(`Cancelled/Exp from ${start}: cancelled AND expired, all-time`, async () => {
      renderAt("/billing/quotations", start, QuotationListPage);
      fireEvent.click(await card(/^Cancelled\/Exp:/));
      await waitFor(() => expect(decodeURIComponent(loc())).toMatch(/status=cancelled,expired/));
      await waitFor(() => { const p = last(m.quoteList); expect(p.status).toBe("cancelled,expired"); expect(p.date_from).toBeUndefined(); });
    });

    it(`Pipeline Value from ${start}: draft, sent and accepted, all-time (same scope as the KPI)`, async () => {
      renderAt("/billing/quotations", start, QuotationListPage);
      fireEvent.click(await card(/^Pipeline Value:/));
      await waitFor(() => expect(decodeURIComponent(loc())).toMatch(/status=draft,sent,accepted/));
      await waitFor(() => { const p = last(m.quoteList); expect(p.status).toBe("draft,sent,accepted"); expect(p.date_from).toBeUndefined(); });
    });
  }
});
