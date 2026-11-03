import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * Regression tests for the Audit & Evidence / System Health / Email Delivery
 * fixes: each one pins a bug that previously shipped.
 */

const {
  getJobTelemetry,
  retryJob,
  getTriageSummary,
  listAttentionItems,
  getInvoiceFinalizationBreaker,
  getEmailDeliveryOverview,
  listEmailDeliveryFailures,
  resendEmailDeliveryFailure,
  getProductionAcceptanceReport,
} = vi.hoisted(() => ({
  getJobTelemetry: vi.fn(),
  retryJob: vi.fn(),
  getTriageSummary: vi.fn(),
  listAttentionItems: vi.fn(),
  getInvoiceFinalizationBreaker: vi.fn(),
  getEmailDeliveryOverview: vi.fn(),
  listEmailDeliveryFailures: vi.fn(),
  resendEmailDeliveryFailure: vi.fn(),
  getProductionAcceptanceReport: vi.fn(),
}));

vi.mock("../../service/privilegedAccessService", () => ({ getJobTelemetry, retryJob }));
vi.mock("../../service/commandCenterService", () => ({
  getTriageSummary,
  listAttentionItems,
  getInvoiceFinalizationBreaker,
  setInvoiceFinalizationBreaker: vi.fn(),
  acknowledgeAttentionItem: vi.fn(),
  assignAttentionItem: vi.fn(),
  transitionAttentionItem: vi.fn(),
  suppressAttentionItem: vi.fn(),
  getEmailDeliveryOverview,
  listEmailDeliveryFailures,
  resendEmailDeliveryFailure,
  sendSmtpTestEmail: vi.fn(),
}));
vi.mock("../../service/commercialService", () => ({ getProductionAcceptanceReport }));
vi.mock("../../context/CommandCenterContext", () => ({
  useCommandCenter: () => ({ activeGrant: null, attentionCounts: { total_open: 1, sla_breaches: 0 }, refresh: vi.fn() }),
}));
vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ user: { id: 7, role: "super_admin", email: "admin@example.com" } }),
}));

import TriagePage from "./TriagePage";
import GovernancePage from "./GovernancePage";
import EmailDeliveryPage from "./EmailDeliveryPage";
import ProductionAcceptancePage from "./ProductionAcceptancePage";

const EMPTY_TRIAGE = {
  generated_at: "2026-01-01T00:00:00Z",
  incidents: { counts: { p0: 0, p1: 0, p2: 0, p3: 0, total_open: 0, sla_breaches: 0 }, top_items: [] },
  pipeline_stages: [],
  scheduler_enabled: true,
  safety_controls: [],
  critical_events: [],
};

function attentionItem(overrides) {
  return {
    id: 1,
    source: "jobs",
    source_key: "job:recurring_billing_job",
    title: "Recurring billing failed",
    description: null,
    severity: "p1",
    status: "open",
    owner_user_id: null,
    occurrence_count: 1,
    correlation_id: null,
    opened_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getTriageSummary.mockResolvedValue(EMPTY_TRIAGE);
  getJobTelemetry.mockResolvedValue({ jobs: [] });
  listAttentionItems.mockResolvedValue({ items: [] });
  getInvoiceFinalizationBreaker.mockResolvedValue({ enabled: true, reason: null });
  getEmailDeliveryOverview.mockResolvedValue({
    generated_at: "2026-01-01T00:00:00Z",
    smtp_health: "healthy",
    last_24h: { total_attempts: 2, sent: 1, failed: 1, suppressed: 0, duplicate: 0, superseded: 0, queued: 0, failure_rate_pct: 50 },
    last_7d: { total_attempts: 2, sent: 1, failed: 1, suppressed: 0, duplicate: 0, superseded: 0, queued: 0, failure_rate_pct: 50 },
  });
  listEmailDeliveryFailures.mockResolvedValue({
    total: 1,
    items: [{
      id: 11, recipient: "bill@acme.test", organization_id: 3, organization_name: "Acme", template_id: "invoice_issued",
      event_name: "invoice.issued", status: "FAILED", error_message: "SMTP 550", suppression_reason: null,
      sent_at: "2026-01-01T00:00:00Z", resendable: true,
    }],
  });
});

describe("TriagePage reprocessing", () => {
  it("lists jobs whose last_status is the lowercase 'failed' the API actually returns", async () => {
    getJobTelemetry.mockResolvedValue({
      jobs: [
        { job_name: "bad", display_name: "Broken job", last_status: "failed", last_error: "boom", freshness: "fresh", run_count_24h: 1, failure_count_24h: 1 },
        { job_name: "ok", display_name: "Fine job", last_status: "succeeded", freshness: "fresh", run_count_24h: 1, failure_count_24h: 0 },
      ],
    });
    render(<MemoryRouter><TriagePage showReprocessing embedded /></MemoryRouter>);
    expect(await screen.findByText("Broken job")).toBeInTheDocument();
    expect(screen.queryByText("Fine job")).not.toBeInTheDocument();
  });

  it("does not crash on an incident without a correlation id", async () => {
    getTriageSummary.mockResolvedValue({
      ...EMPTY_TRIAGE,
      incidents: { counts: { ...EMPTY_TRIAGE.incidents.counts, total_open: 1, p1: 1 }, top_items: [attentionItem()] },
    });
    render(<MemoryRouter><TriagePage embedded /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /recurring billing failed/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /acknowledge/i })).toBeInTheDocument();
    // Resolve is not a legal transition from "open" on the server.
    expect(within(dialog).queryByRole("button", { name: /^resolve$/i })).not.toBeInTheDocument();
  });
});

describe("GovernancePage attention queue", () => {
  it("only offers Resolve where the server allows it", async () => {
    listAttentionItems.mockResolvedValue({
      items: [
        attentionItem({ id: 1, title: "Open item", status: "open" }),
        attentionItem({ id: 2, title: "Mitigating item", status: "mitigating" }),
      ],
    });
    render(<MemoryRouter><GovernancePage embedded /></MemoryRouter>);
    await screen.findByText("Open item");
    const resolveButtons = screen.getAllByRole("button", { name: /^resolve$/i });
    expect(resolveButtons).toHaveLength(1);
    expect(resolveButtons[0].closest("li")).toHaveTextContent("Mitigating item");
  });
});

describe("EmailDeliveryPage resend", () => {
  it("reports a success:false resend as an error, not a green notice", async () => {
    resendEmailDeliveryFailure.mockResolvedValue({ success: false, message: "Invoice no longer exists" });
    render(<MemoryRouter><EmailDeliveryPage /></MemoryRouter>);
    await screen.findAllByText("bill@acme.test");
    fireEvent.click(screen.getAllByRole("button", { name: /^resend$/i })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Invoice no longer exists");
    expect(screen.queryByRole("status", { name: /invoice no longer exists/i })).not.toBeInTheDocument();
  });
});

describe("ProductionAcceptancePage retry", () => {
  it("clears the error once a retry after a failed first load succeeds", async () => {
    getProductionAcceptanceReport
      .mockRejectedValueOnce(new Error("report down"))
      .mockResolvedValue({ generated_at: new Date().toISOString(), items: [{ id: "COM-01", criterion: "c", status: "PASS", evidence: "e" }] });
    render(<MemoryRouter><ProductionAcceptancePage embedded /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));
    await waitFor(() => expect(screen.getByText("COM-01")).toBeInTheDocument());
    expect(screen.queryByText("report down")).not.toBeInTheDocument();
  });
});
