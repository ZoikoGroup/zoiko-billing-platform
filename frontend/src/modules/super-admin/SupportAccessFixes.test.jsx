import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SupportAccessPage from "./SupportAccessPage";

// Regression tests for the Support Access (JIT privileged access) fixes.

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("../../context/AuthContext", () => ({ useAuth }));

const { useCommandCenter } = vi.hoisted(() => ({ useCommandCenter: vi.fn() }));
vi.mock("../../context/CommandCenterContext", () => ({ useCommandCenter }));

vi.mock("../../hooks/useIsDesktopViewport", () => ({ default: () => true }));

vi.mock("../../service/privilegedAccessService", () => ({
  getActivePrivilegedAccess: vi.fn(),
  listMyPrivilegedAccess: vi.fn(),
  getPrivilegedAccessTenantSummary: vi.fn(),
  getSupportAccessCredentials: vi.fn(),
  searchOrganizations: vi.fn(),
  requestPrivilegedAccess: vi.fn(),
  exitPrivilegedAccess: vi.fn(),
  cancelPrivilegedAccess: vi.fn(),
  listLivePrivilegedAccess: vi.fn(),
  revokePrivilegedAccess: vi.fn(),
  openBreakGlass: vi.fn(),
  reviewBreakGlass: vi.fn(),
  listPendingReviews: vi.fn(),
}));

import * as service from "../../service/privilegedAccessService";

const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString().replace("Z", "");

function asRole(platform_role, id = 1) {
  useAuth.mockReturnValue({ user: { id, email: "op@zoiko.com", platform_role }, role: "super_admin", isAuthenticated: true });
}

function renderPage(path = "/super-admin/support-access") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SupportAccessPage />
    </MemoryRouter>
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const pendingGrant = {
  id: 101,
  organization_id: 1,
  organization_name: "Acme Corp",
  organization_code: "ACM",
  ticket_reference: "SUP-101",
  reason: "Database maintenance",
  requested_minutes: 30,
  status: "pending_approval",
  requested_by_user_id: 1,
  requested_at: inMinutes(-2),
  approval_expires_at: inMinutes(58),
  awaiting_tenant_approval: true,
  is_break_glass: false,
};

let shell;

beforeEach(() => {
  vi.clearAllMocks();
  asRole("support_operator");
  shell = { activeGrant: null, refresh: vi.fn(), clearActiveGrant: vi.fn() };
  useCommandCenter.mockImplementation(() => shell);
  service.getActivePrivilegedAccess.mockResolvedValue(null);
  service.listMyPrivilegedAccess.mockResolvedValue({ grants: [] });
  service.listLivePrivilegedAccess.mockResolvedValue({ grants: [] });
  service.listPendingReviews.mockResolvedValue({ grants: [] });
});

async function confirmCancel() {
  fireEvent.click(await screen.findByRole("button", { name: /cancel request/i }));
  const buttons = await screen.findAllByRole("button", { name: /cancel request/i });
  fireEvent.click(buttons[buttons.length - 1]);
}

