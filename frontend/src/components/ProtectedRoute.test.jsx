import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

vi.mock("../api/client", () => ({
  getAccessToken: () => "fake-token",
  getStoredUser: vi.fn(),
}));

import { getStoredUser } from "../api/client";
import ProtectedRoute from "./ProtectedRoute";

// A super_admin token has no organization_id — the Organization Admin
// surface (/organization-admin/*) assumes exactly one, and its endpoints
// reject super_admin callers server-side with "Super Admin must use
// get_super_admin_organization_id() to explicitly select an organization."
// This guards the fix: super_admin must never be routed onto that surface.
describe("ProtectedRoute — super_admin cannot reach the Organization Admin surface", () => {
  it("redirects away from /organization-admin/users to the super admin's default page", () => {
    getStoredUser.mockReturnValue({ role: "super_admin", email: "sa@zoiko.com" });

    render(
      <MemoryRouter initialEntries={["/organization-admin/users"]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/organization-admin/users" element={<div>ORG ADMIN USERS PAGE</div>} />
          </Route>
          <Route path="/dashboard" element={<div>SUPER ADMIN DASHBOARD</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("SUPER ADMIN DASHBOARD")).toBeInTheDocument();
    expect(screen.queryByText("ORG ADMIN USERS PAGE")).not.toBeInTheDocument();
  });

  it("still allows super_admin into its own Administrators & Users page", () => {
    getStoredUser.mockReturnValue({ role: "super_admin", email: "sa@zoiko.com" });

    render(
      <MemoryRouter initialEntries={["/super-admin/users"]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/super-admin/users" element={<div>SUPER ADMIN USERS PAGE</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("SUPER ADMIN USERS PAGE")).toBeInTheDocument();
  });

  it("still allows an org_admin into their own Organization Admin surface", () => {
    getStoredUser.mockReturnValue({ role: "org_admin", email: "oa@acme.com" });

    render(
      <MemoryRouter initialEntries={["/organization-admin/users"]}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/organization-admin/users" element={<div>ORG ADMIN USERS PAGE</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("ORG ADMIN USERS PAGE")).toBeInTheDocument();
  });
});
