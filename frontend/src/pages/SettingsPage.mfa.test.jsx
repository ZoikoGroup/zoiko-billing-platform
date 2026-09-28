import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

/**
 * MFA enrollment is the gate in front of every privileged action, so a failure
 * here silently blocks the whole super-admin command center. The regression
 * these tests pin down: `/api/auth/mfa/setup/start` issues a NEW secret on
 * every call, so re-running it while the operator holds a live key in their
 * authenticator leaves them with a dead key and an unexplainable
 * "Incorrect verification code".
 */

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock("../api/client", () => ({ apiFetch }));

vi.mock("../components/billing-ui", async () => {
  const actual = await vi.importActual("../components/billing-ui");
  return actual;
});

import SettingsPage from "./SettingsPage";

const SETTINGS = [];
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const OTPAUTH = `otpauth://totp/Zoiko:${encodeURIComponent("admin@example.com")}?secret=${SECRET}&issuer=Zoiko`;

function mockHappyPath({ startResult = { secret: SECRET, otpauth_url: OTPAUTH } } = {}) {
  apiFetch.mockImplementation((url, opts = {}) => {
    if (url === "/api/auth/mfa/status") return Promise.resolve({ enabled: false });
    if (url === "/api/super-admin/settings") return Promise.resolve(SETTINGS);
    if (url === "/api/auth/mfa/setup/start") return Promise.resolve(startResult);
    if (url === "/api/auth/mfa/setup/verify") {
      return Promise.resolve({ recovery_codes: ["aaaa-bbbb", "cccc-dddd"] });
    }
    return Promise.resolve({});
  });
}

async function openSetupModal() {
  render(<SettingsPage />);
  const enable = await screen.findByRole("button", { name: /enable mfa/i });
  fireEvent.click(enable);
  return screen.findByRole("dialog");
}

// Simulates the server replaying an unconfirmed enrollment rather than
// issuing a fresh secret.
function mockReusedPending() {
  const base = apiFetch.getMockImplementation();
  apiFetch.mockImplementation((url, opts) =>
    String(url).startsWith("/api/auth/mfa/setup/start")
      ? Promise.resolve({ secret: SECRET, otpauth_url: OTPAUTH, reused_pending: true })
      : base(url, opts)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHappyPath();
});

