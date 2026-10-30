import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Autosave when leaving: the draft must survive an immediate exit (the
// debounced save used to be dropped on unmount) and must stay cleared after a
// successful save. Mocks and helpers copied from create-invoice-wizard.test.jsx.
//
// This wizard is the money-creating action for the whole billing platform:
// it builds an invoice + line-item payload and POSTs it via invoiceApi.create /
// invoiceApi.bulkSetItems. These tests mock every API the component touches on
// mount (settings/tax/customer search) and on submit, then drive the wizard
// through its real steps exactly as a user would (Next/Back + form fields),
// asserting on the mocked API call counts/args rather than on internals.

const mockInvoiceCreate = vi.fn();
const mockInvoiceBulkSetItems = vi.fn();
const mockInvoiceGet = vi.fn();
const mockInvoiceSendEmail = vi.fn();
const mockCustomerSearch = vi.fn();
const mockCustomerGet = vi.fn();
const mockProductList = vi.fn();
const mockProductGet = vi.fn();
const mockProductListCategories = vi.fn();
const mockSettingsGetConfig = vi.fn();
const mockSettingsGetExchangeRatePair = vi.fn();
const mockTaxList = vi.fn();
const mockPricingListByProduct = vi.fn();

vi.mock("../../../service/billingService", () => ({
  invoiceApi: {
    create: (...args) => mockInvoiceCreate(...args),
    bulkSetItems: (...args) => mockInvoiceBulkSetItems(...args),
    get: (...args) => mockInvoiceGet(...args),
    sendEmail: (...args) => mockInvoiceSendEmail(...args),
  },
  customerApi: {
    search: (...args) => mockCustomerSearch(...args),
    get: (...args) => mockCustomerGet(...args),
  },
  productApi: {
    list: (...args) => mockProductList(...args),
    get: (...args) => mockProductGet(...args),
    listCategories: (...args) => mockProductListCategories(...args),
  },
  settingsApi: {
    getConfig: (...args) => mockSettingsGetConfig(...args),
    getExchangeRatePair: (...args) => mockSettingsGetExchangeRatePair(...args),
  },
  taxApi: {
    list: (...args) => mockTaxList(...args),
  },
  pricingApi: {
    listByProduct: (...args) => mockPricingListByProduct(...args),
  },
}));

import CreateInvoiceWizard from "./create-invoice-wizard";

const ORG_SETTINGS = {
  base_currency: "USD",
  default_currency: "USD",
  default_due_days: 30,
  default_payment_terms: "net_30",
  auto_generate_invoice_number: true,
  relationship_terminology: "customer",
};

const CUSTOMER_SEARCH_RESULT = {
  id: 1,
  display_name: "Acme Corp",
  company_name: "Acme Corp",
  email: "acme@example.com",
};

const CUSTOMER_FULL = {
  id: 1,
  display_name: "Acme Corp",
  company_name: "Acme Corp",
  email: "acme@example.com",
  currency: "USD",
  payment_terms: "net_30",
  billing_address: "123 Main St",
  status: "active",
};

function renderWizard(props = {}) {
  const onClose = props.onClose || vi.fn();
  const onCreated = props.onCreated || vi.fn();
  render(
    <MemoryRouter>
      <CreateInvoiceWizard {...props} onClose={onClose} onCreated={onCreated} />
    </MemoryRouter>
  );
  return { onClose, onCreated };
}

async function selectCustomer() {
  const input = await screen.findByLabelText(/search customer/i);
  fireEvent.change(input, { target: { value: "Acme" } });
  const option = await screen.findByRole("option", { name: /Acme Corp/i }, { timeout: 2000 });
  fireEvent.click(option);
  // Confirms handleCustomerSelect's async customerApi.get resolved and the
  // form actually carries the selected customer forward.
  await screen.findByText("Acme Corp");
}

function clickNext() {
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
}

function clickBack() {
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
}

// ProductSelector (always mounted on step 3, in dropdown mode) re-fetches its
// category list (productApi.listCategories) on every render, because the
// wizard passes it a brand-new inline `fetchCategories` callback each time —
// so every field edit on this step (which re-renders the wizard) kicks off
// another categories fetch. Flush the trailing one under act() with a
// real-timer wait, after the *last* step-3 edit, so its setState doesn't fire
// outside act() once the test has moved on to a later step.
async function waitForProductSelectorToSettle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(mockProductListCategories).toHaveBeenCalled();
}

