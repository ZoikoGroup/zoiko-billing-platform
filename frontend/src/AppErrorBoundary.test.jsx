import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ErrorBoundary } from "./App";

function Thrower({ error }) {
  throw error;
}

function renderWithError(error) {
  // React logs caught render errors to console.error; keep test output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
  return render(
    <ErrorBoundary>
      <Thrower error={error} />
    </ErrorBoundary>
  );
}

describe("App ErrorBoundary", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("shows the update message and a Reload button for chunk-load errors", () => {
    renderWithError(new TypeError("Failed to fetch dynamically imported module: /assets/AssistantPanel-abc.js"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Zoiko Billing was updated. Reload to continue.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
    expect(screen.queryByText(/Render Error/)).not.toBeInTheDocument();
  });

  it("shows a generic message and hides technical details in production builds", () => {
    vi.stubEnv("DEV", false);
    renderWithError(new Error("Cannot read properties of undefined (reading 'secretField')"));
    expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
    expect(screen.queryByTestId("error-details")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("secretField");
  });

  it("shows technical details in development builds", () => {
    vi.stubEnv("DEV", true);
    renderWithError(new Error("boom in dev"));
    expect(screen.getByTestId("error-details")).toHaveTextContent("boom in dev");
  });

  it("uses a fluid layout that fits a 360px viewport", () => {
    window.innerWidth = 360;
    renderWithError(new TypeError("Failed to fetch dynamically imported module: /assets/x.js"));
    const card = screen.getByRole("alert");
    // Fluid: full width up to a max, outer gutter, no fixed pixel widths.
    expect(card.className).toMatch(/\bw-full\b/);
    expect(card.className).toMatch(/\bmax-w-md\b/);
    expect(card.parentElement.className).toMatch(/\bpx-4\b/);
    expect(screen.getByRole("button", { name: /reload/i }).className).toMatch(/\bw-full\b/);
    for (const el of [card, ...card.querySelectorAll("*")]) {
      expect(el.getAttribute("style") || "").not.toMatch(/width\s*:\s*\d+px/);
    }
  });
});
