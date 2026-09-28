import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Products & Pricing hub (PlansPage.jsx) consolidation: tab-aware header
 * (matching the Audit & Evidence / System Health / Financial Operations
 * fix), label agreement between each tab and its embedded page's own header,
 * the Usage Diagnostics → Entitlement Catalog deep link, and — for every
 * write-flow tab that previously rendered its error banner and its
 * table's own empty state independently — a failed fetch reading as a
 * failure, not as an empty catalogue.
 */

const commercial = vi.hoisted(() => ({
  listCommercialPlans: vi.fn(),
  createCommercialPlan: vi.fn(),
  updateCommercialPlan: vi.fn(),
  setCommercialPlanStatus: vi.fn(),
  setCommercialPlanDefault: vi.fn(),
  listCommercialPlanVersions: vi.fn(),
  listEntitlementDefinitions: vi.fn(),
  listPlanVersionEntitlements: vi.fn(),
  listCommercialSubscriptions: vi.fn(),
  createCommercialSubscription: vi.fn(),
  setCommercialSubscriptionStatus: vi.fn(),
  changeCommercialSubscriptionPlan: vi.fn(),
  listCommercialAccounts: vi.fn(),
  listCommercialOverrides: vi.fn(),
  createCommercialOverride: vi.fn(),
  submitCommercialOverride: vi.fn(),
  approveCommercialOverride: vi.fn(),
  rejectCommercialOverride: vi.fn(),
  revokeCommercialOverride: vi.fn(),
  listOrganizations: vi.fn(),
  listCommercialUsageCounters: vi.fn(),
  listCommercialSubscriptionChanges: vi.fn(),
  reverseCommercialSubscriptionChange: vi.fn(),
}));
vi.mock("../../service/commercialService", () => commercial);

const cmdCenter = vi.hoisted(() => ({
  listEvaluationPrograms: vi.fn(),
  createEvaluationProgram: vi.fn(),
  setEvaluationProgramStatus: vi.fn(),
}));
vi.mock("../../service/commandCenterService", () => cmdCenter);

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, role: "super_admin", email: "admin@example.com" } }),
}));

import PlansPage from "./PlansPage";

function renderHub(url = "/super-admin/commercial/plans") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <PlansPage />
    </MemoryRouter>
  );
}

const EXPECTED_TABS = [
  "Plans",
  "Entitlement Catalog",
  "Plan Entitlements",
  "Evaluation Programs",
  "Platform Subscriptions",
  "Entitlement Overrides",
  "Usage Diagnostics",
  "Plan Change History",
];

beforeEach(() => {
  vi.clearAllMocks();
  commercial.listCommercialPlans.mockResolvedValue({ plans: [], total: 0 });
  commercial.listCommercialPlanVersions.mockResolvedValue({ versions: [] });
  commercial.listEntitlementDefinitions.mockResolvedValue({ definitions: [] });
  commercial.listPlanVersionEntitlements.mockResolvedValue({ entitlements: [] });
  commercial.listCommercialSubscriptions.mockResolvedValue({ subscriptions: [], total: 0 });
  commercial.listCommercialAccounts.mockResolvedValue({ accounts: [] });
  commercial.listCommercialOverrides.mockResolvedValue({ overrides: [] });
  commercial.listOrganizations.mockResolvedValue({ organizations: [] });
  commercial.listCommercialUsageCounters.mockResolvedValue({ counters: [] });
  commercial.listCommercialSubscriptionChanges.mockResolvedValue({ changes: [] });
  cmdCenter.listEvaluationPrograms.mockResolvedValue([]);
});

