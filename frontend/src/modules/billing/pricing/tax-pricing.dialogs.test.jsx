import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the Tax Pricing dialogs after the rebuild on Modal,
// including the stacked Tax Groups -> Members case.

const api = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn(),
  listGroups: vi.fn(), createGroup: vi.fn(), updateGroup: vi.fn(), deactivateGroup: vi.fn(),
  listGroupMembers: vi.fn(), addGroupMember: vi.fn(), removeGroupMember: vi.fn(),
}));
vi.mock("../../../service/billingService", () => ({ taxPricingApi: api }));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));

import TaxPricingPage from "./tax-pricing";

const TAX = { id: 5, name: "GST 18", code: "GST-18", tax_type: "gst", rate: 18, pricing_type: "exclusive", effective_from: "2026-01-01", is_active: true };
const GROUP = { id: 9, name: "India GST", code: "IN-GST", is_default: false, is_active: true };

beforeEach(() => {
  vi.clearAllMocks();
  api.list.mockResolvedValue({ items: [TAX], total: 1, page: 1, per_page: 20, pages: 1 });
  api.create.mockResolvedValue({ id: 6 });
  api.update.mockResolvedValue({ ...TAX });
  api.listGroups.mockResolvedValue({ items: [GROUP] });
  api.createGroup.mockResolvedValue({ id: 10 });
  api.listGroupMembers.mockResolvedValue([]);
});
afterEach(() => cleanup());

const renderPage = async () => {
  render(<MemoryRouter><TaxPricingPage /></MemoryRouter>);
  await screen.findByText("GST 18");
};
const esc = () => fireEvent.keyDown(document, { key: "Escape" });

describe("Tax Pricing dialogs", () => {
  it("Create Tax opens the dialog, saves and closes it", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /create tax/i }));
    const dialog = await screen.findByRole("dialog", { name: "Create Tax Pricing" });
    fireEvent.change(within(dialog).getAllByRole("textbox")[0], { target: { value: "VAT 20" } });
    fireEvent.change(within(dialog).getByPlaceholderText("e.g. GST-18"), { target: { value: "vat-20" } });
    fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "20" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Tax" }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create.mock.calls[0][0]).toMatchObject({ name: "VAT 20", code: "VAT-20", rate: 20, tax_type: "vat", pricing_type: "exclusive" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Edit sends Update Tax with the row id and closes", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Tax Pricing" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Update Tax" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
    expect(api.update.mock.calls[0]).toEqual([5, expect.objectContaining({ name: "GST 18", code: "GST-18", rate: 18 })]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("View opens Tax Pricing Details and Close closes it", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog", { name: "Tax Pricing Details" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Tax Groups: Add Group creates a group; footer Close closes", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /tax groups/i }));
    const dialog = await screen.findByRole("dialog", { name: "Tax Groups" });
    await within(dialog).findByText("India GST");
    fireEvent.click(within(dialog).getByRole("button", { name: /add group/i }));
    const [name, code] = within(dialog).getAllByRole("textbox");
    fireEvent.change(name, { target: { value: "EU VAT" } });
    fireEvent.change(code, { target: { value: "eu-vat" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createGroup).toHaveBeenCalledTimes(1));
    expect(api.createGroup.mock.calls[0][0]).toMatchObject({ name: "EU VAT", code: "EU-VAT", is_active: true, is_default: false });
    await waitFor(() => expect(api.listGroups).toHaveBeenCalledTimes(2));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stacked Members dialog: Esc closes only Members, a second Esc closes Tax Groups", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /tax groups/i }));
    const groups = await screen.findByRole("dialog", { name: "Tax Groups" });
    fireEvent.click(await within(groups).findByRole("button", { name: "Members" }));
    await screen.findByRole("dialog", { name: "Members: India GST" });
    await waitFor(() => expect(api.listGroupMembers).toHaveBeenCalledWith(9));

    esc();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Members: India GST" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Tax Groups" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");

    esc();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.style.overflow).toBe("");
  });
});
