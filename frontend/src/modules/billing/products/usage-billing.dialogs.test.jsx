import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the Usage Billing dialogs rebuilt on the shared Modal.

const m = vi.hoisted(() => ({ usage: vi.fn(), prodList: vi.fn(), create: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  productApi: {
    list: (...a) => m.prodList(...a), listUsageBillable: (...a) => m.usage(...a),
    create: (...a) => m.create(...a), listCategories: () => Promise.resolve([]), update: vi.fn(), bulkStatus: vi.fn(),
  },
  settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }), get: () => Promise.resolve({}) },
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children, actions }) => <div><h1>{title}</h1>{actions}{children}</div> }));

import UsageBillingPage from "./usage-billing";

const METER = { id: 1, name: "API Calls", code: "API", status: "active", default_price: "0.01", currency: "USD", billing_frequency: "usage_based", unit_label: "call", created_at: "2026-01-01T15:00:00Z" };
const fieldIn = (dialog, label) => within(dialog).getByText(label).parentElement.querySelector("input, select, textarea");

beforeEach(() => {
  vi.clearAllMocks();
  m.usage.mockResolvedValue({ items: [METER] });
  m.prodList.mockResolvedValue({ items: [] });
  m.create.mockResolvedValue({ id: 2 });
});
afterEach(() => cleanup());

async function renderPage() {
  render(<MemoryRouter><UsageBillingPage /></MemoryRouter>);
  await screen.findByText("API Calls");
}

async function openCreate() {
  fireEvent.click(screen.getAllByRole("button", { name: "Create Meter" })[0]);
  return screen.findByRole("dialog", { name: "Create Meter" });
}

describe("Usage Billing dialogs", () => {
  it("Create Meter: gated on name, calls productApi.create as a usage product, then closes", async () => {
    await renderPage();
    const dialog = await openCreate();
    const create = within(dialog).getByRole("button", { name: "Create Meter" });
    expect(create).toBeDisabled();
    fireEvent.change(fieldIn(dialog, "Meter Name *"), { target: { value: "Storage GB" } });
    fireEvent.change(fieldIn(dialog, "Unit Price *"), { target: { value: "0.25" } });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({
      name: "Storage GB", product_type: "usage", billing_frequency: "usage_based", default_price: 0.25, is_usage_billable: true,
    }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Test API Event: Send Event renders the simulated event (no API call); Close closes", async () => {
    await renderPage();
    const callsBefore = m.usage.mock.calls.length + m.prodList.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Test API Calls" }));
    const dialog = await screen.findByRole("dialog", { name: "Test API Event" });
    fireEvent.change(fieldIn(dialog, "Quantity"), { target: { value: "300" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send Event" }));
    const payload = await within(dialog).findByText(/"billed_amount": 3,/);
    expect(payload).toHaveTextContent('"product_id": 1');
    expect(payload).toHaveTextContent('"quantity": 300');
    expect(payload).toHaveTextContent('"status": "accepted"');
    // runTestEvent is a client-side simulation: it sets local state only.
    expect(m.usage.mock.calls.length + m.prodList.mock.calls.length).toBe(callsBefore);
    expect(m.create).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Cancel closes the Create Meter dialog without calling the API", async () => {
    await renderPage();
    const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(m.create).not.toHaveBeenCalled();
  });
});
