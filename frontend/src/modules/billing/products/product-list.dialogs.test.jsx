import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the Product List dialogs rebuilt on the shared Modal.

const m = vi.hoisted(() => ({ list: vi.fn(), listCategories: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  productApi: {
    list: (...a) => m.list(...a),
    listCategories: (...a) => m.listCategories(...a),
    create: (...a) => m.create(...a),
    update: (...a) => m.update(...a),
  },
}));
if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};

import ProductListPage from "./product-list";

const PRODUCT = { id: 3, name: "Widget", code: "W-1", default_price: 10, currency: "USD", status: "active", product_type: "service", billing_frequency: "one_time" };
// Labels have no htmlFor pairing, so reach the input through the label's wrapper.
const fieldIn = (dialog, label) => within(dialog).getByText(label).parentElement.querySelector("input, textarea, select");

beforeEach(() => {
  vi.clearAllMocks();
  m.list.mockResolvedValue({ items: [PRODUCT], total: 1 });
  m.listCategories.mockResolvedValue([]);
  m.create.mockResolvedValue({ id: 4 });
  m.update.mockResolvedValue({ id: 3 });
});
afterEach(() => cleanup());

async function renderPage() {
  render(<MemoryRouter><ProductListPage /></MemoryRouter>);
  await screen.findByRole("button", { name: "Edit Widget" });
}

describe("Product List dialogs", () => {
  it("New Product: Create is gated on name, calls productApi.create, then closes", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add Product" }));
    const dialog = await screen.findByRole("dialog", { name: "New Product" });
    const create = within(dialog).getByRole("button", { name: "Create Product" });
    expect(create).toBeDisabled();
    fireEvent.change(fieldIn(dialog, "Product Name *"), { target: { value: "Gizmo" } });
    fireEvent.change(fieldIn(dialog, "SKU / Code *"), { target: { value: "GZ-1" } });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Gizmo", code: "GZ-1", default_price: 0 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Edit Product: Save Changes calls productApi.update with the row id, then closes", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit Widget" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Product" });
    expect(fieldIn(dialog, "Product Name *")).toHaveValue("Widget");
    fireEvent.change(fieldIn(dialog, "Product Name *"), { target: { value: "Widget 2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    expect(m.update).toHaveBeenCalledWith(3, expect.objectContaining({ name: "Widget 2", code: "W-1", default_price: 10 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel closes the New Product dialog without calling the API", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add Product" }));
    const dialog = await screen.findByRole("dialog", { name: "New Product" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(m.create).not.toHaveBeenCalled();
  });

  it("Import opens the import wizard and its Cancel closes it", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    const dialog = await screen.findByRole("dialog", { name: "Import Products & Services" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
