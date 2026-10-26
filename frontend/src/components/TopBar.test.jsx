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
// bell on their own home page (QA bug #41). super_admin links to its own
// platform-scoped feed (/super-admin/notifications).

vi.mock("../context/AuthContext", () => ({
  useAuth: vi.fn(),
}));
vi.mock("../context/CommandCenterContext", () => ({
  useCommandCenter: vi.fn(() => null),
}));
vi.mock("../service/orgAdminService", () => ({
  getOrganizationDetails: vi.fn(() => new Promise(() => {})),
}));

import { useAuth } from "../context/AuthContext";
import { useCommandCenter } from "../context/CommandCenterContext";
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

  it.each([
    ["billing_admin", "/billing/workspace/notifications"],
    ["org_admin", "/organization-admin/notifications"],
  ])("is a real link to the notifications feed for %s", (role, expectedHref) => {
    useAuth.mockReturnValue({ user: { email: "a@b.com" }, role, logout: vi.fn() });
    renderTopBar();
    const link = screen.getByRole("link", { name: /notifications/i });
    expect(link).toHaveAttribute("href", expectedHref);
  });

  it("links super_admin to the platform notifications feed", () => {
    useAuth.mockReturnValue({ user: { email: "a@b.com" }, role: "super_admin", logout: vi.fn() });
    renderTopBar();
    const link = screen.getByRole("link", { name: /notifications/i });
    expect(link).toHaveAttribute("href", "/super-admin/notifications");
  });

  it("shows the real open attention-item count for super_admin", () => {
    useAuth.mockReturnValue({ user: { email: "a@b.com" }, role: "super_admin", logout: vi.fn() });
    useCommandCenter.mockReturnValue({ attentionCounts: { total_open: 3 } });
    renderTopBar();
    expect(screen.getByRole("link", { name: "Notifications (3 open)" })).toHaveTextContent("3");
  });

  it("is an honestly disabled placeholder for a role with no notifications feed", () => {
    useAuth.mockReturnValue({ user: { email: "a@b.com" }, role: "some_other_role", logout: vi.fn() });
    renderTopBar();
    const button = screen.getByRole("button", { name: /notifications/i });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("link", { name: /notifications/i })).not.toBeInTheDocument();
  });
});
