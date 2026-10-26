import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const svc = vi.hoisted(() => ({
  listCommercialOverrides: vi.fn(),
  createCommercialOverride: vi.fn(),
  submitCommercialOverride: vi.fn(),
  approveCommercialOverride: vi.fn(),
  rejectCommercialOverride: vi.fn(),
  revokeCommercialOverride: vi.fn(),
  withdrawCommercialOverride: vi.fn(),
  listEntitlementDefinitions: vi.fn(),
  listOrganizations: vi.fn(),
}));
vi.mock("../../service/commercialService", () => svc);
vi.mock("../../context/AuthContext", () => ({ useAuth: () => ({ user: { id: 1 } }) }));

import OverridesPage from "./OverridesPage";

beforeEach(() => {
  vi.clearAllMocks();
  svc.listCommercialOverrides.mockResolvedValue({ overrides: [] });
  svc.listOrganizations.mockResolvedValue({ organizations: [] });
  svc.listEntitlementDefinitions.mockResolvedValue({ definitions: [] });
});

describe("OverridesPage filters", () => {
  it("clears the search and status filter in one click", async () => {
    render(
      <MemoryRouter>
        <OverridesPage />
      </MemoryRouter>
    );
    const clear = await screen.findByRole("button", { name: /^clear filters$/i });
    expect(clear).toBeDisabled();

    const status = screen.getByLabelText(/filter overrides by status/i);
    fireEvent.change(status, { target: { value: "approved" } });
    await waitFor(() => expect(svc.listCommercialOverrides).toHaveBeenLastCalledWith({ status: "approved" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "org.entity" } });

    const enabled = screen.getAllByRole("button", { name: /^clear filters$/i });
    expect(enabled[0]).toBeEnabled();
    // The empty table offers the same reset.
    expect(await screen.findByText(/no overrides match your filters/i)).toBeInTheDocument();

    fireEvent.click(enabled[0]);
    await waitFor(() => expect(status).toHaveValue(""));
    expect(screen.getByRole("searchbox")).toHaveValue("");
    await waitFor(() => expect(svc.listCommercialOverrides).toHaveBeenLastCalledWith({}));
    expect(screen.getAllByRole("button", { name: /^clear filters$/i })[0]).toBeDisabled();
  });
});

const DAY = 24 * 60 * 60 * 1000;
const pending = (id, requestedBy, expiresInDays) => ({
  id, organization_id: 9, entitlement_definition_id: 4, entitlement_key: `key.${id}`, value: 17,
  status: "pending_approval", requested_by_user_id: requestedBy, reason: "r",
  expires_at: new Date(Date.now() + expiresInDays * DAY).toISOString(),
});

function renderPage() {
  return render(
    <MemoryRouter>
      <OverridesPage />
    </MemoryRouter>
  );
}

describe("OverridesPage pending requests", () => {
  it("lets the submitter withdraw their own pending request", async () => {
    svc.listCommercialOverrides.mockResolvedValue({ overrides: [pending(1, 1, 5)] });
    svc.withdrawCommercialOverride.mockResolvedValue({});
    renderPage();
    const row = (await screen.findByText("key.1")).closest("tr");
    expect(within(row).getByText(/awaiting another admin/i)).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: /withdraw/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "submitted by mistake" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^withdraw$/i }));
    await waitFor(() => expect(svc.withdrawCommercialOverride).toHaveBeenCalledWith(1, "submitted by mistake"));
  });

  it("offers only Reject for a request that expired before approval", async () => {
    svc.listCommercialOverrides.mockResolvedValue({ overrides: [pending(2, 99, -3)] });
    renderPage();
    const row = (await screen.findByText("key.2")).closest("tr");
    expect(within(row).getByText(/expired before approval/i)).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /reject/i })).toBeInTheDocument();
  });

  it("shows a failed approval without hiding the table", async () => {
    svc.listCommercialOverrides.mockResolvedValue({ overrides: [pending(3, 99, 5)] });
    svc.approveCommercialOverride.mockRejectedValue(new Error("approval service down"));
    renderPage();
    const row = (await screen.findByText("key.3")).closest("tr");
    fireEvent.click(within(row).getByRole("button", { name: /approve/i }));
    const confirmDialog = await screen.findByRole("dialog");
    fireEvent.click(within(confirmDialog).getByRole("button", { name: /^approve$/i }));
    expect(await screen.findByText(/approval service down/i)).toBeInTheDocument();
    expect(screen.getByText("key.3")).toBeInTheDocument();
  });
});
