import {
  getAccessToken,
  getRefreshToken,
  getStoredUser,
  setStoredUser,
  setStoredSession,
  clearStoredSession,
} from "../service/sessionStorage";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8001";

// Storage is delegated to service/sessionStorage.js (the single source of
// truth — see that file's header comment / Mandatory Fix 5). This module
// keeps its own `setSession(data)` argument shape (`{access_token,
// refresh_token, user}`, matching the raw /api/auth/login response body)
// since every caller in this codebase already depends on it.
export { getAccessToken, getRefreshToken, getStoredUser, setStoredUser };

export function setSession(data) {
  setStoredSession({ accessToken: data.access_token, refreshToken: data.refresh_token, user: data.user });
}

export function clearSession() {
  clearStoredSession();
}

// Pre-session auth endpoints must never go through the silent
// refresh-and-retry path. A failed /auth/login (401 bad credentials) used to
// trigger /auth/refresh and then RE-POST the credentials — doubling the
// rate-limit cost of every wrong password and wiping any stored session via
// clearSession() inside a mere failed login attempt.
const AUTH_RETRY_EXEMPT_PATHS = [
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/refresh",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/accept-invite",
];

function isAuthRetryExempt(path) {
  return AUTH_RETRY_EXEMPT_PATHS.some((p) => path === p || path.startsWith(p + "?"));
}

function networkError(message, aborted = false) {
  const err = new Error(message);
  err.status = 0;
  err.network = true;
  err.aborted = aborted;
  return err;
}

async function refreshSession() {
  const refresh = getRefreshToken();
  if (!refresh) return false;
  try {
    const res = await fetch(`${API_BASE}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!res.ok) {
      clearSession();
      return false;
    }
    const data = await res.json();
    setSession({ ...data, user: getStoredUser() });
    return true;
  } catch {
    // Refresh itself failing to reach the server is transient — do not wipe
    // the session for it; let the original request's outcome decide.
    return false;
  }
}

export async function apiFetch(path, { method = "GET", body, params, timeout = 30000 } = {}) {
  const url = new URL(API_BASE + path);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== "" && v !== undefined && v !== null) {
        url.searchParams.set(k, v);
      }
    });
  }

  const canAuthRetry = !isAuthRetryExempt(path);

  let res;
  try {
    res = await rawFetch(url, method, body, timeout);
    if (res.status === 401 && canAuthRetry && (await refreshSession())) {
      res = await rawFetch(url, method, body, timeout);
    }
  } catch (err) {
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw networkError(`Request timed out after ${timeout / 1000}s.`, true);
    }
    throw networkError(err?.message || "Network request failed.");
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    const detail = data.detail;
    let msg;
    let fields;
    if (Array.isArray(detail)) {
      fields = [...new Set(detail.map((d) => d.loc?.[d.loc.length - 1]).filter(Boolean))];
      msg = detail.map((d) => d.msg).join("; ");
    } else if (detail !== undefined && detail !== null && typeof detail !== "object") {
      msg = String(detail);
    } else if (typeof data.message === "string") {
      // ZoikoException bodies carry both `message` and `detail`; slowapi's 429
      // body carries neither (`{error}` only) — callers map by status instead.
      msg = data.message;
    }
    const err = new Error(msg || `Request failed (${res.status})`);
    err.status = res.status;
    err.serverDetail = typeof msg === "string" ? msg : undefined;
    if (fields) err.serverFields = fields;
    throw err;
  }
  return data;
}

function rawFetch(url, method, body, timeout = 30000) {
  const headers = { "Content-Type": "application/json" };
  const token = getAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  return fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}
