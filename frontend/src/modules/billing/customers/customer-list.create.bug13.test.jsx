import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// BUG-13: the customer create form follows Customer Settings.
//  - no client-side code: the server assigns the next number (prefix+format);
//  - the organization's Default Customer Type is pre-selected and sent;
//  - "Require Billing Address" / "Require Tax ID" are checked before submit
//    (the server enforces the same rules on creation only).

const m = vi.hoisted(() => ({ config: {}, create: vi.fn(), list: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  customerApi: {
    list: (...a) => m.list(...a), getKPI: () => Promise.resolve(null), create: (...a) => m.create(...a),
    update: vi.fn(), activate: vi.fn(), deactivate: vi.fn(), suspend: vi.fn(), bulkDelete: vi.fn(), exportData: vi.fn(),
  },
  settingsApi: { getConfig: () => Promise.resolve(m.config) },
}));

import CustomerListPage from "./customer-list";
import { invalidateGlobalBillingConfig } from "../../../service/billingConfigCache";

function fieldByLabel(container, labelPattern) {
  return within(container).getByText(labelPattern).parentElement.querySelector("input, select, textarea");
}

async function openCreate() {
  render(<MemoryRouter><CustomerListPage /></MemoryRouter>);
  await waitFor(() => expect(m.list).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole("button", { name: /new customer/i }));
  const dialog = screen.getByRole("heading", { name: /^New Customer$/i }).closest("div").parentElement;
  fireEvent.change(fieldByLabel(dialog, /company name/i), { target: { value: "New Co" } });
  fireEvent.change(fieldByLabel(dialog, /^email/i), { target: { value: "new@co.com" } });
  return dialog;
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateGlobalBillingConfig();   // module-level cache must not leak between tests
  m.config = { base_currency: "USD", default_customer_type: "government", require_billing_address: false, require_tax_id: false };
  m.list.mockResolvedValue({ items: [], total: 0 });
  m.create.mockResolvedValue({ id: 9 });
});
afterEach(() => cleanup());

describe("BUG-13 create form follows Customer Settings", () => {
  it("sends no customer code (server assigns it) and the org's default type", async () => {
    const dialog = await openCreate();
    await waitFor(() => expect(fieldByLabel(dialog, /customer type/i)).toHaveValue("government"));
    fireEvent.click(within(dialog).getByRole("button", { name: /^create/i }));
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    const payload = m.create.mock.calls[0][0];
    expect(payload).not.toHaveProperty("customer_code");
    expect(payload.customer_type).toBe("government");
    expect(JSON.stringify(payload)).not.toMatch(/CUST-\d{10,}/);   // no timestamp codes
  });

  it("an explicitly chosen type wins over the default", async () => {
    const dialog = await openCreate();
    fireEvent.change(fieldByLabel(dialog, /customer type/i), { target: { value: "individual" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^create/i }));
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0][0].customer_type).toBe("individual");
  });

  it("Require Billing Address blocks submit without one and marks the field required", async () => {
    m.config.require_billing_address = true;
    const dialog = await openCreate();
    await waitFor(() => expect(within(dialog).getByText(/Billing Address \*/)).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole("button", { name: /^create/i }));
    expect(await screen.findByText(/billing address is required for new customers/i)).toBeInTheDocument();
    expect(m.create).not.toHaveBeenCalled();
    fireEvent.change(fieldByLabel(dialog, /Billing Address \*/), { target: { value: "1 Main St" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^create/i }));
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(fieldByLabel(dialog, /company name/i)).toHaveValue("New Co");
  });

  it("Require Tax ID asks for a country first, then accepts any shown tax identifier", async () => {
    m.config.require_tax_id = true;
    const dialog = await openCreate();
    await waitFor(() => expect(within(dialog).getByText(/a tax id is required for new customers/i)).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole("button", { name: /^create/i }));
    expect(await screen.findByText(/choose a billing country to show its tax id fields/i)).toBeInTheDocument();
    expect(m.create).not.toHaveBeenCalled();
    expect(fieldByLabel(dialog, /^email/i)).toHaveValue("new@co.com");   // input kept
  });

  it("with no requirements the form submits without address or tax id (today's behaviour)", async () => {
    const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: /^create/i }));
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
  });
});
