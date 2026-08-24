import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// ZB-SA-CMD-003 §13 — every Command Center module must be able to say which
// state it is in, and each state must render distinctly and honestly.

import ModuleState, { MODULE_STATES } from "./ModuleState";

describe("ModuleState", () => {
  it("renders a true zero as a finding, with its own label and tone", () => {
    render(<ModuleState status="zero" />);
    expect(screen.getAllByText("Zero").length).toBeGreaterThan(0);;
    // Zero is never dressed up as an error or as unknown.
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  });

  it("renders UNKNOWN with its default honest explanation", () => {
    render(<ModuleState status="unknown" />);
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);;
    expect(
      screen.getByText(/cannot currently determine a value/i)
    ).toBeInTheDocument();
  });

  it("renders NOT CONFIGURED instead of implying coverage", () => {
    render(<ModuleState status="not_configured" title="SLOs & Error Budgets" />);
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText(/No backing data source exists/i)).toBeInTheDocument();
  });

  it("renders permission_denied distinctly from error", () => {
    render(<ModuleState status="permission_denied" />);
    expect(screen.getAllByText("Permission required").length).toBeGreaterThan(0);;
    expect(screen.getByText(/platform role does not include/i)).toBeInTheDocument();
  });

  it("shows a retry affordance only for error/partial states that provide one", () => {
    const onRetry = vi.fn();
    const { unmount } = render(<ModuleState status="error" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();

    render(<ModuleState status="fresh" />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("honors explicit detail overrides over defaults", () => {
    render(<ModuleState status="stale" detail="Last successful run 3 hours ago." />);
    expect(screen.getByText(/Last successful run 3 hours ago/i)).toBeInTheDocument();
  });

  it("exposes a stable style map for all nine spec states", () => {
    for (const key of [
      "loading",
      "zero",
      "not_configured",
      "fresh",
      "stale",
      "unknown",
      "partial",
      "error",
      "permission_denied",
    ]) {
      expect(MODULE_STATES[key]).toBeDefined();
    }
  });
});
