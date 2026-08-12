import React, { useEffect, useState } from "react";
import { NavLink, Navigate, Outlet, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Building2,
  Settings as SettingsIcon,
  LogOut,
} from "lucide-react";

import { apiFetch, clearSession, getStoredUser, setStoredUser } from "../api/client";

const NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/users", label: "Users", icon: Users },
  { to: "/organizations", label: "Organizations", icon: Building2 },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

export default function Layout() {
  const navigate = useNavigate();
  const [user, setUser] = useState(getStoredUser());

  useEffect(() => {
    apiFetch("/api/auth/me")
      .then((u) => {
        setStoredUser(u);
        setUser(u);
      })
      .catch(() => {});
  }, []);

  if (user && user.role && user.role !== "super_admin") {
    return <Navigate to="/portal" replace />;
  }

  function logout() {
    clearSession();
    navigate("/login", { replace: true });
  }

  return (
    <div className="min-h-screen flex">
      <aside className="w-64 bg-slate-900 text-slate-100 flex flex-col">
        <div className="px-6 py-5 border-b border-slate-800">
          <div className="text-lg font-bold text-white">Zoiko Billing</div>
          <div className="text-xs text-slate-400 mt-0.5">
            {user?.role === "super_admin" ? "Super Admin" : ""}
          </div>
        </div>
        <nav className="flex-1 py-4">
          {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-6 py-3 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-orange-500 text-white"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white"
                }`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="px-6 py-4 border-t border-slate-800">
          <div className="text-sm text-slate-200 truncate">{user?.email || "—"}</div>
          <div className="text-xs text-slate-400 mt-0.5">{user?.role || ""}</div>
          <button
            onClick={logout}
            className="mt-3 flex items-center gap-2 text-sm text-slate-300 hover:text-white"
          >
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </aside>
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
