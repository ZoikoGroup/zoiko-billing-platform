import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

/**
 * Regression tests for the Products & Pricing entitlement tabs
 * (Entitlement Catalog, Plan Entitlements, Entitlement Overrides), checked
 * against the backend contracts in super_admin/router.py and
 * commercial/entitlement_override_service.py.
 */

const svc = vi.hoisted(() => ({
  listCommercialPlans: vi.fn(),
  listCommercialPlanVersions: vi.fn(),
  listPlanVersionEntitlements: vi.fn(),
  listEntitlementDefinitions: vi.fn(),
  listCommercialOverrides: vi.fn(),
  createCommercialOverride: vi.fn(),
  submitCommercialOverride: vi.fn(),
  approveCommercialOverride: vi.fn(),
  rejectCommercialOverride: vi.fn(),
  revokeCommercialOverride: vi.fn(),
  withdrawCommercialOverride: vi.fn(),
  listOrganizations: vi.fn(),
}));
vi.mock("../../service/commercialService", () => svc);
vi.mock("../../context/AuthContext", () => ({ useAuth: () => ({ user: { id: 1 } }) }));

import EntitlementsPage from "./EntitlementsPage";
import PlanEntitlementsPage from "./PlanEntitlementsPage";
import OverridesPage from "./OverridesPage";

const DEFS = [
  { id: 1, key: "security.sso", value_type: "boolean", risk_classification: "high_risk", enforcement_type: "hard", description: "SSO" },
  { id: 2, key: "billing.invoice.monthly_limit", value_type: "integer", risk_classification: "standard", enforcement_type: "hard", description: "Invoices" },
];

beforeEach(() => {
  vi.clearAllMocks();
  svc.listEntitlementDefinitions.mockResolvedValue({ definitions: DEFS });
  svc.listOrganizations.mockResolvedValue({ organizations: [{ id: 9, organization_code: "ACME", organization_name: "Acme Ltd" }] });
  svc.listCommercialOverrides.mockResolvedValue({ overrides: [] });
  svc.listCommercialPlans.mockResolvedValue({ plans: [] });
  svc.listCommercialPlanVersions.mockResolvedValue({ versions: [] });
  svc.listPlanVersionEntitlements.mockResolvedValue({ entitlements: [] });
});

const renderWithRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe("Entitlement Catalog", () => {
  it("never shows a draft version's values as a plan's published snapshot", async () => {
    svc.listCommercialPlans.mockResolvedValue({ plans: [{ id: 5, plan_code: "biz", plan_name: "Business", status: "active" }] });
    svc.listCommercialPlanVersions.mockResolvedValue({ versions: [{ id: 51, version_number: 2, status: "draft" }] });
    svc.listPlanVersionEntitlements.mockResolvedValue({
      entitlements: [{ id: 1, key: "security.sso", value_type: "boolean", value: true, is_contracted: false }],
    });
    renderWithRouter(<EntitlementsPage embedded />);
    expect(await screen.findByText("No published version")).toBeInTheDocument();
    expect(svc.listPlanVersionEntitlements).not.toHaveBeenCalled();
    expect(screen.queryByText("Enabled")).not.toBeInTheDocument();
  });

  it("marks a plan whose snapshot failed to load as unavailable instead of blank", async () => {
    svc.listCommercialPlans.mockResolvedValue({ plans: [{ id: 5, plan_code: "biz", plan_name: "Business", status: "active" }] });
    svc.listCommercialPlanVersions.mockRejectedValue(new Error("versions down"));
    renderWithRouter(<EntitlementsPage embedded />);
    expect(await screen.findByText(/couldn't load the published values for business/i)).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable")).toHaveLength(DEFS.length);
  });
});

describe("Plan Entitlements", () => {
  beforeEach(() => {
    svc.listCommercialPlans.mockResolvedValue({
      plans: [
        { id: 5, plan_code: "biz", plan_name: "Business", status: "active" },
        { id: 6, plan_code: "ent", plan_name: "Enterprise", status: "active" },
      ],
    });
  });

  it("shows a plain effective date as the same calendar day in every timezone", async () => {
    svc.listCommercialPlanVersions.mockResolvedValue({
      versions: [{ id: 50, version_number: 1, status: "published", plan_name: "Business", effective_from: "2026-03-01" }],
    });
    render(<PlanEntitlementsPage embedded />);
    fireEvent.change(await screen.findByLabelText("Plan"), { target: { value: "5" } });
    const expected = new Date(2026, 2, 1).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
    expect(await screen.findByText(new RegExp(`effective ${expected}`))).toBeInTheDocument();
  });

  it("does not claim the version is empty while its entitlements are still loading", async () => {
    svc.listCommercialPlanVersions.mockResolvedValue({ versions: [{ id: 50, version_number: 1, status: "published", plan_name: "Business" }] });
    svc.listPlanVersionEntitlements.mockReturnValue(new Promise(() => {}));
    render(<PlanEntitlementsPage embedded />);
    fireEvent.change(await screen.findByLabelText("Plan"), { target: { value: "5" } });
    await waitFor(() => expect(svc.listPlanVersionEntitlements).toHaveBeenCalledWith(50));
    expect(screen.queryByText(/no entitlements bound to this version/i)).not.toBeInTheDocument();
  });

  it("drops the previous plan's version when the next plan's versions fail to load", async () => {
    svc.listCommercialPlanVersions.mockResolvedValueOnce({ versions: [{ id: 50, version_number: 7, status: "published", plan_name: "Business" }] });
    render(<PlanEntitlementsPage embedded />);
    const plan = await screen.findByLabelText("Plan");
    fireEvent.change(plan, { target: { value: "5" } });
    await screen.findByRole("option", { name: /version 7/i });

    svc.listCommercialPlanVersions.mockRejectedValueOnce(new Error("Versions unreachable"));
    fireEvent.change(plan, { target: { value: "6" } });
    expect(await screen.findByText("Versions unreachable")).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /version 7/i })).not.toBeInTheDocument();
  });
});

