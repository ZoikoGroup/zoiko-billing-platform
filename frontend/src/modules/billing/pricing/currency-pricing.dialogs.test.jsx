import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the Currency Pricing dialogs after the rebuild on Modal.

const m = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), products: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  currencyPricingApi: { list: (...a) => m.list(...a), create: (...a) => m.create(...a), update: (...a) => m.update(...a), deactivate: vi.fn() },
  productApi: { list: (...a) => m.products(...a) },
}));
vi.mock("../../../service/billingConfigCache", async (importOriginal) => ({
  ...(await importOriginal()),
  loadGlobalBillingConfig: () => Promise.resolve({ default_currency: "INR" }),
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));

import CurrencyPricingPage from "./currency-pricing";

const ROW = { id: 7, product_id: 3, currency: "USD", price: 10, cost_price: null, conversion_type: "manual", exchange_rate: null, is_active: true };

beforeEach(() => {
  vi.clearAllMocks();
  m.list.mockResolvedValue({ items: [ROW], total: 1, page: 1, per_page: 20, pages: 1 });
  m.products.mockResolvedValue({ items: [{ id: 3, name: "Widget" }] });
  m.create.mockResolvedValue({ id: 8 });
  m.update.mockResolvedValue({ ...ROW });
});
afterEach(() => cleanup());

const renderPage = () => render(<MemoryRouter><CurrencyPricingPage /></MemoryRouter>);

describe("Currency Pricing dialogs", () => {
  it("Add Currency Price opens the dialog, Save creates and closes it", async () => {
    renderPage();
    await screen.findByText("Widget");
    fireEvent.click(screen.getByRole("button", { name: /add currency price/i }));
    const dialog = await screen.findByRole("dialog", { name: "Add Currency Pricing" });
    const [product, currency] = within(dialog).getAllByRole("combobox");
    fireEvent.change(product, { target: { value: "3" } });
    fireEvent.change(currency, { target: { value: "USD" } });
    fireEvent.change(within(dialog).getAllByRole("spinbutton")[0], { target: { value: "12.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0][0]).toMatchObject({ product_id: 3, currency: "USD", price: 12.5, conversion_type: "manual", is_active: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Edit opens the edit dialog and Update sends the row id", async () => {
    renderPage();
    await screen.findByText("Widget");
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Currency Pricing" });
    fireEvent.change(within(dialog).getAllByRole("spinbutton")[0], { target: { value: "15" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Update" }));
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    expect(m.update.mock.calls[0]).toEqual([7, expect.objectContaining({ product_id: 3, currency: "USD", price: 15 })]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Cancel and the header close button dismiss without saving", async () => {
    renderPage();
    await screen.findByText("Widget");
    fireEvent.click(screen.getByRole("button", { name: /add currency price/i }));
    let dialog = await screen.findByRole("dialog", { name: "Add Currency Pricing" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /add currency price/i }));
    dialog = await screen.findByRole("dialog", { name: "Add Currency Pricing" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(m.create).not.toHaveBeenCalled();
  });
});
