import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// QA defect #11 (/billing/products/settings): "Default Category not showing
// any options". Same root cause as #4/#10 per the master defect report
// §3.9: category creation silently 422'd (missing required `code`), so no
// organization ever had categories to populate this dropdown with. That's
// fixed on categories.jsx; this test proves the *consumer* side --
// ProductSettingsPage's "Default Category" dropdown -- correctly renders
// whatever productApi.listCategories() returns.

const mockGetConfig = vi.fn();
const mockListCategories = vi.fn();
const mockListUsageBillable = vi.fn();

vi.mock("../../../service/billingService", () => ({
  settingsApi: { getConfig: (...args) => mockGetConfig(...args), updateConfig: vi.fn() },
  productApi: {
    listCategories: (...args) => mockListCategories(...args),
    listUsageBillable: (...args) => mockListUsageBillable(...args),
  },
}));

vi.mock("../../../service/billingConfigCache", () => ({
  invalidateGlobalBillingConfig: vi.fn(),
  subscribeBillingConfigInvalidation: vi.fn(),
}));

import ProductSettingsPage from "./settings";

const CATEGORY = { id: 9, name: "Hardware" };

function renderPage() {
  return render(
    <MemoryRouter>
      <ProductSettingsPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue({});
  mockListCategories.mockResolvedValue([CATEGORY]);
  mockListUsageBillable.mockResolvedValue([]);
});

describe("Product Settings — Default Category dropdown (defect #11)", () => {
  it("renders the org's categories as options", async () => {
    renderPage();
    await waitFor(() => expect(mockListCategories).toHaveBeenCalled());

    const select = await screen.findByDisplayValue("None");
    await waitFor(() => {
      expect(select.querySelector(`option[value="${CATEGORY.id}"]`)).not.toBeNull();
    });
  });
});