describe("Entitlement Overrides", () => {
  async function openCreate() {
    renderWithRouter(<OverridesPage />);
    const newBtn = await screen.findByRole("button", { name: /new override/i });
    await waitFor(() => expect(newBtn).toBeEnabled());
    fireEvent.click(newBtn);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/organization/i), { target: { value: "9" } });
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: "pilot customer" } });
    return dialog;
  }

  it("sends true when a boolean override is set to Enabled", async () => {
    svc.createCommercialOverride.mockResolvedValue({ id: 1, entitlement_key: "security.sso" });
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText(/entitlement key/i), { target: { value: "1" } });
    fireEvent.change(within(dialog).getByLabelText(/override value/i), { target: { value: "true" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /create draft/i }));
    await waitFor(() => expect(svc.createCommercialOverride).toHaveBeenCalledTimes(1));
    expect(svc.createCommercialOverride.mock.calls[0][0]).toMatchObject({
      organization_id: 9,
      entitlement_definition_id: 1,
      value: true,
      reason: "pilot customer",
      expires_at: null,
    });
  });

  it("does not carry a value typed for one key over to a key of another type", async () => {
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText(/entitlement key/i), { target: { value: "2" } });
    fireEvent.change(within(dialog).getByLabelText(/override value/i), { target: { value: "5" } });
    fireEvent.change(within(dialog).getByLabelText(/entitlement key/i), { target: { value: "1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /create draft/i }));
    expect(await within(dialog).findByText(/choose enabled or disabled/i)).toBeInTheDocument();
    expect(svc.createCommercialOverride).not.toHaveBeenCalled();
  });

  it("rejects a fractional integer limit next to the field", async () => {
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText(/entitlement key/i), { target: { value: "2" } });
    fireEvent.change(within(dialog).getByLabelText(/override value/i), { target: { value: "2.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /create draft/i }));
    expect(await within(dialog).findByText(/whole number/i)).toBeInTheDocument();
    expect(svc.createCommercialOverride).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with the server's error when create fails", async () => {
    svc.createCommercialOverride.mockRejectedValue(new Error("An active APPROVED override already exists"));
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText(/entitlement key/i), { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /create draft/i }));
    expect(await within(dialog).findByText(/already exists/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("reads the API's offset-less expires_at as UTC", async () => {
    const naiveUtc = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 19);
    const HOUR = 3600 * 1000;
    svc.listCommercialOverrides.mockResolvedValue({
      overrides: [
        { id: 1, organization_id: 9, entitlement_definition_id: 2, entitlement_key: "future.key", value: 5, status: "approved", reason: "r", expires_at: naiveUtc(3 * HOUR) },
        { id: 2, organization_id: 9, entitlement_definition_id: 2, entitlement_key: "past.key", value: 5, status: "approved", reason: "r", expires_at: naiveUtc(-3 * HOUR) },
      ],
    });
    renderWithRouter(<OverridesPage />);
    const futureRow = (await screen.findByText("future.key")).closest("tr");
    const pastRow = screen.getByText("past.key").closest("tr");
    expect(within(futureRow).queryByText(/no longer applied/i)).not.toBeInTheDocument();
    expect(within(pastRow).getByText(/expired — no longer applied/i)).toBeInTheDocument();
  });

  it("still lists overrides when the organization lookup fails", async () => {
    svc.listOrganizations.mockRejectedValue(new Error("org directory down"));
    svc.listCommercialOverrides.mockResolvedValue({
      overrides: [{ id: 3, organization_id: 9, entitlement_definition_id: 2, entitlement_key: "kept.key", value: 1, status: "draft", reason: "r" }],
    });
    renderWithRouter(<OverridesPage />);
    expect(await screen.findByText("kept.key")).toBeInTheDocument();
    expect(screen.getByText(/org directory down/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new override/i })).toBeDisabled();
  });

  it("disables Approve while an approval is in flight", async () => {
    svc.listCommercialOverrides.mockResolvedValue({
      overrides: [{ id: 4, organization_id: 9, entitlement_definition_id: 2, entitlement_key: "pend.key", value: 1, status: "pending_approval", requested_by_user_id: 99, reason: "r" }],
    });
    svc.approveCommercialOverride.mockReturnValue(new Promise(() => {}));
    renderWithRouter(<OverridesPage />);
    const row = (await screen.findByText("pend.key")).closest("tr");
    fireEvent.click(within(row).getByRole("button", { name: /approve/i }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /^approve$/i }));
    await waitFor(() => expect(within(row).getByRole("button", { name: /approve/i })).toBeDisabled());
    expect(within(row).getByRole("button", { name: /reject/i })).toBeDisabled();
    expect(svc.approveCommercialOverride).toHaveBeenCalledTimes(1);
  });
});
