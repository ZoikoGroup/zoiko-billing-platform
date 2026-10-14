import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { api, setSession, clearSession, userFacingErrorMessage, GENERIC_SERVER_ERROR, NETWORK_ERROR } from "./api";

// Hardening: users must never see raw backend errors (exception text, SQL,
// provider errors, JSON blobs, snake_case field paths).

function jsonResponse(status, body) {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: () => "application/json" }, json: () => Promise.resolve(body) });
}
const futureJwt = () => `${btoa('{"alg":"HS256"}')}.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;

describe("userFacingErrorMessage", () => {
  it("a plain 500 never shows its detail (may contain raw exception / SQL text)", () => {
    const msg = userFacingErrorMessage(500, { detail: "Import preview failed: (psycopg2.errors.UniqueViolation) duplicate key [SQL: INSERT INTO customers ...]" });
    expect(msg).toBe(GENERIC_SERVER_ERROR);
  });

  it("a structured 500 shows only its own generic message, never the DEBUG detail", () => {
    expect(userFacingErrorMessage(500, { success: false, error: "INTERNAL_SERVER_ERROR", message: "Something went wrong on the server. Please try again later.", detail: "KeyError: 'x'" }))
      .toBe("Something went wrong on the server. Please try again later.");
  });

  it("developer-written ZoikoException messages are shown as-is (any status)", () => {
    expect(userFacingErrorMessage(400, { success: false, error: "BAD_REQUEST", message: "Invoice is already paid.", detail: "Invoice is already paid." })).toBe("Invoice is already paid.");
    expect(userFacingErrorMessage(503, { success: false, error: "SERVICE_UNAVAILABLE", message: "Temporarily unavailable." })).toBe("Temporarily unavailable.");
  });

  it("deliberate plain 502/503 messages still reach the user", () => {
    expect(userFacingErrorMessage(502, { detail: "The payment provider could not start checkout. Please try again shortly." }))
      .toBe("The payment provider could not start checkout. Please try again shortly.");
  });

  it("422 validation errors are humanized: no snake_case paths, indexes or 'Value error,' prefix", () => {
    const msg = userFacingErrorMessage(422, { detail: [
      { loc: ["body", "unit_price"], msg: "Value error, must be greater than 0" },
      { loc: ["body", "items", 0], msg: "Field required" },
    ] });
    expect(msg).toBe("Unit price: must be greater than 0, Items: Field required");
  });

  it("an object detail shows its message, never raw JSON", () => {
    expect(userFacingErrorMessage(422, { detail: { message: "Plan change is blocked.", subscription_change_id: 9, blockers: ["x"] } })).toBe("Plan change is blocked.");
    expect(userFacingErrorMessage(422, { detail: { code: 1 } })).toBeNull();
  });
});

describe("api client error surface", () => {
  beforeEach(() => { clearSession(); setSession({ accessToken: futureJwt(), refreshToken: "r", user: { id: 1 } }); });
  afterEach(() => { vi.unstubAllGlobals(); clearSession(); });

  it("a raw 500 rejects with the generic message; raw text kept only on serverDetail", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { detail: "Template generation failed: [Errno 2] No such file: /app/x.xlsx" })));
    const err = await api.get("/billing/customers/import/template").catch((e) => e);
    expect(err.status).toBe(500);
    expect(err.message).toBe(GENERIC_SERVER_ERROR);
    expect(err.message).not.toMatch(/Errno|\/app\//);
    expect(err.serverDetail).toMatch(/Errno/);
  });

  it("a network failure shows a friendly message, not the browser's 'Failed to fetch'", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const err = await api.get("/billing/customers").catch((e) => e);
    expect(err.status).toBe(0);
    expect(err.message).toBe(NETWORK_ERROR);
  });

  it("request_id is kept on the error for support/diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { success: false, error: "INTERNAL_SERVER_ERROR", message: GENERIC_SERVER_ERROR, request_id: "req-123" })));
    const err = await api.get("/billing/x").catch((e) => e);
    expect(err.requestId).toBe("req-123");
  });
});
