import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../service/commandCenterService", () => ({
  getTriageSummary: vi.fn(() =>
    Promise.resolve({
      generated_at: "2026-01-01T00:00:00Z",
      incidents: {
        counts: { p0: 1, p1: 0, p2: 2, p3: 0, total_open: 3, sla_breaches: 0 },
        by_severity: [],
        top_incidents: [],
      },
      safety_controls: [
        { scope: "commercial_subscription_charging", display_name: "Charging", enabled: true, expires_at: null, reason: null },
      ],
    })
  ),
  getApiTelemetry: vi.fn(() =>
    Promise.resolve({ p95_ms: 120, p95_budget_ms: 800, error_rate: 0.001, sample_count: 50, slo: { status: "NOT_CONFIGURED" } })
  ),
  listAttentionItems: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../service/commercialService", () => ({
  getBillingKillSwitch: vi.fn(() =>
    Promise.resolve({ id: 2, scope: "commercial_subscription_charging", enabled: true, reason: null, expires_at: null })
  ),
  setBillingKillSwitch: vi.fn(),
}));

vi.mock("../../service/api", () => ({
  api: {
    get: vi.fn((path) => {
      if (path.includes("launch-readiness")) {
        return Promise.resolve({
          overall_status: "WARNING",
          items: [{ id: "DB-01", criterion: "Database connectivity", status: "PASS" }],
        });
      }
      return Promise.resolve({});
    }),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
  },
}));

import CommandCenterHubPage from "./CommandCenterHubPage";
import TriagePage from "./TriagePage";
import KillSwitchPage from "./KillSwitchPage";
import LaunchReadinessPage from "./LaunchReadinessPage";
import { CommandCenterProvider } from "../../context/CommandCenterContext";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("../../context/AuthContext", () => ({ useAuth }));

function Wrapper({ children }) {
  // CommandCenterHubPage (and any future page under this section) reads
  // shell state via useCommandCenter() — it throws outside this provider,
  // exactly like it would if a route were ever mounted without it.
  return (
    <MemoryRouter>
      <CommandCenterProvider>{children}</CommandCenterProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  useAuth.mockReturnValue({
    user: { role: "super_admin", name: "Admin" },
    activeGrant: null,
    sessionReady: true,
  });
});

describe.each([
  ["CommandCenterHubPage", CommandCenterHubPage],
  ["TriagePage", TriagePage],
  ["KillSwitchPage", KillSwitchPage],
  ["LaunchReadinessPage", LaunchReadinessPage],
])("%s smoke render", (name, Page) => {
  it("renders without crashing and shows real content", async () => {
    const { container } = render(
      <Wrapper>
        <Page />
      </Wrapper>
    );
    await waitFor(() => expect(container.textContent).not.toBe(""), { timeout: 3000 });
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });
});
