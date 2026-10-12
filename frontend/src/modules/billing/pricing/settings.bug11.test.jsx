import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";

// BUG-11.2 (/billing/pricing/settings): the action row must wrap on narrow
// screens, and Refresh must not silently throw away unsaved edits.

const m = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  settingsApi: { get: (...a) => m.get(...a), update: (...a) => m.update(...a) },
}));

import PricingSettingsPage from "./settings";

beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockResolvedValue({
    default_currency: "USD",
    default_billing_frequency: "monthly",
    default_trial_days: 0,
    rounding_precision: 2,
    is_tax_inclusive_default: false,
    default_pricing_strategy: "flat",
    pricing_extra_settings: { rounding_rule: "none" },
  });
  m.update.mockResolvedValue({});
});
afterEach(() => cleanup());

async function renderLoaded() {
  render(<PricingSettingsPage />);
  const trial = await screen.findByLabelText("Default Trial Days");
  expect(m.get).toHaveBeenCalledTimes(1);
  return trial;
}

describe("BUG-11.2 Pricing Settings", () => {
  it("action row wraps instead of overflowing", async () => {
    await renderLoaded();
    const row = screen.getByRole("button", { name: /refresh/i }).parentElement;
    expect(row.className).toMatch(/\bflex-wrap\b/);
    expect(row.className).toMatch(/\bgap-2\b/);
    expect(row).toContainElement(screen.getByRole("button", { name: /save changes/i }));
  });

  it("Refresh with no edits refetches without prompting", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(m.get).toHaveBeenCalledTimes(2));
  });

  it("Refresh with edits asks first; Cancel keeps the edit and does not refetch", async () => {
    const trial = await renderLoaded();
    fireEvent.change(trial, { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    const dialog = screen.getByRole("dialog", { name: /discard unsaved changes/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Default Trial Days")).toHaveValue(14);
    expect(m.get).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /save changes/i })).toBeEnabled();
  });

  it("confirming the prompt refetches and resets the form to the saved values", async () => {
    const trial = await renderLoaded();
    fireEvent.change(trial, { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /discard & refresh/i }));
    await waitFor(() => expect(m.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("Default Trial Days")).toHaveValue(0);
    expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();
  });
});
