import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import userEvent from "@testing-library/user-event";

// Contract create wizard on the full-page form pattern: sticky phone bar,
// pinned step actions, Cancel + unsaved-changes prompt (no autosave), and the
// same create / setItems / activate calls as before. Typing is key by key
// (userEvent.type) so a field that loses focus per keystroke would fail.

const mockContractCreate = vi.fn();
const mockContractSetItems = vi.fn();
const mockContractActivate = vi.fn();
const mockCustomerSearch = vi.fn();
const mockCustomerGet = vi.fn();
const mockSettingsGet = vi.fn();
const mockQuoteList = vi.fn();

vi.mock("../../../service/billingService", () => ({
  contractApi: {
    create: (...a) => mockContractCreate(...a),
    setItems: (...a) => mockContractSetItems(...a),
    activate: (...a) => mockContractActivate(...a),
  },
  customerApi: { search: (...a) => mockCustomerSearch(...a), get: (...a) => mockCustomerGet(...a) },
  productApi: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), listCategories: vi.fn().mockResolvedValue([]) },
  pricingApi: { listByProduct: vi.fn().mockResolvedValue([]), resolvePrice: vi.fn() },
  settingsApi: { get: (...a) => mockSettingsGet(...a) },
  quoteApi: { list: (...a) => mockQuoteList(...a), listItems: vi.fn().mockResolvedValue([]) },
}));

import ContractCreateWizardPage from "./contract-create";

function renderWizard() {
  return render(
    <MemoryRouter initialEntries={["/billing/contracts/create"]}>
      <Routes>
        <Route path="/billing/contracts/create" element={<ContractCreateWizardPage />} />
        <Route path="/billing/contracts" element={<p>Contracts list</p>} />
        <Route path="/billing/contracts/:id" element={<p>Contract detail</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const next = () => fireEvent.click(screen.getByRole("button", { name: /^Next/ }));

async function selectCustomer(user) {
  const search = screen.getByLabelText(/search customer by name/i);
  await user.type(search, "Helix");
  fireEvent.click(await screen.findByRole("button", { name: /Helix Biotech/ }));
  await screen.findByText("helix@example.com • USD");
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockSettingsGet.mockResolvedValue({ contract_prefix: "CTR-", default_currency: "USD" });
  mockQuoteList.mockResolvedValue([]);
  mockCustomerSearch.mockResolvedValue([{ id: 7, display_name: "Helix Biotech", email: "helix@example.com" }]);
  mockCustomerGet.mockResolvedValue({ id: 7, display_name: "Helix Biotech", email: "helix@example.com", currency: "USD" });
  mockContractCreate.mockResolvedValue({ id: 42 });
  mockContractSetItems.mockResolvedValue({});
  mockContractActivate.mockResolvedValue({});
});

describe("Contract create wizard (full-page pattern)", () => {
  it("shows the phone bar, the required note and pinned step actions", async () => {
    renderWizard();
    expect(screen.getByRole("button", { name: "Back to contracts" })).toBeInTheDocument();
    expect(screen.getAllByText("Step 1 of 7").length).toBeGreaterThan(0);
    expect(screen.getByText("Required")).toBeInTheDocument();
    // Icon-only on phones, so it carries an explicit name; disabled on step 1.
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Next/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("Cancel leaves straight away when nothing was entered", async () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Contracts list")).toBeInTheDocument();
  });

  it("asks before discarding entered data; Keep editing stays, Discard leaves", async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectCustomer(user);

    fireEvent.click(screen.getByRole("button", { name: "Back to contracts" }));
    const prompt = await screen.findByRole("dialog", { name: "Discard this contract?" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard this contract?" })).not.toBeInTheDocument());
    expect(screen.queryByText("Contracts list")).not.toBeInTheDocument();
    expect(screen.getByText("Helix Biotech")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Discard this contract?" })).getByRole("button", { name: "Discard" }));
    expect(await screen.findByText("Contracts list")).toBeInTheDocument();
  });

  it("keeps value and focus while the contract name is typed key by key", async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectCustomer(user);
    next();
    const name = await screen.findByText("Contract Name *").then((l) => l.parentElement.querySelector("input"));
    await user.click(name);
    await user.type(name, "Helix annual services");
    expect(name).toHaveValue("Helix annual services");
    expect(name).toHaveFocus();
  });

  it("Save as Draft and Save & Activate send the same calls as before", async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectCustomer(user);
    next();
    const name = (await screen.findByText("Contract Name *")).parentElement.querySelector("input");
    fireEvent.change(name, { target: { value: "Helix annual services" } });
    next();
    const item = await screen.findByText("Description");
    fireEvent.change(item.parentElement.querySelector("input"), { target: { value: "Annual platform licence" } });
    fireEvent.change(screen.getByText("Unit Price").parentElement.querySelector("input"), { target: { value: "12000" } });
    next(); next(); next(); next();
    await screen.findByText("Finalize Contract");
    expect(screen.queryByText("Required")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save & Activate" }));
    await waitFor(() => expect(mockContractActivate).toHaveBeenCalledWith(42));
    expect(mockContractCreate).toHaveBeenCalledTimes(1);
    expect(mockContractCreate.mock.calls[0][0]).toMatchObject({
      customer_id: 7, contract_name: "Helix annual services", currency: "USD", status: "draft", billing_period: "monthly",
    });
    expect(mockContractSetItems).toHaveBeenCalledWith(42, {
      items: [expect.objectContaining({ description: "Annual platform licence", quantity: 1, unit_price: 12000 })],
    });
    expect(await screen.findByText("Contract detail")).toBeInTheDocument();
  });
});
