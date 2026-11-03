import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Regression coverage for the Command Center / Triage-area fixes:
// Hub source-error counting + honest "—" tiles, Notifications truncation,
// Kill Switch auto-expiry + naive-UTC dates + inline refresh errors, Tenant
// Health independent sources + filters, Launch Readiness re-run failures,
// and the lens components' fabricated-green states.

const cc = vi.hoisted(() => ({
  getTriageSummary: vi.fn(),
  getApiTelemetry: vi.fn(),
  getEmailDeliveryOverview: vi.fn(),
}));
vi.mock("../../service/commandCenterService", () => cc);

const commercial = vi.hoisted(() => ({
  getBillingKillSwitch: vi.fn(),
  setBillingKillSwitch: vi.fn(),
  listApprovalRequests: vi.fn(),
}));
vi.mock("../../service/commercialService", () => commercial);

const telemetry = vi.hoisted(() => ({
  getTenantHealthOverview: vi.fn(),
  getJobTelemetry: vi.fn(),
}));
vi.mock("../../service/privilegedAccessService", () => telemetry);

const apiMock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../service/api", () => ({ api: apiMock }));

vi.mock("../../context/CommandCenterContext", () => ({
  useCommandCenter: () => ({ refreshTick: 0, requestRefresh: vi.fn(), worstFreshness: null }),
}));
vi.mock("../../hooks/usePolling", () => ({ default: () => {} }));
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ user: { platform_role: "support_operator" } }),
}));
vi.mock("../../hooks/useIsDesktopViewport", () => ({ default: () => true }));

import CommandCenterHubPage from "./CommandCenterHubPage";
import NotificationsPage from "./NotificationsPage";
import KillSwitchPage from "./KillSwitchPage";
import TenantHealthPage from "./TenantHealthPage";
import LaunchReadinessPage from "./LaunchReadinessPage";
import TriageLens from "./lenses/TriageLens";
import GovernanceLens from "./lenses/GovernanceLens";
import { formatDateTime } from "./constants";

const wrap = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

