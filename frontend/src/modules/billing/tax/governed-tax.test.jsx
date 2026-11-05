import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// ZB-TAX-ARCH-001 Phase 3b (§11): the invoice editor's governed tax panel and
// Taxes -> Exceptions. Blocked, stale and NOT_DETERMINED states must read as
// text (icon + label), never colour alone.

const m = vi.hoisted(() => ({ summary: vi.fn(), exceptions: vi.fn(), requestQuote: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  governedTaxApi: {
    invoiceSummary: (...a) => m.summary(...a),
    exceptions: (...a) => m.exceptions(...a),
    requestQuote: (...a) => m.requestQuote(...a),
  },
}));

import GovernedTaxPanel from "./governed-tax-panel";
import TaxExceptionsPage from "./exceptions";
import { TaxStatusBadge, TAX_STATUS } from "./governed-tax-status";

const FRESH = {
  invoice_id: 11, governed: true, status: "DRAFT", tax_date: "2026-06-01", currency: "GBP",
  freshness: { status: "FRESH" }, engine_label: "Zoiko rule pack GB-VAT-DOMESTIC-SERVICES v1",
  totals: { subtotal: "100.00", discount_amount: "0.00", tax_amount: "20.00", total_amount: "120.00" },
  lines: [{
    line_number: 1, outcome: "STANDARD", legal_reason: "domestic standard-rated service",
    components: [{ component_code: "GB-VAT", label: "UK VAT", rate_percent: "20", tax_amount: "20.00",
      rate_source: "REGISTRY", rate_version_id: 4,
      source: { source_ref: "S11", source_title: "VAT rates on different goods and services", rate_version_id: 4 } }],
  }],
  warnings: [], blocking_reasons: [], can_issue: true,
};

const BLOCKED_NONE = {
  ...FRESH, freshness: { status: "NONE" }, engine_label: null, totals: null, lines: [], can_issue: false,
  blocking_reasons: [{ code: "NO_TAX_QUOTE", reason: "No tax quote yet: tax is NOT_DETERMINED until one is requested.",
    owner: "billing_admin", resolution: "Request a tax quote." }],
};

const STALE = {
  ...FRESH, freshness: { status: "STALE" }, can_issue: false,
  blocking_reasons: [{ code: "QUOTE_STALE", reason: "The invoice lines, prices, discounts, currency or tax date changed since the quote.",
    owner: "billing_admin", resolution: "The invoice or its tax facts changed: request a new tax quote." }],
};

const NOT_DETERMINED = {
  ...FRESH, freshness: { status: "REFUSED" }, engine_label: null, totals: null, lines: [], can_issue: false,
  blocking_reasons: [
    { code: "NOT_DETERMINED", reason: "Tax could not be determined: line 1: no activation for B2C_SERVICES is in effect",
      owner: "org_admin", resolution: "Check the entity's registrations and activations for this market." },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.requestQuote.mockResolvedValue({ status: "QUOTED" });
});
afterEach(() => cleanup());

const renderPanel = () => render(<GovernedTaxPanel invoiceId={11} currency="GBP" />);

