import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

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

describe("CreateInvoiceWizard — happy path", () => {
  it("Save creates the invoice with the expected payload and line items, then navigates away", async () => {
    const { onClose, onCreated } = renderWizard();

    await selectCustomer();
    await advanceToActionsStep();

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(mockInvoiceCreate).toHaveBeenCalledTimes(1));

    // Payload shape from buildPayload().
    const payload = mockInvoiceCreate.mock.calls[0][0];
    expect(payload.customer_id).toBe(1);
    expect(payload.currency).toBe("USD");
    expect(payload.payment_terms).toBe("net_30");

    // Line items are persisted via bulkSetItems against the created invoice id.
    await waitFor(() => expect(mockInvoiceBulkSetItems).toHaveBeenCalledTimes(1));
    const [invoiceId, items] = mockInvoiceBulkSetItems.mock.calls[0];
    expect(invoiceId).toBe(501);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      description: "Consulting Services",
      quantity: 3,
      unit_price: 150,
    });

    // Save (not Save & Send) must never call sendEmail.
    expect(mockInvoiceSendEmail).not.toHaveBeenCalled();

    await waitFor(() => expect(mockInvoiceGet).toHaveBeenCalledWith(501));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Save & Send creates the invoice, persists items, and sends the email — in that order", async () => {
    renderWizard();

    await selectCustomer();
    await advanceToActionsStep();

    fireEvent.click(screen.getByRole("button", { name: /save & send/i }));

    await waitFor(() => expect(mockInvoiceSendEmail).toHaveBeenCalledTimes(1));

    expect(mockInvoiceCreate).toHaveBeenCalledTimes(1);
    expect(mockInvoiceBulkSetItems).toHaveBeenCalledTimes(1);
    expect(mockInvoiceSendEmail).toHaveBeenCalledWith(501);

    // sendEmail must run only after the invoice + items were actually saved.
    const createOrder = mockInvoiceCreate.mock.invocationCallOrder[0];
    const bulkOrder = mockInvoiceBulkSetItems.mock.invocationCallOrder[0];
    const sendOrder = mockInvoiceSendEmail.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(bulkOrder);
    expect(bulkOrder).toBeLessThan(sendOrder);
  });
});

describe("CreateInvoiceWizard — validation blocks the money-creating action", () => {
  it("does not advance past step 1 and never creates an invoice without a selected customer", async () => {
    renderWizard();
    await screen.findByLabelText(/search customer/i);

    clickNext();

    expect(await screen.findByRole("alert")).toHaveTextContent(/please select a customer/i);
    // Still on step 1 — the customer search field is still present.
    expect(screen.getByLabelText(/search customer/i)).toBeInTheDocument();
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  it("does not advance past step 3 and never creates an invoice for a line item missing a description", async () => {
    renderWizard();

    await selectCustomer();
    clickNext(); // -> step 2
    await screen.findByLabelText(/invoice date/i);
    clickNext(); // -> step 3

    // Add a line item but leave its description blank (quantity defaults to 1).
    await addLineItem({});

    clickNext();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /each line item needs a description and quantity > 0/i
    );
    // Still on step 3 — the line item description field is still present.
    expect(screen.getByLabelText(/description for item 1/i)).toBeInTheDocument();
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });

  it("blocks a zero-quantity line item even when a description is present", async () => {
    renderWizard();

    await selectCustomer();
    clickNext();
    await screen.findByLabelText(/invoice date/i);
    clickNext();

    await addLineItem({ description: "Consulting Services", quantity: "0", unitPrice: "150" });

    clickNext();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /each line item needs a description and quantity > 0/i
    );
    expect(mockInvoiceCreate).not.toHaveBeenCalled();
  });
});

describe("CreateInvoiceWizard — Stepper navigation cannot bypass validation", () => {
  it("the Stepper only allows jumping back to already-visited steps, not forward", async () => {
    renderWizard();
    await screen.findByLabelText(/search customer/i);

    // Before any customer is selected / step advanced, no stepper step is
    // clickable (Stepper only enables steps with idx < current).
    const actionsStepButton = screen.getByRole("button", { name: /actions/i });
    expect(actionsStepButton).toBeDisabled();
  });
});