describe("SupportAccessPage fixes", () => {
  it("a failed cancel stays inline and keeps the history instead of the full-page load error", async () => {
    service.listMyPrivilegedAccess.mockResolvedValueOnce({ grants: [pendingGrant] });
    service.cancelPrivilegedAccess.mockRejectedValue(
      new Error("Only a request that is not yet active can be cancelled (status: expired_unused).")
    );
    // The re-read after the failure shows the request lapsed in the meantime.
    service.listMyPrivilegedAccess.mockResolvedValue({ grants: [{ ...pendingGrant, status: "expired_unused", awaiting_tenant_approval: false }] });

    renderPage();
    await confirmCancel();

    expect(await screen.findByText(/can be cancelled \(status: expired_unused\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/Unable to load support access/i)).not.toBeInTheDocument();
    // The page re-read the grant so it reflects the real state now.
    await waitFor(() => expect(service.getActivePrivilegedAccess).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/No one approved it within 60 minutes/i)).toBeInTheDocument();
    expect(screen.getByText("No active support session")).toBeInTheDocument();
  });

  it("ignores an older in-flight read that lands after a newer one (no resurrected request)", async () => {
    service.listMyPrivilegedAccess.mockResolvedValueOnce({ grants: [pendingGrant] });
    renderPage();
    await screen.findByText("Waiting for Acme Corp to approve");

    // "Check now" starts a read that hangs...
    const slow = deferred();
    service.getActivePrivilegedAccess.mockReturnValueOnce(slow.promise);
    service.listMyPrivilegedAccess.mockResolvedValueOnce({ grants: [pendingGrant] });
    fireEvent.click(screen.getByRole("button", { name: /check now/i }));

    // ...then the operator cancels; the post-cancel read says it is gone.
    service.cancelPrivilegedAccess.mockResolvedValue({ ...pendingGrant, status: "revoked" });
    service.getActivePrivilegedAccess.mockResolvedValue(null);
    service.listMyPrivilegedAccess.mockResolvedValue({
      grants: [{ ...pendingGrant, status: "revoked", revoked_by_user_id: 1, awaiting_tenant_approval: false }],
    });
    await confirmCancel();
    expect(await screen.findByText("You cancelled this request.")).toBeInTheDocument();

    // The stale read finally resolves with the old pending grant.
    slow.resolve(pendingGrant);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Waiting for Acme Corp to approve")).not.toBeInTheDocument();
  });

  it("a revoker revoking their own ACTIVE session is shown as revoked, not 'cancelled'", async () => {
    service.listMyPrivilegedAccess.mockResolvedValue({
      grants: [
        {
          ...pendingGrant,
          status: "revoked",
          awaiting_tenant_approval: false,
          activated_at: inMinutes(-10),
          revoked_by_user_id: 1,
          revoke_reason: "Done early",
        },
        { ...pendingGrant, id: 102, status: "denied", awaiting_tenant_approval: false, approval_note: "Not today" },
      ],
    });
    renderPage();

    expect(await screen.findByText("Revoked: Done early")).toBeInTheDocument();
    expect(screen.queryByText("You cancelled this request.")).not.toBeInTheDocument();
    expect(screen.getByText("Declined by the organisation's admin: Not today")).toBeInTheDocument();
  });

  it("never prints 'null' when organization_name is missing", async () => {
    service.listMyPrivilegedAccess.mockResolvedValue({ grants: [{ ...pendingGrant, organization_name: null }] });
    renderPage();

    expect(await screen.findByText("Waiting for Organization #1 to approve")).toBeInTheDocument();
    expect(screen.queryByText(/null/)).not.toBeInTheDocument();
  });

  it("asks the shell to re-read when its active grant disagrees with the page's fresher read", async () => {
    shell.activeGrant = { id: 103, organization_name: "Acme Corp", status: "active", expires_at: inMinutes(10) };
    service.getSupportAccessCredentials.mockRejectedValue(new Error("This privileged access session is not active (status: revoked)."));
    service.getPrivilegedAccessTenantSummary.mockRejectedValue(new Error("not active"));
    renderPage();

    await waitFor(() => expect(shell.refresh).toHaveBeenCalled());
  });

  it("ending a session clears the shell's grant immediately", async () => {
    shell.activeGrant = { id: 103, organization_name: "Acme Corp", status: "active", expires_at: inMinutes(10) };
    service.getActivePrivilegedAccess.mockResolvedValue(shell.activeGrant);
    service.getSupportAccessCredentials.mockReturnValue(new Promise(() => {}));
    service.getPrivilegedAccessTenantSummary.mockReturnValue(new Promise(() => {}));
    service.exitPrivilegedAccess.mockResolvedValue({ ...shell.activeGrant, status: "exited" });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /end session/i }));
    const buttons = await screen.findAllByRole("button", { name: /end session/i });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(service.exitPrivilegedAccess).toHaveBeenCalledWith(103));
    await waitFor(() => expect(shell.clearActiveGrant).toHaveBeenCalled());
  });

  it("a failed revoke keeps the live list on screen and refreshes it", async () => {
    asRole("security_operator");
    const activeRow = { ...pendingGrant, status: "active", awaiting_tenant_approval: false, expires_at: inMinutes(10), requested_by_email: "supp@zoiko.com" };
    service.listLivePrivilegedAccess.mockResolvedValueOnce({ grants: [activeRow] });
    service.revokePrivilegedAccess.mockRejectedValue(new Error("Grant cannot be revoked in status expired."));
    service.listLivePrivilegedAccess.mockRejectedValue(new Error("Network down"));

    renderPage("/super-admin/support-access?tab=live");

    fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
    fireEvent.change(await screen.findByLabelText(/reason for revoking/i), { target: { value: "Ticket closed" } });
    fireEvent.click(screen.getByRole("button", { name: /revoke now/i }));

    // Error shown in the (still open) modal...
    expect(await screen.findByText("Grant cannot be revoked in status expired.")).toBeInTheDocument();
    // ...the list was re-requested, and its failure is inline with the row kept.
    await waitFor(() => expect(service.listLivePrivilegedAccess).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Couldn't refresh live sessions")).toBeInTheDocument();
    expect(screen.getAllByText("Acme Corp").length).toBeGreaterThan(0);
    expect(screen.queryByText("Unable to load live sessions")).not.toBeInTheDocument();
    expect(screen.getByText("1 active")).toBeInTheDocument();
  });

  it("a failed review refresh keeps pending reviews visible", async () => {
    asRole("auditor");
    const bg = { ...pendingGrant, id: 200, status: "active", is_break_glass: true, awaiting_tenant_approval: false, requested_by_user_id: 9, review_due_at: inMinutes(600) };
    service.listPendingReviews.mockResolvedValueOnce({ grants: [bg] });
    service.reviewBreakGlass.mockRejectedValue(new Error("This break-glass session has already been reviewed."));
    service.listPendingReviews.mockRejectedValue(new Error("Network down"));

    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /^review$/i }));
    fireEvent.change(screen.getByLabelText(/findings/i), { target: { value: "Looked fine" } });
    fireEvent.click(screen.getByRole("button", { name: /submit review/i }));

    expect(await screen.findByText("This break-glass session has already been reviewed.")).toBeInTheDocument();
    expect(await screen.findByText("Couldn't refresh reviews")).toBeInTheDocument();
    expect(screen.queryByText("Unable to load reviews")).not.toBeInTheDocument();
  });

  it("the request form rejects whitespace-only reason submitted with Enter", async () => {
    service.searchOrganizations.mockResolvedValue({ organizations: [{ id: 1, organization_name: "Acme Corp", organization_code: "ACM" }], total: 1 });
    renderPage();

    const [openBtn] = await screen.findAllByRole("button", { name: /request access/i });
    fireEvent.click(openBtn);
    fireEvent.click(await screen.findByRole("option", { name: /Acme Corp/i }));
    fireEvent.change(screen.getByLabelText(/why do you need access/i), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText(/ticket \/ incident reference/i), { target: { value: "SUP-1" } });
    fireEvent.submit(screen.getByLabelText(/ticket \/ incident reference/i).closest("form"));

    expect(await screen.findByText(/fill in both the reason and the ticket reference/i)).toBeInTheDocument();
    expect(service.requestPrivilegedAccess).not.toHaveBeenCalled();
  });

  it("tells the operator when the organisation search is truncated", async () => {
    service.searchOrganizations.mockResolvedValue({
      organizations: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, organization_name: `Org ${i + 1}`, organization_code: `O${i + 1}` })),
      total: 57,
    });
    renderPage();

    const [openBtn] = await screen.findAllByRole("button", { name: /request access/i });
    fireEvent.click(openBtn);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/Showing 20 of 57 organizations/i)).toBeInTheDocument();
  });
});
