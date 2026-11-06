import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { axe } from "../../../test/a11y";
import { formatDisplayCurrency } from "../../../utils/billing-helpers";

// ZB-TAX-ARCH-001 Phase 5d PR 1: the governed credit-note screen (pilot step 3.4).

const m = vi.hoisted(() => ({
  user: { id: 2, role: "billing_admin" },
  summary: vi.fn(), creditable: vi.fn(), previewCredit: vi.fn(), createCredit: vi.fn(),
}));
vi.mock("../../../api/client", async (orig) => ({ ...(await orig()), getStoredUser: () => m.user }));
vi.mock("../../../service/billingService", () => ({
  governedTaxApi: {
    invoiceSummary: (...a) => m.summary(...a), exceptions: vi.fn(), requestQuote: vi.fn(),
    creditable: (...a) => m.creditable(...a), previewCredit: (...a) => m.previewCredit(...a),
    createCredit: (...a) => m.createCredit(...a),
  },
}));

import GovernedTaxPanel from "./governed-tax-panel";
import { fractionFor } from "./governed-credit-note";

const SENT = {
  invoice_id: 11, governed: true, status: "SENT", currency: "GBP", freshness: { status: "COMMITTED" },
  engine_label: "Zoiko rule pack GB-VAT-DOMESTIC-SERVICES v1",
  totals: { subtotal: "150.00", discount_amount: "0.00", tax_amount: "30.00", total_amount: "180.00" },
  lines: [], warnings: [], blocking_reasons: [], can_issue: false,
};
const LINES = [
  { invoice_item_id: 101, line_number: 1, description: "Consulting", quantity: "3", net: "100.00", tax_amount: "20.00",
    credited_fraction: "0", remaining_fraction: "1.0000000000", outcome: "STANDARD", legal_reason: "domestic standard-rated service",
    components: [{ component_code: "GB-VAT", label: "UK VAT", rate_percent: "20", tax_amount: "20.00" }] },
  { invoice_item_id: 102, line_number: 2, description: "Support", quantity: "1", net: "50.00", tax_amount: "10.00",
    credited_fraction: "0", remaining_fraction: "1.0000000000", outcome: "STANDARD", legal_reason: "domestic standard-rated service",
    components: [{ component_code: "GB-VAT", label: "UK VAT", rate_percent: "20", tax_amount: "10.00" }] },
];
const CREDITABLE = { invoice_id: 11, invoice_number: "INV-11", status: "SENT", currency: "GBP", provider_committed: false,
  lines: LINES, credit_notes: [] };
const PREVIEW_FULL = { invoice_id: 11, currency: "GBP", provider_committed: false, subtotal: "150.00", tax_amount: "30.00",
  total_amount: "180.00", lines: [
    { invoice_item_id: 101, line_number: 1, description: "Consulting", credited_net: "100.00", outcome: "STANDARD",
      legal_reason: "domestic standard-rated service", components: [{ component_code: "GB-VAT", label: "UK VAT", rate_percent: "20", credited_tax: "20.00" }] },
    { invoice_item_id: 102, line_number: 2, description: "Support", credited_net: "50.00", outcome: "STANDARD",
      legal_reason: "domestic standard-rated service", components: [{ component_code: "GB-VAT", label: "UK VAT", rate_percent: "20", credited_tax: "10.00" }] },
  ] };

const renderPanel = () => render(<MemoryRouter><GovernedTaxPanel invoiceId={11} currency="GBP" /></MemoryRouter>);
async function openModal() {
  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: "Create governed credit note" }));
  const dialog = await screen.findByRole("dialog", { name: /Create governed credit note/ });
  await within(dialog).findByText(/Full credit of everything not yet credited/);
  return dialog;
}

beforeEach(() => {
  m.user = { id: 2, role: "billing_admin" };
  Object.values(m).forEach((f) => typeof f === "function" && f.mockReset?.());
  m.summary.mockResolvedValue(SENT);
  m.creditable.mockResolvedValue(CREDITABLE);
});
afterEach(cleanup);

describe("who sees the button", () => {
  it("shows it on a sent, committed governed invoice for a billing admin", async () => {
    renderPanel();
    expect(await screen.findByRole("button", { name: "Create governed credit note" })).toBeInTheDocument();
  });

  it.each([["auditor"], ["finance_approver"]])("hides it from %s (the credit-note flow's permission)", async (role) => {
    m.user = { id: 9, role };
    renderPanel();
    await screen.findByText("Governed tax");
    expect(screen.queryByRole("button", { name: "Create governed credit note" })).not.toBeInTheDocument();
  });

  it("hides it on a draft", async () => {
    m.summary.mockResolvedValue({ ...SENT, status: "DRAFT", freshness: { status: "FRESH" } });
    renderPanel();
    await screen.findByText("Governed tax");
    expect(screen.queryByRole("button", { name: "Create governed credit note" })).not.toBeInTheDocument();
  });
});

