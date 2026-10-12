import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// BUG-09.3 (/billing/pricing/tier-management?plan_id=4) UI/UX follow-ups the
// Phase 3 audit confirmed in code (09.1 focus loss and 09.2 Cancel reset are
// covered by tier-management.batch3.test.jsx):
//  - tiers rendered in API order, so the positional "Tier N" label could
//    number a 101+ band as Tier 1;
//  - a ?plan_id outside the first 100 plans left the dropdown and the plan
//    name blank ('Add pricing tiers to ""');
//  - dialogs: Escape only worked with focus inside the backdrop, Tab could
//    leave the dialog, and focus was not returned to the opener.

const m = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), listTiers: vi.fn(), addTier: vi.fn(), removeTier: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  pricingApi: {
    list: (...a) => m.list(...a), get: (...a) => m.get(...a),
    listTiers: (...a) => m.listTiers(...a), addTier: (...a) => m.addTier(...a), removeTier: (...a) => m.removeTier(...a),
  },
}));
vi.mock("../../../service/billingConfigCache", async (orig) => ({ ...(await orig()), loadGlobalBillingConfig: () => Promise.resolve({ default_currency: "USD" }) }));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));

import TierManagementPage from "./tier-management";

const renderAt = (planId = 4) =>
  render(<MemoryRouter initialEntries={[`/billing/pricing/tier-management?plan_id=${planId}`]}><TierManagementPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  m.list.mockResolvedValue({ items: [{ id: 4, name: "Pro" }] });
  m.get.mockResolvedValue({ id: 250, name: "Enterprise Legacy" });
  m.listTiers.mockResolvedValue([]);
  m.addTier.mockResolvedValue({});
  m.removeTier.mockResolvedValue({});
});
afterEach(() => cleanup());

describe("BUG-09.3 tier order", () => {
  it("numbers tiers by quantity band, whatever order the API returns", async () => {
    m.listTiers.mockResolvedValue([
      { id: 3, from_quantity: 501, to_quantity: null, unit_price: "1.00", flat_fee: "0" },
      { id: 1, from_quantity: 1, to_quantity: 100, unit_price: "3.00", flat_fee: "0" },
      { id: 2, from_quantity: 101, to_quantity: 500, unit_price: "2.00", flat_fee: "0" },
    ]);
    renderAt();
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("cell")[2].textContent)).toEqual(["1", "101", "501"]);
    expect(within(rows[0]).getByText("Tier 1")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Tier 3")).toBeInTheDocument();
  });
});

describe("BUG-09.3 plan beyond the first 100", () => {
  it("resolves the plan by id so the dropdown and the empty-state name are filled", async () => {
    renderAt(250);
    await waitFor(() => expect(m.get).toHaveBeenCalledWith("250"));
    expect(await screen.findByText('Add pricing tiers to "Enterprise Legacy".')).toBeInTheDocument();
    const select = screen.getByLabelText("Pricing plan");
    expect(select).toHaveValue("250");
    expect(within(select).getByRole("option", { name: "Enterprise Legacy" })).toBeInTheDocument();
  });

  it("does not fetch the plan when it is already in the list", async () => {
    renderAt(4);
    expect(await screen.findByText('Add pricing tiers to "Pro".')).toBeInTheDocument();
    expect(m.get).not.toHaveBeenCalled();
  });
});

describe("BUG-09.3 dialog keyboard behaviour", () => {
  async function openAdd() {
    renderAt();
    const trigger = await screen.findByRole("button", { name: /add tier/i });
    await waitFor(() => expect(trigger).not.toBeDisabled());
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Add Tier" });
    return { trigger, dialog };
  }

  it("Escape closes the Add Tier dialog even when focus is outside it, and focus returns to Add Tier", async () => {
    const { trigger } = await openAdd();
    document.body.focus();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add Tier" })).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
    expect(m.addTier).not.toHaveBeenCalled();
  });

  it("Tab and Shift+Tab wrap inside the dialog", async () => {
    const { dialog } = await openAdd();
    const close = within(dialog).getByRole("button", { name: "Close" });
    const submit = within(dialog).getAllByRole("button", { name: /add tier/i }).at(-1);
    submit.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(submit);
  });

  it("Cancel returns focus to the opener", async () => {
    const { trigger, dialog } = await openAdd();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.activeElement).toBe(trigger);
  });

  it("Escape cancels the remove confirmation without removing", async () => {
    m.listTiers.mockResolvedValue([{ id: 11, from_quantity: 1, to_quantity: 100, unit_price: "2.50", flat_fee: "0" }]);
    renderAt();
    const remove = await screen.findByRole("button", { name: "Remove tier 1" });
    remove.focus();
    fireEvent.click(remove);
    await screen.findByRole("alertdialog");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(m.removeTier).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(remove);
  });
});
