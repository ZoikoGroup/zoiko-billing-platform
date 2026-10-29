import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the Pricing Plans dialogs after the rebuild on Modal.

const { pricingApi, productApi } = vi.hoisted(() => ({
  pricingApi: {
    list: vi.fn(), create: vi.fn(), update: vi.fn(), activate: vi.fn(), deactivate: vi.fn(),
    listTiers: vi.fn(), addTier: vi.fn(),
  },
  productApi: { list: vi.fn(), get: vi.fn(), listCategories: vi.fn() },
}));
vi.mock("../../../service/billingService", () => ({ pricingApi, productApi }));
vi.mock("../../../service/billingConfigCache", async (importOriginal) => ({
  ...(await importOriginal()),
  loadGlobalBillingConfig: vi.fn(() => Promise.resolve({})),
}));
// The real ProductSelector is a search/browse widget; a one-click stand-in is
// enough to exercise the dialog's "product required" gate.
vi.mock("../../../components/billing-shared", async (importOriginal) => ({
  ...(await importOriginal()),
  ProductSelector: ({ onSelect }) => (
    <button type="button" onClick={() => onSelect({ id: 3, name: "Widget" })}>Pick Widget</button>
  ),
}));

import PricingPlansPage from "./pricing-plans";

const PRODUCT = { id: 3, name: "Widget", default_price: 99, currency: "USD", billing_frequency: "monthly" };
const PLAN = { id: 21, name: "Gold", product_id: 3, pricing_model: "flat", plan_type: "flat", price: 49, unit_price: 49, currency: "USD", billing_period: "monthly", status: "active", is_active: true };

beforeEach(() => {
  vi.clearAllMocks();
  pricingApi.list.mockResolvedValue({ items: [PLAN], total: 1 });
  pricingApi.create.mockResolvedValue({ id: 22 });
  pricingApi.update.mockResolvedValue({ ...PLAN });
  productApi.list.mockResolvedValue({ items: [PRODUCT] });
  productApi.get.mockResolvedValue(PRODUCT);
  productApi.listCategories.mockResolvedValue({ items: [] });
});
afterEach(() => cleanup());

const renderPage = async () => {
  render(<MemoryRouter><PricingPlansPage /></MemoryRouter>);
  await screen.findByText("Gold");
};

describe("Pricing Plans dialogs", () => {
  it("Add Plan: Create Plan is gated on name + product, then creates and closes", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /add plan/i }));
    const dialog = await screen.findByRole("dialog", { name: "New Pricing Plan" });
    const submit = () => within(dialog).getByRole("button", { name: "Create Plan" });
    expect(submit()).toBeDisabled();

    fireEvent.change(within(dialog).getByPlaceholderText("e.g. Standard Monthly"), { target: { value: "Silver" } });
    expect(submit()).toBeDisabled(); // no product yet
    fireEvent.click(within(dialog).getByRole("button", { name: "Pick Widget" }));
    await waitFor(() => expect(submit()).toBeEnabled());

    fireEvent.click(submit());
    await waitFor(() => expect(pricingApi.create).toHaveBeenCalledTimes(1));
    expect(pricingApi.create.mock.calls[0][0]).toMatchObject({ name: "Silver", product_id: 3, pricing_model: "flat", billing_period: "monthly" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Edit: Save Changes updates the plan and closes", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit Gold" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Pricing Plan" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(pricingApi.update).toHaveBeenCalledTimes(1));
    expect(pricingApi.update.mock.calls[0]).toEqual([21, expect.objectContaining({ name: "Gold", product_id: 3 })]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Preview opens Pricing Preview and Close closes it", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Preview pricing for Gold" }));
    const dialog = await screen.findByRole("dialog", { name: "Pricing Preview" });
    expect(within(dialog).getByText("Gold")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
