import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { getAccessToken, getStoredUser, setStoredUser, clearSession } from "../api/client";
import { ROLES, VALID_ROLES } from "../config/roles";
import { invalidateOrganizationDetailsCache } from "../service/orgAdminService";
import { invalidateZoikoSubscriptionCache } from "../service/platformSelfServiceApi";
import { invalidateConfigCache } from "../service/billingService";
import { invalidateGlobalBillingConfig } from "../service/billingConfigCache";

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

  const login = useCallback(async (loggedInUser) => {
    setStoredUser(loggedInUser);
    setUser(loggedInUser);
    return loggedInUser;
  }, []);

  const logout = useCallback(async () => {
    clearSession();
    invalidateOrganizationDetailsCache();
    invalidateZoikoSubscriptionCache();
    // Tenant isolation: the billing config (currency, terminology, and every
    // other cached settingsApi.getConfig() consumer) must never survive a
    // same-tab account switch — see billingConfigCache.js and
    // billingService.js's own getConfig cache.
    invalidateConfigCache();
    invalidateGlobalBillingConfig();
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
