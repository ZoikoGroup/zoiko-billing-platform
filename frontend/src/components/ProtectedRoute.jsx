import React from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";

import { getAccessToken, getStoredUser } from "../api/client";

export default function ProtectedRoute() {
  const location = useLocation();
  if (!getAccessToken()) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  const user = getStoredUser();
  if (user?.role && user.role !== "super_admin") {
    const { pathname } = location;
    const allowed =
      pathname === "/portal" ||
      pathname === "/billing" ||
      pathname.startsWith("/billing/") ||
      pathname.startsWith("/organization-admin/");
    if (!allowed) {
      return <Navigate to="/portal" replace />;
    }
  }
  return <Outlet />;
}
