import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const svc = vi.hoisted(() => ({
  listCommercialPlans: vi.fn(),
  listCommercialPlanVersions: vi.fn(),
  listPlanVersionEntitlements: vi.fn(),
}));
vi.mock("../../service/commercialService", () => svc);

import PlanEntitlementsPage from "./PlanEntitlementsPage";

const ENTITLEMENTS = [
  { id: 1, key: "api.requests_per_day", value_type: "integer", risk_classification: "standard", enforcement_type: "throttle", value: 200000 },
  { id: 2, key: "api.write", value_type: "boolean", risk_classification: "high_risk", enforcement_type: "hard", value: true },
  { id: 3, key: "billing.invoice.create", value_type: "boolean", risk_classification: "standard", enforcement_type: "hard", value: true },
];

function mockVersions(versions) {
  svc.listCommercialPlanVersions.mockResolvedValue({ versions });
}

beforeEach(() => {
  vi.clearAllMocks();
  svc.listCommercialPlans.mockResolvedValue({ plans: [{ id: 5, plan_name: "Business", plan_code: "business", status: "active" }] });
  mockVersions([{ id: 50, version_number: 1, status: "published", plan_name: "Business", effective_from: null }]);
  svc.listPlanVersionEntitlements.mockResolvedValue({ entitlements: ENTITLEMENTS });
});

const keysShown = () =>
  ENTITLEMENTS.map((e) => e.key).filter((k) => screen.queryByText(k));

describe("PlanEntitlementsPage filters", () => {
  it("filters the matrix and clears every filter in one click", async () => {
    render(<PlanEntitlementsPage embedded />);
    await screen.findByText("api.write");
    const clear = screen.getByRole("button", { name: /^clear filters$/i });
    expect(clear).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/filter by risk/i), { target: { value: "high_risk" } });
    await waitFor(() => expect(keysShown()).toEqual(["api.write"]));
    expect(screen.getByText(/showing 1 of 3 entitlement/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/filter by enforcement/i), { target: { value: "throttle" } });
    await screen.findByText(/no entitlements match your filters/i);

    fireEvent.click(screen.getAllByRole("button", { name: /^clear filters$/i })[0]);
    await waitFor(() => expect(keysShown()).toHaveLength(3));
    expect(screen.getByLabelText(/filter by risk/i)).toHaveValue("");
    expect(screen.getByLabelText(/filter by enforcement/i)).toHaveValue("");
    expect(screen.getAllByRole("button", { name: /^clear filters$/i })[0]).toBeDisabled();
  });

  it("does not show a stray version label in the embedded header", async () => {
    render(<PlanEntitlementsPage embedded />);
    await screen.findByText("api.write");
    // The version picker already shows it; the embedded header used to float
    // "v1 · published" above the plan picker.
    expect(screen.queryByText("v1 · published")).not.toBeInTheDocument();
  });

  it("does not call a draft version the approved bundle", async () => {
    mockVersions([{ id: 51, version_number: 2, status: "draft", plan_name: "Business", effective_from: null }]);
    render(<PlanEntitlementsPage embedded />);
    await screen.findByText("api.write");
    expect(screen.getByText(/this version is draft, so these values are not yet the approved bundle/i)).toBeInTheDocument();
    expect(screen.queryByText(/the published version is immutable/i)).not.toBeInTheDocument();
  });
});
