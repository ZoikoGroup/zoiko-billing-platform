import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  hasAuthenticatedSession,
  ensurePublicSession,
  sendPublicMessage,
  clearPublicSession,
  PublicAssistantError,
} from "./publicAssistant";

const SESSION_KEY = "zoiko_billing_assistant_public_session";
const TOKEN_KEY = "zoiko_billing_access";
const SESSIONS_PATH = "/api/assistant/public/sessions";

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  localStorage.clear();
  clearPublicSession();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("publicAssistant — anonymous client", () => {
  it("TEST 6 — hasAuthenticatedSession reflects the presence of an admin token", () => {
    expect(hasAuthenticatedSession()).toBe(false);
    localStorage.setItem(TOKEN_KEY, "token");
    expect(hasAuthenticatedSession()).toBe(true);
  });

  it("TEST 7 — ensurePublicSession creates/persists a session and sends NO auth header", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ session_uid: "11111111-1111-1111-1111-111111111111", status: "active", messages: [] });
    }));

    const uid = await ensurePublicSession();

    expect(uid).toBe("11111111-1111-1111-1111-111111111111");
    expect(localStorage.getItem(SESSION_KEY)).toBe(uid);
    expect(calls[0].url).toContain(SESSIONS_PATH);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers?.Authorization).toBeUndefined();
  });

  it("TEST 8 — sendPublicMessage returns the answer and requires_auth flag", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith(SESSIONS_PATH)) return jsonResponse({ session_uid: "sess-1234", status: "active", messages: [] });
      return jsonResponse({ message_uid: "m1", answer: "Payments are billed monthly.", requires_auth: false });
    }));

    const resp = await sendPublicMessage("How do payments work in Zoiko Billing platform?");
    expect(resp.answer).toMatch(/payments are billed monthly/i);
    expect(resp.requires_auth).toBe(false);
  });

  it("TEST 9 — a stale (404) session is recovered exactly once, never looped", async () => {
    let messagePosts = 0;
    let sessionCreates = 0;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith(SESSIONS_PATH)) {
        sessionCreates += 1;
        return jsonResponse({ session_uid: `sess-${sessionCreates}`, status: "active", messages: [] });
      }
      messagePosts += 1;
      if (messagePosts === 1) return jsonResponse({ detail: "session not found" }, 404);
      return jsonResponse({ answer: "Recovered.", requires_auth: false });
    }));

    const resp = await sendPublicMessage("hi there");
    expect(resp.answer).toBe("Recovered.");
    expect(messagePosts).toBe(2);
    expect(sessionCreates).toBe(2);
  });

  it("TEST 10 — a non-OK response throws a typed error carrying the HTTP status", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const u = String(url);
      if (u.endsWith(SESSIONS_PATH)) return jsonResponse({ session_uid: "sess-err", status: "active" });
      return jsonResponse({ detail: "temporarily unavailable" }, 503);
    }));

    await expect(sendPublicMessage("hello")).rejects.toBeInstanceOf(PublicAssistantError);
    await expect(sendPublicMessage("hello")).rejects.toMatchObject({ status: 503 });
  });
});
