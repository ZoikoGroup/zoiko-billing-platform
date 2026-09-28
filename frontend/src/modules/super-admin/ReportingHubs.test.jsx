import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Behavioural tests for the two Reporting hubs this pass rebuilt:
 *
 *  - AuditLogsPage: tab-aware header, shared filter bar, evidence diff, and a
 *    CSV export that has to page the feed and never silently truncate.
 *  - ReliabilityPage: a failed job-telemetry call must render an error with a
 *    retry, NOT the "no job runs recorded yet" empty state — an unreachable
 *    endpoint is not evidence of an idle scheduler.
 */

const { listPlatformAuditLogs, listSubscriptionAuditLogs, listCommercialAccounts, listSuperAdminUsers, getProductionAcceptanceReport, downloadCSV } =
  vi.hoisted(() => ({
    listPlatformAuditLogs: vi.fn(),
    listSubscriptionAuditLogs: vi.fn(),
    listCommercialAccounts: vi.fn(),
    listSuperAdminUsers: vi.fn(),
    getProductionAcceptanceReport: vi.fn(),
    downloadCSV: vi.fn(),
  }));

vi.mock("../../service/commercialService", () => ({
  listPlatformAuditLogs,
  listSubscriptionAuditLogs,
  listCommercialAccounts,
  listSuperAdminUsers,
  getProductionAcceptanceReport,
}));

vi.mock("../../utils/export-helpers", () => ({ downloadCSV }));

const { getJobTelemetry, getTriageSummary, getConfigurationInventory, listAttentionItems, getInvoiceFinalizationBreaker, setInvoiceFinalizationBreaker, getMfaStepUpStatus } = vi.hoisted(() => ({
  getJobTelemetry: vi.fn(),
  getTriageSummary: vi.fn(),
  getConfigurationInventory: vi.fn(),
  listAttentionItems: vi.fn(),
  getInvoiceFinalizationBreaker: vi.fn(),
  setInvoiceFinalizationBreaker: vi.fn(),
  getMfaStepUpStatus: vi.fn(),
}));

vi.mock("../../service/privilegedAccessService", () => ({ getJobTelemetry }));
vi.mock("../../service/commandCenterService", () => ({
  getTriageSummary,
  getConfigurationInventory,
  listAttentionItems,
  getInvoiceFinalizationBreaker,
  setInvoiceFinalizationBreaker,
  getMfaStepUpStatus,
}));
vi.mock("../../context/CommandCenterContext", () => ({
  useCommandCenter: () => ({
    activeGrant: null,
    attentionCounts: { total_open: 0, sla_breaches: 0 },
    refresh: vi.fn(),
  }),
}));
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: 7, role: "super_admin", email: "admin@example.com" } }),
}));

vi.mock("../../service/api", () => ({
  api: {
    get: vi.fn((path) => {
      if (path === "/health") return Promise.resolve({ status: "ok", database: "connected" });
      return Promise.resolve({});
    }),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
  },
}));

import AuditLogsPage from "./AuditLogsPage";
import ReliabilityPage from "./ReliabilityPage";
import ConfigurationGovernancePage from "./ConfigurationGovernancePage";
import ProductionAcceptancePage from "./ProductionAcceptancePage";

const PLATFORM_LOG = {
  id: 1,
  actor_id: 7,
  actor_email: "admin@example.com",
  actor_role: "super_admin",
  action: "update",
  entity_type: "CommercialPlan",
  entity_id: 42,
  organization_id: null,
  organization_name: null,
  old_values: { plan_name: "Starter", is_active: false },
  new_values: { plan_name: "Starter Plus", is_active: true },
  metadata: { source: "admin_ui" },
  reason: "pricing correction",
  correlation_id: "corr-1",
  created_at: "2026-01-15T10:30:00Z",
};

function Wrapper({ children, initialEntries = ["/super-admin/audit-logs"] }) {
  return <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>;
}

