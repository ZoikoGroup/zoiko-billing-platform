import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Covers two Create Invoice defects:
//  A. A selected product showed 0.00 -- the picker read original_price (the
//     optional list price, "0.00" for most products and truthy as a string)
//     ahead of default_price, and line pricing picked an arbitrary plan.
//  B. The customer field showed nothing until a name was typed.

const mockInvoiceCreate = vi.fn();
const mockInvoiceBulkSetItems = vi.fn();
const mockInvoiceGet = vi.fn();
const mockInvoiceSendEmail = vi.fn();
const mockCustomerSearch = vi.fn();
const mockCustomerList = vi.fn();
const mockCustomerGet = vi.fn();
const mockProductList = vi.fn();
const mockProductGet = vi.fn();
const mockProductListCategories = vi.fn();
const mockSettingsGetConfig = vi.fn();
const mockSettingsGetExchangeRatePair = vi.fn();
const mockTaxList = vi.fn();
const mockPricingListByProduct = vi.fn();
const mockPricingResolvePrice = vi.fn();

vi.mock("../../../service/billingService", () => ({
  invoiceApi: {
    create: (...args) => mockInvoiceCreate(...args),
    bulkSetItems: (...args) => mockInvoiceBulkSetItems(...args),
    get: (...args) => mockInvoiceGet(...args),
    sendEmail: (...args) => mockInvoiceSendEmail(...args),
  },
  customerApi: {
    search: (...args) => mockCustomerSearch(...args),
    list: (...args) => mockCustomerList(...args),
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
    resolvePrice: (...args) => mockPricingResolvePrice(...args),
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

const ACME = { id: 1, display_name: "Acme Corp", company_name: "Acme Corp", email: "acme@example.com", phone: "+1 555 0100" };
const GLOBEX = { id: 2, display_name: "Globex", company_name: "Globex", email: "billing@globex.test", phone: "+1 555 0200" };
const FULL_CUSTOMERS = {
  1: { ...ACME, currency: "USD", payment_terms: "net_30", billing_address: "123 Main St", status: "active" },
  2: { ...GLOBEX, currency: "USD", payment_terms: "net_30", billing_address: "9 Elm Rd", status: "active" },
};

// Shapes match ProductResponse: money arrives as strings, and original_price
// is "0.00" on most real products.
const AUDIT = { id: 60, name: "Website Audit", code: "AUD", description: "Full website audit", currency: "USD", default_price: "1500.00", original_price: "0.00", tax_percentage: "0.00", default_discount: "0.00", product_type: "service" };
const HOSTING = { id: 61, name: "Hosting", code: "HST", description: "Managed hosting", currency: "USD", default_price: "250.00", original_price: "0.00", tax_percentage: "0.00", default_discount: "0.00", product_type: "service" };
const UNPRICED = { id: 62, name: "Custom Work", code: "CUS", description: "Custom work", currency: "USD", default_price: "0.00", original_price: "0.00", tax_percentage: "0.00", default_discount: "0.00", product_type: "service" };

const catalogResolution = (product) => ({
  product_id: product.id, product_name: product.name,
  base_price: product.default_price, resolved_price: product.default_price,
  pricing_plan_id: null, price_source: "catalog", currency: product.currency,
});

function renderWizard() {
  render(
    <MemoryRouter>
      <CreateInvoiceWizard onClose={vi.fn()} onCreated={vi.fn()} />
    </MemoryRouter>
  );
}

const customerInput = () => screen.findByLabelText(/search customer/i);
const clickNext = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));
const clickBack = () => fireEvent.click(screen.getByRole("button", { name: "Back" }));

async function selectCustomerFromList(name = /Acme Corp/i) {
  fireEvent.focus(await customerInput());
  fireEvent.click(await screen.findByRole("option", { name }));
  await screen.findByText("Billing Address");
}

async function goToLineItems() {
  await selectCustomerFromList();
  clickNext();
  await screen.findByLabelText(/invoice date/i);
  clickNext();
  await screen.findByPlaceholderText(/search products to add/i);
}

async function addProducts(term, names) {
  const input = screen.getByPlaceholderText(/search products to add/i);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: term } });
  for (const name of names) {
    fireEvent.click(await screen.findByRole("option", { name: new RegExp(name, "i") }, { timeout: 2000 }));
  }
  fireEvent.click(screen.getByRole("button", { name: /add selected/i }));
}

