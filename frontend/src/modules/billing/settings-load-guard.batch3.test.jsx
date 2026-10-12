import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Batch 3 data-safety finding (pages reported only as "Fix the UI"):
// Contracts, Payments, Products, Quotations, Pricing settings and Tax
// Configuration rendered an EDITABLE form of hard-coded defaults when the
// saved configuration failed to load, with Save enabled -- saving would have
// written those defaults over the organization's real settings (Tax
// Configuration showed no error at all and rebuilt jurisdictions from tax
// rates). Same defect Batch 1 fixed on invoicing/settings.jsx and
// tax/settings.jsx. Each page must now show an error with Retry instead.

const m = vi.hoisted(() => ({ get: vi.fn(), getConfig: vi.fn() }));

vi.mock("../../service/billingService", () => ({
  settingsApi: {
    get: (...a) => m.get(...a), update: vi.fn(),
    getConfig: (...a) => m.getConfig(...a), updateConfig: vi.fn(),
  },
  productApi: { listCategories: () => Promise.resolve([]), listUsageBillable: () => Promise.resolve([]) },
  taxApi: { list: () => Promise.resolve({ items: [] }), update: vi.fn() },
}));
vi.mock("../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));

import ContractSettings from "./contracts/settings";
import PaymentSettings from "./payments/settings";
import ProductSettings from "./products/settings";
import QuotationSettings from "./quotations/settings";
import PricingSettings from "./pricing/settings";
import TaxConfiguration from "./tax/tax-configuration";

const PAGES = [
  ["Contract Settings", ContractSettings, "Couldn't load contract settings"],
  ["Payment Settings", PaymentSettings, "Couldn't load payment settings"],
  ["Product Settings", ProductSettings, "Couldn't load product settings"],
  ["Quotation Settings", QuotationSettings, "Couldn't load quotation settings"],
  ["Pricing Settings", PricingSettings, "Couldn't load pricing settings"],
  ["Tax Configuration", TaxConfiguration, "Couldn't load tax configuration"],
];

const renderPage = (Page) => render(<MemoryRouter><Page /></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());

describe("Settings pages never offer a form of defaults after a failed load", () => {
  it.each(PAGES)("%s: shows an error with Retry and no Save", async (_name, Page, errorTitle) => {
    m.get.mockRejectedValue(new Error("Network down"));
    m.getConfig.mockRejectedValue(new Error("Network down"));
    renderPage(Page);
    expect(await screen.findByText(errorTitle)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^save/i })).not.toBeInTheDocument();
  });

  it.each(PAGES)("%s: still renders the form when settings load", async (_name, Page, errorTitle) => {
    m.get.mockResolvedValue({ default_currency: "USD", tax_profiles: [] });
    m.getConfig.mockResolvedValue({});
    renderPage(Page);
    expect(await screen.findByRole("button", { name: /^save/i })).toBeInTheDocument();
    expect(screen.queryByText(errorTitle)).not.toBeInTheDocument();
  });
});
