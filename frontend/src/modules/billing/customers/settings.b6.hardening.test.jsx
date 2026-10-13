import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// B6 (/billing/customers/settings): "Default Customer Type, Customer Numbering
// Prefix/Format, Require Billing Address and Require Tax ID are not showing
// options to select". B6 first made them honest read-only values (no backend
// storage). BUG-13 then added real storage (BillingConfiguration columns), so
// they are now working, saved controls -- see settings.bug13.test.jsx.

const m = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("../../../service/billingService", () => ({ settingsApi: { get: (...a) => m.get(...a), update: (...a) => m.update(...a), getConfig: () => Promise.resolve({}) }, invalidateConfigCache: () => {} }));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));

import CustomerSettingsPage from "./settings";

beforeEach(() => { vi.clearAllMocks(); m.update.mockResolvedValue({}); m.get.mockResolvedValue({ default_payment_terms: "net_15" }); });
afterEach(() => cleanup());

describe("B6 Customer Settings", () => {
  it("none of the five settings is a dead or read-only control any more", async () => {
    render(<CustomerSettingsPage />);
    await screen.findByLabelText("Default customer type");
    for (const label of ["Default customer type", "Customer numbering prefix", "Customer numbering format", "Require billing address", "Require tax ID"]) {
      const el = screen.getByLabelText(label);
      expect(["SELECT", "INPUT"]).toContain(el.tagName);
      expect(el).not.toBeDisabled();
    }
    expect(screen.queryByText("Not configurable yet")).toBeNull();
  });

  it("Require Billing Address / Tax ID are real selects that load, save and round-trip", async () => {
    m.get.mockResolvedValue({ default_payment_terms: "net_15", customer_extra_settings: { require_billing_address: true } });
    render(<CustomerSettingsPage />);
    const addr = await screen.findByLabelText("Require billing address");
    const tax = screen.getByLabelText("Require tax ID");
    expect(addr.tagName).toBe("SELECT");
    expect(addr).toHaveValue("yes");
    expect(tax).toHaveValue("no");
    fireEvent.change(tax, { target: { value: "yes" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    const payload = m.update.mock.calls[0][0];
    expect(payload.customer_extra_settings).toEqual({ require_billing_address: true, require_tax_id: true });
    expect(payload.require_billing_address).toBe(true);
    expect(payload.require_tax_id).toBe(true);
  });

  it("configurable settings still load and save", async () => {
    render(<CustomerSettingsPage />);
    const terms = await screen.findByLabelText("Default payment terms");
    expect(terms).toHaveValue("net_15");
    fireEvent.change(terms, { target: { value: "net_60" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    const payload = m.update.mock.calls[0][0];
    expect(payload.default_payment_terms).toBe("net_60");
    expect(payload.default_customer_type).toBe("business");
    expect(payload.customer_numbering_prefix).toBe("CUST-");
    expect(payload.customer_numbering_format).toBe("PREFIX-{SEQ}");
  });

  it("a failed load shows an error with Retry and no editable form", async () => {
    m.get.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({ default_payment_terms: "net_30" });
    render(<CustomerSettingsPage />);
    const retry = await screen.findByRole("button", { name: /try again|retry/i });
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByLabelText("Default payment terms")).toHaveValue("net_30");
  });
});
