import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// ── Module mocks ─────────────────────────────────────────────────────────────
vi.mock("../api/client", () => ({
  apiFetch: vi.fn(),
  setSession: vi.fn(),
}));

const loginMock = vi.fn(() => Promise.resolve());
vi.mock("../context/AuthContext", () => ({
  useAuth: () => ({ login: loginMock }),
}));

import { apiFetch, setSession } from "../api/client";
import LoginPage from "./LoginPage";

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<div>SUPER ADMIN DASHBOARD</div>} />
        <Route
          path="/organization-admin/dashboard"
          element={<div>ORG ADMIN DASHBOARD</div>}
        />
      </Routes>
    </MemoryRouter>
  );
}

function fillForm({ email, password }) {
  if (email !== undefined) {
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: email },
    });
  }
  if (password !== undefined) {
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: password },
    });
  }
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Frontend validation ──────────────────────────────────────────────────────

describe("LoginPage — client-side validation", () => {
  it("blocks submission and shows a field error when the email is empty", async () => {
    renderLogin();
    fillForm({ password: "SomePass123!" });
    submit();

    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("blocks submission for a malformed email address", async () => {
    renderLogin();
    fillForm({ email: "not-an-email", password: "SomePass123!" });
    submit();

    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("blocks submission for a whitespace-only email address", async () => {
    renderLogin();
    fillForm({ email: "   ", password: "SomePass123!" });
    submit();

    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("blocks submission and shows a field error when the password is empty", async () => {
    renderLogin();
    fillForm({ email: "user@example.com" });
    submit();

    expect(await screen.findByText("Enter your password.")).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("shows both field errors when everything is empty", async () => {
    renderLogin();
    submit();

    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

// ── Request shape ────────────────────────────────────────────────────────────

describe("LoginPage — request payload", () => {
  it("sends a trimmed email and the untouched password", async () => {
    apiFetch.mockResolvedValue({
      access_token: "at",
      refresh_token: "rt",
      token_type: "bearer",
      user: { role: "org_admin", email: "user@example.com" },
    });
    renderLogin();
    fillForm({ email: "  user@example.com  ", password: "  padded-pass  " });
    submit();

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const [path, opts] = apiFetch.mock.calls[0];
    expect(path).toBe("/api/auth/login");
    expect(opts.method).toBe("POST");
    expect(opts.body.email).toBe("user@example.com");
    // Password is transmitted exactly as typed — never trimmed or altered.
    expect(opts.body.password).toBe("  padded-pass  ");
  });
});

// ── Error categorization ─────────────────────────────────────────────────────

describe("LoginPage — API error categorization", () => {
  it.each([401, 403])("shows invalid credentials for a %i auth rejection", async (status) => {
    apiFetch.mockRejectedValue(
      Object.assign(new Error("Invalid email or password."), { status, serverDetail: "Invalid email or password." })
    );
    renderLogin();
    fillForm({ email: "user@example.com", password: "wrong-pass" });
    submit();

    expect(await screen.findByText("Invalid email or password.")).toBeInTheDocument();
  });

  it("does not mask an account-state 401 (suspended org) as bad credentials", async () => {
    apiFetch.mockRejectedValue(
      Object.assign(new Error("Your organization has been suspended. Please contact support."), {
        status: 401,
        serverDetail: "Your organization has been suspended. Please contact support.",
      })
    );
    renderLogin();
    fillForm({ email: "user@example.com", password: "whatever" });
    submit();

    expect(
      await screen.findByText("Your organization has been suspended. Please contact support.")
    ).toBeInTheDocument();
  });

  it("shows the server-error copy for a 5xx response", async () => {
    apiFetch.mockRejectedValue(
      Object.assign(new Error("Request failed (500)"), { status: 500, serverDetail: undefined })
    );
    renderLogin();
    fillForm({ email: "user@example.com", password: "SomePass123!" });
    submit();

    expect(
      await screen.findByText("We couldn't sign you in right now. Please try again.")
    ).toBeInTheDocument();
  });

  it("shows the rate-limit copy for a 429 response", async () => {
    apiFetch.mockRejectedValue(
      Object.assign(new Error("Request failed (429)"), { status: 429 })
    );
    renderLogin();
    fillForm({ email: "user@example.com", password: "SomePass123!" });
    submit();

    expect(
      await screen.findByText("Too many sign-in attempts. Please wait a minute and try again.")
    ).toBeInTheDocument();
  });

  it("shows the network-failure copy when the request cannot connect", async () => {
    apiFetch.mockRejectedValue(
      Object.assign(new Error("Network request failed."), { status: 0, network: true })
    );
    renderLogin();
    fillForm({ email: "user@example.com", password: "SomePass123!" });
    submit();

    expect(
      await screen.findByText("Unable to connect. Check your internet connection and try again.")
    ).toBeInTheDocument();
  });

  it("shows the server-error copy for a malformed (session-less) 2xx response", async () => {
    apiFetch.mockResolvedValue({ detail: "unexpected" });
    renderLogin();
    fillForm({ email: "user@example.com", password: "SomePass123!" });
    submit();

    expect(
      await screen.findByText("We couldn't sign you in right now. Please try again.")
    ).toBeInTheDocument();
    expect(setSession).not.toHaveBeenCalled();
  });
});

// ── Success flow ─────────────────────────────────────────────────────────────

describe("LoginPage — successful authentication", () => {
  const successPayload = {
    access_token: "access-123",
    refresh_token: "refresh-456",
    token_type: "bearer",
    user: { role: "org_admin", email: "user@example.com" },
  };

  it("persists the session and redirects to the role's default page", async () => {
    apiFetch.mockResolvedValue(successPayload);
    renderLogin();
    fillForm({ email: "user@example.com", password: "CorrectPass123!" });
    submit();

    expect(await screen.findByText("ORG ADMIN DASHBOARD")).toBeInTheDocument();
    expect(setSession).toHaveBeenCalledWith(successPayload);
    expect(loginMock).toHaveBeenCalledWith(successPayload.user);
  });

  it("clears any previous error banner on a subsequent attempt", async () => {
    apiFetch.mockRejectedValueOnce(Object.assign(new Error("x"), { status: 401 }));
    renderLogin();
    fillForm({ email: "user@example.com", password: "wrong" });
    submit();
    expect(await screen.findByText("Invalid email or password.")).toBeInTheDocument();

    apiFetch.mockResolvedValueOnce(successPayload);
    submit();
    await waitFor(() =>
      expect(screen.queryByText("Invalid email or password.")).not.toBeInTheDocument()
    );
  });
});

// ── Button behavior ──────────────────────────────────────────────────────────

describe("LoginPage — Sign In button states", () => {
  it("disables the button with a loading label while authenticating, re-enables afterwards", async () => {
    let resolveLogin;
    apiFetch.mockImplementation(
      () => new Promise((resolve) => { resolveLogin = resolve; })
    );
    renderLogin();
    fillForm({ email: "user@example.com", password: "SomePass123!" });

    submit();
    const btn = screen.getByRole("button", { name: /signing in/i });
    expect(btn).toBeDisabled();

    resolveLogin({
      access_token: "a", refresh_token: "r", token_type: "bearer",
      user: { role: "org_admin" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign in/i })).toBeEnabled()
    );
  });

  it("re-enables the button after a failure so the user can retry", async () => {
    let rejectLogin;
    apiFetch.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectLogin = reject; })
    );
    renderLogin();
    fillForm({ email: "user@example.com", password: "wrong" });

    submit();
    expect(screen.getByRole("button", { name: /signing in/i })).toBeDisabled();

    rejectLogin(Object.assign(new Error("Invalid email or password."), { status: 401 }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /sign in/i })).toBeEnabled()
    );
    expect(await screen.findByText("Invalid email or password.")).toBeInTheDocument();
  });

  it("ignores duplicate submissions while a request is already in flight", async () => {
    let resolveLogin;
    apiFetch.mockImplementation(
      () => new Promise((resolve) => { resolveLogin = resolve; })
    );
    renderLogin();
    fillForm({ email: "user@example.com", password: "SomePass123!" });

    const btn = screen.getByRole("button", { name: /sign in/i });
    fireEvent.click(btn);
    fireEvent.click(btn); // rapid second click before re-render

    resolveLogin({
      access_token: "a", refresh_token: "r", token_type: "bearer",
      user: { role: "org_admin" },
    });
    await waitFor(() => expect(loginMock).toHaveBeenCalled());
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});

// ── Password visibility ──────────────────────────────────────────────────────

describe("LoginPage — password field", () => {
  it("masks by default and toggles visibility with the eye control", () => {
    renderLogin();
    const pw = screen.getByLabelText("Password");
    expect(pw).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(pw).toHaveAttribute("type", "text");

    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(pw).toHaveAttribute("type", "password");
  });

  it("never places the password value into the DOM as visible text", () => {
    renderLogin();
    fillForm({ password: "secret-value" });
    expect(document.body.textContent).not.toContain("secret-value");
  });
});
