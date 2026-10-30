import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { renderWithRouter } from "../test/renderWithRouter";

// Smoke tests for the customer profile's ConfirmModal (shared Modal), driven
// from the header's Deactivate button.

const m = vi.hoisted(() => ({ get: vi.fn(), deactivate: vi.fn() }));

vi.mock("../../../service/billingService", () => {
  // Every list/detail call the profile tabs make resolves empty.
  const stub = (extra = {}) => new Proxy(extra, {
    get: (t, k) => (k in t ? t[k] : (t[k] = vi.fn(() => Promise.resolve([])))),
  });
  return {
    customerApi: stub({ get: (...a) => m.get(...a), deactivate: (...a) => m.deactivate(...a) }),
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

const CUSTOMER = { id: 42, display_name: "Acme Corp", company_name: "Acme Corp", email: "a@acme.test", status: "active", customer_type: "business", currency: "USD" };

beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockResolvedValue(CUSTOMER);
  m.deactivate.mockResolvedValue({});
});
afterEach(() => cleanup());

const openDeactivate = async () => {
  renderWithRouter(<CustomerProfilePage />, { routePath: "/billing/customers/:id", initialEntries: ["/billing/customers/42"] });
  fireEvent.click(await screen.findByRole("button", { name: /^Deactivate$/ }));
  return screen.findByRole("dialog", { name: "Deactivate Customer" });
};

describe("Customer profile ConfirmModal", () => {
  it("opens titled, focuses Cancel (danger), and Confirm deactivates and closes", async () => {
    const dialog = await openDeactivate();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: /Deactivate/ }));
    await waitFor(() => expect(m.deactivate).toHaveBeenCalledWith("42"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Deactivate Customer" })).toBeNull());
  });

  it("Cancel closes without deactivating", async () => {
    const dialog = await openDeactivate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.deactivate).not.toHaveBeenCalled();
  });

  it("Esc closes without deactivating", async () => {
    await openDeactivate();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.deactivate).not.toHaveBeenCalled();
  });
});
