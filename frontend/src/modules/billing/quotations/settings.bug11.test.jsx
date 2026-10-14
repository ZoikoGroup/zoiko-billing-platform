import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";

// BUG-11.7 (/billing/quotations/settings): the action row must wrap on narrow
// screens, and Refresh must not silently throw away unsaved edits.

const m = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("../../../service/billingService", () => ({ settingsApi: { get: (...a) => m.get(...a), update: (...a) => m.update(...a) } }));
vi.mock("../utils/TerminologyContext", () => ({ useTerminology: () => ({ singular: "Customer", plural: "Customers" }) }));

import QuotationSettingsPage from "./settings";

beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockResolvedValue({ quote_prefix: "QT-", default_currency: "INR", quote_terms_and_conditions: "Net 30", logo_url: "" });
  m.update.mockResolvedValue({});
});
afterEach(() => cleanup());

async function renderLoaded() {
  render(<QuotationSettingsPage />);
  const prefix = await screen.findByLabelText("Quote number prefix");
  expect(m.get).toHaveBeenCalledTimes(1);
  return prefix;
}

describe("BUG-11.7 Quotation Settings", () => {
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
    const prefix = await renderLoaded();
    fireEvent.change(prefix, { target: { value: "QUO-" } });
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    const dialog = screen.getByRole("dialog", { name: /discard unsaved changes/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Quote number prefix")).toHaveValue("QUO-");
    expect(m.get).toHaveBeenCalledTimes(1);
  });

  it("confirming the prompt refetches and resets the form to the saved values", async () => {
    const prefix = await renderLoaded();
    fireEvent.change(prefix, { target: { value: "QUO-" } });
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /discard & refresh/i }));
    await waitFor(() => expect(m.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("Quote number prefix")).toHaveValue("QT-");
    expect(screen.getByRole("button", { name: /save changes/i })).toBeDisabled();
  });
});
