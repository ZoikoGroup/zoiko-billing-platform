import {
  getAccessToken,
  getRefreshToken,
  getStoredUser,
  setStoredSession,
  clearStoredSession,
} from "./sessionStorage";
import { API_BASE_URL, apiUrl } from "../config/apiBase";

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

export const GENERIC_SERVER_ERROR = "Something went wrong on the server. Please try again later.";
export const NETWORK_ERROR = "Couldn't reach the server. Please check your connection and try again.";

const humanizeField = (name) => {
  const s = String(name).replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
};

// Turns an error response body into text that is safe to show to a user.
// Developer-written errors (ZoikoException and the generic 500 handler) carry
// a structured `error` code and a reviewed `message`; a bare FastAPI
// HTTPException carries only `detail`, which for 5xx can contain raw exception
// text (SQL, paths, provider errors) and is therefore never shown.
export function userFacingErrorMessage(status, data) {
  const structured = data && typeof data.error === "string" && typeof data.message === "string";
  if (structured) {
    // Even a structured 500 only ever shows its own generic message — never
    // the DEBUG-only `detail` diagnostics.
    return data.message;
  }
  // A plain 500 is an unhandled failure whose detail may hold raw exception
  // text. Plain 502-504 bodies in this API are deliberate, user-written
  // messages (e.g. "The payment provider could not start checkout…").
  if (status === 500 || (status > 500 && typeof data?.detail !== "string")) return GENERIC_SERVER_ERROR;
  let detail = data?.detail ?? data?.message;
  if (Array.isArray(detail)) {
    // FastAPI 422: "Unit price: must be greater than 0" — no raw snake_case
    // field names, list indexes or "Value error," prefixes.
    return detail.map((e) => {
      const loc = Array.isArray(e?.loc) ? e.loc.filter((l) => typeof l === "string" && l !== "body" && l !== "query") : [];
      const msg = String(e?.msg || "is invalid").replace(/^Value error,\s*/i, "");
      const field = loc.length ? humanizeField(loc[loc.length - 1]) : "";
      return field ? `${field}: ${msg}` : msg;
    }).join(", ");
  }
  if (detail && typeof detail === "object") {
    return typeof detail.message === "string" ? detail.message : null;
  }
  return typeof detail === "string" ? detail : null;
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
 * Low level request helper. Talks to the FastAPI backend over the same-origin
 * /api path (see ../config/apiBase.js), or to VITE_API_BASE_URL when the API is
 * deployed on a separate origin.
 * Automatically attaches the bearer token (if present) and JSON headers,
 * attempts a single silent refresh on a 401 response, and enforces a
 * per-request timeout so a hung backend never freezes the UI.
 */
export async function apiRequest(path, { method = "GET", body, headers = {}, auth = true, retry = true, params, timeout = 30000 } = {}) {
  if (auth) {
    await ensureFreshAccessToken();
  }

  let url = path.startsWith("http") ? path : apiUrl(path);
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
    throw createApiError(NETWORK_ERROR, 0, { serverDetail: err?.message });
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
    const extra = {};
    try {
      const data = await res.json();
      detail = userFacingErrorMessage(res.status, data);
      // Raw server text stays available for diagnostics, never for display.
      extra.serverDetail = data?.detail ?? data?.message;
      if (typeof data?.request_id === "string") extra.requestId = data.request_id;
      // Structured business-level error payload (e.g. a SUBSCRIPTION_LIMIT_REACHED
      // entitlement error — see backend/app/core/exceptions.py's ZoikoException.extra)
      // carried alongside the standard success/error/message/detail shape. Preserved
      // on the thrown error, camelCased, so callers can branch on it directly instead
      // of pattern-matching the free-text message. Every field is optional — a plain
      // 403/404/422 simply won't have them, and `code` alone (via isEntitlementLimitError)
      // is enough to detect the entitlement-limit case.
      if (data && typeof data.error === "string") extra.code = data.error;
      if (data && typeof data.entity === "string") extra.entity = data.entity;
      if (data && typeof data.current_usage === "number") extra.currentUsage = data.current_usage;
      if (data && typeof data.limit === "number") extra.limit = data.limit;
      if (data && typeof data.remaining === "number") extra.remaining = data.remaining;
      if (data && typeof data.plan_name === "string") extra.planName = data.plan_name;
    } catch {
      detail = res.status >= 500 ? GENERIC_SERVER_ERROR : res.statusText;
    }
    throw createApiError(detail, res.status, extra);
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
    const res = await fetch(apiUrl("/api/auth/refresh"), {
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

// A subscription/entitlement limit (e.g. "you've reached your plan's
// customer limit") is still a 403, but a distinct, actionable case from an
// RBAC-denied 403 — this is the single place that tells them apart, so
// every call site checks the same thing instead of re-parsing messages.
export function isEntitlementLimitError(error) {
  return Boolean(error) && error.code === "SUBSCRIPTION_LIMIT_REACHED";
}

export { API_BASE_URL, AUTH_INVALID_EVENT };
