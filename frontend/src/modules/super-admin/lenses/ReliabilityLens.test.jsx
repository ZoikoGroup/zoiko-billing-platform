import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Regression coverage for the Phase 3 architecture remediation fix to
// ReliabilityLens.jsx: R1/R2 used to render hardcoded "Healthy"/"Configured"
// tiles with zero backing evidence. These tests pin the honest-evidence
// contract: an integration can only render green (CONFIGURED/HEALTHY) when
// the backend actually says so, and must render an honest non-green state
// (NOT_CONFIGURED/UNKNOWN/FAILED) otherwise — it can never default to green.

const mockGetApiTelemetry = vi.fn();
const mockGetConfigurationInventory = vi.fn();
const mockApiGet = vi.fn();

vi.mock("../../../service/commandCenterService", () => ({
  getApiTelemetry: (...args) => mockGetApiTelemetry(...args),
  getConfigurationInventory: (...args) => mockGetConfigurationInventory(...args),
}));

vi.mock("../../../service/api", () => ({
  api: { get: (...args) => mockApiGet(...args) },
}));

let mockUser = { platform_role: null };
vi.mock("../../../context/AuthContext", () => ({
  useAuth: () => ({ user: mockUser }),
}));

import ReliabilityLens from "./ReliabilityLens";

function renderLens(jobs = []) {
  return render(
    <MemoryRouter>
      <ReliabilityLens telemetry={null} jobs={jobs} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockUser = { platform_role: null }; // platform_administrator-equivalent (full access)
  mockGetApiTelemetry.mockReset().mockResolvedValue({ sample_count: 0 });
  mockGetConfigurationInventory.mockReset();
  mockApiGet.mockReset();
});

describe("ReliabilityLens — R1 Subsystem Health", () => {
  it("renders the real database liveness result, not a fabricated 'Healthy' default", async () => {
    mockApiGet.mockResolvedValue({ status: "ok", database: "connected" });
    mockGetConfigurationInventory.mockResolvedValue({ entries: [] });
    renderLens();
    await waitFor(() => expect(screen.getByText("HEALTHY")).toBeInTheDocument());
  });

  it("reports the database subsystem as FAILED, not green, when /health says the DB is unreachable", async () => {
    mockApiGet.mockResolvedValue({ status: "ok", database: "unreachable" });
    mockGetConfigurationInventory.mockResolvedValue({ entries: [] });
    renderLens();
    await waitFor(() => expect(screen.getByText("FAILED")).toBeInTheDocument());
  });

  it("reports UNKNOWN, not a fabricated healthy state, when the health check itself fails", async () => {
    mockApiGet.mockRejectedValue(new Error("network error"));
    mockGetConfigurationInventory.mockResolvedValue({ entries: [] });
    renderLens();
    await waitFor(() => expect(screen.getAllByText("UNKNOWN").length).toBeGreaterThan(0));
  });

  it("never renders a bare 'Healthy' claim for subsystems with no dedicated health probe", async () => {
    mockApiGet.mockResolvedValue({ status: "ok", database: "connected" });
    mockGetConfigurationInventory.mockResolvedValue({ entries: [] });
    renderLens();
    await waitFor(() => expect(screen.getByText("HEALTHY")).toBeInTheDocument());
    // Only the one real signal (Database & Core) may say HEALTHY; every other
    // of the 12 listed subsystems must render NOT MONITORED, never "Healthy".
    // (Stripe/SMTP show CHECKING here since configEntries resolves without a
    // matching entry, and the 3 unimplemented integrations always show NOT MONITORED.)
    expect(screen.getAllByText("NOT MONITORED").length).toBe(14);
  });
});

describe("ReliabilityLens — R2 Integration Health", () => {
  it("renders Stripe as NOT CONFIGURED, never green, when the backend reports it absent", async () => {
    mockApiGet.mockResolvedValue({ status: "ok", database: "connected" });
    mockGetConfigurationInventory.mockResolvedValue({
      entries: [
        { name: "stripe.gateway", category: "environment_capability", value: "NOT_CONFIGURED" },
        { name: "smtp.provider", category: "environment_capability", value: "CONFIGURED" },
      ],
    });
    renderLens();
    await waitFor(() => expect(screen.getByText("NOT CONFIGURED")).toBeInTheDocument());
    expect(screen.getByText("CONFIGURED")).toBeInTheDocument();
  });

  it("never claims Stripe or SMTP are CONFIGURED before the real evidence has loaded", () => {
    mockApiGet.mockResolvedValue({ status: "ok", database: "connected" });
    mockGetConfigurationInventory.mockReturnValue(new Promise(() => {})); // never resolves
    renderLens();
    // While pending, must not show a green "CONFIGURED" claim for either integration.
    expect(screen.queryByText("CONFIGURED")).not.toBeInTheDocument();
  });

  it("falls back to UNKNOWN, not green, for a platform role without configuration-read access", async () => {
    mockUser = { platform_role: "finance_readonly" };
    mockApiGet.mockResolvedValue({ status: "ok", database: "connected" });
    renderLens();
    await waitFor(() => expect(screen.getAllByText("UNKNOWN").length).toBeGreaterThan(0));
    expect(mockGetConfigurationInventory).not.toHaveBeenCalled();
  });

  it("marks integrations with no backend implementation as NOT MONITORED, never green", async () => {
    mockApiGet.mockResolvedValue({ status: "ok", database: "connected" });
    mockGetConfigurationInventory.mockResolvedValue({ entries: [] });
    renderLens();
    await waitFor(() => {
      expect(screen.getByText("Tax Providers (Avalara/TaxJar)")).toBeInTheDocument();
    });
    const notMonitored = screen.getAllByText("NOT MONITORED");
    // 11 subsystems (R1) + 3 unimplemented integrations (R2) = 14
    expect(notMonitored.length).toBe(14);
  });
});