describe("PlansPage hub", () => {
  it("exposes all 8 tabs, none removed", async () => {
    renderHub();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(EXPECTED_TABS);
  });

  it("retitles the hub header to match the active tab, with no second embedded header", async () => {
    renderHub();
    expect(await screen.findByRole("heading", { name: "Plans" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Platform Subscriptions" }));
    await waitFor(() => expect(commercial.listCommercialSubscriptions).toHaveBeenCalled());
    const headings = await screen.findAllByRole("heading", { name: "Platform Subscriptions" });
    expect(headings).toHaveLength(1);
    // The old mismatch: tab said "Platform Subscriptions", the embedded
    // page's own header said "Commercial Subscriptions".
    expect(screen.queryByText("Commercial Subscriptions")).not.toBeInTheDocument();
  });

  it("titles the hub itself to match its sidebar label, not a static 'Commercial Plans'", async () => {
    renderHub();
    expect(screen.queryByText("Commercial Plans")).not.toBeInTheDocument();
    expect(screen.getAllByText("Products & Pricing").length).toBeGreaterThan(0);
  });

  it("every tab label matches its embedded page's own header title", async () => {
    renderHub();
    for (const label of EXPECTED_TABS.filter((l) => l !== "Plans")) {
      fireEvent.click(screen.getByRole("tab", { name: label }));
      // eslint-disable-next-line no-await-in-loop
      const headings = await screen.findAllByRole("heading", { name: label });
      expect(headings).toHaveLength(1);
    }
  });

  it("jumps from a Usage Diagnostics key to that key pre-filtered in the Entitlement Catalog", async () => {
    commercial.listCommercialUsageCounters.mockResolvedValue({
      counters: [{ id: 1, organization_id: 1, entitlement_key: "api_calls_per_day", window_key: "2026-01-01", count: 5 }],
    });
    commercial.listEntitlementDefinitions.mockResolvedValue({
      definitions: [{ id: 1, key: "api_calls_per_day", description: "API calls", value_type: "integer", risk_level: "low" }],
    });
    renderHub();
    fireEvent.click(screen.getByRole("tab", { name: "Usage Diagnostics" }));
    fireEvent.click(await screen.findByRole("button", { name: "api_calls_per_day" }));

    const catalogTab = await screen.findByRole("tab", { name: "Entitlement Catalog" });
    expect(catalogTab).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(screen.getByPlaceholderText(/search by key/i)).toHaveValue("api_calls_per_day"));
  });

  it("Plans tab: shows the fetch error, not 'No commercial plans yet', on a failed load", async () => {
    commercial.listCommercialPlans.mockRejectedValue(new Error("Plans service unreachable"));
    renderHub();
    expect(await screen.findByText("Plans service unreachable")).toBeInTheDocument();
    expect(screen.queryByText("No commercial plans yet")).not.toBeInTheDocument();
  });

  it("Evaluation Programs: shows the fetch error, not 'No evaluation programs', on a failed load", async () => {
    cmdCenter.listEvaluationPrograms.mockRejectedValue(new Error("Programs service unreachable"));
    renderHub("/super-admin/commercial/plans?tab=evaluation-programs");
    expect(await screen.findByText("Programs service unreachable")).toBeInTheDocument();
    expect(screen.queryByText("No evaluation programs")).not.toBeInTheDocument();
  });

  it("Platform Subscriptions: shows the fetch error, not 'No commercial subscriptions yet', on a failed load", async () => {
    commercial.listCommercialSubscriptions.mockRejectedValue(new Error("Subscriptions service unreachable"));
    renderHub("/super-admin/commercial/plans?tab=subscriptions");
    expect(await screen.findByText("Subscriptions service unreachable")).toBeInTheDocument();
    expect(screen.queryByText("No commercial subscriptions yet")).not.toBeInTheDocument();
  });

  it("Entitlement Overrides: shows the fetch error, not 'No commercial overrides yet', on a failed load", async () => {
    commercial.listCommercialOverrides.mockRejectedValue(new Error("Overrides service unreachable"));
    renderHub("/super-admin/commercial/plans?tab=overrides");
    expect(await screen.findByText("Overrides service unreachable")).toBeInTheDocument();
    expect(screen.queryByText("No commercial overrides yet")).not.toBeInTheDocument();
  });

  it("Plan Change History: shows the fetch error, not 'No plan changes yet', on a failed load", async () => {
    commercial.listCommercialSubscriptionChanges.mockRejectedValue(new Error("Plan-change service unreachable"));
    renderHub("/super-admin/commercial/plans?tab=plan-changes");
    expect(await screen.findByText("Plan-change service unreachable")).toBeInTheDocument();
    expect(screen.queryByText("No plan changes yet")).not.toBeInTheDocument();
  });

  it("Plan Entitlements: a Retry after a failed versions fetch re-fetches versions, not the plan list", async () => {
    commercial.listCommercialPlans.mockResolvedValue({
      plans: [{ id: 1, plan_code: "std", plan_name: "Standard", status: "active" }],
    });
    commercial.listCommercialPlanVersions.mockRejectedValueOnce(new Error("Versions unreachable"));
    renderHub("/super-admin/commercial/plans?tab=plan-entitlements");

    expect(await screen.findByText("Versions unreachable")).toBeInTheDocument();
    // The hub preloads its own Plans-tab list in the background regardless of
    // the active tab, and PlanEntitlementsPage independently loads the plan
    // list for its own picker — both fire once on mount.
    const plansCallsBeforeRetry = commercial.listCommercialPlans.mock.calls.length;

    commercial.listCommercialPlanVersions.mockResolvedValueOnce({ versions: [] });
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(commercial.listCommercialPlanVersions).toHaveBeenCalledTimes(2));
    // The plan list itself was not re-fetched by a versions-stage retry.
    expect(commercial.listCommercialPlans).toHaveBeenCalledTimes(plansCallsBeforeRetry);
  });
});
