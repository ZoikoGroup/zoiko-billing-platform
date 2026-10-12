import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";

// BUG-13 (/billing/customers/settings): Default Customer Type, Customer
// Numbering Prefix/Format, Require Billing Address and Require Tax ID showed no
// options / could not be typed into. They are now real controls backed by
// BillingConfiguration columns (see backend tests/test_customer_settings_bug13.py):
// values load from the organization's settings, save as canonical enum/boolean
// values, and a save refreshes every cached config reader.

const m = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), invalidate: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  settingsApi: { get: (...a) => m.get(...a), update: (...a) => m.update(...a), getConfig: () => Promise.resolve({}) },
  invalidateConfigCache: () => m.invalidate(),
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));

import CustomerSettingsPage, { CUSTOMER_TYPE_OPTIONS, NUMBER_FORMAT_OPTIONS, prefixError } from "./settings";

const SAVED = {
  default_payment_terms: "net_30",
  default_customer_type: "government",
  customer_numbering_prefix: "GOV-",
  customer_numbering_format: "PREFIX-{YYYY}-{SEQ}",
  require_billing_address: true,
  require_tax_id: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockResolvedValue(SAVED);
  m.update.mockResolvedValue({});
});
afterEach(() => cleanup());

const saveButton = () => screen.getByRole("button", { name: /save changes/i });

describe("BUG-13 Customer Settings controls", () => {
  it("loads each setting from the organization's saved values (not invented defaults)", async () => {
    render(<CustomerSettingsPage />);
    expect(await screen.findByLabelText("Default customer type")).toHaveValue("government");
    expect(screen.getByLabelText("Customer numbering prefix")).toHaveValue("GOV-");
    expect(screen.getByLabelText("Customer numbering format")).toHaveValue("PREFIX-{YYYY}-{SEQ}");
    expect(screen.getByLabelText("Require billing address")).toHaveValue("yes");
    expect(screen.getByLabelText("Require tax ID")).toHaveValue("no");
    expect(saveButton()).toBeDisabled();   // nothing changed yet
  });

  it("offers exactly the four supported customer types and five supported formats", async () => {
    render(<CustomerSettingsPage />);
    const type = await screen.findByLabelText("Default customer type");
    expect(within(type).getAllByRole("option").map((o) => o.value)).toEqual(["business", "individual", "non_profit", "government"]);
    expect(CUSTOMER_TYPE_OPTIONS.map((o) => o.label)).toEqual(["Business", "Individual", "Non-Profit", "Government"]);
    const fmt = screen.getByLabelText("Customer numbering format");
    expect(within(fmt).getAllByRole("option").map((o) => o.value)).toEqual(NUMBER_FORMAT_OPTIONS.map((o) => o.value));
  });

  it("accepts typing in the prefix, shows a live example, and saves canonical values", async () => {
    render(<CustomerSettingsPage />);
    const prefix = await screen.findByLabelText("Customer numbering prefix");
    fireEvent.change(prefix, { target: { value: "C-" } });
    fireEvent.change(screen.getByLabelText("Customer numbering format"), { target: { value: "PREFIX-{SEQ}" } });
    fireEvent.change(screen.getByLabelText("Default customer type"), { target: { value: "individual" } });
    fireEvent.change(screen.getByLabelText("Require tax ID"), { target: { value: "yes" } });
    expect(prefix).toHaveValue("C-");
    expect(screen.getByText("C-00001")).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    expect(m.update.mock.calls[0][0]).toMatchObject({
      default_customer_type: "individual", customer_numbering_prefix: "C-", customer_numbering_format: "PREFIX-{SEQ}",
      require_billing_address: true, require_tax_id: true,
    });
    expect(m.invalidate).toHaveBeenCalled();     // the create form sees the new values
    await waitFor(() => expect(saveButton()).toBeDisabled());
  });

  it("an invalid prefix shows a field-specific error and blocks Save without losing other edits", async () => {
    render(<CustomerSettingsPage />);
    const prefix = await screen.findByLabelText("Customer numbering prefix");
    fireEvent.change(screen.getByLabelText("Default customer type"), { target: { value: "business" } });
    fireEvent.change(prefix, { target: { value: "bad prefix" } });
    expect(prefix).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(/letters, numbers, hyphens and underscores/);
    expect(saveButton()).toBeDisabled();
    expect(screen.getByLabelText("Default customer type")).toHaveValue("business");
    fireEvent.change(prefix, { target: { value: "OK-" } });
    expect(saveButton()).toBeEnabled();
  });

  it("prefix rules match the server (optional, <= 10, letters/digits/-/_)", () => {
    expect(prefixError("")).toBeNull();
    expect(prefixError("CUST-")).toBeNull();
    expect(prefixError("A_B-9")).toBeNull();
    expect(prefixError("ELEVENCHARS")).toMatch(/10 characters/);
    expect(prefixError("x/y")).toMatch(/letters/);
  });

  it("a failed save keeps the edits and shows the server's message", async () => {
    m.update.mockRejectedValueOnce(Object.assign(new Error("Validation failed: customer_numbering_prefix: Customer number prefix must be 10 characters or less"), { status: 400 }));
    render(<CustomerSettingsPage />);
    fireEvent.change(await screen.findByLabelText("Customer numbering prefix"), { target: { value: "ABC-" } });
    fireEvent.click(saveButton());
    expect(await screen.findByText(/Customer number prefix must be 10 characters or less/)).toBeInTheDocument();
    expect(screen.getByLabelText("Customer numbering prefix")).toHaveValue("ABC-");
  });

  it("a failed load shows Retry and no editable controls or Save", async () => {
    m.get.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(SAVED);
    render(<CustomerSettingsPage />);
    expect(await screen.findByText("Couldn't load customer settings")).toBeInTheDocument();
    expect(screen.queryByLabelText("Default customer type")).toBeNull();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(await screen.findByLabelText("Default customer type")).toHaveValue("government");
  });
});
