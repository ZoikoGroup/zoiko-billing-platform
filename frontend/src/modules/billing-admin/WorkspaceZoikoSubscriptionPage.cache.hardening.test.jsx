import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect } from "react";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// The workspace subscription page and TrialBanner (rendered by BillingShell
// on the same screen) must share getZoikoSubscriptionCached, so the slow
// GET /billing/workspace/zoiko-subscription runs once on mount.

const m = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../service/api", () => ({ api: { get: (...a) => m.get(...a), post: (...a) => m.post(...a) } }));
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, first_name: "Alex", role: "org_admin" }, role: "org_admin" }),
}));

import WorkspaceZoikoSubscriptionPage from "./WorkspaceZoikoSubscriptionPage";
import { getZoikoSubscriptionCached, invalidateZoikoSubscriptionCache } from "../../service/platformSelfServiceApi";

const SUB_URL = "/billing/workspace/zoiko-subscription";
const SUB = {
  account: { id: 1, status: "active" },
  subscription: { id: 10, status: "active", plan_name: "Zoiko Enterprise", currency: "USD" },
  invoices: [], payments: [], quotes: [],
};

// Mirrors TrialBanner's data access.
function TrialBannerLike() {
  useEffect(() => { getZoikoSubscriptionCached().catch(() => {}); }, []);
  return null;
}

const subCalls = () => m.get.mock.calls.filter(([url]) => url === SUB_URL).length;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateZoikoSubscriptionCache();
  m.get.mockImplementation((url) => (url === SUB_URL
    ? new Promise((r) => setTimeout(() => r(SUB), 10))
    : Promise.resolve({})));
});
afterEach(() => cleanup());

describe("WorkspaceZoikoSubscriptionPage subscription fetch", () => {
  it("fetches the zoiko subscription once on mount alongside a TrialBanner-style consumer", async () => {
    render(
      <MemoryRouter>
        <TrialBannerLike />
        <WorkspaceZoikoSubscriptionPage />
      </MemoryRouter>
    );
    expect(await screen.findByText("Zoiko Enterprise")).toBeInTheDocument();
    expect(subCalls()).toBe(1);
  });

  it("an explicit refresh forces a fresh fetch", async () => {
    render(<MemoryRouter><WorkspaceZoikoSubscriptionPage /></MemoryRouter>);
    await screen.findByText("Zoiko Enterprise");
    expect(subCalls()).toBe(1);

    fireEvent.click(screen.getAllByRole("button", { name: /refresh/i })[0]);
    await waitFor(() => expect(subCalls()).toBe(2));
  });
});
