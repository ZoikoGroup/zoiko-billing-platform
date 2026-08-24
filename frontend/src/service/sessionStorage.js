/**
 * service/sessionStorage.js
 * --------------------------
 * Single source of truth for reading/writing the Super Admin / tenant session
 * in localStorage. Phase 3 architecture remediation (Mandatory Fix 5): prior
 * to this file existing, `api/client.js` and `service/api.js` each read and
 * wrote the same three localStorage keys independently, with incompatible
 * `setSession` argument shapes — a latent drift risk if either implementation
 * changed without the other. Both files now delegate all actual storage
 * access here; each keeps its own request/refresh/retry orchestration
 * unchanged (that behavior is deliberately NOT unified — see the remediation
 * report for why a full rewrite was judged out of scope).
 */

const TOKEN_KEY = "zoiko_billing_access";
const REFRESH_KEY = "zoiko_billing_refresh";
const USER_KEY = "zoiko_billing_user";

export function getAccessToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY);
}

export function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

export function setStoredUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/** Canonical write path. Only supplied fields are written — a partial refresh
 * (e.g. access token only) never blanks out an existing refresh token or user. */
export function setStoredSession({ accessToken, refreshToken, user } = {}) {
  if (accessToken) localStorage.setItem(TOKEN_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearStoredSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}