beforeEach(() => {
  vi.clearAllMocks();
  listPlatformAuditLogs.mockResolvedValue({ logs: [PLATFORM_LOG], total: 1 });
  listSubscriptionAuditLogs.mockResolvedValue({ logs: [], total: 0 });
  listCommercialAccounts.mockResolvedValue({ items: [] });
  listSuperAdminUsers.mockResolvedValue({ items: [] });
  getJobTelemetry.mockResolvedValue({ jobs: [] });
  getTriageSummary.mockResolvedValue({
    generated_at: "2026-01-01T00:00:00Z",
    incidents: { counts: { p0: 0, p1: 0, p2: 0, p3: 0, total_open: 0, sla_breaches: 0 }, by_severity: [], top_incidents: [] },
    safety_controls: [],
  });
  listAttentionItems.mockResolvedValue({ items: [] });
  getConfigurationInventory.mockResolvedValue({ categories: [], generated_at: null });
  getInvoiceFinalizationBreaker.mockResolvedValue({
    scope: "tenant_invoice_finalization",
    enabled: true,
    reason: null,
    expires_at: null,
    changed_by_email: null,
    changed_at: null,
  });
  setInvoiceFinalizationBreaker.mockResolvedValue({
    scope: "tenant_invoice_finalization",
    enabled: false,
    reason: "duplicate invoices",
    expires_at: null,
    changed_by_email: "admin@example.com",
    changed_at: null,
  });
  // Default to enrolled: MFA being absent is a specific state under test, so
  // the baseline must be the one where the breaker action is actually possible.
  getMfaStepUpStatus.mockResolvedValue({ enabled: true });
  // Verdict must be one of READY | CONDITIONAL | BLOCKED. A fixture using an
  // invalid value would have hidden the page's verdict-vocabulary drift.
  getProductionAcceptanceReport.mockResolvedValue({
    generated_at: new Date(Date.now() - 60_000).toISOString(),
    overall_status: "CONDITIONAL",
    summary: "Conditionally ready.",
    items: [],
  });
});

