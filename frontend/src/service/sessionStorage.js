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
const KEYS = [TOKEN_KEY, REFRESH_KEY, USER_KEY];

// "Remember me" unticked at login keeps the session in sessionStorage instead:
// it survives reloads but ends when the tab/browser is closed. Reads check
// both stores; writes go to whichever store currently holds the session.
function read(key) {
  return localStorage.getItem(key) ?? sessionStorage.getItem(key);
}

function activeStore() {
  return sessionStorage.getItem(TOKEN_KEY) && !localStorage.getItem(TOKEN_KEY) ? sessionStorage : localStorage;
}

export function getAccessToken() {
  return read(TOKEN_KEY);
}

export function getRefreshToken() {
  return read(REFRESH_KEY);
}

export function getStoredUser() {
  try {
    return JSON.parse(read(USER_KEY) || "null");
  } catch {
    return null;
  }
}

export function setStoredUser(user) {
  activeStore().setItem(USER_KEY, JSON.stringify(user));
}

/** Canonical write path. Only supplied fields are written — a partial refresh
 * (e.g. access token only) never blanks out an existing refresh token or user.
 * `persist` is only passed at login: true = localStorage (remembered),
 * false = sessionStorage (this tab only); omitted = keep the current store. */
export function setStoredSession({ accessToken, refreshToken, user, persist } = {}) {
  let store = activeStore();
  if (persist !== undefined) {
    store = persist ? localStorage : sessionStorage;
    const other = persist ? sessionStorage : localStorage;
    KEYS.forEach((key) => other.removeItem(key));
  }
  if (accessToken) store.setItem(TOKEN_KEY, accessToken);
  if (refreshToken) store.setItem(REFRESH_KEY, refreshToken);
  if (user) store.setItem(USER_KEY, JSON.stringify(user));
}

export function clearStoredSession() {
  KEYS.forEach((key) => {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  });
}
