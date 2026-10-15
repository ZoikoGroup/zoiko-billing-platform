import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the shared single-flight refresh so recovery can be asserted without
// touching the real /api/auth/refresh network path.
const mockRefresh = vi.hoisted(() => vi.fn());

vi.mock("../../service/api", () => ({
  tryRefreshToken: (...args) => mockRefresh(...args),
}));

vi.mock("../../service/sessionStorage", () => ({
  getAccessToken: () => "test-token",
}));

import { createSession, sendMessageStreamed } from "./api";

function errorResponse(status, body = {}) {
  return {
    ok: false,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

beforeEach(() => {
  mockRefresh.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ai-assistant api — auth classification + silent recovery", () => {
  it("TEST 1 — a 403 is reported as forbidden, never as an expired session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(403, { detail: "inactive subscription" })));
    await expect(createSession("t", "m")).rejects.toMatchObject({ status: 403, forbidden: true });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("TEST 2 — a 401 triggers exactly one silent refresh and one replay", async () => {
    mockRefresh.mockResolvedValue({ ok: true });
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return errorResponse(401, { detail: "expired" });
      return { ok: true, status: 201, json: async () => ({ conversation_uid: "c1" }) };
    }));

    const session = await createSession("t", "m");
    expect(session.conversation_uid).toBe("c1");
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it("TEST 3 — 'session expired' is only claimed once the refresh also fails", async () => {
    mockRefresh.mockResolvedValue({ ok: false, invalidSession: true });
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(401, { detail: "expired" })));
    await expect(createSession("t", "m")).rejects.toMatchObject({
      status: 401,
      authInvalid: true,
      sessionExpired: true,
    });
  });

  it("TEST 4 — the streaming send refreshes + replays once on 401, then streams the answer", async () => {
    mockRefresh.mockResolvedValue({ ok: true });
    const encoder = new TextEncoder();
    let calls = 0;
    const body = {
      getReader() {
        const frames = ['event: done\ndata: {"response":{"answer":"Streamed answer"},"streamed":true}\n\n'];
        let i = 0;
        return {
          read: async () => {
            if (i >= frames.length) return { done: true, value: undefined };
            const value = encoder.encode(frames[i]);
            i += 1;
            return { done: false, value };
          },
        };
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) return errorResponse(401, { detail: "expired" });
      return { ok: true, status: 200, body };
    }));

    const done = vi.fn();
    const onError = vi.fn();
    await new Promise((resolve) => {
      sendMessageStreamed("c1", "hi", undefined, {
        onToken: () => {},
        onDone: (p) => { done(p); resolve(); },
        onError: (e) => { onError(e); resolve(); },
      });
    });

    expect(onError).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it("TEST 5 — a streamed 403 stays forbidden (no refresh, no expiry claim)", async () => {
    const onError = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => errorResponse(403, { detail: "not permitted" })));
    await new Promise((resolve) => {
      sendMessageStreamed("c1", "hi", undefined, {
        onToken: () => {},
        onDone: () => resolve(),
        onError: (e) => { onError(e); resolve(); },
      });
    });

    expect(onError).toHaveBeenCalledTimes(1);
    const err = onError.mock.calls[0][0];
    expect(err).toMatchObject({ status: 403, forbidden: true });
    expect(err.sessionExpired).toBeUndefined();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