describe("full credit", () => {
  it("previews from the snapshot to the cent, then confirms through the governed route", async () => {
    m.previewCredit.mockResolvedValue(PREVIEW_FULL);
    m.createCredit.mockResolvedValue({ credit_note_id: 5, credit_note_number: "CN-5", total_amount: "180.00", tax_amount: "30.00" });
    const dialog = await openModal();
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview credit" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Give a reason");          // reason required
    expect(m.previewCredit).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Order cancelled" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview credit" }));
    const full = [{ invoice_item_id: 101, fraction: "1.0000000000" }, { invoice_item_id: 102, fraction: "1.0000000000" }];
    await waitFor(() => expect(m.previewCredit).toHaveBeenCalledWith(11, { lines: full }));
    const gbp = (v) => formatDisplayCurrency(v, "GBP");
    expect(await within(dialog).findByText(gbp("180.00"))).toBeInTheDocument();                  // gross, exactly the server's
    expect(within(dialog).getByText(gbp("30.00"))).toBeInTheDocument();
    expect(within(dialog).getByText(`UK VAT 20%: ${gbp("20.00")}`)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/Standard · domestic standard-rated service/)).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm credit note" }));
    await waitFor(() => expect(m.createCredit).toHaveBeenCalledWith(11,
      { lines: full, reason: "Order cancelled", credit_note_type: "full_credit" }));
    expect(await within(dialog).findByText(/Credit note CN-5 created/)).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    m.previewCredit.mockResolvedValue(PREVIEW_FULL);
    const dialog = await openModal();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "x" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview credit" }));
    await within(dialog).findByText(/Preview: what will be reversed/);
    expect(await axe(document.body)).toHaveNoViolations();
  });
});

describe("partial credit", () => {
  it("credits chosen lines and quantities", async () => {
    m.previewCredit.mockResolvedValue({ ...PREVIEW_FULL, lines: [PREVIEW_FULL.lines[0]] });
    m.createCredit.mockResolvedValue({ credit_note_id: 6, credit_note_number: "CN-6", total_amount: "40.00", tax_amount: "6.67" });
    const dialog = await openModal();
    fireEvent.click(within(dialog).getByLabelText(/Partial: choose lines and quantities/));
    fireEvent.change(within(dialog).getByLabelText("Quantity to credit for line 1"), { target: { value: "1" } });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "One hour not delivered" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview credit" }));
    await waitFor(() => expect(m.previewCredit).toHaveBeenCalledWith(11, { lines: [{ invoice_item_id: 101, fraction: "0.3333333333" }] }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Confirm credit note" }));
    await waitFor(() => expect(m.createCredit.mock.calls[0][1].credit_note_type).toBe("partial_credit"));
  });

  it("uses the exact remaining fraction when a quantity completes the line", () => {
    const line = { quantity: "3", remaining_fraction: "0.6666666667" };
    expect(fractionFor(line, 2)).toBe("0.6666666667");
    expect(fractionFor(line, 1)).toBe("0.3333333333");
    expect(fractionFor(line, 0)).toBeNull();
    expect(fractionFor({ quantity: "2", remaining_fraction: "1.0000000000" }, 5)).toBe("1.0000000000");
  });
});

describe("provider-committed invoices", () => {
  it("shows the ADJUST progress and links a stuck one to the stuck-transactions screen", async () => {
    m.creditable
      .mockResolvedValueOnce({ ...CREDITABLE, provider_committed: true })
      .mockResolvedValue({ ...CREDITABLE, provider_committed: true,
        credit_notes: [{ id: 7, credit_note_number: "CN-7", total_amount: "180.00",
          adjust: { transaction_id: 70, state: "REVIEW_REQUIRED", last_error: "provider refused" } }] });
    m.previewCredit.mockResolvedValue({ ...PREVIEW_FULL, provider_committed: true });
    m.createCredit.mockResolvedValue({ credit_note_id: 7, credit_note_number: "CN-7", total_amount: "180.00", tax_amount: "30.00" });
    const dialog = await openModal();
    expect(within(dialog).getByText(/also adjusts the provider transaction/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "cancelled" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview credit" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Confirm credit note" }));
    expect(await within(dialog).findByText("Provider adjustment needs review")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Open stuck transactions" }))
      .toHaveAttribute("href", "/billing/tax/governance/transactions");
  });

  it("shows earlier credit notes' adjust state while it is in progress", async () => {
    m.creditable.mockResolvedValue({ ...CREDITABLE, provider_committed: true,
      credit_notes: [{ id: 3, credit_note_number: "CN-3", total_amount: "10.00", adjust: { transaction_id: 30, state: "PENDING" } }] });
    const dialog = await openModal();
    expect(within(dialog).getByText(/CN-3/)).toBeInTheDocument();
    expect(within(dialog).getByText("Adjusting at the provider…")).toBeInTheDocument();
  });
});
