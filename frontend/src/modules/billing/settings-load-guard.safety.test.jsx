import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Pre-push safety fixes: Billing Configuration (dashboard settings) and
// Subscription Settings rendered an editable form of hard-coded defaults when
// their settings load failed, so Save could overwrite the organization's real
// configuration with those defaults. Same guard as the other settings pages:
// failure -> error + Try Again, no form, no Save.

const m = vi.hoisted(() => ({ getConfig: vi.fn(), updateConfig: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock("../../service/billingService", () => ({
  settingsApi: {
    getConfig: (...a) => m.getConfig(...a), updateConfig: (...a) => m.updateConfig(...a),
    get: (...a) => m.get(...a), update: (...a) => m.update(...a),
    getExchangeRates: () => Promise.resolve(null), refreshExchangeRates: () => Promise.resolve(null),
    validateConfig: () => Promise.resolve({}), getHealth: () => Promise.resolve({}),
    listEmailTemplates: () => Promise.resolve([]), getNumberingDiagnostics: () => Promise.resolve({}),
    getTaxDiagnostics: () => Promise.resolve({}), getExchangeRateDiagnostics: () => Promise.resolve({}),
    testSmtp: () => Promise.resolve({}), previewEmailTemplate: () => Promise.resolve({}), validateFull: () => Promise.resolve({}),
  },
}));
vi.mock("../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));
vi.mock("./utils/TerminologyContext", () => ({ useTerminology: () => ({ singular: "Customer", plural: "Customers" }) }));
if (typeof HTMLElement !== "undefined") {
  HTMLElement.prototype.scrollIntoView = HTMLElement.prototype.scrollIntoView || function noop() {};
  HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};
}

import BillingSettingsPage from "./dashboard/settings";
import SubscriptionSettingsPage from "./subscriptions/settings";

beforeEach(() => {
  vi.clearAllMocks();
  m.updateConfig.mockResolvedValue({});
  m.update.mockResolvedValue({});
});
afterEach(() => cleanup());

const saveButton = () => screen.queryByRole("button", { name: /save changes/i });

describe("Billing Configuration (dashboard settings) failed load", () => {
  const renderPage = () => render(<MemoryRouter><BillingSettingsPage /></MemoryRouter>);

  it("failure shows an error with Try Again and no editable form or Save", async () => {
    m.getConfig.mockRejectedValue(new Error("network down"));
    renderPage();
    expect(await screen.findByText("Couldn't load billing configuration")).toBeInTheDocument();
    expect(screen.getByText(/network down/)).toBeInTheDocument();
    expect(saveButton()).toBeNull();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(m.updateConfig).not.toHaveBeenCalled();
  });

  it("Try Again loads the real configuration and the form becomes available", async () => {
    m.getConfig.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({ company_name: "Acme Real Ltd" });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));
    expect(await screen.findByDisplayValue("Acme Real Ltd")).toBeInTheDocument();
    expect(saveButton()).not.toBeNull();
    expect(screen.queryByText("Couldn't load billing configuration")).toBeNull();
  });
});

describe("Subscription Settings failed load", () => {
  const renderPage = () => render(<MemoryRouter><SubscriptionSettingsPage /></MemoryRouter>);

  it("failure shows an error with Try Again and no editable form or Save", async () => {
    m.get.mockRejectedValue(new Error("offline"));
    renderPage();
    expect(await screen.findByText("Couldn't load subscription settings")).toBeInTheDocument();
    expect(saveButton()).toBeNull();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("success shows the persisted values; Try Again recovers from a failure", async () => {
    m.get.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ subscription_extra_settings: { default_subscription_prefix: "SUBX-" } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));
    expect(await screen.findByDisplayValue("SUBX-")).toBeInTheDocument();
    expect(saveButton()).not.toBeNull();
  });
});
