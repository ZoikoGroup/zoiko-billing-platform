import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, cleanup, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// B10-A (/billing/settings → Administration → Email Templates): "some Preview
// buttons do not work / show unexpected content". The preview panel renders
// below the 24-template list (a click near the top looked like a no-op), a
// click on A then B could show A's preview under B's name, and invalid
// variables JSON was silently ignored.

const m = vi.hoisted(() => ({ listTemplates: vi.fn(), preview: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  settingsApi: {
    getConfig: () => Promise.resolve({ company_name: "Acme" }), updateConfig: () => Promise.resolve({}),
    get: () => Promise.resolve({}), update: () => Promise.resolve({}),
    getExchangeRates: () => Promise.resolve(null), refreshExchangeRates: () => Promise.resolve(null),
    validateConfig: () => Promise.resolve({}), getHealth: () => Promise.resolve({}),
    listEmailTemplates: (...a) => m.listTemplates(...a), getNumberingDiagnostics: () => Promise.resolve([]),
    getTaxDiagnostics: () => Promise.resolve([]), getExchangeRateDiagnostics: () => Promise.resolve({}),
    testSmtp: () => Promise.resolve({}), previewEmailTemplate: (...a) => m.preview(...a), validateFull: () => Promise.resolve({}),
  },
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));
vi.mock("../utils/TerminologyContext", () => ({ useTerminology: () => ({ singular: "Customer", plural: "Customers" }) }));
const scrolls = [];
if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() { scrolls.push(this.getAttribute("aria-label")); };
  HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};
}

import BillingSettingsPage from "./settings";

const preview = (name, html) => ({ template_name: name, subject: `Subject ${name}`, html_content: "<html></html>", rendered_html: html, variables_found: [], variables_provided: [], variables_missing: [] });

beforeEach(() => {
  vi.clearAllMocks(); scrolls.length = 0;
  m.listTemplates.mockResolvedValue([{ name: "invoice_sent" }, { name: "quote_sent" }]);
});
afterEach(() => cleanup());

const openAdmin = async () => {
  render(<MemoryRouter><BillingSettingsPage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("tab", { name: /administration/i }));
  await screen.findByText("invoice_sent");
};
const previewButtons = () => screen.getAllByRole("button", { name: /^preview$/i });

describe("B10-A template previews", () => {
  it("clicking Preview brings the preview panel into view", async () => {
    m.preview.mockResolvedValue(preview("invoice_sent", "<p>Invoice</p>"));
    await openAdmin();
    fireEvent.click(previewButtons()[0]);
    await screen.findByTitle("Preview of invoice_sent");
    await waitFor(() => expect(scrolls).toContain("Preview of invoice_sent template"));
  });

  it("A then B: only B's preview is shown, even if A's response arrives last", async () => {
    let releaseA;
    m.preview.mockImplementation((name) => (name === "invoice_sent"
      ? new Promise((r) => { releaseA = () => r(preview("invoice_sent", "<p>AAA</p>")); })
      : Promise.resolve(preview("quote_sent", "<p>BBB</p>"))));
    await openAdmin();
    fireEvent.click(previewButtons()[0]);
    fireEvent.click(previewButtons()[1]);
    const frame = await screen.findByTitle("Preview of quote_sent");
    releaseA();
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTitle("Preview of quote_sent").getAttribute("srcdoc")).toContain("BBB");
    expect(screen.queryByTitle("Preview of invoice_sent")).toBeNull();
    expect(frame).toBeTruthy();
  });

  it("invalid variables JSON is reported and nothing is requested", async () => {
    m.preview.mockResolvedValue(preview("invoice_sent", "<p>Invoice</p>"));
    await openAdmin();
    fireEvent.click(previewButtons()[0]);
    await screen.findByTitle("Preview of invoice_sent");
    m.preview.mockClear();
    fireEvent.change(screen.getByLabelText("Template Variables (JSON)"), { target: { value: "{not json" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText(/Template variables must be a JSON object/)).toBeInTheDocument();
    expect(m.preview).not.toHaveBeenCalled();
  });
});