// ProductSelector refetches categories on re-render; flush the trailing
// fetch inside act() before leaving step 3.
async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
}

const runningTotals = () => screen.getByLabelText(/invoice running totals/i);

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();

  mockSettingsGetConfig.mockResolvedValue(ORG_SETTINGS);
  mockSettingsGetExchangeRatePair.mockResolvedValue({ rate: 1, source: "cached" });
  mockTaxList.mockResolvedValue([]);
  mockCustomerList.mockResolvedValue({ items: [ACME, GLOBEX], total: 2 });
  mockCustomerSearch.mockResolvedValue([ACME]);
  mockCustomerGet.mockImplementation((id) => Promise.resolve(FULL_CUSTOMERS[id]));
  mockProductList.mockResolvedValue({ items: [AUDIT, HOSTING, UNPRICED], total: 3 });
  mockProductListCategories.mockResolvedValue([]);
  mockPricingListByProduct.mockResolvedValue([]);
  mockPricingResolvePrice.mockImplementation(({ product_id }) => {
    const product = [AUDIT, HOSTING, UNPRICED].find((p) => p.id === product_id);
    return Promise.resolve(catalogResolution(product));
  });
  mockInvoiceCreate.mockResolvedValue({ id: 501, invoice_number: "INV-000501" });
  mockInvoiceBulkSetItems.mockResolvedValue({});
  mockInvoiceGet.mockResolvedValue({ id: 501, invoice_number: "INV-000501", status: "draft" });
  mockInvoiceSendEmail.mockResolvedValue({ email_delivered: true });
});

