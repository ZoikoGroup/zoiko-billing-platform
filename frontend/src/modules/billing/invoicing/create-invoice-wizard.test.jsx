import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter } from "../test/renderWithRouter";
import { axe } from "../../../test/a11y";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("../../../service/billingService", () => ({
  invoiceApi: {
    create: vi.fn(),
    bulkSetItems: vi.fn(() => Promise.resolve({})),
    get: vi.fn(),
  },
  customerApi: {
    search: vi.fn(() => Promise.resolve([])),
    get: vi.fn(),
  },
  productApi: {
    list: vi.fn(() => Promise.resolve({ items: [] })),
    get: vi.fn(),
    listCategories: vi.fn(() => Promise.resolve({ items: [] })),
  },
  settingsApi: {
    getConfig: vi.fn(() => Promise.resolve({ base_currency: "USD", default_payment_terms: "net_30", default_due_days: 30 })),
  },
  taxApi: {
    list: vi.fn(() => Promise.resolve({ items: [] })),
  },
  pricingApi: {
    resolvePrice: vi.fn(),
  },
}));

import CreateInvoiceWizard from "./create-invoice-wizard";
import { invoiceApi, customerApi } from "../../../service/billingService";

const CUSTOMER = {
  id: 42, display_name: "Acme Corp", company_name: "Acme Corp", status: "active",
  currency: "USD", payment_terms: "net_30", billing_address: "1 Main St", email: "billing@acme.com",
};

async function selectCustomer() {
  customerApi.search.mockResolvedValue([CUSTOMER]);
  customerApi.get.mockResolvedValue(CUSTOMER);
  const searchBox = screen.getByLabelText(/search customer/i);
  fireEvent.change(searchBox, { target: { value: "Acme" } });
  const option = await screen.findByRole("option", { name: /Acme Corp/i });
  fireEvent.click(option);
  await waitFor(() => expect(customerApi.get).toHaveBeenCalledWith(42));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  customerApi.search.mockResolvedValue([]);
});

afterEach(() => {
  localStorage.clear();
});

