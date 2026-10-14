// A timezone west of UTC, where the old footer label showed the previous day.
process.env.TZ = "America/New_York";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// BUG-12.3 (/billing/usage-billing): "when the user wants data between two
// dates ... clicking Refresh does not clear the dates. Add a Clear button."
// Approved behaviour (D6): Refresh stays a reload that KEEPS the date filter;
// the existing "Clear filters" action clears the dates; the footer label must
// show the picked calendar days in every timezone. Pagination is deferred:
// the page still loads up to 100 products per call.

const m = vi.hoisted(() => ({ usage: vi.fn(), prodList: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  productApi: {
    list: (...a) => m.prodList(...a), listUsageBillable: (...a) => m.usage(...a),
    listCategories: () => Promise.resolve([]), create: vi.fn(), update: vi.fn(),
  },
  settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }), get: () => Promise.resolve({}) },
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children, actions }) => <div><h1>{title}</h1>{actions}{children}</div> }));

import UsageBillingPage from "./usage-billing";

const METERS = [
  { id: 1, name: "API Calls", code: "API", status: "active", default_price: "0.01", currency: "USD", created_at: "2026-01-01T15:00:00Z" },
  { id: 2, name: "Storage GB", code: "STO", status: "active", default_price: "0.10", currency: "USD", created_at: "2026-03-15T15:00:00Z" },
];

beforeEach(() => {
  vi.clearAllMocks();
  m.usage.mockResolvedValue({ items: METERS });
  m.prodList.mockResolvedValue({ items: [] });
});
afterEach(() => cleanup());

const local = (y, mo, d) => new Date(y, mo - 1, d).toLocaleDateString();
const clearBtn = () => screen.queryAllByRole("button", { name: "Clear filters" })[0];

async function pickRange(from, to) {
  render(<MemoryRouter><UsageBillingPage /></MemoryRouter>);
  await screen.findByText("API Calls");
  fireEvent.change(screen.getByLabelText("Created from date"), { target: { value: from } });
  fireEvent.change(screen.getByLabelText("Created to date"), { target: { value: to } });
}

describe("BUG-12.3 Usage Billing date range", () => {
  it("the footer label shows the picked calendar days, not the day before (UTC-5)", async () => {
    await pickRange("2026-01-01", "2026-01-31");
    const label = await screen.findByText(/^Created from /);
    expect(label).toHaveTextContent(`Created from ${local(2026, 1, 1)} to ${local(2026, 1, 31)}`);
    expect(label).not.toHaveTextContent(local(2025, 12, 31));
  });

  it("filters to the chosen days and never calls the API for a partial range", async () => {
    render(<MemoryRouter><UsageBillingPage /></MemoryRouter>);
    await screen.findByText("API Calls");
    const callsBefore = m.usage.mock.calls.length + m.prodList.mock.calls.length;
    fireEvent.change(screen.getByLabelText("Created from date"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("Created to date"), { target: { value: "2026-01-31" } });
    expect(await screen.findByText("API Calls")).toBeInTheDocument();
    expect(screen.queryByText("Storage GB")).not.toBeInTheDocument();
    expect(m.usage.mock.calls.length + m.prodList.mock.calls.length).toBe(callsBefore);
  });

  it("Refresh reloads data and keeps the selected dates", async () => {
    await pickRange("2026-01-01", "2026-01-31");
    const callsBefore = m.usage.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(m.usage.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(screen.getByLabelText("Created from date")).toHaveValue("2026-01-01");
    expect(screen.getByLabelText("Created to date")).toHaveValue("2026-01-31");
    expect(screen.queryByText("Storage GB")).not.toBeInTheDocument();
  });

  it("Clear filters empties both dates, removes the label and shows every meter again", async () => {
    await pickRange("2026-01-01", "2026-01-31");
    fireEvent.click(clearBtn());
    expect(screen.getByLabelText("Created from date")).toHaveValue("");
    expect(screen.getByLabelText("Created to date")).toHaveValue("");
    expect(screen.queryByText(/^Created from /)).not.toBeInTheDocument();
    expect(await screen.findByText("Storage GB")).toBeInTheDocument();
    expect(clearBtn()).toBeDisabled();
  });

  it("Clear also resets the inverted-range warning", async () => {
    await pickRange("2026-02-01", "2026-01-01");
    expect(await screen.findByText(/start date is after the end date/i)).toBeInTheDocument();
    fireEvent.click(clearBtn());
    expect(screen.queryByText(/start date is after the end date/i)).not.toBeInTheDocument();
  });

  it("keeps the existing 100-per-call product listing (pagination deferred)", async () => {
    render(<MemoryRouter><UsageBillingPage /></MemoryRouter>);
    await screen.findByText("API Calls");
    for (const [params] of m.prodList.mock.calls) expect(params.per_page).toBe(100);
  });
});
