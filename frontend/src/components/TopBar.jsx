import { useState, useRef, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Bell, ChevronDown, User, Building, LogOut, Menu, X } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { ROLE_LABELS } from "../config/roles";

function initialsOf(user) {
  if (!user) return "JD";
  if (user.name) {
    const parts = user.name.trim().split(/\s+/);
    return parts.slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  }
  if (user.email) return user.email.slice(0, 2).toUpperCase();
  return "U";
}

export default function TopBar({ menuOpen = false, onMenuClick }) {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const { user, role, logout } = useAuth();
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

  const closeDropdown = () => setIsDropdownOpen(false);

  const handleSignOut = () => {
    setIsDropdownOpen(false);
    logout();
    navigate("/login", { replace: true });
  };

  return (
    <header className="fixed top-0 left-0 right-0 lg:left-72 h-[65px] bg-white border-b border-gray-200 flex items-center justify-between px-6 z-50 shadow-sm">
      {/* Left: Brand Logo */}
      <div className="flex items-center gap-2">
        {onMenuClick && (
          <button
            type="button"
            onClick={onMenuClick}
            className="lg:hidden -ml-2 inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-[#E5E0D9] bg-white text-[#6B6560] shadow-[0_1px_3px_rgba(0,0,0,0.04)] transition hover:shadow-[0_8px_24px_rgba(0,0,0,0.06)]"
            aria-label="Toggle navigation"
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        )}
        <Link
          to={role === "super_admin" ? "/super-admin/dashboard" : "/billing"}
          className="text-xl font-extrabold text-[#1a0933] tracking-tight"
        >
          Zoiko<span className="text-[#ff6b00]">Billing</span>
        </Link>
      </div>

      {/* Right: Actions & User Dropdown */}
      <div className="flex items-center gap-4">
        {/* Notification Icon */}
        <button
          className="relative p-2 rounded-full text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors"
          aria-label="Notifications"
        >
          <Bell size={20} />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-[#ff6b00] rounded-full border-2 border-white" />
        </button>

        {/* Divider */}
        <div className="w-px h-7 bg-gray-200" />

        {/* User Menu Container */}
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="flex items-center gap-3 p-1.5 rounded-lg hover:bg-gray-50 transition-colors focus:outline-none"
          >
            {/* User Avatar */}
            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#1a0933] to-purple-800 text-white font-semibold text-sm flex items-center justify-center">
              {initialsOf(user)}
            </div>

            {/* User Details & Role Badge */}
            <div className="flex flex-col items-start text-left">
              <span className="text-sm font-semibold text-gray-800 leading-tight">
                {user?.name || user?.email || "User"}
              </span>
              <span className="text-[10px] font-bold uppercase tracking-wider bg-purple-100 text-purple-800 px-1.5 py-0.5 rounded mt-0.5">
                {role ? ROLE_LABELS[role] || role : "User"}
              </span>
            </div>

            <ChevronDown size={16} className="text-gray-400" />
          </button>

          {/* Dropdown Menu */}
          {isDropdownOpen && (
            <div className="absolute right-0 top-full mt-2 w-56 bg-white border border-gray-200 rounded-xl shadow-lg p-1.5 flex flex-col gap-1 z-50">
              {role === "super_admin" ? (
                <Link
                  to="/super-admin/settings"
                  onClick={closeDropdown}
                  className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <User size={16} /> Platform Settings
                </Link>
              ) : (
                <>
                  <Link
                    to="/settings"
                    onClick={closeDropdown}
                    className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    <User size={16} /> Profile Settings
                  </Link>
                  <Link
                    to="/organization-admin/organization"
                    onClick={closeDropdown}
                    className="flex items-center gap-2.5 px-3 py-2 text-sm text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    <Building size={16} /> Organization
                  </Link>
                </>
              )}

              <div className="h-px bg-gray-100 my-1" />

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
