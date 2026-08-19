const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

const TOKEN_KEY = "zoiko_billing_access";
const REFRESH_KEY = "zoiko_billing_refresh";
const USER_KEY = "zoiko_billing_user";

export function getAccessToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY);
}

export function setSession(data) {
  localStorage.setItem(TOKEN_KEY, data.access_token);
  localStorage.setItem(REFRESH_KEY, data.refresh_token);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
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

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
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
