/**
 * modules/ai-assistant/publicAssistant.js
 * ----------------------------------------
 * Client for the UNAUTHENTICATED public assistant
 * (backend: ZB-AI-PUB-001  POST/GET /api/assistant/public/*).
 *
 * WHY THIS EXISTS
 * ---------------
 * The in-app assistant (./api.js) talks to the AUTHENTICATED /api/chatbot
 * routes, which require a valid session and an active billing subscription
 * (see backend app/modules/chatbot/router.py). When that session is missing or
 * has expired, a general PRODUCT question ("How do payments work in Zoiko
 * Billing platform?") used to dead-end with "Your session has expired." — even
 * though the answer contains no tenant data and is freely available to the
 * marketing-site widget.
 *
 * This module lets the in-app panel fall back to the SAME public service the
 * widget uses. It is guidance-only and anonymous:
 *   - no Authorization header is ever sent;
 *   - account-specific questions come back with `requires_auth: true` and the
 *     public service NEVER looks up tenant data (enforced server-side, not
 *     here) — the panel surfaces those as a sign-in prompt.
 *
 * The security boundary lives in the backend; this file only decides where a
 * message is sent, never what a user is allowed to see.
 */

import { apiUrl } from "../../config/apiBase";
import { getAccessToken } from "../../service/sessionStorage";

const API_BASE = apiUrl("/api/assistant/public");

// Survives reloads and matches the marketing widget's continuity idea, but on a
// separate key: the dashboard and the marketing site are different origins and
// must never share an anonymous session id.
const SESSION_KEY = "zoiko_billing_assistant_public_session";

const REQUEST_TIMEOUT_MS = 45000;

/** Visitor-facing failure carrying a machine-readable status for logging. */
export class PublicAssistantError extends Error {
  constructor(message, { status = 0, detail = "", stale = false } = {}) {
    super(message || "Public assistant request failed");
    this.name = "PublicAssistantError";
    this.status = status;
    this.detail = detail;
    // True on 404: the stored session no longer exists as this caller's own
    // (expired, closed, or bound to another network). Safe to start fresh.
    this.stale = stale;
  }
}

/**
 * Whether an admin session is present. This is deliberately a cheap presence
 * check (not an expiry check): a present-but-expired token is still worth
 * trying, because ./api.js now silently refreshes and retries it. Only a
 * completely absent token routes straight to the public path.
 */
export function hasAuthenticatedSession() {
  return Boolean(getAccessToken());
}

function readStoredUid() {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function storeUid(uid) {
  try {
    localStorage.setItem(SESSION_KEY, uid);
  } catch {
    /* private mode / storage disabled — session simply won't persist */
  }
}

/** Drop the stored anonymous session (expired/foreign) so the next send starts a new one. */
export function clearPublicSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** Client-generated session uid (36-char UUID fits the backend's 36-char column). */
export function newPublicUid() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `pub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function requestJson(path, { method = "GET", body, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      if (signal?.aborted) {
        const aborted = new PublicAssistantError("Request aborted");
        aborted.aborted = true;
        throw aborted;
      }
      throw new PublicAssistantError("The assistant took too long to respond. Please try again.", {
        status: 0,
        detail: "timeout",
      });
    }
    throw new PublicAssistantError(
      "The assistant service is unreachable right now. Please try again in a moment.",
      { status: 0, detail: err?.message || "network_failure" }
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", abort);
  }

  if (!res.ok) {
    let detail = "";
    try {
      const data = await res.json();
      detail = data?.detail || data?.message || "";
    } catch {
      /* non-JSON error body is fine */
    }
    throw new PublicAssistantError(detail || `Something went wrong (HTTP ${res.status}). Please try again.`, {
      status: res.status,
      detail,
      stale: res.status === 404,
    });
  }

  try {
    return await res.json();
  } catch {
    throw new PublicAssistantError("The assistant sent back an unreadable response. Please try again.", {
      status: res.status,
      detail: "bad_json",
    });
  }
}

/**
 * Start (or idempotently resume) an anonymous session and return its uid.
 * Re-posting the same uid is how the backend resumes; a fresh uid starts new.
 */
export async function ensurePublicSession({ signal } = {}) {
  const stored = readStoredUid() || newPublicUid();
  const page = typeof window !== "undefined" ? window.location.pathname : "/";
  const data = await requestJson("/sessions", {
    method: "POST",
    body: { session_uid: stored, page },
    signal,
  });
  const uid = data?.session_uid || stored;
  storeUid(uid);
  return uid;
}

/**
 * Send one message to the public assistant.
 *
 * A stale session (404) is recovered ONCE by discarding the stored uid,
 * starting a fresh anonymous session and replaying the turn — never a retry
 * loop. Any other failure propagates as a PublicAssistantError.
 *
 * @returns {Promise<{session_uid?: string, message_uid?: string, answer: string,
 *   mode?: string, risk_class?: string, requires_auth?: boolean,
 *   safety_state?: string, evidence?: Array<{source?: string, url?: string}>}>}
 */
export async function sendPublicMessage(message, { signal } = {}) {
  const page = typeof window !== "undefined" ? window.location.pathname : "/";
  const messageId = newPublicUid();

  const post = (uid) =>
    requestJson(`/sessions/${encodeURIComponent(uid)}/messages`, {
      method: "POST",
      body: { message, page, message_id: messageId, intent_id: null },
      signal,
    });

  const uid = await ensurePublicSession({ signal });
  try {
    return await post(uid);
  } catch (err) {
    if (err instanceof PublicAssistantError && err.stale) {
      clearPublicSession();
      const freshUid = await ensurePublicSession({ signal });
      return post(freshUid);
    }
    throw err;
  }
}