describe("MFA enrollment", () => {
  it("shows the setup key, and does not require a QR scan", async () => {
    await openSetupModal();
    // Manual entry only: the key must be on screen, and there must be no QR
    // demanding a camera we deliberately don't ask for.
    await waitFor(() => expect(screen.getByText(SECRET)).toBeInTheDocument());
    expect(screen.queryByRole("img", { name: /qr code/i })).not.toBeInTheDocument();
  });

  it("issues the secret exactly once per modal open, not on every re-render", async () => {
    await openSetupModal();
    await waitFor(() => expect(screen.getByText(SECRET)).toBeInTheDocument());

    const startCalls = () =>
      apiFetch.mock.calls.filter(([url]) => url.startsWith("/api/auth/mfa/setup/start")).length;
    const afterOpen = startCalls();
    expect(afterOpen).toBe(1);

    // Re-rendering (typing, state churn) must not silently re-issue the key.
    fireEvent.click(screen.getByRole("button", { name: /i've added it/i }));
    fireEvent.change(screen.getByLabelText(/6-digit authenticator code/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(startCalls()).toBe(afterOpen);
  });

  it("reuses a pending key on reopen and says so, instead of invalidating the operator's app", async () => {
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /enable mfa/i }));
    await waitFor(() => expect(screen.getByText(SECRET)).toBeInTheDocument());

    // Reopening must NOT silently swap the secret — the response says the
    // pending enrollment was replayed, and the UI says the old key still works.
    mockReusedPending();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    fireEvent.click(screen.getByRole("button", { name: /enable mfa/i }));

    await waitFor(() => expect(screen.getByText(/same key from your last attempt/i)).toBeInTheDocument());
    expect(screen.getByText(SECRET)).toBeInTheDocument();
  });

  it("only asks the server for a new key when the operator explicitly requests one", async () => {
    apiFetch.mockImplementation((url) => {
      if (url === "/api/auth/mfa/status") return Promise.resolve({ enabled: false });
      if (url === "/api/super-admin/settings") return Promise.resolve(SETTINGS);
      if (String(url).startsWith("/api/auth/mfa/setup/start")) {
        return Promise.resolve({ secret: SECRET, otpauth_url: OTPAUTH });
      }
      if (String(url).startsWith("/api/auth/mfa/setup/verify")) {
        return Promise.reject(new Error("Incorrect verification code."));
      }
      return Promise.resolve({});
    });
    await openSetupModal();
    await waitFor(() => expect(screen.getByText(SECRET)).toBeInTheDocument());

    // Opening the modal must never carry ?regenerate=true.
    const urls = apiFetch.mock.calls
      .map(([url]) => url)
      .filter((u) => u.startsWith("/api/auth/mfa/setup/start"));
    expect(urls.every((u) => !u.includes("regenerate"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /i've added it/i }));
    fireEvent.change(screen.getByLabelText(/6-digit authenticator code/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm & enable/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/incorrect verification code/i));
    fireEvent.click(screen.getByRole("button", { name: /get a new key/i }));

    await waitFor(() =>
      expect(
        apiFetch.mock.calls.some(([u]) => String(u).includes("regenerate=true"))
      ).toBe(true)
    );
  });

  it("does not repeat the server message verbatim alongside its own guidance", async () => {
    apiFetch.mockImplementation((url) => {
      if (url === "/api/auth/mfa/status") return Promise.resolve({ enabled: false });
      if (url === "/api/super-admin/settings") return Promise.resolve(SETTINGS);
      if (url === "/api/auth/mfa/setup/start") return Promise.resolve({ secret: SECRET, otpauth_url: OTPAUTH });
      if (url === "/api/auth/mfa/setup/verify") return Promise.reject(new Error("Incorrect verification code."));
      return Promise.resolve({});
    });
    await openSetupModal();
    await waitFor(() => expect(screen.getByText(SECRET)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /i've added it/i }));
    fireEvent.change(screen.getByLabelText(/6-digit authenticator code/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm & enable/i }));

    const alert = await screen.findByRole("alert");
    // "Codes change every 30s" must appear once, not once per layer.
    const occurrences = (alert.textContent.match(/30s?/gi) || []).length;
    expect(occurrences).toBe(1);
  });

  it("rejects a non-numeric or over-length code before it ever reaches the API", async () => {
    await openSetupModal();
    await waitFor(() => expect(screen.getByText(SECRET)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /i've added it/i }));

    const input = screen.getByLabelText(/6-digit authenticator code/i);
    fireEvent.change(input, { target: { value: "12 34-56 78" } });
    // Letters and separators are dropped, so "12 34-56 78" cannot masquerade
    // as a complete 6-digit code.
    expect(input.value).toBe("123456");
    expect(input.value).toHaveLength(6);
  });

  it("offers a new key when verification fails, and re-issues on demand", async () => {
    apiFetch.mockImplementation((url, opts = {}) => {
      if (url === "/api/auth/mfa/status") return Promise.resolve({ enabled: false });
      if (url === "/api/super-admin/settings") return Promise.resolve(SETTINGS);
      if (url === "/api/auth/mfa/setup/start") return Promise.resolve({ secret: SECRET, otpauth_url: OTPAUTH });
      if (url === "/api/auth/mfa/setup/verify") {
        return Promise.reject(new Error("Incorrect verification code."));
      }
      return Promise.resolve({});
    });

    await openSetupModal();
    await waitFor(() => expect(screen.getByText(SECRET)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /i've added it/i }));
    fireEvent.change(screen.getByLabelText(/6-digit authenticator code/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm & enable/i }));

    // A bare "try again" is not actionable — the usual cause is a stale key.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/incorrect verification code/i));
    expect(screen.getByRole("alert")).toHaveTextContent(/does not match the one above/i);
    expect(screen.getByRole("button", { name: /get a new key/i })).toBeInTheDocument();

    const startCallsBefore = apiFetch.mock.calls.filter(([u]) => String(u).startsWith("/api/auth/mfa/setup/start")).length;
    fireEvent.click(screen.getByRole("button", { name: /get a new key/i }));
    await waitFor(() =>
      expect(
        apiFetch.mock.calls.filter(([u]) => String(u).startsWith("/api/auth/mfa/setup/start")).length
      ).toBe(startCallsBefore + 1)
    );
    expect(
      apiFetch.mock.calls.some(([u]) => String(u).includes("regenerate=true"))
    ).toBe(true);
  });

  it("surfaces a failed start as a retryable error instead of an empty setup screen", async () => {
    apiFetch.mockImplementation((url) => {
      if (url === "/api/auth/mfa/status") return Promise.resolve({ enabled: false });
      if (url === "/api/super-admin/settings") return Promise.resolve(SETTINGS);
      if (url === "/api/auth/mfa/setup/start") return Promise.reject(new Error("setup endpoint down"));
      return Promise.resolve({});
    });

    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /enable mfa/i }));

    await waitFor(() => expect(screen.getByText(/setup endpoint down/i)).toBeInTheDocument());
    // No QR and no dead "continue" button — the operator is told what broke.
    expect(screen.queryByRole("button", { name: /i've added it/i })).not.toBeInTheDocument();
  });
});
