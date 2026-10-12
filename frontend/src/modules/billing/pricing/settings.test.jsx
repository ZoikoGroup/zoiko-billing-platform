import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

// Regression coverage for QA Bug 14 (/billing/pricing/settings): "from Default
// Trial Days to Rounding Rule if select anything it automatically [jumps] up
// to the starting [point]". A prior fix hoisted `SettingsField` (the wrapper
// card around each field) to module scope -- it used to be declared inside
// the page component's render body, which gave React a new component type
// on every render and forced it to unmount+remount every field's real
// <input>/<select> DOM node on each keystroke/selection (losing focus and
// looking like the page "snapped back to the start"). This test drives every
// field between Default Trial Days and Rounding Rule exactly as a user would
// and asserts each keeps focus and accumulates value across repeated
// interactions instead of resetting/remounting.

const mockSettingsGet = vi.fn();
const mockSettingsUpdate = vi.fn();

vi.mock("../../../service/billingService", () => ({
  settingsApi: {
    get: (...args) => mockSettingsGet(...args),
    update: (...args) => mockSettingsUpdate(...args),
  },
}));

import PricingSettingsPage from "./settings";

beforeEach(() => {
  vi.clearAllMocks();
  mockSettingsGet.mockResolvedValue({
    default_currency: "USD",
    default_billing_frequency: "monthly",
    default_trial_days: 0,
    rounding_precision: 2,
    is_tax_inclusive_default: false,
    default_pricing_strategy: "flat",
    pricing_extra_settings: { rounding_rule: "none" },
  });
});

describe("PricingSettingsPage - field remount regression (Bug 14)", () => {
  it("keeps focus and accumulates typed value in Default Trial Days across keystrokes", async () => {
    render(<PricingSettingsPage />);
    const trialDaysInput = await screen.findByDisplayValue("0");
    trialDaysInput.focus();
    expect(document.activeElement).toBe(trialDaysInput);

    // Type digit-by-digit, the way a real user would, re-rendering the page
    // (and every SettingsField) after each keystroke.
    fireEvent.change(trialDaysInput, { target: { value: "2" } });
    expect(document.activeElement).toBe(trialDaysInput);
    fireEvent.change(trialDaysInput, { target: { value: "21" } });
    expect(document.activeElement).toBe(trialDaysInput);

    expect(trialDaysInput).toHaveValue(21);
  });

  it("keeps focus while editing Price Precision (the field immediately after Trial Days)", async () => {
    render(<PricingSettingsPage />);
    await screen.findByText("Default Trial Days");
    const precisionInput = screen.getByDisplayValue("2");
    precisionInput.focus();
    fireEvent.change(precisionInput, { target: { value: "4" } });
    expect(document.activeElement).toBe(precisionInput);
    expect(precisionInput).toHaveValue(4);
  });

  it("does not lose the selected value when changing Tax Inclusive Pricing and Default Pricing Strategy selects", async () => {
    render(<PricingSettingsPage />);
    await screen.findByText("Tax Inclusive Pricing");

    const taxSelect = screen.getByDisplayValue("No (tax added at checkout)");
    fireEvent.change(taxSelect, { target: { value: "yes" } });
    expect(taxSelect).toHaveValue("yes");

    const strategySelect = screen.getByDisplayValue("Flat");
    fireEvent.change(strategySelect, { target: { value: "graduated" } });
    expect(strategySelect).toHaveValue("graduated");

    // Both selections must persist simultaneously -- if SettingsField (or an
    // internal select) remounted on the second change, the first selection
    // would revert to its initial value.
    expect(taxSelect).toHaveValue("yes");
  });

  it("keeps focus and value when selecting the Rounding Rule dropdown (last field in the affected range)", async () => {
    render(<PricingSettingsPage />);
    const roundingSelect = await screen.findByDisplayValue("No Rounding");
    roundingSelect.focus();
    expect(document.activeElement).toBe(roundingSelect);

    fireEvent.change(roundingSelect, { target: { value: "nearest_0.10" } });
    expect(document.activeElement).toBe(roundingSelect);
    expect(roundingSelect).toHaveValue("nearest_0.10");
  });
});
