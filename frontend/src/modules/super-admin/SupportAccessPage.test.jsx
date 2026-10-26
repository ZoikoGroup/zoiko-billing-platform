import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SupportAccessPage, { parseServerTime } from "./SupportAccessPage";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("../../context/AuthContext", () => ({ useAuth }));

const { useCommandCenter } = vi.hoisted(() => ({ useCommandCenter: vi.fn() }));
vi.mock("../../context/CommandCenterContext", () => ({ useCommandCenter }));

vi.mock("../../hooks/useIsDesktopViewport", () => ({
  default: () => true,
}));

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
  useAuth.mockReturnValue({
    user: { id, email: "op@zoiko.com", platform_role },
    role: "super_admin",
    isAuthenticated: true,
  });
}

function renderPage(path = "/super-admin/support-access") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SupportAccessPage />
    </MemoryRouter>
  );
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
  requested_at: inMinutes(-2),
  approval_expires_at: inMinutes(58),
  is_break_glass: false,
};

describe("SupportAccessPage (ZB-SEC-PRIV-001)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asRole("security_operator");
    useCommandCenter.mockReturnValue({ activeGrant: null, refresh: vi.fn(), clearActiveGrant: vi.fn() });
    service.getActivePrivilegedAccess.mockResolvedValue(null);
    service.listMyPrivilegedAccess.mockResolvedValue({ grants: [] });
    service.listLivePrivilegedAccess.mockResolvedValue({ grants: [] });
    service.listPendingReviews.mockResolvedValue({ grants: [] });
  });

  it("parses naive server timestamps as UTC", () => {
    expect(parseServerTime("2026-10-15T10:00:00").toISOString()).toBe("2026-10-15T10:00:00.000Z");
    expect(parseServerTime("2026-10-15T10:00:00+05:30").toISOString()).toBe("2026-10-15T04:30:00.000Z");
    expect(parseServerTime(null)).toBeNull();
  });

  it("shows a pending request with a countdown and no Activate button", async () => {
    asRole("support_operator");
    service.listMyPrivilegedAccess.mockResolvedValue({ grants: [pendingGrant] });

    renderPage();

    expect(await screen.findByText("Waiting for Acme Corp to approve")).toBeInTheDocument();
    expect(screen.getByText(/organisation's admins have been emailed/i)).toBeInTheDocument();
    expect(screen.getByText(/Request expires in/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /activate access/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel request/i })).toBeInTheDocument();
  });

  it("cancels through the requester-owned cancel endpoint, not revoke", async () => {
    asRole("support_operator");
    service.listMyPrivilegedAccess.mockResolvedValue({ grants: [pendingGrant] });
    service.cancelPrivilegedAccess.mockResolvedValue({ ...pendingGrant, status: "revoked" });

    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /cancel request/i }));
    // Confirmation dialog
    const confirmButtons = await screen.findAllByRole("button", { name: /cancel request/i });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => expect(service.cancelPrivilegedAccess).toHaveBeenCalledWith(101));
    expect(service.revokePrivilegedAccess).not.toHaveBeenCalled();
  });

  it("renders the active break-glass session with a readable summary", async () => {
    useCommandCenter.mockReturnValue({
      activeGrant: {
        id: 103,
        organization_name: "Acme Corp",
        organization_code: "ACM",
        ticket_reference: "INC-999",
        status: "active",
        expires_at: inMinutes(20),
        is_break_glass: true,
      },
      refresh: vi.fn(),
      clearActiveGrant: vi.fn(),
    });
    service.getSupportAccessCredentials.mockResolvedValue({
      grant_id: 103,
      username: "support-103-abc123@support-access.zoikobilling.com",
      password: "Xy7!secretPass9",
      login_url: "http://localhost:5173/login",
      role: "auditor",
      access: "Read-only",
      expires_at: inMinutes(20),
    });
    service.getPrivilegedAccessTenantSummary.mockResolvedValue({
      customer_summary: { total_active_customers: 42, by_status: { active: 40, inactive: 2 } },
      subscription_summary: { total_active_subscriptions: 10 },
      invoice_summary: { total_invoices: 7, total_amount: 1234.5, paid_count: 5, paid_amount: 1000, overdue_count: 1, overdue_amount: 34.5, sent_count: 1, draft_count: 0 },
    });

    renderPage();

    expect(await screen.findByText("Emergency Access")).toBeInTheDocument();
    expect(screen.getByText("Active session · Acme Corp")).toBeInTheDocument();
    expect(await screen.findByText("42")).toBeInTheDocument();
    expect(screen.getByText("Total value 1,234.50")).toBeInTheDocument();
    expect(screen.queryByText(/\{"count"/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /end session/i })).toBeInTheDocument();

    // Temporary login: user ID visible, password hidden until revealed.
    expect(await screen.findByText("support-103-abc123@support-access.zoikobilling.com")).toBeInTheDocument();
    expect(screen.queryByText("Xy7!secretPass9")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /show password/i }));
    expect(screen.getByText("Xy7!secretPass9")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open login page/i })).toHaveAttribute("href", "http://localhost:5173/login");
  });

  it("gives security operators live sessions and reviews tabs, with no platform approval queue", async () => {
    service.listLivePrivilegedAccess.mockResolvedValue({ grants: [{ ...pendingGrant, requested_by_email: "supp@zoiko.com" }] });

    renderPage();

    await waitFor(() => expect(screen.getByRole("tab", { name: /live sessions\s*1/i })).toBeInTheDocument());
    expect(screen.queryByRole("tab", { name: /approvals/i })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /break-glass reviews/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /break-glass access/i })).toBeInTheDocument();
  });

  it("lets revokers revoke a live session with a reason", async () => {
    service.listLivePrivilegedAccess.mockResolvedValue({
      grants: [{ ...pendingGrant, status: "active", expires_at: inMinutes(10), requested_by_email: "supp@zoiko.com" }],
    });
    service.revokePrivilegedAccess.mockResolvedValue({});

    renderPage("/super-admin/support-access?tab=live");

    fireEvent.click(await screen.findByRole("button", { name: /^revoke$/i }));
    fireEvent.change(await screen.findByLabelText(/reason for revoking/i), { target: { value: "Ticket closed" } });
    fireEvent.click(screen.getByRole("button", { name: /revoke now/i }));

    await waitFor(() =>
      expect(service.revokePrivilegedAccess).toHaveBeenCalledWith(101, { reason: "Ticket closed" })
    );
  });

  it("auditors land on reviews and never call own-grant endpoints", async () => {
    asRole("auditor");

    renderPage();

    expect(await screen.findByText(/No emergency sessions awaiting review/i)).toBeInTheDocument();
    expect(service.getActivePrivilegedAccess).not.toHaveBeenCalled();
    expect(service.listMyPrivilegedAccess).not.toHaveBeenCalled();
  });

  it("explains when the role has no support-access capability", async () => {
    asRole("reliability_operator");

    renderPage();

    expect(await screen.findByText(/Your role can't use support access/i)).toBeInTheDocument();
  });
});
