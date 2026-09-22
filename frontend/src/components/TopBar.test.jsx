import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// ORG-01: the notification bell used to always render a hardcoded orange
// "unread" dot regardless of whether any notification had ever been
// fetched (in fact nothing was ever fetched -- no onClick, no API call).
// That's a fabricated indicator, not a real one. This locks in the fix:
// no fake unread state, and the bell is a real link for org_admin and
// billing_admin -- the two roles whose org-scoped billing permissions the
// notifications feed (WorkspaceNotificationsPage) actually relies on. A
// billing_admin-only gate previously left org_admin -- the default landing
// role for /organization-admin/dashboard -- with a permanently disabled
// bell on their own home page (QA bug #41).

vi.mock("../context/AuthContext", () => ({
  useAuth: vi.fn(),
}));
vi.mock("../service/orgAdminService", () => ({
  getOrganizationDetails: vi.fn(() => new Promise(() => {})),
}));

import { useAuth } from "../context/AuthContext";
import TopBar from "./TopBar";

function renderTopBar() {
  return render(
    <MemoryRouter>
      <TopBar />
    </MemoryRouter>
  );
}

describe("TopBar notification icon", () => {
  it("never renders a fake unread indicator", () => {
    useAuth.mockReturnValue({ user: { email: "a@b.com" }, role: "org_admin", logout: vi.fn() });
    const { container } = renderTopBar();
    expect(container.querySelector(".bg-\\[\\#ff6b00\\]")).not.toBeInTheDocument();
  });

  it.each(["billing_admin", "org_admin"])("is a real link to the notifications feed for %s", (role) => {
    useAuth.mockReturnValue({ user: { email: "a@b.com" }, role, logout: vi.fn() });
    renderTopBar();
    const link = screen.getByRole("link", { name: /notifications/i });
    expect(link).toHaveAttribute("href", "/billing/workspace/notifications");
  });

  it("is an honestly disabled placeholder for roles with no notifications feed", () => {
    useAuth.mockReturnValue({ user: { email: "a@b.com" }, role: "finance_approver", logout: vi.fn() });
    renderTopBar();
    const button = screen.getByRole("button", { name: /notifications/i });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("link", { name: /notifications/i })).not.toBeInTheDocument();
  });
});
