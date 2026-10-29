process.env.TZ = "Asia/Kolkata";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Batch 7 BUG-07 (/billing/pricing/discounts): "Valid To allows previous
// years". The rule (backend validate_validity_date_range: Valid To must be
// after Valid From) already existed, but a TYPED year bypasses the picker's
// min and was only flagged on Save, so a past date looked accepted. Past
// dates are not banned outright: historical discounts are legitimate.

const m = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  discountApi: { list: (...a) => m.list(...a), create: (...a) => m.create(...a), update: (...a) => m.update(...a), deactivate: vi.fn() },
  settingsApi: { getConfig: () => Promise.resolve({ base_currency: "INR", default_currency: "INR" }), get: () => Promise.resolve({ default_currency: "INR" }) },
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children, actions }) => <div><h1>{title}</h1>{actions}{children}</div> }));

import DiscountEnginePage from "./discount-engine";

beforeEach(() => { vi.clearAllMocks(); m.list.mockResolvedValue({ items: [], total: 0, page: 1, per_page: 20, pages: 1 }); m.create.mockResolvedValue({ id: 10 }); });
afterEach(() => cleanup());

const openCreate = async () => {
  render(<MemoryRouter><DiscountEnginePage /></MemoryRouter>);
  fireEvent.click((await screen.findAllByRole("button", { name: /create discount/i }))[0]);
  return screen.getByRole("dialog", { name: "Create Discount" });
};

describe("BUG-07 Discount Valid To", () => {
  it("a typed past year is flagged immediately (not only on Save)", async () => {
    const dialog = await openCreate();
    const to = within(dialog).getByLabelText("Valid To");
    fireEvent.change(to, { target: { value: "2024-01-15T10:00" } });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Valid to must be after valid from");
    expect(to).toHaveAttribute("aria-invalid", "true");
    // Only the date range is wrong: Save must not send, and the error is not repeated.
    fireEvent.change(within(dialog).getByLabelText("Name *"), { target: { value: "Spring" } });
    fireEvent.change(within(dialog).getByLabelText("Value *"), { target: { value: "5" } });
    fireEvent.click(within(dialog).getAllByRole("button", { name: /create discount/i }).at(-1));
    await new Promise((r) => setTimeout(r, 30));
    expect(m.create).not.toHaveBeenCalled();
    expect(within(dialog).getAllByRole("alert")).toHaveLength(1); // announced once, not twice
    expect(document.activeElement).toBe(to);
  });

  it("a historical range (From and To both in the past, To after From) is allowed, with a warning", async () => {
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Valid From *"), { target: { value: "2024-01-01T10:00" } });
    fireEvent.change(within(dialog).getByLabelText("Valid To"), { target: { value: "2024-01-15T10:00" } });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).getByText(/already be expired/)).toBeInTheDocument();
  });

  it("fixing Valid From clears the error live", async () => {
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Valid To"), { target: { value: "2024-01-15T10:00" } });
    expect(within(dialog).getByRole("alert")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Valid From *"), { target: { value: "2024-01-01T10:00" } });
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("every field is labelled; Escape closes the dialog", async () => {
    const dialog = await openCreate();
    for (const l of ["Name *", "Code", "Description", "Discount Type *", "Value Type", "Value *", "Currency", "Min Order Amount", "Max Discount", "Status", "Usage Limit", "Per Customer Limit"]) {
      expect(within(dialog).getByLabelText(l)).toBeInTheDocument();
    }
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("Discount dialogs (smoke, rebuilt on Modal)", () => {
  const ROW = { id: 4, name: "Autumn", code: "AUT", discount_type: "coupon", value_type: "percentage", discount_value: 10, status: "active", currency: "INR", valid_from: "2026-01-01T00:00:00" };

  it("Create Discount sends the form and closes the dialog", async () => {
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Name *"), { target: { value: "Spring" } });
    fireEvent.change(within(dialog).getByLabelText("Value *"), { target: { value: "5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Discount" }));
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0][0]).toMatchObject({ name: "Spring", discount_value: 5, discount_type: "coupon", value_type: "percentage", status: "draft" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Edit sends Update Discount with the row id", async () => {
    m.list.mockResolvedValue({ items: [ROW], total: 1, page: 1, per_page: 20, pages: 1 });
    m.update.mockResolvedValue({ ...ROW });
    render(<MemoryRouter><DiscountEnginePage /></MemoryRouter>);
    await screen.findByText("Autumn");
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Discount" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Update Discount" }));
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    expect(m.update.mock.calls[0]).toEqual([4, expect.objectContaining({ name: "Autumn", code: "AUT", discount_value: 10 })]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("View opens Discount Details and Close closes it", async () => {
    m.list.mockResolvedValue({ items: [ROW], total: 1, page: 1, per_page: 20, pages: 1 });
    render(<MemoryRouter><DiscountEnginePage /></MemoryRouter>);
    await screen.findByText("Autumn");
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog", { name: "Discount Details" });
    expect(within(dialog).getByText("Autumn")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
