import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../service/commercialService", () => ({
  listOrganizations: vi.fn(() =>
    Promise.resolve({
      organizations: [
        {
          id: 1,
          organization_name: "Acme Inc.",
          organization_code: "ACME",
          lifecycle_state: "active",
          billing_source: "self_serve",
          billing_classification: "standard",
          subscription_status: "active",
          subscription_plan_code: "PRO",
          active_users: 3,
          total_users: 5,
          org_admins: 1,
          open_incident_count: 2,
          last_activity_at: "2026-08-01T00:00:00Z",
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      total: 1,
    })
  ),
  createOrganization: vi.fn(),
  getPlatformLifecycle: vi.fn(() =>
    Promise.resolve({
      total_organizations: 2,
      counts_by_state: { active: 1, onboarding: 1 },
      onboarding_pipeline: [
        {
          id: 2,
          organization_name: "New Co",
          organization_code: "NEWCO",
          registered_at: "2026-08-01T00:00:00Z",
          state: "onboarding",
          onboarding_readiness: { administrator: "PASS", configuration: "PENDING" },
          blockers: ["Awaiting admin invite acceptance"],
        },
      ],
      blocked_organizations: [
        {
          id: 3,
          organization_name: "Blocked Co",
          organization_code: "BLOCKED",
          lifecycle_state: "suspended",
          last_transition_reason: "Non-payment",
          last_transition_at: "2026-07-01T00:00:00Z",
        },
      ],
      recent_transitions: [
        {
          id: 4,
          created_at: "2026-08-01T00:00:00Z",
          organization_id: 3,
          organization_code: "BLOCKED",
          organization_name: "Blocked Co",
          from_state: "active",
          to_state: "suspended",
          actor_email: "admin@zoiko.com",
          reason: "Non-payment",
          correlation_id: "abc-123",
        },
      ],
      generated_at: "2026-01-01T00:00:00Z",
      plane: "PLATFORM",
    })
  ),
}));

vi.mock("../../service/privilegedAccessService", () => ({
  searchOrganizations: vi.fn(() => Promise.resolve({ organizations: [] })),
  requestPrivilegedAccess: vi.fn(),
  activatePrivilegedAccess: vi.fn(),
  getActivePrivilegedAccess: vi.fn(() =>
    Promise.resolve({
      id: 9,
      status: "active",
      organization_id: 1,
      organization_name: "Acme Inc.",
      organization_code: "ACME",
      ticket_reference: "INC-1",
      expires_at: "2026-08-24T12:00:00Z",
      reason: "debug",
    })
  ),
  exitPrivilegedAccess: vi.fn(),
  listMyPrivilegedAccess: vi.fn(() =>
    Promise.resolve({
      grants: [
        {
          id: 9,
          organization_name: "Acme Inc.",
          ticket_reference: "INC-1",
          requested_at: "2026-08-24T11:00:00Z",
          status: "active",
        },
      ],
    })
  ),
  getPrivilegedAccessTenantSummary: vi.fn(() =>
    Promise.resolve({
      customer_summary: { total_active_customers: 12 },
      subscription_summary: { total_active_subscriptions: 4 },
      invoice_summary: { paid: 10, overdue: 2 },
    })
  ),
  getOrganizationTelemetry: vi.fn(() => Promise.resolve({})),
  getJobTelemetry: vi.fn(() => Promise.resolve({ jobs: [], scheduler_enabled: false })),
  getTenantHealthOverview: vi.fn(() =>
    Promise.resolve({
      summary: {
        total_organizations: 2,
        counts_by_lifecycle_state: { active: 1, onboarding: 1 },
        open_incident_total: 2,
        jobs_tracked: 3,
        jobs_with_failures_24h: 1,
        jobs_not_fresh: 0,
      },
      organizations: [
        {
          id: 1,
          organization_code: "ACME",
          organization_name: "Acme Inc.",
          lifecycle_state: "active",
          total_users: 5,
          active_users: 3,
          suspended_users: 1,
          unverified_users: 1,
          org_admins: 1,
          open_incident_count: 2,
          worst_open_severity: "p1",
          last_incident_at: "2026-08-01T00:00:00Z",
          last_activity_at: "2026-08-20T00:00:00Z",
        },
      ],
      plane: "PLATFORM",
    })
  ),
  getFinancialConsistency: vi.fn(() => Promise.resolve({})),
}));

