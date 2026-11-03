import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { SettingsSaveBar } from "../../../components/billing-ui";

// Settings pages keep their Refresh / Save buttons in a bar pinned to the
// bottom, with whether anything is unsaved. Customer settings stands in for
// the module settings pages (same conversion); mocks as in
// settings.refresh.bug13.test.jsx.

const m = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("../../../service/billingService", () => ({ settingsApi: { get: (...a) => m.get(...a), update: (...a) => m.update(...a), getConfig: () => Promise.resolve({}) }, invalidateConfigCache: () => {} }));

import CustomerSettingsPage from "./settings";

beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockResolvedValue({ default_payment_terms: "net_15" });
  m.update.mockResolvedValue({});
});
afterEach(() => cleanup());

describe("Settings save bar", () => {
  it("customer settings: Save sits in the pinned bar and the status follows the form", async () => {
    render(<CustomerSettingsPage />);
    const terms = await screen.findByLabelText("Default payment terms");
    const save = screen.getByRole("button", { name: /Save Changes/ });
    const bar = save.closest("div.fixed");
    expect(bar).not.toBeNull();
    expect(screen.getByRole("button", { name: /refresh/i }).closest("div.fixed")).toBe(bar);
    expect(screen.getByText("No changes")).toBeInTheDocument();
    expect(save).toBeDisabled();

    fireEvent.change(terms, { target: { value: "net_60" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(save).toBeEnabled();

    fireEvent.click(save);
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("the page header is the shared one, with breadcrumbs", async () => {
    render(<CustomerSettingsPage />);
    await screen.findByLabelText("Default payment terms");
    expect(screen.getByRole("heading", { name: "Customer Settings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Customers" })).toHaveAttribute("href", "/billing/customers");
  });

  it("SettingsSaveBar: actions wrap rather than overflow; compactStatus hides the text on phones", () => {
    const { rerender } = render(
      <SettingsSaveBar hasChanges={false}><button type="button">Save Changes</button></SettingsSaveBar>
    );
    const actions = screen.getByRole("button", { name: "Save Changes" }).parentElement;
    expect(actions.className).toMatch(/\bflex-wrap\b/);
    expect(screen.getByRole("status")).not.toHaveClass("max-sm:hidden");
    rerender(<SettingsSaveBar hasChanges compactStatus><button type="button">Save Changes</button></SettingsSaveBar>);
    expect(screen.getByRole("status")).toHaveClass("max-sm:hidden");
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
  });
});