async function addLineItem({ description, quantity, unitPrice }) {
  fireEvent.click(screen.getByRole("button", { name: /add line item/i }));
  if (description !== undefined) {
    const descInput = await screen.findByLabelText(/description for item 1/i);
    fireEvent.change(descInput, { target: { value: description } });
  }
  if (quantity !== undefined) {
    fireEvent.change(screen.getByLabelText(/quantity for item 1/i), { target: { value: quantity } });
  }
  if (unitPrice !== undefined) {
    fireEvent.change(screen.getByLabelText(/unit price for item 1/i), { target: { value: unitPrice } });
  }
  await waitForProductSelectorToSettle();
}

// Drives the wizard from a freshly-selected customer (step 1) all the way to
// step 7 ("Actions"), filling in one valid line item along the way.
async function advanceToActionsStep() {
  clickNext(); // step 1 -> 2 (customer already selected)
  await screen.findByLabelText(/invoice date/i);
  clickNext(); // step 2 -> 3
  await addLineItem({ description: "Consulting Services", quantity: "3", unitPrice: "150" });
  clickNext(); // step 3 -> 4
  await screen.findByLabelText(/global discount/i);
  clickNext(); // step 4 -> 5
  await screen.findByText(/Line Items \(1\)/i);
  clickNext(); // step 5 -> 6 (PDF preview)
  clickNext(); // step 6 -> 7
  await screen.findByText(/Ready to Save/i);
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();

  mockSettingsGetConfig.mockResolvedValue(ORG_SETTINGS);
  mockSettingsGetExchangeRatePair.mockResolvedValue({ rate: 1, source: "cached" });
  mockTaxList.mockResolvedValue([]);
  mockCustomerSearch.mockResolvedValue([CUSTOMER_SEARCH_RESULT]);
  mockCustomerGet.mockResolvedValue(CUSTOMER_FULL);
  mockProductList.mockResolvedValue([]);
  mockProductListCategories.mockResolvedValue([]);
  mockPricingListByProduct.mockResolvedValue([]);
  mockInvoiceCreate.mockResolvedValue({ id: 501, invoice_number: "INV-000501" });
  mockInvoiceBulkSetItems.mockResolvedValue({});
  mockInvoiceGet.mockResolvedValue({ id: 501, invoice_number: "INV-000501", status: "draft" });
  mockInvoiceSendEmail.mockResolvedValue({ email_delivered: true });
});


const DRAFT_KEY = "zoiko_invoice_draft_v1";
const readDraft = () => JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");

describe("Create Invoice wizard — draft when leaving", () => {
  it("leaving right after adding a line item keeps the step and the line item", async () => {
    renderWizard();
    await selectCustomer();
    clickNext();
    await screen.findByLabelText(/invoice date/i);
    clickNext();
    fireEvent.click(screen.getByRole("button", { name: /add line item/i }));
    fireEvent.change(await screen.findByLabelText(/description for item 1/i), { target: { value: "Onsite workshop" } });
    fireEvent.change(screen.getByLabelText(/quantity for item 1/i), { target: { value: "3" } });
    await waitForProductSelectorToSettle();
    // Leave at once (well inside the 600ms debounce): unmount the wizard.
    cleanup();
    const d = readDraft();
    expect(d.step).toBe(3);
    expect(d.lineItems).toHaveLength(1);
    expect(d.lineItems[0]).toMatchObject({ description: "Onsite workshop" });
    expect(Number(d.lineItems[0].quantity)).toBe(3);
  });

  it("after a successful Save the draft stays cleared when the wizard unmounts", async () => {
    renderWizard();
    await selectCustomer();
    await advanceToActionsStep();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockInvoiceCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readDraft()).toBeNull());
    cleanup();
    expect(readDraft()).toBeNull();
  });
});