function summary(overrides = {}) {
  return {
    generated_at: "2026-01-01T00:00:00",
    incidents: {
      counts: { p0: 0, p1: 0, p2: 0, p3: 0, total_open: 0, sla_breaches: 0 },
      top_items: [],
    },
    pipeline_stages: [],
    scheduler_enabled: true,
    safety_controls: [{ scope: "x", display_name: "X", enabled: true, expires_at: null, reason: null }],
    critical_events: [],
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CommandCenterHubPage", () => {
  it("does not report healthy sources as unreachable once they all loaded", async () => {
    cc.getTriageSummary.mockResolvedValue(summary());
    cc.getApiTelemetry.mockResolvedValue({ sample_count: 3, p95_ms: 100, p95_budget_ms: 800 });
    cc.getEmailDeliveryOverview.mockResolvedValue({ smtp_health: "healthy", last_24h: { failed: 0, failure_rate_pct: 0 } });
    wrap(<CommandCenterHubPage />);

    await waitFor(() => expect(screen.getByText("No critical incidents open")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText(/Email Delivery: 0 failed/)).toBeInTheDocument());
    expect(screen.queryByText(/couldn't be reached/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/partial visibility/i)).not.toBeInTheDocument();
    // One load per source on mount (the old effects fired twice).
    expect(cc.getTriageSummary).toHaveBeenCalledTimes(1);
    expect(cc.getApiTelemetry).toHaveBeenCalledTimes(1);
  });

  it("shows '—' (not a reassuring 0) and counts only the failed source when triage fails", async () => {
    cc.getTriageSummary.mockRejectedValue(new Error("boom"));
    cc.getApiTelemetry.mockResolvedValue({ sample_count: 0, slo: { p95_budget_ms: 800 } });
    cc.getEmailDeliveryOverview.mockResolvedValue({ smtp_health: "healthy", last_24h: { failed: 0, failure_rate_pct: 0 } });
    wrap(<CommandCenterHubPage />);

    await waitFor(() => expect(screen.getByText(/1 data source couldn't be reached/i)).toBeInTheDocument());
    expect(screen.getByTestId("hero-critical")).toHaveTextContent("—");
    expect(screen.getByTestId("hero-engaged")).toHaveTextContent("—");
    expect(screen.queryByText("No critical incidents open")).not.toBeInTheDocument();
    // Empty telemetry window: honest "no samples", never "within budget".
    expect(screen.getByLabelText(/API Performance: —\. No requests measured yet/)).toBeInTheDocument();
    expect(screen.getByText("No requests in the window yet")).toBeInTheDocument();
  });

  it("does not call job freshness 'Fresh' when it is not tracked", async () => {
    cc.getTriageSummary.mockResolvedValue(summary());
    cc.getApiTelemetry.mockResolvedValue({ sample_count: 0 });
    cc.getEmailDeliveryOverview.mockResolvedValue({ smtp_health: "unknown", last_24h: { failed: 0 } });
    wrap(<CommandCenterHubPage />);
    await waitFor(() => expect(screen.getByLabelText(/Job Freshness: Not tracked/)).toBeInTheDocument());
    expect(screen.queryByLabelText(/Job Freshness: Fresh/)).not.toBeInTheDocument();
  });
});

describe("NotificationsPage", () => {
  it("says when the feed is only the top slice of a larger open queue, and rows are buttons", async () => {
    cc.getTriageSummary.mockResolvedValue(
      summary({
        incidents: {
          counts: { p0: 1, p1: 0, p2: 0, p3: 0, total_open: 12, sla_breaches: 0 },
          top_items: [{ id: 1, title: "Payment job failing", severity: "p0", status: "open", opened_at: "2026-01-01T10:00:00", occurrence_count: 1 }],
        },
      })
    );
    wrap(<NotificationsPage />);
    expect(await screen.findByText(/Showing the 1 highest-priority of 12 open items/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Payment job failing/ })).toBeInTheDocument();
    // Naive UTC timestamp rendered as UTC, not local time.
    expect(screen.getByText(new RegExp(formatDateTime(new Date("2026-01-01T10:00:00Z")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
  });
});

describe("KillSwitchPage", () => {
  const disabled = {
    id: 2,
    scope: "commercial_subscription_charging",
    enabled: false,
    reason: "Incident",
    expires_at: "2099-01-01T08:00:00",
    changed_at: "2026-01-01T00:00:00",
    changed_by_email: "ops@example.com",
  };

  it("shows when a pause lifts automatically (backend auto-expiry), read as UTC", async () => {
    commercial.getBillingKillSwitch.mockResolvedValue(disabled);
    wrap(<KillSwitchPage />);
    const expected = formatDateTime(new Date("2099-01-01T08:00:00Z"));
    expect(await screen.findByText(`Pause lifts automatically at ${expected}`)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`Last changed ${formatDateTime(new Date("2026-01-01T00:00:00Z"))}`))).toBeInTheDocument();
  });

  it("keeps the switch on screen when a refresh fails", async () => {
    commercial.getBillingKillSwitch.mockResolvedValueOnce(disabled).mockRejectedValueOnce(new Error("Network down"));
    wrap(<KillSwitchPage />);
    await screen.findByText("Disabled");
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Network down/);
    expect(screen.getByText("Disabled")).toBeInTheDocument();
  });

  it("treats a whitespace-only reason as missing and sends a trimmed reason", async () => {
    commercial.getBillingKillSwitch.mockResolvedValue(disabled);
    commercial.setBillingKillSwitch.mockResolvedValue({ ...disabled, enabled: true, expires_at: null });
    wrap(<KillSwitchPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Re-enable charging" }));
    const dialog = await screen.findByRole("dialog");
    const reason = within(dialog).getByLabelText(/reason/i);
    const submit = within(dialog).getByRole("button", { name: "Re-enable charging" });
    fireEvent.change(reason, { target: { value: "   " } });
    expect(submit).toBeDisabled();
    fireEvent.change(reason, { target: { value: "  Resolved  " } });
    fireEvent.click(submit);
    await waitFor(() => expect(commercial.setBillingKillSwitch).toHaveBeenCalledWith(true, "Resolved"));
  });
});

describe("TenantHealthPage", () => {
  const overview = {
    plane: "PLATFORM",
    generated_at: "2026-01-01T00:00:00",
    summary: {
      total_organizations: 2,
      counts_by_lifecycle_state: { active: 2 },
      open_incident_total: 0,
      jobs_tracked: 0,
      jobs_with_failures_24h: 0,
      jobs_not_fresh: 0,
    },
    organizations: [
      { id: 1, organization_code: "ACME", organization_name: "Acme Inc.", lifecycle_state: "active", total_users: 1, active_users: 1 },
      { id: 2, organization_code: "GLOBEX", organization_name: "Globex", lifecycle_state: "active", total_users: 1, active_users: 1 },
    ],
  };

  it("still shows the tenant table when only the job feed fails", async () => {
    telemetry.getTenantHealthOverview.mockResolvedValue(overview);
    telemetry.getJobTelemetry.mockRejectedValue(new Error("jobs down"));
    wrap(<TenantHealthPage />);
    expect((await screen.findAllByText("Acme Inc.")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/unable to load tenant telemetry/i)).not.toBeInTheDocument();
  });

  it("distinguishes 'no matches' from 'none yet' and offers Clear filters", async () => {
    telemetry.getTenantHealthOverview.mockResolvedValue(overview);
    telemetry.getJobTelemetry.mockResolvedValue({ jobs: [], scheduler_enabled: true });
    wrap(<TenantHealthPage />);
    await screen.findAllByText("Acme Inc.");
    fireEvent.change(screen.getByPlaceholderText(/search organization/i), { target: { value: "zzz" } });
    expect(await screen.findAllByText("No organizations match these filters")).not.toHaveLength(0);
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    expect((await screen.findAllByText("Globex")).length).toBeGreaterThan(0);
  });
});

describe("LaunchReadinessPage", () => {
  it("keeps the previous results when a re-run fails, worst checks first", async () => {
    apiMock.get
      .mockResolvedValueOnce({
        overall_status: "FAIL",
        items: [
          { id: "A-1", criterion: "Passing check", status: "PASS", evidence: "ok" },
          { id: "B-1", criterion: "Failing check", status: "FAIL", evidence: "bad" },
        ],
      })
      .mockRejectedValueOnce(new Error("server down"));
    wrap(<LaunchReadinessPage />);
    await screen.findByText("Failing check");
    const failing = screen.getByText("Failing check");
    const passing = screen.getByText("Passing check");
    expect(failing.compareDocumentPosition(passing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /re-run checks/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/server down/);
    expect(screen.getByText("Failing check")).toBeInTheDocument();
  });
});

describe("Lenses never fabricate a green state", () => {
  it("TriageLens without data does not claim 'No active incidents'", () => {
    wrap(<TriageLens triageData={null} />);
    expect(screen.queryByText("No active incidents")).not.toBeInTheDocument();
    expect(screen.getByText("Incident data unavailable")).toBeInTheDocument();
  });

  it("GovernanceLens shows 'Unavailable', not 'Queue Empty', when the approval fetch fails", async () => {
    commercial.listApprovalRequests.mockRejectedValue(new Error("403"));
    wrap(<GovernanceLens readiness={null} activity={[]} />);
    expect(await screen.findByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Queue Empty")).not.toBeInTheDocument();
  });
});
