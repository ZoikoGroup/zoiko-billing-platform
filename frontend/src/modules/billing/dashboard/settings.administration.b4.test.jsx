import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// B4-08: Billing Settings → Administration. "Load" on Exchange Rate
// Diagnostics crashed the whole app ("Render Error"), SMTP step results were
// read from the wrong fields, and template previews leaked their CSS.

const m = vi.hoisted(() => ({
  exchangeDiag: vi.fn(), testSmtp: vi.fn(), listTemplates: vi.fn(), preview: vi.fn(),
}));
vi.mock("../../../service/billingService", () => ({
  settingsApi: {
    getConfig: () => Promise.resolve({ company_name: "Acme" }), updateConfig: () => Promise.resolve({}),
    get: () => Promise.resolve({}), update: () => Promise.resolve({}),
    getExchangeRates: () => Promise.resolve(null), refreshExchangeRates: () => Promise.resolve(null),
    validateConfig: () => Promise.resolve({}), getHealth: () => Promise.resolve({}),
    listEmailTemplates: (...a) => m.listTemplates(...a), getNumberingDiagnostics: () => Promise.resolve([]),
    getTaxDiagnostics: () => Promise.resolve([]), getExchangeRateDiagnostics: (...a) => m.exchangeDiag(...a),
    testSmtp: (...a) => m.testSmtp(...a), previewEmailTemplate: (...a) => m.preview(...a), validateFull: () => Promise.resolve({}),
  },
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));
vi.mock("../utils/TerminologyContext", () => ({ useTerminology: () => ({ singular: "Customer", plural: "Customers" }) }));
if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollIntoView = HTMLElement.prototype.scrollIntoView || function noop() {};
  HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};
}

import BillingSettingsPage from "./settings";

const item = (field, value) => ({ field, value, valid: true, warnings: [] });

beforeEach(() => {
  vi.clearAllMocks();
  m.listTemplates.mockResolvedValue([{ name: "invoice_sent", size_bytes: 1024 }]);
});
afterEach(() => cleanup());

const openAdministration = async () => {
  render(<MemoryRouter><BillingSettingsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("tab", { name: /administration/i }));
};
const card = (title) => screen.getByText(title).closest(".rounded-3xl");

describe("B4-08 Administration tab", () => {
  it("Exchange Rate Diagnostics Load renders the diagnostic values instead of crashing", async () => {
    m.exchangeDiag.mockResolvedValue({
      provider: item("provider", "openexchangerates"),
      base_currency: item("base_currency", "INR"),
      last_refreshed: item("last_refreshed", "2026-10-01T00:00:00"),
      staleness_hours: 3, cached_rates_count: 0, cached_rates: {}, valid: true, rate_warnings: [], inactive_currencies: [],
    });
    await openAdministration();
    fireEvent.click(within(card("Exchange Rate Diagnostics")).getByRole("button", { name: /load/i }));
    expect(await screen.findByText("openexchangerates")).toBeInTheDocument();
    expect(screen.getByText("INR")).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });

  it("SMTP test shows each step's real result and message", async () => {
    m.testSmtp.mockResolvedValue({
      success: false, message: "SMTP host is not configured",
      connection: { ok: false, message: "Could not connect to the mail server" },
      tls: { ok: true, message: "TLS negotiated" },
      authentication: { ok: false, message: "Skipped" },
      test_email_sent: { ok: false, message: "Not sent" },
    });
    await openAdministration();
    const smtp = card("SMTP Test");
    fireEvent.change(within(smtp).getByPlaceholderText("test@example.com"), { target: { value: "qa@example.invalid" } });
    fireEvent.click(within(smtp).getByRole("button", { name: /send test email/i }));
    expect(await screen.findByText("Could not connect to the mail server")).toBeInTheDocument();
    expect(screen.getByText("TLS negotiated")).toBeInTheDocument();
    expect(screen.getByText("SMTP connection failed")).toBeInTheDocument();
  });

  it("template preview renders in a sandboxed iframe so template CSS can't restyle the app", async () => {
    m.preview.mockResolvedValue({
      template_name: "invoice_sent", subject: "Invoice INV-1 from Acme",
      html_content: "<html></html>", rendered_html: "<style>body{display:none}</style><p>Hello</p>",
      variables_found: [], variables_provided: [], variables_missing: [],
    });
    await openAdministration();
    fireEvent.click(await screen.findByRole("button", { name: /preview/i }));
    const frame = await screen.findByTitle("Preview of invoice_sent");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("<p>Hello</p>");
    expect([...document.querySelectorAll("style")].some((s) => s.textContent.includes("display:none"))).toBe(false);
  });
});
