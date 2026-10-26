import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const svc = vi.hoisted(() => ({
  getCommercialPlan: vi.fn(),
  listCommercialPlanVersions: vi.fn(),
  createCommercialPlanVersion: vi.fn(),
  submitCommercialPlanVersion: vi.fn(),
  approveCommercialPlanVersion: vi.fn(),
  rejectCommercialPlanVersion: vi.fn(),
  archiveCommercialPlanVersion: vi.fn(),
  listEntitlementDefinitions: vi.fn(),
  listPlanVersionEntitlements: vi.fn(),
  setCommercialPlanVersionEntitlement: vi.fn(),
}));
vi.mock("../../service/commercialService", () => svc);

import CommercialPlanVersionsPage from "./CommercialPlanVersionsPage";

const DEFINITIONS = [
  { id: 1, key: "api.requests_per_day", value_type: "integer", risk_classification: "standard" },
  { id: 2, key: "api.write", value_type: "boolean", risk_classification: "high" },
];

// Simulates the server: saved values persist and are returned on reopen.
let serverValues;

beforeEach(() => {
  vi.clearAllMocks();
  serverValues = {};
  svc.getCommercialPlan.mockResolvedValue({ id: 5, plan_code: "PRO", plan_name: "Pro" });
  svc.listCommercialPlanVersions.mockResolvedValue({
    versions: [{ id: 50, version_number: 1, status: "draft", price_amount: null, max_users: null, max_storage_gb: null }],
    total: 1,
  });
  svc.listEntitlementDefinitions.mockResolvedValue({ definitions: DEFINITIONS });
  svc.listPlanVersionEntitlements.mockImplementation(() =>
    Promise.resolve({
      entitlements: Object.entries(serverValues).map(([defId, value]) => ({
        entitlement_definition_id: Number(defId),
        value,
      })),
    })
  );
  svc.setCommercialPlanVersionEntitlement.mockImplementation((versionId, defId, value) => {
    serverValues[defId] = value;
    return Promise.resolve({ entitlement_definition_id: defId, value });
  });
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/super-admin/commercial/plans/5/versions"]}>
      <Routes>
        <Route path="/super-admin/commercial/plans/:planId/versions" element={<CommercialPlanVersionsPage />} />
      </Routes>
    </MemoryRouter>
  );
}

async function openMatrix() {
  fireEvent.click(await screen.findByRole("button", { name: /edit entitlements/i }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("api.requests_per_day");
  return dialog;
}

describe("Edit entitlements modal", () => {
  it("keeps saved values when the modal is closed and reopened", async () => {
    renderPage();
    let dialog = await openMatrix();

    const input = within(dialog).getByPlaceholderText("integer");
    fireEvent.change(input, { target: { value: "5000" } });
    const row = input.closest("tr");
    fireEvent.click(within(row).getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(within(row).getByText(/saved/i)).toBeInTheDocument());
    expect(svc.setCommercialPlanVersionEntitlement).toHaveBeenCalledWith(50, 1, 5000);

    fireEvent.click(within(dialog).getByRole("button", { name: /^done$/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    dialog = await openMatrix();
    expect(within(dialog).getByPlaceholderText("integer")).toHaveValue("5000");
  });

  it("saves unsaved edits instead of discarding them when closing", async () => {
    renderPage();
    const dialog = await openMatrix();

    fireEvent.change(within(dialog).getByPlaceholderText("integer"), { target: { value: "250" } });
    const done = within(dialog).getByRole("button", { name: /save 1 & close/i });
    expect(within(dialog).getByText(/1 unsaved change/i)).toBeInTheDocument();

    fireEvent.click(done);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(svc.setCommercialPlanVersionEntitlement).toHaveBeenCalledWith(50, 1, 250);
    expect(serverValues[1]).toBe(250);
  });

  it("stays open with the error when a save fails on close", async () => {
    svc.setCommercialPlanVersionEntitlement.mockRejectedValueOnce(new Error("Version is not DRAFT"));
    renderPage();
    const dialog = await openMatrix();

    fireEvent.change(within(dialog).getByPlaceholderText("integer"), { target: { value: "9" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /save 1 & close/i }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/not DRAFT/i);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByPlaceholderText("integer")).toHaveValue("9");
  });
});
