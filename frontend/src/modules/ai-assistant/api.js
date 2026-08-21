/**
 * modules/ai-assistant/api.js
 * ---------------------------
 * API client for the Zoiko Billing AI Assistant backend.
 * Mirrors the Phase 4 conversation engine and Phase 6 action lifecycle.
 */

const API_BASE = "/api/chatbot";

function getToken() {
  return localStorage.getItem("zoiko_billing_access") || "";
}

function authHeaders() {
  return {
    Authorization: `Bearer ${getToken()}`,
    "Content-Type": "application/json",
    "X-Correlation-Id": crypto.randomUUID(),
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
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ message, page: page || window.location.pathname }),
  });
  const body = await res.text();
  console.log("[CHATBOT-DIAG] sendMessage() ← status:", res.status, "body:", body.slice(0, 500));
  if (!res.ok) throw new Error(`Send message failed: ${res.status} — ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

export async function getCapabilities() {
  const res = await fetch(`${API_BASE}/capabilities`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Get capabilities failed: ${res.status}`);
  return res.json();
}

// ── Action Lifecycle API ─────────────────────────────────────────────────

const ACTION_BASE = "/api/chatbot/actions";

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
