import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import userEvent from "@testing-library/user-event";

// Contract edit on the full-page form pattern: phone bar, pinned Cancel /
// Save Changes, discard prompt only when something changed, and line items as
// cards on phones (same inputs and handlers as the desktop table).

const mockGet = vi.fn();
const mockGetItems = vi.fn();
const mockUpdate = vi.fn();
const mockSetItems = vi.fn();

vi.mock("../../../service/billingService", () => ({
  contractApi: {
    get: (...a) => mockGet(...a),
    getItems: (...a) => mockGetItems(...a),
    update: (...a) => mockUpdate(...a),
    setItems: (...a) => mockSetItems(...a),
    createAmendment: vi.fn(),
  },
  productApi: { list: () => Promise.resolve([]) },
  pricingApi: { listByProduct: vi.fn(), resolvePrice: vi.fn() },
  settingsApi: { get: () => Promise.resolve({ default_currency: "USD" }) },
}));

import ContractEditPage from "./contract-edit";

const CONTRACT = { id: 5, contract_name: "Acme MSA", contract_number: "CON-0005", status: "draft", start_date: "2026-01-01", end_date: "2030-12-31", currency: "USD", terms: "Net 30" };
const ITEM = { id: 11, line_number: 1, description: "Support retainer", quantity: 2, unit_price: 500, discount_percentage: 0, tax_percentage: 0 };

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/billing/contracts/5/edit"]}>
      <Routes>
        <Route path="/billing/contracts/:id/edit" element={<ContractEditPage />} />
        <Route path="/billing/contracts/:id" element={<p>Contract detail</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const originalMatchMedia = window.matchMedia;
function emulatePhone() {
  window.matchMedia = (query) => ({
    matches: query === "(max-width: 639.98px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockGet.mockResolvedValue(CONTRACT);
  mockGetItems.mockResolvedValue([ITEM]);
  mockUpdate.mockResolvedValue({});
  mockSetItems.mockResolvedValue({});
});
afterEach(() => { window.matchMedia = originalMatchMedia; });

describe("Contract edit (full-page pattern)", () => {
  it("shows the phone bar and a pinned Cancel / Save Changes bar", async () => {
    renderPage();
    await screen.findByText("Edit Acme MSA");
    expect(screen.getByRole("button", { name: "Back to contract" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save Changes/ })).toBeInTheDocument();
  });

  it("Cancel leaves straight away when nothing changed", async () => {
    renderPage();
    await screen.findByText("Edit Acme MSA");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Contract detail")).toBeInTheDocument();
  });

  it("asks before discarding a change; Keep editing keeps it", async () => {
    renderPage();
    await screen.findByText("Edit Acme MSA");
    fireEvent.change(screen.getByPlaceholderText(/terms and conditions/i), { target: { value: "Net 45" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to contract" }));
    const prompt = await screen.findByRole("dialog", { name: "Discard changes?" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard changes?" })).not.toBeInTheDocument());
    expect(screen.getByPlaceholderText(/terms and conditions/i)).toHaveValue("Net 45");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Discard changes?" })).getByRole("button", { name: "Discard changes" }));
    expect(await screen.findByText("Contract detail")).toBeInTheDocument();
  });

  it("phones: line items are cards; typing key by key keeps focus and Save sends it", async () => {
    emulatePhone();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Edit Acme MSA");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const desc = screen.getByLabelText("Description");
    expect(desc).toHaveValue("Support retainer");
    await user.clear(desc);
    await user.type(desc, "Premium support");
    expect(desc).toHaveValue("Premium support");
    expect(desc).toHaveFocus();
    expect(screen.getByRole("button", { name: "Remove line item" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));
    await waitFor(() => expect(mockSetItems).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith("5", expect.objectContaining({ contract_name: "Acme MSA" }));
    expect(mockSetItems.mock.calls[0][1].items[0]).toMatchObject({ description: "Premium support", quantity: 2, unit_price: 500 });
  });
});