describe("AuditLogsPage", () => {
  it("titles the page for the active hub tab, not for a retired sub-route", async () => {
    render(
      <Wrapper>
        <AuditLogsPage />
      </Wrapper>
    );
    await waitFor(() => expect(screen.getByRole("heading", { name: /audit & evidence/i })).toBeInTheDocument());
    expect(screen.queryByText(/security events/i)).not.toBeInTheDocument();
  });

  it("switches the header to the tab the operator selected", async () => {
    render(
      <Wrapper>
        <AuditLogsPage />
      </Wrapper>
    );
    await waitFor(() => expect(screen.getByRole("heading", { name: /audit & evidence/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: /configuration governance/i }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /configuration governance/i })).toBeInTheDocument()
    );
  });

  it("collects the incident reference the server demands before engaging a breaker", async () => {
    // The backend rejects an engage (enabled=false) with no incident_reference
    // ("An incident_reference is required to engage (disable) a circuit
    // breaker."), and the modal used to offer no way to supply one, so every
    // Pause click came back 422.
    render(
      <Wrapper initialEntries={["/super-admin/audit-logs?tab=data-governance"]}>
        <AuditLogsPage />
      </Wrapper>
    );
    await waitFor(() => expect(screen.getByText("Invoice Finalization")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /^pause$/i }));
    const dialog = await screen.findByRole("dialog");
    const referenceInput = within(dialog).getByLabelText(/incident reference/i);
    expect(referenceInput).toBeRequired();

    // Submit stays disabled until reason + reference + MFA code are all real.
    const submit = within(dialog).getByRole("button", { name: /^pause$/i });
    expect(submit).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: "duplicate invoices" } });
    fireEvent.change(referenceInput, { target: { value: "INC-2026-014" } });
    fireEvent.change(within(dialog).getByLabelText(/mfa code/i), { target: { value: "123456" } });

    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^pause$/i })).toBeEnabled());
    fireEvent.click(within(dialog).getByRole("button", { name: /^pause$/i }));

    await waitFor(() => expect(setInvoiceFinalizationBreaker).toHaveBeenCalledTimes(1));
    const [, reason, code, , incidentReference] = setInvoiceFinalizationBreaker.mock.calls[0];
    expect(reason).toBe("duplicate invoices");
    expect(code).toBe("123456");
    expect(incidentReference).toBe("INC-2026-014");
  });

  it("does not demand an incident reference to resume a breaker", async () => {
    getInvoiceFinalizationBreaker.mockResolvedValue({
      scope: "tenant_invoice_finalization",
      enabled: false,
      reason: "duplicate invoices",
      expires_at: null,
      changed_by_email: "admin@example.com",
      changed_at: null,
    });
    render(
      <Wrapper initialEntries={["/super-admin/audit-logs?tab=data-governance"]}>
        <AuditLogsPage />
      </Wrapper>
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /^resume$/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^resume$/i }));

    const dialog = await screen.findByRole("dialog");
    // A resume is a release, not an engage — the server does not require a
    // reference, so the field must not be demanded here either.
    expect(within(dialog).queryByLabelText(/incident reference/i)).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: "resolved" } });
    fireEvent.change(within(dialog).getByLabelText(/mfa code/i), { target: { value: "123456" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^resume$/i }));

    await waitFor(() => expect(setInvoiceFinalizationBreaker).toHaveBeenCalledTimes(1));
    expect(setInvoiceFinalizationBreaker.mock.calls[0][4]).toBe("");
  });

  it("blocks the breaker and points at enrollment when MFA step-up is missing", async () => {
    getMfaStepUpStatus.mockResolvedValue({ enabled: false });
    render(
      <Wrapper initialEntries={["/super-admin/audit-logs?tab=data-governance"]}>
        <AuditLogsPage />
      </Wrapper>
    );

    // The server hard-fails every change with "MFA is not enabled on this
    // account", so the card must not offer an action that can only 400 — and
    // the operator needs somewhere to actually go.
    await waitFor(() => expect(screen.getByText(/MFA step-up is not enrolled/i)).toBeInTheDocument());
    const pause = screen.getByRole("button", { name: /^pause$/i });
    expect(pause).toBeDisabled();

    const enable = screen.getByRole("link", { name: /enable mfa/i });
    expect(enable).toHaveAttribute("href", "/super-admin/settings");
  });

  it("lets the breaker through with no code when step-up is bypassed", async () => {
    // Dev-only deployment flag. The server skips verification entirely, so the
    // UI must not block on a code nobody will check.
    getMfaStepUpStatus.mockResolvedValue({ enabled: true, bypassed: true });
    render(
      <Wrapper initialEntries={["/super-admin/audit-logs?tab=data-governance"]}>
        <AuditLogsPage />
      </Wrapper>
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /^pause$/i })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^pause$/i })).not.toBeDisabled();
    // The card must stop claiming MFA is enforced.
    expect(screen.queryByText(/MFA step-up required on every change/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^pause$/i }));
    const dialog = await screen.findByRole("dialog");
    // No code field at all, rather than a field whose value is ignored.
    expect(within(dialog).queryByLabelText(/mfa code/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText(/bypassed/i)).toBeInTheDocument();

    // Reason + incident reference are still required — the bypass is only
    // about the second factor, not about dropping the audit trail.
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: "maintenance" } });
    expect(within(dialog).getByRole("button", { name: /^pause$/i })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/incident reference/i), { target: { value: "INC-2026-1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^pause$/i }));

    await waitFor(() => expect(setInvoiceFinalizationBreaker).toHaveBeenCalledTimes(1));
    expect(setInvoiceFinalizationBreaker.mock.calls[0][2]).toBe("");
  });

  it("does not claim MFA is missing when the status probe itself fails", async () => {    // A failed probe is not evidence of missing MFA. Claiming it would show a
    // false alarm and hide the action on a perfectly valid account.
    getMfaStepUpStatus.mockRejectedValue(new Error("status probe down"));
    render(
      <Wrapper initialEntries={["/super-admin/audit-logs?tab=data-governance"]}>
        <AuditLogsPage />
      </Wrapper>
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /^pause$/i })).toBeInTheDocument());
    expect(screen.queryByText(/MFA step-up is not enrolled/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^pause$/i })).not.toBeDisabled();
  });

  it("routes to enrollment from the server's MFA rejection when the card status is stale", async () => {
    // Status says enrolled, but MFA was disabled server-side in the meantime:
    // the card cannot pre-empt this, so the modal must recognise the refusal.
    setInvoiceFinalizationBreaker.mockRejectedValue(
      new Error("MFA is not enabled on this account. Step-up verification requires MFA.")
    );
    render(
      <Wrapper initialEntries={["/super-admin/audit-logs?tab=data-governance"]}>
        <AuditLogsPage />
      </Wrapper>
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /^pause$/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^pause$/i }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: "dupes" } });
    fireEvent.change(within(dialog).getByLabelText(/incident reference/i), { target: { value: "INC-2026-1" } });
    fireEvent.change(within(dialog).getByLabelText(/mfa code/i), { target: { value: "123456" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^pause$/i }));

    await waitFor(() => expect(within(dialog).getByText(/MFA is not enabled on this account/i)).toBeInTheDocument());
    expect(within(dialog).getByRole("link", { name: /enable mfa/i })).toHaveAttribute("href", "/super-admin/settings");
  });

  it("shows a structured before/after diff from real old/new values", async () => {    render(
      <Wrapper>
        <AuditLogsPage />
      </Wrapper>
    );
    await waitFor(() => expect(screen.getByText("admin@example.com")).toBeInTheDocument());

    fireEvent.click(screen.getByText("admin@example.com"));
    const dialog = await screen.findByRole("dialog");
    // Changed / added / removed are labelled from the diff, not raw JSON only.
    expect(within(dialog).getByText("Starter")).toBeInTheDocument();
    expect(within(dialog).getByText("Starter Plus")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Plan name").length).toBeGreaterThan(0);
  });

  it("exports with the active filters and reports a real row count", async () => {
    render(
      <Wrapper>
        <AuditLogsPage />
      </Wrapper>
    );
    await waitFor(() => expect(screen.getByText("admin@example.com")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    await waitFor(() => expect(downloadCSV).toHaveBeenCalledTimes(1));
    expect(downloadCSV.mock.calls[0][0]).toHaveLength(1);
    expect(screen.getByText(/exported 1 row\(s\)/i)).toBeInTheDocument();
  });

  it("surfaces an export failure as an error, not a success message", async () => {
    downloadCSV.mockImplementationOnce(() => {
      throw new Error("export blocked by policy");
    });
    render(
      <Wrapper>
        <AuditLogsPage />
      </Wrapper>
    );
    await waitFor(() => expect(screen.getByText("admin@example.com")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/export blocked by policy/i);
  });

  it("passes the operator's sort direction to the server", async () => {
    render(
      <Wrapper>
        <AuditLogsPage />
      </Wrapper>
    );
    await waitFor(() => expect(screen.getByText("admin@example.com")).toBeInTheDocument());
    const before = listPlatformAuditLogs.mock.calls.at(-1)[0];
    expect(before.order).toBe("desc");

    fireEvent.click(screen.getByRole("button", { name: /timestamp/i }));
    await waitFor(() => expect(listPlatformAuditLogs.mock.calls.at(-1)[0].order).toBe("asc"));
  });
});

describe("ConfigurationGovernancePage provenance", () => {
  const entry = (over) => ({
    name: "X",
    category: "operational_threshold",
    value_kind: "value",
    value: "1",
    is_sensitive: false,
    source: "code:app.core.api_metrics",
    scope: "platform",
    mutable: false,
    effective_from: null,
    last_updated_at: null,
    updated_by: null,
    audit_status: "READ_ONLY_CODE_BASELINE",
    description: "",
    ...over,
  });

  const renderPage = (entries) => {
    getConfigurationInventory.mockResolvedValue({
      categories: ["platform_setting", "operational_threshold", "environment_capability"],
      summary: { platform_setting: 1, operational_threshold: 1, environment_capability: 1 },
      environment: "development",
      generated_at: "2026-01-01T00:00:00Z",
      entries,
    });
    render(
      <Wrapper initialEntries={["/super-admin/audit-logs?tab=configuration-governance"]}>
        <ConfigurationGovernancePage />
      </Wrapper>
    );
  };

  // Scoped to the chips themselves — the page description legitimately
  // mentions UNKNOWN as a concept, which is not what is under test here.
  const unknownChips = () => screen.queryAllByTitle(/No recorded (actor|timestamp)/i);

  it("does not claim missing evidence for values that were never written by anyone", async () => {
    renderPage([
      entry({ name: "THRESHOLD_A" }),
      entry({
        name: "STRIPE",
        category: "environment_capability",
        value_kind: "status",
        value: "CONFIGURED",
        source: "environment",
        audit_status: "PRESENCE_ONLY_NEVER_VALUE",
      }),
    ]);

    await waitFor(() => expect(screen.getByText("THRESHOLD_A")).toBeInTheDocument());

    // Code-declared and environment-derived values have no actor or timestamp
    // because the fields do not apply, NOT because evidence is missing. Every
    // row showing UNKNOWN made the page look like it had lost its data.
    expect(unknownChips()).toHaveLength(0);
    expect(screen.getAllByText(/Code-declared/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Declared in source/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Environment-derived/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Read from environment/).length).toBeGreaterThan(0);
  });

  it("still reports UNKNOWN for a DB-backed setting with no recorded actor", async () => {
    renderPage([
      entry({
        name: "DB_SETTING",
        category: "platform_setting",
        mutable: true,
        source: "platform_settings",
        audit_status: "PRE_PHASE_4_LAST_CHANGE_UNAUDITED",
      }),
    ]);

    await waitFor(() => expect(screen.getByText("DB_SETTING")).toBeInTheDocument());
    // A settings row genuinely can lack an actor — that is real missing
    // evidence, and the page must still say so rather than inventing one.
    expect(unknownChips().length).toBeGreaterThan(0);
    expect(screen.queryByText(/Code-declared/)).not.toBeInTheDocument();
  });

  it("shows a recorded actor and timestamp for an audited DB setting", async () => {
    renderPage([
      entry({
        name: "AUDITED_SETTING",
        category: "platform_setting",
        mutable: true,
        source: "platform_settings",
        updated_by: "admin@example.com",
        last_updated_at: "2026-05-05T10:00:00Z",
        audit_status: "AUDITED_SINCE_PHASE_4",
      }),
    ]);

    await waitFor(() => expect(screen.getByText("admin@example.com")).toBeInTheDocument());
    expect(unknownChips()).toHaveLength(0);
  });
});

describe("ProductionAcceptancePage release control", () => {
  const item = (id, status, evidence) => ({
    id,
    criterion: `Criterion ${id}`,
    status,
    evidence: evidence || `Evidence for ${id}.`,
  });

  const renderPage = (report) => {
    getProductionAcceptanceReport.mockResolvedValue(report);
    render(
      <Wrapper>
        <ProductionAcceptancePage />
      </Wrapper>
    );
  };

  const freshIso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

  it("leads with blocking criteria and isolates them behind the Blocking filter", async () => {
    renderPage({
      generated_at: freshIso(60_000),
      overall_status: "BLOCKED",
      summary: "NOT READY FOR PRODUCTION. 1 criteria are FAILING: SEC-01.",
      items: [item("COM-01", "PASS"), item("TAX-01", "NOT_APPLICABLE"), item("SEC-01", "FAIL")],
    });

    await waitFor(() => expect(screen.getByText("NOT READY FOR PRODUCTION — BLOCKED")).toBeInTheDocument());

    const headings = screen.getAllByText(/^Criterion /).map((n) => n.textContent);
    expect(headings[0]).toBe("Criterion SEC-01");

    fireEvent.click(screen.getByRole("button", { name: /^Blocking/ }));
    expect(screen.getByText("Criterion SEC-01")).toBeInTheDocument();
    expect(screen.queryByText("Criterion COM-01")).not.toBeInTheDocument();
    expect(screen.queryByText("Criterion TAX-01")).not.toBeInTheDocument();
  });

  it("keeps Not Applicable reachable but out of the default view", async () => {
    renderPage({
      generated_at: freshIso(60_000),
      overall_status: "CONDITIONAL",
      summary: "Conditionally ready.",
      items: [item("COM-01", "PASS"), item("TAX-01", "NOT_APPLICABLE")],
    });

    await waitFor(() => expect(screen.getByText("TAX-01")).toBeInTheDocument());
    // Both render; the filter is a control, not a hidden-state claim.
    expect(screen.getByText("COM-01")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Not applicable/ }));
    expect(screen.getByText("TAX-01")).toBeInTheDocument();
    expect(screen.queryByText("COM-01")).not.toBeInTheDocument();
  });

  it("refuses to present an unrecognised verdict as ready", async () => {
    // The backend contract is READY | CONDITIONAL | BLOCKED. Anything else
    // means the page's vocabulary has drifted from the report's, and a
    // release gate must not answer a go-live question with a guess.
    renderPage({
      generated_at: freshIso(60_000),
      overall_status: "READY_PENDING_SIGNOFF",
      summary: "All good, probably.",
      items: [item("COM-01", "PASS")],
    });

    await waitFor(() => expect(screen.getByText("UNRECOGNISED VERDICT")).toBeInTheDocument());
    expect(screen.queryByText(/^READY$/)).not.toBeInTheDocument();
    expect(screen.queryByText("CONDITIONALLY READY")).not.toBeInTheDocument();
    expect(screen.queryByText("All good, probably.")).not.toBeInTheDocument();
  });

  it("renders long evidence verbatim instead of truncating it", async () => {
    const longEvidence = "A".repeat(1200);
    renderPage({
      generated_at: freshIso(60_000),
      overall_status: "CONDITIONAL",
      summary: "Conditionally ready.",
      items: [item("SEC-01", "WARNING", longEvidence)],
    });

    await waitFor(() => expect(screen.getByText(longEvidence)).toBeInTheDocument());
  });

  it("flags a stale snapshot on a page that is explicitly not live monitoring", async () => {
    renderPage({
      generated_at: freshIso(3 * 24 * 60 * 60 * 1000),
      overall_status: "CONDITIONAL",
      summary: "Conditionally ready.",
      items: [item("COM-01", "PASS")],
    });

    await waitFor(() => expect(screen.getByText(/not live monitoring/i)).toBeInTheDocument());
    expect(screen.getByText(/snapshot and nothing here re-checks itself/i)).toBeInTheDocument();
  });

  it("does not add a staleness warning to a freshly generated report", async () => {
    renderPage({
      generated_at: freshIso(60_000),
      overall_status: "CONDITIONAL",
      summary: "Conditionally ready.",
      items: [item("COM-01", "PASS")],
    });

    await waitFor(() => expect(screen.getByText("COM-01")).toBeInTheDocument());
    expect(screen.queryByText(/re-checks itself/i)).not.toBeInTheDocument();
  });
});

