import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// BUG-11.6 (/billing/products/settings): the fixed Save bar sat under the
// shell's fixed AI-assistant launcher (bottom-6 right-6, z-40, later in the
// DOM) and its right-0 ignored the open assistant panel.

const m = vi.hoisted(() => ({ getConfig: vi.fn(), updateConfig: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  settingsApi: { getConfig: (...a) => m.getConfig(...a), updateConfig: (...a) => m.updateConfig(...a) },
  productApi: { listCategories: () => Promise.resolve([]), listUsageBillable: () => Promise.resolve([]) },
}));
vi.mock("../../../service/billingConfigCache", () => ({
  invalidateGlobalBillingConfig: vi.fn(),
  subscribeBillingConfigInvalidation: vi.fn(),
}));

import ProductSettingsPage from "./settings";

beforeEach(() => {
  vi.clearAllMocks();
  m.getConfig.mockResolvedValue({ product_numbering_prefix: "PROD-" });
  m.updateConfig.mockResolvedValue({});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderPage = (wrap = (c) => c) => render(<MemoryRouter>{wrap(<ProductSettingsPage />)}</MemoryRouter>);

describe("BUG-11.6 Product Settings save bar", () => {
  it("reserves right-side space for the assistant launcher and keeps page content clear of the bar", async () => {
    renderPage();
    const bar = await screen.findByTestId("product-settings-save-bar");
    // Launcher occupies 24-80px from the right edge; pr-24 (96px) keeps the
    // actions out of that region.
    expect(bar.className).toMatch(/\bpr-24\b/);
    expect(bar.className).toMatch(/\bfixed\b/);
    // The form content reserves bottom space so nothing hides behind the bar.
    expect(document.querySelector(".pb-28")).not.toBeNull();
  });

  it("Save Changes stays reachable inside the bar and saves the edit", async () => {
    renderPage();
    const bar = await screen.findByTestId("product-settings-save-bar");
    const save = within(bar).getByRole("button", { name: /save changes/i });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /portal display/i }));
    fireEvent.click(screen.getByRole("switch", { name: /require sku/i }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(m.updateConfig).toHaveBeenCalledTimes(1));
    expect(m.updateConfig.mock.calls[0][0]).toMatchObject({ require_sku: "yes" });
  });

  it("ends at the workspace's right edge so an open assistant panel isn't covered", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1440);
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rect() {
      // The shell's <main> is narrowed by the 440px assistant panel.
      if (this.dataset?.testid === "workspace") return { left: 0, right: 1000, width: 1000, top: 0, bottom: 800, height: 800 };
      return realRect.call(this);
    });
    renderPage((page) => <main data-testid="workspace">{page}</main>);
    const bar = await screen.findByTestId("product-settings-save-bar");
    await waitFor(() => expect(bar.style.right).toBe("440px"));
  });

  it("falls back to the viewport edge (right-0) when no layout can be measured", async () => {
    renderPage();
    const bar = await screen.findByTestId("product-settings-save-bar");
    expect(bar.className).toMatch(/\bright-0\b/);
    expect(bar.style.right).toBe("");
  });
});
