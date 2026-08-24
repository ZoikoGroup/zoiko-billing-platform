import React from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";

import { getAccessToken, getStoredUser } from "../api/client";
import { ROLE_DEFAULT_REDIRECT } from "../config/roles";

const ROLE_PATH_RULES = {
  // Super Admin belongs to no single organization. The Organization Admin
  // surface (/organization-admin/*) assumes exactly one — its endpoints
  // call get_organization_id(), which rejects a super_admin token outright
  // ("Super Admin must use get_super_admin_organization_id() to explicitly
  // select an organization"). Rather than let a super_admin land on a page
  // that's guaranteed to crash, route them to their own equivalent tooling
  // (Super Admin → Platform → Administrators & Users, Organizations, etc.).
  super_admin: (pathname) =>
    pathname !== "/organization-admin" && !pathname.startsWith("/organization-admin/"),
  org_admin: (pathname) =>
    pathname === "/organization-admin" ||
    pathname.startsWith("/organization-admin/") ||
    pathname === "/billing" ||
    pathname.startsWith("/billing/"),
  billing_admin: (pathname) =>
    pathname === "/billing" ||
    pathname.startsWith("/billing/"),
  // Finance Approver and Auditor are billing-plane roles with no organization
  // or super-admin surface of their own — server-side dependencies
  // (get_current_finance_approver / get_current_auditor_or_above) gate the
  // specific mutations/reads each can perform within /billing/*.
  finance_approver: (pathname) =>
    pathname === "/billing" ||
    pathname.startsWith("/billing/"),
  auditor: (pathname) =>
    pathname === "/billing" ||
    pathname.startsWith("/billing/"),
};

export default function ProtectedRoute() {
  const location = useLocation();
  if (!getAccessToken()) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  const user = getStoredUser();
  const role = user?.role;
  if (role && ROLE_PATH_RULES[role]) {
    const isAllowed = ROLE_PATH_RULES[role](location.pathname);
    if (!isAllowed) {
      return <Navigate to={ROLE_DEFAULT_REDIRECT[role] || "/login"} replace />;
    }
  }
  return <Outlet />;
}
