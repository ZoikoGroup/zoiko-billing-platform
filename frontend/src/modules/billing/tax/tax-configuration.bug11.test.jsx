import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// BUG-11.13 (/billing/tax/configuration): header must wrap/stack on mobile,
// Save must only be enabled when the configuration actually changed, and long
// names/descriptions must truncate (full text in a title) instead of
// overflowing their rows.

const m = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  taxApi: { list: (...a) => m.list(...a) },
  settingsApi: { get: (...a) => m.get(...a), update: (...a) => m.update(...a) },
}));

import TaxConfigurationPage from "./tax-configuration";

const LONG_NAME = "Very Long Jurisdiction Name ".repeat(8).trim();
const LONG_DESC = "An exceptionally long exemption description ".repeat(8).trim();

beforeEach(() => {
  vi.clearAllMocks();
  m.list.mockResolvedValue({ items: [{ id: 1, name: "GST", rate: 18, jurisdiction: "IN" }] });
  m.get.mockResolvedValue({
    tax_profiles: [
      { type: "jurisdictions", data: [{ id: "j1", name: LONG_NAME, type: "country", tax_rule: "standard" }] },
      { type: "exemptions", data: [{ id: "e1", name: "Charity", description: LONG_DESC, tax_rate_id: "", jurisdiction: "" }] },
    ],
  });
  m.update.mockResolvedValue({});
});
afterEach(() => cleanup());

const saveButton = () => screen.getByRole("button", { name: /save changes/i });

describe("BUG-11.13 Tax Configuration", () => {
  it("Save is disabled until something changes, and disabled again after reverting", async () => {
    render(<TaxConfigurationPage />);
    await screen.findByText("Tax Jurisdictions");
    expect(saveButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Jurisdiction name"), { target: { value: "UK" } });
    fireEvent.click(screen.getAllByRole("button", { name: /^add$/i })[0]);
    expect(saveButton()).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Remove jurisdiction UK" }));
    expect(saveButton()).toBeDisabled();
  });

  it("jurisdictions derived from tax rates (nothing saved yet) are unsaved, so Save is available", async () => {
    m.get.mockResolvedValue({ tax_profiles: [] });
    render(<TaxConfigurationPage />);
    await screen.findByText("Tax Jurisdictions");
    expect(await screen.findByText("IN")).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    expect(m.update.mock.calls[0][0].tax_profiles[0]).toEqual(
      { type: "jurisdictions", data: [expect.objectContaining({ id: "IN", name: "IN" })] },
    );
    await waitFor(() => expect(saveButton()).toBeDisabled());
  });

  it("after a successful save the snapshot updates and Save is disabled again", async () => {
    render(<TaxConfigurationPage />);
    await screen.findByText("Tax Jurisdictions");
    fireEvent.click(screen.getByRole("button", { name: "Remove exemption" }));
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    expect(m.update.mock.calls[0][0].tax_profiles).toEqual([
      { type: "jurisdictions", data: [expect.objectContaining({ id: "j1" })] },
      { type: "exemptions", data: [] },
    ]);
    await waitFor(() => expect(saveButton()).toBeDisabled());
  });

  it("a failed load shows Retry and no Save", async () => {
    m.get.mockRejectedValueOnce(new Error("Network down"));
    render(<TaxConfigurationPage />);
    expect(await screen.findByText("Couldn't load tax configuration")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
  });

  it("header stacks on mobile and the action group wraps", async () => {
    render(<TaxConfigurationPage />);
    await screen.findByText("Tax Jurisdictions");
    const actions = screen.getByRole("button", { name: /refresh/i }).parentElement;
    expect(actions.className).toMatch(/\bflex-wrap\b/);
    const header = actions.parentElement;
    expect(header.className).toMatch(/\bflex-col\b/);
    expect(header.className).toMatch(/\blg:flex-row\b/);
    expect(header.className).toMatch(/\bgap-4\b/);
  });

  it("long jurisdiction and exemption text truncates with the full text in a title", async () => {
    render(<TaxConfigurationPage />);
    const name = await screen.findByText(LONG_NAME);
    expect(name.className).toMatch(/\btruncate\b/);
    expect(name.className).toMatch(/\bmin-w-0\b/);
    expect(name).toHaveAttribute("title", LONG_NAME);
    expect(name.parentElement.className).toMatch(/\bmin-w-0\b/);

    const desc = screen.getByText(LONG_DESC);
    expect(desc.className).toMatch(/\btruncate\b/);
    expect(desc).toHaveAttribute("title", LONG_DESC);
    expect(desc.parentElement.className).toMatch(/\bmin-w-0\b/);
  });
});
