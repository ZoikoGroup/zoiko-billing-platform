import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import userEvent from "@testing-library/user-event";

// Quotation create (full page) on the full-page form pattern: sticky phone bar,
// pinned step actions, Cancel + unsaved-changes prompt (no autosave), and the
// same create / addItems / recalculate / send calls as before. Typing is key by key
// (userEvent.type) so a field that loses focus per keystroke would fail.

const mockQuoteCreate = vi.fn();
const mockQuoteAddItems = vi.fn();
const mockQuoteRecalculate = vi.fn();
const mockQuoteSend = vi.fn();
const mockCustomerSearch = vi.fn();
const mockCustomerGet = vi.fn();
const mockSettingsGet = vi.fn();

vi.mock("../../../service/billingService", () => ({
  quoteApi: {
    create: (...a) => mockQuoteCreate(...a),
    addItems: (...a) => mockQuoteAddItems(...a),
    recalculate: (...a) => mockQuoteRecalculate(...a),
    send: (...a) => mockQuoteSend(...a),
  },
  customerApi: { search: (...a) => mockCustomerSearch(...a), get: (...a) => mockCustomerGet(...a) },
  productApi: { list: vi.fn().mockResolvedValue([]), get: vi.fn(), listCategories: vi.fn().mockResolvedValue([]) },
  pricingApi: { listByProduct: vi.fn().mockResolvedValue([]), resolvePrice: vi.fn() },
  settingsApi: { get: (...a) => mockSettingsGet(...a), getExchangeRatePair: vi.fn().mockResolvedValue({ rate: 1 }) },
}));

import QuotationCreateWizardPage from "./quotation-create";

function renderWizard() {
  return render(
    <MemoryRouter initialEntries={["/billing/quotations/create"]}>
      <Routes>
        <Route path="/billing/quotations/create" element={<QuotationCreateWizardPage />} />
        <Route path="/billing/quotations" element={<p>Quotations list</p>} />
        <Route path="/billing/quotations/:id" element={<p>Quotation detail</p>} />
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
  mockSettingsGet.mockResolvedValue({ quote_prefix: "QT-", default_currency: "USD" });
  mockCustomerSearch.mockResolvedValue([{ id: 7, display_name: "Helix Biotech", email: "helix@example.com" }]);
  mockCustomerGet.mockResolvedValue({ id: 7, display_name: "Helix Biotech", email: "helix@example.com", currency: "USD" });
  mockQuoteCreate.mockResolvedValue({ id: 42 });
  mockQuoteAddItems.mockResolvedValue({});
  mockQuoteRecalculate.mockResolvedValue({});
  mockQuoteSend.mockResolvedValue({});
});

describe("Quotation create (full-page pattern)", () => {
  it("shows the phone bar, the required note and pinned step actions", async () => {
    renderWizard();
    expect(screen.getByRole("button", { name: "Back to quotations" })).toBeInTheDocument();
    expect(screen.getAllByText("Step 1 of 6").length).toBeGreaterThan(0);
    // Icon-only on phones, so it carries an explicit name; disabled on step 1.
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Next/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("Cancel leaves straight away when nothing was entered", async () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Quotations list")).toBeInTheDocument();
  });

  it("asks before discarding entered data; Keep editing stays, Discard leaves", async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectCustomer(user);

    fireEvent.click(screen.getByRole("button", { name: "Back to quotations" }));
    const prompt = await screen.findByRole("dialog", { name: "Discard this quotation?" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard this quotation?" })).not.toBeInTheDocument());
    expect(screen.queryByText("Quotations list")).not.toBeInTheDocument();
    expect(screen.getByText("Helix Biotech")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Discard this quotation?" })).getByRole("button", { name: "Discard" }));
    expect(await screen.findByText("Quotations list")).toBeInTheDocument();
  });

  it("keeps value and focus while the subject is typed key by key", async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectCustomer(user);
    next();
    const name = await screen.findByText("Subject").then((l) => l.parentElement.querySelector("input"));
    await user.click(name);
    await user.type(name, "Helix annual services");
    expect(name).toHaveValue("Helix annual services");
    expect(name).toHaveFocus();
  });

  it("Save & Send sends the same calls as before", async () => {
    const user = userEvent.setup();
    renderWizard();
    await selectCustomer(user);
    next();
    const name = (await screen.findByText("Subject")).parentElement.querySelector("input");
    fireEvent.change(name, { target: { value: "Helix annual services" } });
    next();
    const item = await screen.findByText("Description *");
    expect(screen.getByText("Required")).toBeInTheDocument();
    fireEvent.change(item.parentElement.querySelector("input"), { target: { value: "Annual platform licence" } });
    fireEvent.change(screen.getByText("Unit Price *").parentElement.querySelector("input"), { target: { value: "12000" } });
    next(); next(); next();
    await screen.findByText("Finalize Quotation");

    fireEvent.click(screen.getByRole("button", { name: "Save & Send" }));
    await waitFor(() => expect(mockQuoteSend).toHaveBeenCalledWith(42));
    expect(mockQuoteCreate).toHaveBeenCalledTimes(1);
    expect(mockQuoteCreate.mock.calls[0][0]).toMatchObject({ customer_id: 7, subject: "Helix annual services", currency: "USD" });
    expect(mockQuoteAddItems).toHaveBeenCalledWith(42, [
      expect.objectContaining({ line_number: 1, description: "Annual platform licence", quantity: 1, unit_price: 12000 }),
    ]);
    expect(mockQuoteRecalculate).toHaveBeenCalledWith(42);
    expect(await screen.findByText("Quotation detail")).toBeInTheDocument();
  });
});
