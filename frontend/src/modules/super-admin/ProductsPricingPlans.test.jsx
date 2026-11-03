import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

/**
 * Regression tests for the Products & Pricing "Plans" tab, the catalog
 * versions page and the plan-change history, each pinned to a backend
 * contract the old UI got wrong.
 */

const svc = vi.hoisted(() => ({
  listCommercialPlans: vi.fn(),
  createCommercialPlan: vi.fn(),
  updateCommercialPlan: vi.fn(),
  setCommercialPlanStatus: vi.fn(),
  setCommercialPlanDefault: vi.fn(),
  getCommercialPlan: vi.fn(),
  listCommercialPlanVersions: vi.fn(),
  createCommercialPlanVersion: vi.fn(),
  updateCommercialPlanVersion: vi.fn(),
  submitCommercialPlanVersion: vi.fn(),
  approveCommercialPlanVersion: vi.fn(),
  rejectCommercialPlanVersion: vi.fn(),
  archiveCommercialPlanVersion: vi.fn(),
  listEntitlementDefinitions: vi.fn(),
  listPlanVersionEntitlements: vi.fn(),
  setCommercialPlanVersionEntitlement: vi.fn(),
  listCommercialSubscriptionChanges: vi.fn(),
  reverseCommercialSubscriptionChange: vi.fn(),
}));
vi.mock("../../service/commercialService", () => svc);

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: 1, role: "super_admin", email: "admin@example.com" } }),
}));

import PlansPage from "./PlansPage";
import CommercialPlanVersionsPage from "./CommercialPlanVersionsPage";
import PlanChangesPage from "./PlanChangesPage";

const PLAN = {
  id: 7,
  plan_code: "std",
  plan_name: "Standard",
  description: null,
  status: "active",
  is_default: false,
  billing_interval: "monthly",
  currency: "USD",
  price_amount: "49.00",
  effective_from: null,
  effective_to: null,
  max_users: 10,
  max_storage_gb: null,
  features: null,
};

function renderPlans() {
  return render(
    <MemoryRouter initialEntries={["/super-admin/commercial/plans"]}>
      <PlansPage />
    </MemoryRouter>
  );
}

function renderVersions() {
  return render(
    <MemoryRouter initialEntries={["/super-admin/commercial/plans/7/versions"]}>
      <Routes>
        <Route path="/super-admin/commercial/plans/:planId/versions" element={<CommercialPlanVersionsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  svc.listCommercialPlans.mockImplementation((params = {}) =>
    Promise.resolve(params.limit === 1 ? { plans: [], total: params.status === "active" ? 1 : 0 } : { plans: [PLAN], total: 1 })
  );
  svc.getCommercialPlan.mockResolvedValue(PLAN);
  svc.listCommercialPlanVersions.mockResolvedValue({ versions: [], total: 0 });
  svc.listEntitlementDefinitions.mockResolvedValue({ definitions: [] });
  svc.listPlanVersionEntitlements.mockResolvedValue({ entitlements: [] });
  svc.listCommercialSubscriptionChanges.mockResolvedValue({ changes: [], total: 0 });
});

async function confirmDialog(label) {
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: label }));
}

