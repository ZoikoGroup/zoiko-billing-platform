import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// ORG-01: the notification bell used to always render a hardcoded orange
// "unread" dot regardless of whether any notification had ever been
// fetched (in fact nothing was ever fetched -- no onClick, no API call).
// That's a fabricated indicator, not a real one. This locks in the fix:
// no fake unread state, and the bell only becomes a real link for a role
// that has an actual (non-fabricated) notifications feed behind it —
// billing_admin, org_admin and super_admin each have one now.

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

  it("is a real link to the notifications feed for billing_admin", () => {
    useAuth.mockReturnValue({ user: { email: "a@b.com" }, role: "billing_admin", logout: vi.fn() });
    renderTopBar();
    const link = screen.getByRole("link", { name: /notifications/i });
    expect(link).toHaveAttribute("href", "/billing/workspace/notifications");
  });

  it("is a real link to the notifications feed for org_admin", () => {
    useAuth.mockReturnValue({ user: { email: "a@b.com" }, role: "org_admin", logout: vi.fn() });
    renderTopBar();
    const link = screen.getByRole("link", { name: /notifications/i });
    expect(link).toHaveAttribute("href", "/organization-admin/notifications");
  });

  it("is a real link to the notifications feed for super_admin", () => {
    useAuth.mockReturnValue({ user: { email: "a@b.com" }, role: "super_admin", logout: vi.fn() });
    renderTopBar();
    const link = screen.getByRole("link", { name: /notifications/i });
    expect(link).toHaveAttribute("href", "/super-admin/notifications");
  });

  it("is an honestly disabled placeholder for a role with no notifications feed", () => {
    useAuth.mockReturnValue({ user: { email: "a@b.com" }, role: "some_other_role", logout: vi.fn() });
    renderTopBar();
    const button = screen.getByRole("button", { name: /notifications/i });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("link", { name: /notifications/i })).not.toBeInTheDocument();
  });
});
