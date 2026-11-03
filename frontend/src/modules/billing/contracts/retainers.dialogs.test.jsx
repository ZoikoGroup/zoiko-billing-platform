import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockSettingsGet = vi.fn();

vi.mock("../../../service/billingService", () => ({
  productApi: {
    list: (...a) => mockList(...a),
    create: (...a) => mockCreate(...a),
    update: (...a) => mockUpdate(...a),
    delete: (...a) => mockDelete(...a),
  },
  settingsApi: { get: (...a) => mockSettingsGet(...a) },
}));

import RetainersPage from "./retainers";

const RETAINER = { id: 7, name: "Gold Retainer", sku: "RET-7", unit_price: 500, billing_period: "monthly", status: "active", currency: "USD" };

async function renderPage() {
  render(<MemoryRouter><RetainersPage /></MemoryRouter>);
  await screen.findByText("Gold Retainer");
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockList.mockResolvedValue({ items: [RETAINER], total: 1 });
  mockSettingsGet.mockResolvedValue({ default_currency: "USD" });
  mockCreate.mockResolvedValue({ id: 8 });
  mockUpdate.mockResolvedValue({ id: 7 });
  mockDelete.mockResolvedValue({});
});

describe("Retainers dialogs", () => {
  it("Create Retainer: gated on name + unit price, calls productApi.create, closes", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /new retainer/i }));
    const dialog = await screen.findByRole("dialog", { name: "Create Retainer" });
    const create = within(dialog).getByRole("button", { name: /create/i });
    expect(create).toBeDisabled();

    fireEvent.change(within(dialog).getByPlaceholderText(/monthly consulting retainer/i), { target: { value: "Silver" } });
    expect(create).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText("0.00"), { target: { value: "250" } });
    expect(create).toBeEnabled();

    fireEvent.click(create);
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Silver", default_price: 250, product_type: "retainer" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel closes the Create Retainer dialog without calling the API", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /new retainer/i }));
    const dialog = await screen.findByRole("dialog", { name: "Create Retainer" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("Edit <name>: Save calls productApi.update(id, ...) and closes", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit retainer" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Gold Retainer" });
    fireEvent.click(within(dialog).getByRole("button", { name: /save/i }));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith(7, expect.objectContaining({ name: "Gold Retainer", default_price: 500 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Delete Retainer: Delete calls productApi.delete(id) and closes", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Delete retainer" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Retainer" });
    fireEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith(7));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