describe("Plans tab", () => {
  it("edit sends only changed fields and never the unsupported is_default", async () => {
    svc.updateCommercialPlan.mockResolvedValue({ ...PLAN, plan_name: "Standard Plus" });
    renderPlans();
    fireEvent.click(await screen.findByRole("button", { name: "Edit std" }));
    const dialog = await screen.findByRole("dialog");
    // PATCH /commercial-plans/{id} has no is_default — the checkbox was a no-op there.
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/plan name/i), { target: { value: "Standard Plus" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(svc.updateCommercialPlan).toHaveBeenCalledWith(7, { plan_name: "Standard Plus" }));
  });

  it("refuses to report a cleared field as saved (the backend ignores nulls on update)", async () => {
    renderPlans();
    fireEvent.click(await screen.findByRole("button", { name: "Edit std" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^price/i), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /save changes/i }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/can't clear a value/i);
    expect(svc.updateCommercialPlan).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("rejects non-object features JSON before it reaches the backend's dict field", async () => {
    renderPlans();
    fireEvent.click(await screen.findByRole("button", { name: /create plan/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/plan code/i), { target: { value: "pro" } });
    fireEvent.change(within(dialog).getByLabelText(/plan name/i), { target: { value: "Pro" } });
    fireEvent.change(within(dialog).getByLabelText(/features/i), { target: { value: "[1, 2]" } });
    fireEvent.submit(within(dialog).getByLabelText(/plan code/i).closest("form"));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/JSON object/i);
    expect(svc.createCommercialPlan).not.toHaveBeenCalled();
  });

  it("a row action on page 2 reloads page 2, not page 1 (stale closure)", async () => {
    const page2Plan = { ...PLAN, id: 99, plan_code: "p2", plan_name: "Page Two" };
    svc.listCommercialPlans.mockImplementation((params = {}) => {
      if (params.limit === 1) return Promise.resolve({ plans: [], total: 0 });
      return Promise.resolve({ plans: params.skip ? [page2Plan] : [PLAN], total: 45 });
    });
    svc.setCommercialPlanStatus.mockResolvedValue({ ...page2Plan, status: "inactive" });
    renderPlans();
    await screen.findByText("Standard");
    fireEvent.click(screen.getAllByRole("button", { name: "2" })[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Deactivate p2" }));
    await confirmDialog("Deactivate");

    await waitFor(() => expect(svc.setCommercialPlanStatus).toHaveBeenCalledWith(99, "inactive"));
    await waitFor(() => {
      const listCalls = svc.listCommercialPlans.mock.calls.map(([p]) => p).filter((p) => p.limit !== 1);
      expect(listCalls[listCalls.length - 1]).toMatchObject({ skip: 20 });
    });
    expect(await screen.findByText("Page Two")).toBeInTheDocument();
  });

  it("a failed status change keeps the table and shows a dismissible error", async () => {
    svc.setCommercialPlanStatus.mockRejectedValue(new Error("CommercialPlan std is ARCHIVED and cannot change status."));
    renderPlans();
    fireEvent.click(await screen.findByRole("button", { name: "Archive std" }));
    await confirmDialog("Archive plan");

    const alert = await screen.findByText(/cannot change status/i);
    expect(screen.getByText("Standard")).toBeInTheDocument();
    fireEvent.click(within(alert.closest("[role=alert]")).getByRole("button", { name: /dismiss/i }));
    await waitFor(() => expect(screen.queryByText(/cannot change status/i)).not.toBeInTheDocument());
  });

  it("passes search and status filters to the list endpoint", async () => {
    renderPlans();
    await screen.findByText("Standard");
    fireEvent.click(screen.getByRole("button", { name: /^active/i, pressed: false }));
    await waitFor(() =>
      expect(svc.listCommercialPlans).toHaveBeenCalledWith(expect.objectContaining({ status: "active", skip: 0, limit: 20 }))
    );
  });
});

describe("Catalog versions page", () => {
  it("lets a draft carry a billing interval (the field had no input before)", async () => {
    svc.createCommercialPlanVersion.mockResolvedValue({ id: 1, version_number: 1, status: "draft" });
    renderVersions();
    fireEvent.click(await screen.findByRole("button", { name: /create first draft/i }));
    const dialog = await screen.findByRole("dialog");
    // Prefilled from the plan template.
    expect(within(dialog).getByLabelText(/billing interval/i)).toHaveValue("monthly");
    fireEvent.change(within(dialog).getByLabelText(/billing interval/i), { target: { value: "annual" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /create draft/i }));

    await waitFor(() =>
      expect(svc.createCommercialPlanVersion).toHaveBeenCalledWith("7", expect.objectContaining({ billing_interval: "annual", plan_name: "Standard" }))
    );
  });

  it("edits a draft's fields through the draft-only PATCH endpoint", async () => {
    svc.listCommercialPlanVersions.mockResolvedValue({
      versions: [{ id: 50, version_number: 2, status: "draft", plan_name: "Standard", price_amount: null }],
    });
    svc.updateCommercialPlanVersion.mockResolvedValue({ id: 50, version_number: 2, status: "draft" });
    renderVersions();
    fireEvent.click(await screen.findByRole("button", { name: "Edit details of v2" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/max users/i), { target: { value: "25" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /save draft/i }));

    await waitFor(() => expect(svc.updateCommercialPlanVersion).toHaveBeenCalledWith(50, expect.objectContaining({ max_users: 25 })));
  });

  it("a failed approval keeps the versions table and offers Dismiss, not a list Retry", async () => {
    svc.listCommercialPlanVersions.mockResolvedValue({
      versions: [{ id: 51, version_number: 3, status: "pending_approval", plan_name: "Standard", price_amount: null }],
    });
    svc.approveCommercialPlanVersion.mockRejectedValue(new Error("You cannot approve your own request."));
    renderVersions();
    fireEvent.click(await screen.findByRole("button", { name: "Approve v3" }));
    await confirmDialog("Approve & publish");

    const msg = await screen.findByText(/cannot approve your own request/i);
    const banner = msg.closest("[role=alert]");
    expect(within(banner).getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
    expect(within(banner).queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.getByText("v3")).toBeInTheDocument();
  });

  it("does not silently save a non-numeric integer entitlement as unset", async () => {
    svc.listCommercialPlanVersions.mockResolvedValue({
      versions: [{ id: 50, version_number: 1, status: "draft", plan_name: "Standard", price_amount: null }],
    });
    svc.listEntitlementDefinitions.mockResolvedValue({
      definitions: [{ id: 1, key: "api.requests_per_day", value_type: "integer", risk_classification: "standard" }],
    });
    renderVersions();
    fireEvent.click(await screen.findByRole("button", { name: /edit entitlements/i }));
    const dialog = await screen.findByRole("dialog");
    const input = await within(dialog).findByPlaceholderText("integer");
    fireEvent.change(input, { target: { value: "lots" } });
    fireEvent.click(within(input.closest("tr")).getByRole("button", { name: /^save$/i }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/whole number/i);
    expect(svc.setCommercialPlanVersionEntitlement).not.toHaveBeenCalled();
  });
});

describe("Plan change history", () => {
  it("pages through the backend instead of truncating at its default 50 rows, and shows the real total", async () => {
    svc.listCommercialSubscriptionChanges.mockImplementation((params = {}) =>
      Promise.resolve(
        params.limit === 1
          ? { changes: [], total: 0 }
          : {
              changes: [{ id: 120, commercial_subscription_id: 3, from_plan_id: 1, to_plan_id: 2, from_plan_code: "pro", to_plan_code: "std", direction: "downgrade", status: "applied", requested_at: "2026-10-01T00:00:00", blockers: [] }],
              total: 75,
            }
      )
    );
    render(<PlanChangesPage />);
    expect((await screen.findAllByText("75 change(s)")).length).toBeGreaterThan(0);
    expect(svc.listCommercialSubscriptionChanges).toHaveBeenCalledWith({ skip: 0, limit: 20 });
    fireEvent.click(screen.getByRole("button", { name: "4" }));
    await waitFor(() => expect(svc.listCommercialSubscriptionChanges).toHaveBeenCalledWith({ skip: 60, limit: 20 }));
  });

  it("only offers cancel on scheduled changes, and keeps the dialog open with the error on failure", async () => {
    svc.listCommercialSubscriptionChanges.mockImplementation((params = {}) =>
      Promise.resolve(
        params.limit === 1
          ? { changes: [], total: 0 }
          : {
              changes: [
                { id: 1, commercial_subscription_id: 3, from_plan_id: 1, to_plan_id: 2, direction: "downgrade", status: "scheduled", requested_at: "2026-10-01T00:00:00", blockers: null },
                { id: 2, commercial_subscription_id: 4, from_plan_id: 1, to_plan_id: 2, direction: "downgrade", status: "blocked", requested_at: "2026-10-01T00:00:00", blockers: [{ check_id: "x", label: "Internal users", detail: "Too many users", current_count: 12, target_limit: 5 }] },
              ],
              total: 2,
            }
      )
    );
    svc.reverseCommercialSubscriptionChange.mockRejectedValue(new Error("SubscriptionChange 1 is APPLIED, not SCHEDULED; cannot reverse."));
    render(<PlanChangesPage />);
    expect(await screen.findByRole("button", { name: "Cancel scheduled plan change #1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel scheduled plan change #2" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel scheduled plan change #1" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: "Customer asked" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel change$/i }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/not SCHEDULED/i);
    expect(svc.reverseCommercialSubscriptionChange).toHaveBeenCalledWith(1, "Customer asked");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
