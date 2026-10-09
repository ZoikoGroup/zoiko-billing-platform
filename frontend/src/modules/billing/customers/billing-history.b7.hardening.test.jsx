import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// B7 (/billing/customers/billing-history): "Clear button missing". Clear
// filters appears whenever search, status or a date is set, resets all of
// them (and the page), and the list refetches unfiltered.

if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};
const m = vi.hoisted(() => ({ invList: vi.fn(), payList: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  invoiceApi: { list: (...a) => m.invList(...a) },
  paymentApi: { list: (...a) => m.payList(...a) },
  settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }), get: () => Promise.resolve({}) },
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children, actions }) => <div><h1>{title}</h1>{actions}{children}</div> }));

import BillingHistoryPage from "./billing-history";

const clearBtn = () => screen.queryAllByRole("button", { name: "Clear filters" })[0];
beforeEach(() => { vi.clearAllMocks(); m.invList.mockResolvedValue({ items: [], total: 0 }); m.payList.mockResolvedValue({ items: [], total: 0 }); });
afterEach(() => cleanup());

describe("B7 Customer Billing History", () => {
  it("no filter: no Clear; search + status + dates: Clear resets all and refetches unfiltered", async () => {
    render(<MemoryRouter><BillingHistoryPage /></MemoryRouter>);
    await waitFor(() => expect(m.invList).toHaveBeenCalled());
    expect(clearBtn()).toBeUndefined();
    fireEvent.change(screen.getByLabelText("Search billing history"), { target: { value: "INV-9" } });
    fireEvent.click(screen.getByRole("button", { name: "Toggle filters" }));
    fireEvent.change(screen.getByLabelText("Filter by status"), { target: { value: "paid" } });
    fireEvent.change(screen.getByLabelText("Filter from date"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("Filter to date"), { target: { value: "2026-12-31" } });
    await waitFor(() => expect(clearBtn()).toBeDefined());
    fireEvent.click(clearBtn());
    expect(screen.getByLabelText("Search billing history")).toHaveValue("");
    expect(screen.getByLabelText("Filter by status")).toHaveValue("");
    expect(screen.getByLabelText("Filter from date")).toHaveValue("");
    expect(screen.getByLabelText("Filter to date")).toHaveValue("");
    await waitFor(() => {
      const p = m.invList.mock.calls.at(-1)[0];
      expect(p.status).toBeUndefined();
      expect(p.search_term ?? p.search).toBeFalsy();
    });
    expect(clearBtn()).toBeUndefined();
  });
});
