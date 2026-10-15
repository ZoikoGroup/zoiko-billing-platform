import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import PrivilegedAccessLogPage from "./PrivilegedAccessLogPage";

vi.mock("../../service/privilegedAccessService", () => ({
  getPrivilegedAccessLog: vi.fn(),
  tenantRevokePrivilegedAccess: vi.fn(),
  tenantApprovePrivilegedAccess: vi.fn(),
  tenantDenyPrivilegedAccess: vi.fn(),
}));

import * as privService from "../../service/privilegedAccessService";

const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString().replace("Z", "");

const pending = {
  id: 7,
  correlation_id: "corr-7",
  status: "pending_approval",
  is_break_glass: false,
  reason: "Invoice total looks wrong",
  ticket_reference: "SUP-7",
  requested_minutes: 15,
  requested_at: inMinutes(-1),
  approval_expires_at: inMinutes(59),
};

describe("PrivilegedAccessLogPage (org admin approves support access)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    privService.getPrivilegedAccessLog.mockResolvedValue({ entries: [] });
  });

  it("shows pending requests with Approve and Decline", async () => {
    privService.getPrivilegedAccessLog.mockResolvedValue({ entries: [pending] });
    render(<PrivilegedAccessLogPage />);

    expect(await screen.findByText("“Invoice total looks wrong”")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /decline/i })).toBeInTheDocument();
  });

  it("approving issues access for the requested minutes", async () => {
    privService.getPrivilegedAccessLog.mockResolvedValue({ entries: [pending] });
    privService.tenantApprovePrivilegedAccess.mockResolvedValue({});
    render(<PrivilegedAccessLogPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
    expect(screen.getByText(/temporary, read-only login to your organisation for 15 minutes/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /approve access/i }));

    await waitFor(() => expect(privService.tenantApprovePrivilegedAccess).toHaveBeenCalledWith(7, { note: undefined }));
    expect(await screen.findByText(/read-only access for 15 minutes/i)).toBeInTheDocument();
  });

  it("declining requires a reason", async () => {
    privService.getPrivilegedAccessLog.mockResolvedValue({ entries: [pending] });
    privService.tenantDenyPrivilegedAccess.mockResolvedValue({});
    render(<PrivilegedAccessLogPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^decline$/i }));
    const submit = screen.getByRole("button", { name: /decline request/i });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Not expected" } });
    fireEvent.click(submit);

    await waitFor(() => expect(privService.tenantDenyPrivilegedAccess).toHaveBeenCalledWith(7, { note: "Not expected" }));
  });

  it("shows active access with the temporary login and lets the admin revoke it", async () => {
    privService.getPrivilegedAccessLog.mockResolvedValue({
      entries: [
        {
          ...pending,
          status: "active",
          is_break_glass: true,
          expires_at: inMinutes(10),
          activated_at: inMinutes(-5),
          support_username: "support-7-abc@support-access.zoikobilling.com",
        },
      ],
    });
    privService.tenantRevokePrivilegedAccess.mockResolvedValue({});
    render(<PrivilegedAccessLogPage />);

    expect(await screen.findByText("support-7-abc@support-access.zoikobilling.com")).toBeInTheDocument();
    expect(screen.getByText("Emergency access")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /revoke now/i }));
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Done" } });
    fireEvent.click(screen.getAllByRole("button", { name: /revoke now/i }).at(-1));

    await waitFor(() => expect(privService.tenantRevokePrivilegedAccess).toHaveBeenCalledWith(7, { reason: "Done" }));
  });

  it("shows history with outcomes", async () => {
    privService.getPrivilegedAccessLog.mockResolvedValue({
      entries: [{ ...pending, status: "denied", decision_note: "Not expected" }],
    });
    render(<PrivilegedAccessLogPage />);

    expect(await screen.findByText("Declined")).toBeInTheDocument();
    expect(screen.getByText("Note: Not expected")).toBeInTheDocument();
  });
});