describe("Issue A — product line-item pricing", () => {
  it("the product picker shows the catalog price, not the 0.00 original_price", async () => {
    renderWizard();
    await goToLineItems();

    const input = screen.getByPlaceholderText(/search products to add/i);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Web" } });
    const option = await screen.findByRole("option", { name: /Website Audit/i }, { timeout: 2000 });
    expect(option).toHaveTextContent(/1,500\.00/);
    expect(option).not.toHaveTextContent(/\b0\.00/);
    await settle();
  });

  it("a selected product's line gets its resolved unit price and quantity drives the line amount", async () => {
    renderWizard();
    await goToLineItems();
    await addProducts("Web", ["Website Audit"]);

    const price = await screen.findByLabelText(/unit price for item 1/i);
    expect(Number(price.value)).toBe(1500);
    expect(mockPricingResolvePrice).toHaveBeenCalledWith({ product_id: 60, quantity: 1 });
    expect(screen.getByText(/Amount: .*1,500\.00/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/quantity for item 1/i), { target: { value: "3" } });
    expect(screen.getByText(/Amount: .*4,500\.00/)).toBeInTheDocument();
    expect(within(runningTotals()).getAllByText(/4,500\.00/).length).toBeGreaterThan(0);
    await settle();
  });

  it("applies the single flat plan in effect and ignores expired or inactive plans", async () => {
    mockPricingListByProduct.mockResolvedValue([
      { id: 9, plan_type: "flat", is_active: true, effective_from: "2000-01-01", effective_to: "2000-12-31", price: "10.00" },
      { id: 10, plan_type: "flat", is_active: false, effective_from: "2000-01-01", effective_to: null, price: "20.00" },
      { id: 11, plan_type: "flat", is_active: true, effective_from: "2000-01-01", effective_to: null, price: "1200.00" },
    ]);
    mockPricingResolvePrice.mockResolvedValue({
      product_id: 60, base_price: "1500.00", resolved_price: "1200.0000",
      pricing_plan_id: 11, price_source: "pricing_plan", currency: "USD",
    });
    renderWizard();
    await goToLineItems();
    await addProducts("Web", ["Website Audit"]);

    const price = await screen.findByLabelText(/unit price for item 1/i);
    expect(Number(price.value)).toBe(1200);
    expect(mockPricingResolvePrice).toHaveBeenCalledWith({ product_id: 60, pricing_plan_id: 11, quantity: 1 });
    await settle();
  });

  it("several products add up, and removing one updates the subtotal without touching the others", async () => {
    renderWizard();
    await goToLineItems();
    await addProducts("a", ["Website Audit", "Hosting"]);

    await screen.findByLabelText(/unit price for item 2/i);
    expect(within(runningTotals()).getAllByText(/1,750\.00/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /remove item 1/i }));
    expect(Number(screen.getByLabelText(/unit price for item 1/i).value)).toBe(250);
    expect(within(runningTotals()).getAllByText(/250\.00/).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(/unit price for item 2/i)).not.toBeInTheDocument();
    await settle();
  });

  it("keeps the unit price through Next and Back", async () => {
    renderWizard();
    await goToLineItems();
    await addProducts("Web", ["Website Audit"]);
    await screen.findByLabelText(/unit price for item 1/i);
    await settle();

    clickNext();
    await screen.findByLabelText(/global discount/i);
    clickBack();
    expect(Number((await screen.findByLabelText(/unit price for item 1/i)).value)).toBe(1500);
    await settle();
  });

  it("flags an unpriced product and blocks the step until a price is entered", async () => {
    renderWizard();
    await goToLineItems();
    await addProducts("Custom", ["Custom Work"]);

    await screen.findByText(/no price is configured for this product/i);
    await settle();
    clickNext();
    expect(await screen.findByRole("alert")).toHaveTextContent(/item #1 \(custom work\) has no configured price/i);
    expect(screen.getByLabelText(/unit price for item 1/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/unit price for item 1/i), { target: { value: "75" } });
    expect(screen.queryByText(/no price is configured for this product/i)).not.toBeInTheDocument();
    await settle();
    clickNext();
    await screen.findByLabelText(/global discount/i);
  });

  it("saves the resolved price in the line-item payload, and a manual edit as the saved price", async () => {
    renderWizard();
    await goToLineItems();
    await addProducts("a", ["Website Audit", "Hosting"]);
    await screen.findByLabelText(/unit price for item 2/i);
    // Hand-edit the second line; the backend prices from original_amount, so
    // the edit must land there too.
    fireEvent.change(screen.getByLabelText(/unit price for item 2/i), { target: { value: "300" } });
    await settle();

    clickNext(); // -> 4
    await screen.findByLabelText(/global discount/i);
    clickNext(); // -> 5
    await screen.findByText(/Line Items \(2\)/i);
    clickNext(); // -> 6
    clickNext(); // -> 7
    await screen.findByText(/Ready to Save/i);
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(mockInvoiceBulkSetItems).toHaveBeenCalledTimes(1));
    const [, items] = mockInvoiceBulkSetItems.mock.calls[0];
    expect(items[0]).toMatchObject({
      product_id: 60, quantity: 1, unit_price: 1500, original_amount: 1500,
      original_currency: "USD", exchange_rate: 1, price_source: "catalog", base_price: 1500, resolved_price: 1500,
    });
    expect(items[1]).toMatchObject({
      product_id: 61, unit_price: 300, original_amount: 300, converted_amount: 300, price_source: "negotiated",
    });
    expect(items[1].pricing_plan_id).toBeUndefined();
  });
});