vi.mock("../../service/commandCenterService", () => ({
  getAttentionCounts: vi.fn(() => Promise.resolve({})),
  getConfigurationInventory: vi.fn(() => Promise.resolve({})),
  getTriageSummary: vi.fn(() => Promise.resolve({})),
  getApiTelemetry: vi.fn(() => Promise.resolve({})),
}));

vi.mock("../../api/client", () => ({
  apiFetch: vi.fn((path) => {
    if (path === "/api/auth/me") return Promise.resolve({ id: 1, platform_role: "platform_administrator" });
    if (path === "/api/super-admin/users") {
      return Promise.resolve({
        users: [
          {
            id: 1,
            first_name: "Jane",
            last_name: "Doe",
            email: "jane@acme.com",
            role: "org_admin",
            organization_name: "Acme Inc.",
            derived_status: "active",
            is_active: true,
            last_login_at: "2026-08-01T00:00:00Z",
            mfa_enabled: false,
            platform_role: null,
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            id: 2,
            first_name: "Sam",
            last_name: "Root",
            email: "sam@zoiko.com",
            role: "super_admin",
            organization_name: null,
            derived_status: "active",
            is_active: true,
            last_login_at: null,
            mfa_enabled: true,
            platform_role: "platform_administrator",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        total: 2,
      });
    }
    return Promise.resolve({});
  }),
}));

import { CommandCenterProvider } from "../../context/CommandCenterContext";
import OrganizationsPage from "./OrganizationsPage";
import SupportAccessPage from "./SupportAccessPage";
import LifecycleOnboardingPage from "./LifecycleOnboardingPage";
import TenantHealthPage from "./TenantHealthPage";
import UsersPage from "../../pages/UsersPage";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("../../context/AuthContext", () => ({ useAuth }));

function Wrapper({ children }) {
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
  ["OrganizationsPage", OrganizationsPage],
  ["SupportAccessPage", SupportAccessPage],
  ["LifecycleOnboardingPage", LifecycleOnboardingPage],
  ["TenantHealthPage", TenantHealthPage],
  ["UsersPage", UsersPage],
])("%s smoke render (Platform section)", (name, Page) => {
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

describe("TenantHealthPage capability gating", () => {
  it("shows an honest permission message for a role without reliability.read, instead of a raw error", async () => {
    // support_operator now holds reliability.read (granted per user request) —
    // finance_readonly is a role that still lacks it, so this exercises the
    // denial path without going stale the next time the role map changes.
    useAuth.mockReturnValue({
      user: { role: "super_admin", platform_role: "finance_readonly", name: "Finance" },
      activeGrant: null,
      sessionReady: true,
    });

    render(
      <Wrapper>
        <TenantHealthPage />
      </Wrapper>
    );

    await waitFor(() =>
      expect(screen.getByText(/does not include the reliability\.read capability/i)).toBeInTheDocument()
    );
    expect(screen.queryByText(/unable to load tenant telemetry/i)).not.toBeInTheDocument();
  });

  it("support_operator now has real access — no permission message, real content loads", async () => {
    useAuth.mockReturnValue({
      user: { role: "super_admin", platform_role: "support_operator", name: "Support" },
      activeGrant: null,
      sessionReady: true,
    });

    render(
      <Wrapper>
        <TenantHealthPage />
      </Wrapper>
    );

    await waitFor(() => expect(screen.getByText(/organization\(s\) · plane/i)).toBeInTheDocument());
    expect(screen.queryByText(/does not include the reliability\.read capability/i)).not.toBeInTheDocument();
  });
});
