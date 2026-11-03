import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { renderWithRouter } from "../test/renderWithRouter";

// B5: editing the customer details moves Cancel / Save Changes into a pinned
// bar, and leaving with unsaved edits asks first.

const m = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));

vi.mock("../../../service/billingService", () => {
  // Every list/detail call the profile tabs make resolves empty.
  const stub = (extra = {}) => new Proxy(extra, {
    get: (t, k) => (k in t ? t[k] : (t[k] = vi.fn(() => Promise.resolve([])))),
  });
  return {
    customerApi: stub({ get: (...a) => m.get(...a), update: (...a) => m.update(...a) }),
    invoiceApi: stub(), paymentApi: stub(), contractApi: stub(),
    subscriptionApi: stub(), creditNoteApi: stub(), quoteApi: stub(),
    settingsApi: stub({ getConfig: vi.fn(() => Promise.resolve({})) }),
  };
});
vi.mock("../../../service/billingConfigCache", () => ({
  loadGlobalBillingConfig: vi.fn(() => Promise.resolve({})),
  subscribeBillingConfigInvalidation: vi.fn(() => () => {}),
}));
vi.mock("../utils/CurrencyContext", () => ({ useCurrency: () => ({ baseCurrency: "USD" }) }));
vi.mock("../utils/TerminologyContext", () => ({ useTerminology: () => ({ singular: "Customer", plural: "Customers" }) }));

import CustomerProfilePage from "./customer-profile";

const CUSTOMER = { id: 42, display_name: "Acme Display", company_name: "Acme Corp", email: "a@acme.test", status: "active", customer_type: "business", currency: "USD" };

let link;
beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockResolvedValue(CUSTOMER);
  m.update.mockResolvedValue({});
  link = document.createElement("a");
  link.href = "/billing/customers";
  link.textContent = "All customers";
  link.addEventListener("click", (e) => e.preventDefault());
  document.body.appendChild(link);
});
afterEach(() => {
  link.remove();
  vi.restoreAllMocks();
  cleanup();
});

const startEditing = async () => {
  renderWithRouter(<CustomerProfilePage />, { routePath: "/billing/customers/:id", initialEntries: ["/billing/customers/42"] });
  fireEvent.click(await screen.findByRole("button", { name: /^Edit$/ }));
  return screen.findByDisplayValue("Acme Display");
};

describe("Customer profile — editing details", () => {
  it("swaps Edit for a Cancel / Save Changes bar, and Cancel brings Edit back", async () => {
    await startEditing();
    expect(screen.queryByRole("button", { name: /^Edit$/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Save Changes/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(await screen.findByRole("button", { name: /^Edit$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save Changes/ })).toBeNull();
  });

  it("asks before leaving with unsaved edits, not without", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const input = await startEditing();

    fireEvent.click(link);
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Acme Renamed" } });
    fireEvent.click(link);
    expect(confirm).toHaveBeenCalledWith("You have unsaved changes to this customer. Leave and discard them?");
  });

  it("Save Changes sends the edit and closes the bar", async () => {
    const input = await startEditing();
    fireEvent.change(input, { target: { value: "Acme Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));

    await waitFor(() => expect(m.update).toHaveBeenCalledWith("42", expect.objectContaining({ display_name: "Acme Renamed" })));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Save Changes/ })).toBeNull());
  });
});
