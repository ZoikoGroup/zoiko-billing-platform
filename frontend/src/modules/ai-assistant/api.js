/**
 * modules/ai-assistant/api.js
 * ---------------------------
 * API client for the Zoiko Billing AI Assistant backend.
 * Mirrors the Phase 4 conversation engine and Phase 6 action lifecycle.
 */

import { getAccessToken } from "../../service/sessionStorage";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:8001";
const API_BASE = `${API_BASE_URL}/api/chatbot`;

function getToken() {
  return getAccessToken() || "";
}

function authHeaders() {
  return {
    Authorization: `Bearer ${getToken()}`,
    "Content-Type": "application/json",
  };
}

export async function createSession(title, initialMessage) {
  const res = await fetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ title, initial_message: initialMessage }),
  });
  if (!res.ok) throw new Error(`Create session failed: ${res.status}`);
  return res.json();
}

export async function listSessions(limit = 20, offset = 0) {
  const res = await fetch(`${API_BASE}/sessions?limit=${limit}&offset=${offset}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`List sessions failed: ${res.status}`);
  return res.json();
}

export async function getSession(conversationUid) {
  const res = await fetch(`${API_BASE}/sessions/${conversationUid}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Get session failed: ${res.status}`);
  return res.json();
}

export async function closeSession(conversationUid) {
  const res = await fetch(`${API_BASE}/sessions/${conversationUid}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok && res.status !== 204) throw new Error(`Close session failed: ${res.status}`);
}

export async function sendMessage(conversationUid, message, page) {
  const url = `${API_BASE}/sessions/${conversationUid}/messages`;
  console.log("[CHATBOT-DIAG] sendMessage() → POST", url, "body:", { message, page });
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ message, page: page || window.location.pathname }),
    });
  } catch (networkErr) {
    const err = new Error("network_failure");
    err.cause = networkErr;
    err.status = 0;
    throw err;
  }
  console.log("[CHATBOT-DIAG] sendMessage() ← status:", res.status);
  if (!res.ok) {
    const err = new Error(`Send message failed: ${res.status}`);
    err.status = res.status;
    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      err.retryAfter = retryAfter ? parseInt(retryAfter, 10) || 10 : 10;
    }
    if (res.status === 401 || res.status === 403) {
      err.sessionExpired = true;
    }
    throw err;
  }
  return res.json();
}

function parseSseFrame(frame, { onReady, onToken, onDone, onError }) {
  let eventName = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return;
  let payload;
  try {
    payload = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }
  if (eventName === "ready") onReady?.(payload);
  else if (eventName === "token") onToken?.(payload.delta ?? "");
  else if (eventName === "done") onDone?.(payload);
  else if (eventName === "error") onError?.(new Error(payload.message || "Stream error"));
}

/**
 * sendMessageStreamed — post a message and receive the answer as an SSE
 * stream (POST /messages/stream).  Never throws; reports through callbacks.
 *
 * Real failures are NOT hidden: HTTP errors keep their status code and the
 * server's `detail`/`message` text, and only the friendly no-callbacks path
 * is the onError fallback.  A single automatic retry rides out transient
 * failures (network, 5xx, rate-limit) that happen BEFORE the stream opened;
 * once any SSE frame has been received the stream is never re-sent.
 *
 * @param {{signal?: AbortSignal, onReady?: Function, onToken: Function, onDone: Function, onError?: Function}} opts
 */
