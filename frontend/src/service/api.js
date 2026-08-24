import {
  getAccessToken,
  getRefreshToken,
  getStoredUser,
  setStoredSession,
  clearStoredSession,
} from "./sessionStorage";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8001";
const AUTH_INVALID_EVENT = "zoiko-billing-auth-session-invalid";

let refreshPromise = null;
let sessionInvalidNotified = false;

// Storage is delegated to service/sessionStorage.js (the single source of
// truth — see that file's header comment / Mandatory Fix 5).
export { getAccessToken, getRefreshToken, getStoredUser };

export function setSession({ accessToken, refreshToken, user } = {}) {
  setStoredSession({ accessToken, refreshToken, user });
  if (accessToken || refreshToken || user) sessionInvalidNotified = false;
}

export function clearSession() {
  clearStoredSession();
}

function notifySessionInvalid(reason) {
  if (sessionInvalidNotified) return;
  sessionInvalidNotified = true;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTH_INVALID_EVENT, { detail: { reason } }));
  }
}

function createApiError(message, status, extra = {}) {
  const error = new Error(message || `Request failed with status ${status}`);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

// ── Proactive token refresh ───────────────────────────────────────────────
// The backend signs access tokens with an `exp` claim (60 min default).
// Instead of letting every parallel call bounce off a 401 first (wasted
// round trips + noisy access logs), requests proactively refresh via the
// SAME single-flight promise the reactive 401 path uses whenever the
// current token is missing its expiry, already expired, or inside the
// skew window.
const PROACTIVE_REFRESH_SKEW_MS = 30_000;

export function getTokenExpiryMs(token) {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
    );
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function ensureFreshAccessToken() {
  const token = getAccessToken();
  const expiryMs = getTokenExpiryMs(token);
  // Unparseable/absent expiry: do nothing here — the reactive 401 path
  // still guarantees exactly one refresh-and-retry.
  if (expiryMs == null) return;
  if (expiryMs - Date.now() > PROACTIVE_REFRESH_SKEW_MS) return;

  const result = await tryRefreshToken();
  if (result.invalidSession) {
    clearSession();
    notifySessionInvalid(result.reason);
    throw createApiError("Your session has expired. Please sign in again.", 401, {
      authInvalid: true,
      refreshStatus: result.status,
    });
  }
  // Transient refresh failure: fall through and send the request with the
  // current token — the server decides; a genuine 401 still hits the
  // reactive path below.
}

/**
 * Low level request helper. Talks to the FastAPI backend at VITE_API_BASE_URL.
 * Automatically attaches the bearer token (if present) and JSON headers,
 * attempts a single silent refresh on a 401 response, and enforces a
 * per-request timeout so a hung backend never freezes the UI.
 */
export async function apiRequest(path, { method = "GET", body, headers = {}, auth = true, retry = true, params, timeout = 30000 } = {}) {
  if (auth) {
    await ensureFreshAccessToken();
  }

  let url = path.startsWith("http") ? path : `${API_BASE_URL}${path}`;
  if (params) {
    const query = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    if (query) url += `${url.includes("?") ? "&" : "?"}${query}`;
  }

  const finalHeaders = { ...headers };
  if (body !== undefined && !(body instanceof FormData)) {
    finalHeaders["Content-Type"] = "application/json";
  }
  if (auth) {
    const token = getAccessToken();
    if (token) finalHeaders["Authorization"] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw createApiError(`Request timed out after ${timeout / 1000}s. The server may be unreachable.`, 408);
    }
    throw createApiError(err.message || "Network error. Please check your connection.", 0);
  }
  clearTimeout(timer);

  if (res.status === 401 && auth && retry) {
    const refreshResult = await tryRefreshToken();
    if (refreshResult.ok) {
      return apiRequest(path, { method, body, headers, auth, retry: false, timeout });
    }
    if (refreshResult.invalidSession) {
      clearSession();
      notifySessionInvalid(refreshResult.reason);
      throw createApiError("Your session has expired. Please sign in again.", 401, {
        authInvalid: true,
        refreshStatus: refreshResult.status,
      });
    }
  }

  if (!res.ok) {
    let detail;
    try {
      const data = await res.json();
      detail = data?.detail || data?.message;
      if (Array.isArray(detail)) {
        // Handle FastAPI 422 validation errors nicely
        detail = detail.map(err => {
          const field = err.loc ? err.loc[err.loc.length - 1] : "Field";
          return `${field}: ${err.msg}`;
        }).join(", ");
      } else if (typeof detail === "object" && detail !== null) {
        detail = JSON.stringify(detail);
      }
    } catch {
      detail = res.statusText;
    }
    throw createApiError(detail, res.status);
  }

  if (res.status === 204) return null;

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return res.json();
  return res.text();
}

async function tryRefreshToken() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshAccessToken().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

async function refreshAccessToken() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    return { ok: false, invalidSession: true, reason: "missing_refresh_token" };
  }

  try {
    const res = await fetch(`${API_BASE_URL}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        invalidSession: true,
        status: res.status,
        reason: "refresh_rejected",
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        invalidSession: false,
        status: res.status,
        reason: "refresh_transient_failure",
      };
    }

    const data = await res.json();
    if (data?.access_token) {
      setSession({
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        user: data.employee || data.user,
      });
      return { ok: true };
    }
    return { ok: false, invalidSession: false, reason: "refresh_missing_access_token" };
  } catch (error) {
    return { ok: false, invalidSession: false, reason: "refresh_network_error", error };
  }
}

export const api = {
  get: (path, opts) => apiRequest(path, { ...opts, method: "GET" }),
  post: (path, body, opts) => apiRequest(path, { ...opts, method: "POST", body }),
  put: (path, body, opts) => apiRequest(path, { ...opts, method: "PUT", body }),
  patch: (path, body, opts) => apiRequest(path, { ...opts, method: "PATCH", body }),
  delete: (path, opts) => apiRequest(path, { ...opts, method: "DELETE" }),
};

export { API_BASE_URL, AUTH_INVALID_EVENT };
