import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockSetItems = vi.fn();
const mockCreateAmendment = vi.fn();

vi.mock("../../../service/billingService", () => ({
  contractApi: {
    get: (...a) => mockGet(...a),
    getItems: () => Promise.resolve([]),
    update: (...a) => mockUpdate(...a),
    setItems: (...a) => mockSetItems(...a),
    createAmendment: (...a) => mockCreateAmendment(...a),
  },
  productApi: { list: () => Promise.resolve([]) },
  pricingApi: { listByProduct: vi.fn(), resolvePrice: vi.fn() },
  settingsApi: { get: () => Promise.resolve({ default_currency: "USD" }) },
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useParams: () => ({ id: "5" }), useNavigate: () => vi.fn() };
});

import ContractEditPage from "./contract-edit";

const CONTRACT = { id: 5, contract_name: "Acme MSA", contract_number: "CON-0005", status: "active", start_date: "2026-01-01", end_date: "2030-12-31", currency: "USD", terms: "Net 30" };

async function openAmendmentDialog() {
  render(<MemoryRouter><ContractEditPage /></MemoryRouter>);
  await screen.findByText("Edit Acme MSA");
  fireEvent.change(screen.getByPlaceholderText(/terms and conditions/i), { target: { value: "Net 45" } });
  fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
  return screen.findByRole("dialog", { name: "Active Contract Requires Amendment" });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockGet.mockResolvedValue(CONTRACT);
  mockUpdate.mockResolvedValue({});
  mockCreateAmendment.mockResolvedValue({});
});

describe("Contract edit amendment dialog", () => {
  it("material change on an ACTIVE contract opens the dialog; Save with Amendment records the amendment, saves, closes", async () => {
    const dialog = await openAmendmentDialog();
    expect(mockUpdate).not.toHaveBeenCalled();

    const primary = within(dialog).getByRole("button", { name: /save with amendment/i });
    const dateInput = dialog.querySelector('input[type="date"]');
    fireEvent.change(dateInput, { target: { value: "" } });
    expect(primary).toBeDisabled();
    fireEvent.change(dateInput, { target: { value: "2027-01-01" } });
    expect(primary).toBeEnabled();

    fireEvent.click(primary);
    await waitFor(() => expect(mockCreateAmendment).toHaveBeenCalledWith("5", expect.objectContaining({
      effective_date: "2027-01-01",
      previous_values: { terms: "Net 30" },
      new_values: { terms: "Net 45" },
    })));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith("5", expect.objectContaining({ terms: "Net 45" })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel closes the amendment dialog without saving", async () => {
    const dialog = await openAmendmentDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockCreateAmendment).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