export function sendMessageStreamed(conversationUid, message, page, opts) {
  const { signal, onReady = () => {}, onToken, onDone, onError = () => {} } = opts || {};
  const url = `${API_BASE}/sessions/${conversationUid}/messages/stream`;
  const MAX_ATTEMPTS = 2;

  let attempts = 0;
  let sawFrame = false;
  const handleSseEvent = (name, args) => {
    sawFrame = true;
    if (name === "ready") onReady(args);
    else if (name === "token") onToken(args.delta ?? "");
    else if (name === "done") onDone(args);
    else if (name === "error") onError(new Error(args.message || "Stream error"));
  };
  const parseSseChunk = (frame) =>
    parseSseFrame(frame, {
      onReady: (p) => handleSseEvent("ready", p),
      onToken: (d) => handleSseEvent("token", { delta: d }),
      onDone: (p) => handleSseEvent("done", p),
      onError: (e) => handleSseEvent("error", { message: e.message }),
    });

  const attempt = () => {
    console.log(`[CHATBOT-DIAG] sendMessageStreamed() → POST ${url} (attempt ${attempts + 1}/${MAX_ATTEMPTS})`);
    fetch(url, {
      method: "POST",
      headers: { ...authHeaders(), Accept: "text/event-stream" },
      body: JSON.stringify({ message, page: page || window.location.pathname }),
      signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const status = response.status;
          let detailText = "";
          try {
            const data = await response.json();
            detailText = data?.detail || data?.message || "";
          } catch { /* non-JSON error body is fine */ }
          const err = new Error(`Send message failed: ${status}${detailText ? ` — ${detailText}` : ""}`);
          err.status = status;
          if (status === 401 || status === 403) err.sessionExpired = true;
          if (status === 429) {
            const ra = response.headers.get("Retry-After");
            err.retryAfter = ra ? parseInt(ra, 10) || 10 : 10;
          }
          throw err;
        }
        if (!response.body) {
          const err = new Error("Send message failed: empty response body");
          err.status = 0;
          throw err;
        }
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = "";
        const pump = () =>
          reader.read().then(({ done, value }) => {
            if (done) {
              if (buffer.trim()) parseSseChunk(buffer);
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              parseSseChunk(frame);
            }
            return pump();
          });
        return pump();
      })
      .catch((err) => {
        if (err?.name === "AbortError") return;
        const status = err?.status;
        const transient = status == null || status === 0 || status === 429 || status >= 500;
        if (transient && !sawFrame && attempts < MAX_ATTEMPTS - 1) {
          attempts += 1;
          console.warn(`[CHATBOT-DIAG] stream attempt ${attempts + 1} of ${MAX_ATTEMPTS}: retrying after ${status ?? "network"} error`, err?.message);
          attempt();
          return;
        }
        if (status == null) {
          // Genuine fetch-level failure (connection refused, proxy down…).
          const failure = new Error("network_failure");
          failure.cause = err;
          failure.status = 0;
          onError(failure);
        } else {
          // Real HTTP/stream failure — preserve status + message + detail.
          onError(err);
        }
      });
  };
  attempt();
}

/**
 * cancelStream — best-effort signal to the backend to stop an in-flight SSE
 * generation (the Stop button).  Fire-and-forget by design: the SSE fetch is
 * already aborted client-side and the UI is settled regardless, this only
 * prevents the backend's daemon pipeline from burning LLM tokens on a
 * disconnected client.  Never throws.
 */
export function cancelStream(conversationUid) {
  return fetch(
    `${API_BASE}/sessions/${conversationUid}/messages/stream/cancel`,
    {
      method: "POST",
      headers: authHeaders(),
      keepalive: true,
    }
  ).catch(() => {});
}

export async function getCapabilities() {
  const res = await fetch(`${API_BASE}/capabilities`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Get capabilities failed: ${res.status}`);
  return res.json();
}

// ── Action Lifecycle API ─────────────────────────────────────────────────

const ACTION_BASE = `${API_BASE}/actions`;

export async function createActionDraft(actionType, proposedParams) {
  const res = await fetch(`${ACTION_BASE}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ action_type: actionType, proposed_params: proposedParams }),
  });
  if (!res.ok) throw new Error(`Create draft failed: ${res.status}`);
  return res.json();
}

export async function generatePreview(actionUid) {
  const res = await fetch(`${ACTION_BASE}/${actionUid}/preview`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Generate preview failed: ${res.status}`);
  return res.json();
}

export async function confirmAction(actionUid, previewUid, previewHash) {
  const res = await fetch(`${ACTION_BASE}/${actionUid}/confirm`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ preview_uid: previewUid, preview_hash: previewHash }),
  });
  if (!res.ok) throw new Error(`Confirm action failed: ${res.status}`);
  return res.json();
}

export async function executeAction(actionUid, idempotencyKey) {
  const res = await fetch(`${ACTION_BASE}/${actionUid}/execute`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ idempotency_key: idempotencyKey }),
  });
  if (!res.ok) throw new Error(`Execute action failed: ${res.status}`);
  return res.json();
}

export async function cancelAction(actionUid) {
  const res = await fetch(`${ACTION_BASE}/${actionUid}/cancel`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Cancel action failed: ${res.status}`);
  return res.json();
}
