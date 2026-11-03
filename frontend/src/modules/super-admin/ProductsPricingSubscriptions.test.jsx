import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const commercial = vi.hoisted(() => ({
  listCommercialSubscriptions: vi.fn(),
  createCommercialSubscription: vi.fn(),
  setCommercialSubscriptionStatus: vi.fn(),
  changeCommercialSubscriptionPlan: vi.fn(),
  listCommercialAccounts: vi.fn(),
  listCommercialPlans: vi.fn(),
  listCommercialUsageCounters: vi.fn(),
  listOrganizations: vi.fn(),
}));
vi.mock("../../service/commercialService", () => commercial);

const cc = vi.hoisted(() => ({
  listEvaluationPrograms: vi.fn(),
  createEvaluationProgram: vi.fn(),
  setEvaluationProgramStatus: vi.fn(),
  approveEvaluationProgram: vi.fn(),
}));
vi.mock("../../service/commandCenterService", () => cc);

import SubscriptionsPage from "./SubscriptionsPage";
import EvaluationProgramsPage from "./EvaluationProgramsPage";
import UsageDiagnosticsPage from "./UsageDiagnosticsPage";

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

function sub(overrides) {
  return {
    id: 1, commercial_account_id: 1, organization_id: 1, organization_code: "ACME", organization_name: "Acme Ltd",
    commercial_plan_id: 10, plan_code: "pro", plan_name: "Professional", status: "active",
    start_at: null, end_at: null, current_period_start: null, current_period_end: null,
    trial_ends_at: null, recovery_ends_at: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

const rowOf = (text) => screen.getByText(text).closest("tr");

beforeEach(() => {
  vi.clearAllMocks();
  commercial.listCommercialPlans.mockResolvedValue({ plans: [], total: 0 });
  commercial.listCommercialAccounts.mockResolvedValue({ accounts: [], total: 0 });
  commercial.listOrganizations.mockResolvedValue({ organizations: [], total: 0 });
});

describe("SubscriptionsPage", () => {
  it("offers the backend's transitions for a trial_recovery subscription and shows its recovery window", async () => {
    commercial.listCommercialSubscriptions.mockResolvedValue({
      subscriptions: [sub({ status: "trial_recovery", recovery_ends_at: inDays(5) })],
      total: 1,
    });
    render(<SubscriptionsPage embedded />);
    await screen.findByText("Acme Ltd");
    const row = rowOf("Acme Ltd");
    const select = within(row).getByRole("combobox", { name: /status change/i });
    const options = within(select).getAllByRole("option").map((o) => o.value);
    expect(options).toEqual(["active", "suspended", "cancelled", "expired"]);
    expect(within(row).getByText(/^Recovery \d+d/)).toBeInTheDocument();
    expect(within(row).getByText("Trial Recovery")).toBeInTheDocument();
  });

  it("does not offer Change plan for statuses change_plan rejects", async () => {
    commercial.listCommercialSubscriptions.mockResolvedValue({
      subscriptions: [
        sub({ id: 1, organization_name: "Acme Ltd", status: "cancel_at_period_end" }),
        sub({ id: 2, organization_name: "Beta Inc", status: "active" }),
      ],
      total: 2,
    });
    render(<SubscriptionsPage embedded />);
    await screen.findByText("Acme Ltd");
    expect(within(rowOf("Acme Ltd")).queryByRole("button", { name: /change plan/i })).not.toBeInTheDocument();
    expect(within(rowOf("Beta Inc")).getByRole("button", { name: /change plan/i })).toBeInTheDocument();
  });

  it("reports a rejected transition inline and keeps the list", async () => {
    commercial.listCommercialSubscriptions.mockResolvedValue({ subscriptions: [sub({ status: "active" })], total: 1 });
    commercial.setCommercialSubscriptionStatus.mockRejectedValue(new Error("Illegal CommercialSubscription transition"));
    render(<SubscriptionsPage embedded />);
    await screen.findByText("Acme Ltd");
    const row = rowOf("Acme Ltd");
    fireEvent.change(within(row).getByRole("combobox", { name: /status change/i }), { target: { value: "suspended" } });
    fireEvent.click(within(row).getByRole("button", { name: /apply/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Suspend" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/illegal commercialsubscription transition/i);
    expect(commercial.setCommercialSubscriptionStatus).toHaveBeenCalledWith(1, "suspended");
    expect(screen.getByText("Acme Ltd")).toBeInTheDocument();
    expect(screen.queryByText(/unable to load subscriptions/i)).not.toBeInTheDocument();
  });

  it("sends the status filter to the backend and resets to page 1", async () => {
    commercial.listCommercialSubscriptions.mockResolvedValue({ subscriptions: [], total: 0 });
    render(<SubscriptionsPage embedded />);
    await waitFor(() => expect(commercial.listCommercialSubscriptions).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("combobox", { name: /filter by status/i }), { target: { value: "past_due" } });
    await waitFor(() =>
      expect(commercial.listCommercialSubscriptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "past_due", skip: 0 })
      )
    );
    expect(await screen.findByText("No subscriptions match")).toBeInTheDocument();
  });

  it("does not let an organization with an open subscription be picked in Create", async () => {
    commercial.listCommercialSubscriptions.mockResolvedValue({ subscriptions: [], total: 0 });
    commercial.listCommercialAccounts.mockResolvedValue({
      accounts: [
        { organization_id: 1, organization_code: "ACME", organization_name: "Acme Ltd", current_subscription: { id: 9, status: "active", plan_code: "pro", plan_name: "Professional" } },
        { organization_id: 2, organization_code: "BETA", organization_name: "Beta Inc", current_subscription: null },
      ],
      total: 2,
    });
    render(<SubscriptionsPage embedded />);
    fireEvent.click((await screen.findAllByRole("button", { name: /create subscription/i }))[0]);
    const orgSelect = await screen.findByLabelText(/organization/i, { selector: "select" });
    await waitFor(() => expect(within(orgSelect).getAllByRole("option")).toHaveLength(3));
    expect(within(orgSelect).getByRole("option", { name: /acme ltd/i })).toBeDisabled();
    expect(within(orgSelect).getByRole("option", { name: /beta inc/i })).not.toBeDisabled();
  });
});

describe("EvaluationProgramsPage", () => {
  const program = (overrides) => ({
    id: 3, plan_id: 1, plan_code: "essentials", granted_plan_code: null, is_active: true, duration_days: 30,
    payment_requirement: "none", conversion_policy: "manual", expiry_action: "suspend", approved_by: 1, caps: [],
    ...overrides,
  });

  it("still lists programs when the plan catalog fails to load", async () => {
    cc.listEvaluationPrograms.mockResolvedValue([program()]);
    commercial.listCommercialPlans.mockRejectedValue(new Error("plans down"));
    render(<EvaluationProgramsPage embedded />);
    expect(await screen.findByText("essentials")).toBeInTheDocument();
    expect(screen.queryByText(/unable to load evaluation programs/i)).not.toBeInTheDocument();
  });

  it("renders object cap values as JSON, not [object Object]", async () => {
    cc.listEvaluationPrograms.mockResolvedValue([
      program({ caps: [{ id: 1, entitlement_definition_id: 4, entitlement_key: "regions", value_type: "set", cap_value: { max: 2 } }] }),
    ]);
    render(<EvaluationProgramsPage embedded />);
    fireEvent.click(within(await screen.findByText("essentials").then((el) => el.closest("tr"))).getByRole("button", { name: /details/i }));
    expect(await screen.findByText('{"max":2}')).toBeInTheDocument();
    expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
  });

  it("asks for confirmation before deactivating, and does nothing if cancelled", async () => {
    cc.listEvaluationPrograms.mockResolvedValue([program()]);
    render(<EvaluationProgramsPage embedded />);
    const row = (await screen.findByText("essentials")).closest("tr");
    fireEvent.click(within(row).getByRole("button", { name: /^deactivate$/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(cc.setEvaluationProgramStatus).not.toHaveBeenCalled();
  });

  it("labels the not-yet-automated expiry policies honestly", async () => {
    cc.listEvaluationPrograms.mockResolvedValue([program({ conversion_policy: "auto_charge_on_expiry", expiry_action: "downgrade" })]);
    render(<EvaluationProgramsPage embedded />);
    const row = (await screen.findByText("essentials")).closest("tr");
    expect(within(row).getByText(/auto-charge at trial end \(not automated yet\)/i)).toBeInTheDocument();
    expect(within(row).getByText(/downgrade \(not automated yet\)/i)).toBeInTheDocument();
  });
});

describe("UsageDiagnosticsPage", () => {
  it("shows counters even when organization names fail to load, and never renders an empty key link", async () => {
    commercial.listCommercialUsageCounters.mockResolvedValue({
      counters: [
        { id: 1, organization_id: 7, entitlement_definition_id: 2, entitlement_key: "api_calls", window_key: "2026-11", count: 42, soft_warned_at: null, updated_at: "2026-11-02T00:00:00Z" },
        { id: 2, organization_id: 7, entitlement_definition_id: 5, entitlement_key: null, window_key: "2026-11-02", count: 3, soft_warned_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-02T00:00:00Z" },
      ],
      total: 2,
    });
    commercial.listOrganizations.mockRejectedValue(new Error("directory down"));
    const onOpenKey = vi.fn();
    render(<UsageDiagnosticsPage embedded onOpenKey={onOpenKey} />);

    expect(await screen.findByRole("button", { name: "api_calls" })).toBeInTheDocument();
    expect(screen.getByText("definition #5")).toBeInTheDocument();
    expect(screen.getByText(/couldn't be loaded \(directory down\)/i)).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "api_calls" }).closest("tr")).getByText("Nov 2026 (monthly)")).toBeInTheDocument();
    expect(screen.queryByText(/unable to load usage diagnostics/i)).not.toBeInTheDocument();
  });

  it("pages through the organization directory past the 200-row API cap", async () => {
    commercial.listCommercialUsageCounters.mockResolvedValue({
      counters: [{ id: 1, organization_id: 250, entitlement_definition_id: 2, entitlement_key: "seats", window_key: "2026-11", count: 1, updated_at: "2026-11-02T00:00:00Z" }],
      total: 1,
    });
    const firstPage = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, organization_code: `ORG${i + 1}`, organization_name: `Org ${i + 1}` }));
    commercial.listOrganizations
      .mockResolvedValueOnce({ organizations: firstPage, total: 201 })
      .mockResolvedValueOnce({ organizations: [{ id: 250, organization_code: "LATE", organization_name: "Late Org" }], total: 201 });
    render(<UsageDiagnosticsPage embedded />);
    expect(await screen.findByText("Late Org")).toBeInTheDocument();
    expect(commercial.listOrganizations).toHaveBeenNthCalledWith(2, { skip: 200, limit: 200 });
  });
});
