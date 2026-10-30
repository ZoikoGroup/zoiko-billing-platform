import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the /billing/tax dialogs: New / Edit Tax Rate (shared Modal)
// and the Import Tax Rates wizard (own markup).

const m = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  taxApi: { list: (...a) => m.list(...a), create: (...a) => m.create(...a), update: (...a) => m.update(...a) },
}));

import TaxRatesPage from "./tax-rates";

const GST = { id: 7, name: "GST", code: "GST-STD", rate: 18, tax_type: "gst", jurisdiction: "IN", is_active: true, created_at: "2026-01-01T00:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  m.list.mockResolvedValue({ items: [GST], total: 1 });
  m.create.mockResolvedValue({ id: 8 });
  m.update.mockResolvedValue({});
});
afterEach(() => cleanup());

const renderPage = async () => {
  render(<MemoryRouter><TaxRatesPage /></MemoryRouter>);
  await screen.findByText("GST");
};

describe("Tax Rates dialogs", () => {
  it("New Tax Rate: Create is gated on a name, calls create and closes", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Add Tax Rate/ }));
    const dialog = await screen.findByRole("dialog", { name: "New Tax Rate" });

    const create = within(dialog).getByRole("button", { name: "Create Tax Rate" });
    expect(create).toBeDisabled();
    // Labels aren't tied to inputs; Name is the first text field.
    fireEvent.change(within(dialog).getAllByRole("textbox")[0], { target: { value: "VAT 20" } });
    expect(create).toBeEnabled();
    fireEvent.click(create);

    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ name: "VAT 20", rate: 0, tax_type: "sales_tax" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New Tax Rate" })).toBeNull());
  });

  it("Edit Tax Rate: Update calls update with the rate id and closes", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit tax rate GST" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Tax Rate" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Update Tax Rate" }));

    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    expect(m.update).toHaveBeenCalledWith(7, expect.objectContaining({ name: "GST", code: "GST-STD", rate: 18 }));
    expect(m.create).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Tax Rate" })).toBeNull());
  });

  it("Esc closes the tax-rate dialog without saving", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Add Tax Rate/ }));
    await screen.findByRole("dialog", { name: "New Tax Rate" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.create).not.toHaveBeenCalled();
  });

  it("Import Tax Rates wizard opens and Cancel closes it", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /^Import$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Import Tax Rates" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import Tax Rates" })).toBeNull());
  });
});
