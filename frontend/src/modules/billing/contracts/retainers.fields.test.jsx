import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Retainers are products. The products API (ProductResponse) returns
// code / default_price / billing_frequency; the page used to read sku /
// unit_price / billing_period, so the list showed "—" and Edit reset a
// quarterly retainer to monthly on save.

const mockList = vi.fn();
const mockCreate = vi.fn();
const mockUpdate = vi.fn();

vi.mock("../../../service/billingService", () => ({
  productApi: {
    list: (...a) => mockList(...a),
    create: (...a) => mockCreate(...a),
    update: (...a) => mockUpdate(...a),
    delete: vi.fn(),
  },
  settingsApi: { get: () => Promise.resolve({ default_currency: "USD" }) },
}));

import RetainersPage from "./retainers";

// Shape returned by the real API.
const API_RETAINER = {
  id: 9, name: "Quarterly Advisory", code: "RET-Q1", default_price: "1500.00",
  billing_frequency: "quarterly", is_active: true, status: "active", currency: "USD", description: null,
};

async function renderPage() {
  render(<MemoryRouter><RetainersPage /></MemoryRouter>);
  return screen.findByText("Quarterly Advisory");
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockList.mockResolvedValue({ items: [API_RETAINER], total: 1 });
  mockUpdate.mockResolvedValue({ id: 9 });
  mockCreate.mockResolvedValue({ id: 10 });
});

describe("Retainers read the API's product fields", () => {
  it("list row shows code, price and billing frequency from the API shape", async () => {
    const name = await renderPage();
    const row = name.closest("tr");
    expect(within(row).getByText("RET-Q1")).toBeInTheDocument();
    expect(within(row).getByText(/1,500\.00/)).toBeInTheDocument();
    expect(within(row).getByText("quarterly")).toBeInTheDocument();
  });

  it("Edit prefills from the API shape and saving keeps the retainer quarterly", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit retainer" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Quarterly Advisory" });
    expect(within(dialog).getByDisplayValue("RET-Q1")).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue("1500.00")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("combobox")[0]).toHaveValue("quarterly");

    const save = within(dialog).getByRole("button", { name: /save/i });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith(9, expect.objectContaining({ code: "RET-Q1", default_price: 1500, billing_frequency: "quarterly", is_active: true }));
  });

  it("billing period options are values the API accepts", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /new retainer/i }));
    const dialog = await screen.findByRole("dialog", { name: "Create Retainer" });
    const values = [...within(dialog).getAllByRole("combobox")[0].querySelectorAll("option")].map((o) => o.value);
    const API_FREQUENCIES = ["one_time", "monthly", "quarterly", "yearly", "usage_based", "recurring"];
    expect(values.every((v) => API_FREQUENCIES.includes(v))).toBe(true);
    expect(values).toContain("yearly");
  });

  it("still reads the older field names when a payload uses them", async () => {
    mockList.mockResolvedValue({ items: [{ id: 3, name: "Legacy", sku: "RET-OLD", unit_price: 200, billing_period: "monthly", status: "active", currency: "USD" }], total: 1 });
    render(<MemoryRouter><RetainersPage /></MemoryRouter>);
    const row = (await screen.findByText("Legacy")).closest("tr");
    expect(within(row).getByText("RET-OLD")).toBeInTheDocument();
    expect(within(row).getByText(/200\.00/)).toBeInTheDocument();
  });
});
