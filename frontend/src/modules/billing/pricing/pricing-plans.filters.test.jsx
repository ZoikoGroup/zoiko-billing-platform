import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

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

import PricingPlansPage from "./pricing-plans";

beforeEach(() => {
  vi.clearAllMocks();
  pricingApi.list.mockResolvedValue({ items: [], total: 0 });
  productApi.list.mockResolvedValue({ items: [] });
  productApi.listCategories.mockResolvedValue({ items: [] });
});

const lastListParams = () => pricingApi.list.mock.calls.at(-1)[0];

describe("Pricing Plans filters", () => {
  it("clears status, model, period and search in one click", async () => {
    render(
      <MemoryRouter>
        <PricingPlansPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(pricingApi.list).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /toggle filters/i }));

    const clear = screen.getByRole("button", { name: /^clear filters$/i });
    expect(clear).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/filter by status/i), { target: { value: "active" } });
    const model = screen.getByLabelText(/filter by pricing model/i);
    fireEvent.change(model, { target: { value: model.options[1].value } });
    const period = screen.getByLabelText(/filter by billing period/i);
    fireEvent.change(period, { target: { value: period.options[1].value } });
    fireEvent.change(screen.getByLabelText(/search plans by name/i), { target: { value: "gold" } });

    await waitFor(() => expect(lastListParams()).toMatchObject({ status: "active", search_term: "gold" }));
    // The filter toggle shows how many filters are on, even when collapsed.
    expect(screen.getByRole("button", { name: /toggle filters \(4 active\)/i })).toBeInTheDocument();
    expect(await screen.findByText(/try adjusting your search or filters/i)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /^clear filters$/i })[0]);
    await waitFor(() => expect(screen.getByLabelText(/filter by status/i)).toHaveValue(""));
    expect(screen.getByLabelText(/filter by pricing model/i)).toHaveValue("");
    expect(screen.getByLabelText(/filter by billing period/i)).toHaveValue("");
    expect(screen.getByLabelText(/search plans by name/i)).toHaveValue("");
    await waitFor(() => {
      const params = lastListParams();
      expect(params.status).toBeUndefined();
      expect(params.pricing_model).toBeUndefined();
      expect(params.billing_period).toBeUndefined();
      expect(params.search_term).toBeUndefined();
    });
    expect(screen.getAllByRole("button", { name: /^clear filters$/i })[0]).toBeDisabled();
  });
});
