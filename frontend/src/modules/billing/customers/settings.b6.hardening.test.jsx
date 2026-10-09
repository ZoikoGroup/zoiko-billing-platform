import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// B6 (/billing/customers/settings): "Default Customer Type, Customer Numbering
// Prefix/Format, Require Billing Address and Require Tax ID are not showing
// options to select". None of these five has backend storage (no field in the
// settings schema), so they cannot be saved; making them configurable is a
// product decision. They were rendered as DISABLED dropdowns/inputs that look
// openable but are not. They are now plain read-only values marked
// "Not configurable yet", showing what the system actually does.

const m = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("../../../service/billingService", () => ({ settingsApi: { get: (...a) => m.get(...a), update: (...a) => m.update(...a) } }));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));

import CustomerSettingsPage from "./settings";

const READ_ONLY = {
  "Default customer type": "Business",
  "Customer numbering prefix": "CUST-",
  "Customer numbering format": "CUST- + timestamp",
  "Require billing address": "Optional",
  "Require tax ID": "Optional",
};

beforeEach(() => { vi.clearAllMocks(); m.update.mockResolvedValue({}); m.get.mockResolvedValue({ default_payment_terms: "net_15" }); });
afterEach(() => cleanup());

describe("B6 Customer Settings", () => {
  it("the five unconfigurable settings are read-only values, not dead dropdowns", async () => {
    render(<CustomerSettingsPage />);
    await screen.findByLabelText("Default customer type");
    for (const [label, value] of Object.entries(READ_ONLY)) {
      const el = screen.getByLabelText(label);
      expect(el.tagName).toBe("OUTPUT");
      expect(el).toHaveTextContent(value);
    }
    expect(screen.queryAllByRole("combobox").map((c) => c.getAttribute("aria-label")))
      .not.toEqual(expect.arrayContaining(["Default customer type", "Require billing address", "Require tax ID"]));
    expect(screen.getAllByText("Not configurable yet")).toHaveLength(5);
  });

  it("configurable settings still load and save; read-only ones are never sent", async () => {
    render(<CustomerSettingsPage />);
    const terms = await screen.findByLabelText("Default payment terms");
    expect(terms).toHaveValue("net_15");
    fireEvent.change(terms, { target: { value: "net_60" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    const payload = m.update.mock.calls[0][0];
    expect(payload.default_payment_terms).toBe("net_60");
    for (const k of ["default_customer_type", "customer_numbering_prefix", "customer_numbering_format", "require_billing_address", "require_tax_id"]) {
      expect(payload).not.toHaveProperty(k);
    }
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
