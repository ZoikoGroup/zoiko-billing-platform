import { useState, useRef, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell, ChevronDown, User, Building, LogOut, Menu, X, HelpCircle } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useCommandCenter } from "../context/CommandCenterContext";
import { ROLE_LABELS } from "../config/roles";
import ZoikoMark from "./ZoikoMark";
import { getOrganizationDetails } from "../service/orgAdminService";

const NOTIFICATIONS_ROUTE_BY_ROLE = {
  billing_admin: "/billing/workspace/notifications",
  org_admin: "/organization-admin/notifications",
  super_admin: "/super-admin/notifications",
};

function initialsOf(user) {
  if (!user) return "JD";
  if (user.name) {
    const parts = user.name.trim().split(/\s+/);
    return parts.slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  }
  if (user.email) return user.email.slice(0, 2).toUpperCase();
  return "U";
}

// Organization/workspace context — Plane 2 only (org_admin, billing_admin).
// Super Admin operates across organizations, not inside one, so it never
// renders here (see ProtectedRoute's ROLE_PATH_RULES for the same split).
const ORG_CONTEXT_ROLES = ["org_admin", "billing_admin"];

function OrgContext({ role }) {
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const showOrgContext = ORG_CONTEXT_ROLES.includes(role);

  useEffect(() => {
    if (!showOrgContext) return;
    let cancelled = false;
    setLoading(true);
    getOrganizationDetails()
      .then((data) => {
        if (!cancelled) setOrg(data);
      })
      .catch(() => {
        if (!cancelled) setOrg(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showOrgContext]);

  if (!showOrgContext) return null;

  const orgName = org?.name || org?.company_name || null;

  return (
    <div className="hidden md:flex min-w-0 items-center gap-3">
      <div className="h-7 w-px shrink-0 bg-gray-200" aria-hidden="true" />
      <div className="min-w-0 leading-tight">
        {loading ? (
          <div className="h-4 w-28 animate-pulse rounded bg-gray-100" />
        ) : (
          <p className="truncate text-sm font-semibold text-gray-800" title={orgName || undefined}>
            {orgName || "Organization"}
          </p>
        )}
        <p className="truncate text-[11px] font-medium text-gray-500">
          {ROLE_LABELS[role] || "Workspace"}
        </p>
      </div>
    </div>
  );
}

export default function TopBar({ menuOpen = false, onMenuClick, sidebarCollapsed = false, onAssistantClick }) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const { user, role, logout } = useAuth();
  const commandCenter = useCommandCenter({ required: false });
  const openAttention = role === "super_admin"
    ? (commandCenter?.attentionCounts?.unread ?? commandCenter?.attentionCounts?.total_open ?? 0)
    : 0;
  const navigate = useNavigate();

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Close dropdown on Escape
  useEffect(() => {
    const handleEscape = (event) => {
      if (event.key === "Escape") setIsDropdownOpen(false);
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, []);

  const closeDropdown = () => setIsDropdownOpen(false);

  const handleSignOut = () => {
    setIsDropdownOpen(false);
    logout();
    navigate("/login", { replace: true });
  };

  return (
    <header className={`fixed top-0 left-0 right-0 h-[65px] bg-white border-b border-gray-200 flex items-center justify-between gap-3 px-4 sm:px-6 z-50 shadow-sm transition-[left] ${sidebarCollapsed ? "lg:left-[76px]" : "lg:left-72"}`}>
      {/* Left: Brand + Organization/Workspace Context */}
      <div className="flex min-w-0 items-center gap-2">
        {onMenuClick && (
          <button
            type="button"
            onClick={onMenuClick}
            className="lg:hidden -ml-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-[#E5E0D9] bg-white text-[#6B6560] shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition hover:shadow-[0_8px_24px_rgba(0,0,0,0.06)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            aria-label="Toggle navigation"
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        )}
        <Link
          to={role === "super_admin" ? "/super-admin/dashboard" : "/billing"}
          className="flex shrink-0 items-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
        >
          <img src="/zoiko-billing-logo-sm.png" alt="Zoiko Billing" width="123" height="44" className="h-9 w-auto sm:h-11" />
        </Link>
        <OrgContext role={role} />
      </div>

      {/* Right: Actions & User Dropdown */}
      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        {/* AI assistant launcher, at every width. It used to float at the
            bottom-right of the page, where it covered list rows, footer
            actions and "Next"/"Record Payment" buttons as pages scrolled. */}
        {onAssistantClick && (
          <button
            type="button"
            onClick={onAssistantClick}
            aria-label="Open AI Billing Assistant"
            title="AI Billing Assistant"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-gray-100 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
          >
            <ZoikoMark size={30} rounded="rounded-md" showAccentDot />
          </button>
        )}

        {/* Help / support */}
        {role === "billing_admin" && (
          <Link
            to="/billing/workspace/help"
            className="hidden sm:inline-flex p-2 rounded-full text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            aria-label="Help and documentation"
          >
            <HelpCircle size={20} />
          </Link>
        )}

        {/* Notification Icon — links to each role's real (non-fabricated)
            notifications feed: the org-scoped billing feed for org_admin /
            billing_admin, and the platform feed (open attention items + audit
            events) for super_admin. The only badge is the real open
            attention-item count for super_admin; there is never a fake
            "unread" dot (ORG-01). Roles without a feed get an inert placeholder. */}
        {NOTIFICATIONS_ROUTE_BY_ROLE[role] ? (
          <Link
            to={NOTIFICATIONS_ROUTE_BY_ROLE[role]}
            className="relative p-3 sm:p-2 rounded-full text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            aria-label={openAttention > 0 ? `Notifications (${openAttention} open)` : "Notifications"}
          >
            <Bell size={20} />
            {openAttention > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
                {openAttention > 99 ? "99+" : openAttention}
              </span>
            )}
          </Link>
        ) : (
          <button
            type="button"
            disabled
            title="Notifications are not yet available for this workspace"
            aria-label="Notifications (not yet available)"
            className="p-3 sm:p-2 rounded-full text-gray-300 cursor-not-allowed"
          >
            <Bell size={20} />
          </button>
        )}

        {/* Divider */}
        <div className="hidden sm:block w-px h-7 bg-gray-200" />

        {/* User Menu Container */}
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setIsDropdownOpen((v) => !v)}
            className="flex items-center gap-3 p-1 sm:p-1.5 rounded-lg hover:bg-gray-50 transition-colors focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
            aria-haspopup="menu"
            aria-expanded={isDropdownOpen}
            aria-label="Open account menu"
          >
            {/* User Avatar */}
            <div className="w-9 h-9 shrink-0 rounded-full bg-gradient-to-br from-[#1a0933] to-purple-800 text-white font-semibold text-sm flex items-center justify-center">
              {initialsOf(user)}
            </div>

            {/* User Details & Role Badge — collapses on narrow viewports */}
            <div className="hidden flex-col items-start text-left sm:flex">
              <span className="text-sm font-semibold text-gray-800 leading-tight">
                {user?.name || user?.email || "User"}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wider bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded mt-0.5">
                {role ? ROLE_LABELS[role] || role : "User"}
              </span>
            </div>

            <ChevronDown size={16} className="hidden text-gray-400 sm:block" />
          </button>

          {/* Dropdown Menu */}
          {isDropdownOpen && (
            <div className="absolute right-0 top-full mt-2 w-56 bg-white border border-gray-200 rounded-xl shadow-lg p-1.5 flex flex-col gap-1 z-50">
              {role === "super_admin" ? null : role === "billing_admin" ? (
                <>
                  <Link
                    to="/billing/workspace/organization"
                    onClick={closeDropdown}
                    className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    <Building size={16} /> Organization Profile
                  </Link>
                  <Link
                    to="/billing/settings"
                    onClick={closeDropdown}
                    className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    <User size={16} /> Billing Settings
                  </Link>
                </>
              ) : (
                // org_admin (and other org-scoped roles without a surface of
                // their own): there is no standalone user-profile page in
                // this app — never route a non-super_admin user to "/settings"
                // (a Super Admin legacy redirect).
                <Link
                  to="/organization-admin/organization"
                  onClick={closeDropdown}
                  className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <Building size={16} /> Organization
                </Link>
              )}

              {role !== "super_admin" && <div className="h-px bg-gray-100 my-1" />}

              {/* Sign Out Action */}
              <button
                onClick={handleSignOut}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-600 rounded-lg hover:bg-red-50 transition-colors font-medium text-left"
              >
                <LogOut size={16} /> Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
