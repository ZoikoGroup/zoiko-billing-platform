import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the Pricing Plans dialogs rebuilt on the shared Modal.

const m = vi.hoisted(() => ({ planList: vi.fn(), prodList: vi.fn(), create: vi.fn(), listTiers: vi.fn(), addTier: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  pricingApi: {
    list: (...a) => m.planList(...a), create: (...a) => m.create(...a),
    listTiers: (...a) => m.listTiers(...a), addTier: (...a) => m.addTier(...a),
    update: vi.fn(), deactivate: vi.fn(), removeTier: vi.fn(),
  },
  productApi: { list: (...a) => m.prodList(...a), listCategories: () => Promise.resolve([]) },
  settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }), get: () => Promise.resolve({}) },
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children, actions }) => <div><h1>{title}</h1>{actions}{children}</div> }));
if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};

import ProductPricingPlansPage from "./pricing-plans";

const PLAN = { id: 9, name: "Volume Gold", plan_type: "tiered", price: 5, billing_interval: "monthly", status: "active", product_id: 7 };
const fieldIn = (dialog, label) => within(dialog).getByText(label).parentElement.querySelector("input, select");

beforeEach(() => {
  vi.clearAllMocks();
  m.planList.mockResolvedValue({ items: [PLAN], total: 1 });
  m.prodList.mockResolvedValue({ items: [{ id: 7, name: "Widget Pro" }] });
  m.create.mockResolvedValue({ id: 10 });
  m.listTiers.mockResolvedValue([]);
  m.addTier.mockResolvedValue({ id: 1 });
});
afterEach(() => cleanup());

async function renderPage() {
  render(<MemoryRouter><ProductPricingPlansPage /></MemoryRouter>);
  await screen.findAllByText("Volume Gold");
}

async function openNewPlan() {
  fireEvent.click(screen.getAllByRole("button", { name: "Add Plan" })[0]);
  return screen.findByRole("dialog", { name: "New Pricing Plan" });
}

describe("Pricing Plans dialogs", () => {
  it("New Pricing Plan: gated on name + product, calls pricingApi.create, then closes", async () => {
    await renderPage();
    const dialog = await openNewPlan();
    const create = within(dialog).getByRole("button", { name: "Create Plan" });
    expect(create).toBeDisabled();
    fireEvent.change(fieldIn(dialog, "Name *"), { target: { value: "Starter" } });
    expect(create).toBeDisabled(); // still needs a product
    fireEvent.change(within(dialog).getByRole("searchbox", { name: /search products/i }), { target: { value: "Widget" } });
    fireEvent.click(await within(dialog).findByRole("option", { name: /Widget Pro/ }));
    fireEvent.change(fieldIn(dialog, "Price *"), { target: { value: "12.5" } });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Starter", product_id: 7, price: 12.5, plan_type: "flat" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Pricing Tiers: Add calls pricingApi.addTier and refreshes the list; Close closes", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Table view" }));
    fireEvent.click(await screen.findByRole("button", { name: "Tiers" }));
    const dialog = await screen.findByRole("dialog", { name: "Pricing Tiers" });
    await waitFor(() => expect(m.listTiers).toHaveBeenCalledWith(9));
    const add = within(dialog).getByRole("button", { name: "Add" });
    expect(add).toBeDisabled();
    m.listTiers.mockResolvedValue([{ id: 1, from_quantity: 1, to_quantity: 100, unit_price: 2, flat_fee: 0 }]);
    fireEvent.change(within(dialog).getByPlaceholderText("From"), { target: { value: "1" } });
    fireEvent.change(within(dialog).getByPlaceholderText("To"), { target: { value: "100" } });
    fireEvent.change(within(dialog).getByPlaceholderText("Price"), { target: { value: "2" } });
    fireEvent.click(add);
    await waitFor(() => expect(m.addTier).toHaveBeenCalledWith(9, { from_quantity: 1, to_quantity: 100, unit_price: 2, flat_fee: 0 }));
    expect(await within(dialog).findByRole("button", { name: "Delete tier 1–100" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Cancel closes the New Pricing Plan dialog without calling the API", async () => {
    await renderPage();
    const dialog = await openNewPlan();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(m.create).not.toHaveBeenCalled();
  });
});
