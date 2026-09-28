import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Regression for the Super Admin Command Center's "Domain" filter (§A of the
// Super Admin defect sweep): the dropdown's onChange handler only called
// `setActiveLens()`, which updates CommandCenterContext state that NOTHING
// in the app ever reads back out (grep confirms `activeLens` has exactly one
// consumer: the context module itself). Picking "Domain A (Commercial)" or
// "Domain C (Telemetry)" therefore silently did nothing — no navigation, no
// change to what was on screen — even though the component's own comment
// says domain selection is "the only cross-domain navigation primitive the
// platform actually has". The fix makes it actually navigate to the matching
// lens route.

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

const mockUpdateContextScope = vi.fn();
const mockSetActiveLens = vi.fn();

vi.mock("../context/CommandCenterContext", () => ({
  useCommandCenter: () => ({
    contextScope: {
      environment: "PRODUCTION",
      domain: "Global Operations",
      period: "Last 30 Days",
    },
    updateContextScope: mockUpdateContextScope,
    setActiveLens: mockSetActiveLens,
    lastRefreshedAt: new Date("2026-01-01T00:00:00Z"),
    requestRefresh: vi.fn(),
    environmentVerified: true,
  }),
}));

import CommandCenterContextBar from "./CommandCenterContextBar";

function selectDomain(value) {
  fireEvent.change(screen.getByLabelText(/filter by domain/i), { target: { value } });
}

describe("CommandCenterContextBar domain filter", () => {
  it("navigates to the Commercial lens when Domain A is selected", () => {
    render(<CommandCenterContextBar />);
    selectDomain("Domain A (Commercial)");
    expect(mockNavigate).toHaveBeenCalledWith("/super-admin/organizations");
  });

  it("navigates to the Reliability lens when Domain C is selected", () => {
    render(<CommandCenterContextBar />);
    selectDomain("Domain C (Telemetry)");
    expect(mockNavigate).toHaveBeenCalledWith("/super-admin/reliability");
  });

  it("navigates to the Triage lens when Global Operations is selected", () => {
    render(<CommandCenterContextBar />);
    selectDomain("Global Operations");
    expect(mockNavigate).toHaveBeenCalledWith("/super-admin/triage");
  });

  it("still updates the shell's context scope (existing behavior preserved)", () => {
    render(<CommandCenterContextBar />);
    selectDomain("Domain A (Commercial)");
    expect(mockUpdateContextScope).toHaveBeenCalledWith("domain", "Domain A (Commercial)");
    expect(mockSetActiveLens).toHaveBeenCalledWith("commercial");
  });
});
