import React from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";

import { getAccessToken, getStoredUser } from "../api/client";

const ROLE_PATH_RULES = {
  super_admin: () => true,
  org_admin: (pathname) =>
    pathname === "/portal" ||
    pathname === "/organization-admin" ||
    pathname.startsWith("/organization-admin/") ||
    pathname === "/billing" ||
    pathname.startsWith("/billing/"),
  billing_admin: (pathname) =>
    pathname === "/portal" ||
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
      return <Navigate to="/portal" replace />;
    }
  }
  return <Outlet />;
}
