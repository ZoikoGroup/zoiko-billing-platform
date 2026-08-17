
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
const TOKEN_KEY = "zoiko_billing_access";
const REFRESH_KEY = "zoiko_billing_refresh";
const USER_KEY = "zoiko_billing_user";
const AUTH_INVALID_EVENT = "zoiko-billing-auth-session-invalid";

let refreshPromise = null;
let sessionInvalidNotified = false;

export function getAccessToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY);
}

export function getStoredUser() {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function setSession({ accessToken, refreshToken, user } = {}) {
  if (accessToken) localStorage.setItem(TOKEN_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  if (accessToken || refreshToken || user) sessionInvalidNotified = false;
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
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

/**
 * Low level request helper. Talks to the FastAPI backend at VITE_API_BASE_URL.
 * Automatically attaches the bearer token (if present) and JSON headers,
 * attempts a single silent refresh on a 401 response, and enforces a
 * per-request timeout so a hung backend never freezes the UI.
 */
export async function apiRequest(path, { method = "GET", body, headers = {}, auth = true, retry = true, params, timeout = 30000 } = {}) {
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