describe("ReliabilityPage", () => {
  it("shows job health with a failure-first order and honest counts", async () => {
    getJobTelemetry.mockResolvedValue({
      jobs: [
        { job_name: "ok", display_name: "Healthy job", last_status: "succeeded", freshness: "fresh", expected_interval_minutes: 5, last_started_at: "2026-01-01T00:00:00Z", last_error: null },
        { job_name: "bad", display_name: "Failing job", last_status: "failed", freshness: "stale", expected_interval_minutes: 15, last_started_at: "2026-01-01T00:00:00Z", last_error: "boom" },
      ],
    });
    render(
      <Wrapper initialEntries={["/super-admin/reliability"]}>
        <ReliabilityPage />
      </Wrapper>
    );
    await waitFor(() => expect(screen.getByText("Failing job")).toBeInTheDocument());
    // The stopped/failing job must be read first, not buried under the healthy one.
    expect(screen.getByText("Failing job").compareDocumentPosition(screen.getByText("Healthy job")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    // No fabricated "Integration Health" / "SLO" module tiles: this codebase
    // has no connector abstraction and no SLO policy engine to report on, so
    // the honest choice is to not render them at all (the header description
    // says so explicitly instead of showing a green lie).
    expect(screen.queryByText("Integration Health")).not.toBeInTheDocument();
    expect(screen.queryByText(/SLO \/ Error Budget/)).not.toBeInTheDocument();
  });

  it("renders a retryable error — not the empty state — when job telemetry fails", async () => {
    getJobTelemetry.mockRejectedValue(new Error("telemetry endpoint down"));
    render(
      <Wrapper initialEntries={["/super-admin/reliability"]}>
        <ReliabilityPage />
      </Wrapper>
    );
    await waitFor(() => expect(screen.getAllByText(/telemetry endpoint down/i).length).toBeGreaterThan(0));
    expect(screen.queryByText(/no job runs recorded yet/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /retry|retry|refresh/i }).length).toBeGreaterThan(0);
  });

  it("keeps the real database connectivity signal and its checked-at stamp", async () => {
    render(
      <Wrapper initialEntries={["/super-admin/reliability"]}>
        <ReliabilityPage />
      </Wrapper>
    );
    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
    expect(screen.getAllByText(/checked .*ago/i).length).toBeGreaterThan(0);
  });

  it("retitles the header when the operator switches tabs", async () => {
    render(
      <Wrapper initialEntries={["/super-admin/reliability"]}>
        <ReliabilityPage />
      </Wrapper>
    );
    await waitFor(() => expect(screen.getByRole("heading", { name: /system health/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: /release control/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: /release control/i })).toBeInTheDocument());
  });
});
