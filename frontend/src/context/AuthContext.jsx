import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { getAccessToken, getStoredUser, setStoredUser, clearSession } from "../api/client";
import { ROLES, VALID_ROLES } from "../config/roles";
import { invalidateOrganizationDetailsCache } from "../service/orgAdminService";
import { invalidateZoikoSubscriptionCache } from "../service/platformSelfServiceApi";
import { invalidateConfigCache } from "../service/billingService";
import { invalidateGlobalBillingConfig } from "../service/billingConfigCache";
import { AUTH_INVALID_EVENT, clearApiCache } from "../service/api";

// Tenant isolation: per-organization data cached in module scope (org detail,
// Zoiko subscription, billing config, api.js response cache -- none keyed by
// tenant on its own) must never survive into another session in the same tab.
function clearTenantCaches() {
  invalidateOrganizationDetailsCache();
  invalidateZoikoSubscriptionCache();
  invalidateConfigCache();
  invalidateGlobalBillingConfig();
  clearApiCache();
}

export const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => getStoredUser());

  useEffect(() => {
    if (!getAccessToken()) {
      setUser(null);
      return;
    }
    setUser(getStoredUser());
  }, []);

  // An expired/revoked session (api.js notifySessionInvalid) sends the user to
  // /login without a page reload or logout(); clear the tenant caches then too,
  // otherwise the next account signed in on this tab could briefly see the
  // previous organization's name, subscription or currency.
  useEffect(() => {
    const onSessionInvalid = () => { clearTenantCaches(); setUser(null); };
    window.addEventListener(AUTH_INVALID_EVENT, onSessionInvalid);
    return () => window.removeEventListener(AUTH_INVALID_EVENT, onSessionInvalid);
  }, []);

  const login = useCallback(async (loggedInUser) => {
    // A fresh sign-in starts from a clean slate whatever happened before: a new
    // identity must never see another user's or organization's cached reads.
    clearTenantCaches();
    setStoredUser(loggedInUser);
    setUser(loggedInUser);
    return loggedInUser;
  }, []);

  const logout = useCallback(async () => {
    clearSession();
    clearTenantCaches();
    setUser(null);
  }, []);

  const role = user?.role && VALID_ROLES.includes(user.role) ? user.role : null;

  const hasRole = (roles) => {
    if (!role) return false;
    if (!Array.isArray(roles)) return role === roles;
    return roles.includes(role);
  };

  const value = {
    user,
    role,
    isAuthenticated: Boolean(getAccessToken()),
    login,
    logout,
    hasRole,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
