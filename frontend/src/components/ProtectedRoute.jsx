import React from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";

import { getAccessToken, getStoredUser } from "../api/client";
import { ROLE_DEFAULT_REDIRECT } from "../config/roles";

const ROLE_PATH_RULES = {
  super_admin: () => true,
  org_admin: (pathname) =>
    pathname === "/organization-admin" ||
    pathname.startsWith("/organization-admin/") ||
    pathname === "/billing" ||
    pathname.startsWith("/billing/"),
  billing_admin: (pathname) =>
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