describe("Governed tax panel", () => {
  it("shows net, tax per component, gross, tax date, treatment and source for a current quote", async () => {
    m.summary.mockResolvedValue(FRESH);
    renderPanel();
    expect(await screen.findByText("Tax quote current")).toBeInTheDocument();
    expect(screen.getByText(FRESH.engine_label)).toBeInTheDocument();
    const table = screen.getByRole("table", { name: /tax by line and component/i });
    expect(within(table).getByText("UK VAT")).toBeInTheDocument();
    expect(within(table).getByText("20%")).toBeInTheDocument();
    expect(within(table).getByText("Standard")).toBeInTheDocument();
    expect(within(table).getByText(/\[S11\] VAT rates on different goods and services · rate version 4/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /quote/i })).not.toBeInTheDocument();
  });

  it("blocked: no quote yet reads as text, names who resolves it and offers a quote", async () => {
    m.summary.mockResolvedValue(BLOCKED_NONE);
    renderPanel();
    expect(await screen.findByText("No tax quote")).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Issuing is blocked")).toBeInTheDocument();
    expect(within(alert).getByText(/Who resolves it: Billing admin/)).toBeInTheDocument();
    expect(screen.getByText("Not determined")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request tax quote" })).toBeInTheDocument();
  });

  it("stale: says so in words and re-quotes, then reloads", async () => {
    m.summary.mockResolvedValueOnce(STALE).mockResolvedValueOnce(FRESH);
    renderPanel();
    expect(await screen.findByText("Tax quote out of date")).toBeInTheDocument();
    expect(within(screen.getByRole("alert")).getByText(/changed since the quote/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Re-quote" }));
    await waitFor(() => expect(m.requestQuote).toHaveBeenCalledWith(11));
    expect(await screen.findByText("Tax quote current")).toBeInTheDocument();
    expect(m.summary).toHaveBeenCalledTimes(2);
  });

  it("NOT_DETERMINED: never shows a zero tax, shows the reason and the owner", async () => {
    m.summary.mockResolvedValue(NOT_DETERMINED);
    renderPanel();
    expect(await screen.findByText("Tax not determined")).toBeInTheDocument();
    expect(screen.getByText("Not determined")).toBeInTheDocument();
    expect(screen.queryByText(/£0\.00|0\.00/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("alert")).getByText(/Who resolves it: Organization admin/)).toBeInTheDocument();
  });

  it("renders nothing for a legacy (non-governed) invoice", async () => {
    m.summary.mockResolvedValue({ invoice_id: 11, governed: false });
    const { container } = renderPanel();
    await waitFor(() => expect(m.summary).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Tax status badge", () => {
  it.each(Object.keys(TAX_STATUS))("%s has a text label and a decorative icon", (status) => {
    render(<TaxStatusBadge status={status} />);
    const label = screen.getByText(TAX_STATUS[status].label);
    const badge = label.closest("[data-tax-status]");
    expect(badge.querySelector("svg").getAttribute("aria-hidden")).toBe("true");
    cleanup();
  });
});

describe("Taxes -> Exceptions", () => {
  const ITEM = {
    invoice_id: 21, invoice_number: "INV-21", tax_date: "2026-06-01", quote_id: 5, quote_status: "NEEDS_EVIDENCE",
    freshness: "REFUSED", code: "REQUIRED_FACTS_MISSING", reason: "Required tax facts are missing, expired or ambiguous.",
    missing: [{ code: "BUYER_COUNTRY_MISSING", message: "The buyer has no billing country.", owner: "billing_admin" }],
    owner: "billing_admin", resolution: "Complete the missing facts listed below.",
    requote: { method: "POST", path: "/api/v1/tax/quotes", body: { document_type: "invoice", document_id: 21 } },
  };

  it("lists blocked drafts with reason, missing facts and owner; re-quote calls the API and reloads", async () => {
    m.exceptions.mockResolvedValueOnce({ items: [ITEM] }).mockResolvedValueOnce({ items: [] });
    render(<MemoryRouter><TaxExceptionsPage /></MemoryRouter>);
    const link = await screen.findByRole("link", { name: "INV-21" });
    expect(link).toHaveAttribute("href", "/billing/invoices/21");
    const row = link.closest("tr");
    expect(within(row).getByText("Tax not determined")).toBeInTheDocument();
    expect(within(row).getByText(/The buyer has no billing country\. \(Billing admin\)/)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Re-quote INV-21" }));
    await waitFor(() => expect(m.requestQuote).toHaveBeenCalledWith(21));
    expect(await screen.findByText("No governed draft invoices are blocked.")).toBeInTheDocument();
  });

  it("shows an error instead of an empty list when loading fails", async () => {
    m.exceptions.mockRejectedValue(new Error("boom"));
    render(<MemoryRouter><TaxExceptionsPage /></MemoryRouter>);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.queryByText("No governed draft invoices are blocked.")).not.toBeInTheDocument();
  });
});
