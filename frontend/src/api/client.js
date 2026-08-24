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

async function refreshSession() {
  const refresh = getRefreshToken();
  if (!refresh) return false;
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

  let attempt = true;
  let res = await rawFetch(url, method, body, timeout);

  if (res.status === 401 && attempt && (await refreshSession())) {
    attempt = false;
    res = await rawFetch(url, method, body, timeout);
  }

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    const detail = data.detail;
    const msg = Array.isArray(detail) ? detail.map((d) => d.msg).join("; ") : detail;
    const err = new Error(msg || `Request failed (${res.status})`);
    err.status = res.status;
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