describe("CreateInvoiceWizard", () => {
  it("has no accessibility violations on step 1 (axe-core)", async () => {
    const { container } = renderWithRouter(<CreateInvoiceWizard />);
    expect(screen.getByText("Step 1 of 7")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("opens on step 1 (customer selection) with Next disabled by validation", async () => {
    renderWithRouter(<CreateInvoiceWizard />);
    expect(screen.getByText("Step 1 of 7")).toBeInTheDocument();
    expect(screen.getByLabelText(/search customer/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/please select a customer/i));
  });

  it("searches and selects a customer, populating billing details", async () => {
    renderWithRouter(<CreateInvoiceWizard />);
    await selectCustomer();
    expect(screen.getByDisplayValue("Acme Corp")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(screen.getByText("Step 2 of 7")).toBeInTheDocument());
  });

  it("blocks moving past Line Items with no items added", async () => {
    renderWithRouter(<CreateInvoiceWizard />);
    await selectCustomer();
    fireEvent.click(screen.getByRole("button", { name: /^next/i })); // -> step 2
    await waitFor(() => expect(screen.getByText("Step 2 of 7")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^next/i })); // -> step 3
    await waitFor(() => expect(screen.getByText("Step 3 of 7")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/add at least one line item/i));
  });

  it("adds a manual line item and computes the running total", async () => {
    renderWithRouter(<CreateInvoiceWizard />);
    await selectCustomer();
    fireEvent.click(screen.getByRole("button", { name: /^next/i })); // step 2
    await waitFor(() => expect(screen.getByText("Step 2 of 7")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^next/i })); // step 3
    await waitFor(() => expect(screen.getByText("Step 3 of 7")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /add line item/i }));
    fireEvent.change(screen.getByLabelText(/description for item 1/i), { target: { value: "Consulting" } });
    fireEvent.change(screen.getByLabelText(/quantity for item 1/i), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/unit price for item 1/i), { target: { value: "100" } });

    // total = qty * price with no tax/discount configured in this test
    const totalsPanel = screen.getByLabelText(/invoice running totals/i);
    const totalRow = within(totalsPanel).getByText("Total").closest("div");
    await waitFor(() => expect(within(totalRow).getByText(/\$?200\.00/)).toBeInTheDocument());
  });

  it("saves the invoice and navigates to the detail page on success", async () => {
    invoiceApi.create.mockResolvedValue({ id: 99, invoice_number: "INV-0099" });
    invoiceApi.get.mockResolvedValue({ id: 99, invoice_number: "INV-0099", status: "draft" });

    renderWithRouter(<CreateInvoiceWizard />);
    await selectCustomer();
    fireEvent.click(screen.getByRole("button", { name: /^next/i })); // step 2
    await waitFor(() => expect(screen.getByText("Step 2 of 7")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^next/i })); // step 3
    await waitFor(() => expect(screen.getByText("Step 3 of 7")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /add line item/i }));
    fireEvent.change(screen.getByLabelText(/description for item 1/i), { target: { value: "Consulting" } });
    fireEvent.change(screen.getByLabelText(/quantity for item 1/i), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/unit price for item 1/i), { target: { value: "500" } });

    // Jump through the remaining steps (4 Taxes/Discounts, 5 Review, 6 PDF Preview) — no
    // required fields on any of them per validateStep(), only step 1 and 3 validate.
    fireEvent.click(screen.getByRole("button", { name: /^next/i })); // step 4
    await waitFor(() => expect(screen.getByText("Step 4 of 7")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^next/i })); // step 5
    await waitFor(() => expect(screen.getByText("Step 5 of 7")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^next/i })); // step 6
    await waitFor(() => expect(screen.getByText("Step 6 of 7")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^next/i })); // step 7
    await waitFor(() => expect(screen.getByText("Step 7 of 7")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(invoiceApi.create).toHaveBeenCalledTimes(1));
    const payload = invoiceApi.create.mock.calls[0][0];
    expect(payload.customer_id).toBe(42);
    expect(invoiceApi.bulkSetItems).toHaveBeenCalledWith(99, expect.arrayContaining([
      expect.objectContaining({ description: "Consulting", quantity: 1, unit_price: 500 }),
    ]));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/billing/invoices/99", expect.anything()));
  });

  it("shows an error and does not navigate when saving fails", async () => {
    invoiceApi.create.mockRejectedValue({ message: "Duplicate invoice number" });

    renderWithRouter(<CreateInvoiceWizard />);
    await selectCustomer();
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(screen.getByText("Step 2 of 7")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(screen.getByText("Step 3 of 7")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /add line item/i }));
    fireEvent.change(screen.getByLabelText(/description for item 1/i), { target: { value: "Consulting" } });
    fireEvent.change(screen.getByLabelText(/quantity for item 1/i), { target: { value: "1" } });
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole("button", { name: /^next/i }));
      await waitFor(() => expect(screen.getByText(`Step ${i + 4} of 7`)).toBeInTheDocument());
    }

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText("Duplicate invoice number")).toBeInTheDocument());
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("shows the Subscription Limit Reached panel (not a raw error) when the invoice monthly limit is reached", async () => {
    // Shape produced by service/api.js's apiRequest for a
    // SUBSCRIPTION_LIMIT_REACHED response from POST /billing/invoices
    // (billing.invoice.monthly_limit, entity: "invoice").
    invoiceApi.create.mockRejectedValue(Object.assign(new Error("'billing.invoice.monthly_limit' limit (1000) exceeded."), {
      status: 403,
      code: "SUBSCRIPTION_LIMIT_REACHED",
      entity: "invoice",
      currentUsage: 1000,
      limit: 1000,
      remaining: 0,
      planName: "Professional",
    }));

    renderWithRouter(<CreateInvoiceWizard />);
    await selectCustomer();
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(screen.getByText("Step 2 of 7")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^next/i }));
    await waitFor(() => expect(screen.getByText("Step 3 of 7")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /add line item/i }));
    fireEvent.change(screen.getByLabelText(/description for item 1/i), { target: { value: "Consulting" } });
    fireEvent.change(screen.getByLabelText(/quantity for item 1/i), { target: { value: "1" } });
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole("button", { name: /^next/i }));
      await waitFor(() => expect(screen.getByText(`Step ${i + 4} of 7`)).toBeInTheDocument());
    }

    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(screen.getByText(/invoice limit reached/i)).toBeInTheDocument());
    expect(screen.queryByText(/billing\.invoice\.monthly_limit/)).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
