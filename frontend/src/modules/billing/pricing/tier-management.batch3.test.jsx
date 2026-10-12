import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Batch 3 / C (/billing/pricing/tier-management?plan_id=4):
//  C1 inputs lost focus after every letter: AddTierModal was declared INSIDE
//     the page component, so each keystroke remounted it.
//  C2 Cancel did not reset the Add Tier form.
//  C3 the form collected Name/Type/Priority (not tier fields -- discarded) and
//     always sent flat_fee 0; the "Priority" column actually showed flat_fee.

const m = vi.hoisted(() => ({ listTiers: vi.fn(), addTier: vi.fn(), removeTier: vi.fn() }));

vi.mock("../../../service/billingService", () => ({
  pricingApi: {
    list: () => Promise.resolve({ items: [{ id: 4, name: "Pro" }] }),
    listTiers: (...a) => m.listTiers(...a), addTier: (...a) => m.addTier(...a), removeTier: (...a) => m.removeTier(...a),
  },
}));
vi.mock("../../../service/billingConfigCache", async (orig) => ({ ...(await orig()), loadGlobalBillingConfig: () => Promise.resolve({ default_currency: "USD" }) }));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));

import TierManagementPage, { validateTier } from "./tier-management";

const TIER = { id: 11, from_quantity: 1, to_quantity: 100, unit_price: "2.50", flat_fee: "10.00" };

function renderPage() {
  return render(<MemoryRouter initialEntries={["/billing/pricing/tier-management?plan_id=4"]}><TierManagementPage /></MemoryRouter>);
}

async function openAdd() {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: /add tier/i }));
  return screen.findByRole("dialog", { name: "Add Tier" });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.listTiers.mockResolvedValue([TIER]);
  m.addTier.mockResolvedValue({});
  m.removeTier.mockResolvedValue({});
});
afterEach(() => cleanup());

describe("C1 — typing does not lose focus", () => {
  it("the same input stays mounted and focused across consecutive keystrokes", async () => {
    await openAdd();
    const input = screen.getByLabelText(/min units/i);
    input.focus();
    for (const v of ["1", "12", "120"]) {
      fireEvent.change(screen.getByLabelText(/min units/i), { target: { value: v } });
      expect(screen.getByLabelText(/min units/i)).toBe(input); // not remounted
      expect(document.activeElement).toBe(input);
    }
    expect(input).toHaveValue(120);
  });

  it("tabbing between fields keeps every typed value", async () => {
    await openAdd();
    fireEvent.change(screen.getByLabelText(/min units/i), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/max units/i), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText(/unit price/i), { target: { value: "1.25" } });
    fireEvent.change(screen.getByLabelText(/flat fee/i), { target: { value: "3" } });
    expect(screen.getByLabelText(/min units/i)).toHaveValue(5);
    expect(screen.getByLabelText(/max units/i)).toHaveValue(50);
    expect(screen.getByLabelText(/unit price/i)).toHaveValue(1.25);
    expect(screen.getByLabelText(/flat fee/i)).toHaveValue(3);
  });
});

describe("C2 — Cancel resets the form", () => {
  it.each([
    ["Cancel button", (d) => fireEvent.click(within(d).getByRole("button", { name: "Cancel" }))],
    ["close (X) button", (d) => fireEvent.click(within(d).getByRole("button", { name: "Close" }))],
  ])("reopening after %s shows an empty form and no stale error", async (_how, close) => {
    let dialog = await openAdd();
    fireEvent.change(screen.getByLabelText(/min units/i), { target: { value: "7" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Tier" })); // invalid -> error shown
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    close(dialog);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /add tier/i }));
    dialog = await screen.findByRole("dialog", { name: "Add Tier" });
    expect(screen.getByLabelText(/min units/i)).toHaveValue(null);
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("C3 — the form sends exactly the tier contract", () => {
  it("submits min/max/unit price/flat fee (no discarded fields)", async () => {
    const dialog = await openAdd();
    expect(within(dialog).queryByLabelText(/^name/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/min units/i), { target: { value: "101" } });
    fireEvent.change(screen.getByLabelText(/max units/i), { target: { value: "500" } });
    fireEvent.change(screen.getByLabelText(/unit price/i), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/flat fee/i), { target: { value: "15" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Tier" }));
    await waitFor(() => expect(m.addTier).toHaveBeenCalledWith("4", {
      pricing_plan_id: 4, from_quantity: 101, to_quantity: 500, unit_price: 2, flat_fee: 15,
    }));
  });

  it("the fee column is labelled Flat Fee, not Priority", async () => {
    renderPage();
    await screen.findByText("Tier 1");
    expect(screen.getByRole("columnheader", { name: "Flat Fee" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Priority" })).not.toBeInTheDocument();
  });

  it("a failed removal is shown in the dialog", async () => {
    m.removeTier.mockRejectedValue(new Error("Tier is in use"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Remove tier 1" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Tier 1 (1–100 units)");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await within(dialog).findByText("Tier is in use")).toBeInTheDocument();
  });
});

describe("validateTier mirrors PlanTierCreate", () => {
  const ok = { from_quantity: "1", to_quantity: "", unit_price: "0", flat_fee: "" };
  it.each([
    [{ from_quantity: "0" }, /min units/i],
    [{ from_quantity: "" }, /min units/i],
    [{ to_quantity: "1" }, /greater than min/i],
    [{ unit_price: "" }, /unit price/i],
    [{ flat_fee: "-1" }, /flat fee/i],
  ])("rejects %o", (patch, msg) => {
    expect(validateTier({ ...ok, ...patch })).toMatch(msg);
  });
  it("accepts an open-ended tier and a zero price", () => {
    expect(validateTier(ok)).toBeNull();
  });
});