describe("Issue B — customer options load automatically", () => {
  it("loads the organization's customers once and shows them on focus without typing", async () => {
    renderWizard();
    const input = await customerInput();
    await waitFor(() => expect(mockCustomerList).toHaveBeenCalledTimes(1));
    expect(mockCustomerList).toHaveBeenCalledWith({ per_page: 20, sort_by: "company_name", sort_order: "asc" });

    fireEvent.focus(input);
    expect(await screen.findByRole("option", { name: /Acme Corp/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Globex/i })).toHaveTextContent("billing@globex.test");
    expect(mockCustomerSearch).not.toHaveBeenCalled();

    // Close and reopen: served from the cached first page, no refetch.
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.focus(input);
    await screen.findByRole("option", { name: /Globex/i });
    expect(mockCustomerList).toHaveBeenCalledTimes(1);
  });

  it("selecting a listed customer fills in their details and survives wizard navigation", async () => {
    renderWizard();
    await selectCustomerFromList(/Globex/i);
    // Billing and shipping both default to the customer's billing address.
    expect(screen.getAllByDisplayValue("9 Elm Rd")).toHaveLength(2);
    expect(mockCustomerGet).toHaveBeenCalledWith(2);

    clickNext();
    await screen.findByLabelText(/invoice date/i);
    clickBack();
    expect(await customerInput()).toHaveValue("Globex");
    expect(screen.getAllByDisplayValue("9 Elm Rd")).toHaveLength(2);
  });

  it("typing searches server-side by name, email or phone", async () => {
    mockCustomerSearch.mockImplementation((term) => Promise.resolve(term.includes("globex") ? [GLOBEX] : []));
    renderWizard();
    const input = await customerInput();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "billing@globex" } });

    await waitFor(() => expect(mockCustomerSearch).toHaveBeenCalledWith("billing@globex"));
    const listbox = screen.getByRole("listbox");
    await waitFor(() => expect(within(listbox).getAllByRole("option")).toHaveLength(1));
    expect(within(listbox).getByRole("option", { name: /Globex/i })).toBeInTheDocument();
  });

  it("shows loading, empty and error states", async () => {
    let resolveList;
    mockCustomerList.mockReturnValue(new Promise((r) => { resolveList = r; }));
    renderWizard();
    const input = await customerInput();
    fireEvent.focus(input);
    expect(await screen.findByText(/loading customers/i)).toBeInTheDocument();
    await act(async () => { resolveList({ items: [], total: 0 }); });
    expect(await screen.findByText(/no customers found/i)).toBeInTheDocument();

    mockCustomerSearch.mockResolvedValue([]);
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(await screen.findByText(/no customers match "zzz"/i, {}, { timeout: 2000 })).toBeInTheDocument();

    mockCustomerSearch.mockRejectedValue(new Error("boom"));
    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(await screen.findByText(/could not search customers/i, {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it("offers a retry when the initial customer load fails", async () => {
    // Fails until the user retries (a failed load is also retried on focus).
    mockCustomerList.mockRejectedValue(new Error("network"));
    renderWizard();
    const input = await customerInput();
    fireEvent.focus(input);
    expect(await screen.findByText(/could not load customers/i)).toBeInTheDocument();
    const failedCalls = mockCustomerList.mock.calls.length;

    mockCustomerList.mockResolvedValue({ items: [ACME, GLOBEX], total: 2 });
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByRole("option", { name: /Acme Corp/i })).toBeInTheDocument();
    expect(mockCustomerList).toHaveBeenCalledTimes(failedCalls + 1);
  });

  it("ignores a stale search response that arrives after a newer one", async () => {
    let resolveStale;
    mockCustomerSearch.mockImplementation((term) => (
      term === "Ac" ? new Promise((r) => { resolveStale = r; }) : Promise.resolve([ACME])
    ));
    renderWizard();
    const input = await customerInput();
    fireEvent.focus(input);

    fireEvent.change(input, { target: { value: "Ac" } });
    await waitFor(() => expect(mockCustomerSearch).toHaveBeenCalledWith("Ac"));
    fireEvent.change(input, { target: { value: "Acme" } });
    await waitFor(() => expect(mockCustomerSearch).toHaveBeenCalledWith("Acme"));
    await screen.findByRole("option", { name: /Acme Corp/i });

    await act(async () => { resolveStale([{ id: 99, display_name: "Stale Co", company_name: "Stale Co" }]); });
    expect(screen.queryByRole("option", { name: /Stale Co/i })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Acme Corp/i })).toBeInTheDocument();
  });

  it("drops duplicate customer records and hints when more customers exist than the first page", async () => {
    mockCustomerList.mockResolvedValue({ items: [ACME, ACME, GLOBEX], total: 150 });
    renderWizard();
    fireEvent.focus(await customerInput());
    await screen.findByRole("option", { name: /Globex/i });
    expect(screen.getAllByRole("option", { name: /Acme Corp/i })).toHaveLength(1);
    expect(screen.getByText(/showing 2 of 150 customers/i)).toBeInTheDocument();
  });

  it("supports keyboard selection and clearing the selected customer", async () => {
    renderWizard();
    const input = await customerInput();
    fireEvent.focus(input);
    await screen.findByRole("option", { name: /Globex/i });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Billing Address");
    expect(input).toHaveValue("Globex");

    fireEvent.click(screen.getByRole("button", { name: /clear customer/i }));
    expect(input).toHaveValue("");
    expect(screen.queryByText("Billing Address")).not.toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /Acme Corp/i })).toBeInTheDocument();
  });
});
