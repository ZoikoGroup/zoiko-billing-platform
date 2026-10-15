import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

/**
 * Financial Operations hub consolidation: 9 tabs → 7, Plane 1 (Domain A)
 * removed with legacy links redirected to Plane 1's own route, one merged
 * Overview carrying the only copy of the F1–F4 cards, and panel fetch
 * failures that read as failures rather than as "all clear" empty states.
 */

const svc = vi.hoisted(() => ({
  getFinancialOperationsSummary: vi.fn(),
  getBillingCommandOverview: vi.fn(),
  getBillingCommandTrend: vi.fn(),
  listBillingOverdueInvoices: vi.fn(),
  listBillingCollectionsRisk: vi.fn(),
  listBillingRecentActivity: vi.fn(),
  getInvoiceStatusDistribution: vi.fn(),
  getInvoiceDeliveryDiagnostics: vi.fn(),
  listFailedPayments: vi.fn(),
  listDunningCases: vi.fn(),
  listAllocationExceptions: vi.fn(),
  listCreditApplications: vi.fn(),
  listCreditNotesAdmin: vi.fn(),
  listRefundsAdmin: vi.fn(),
  listWriteOffsAdmin: vi.fn(),
  getTaxSummary: vi.fn(),
  listReconciliationRuns: vi.fn(),
  getReconciliationRun: vi.fn(),
  triggerReconciliationRun: vi.fn(),
  acknowledgeReconciliationException: vi.fn(),
  resolveReconciliationException: vi.fn(),
}));

vi.mock("../../service/commandCenterService", () => svc);
vi.mock("../../service/commercialService", () => ({
  listOrganizations: vi.fn(() => Promise.resolve({ organizations: [] })),
}));
vi.mock("../../context/CommandCenterContext", () => ({
  useCommandCenter: () => ({ requestRefresh: vi.fn(), refreshTick: 0 }),
}));
vi.mock("../../components/CommandCenterContextBar", () => ({ default: () => null }));

import FinancialOperationsPage from "./FinancialOperationsPage";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.search}</div>;
}

function renderHub(url = "/super-admin/financial-operations") {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/super-admin/financial-operations" element={<FinancialOperationsPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

const EXPECTED_TABS = [
  "Overview",
  "Invoice Engine",
  "Payments & Recovery",
  "Balances & Allocations",
  "Credits, Refunds & Write-offs",
  "Tax",
  "Tenant Ledger Reconciliation",
];

beforeEach(() => {
  vi.clearAllMocks();
  svc.getFinancialOperationsSummary.mockResolvedValue({});
  svc.getBillingCommandOverview.mockResolvedValue({ kpis: {}, sparklines: {}, action_center: {}, aging: [], next_seven_days: {} });
  svc.getBillingCommandTrend.mockResolvedValue({ points: [] });
  svc.listBillingOverdueInvoices.mockResolvedValue({ invoices: [] });
  svc.listBillingCollectionsRisk.mockResolvedValue({ rows: [] });
  svc.listBillingRecentActivity.mockResolvedValue({ items: [] });
  svc.getInvoiceStatusDistribution.mockResolvedValue({ total_invoices: 0, buckets: [] });
  svc.getInvoiceDeliveryDiagnostics.mockResolvedValue({ total: 0 });
  svc.listFailedPayments.mockResolvedValue({ items: [] });
  svc.listDunningCases.mockResolvedValue({ items: [] });
  svc.listAllocationExceptions.mockResolvedValue({ items: [] });
  svc.listCreditApplications.mockResolvedValue({ items: [] });
  svc.listCreditNotesAdmin.mockResolvedValue({ items: [] });
  svc.listRefundsAdmin.mockResolvedValue({ items: [] });
  svc.listWriteOffsAdmin.mockResolvedValue({ items: [] });
  svc.getTaxSummary.mockResolvedValue({ total_records: 0, buckets: [] });
  svc.listReconciliationRuns.mockResolvedValue({ items: [] });
});

describe("FinancialOperationsPage hub", () => {
  it("exposes exactly the seven consolidated tabs", async () => {
    renderHub();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(EXPECTED_TABS);
    expect(screen.queryByRole("tab", { name: /quotes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /command center/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /disputes/i })).not.toBeInTheDocument();
  });

  it.each(["quotes", "invoices", "payments", "reconciliation", "evaluation"])(
    "redirects legacy ?tab=%s to the Plane 1 route instead of dropping it on Overview",
    async (tab) => {
      renderHub(`/super-admin/financial-operations?tab=${tab}`);
      expect(await screen.findByTestId("location")).toHaveTextContent(
        `/super-admin/commercial/invoices?tab=${tab}`
      );
    }
  );

  it("redirects the removed quotes-invoices section to Plane 1", async () => {
    renderHub("/super-admin/financial-operations?section=quotes-invoices");
    expect(await screen.findByTestId("location")).toHaveTextContent(
      "/super-admin/commercial/invoices?tab=quotes"
    );
  });

  it("maps retired section keys onto their replacement tab", async () => {
    renderHub("/super-admin/financial-operations?section=reconciliation");
    const tab = await screen.findByRole("tab", { name: "Tenant Ledger Reconciliation" });
    expect(tab).toHaveAttribute("aria-selected", "true");
  });

  it("retitles the header per tab and shows no second, embedded page header", async () => {
    renderHub();
    fireEvent.click(await screen.findByRole("tab", { name: "Payments & Recovery" }));
    await waitFor(() => expect(svc.listFailedPayments).toHaveBeenCalled());
    const headings = await screen.findAllByRole("heading", { name: "Payments & Recovery" });
    expect(headings).toHaveLength(1);
  });

  it("Overview: shows exactly one 'Financial Operations Overview' heading, not an orphaned second header row", async () => {
    // BillingCommandCenterPage used to hand-roll its own header div that only
    // hid its own <h1> when embedded — since it is only ever mounted with
    // embedded=true (the hub's default Overview tab), the subtitle and
    // "Refreshed…" timestamp rendered as a second, title-less header row
    // floating below the hub's real header and tab row on every load.
    renderHub();
    await waitFor(() => expect(svc.getBillingCommandOverview).toHaveBeenCalled());
    const headings = await screen.findAllByRole("heading", { name: "Financial Operations Overview" });
    expect(headings).toHaveLength(1);
    expect(screen.getByText(/^Refreshed/)).toBeInTheDocument();
  });

  it("fetches the F1–F4 summary only on Overview", async () => {
    renderHub("/super-admin/financial-operations?section=payments-recovery");
    await waitFor(() => expect(svc.listDunningCases).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "Balances & Allocations" }));
    await waitFor(() => expect(svc.listAllocationExceptions).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("tab", { name: "Invoice Engine" }));
    await waitFor(() => expect(svc.getInvoiceStatusDistribution).toHaveBeenCalled());
    expect(svc.getFinancialOperationsSummary).not.toHaveBeenCalled();
  });

  it("re-fetches a tab when it is re-activated", async () => {
    renderHub("/super-admin/financial-operations?section=tax");
    await waitFor(() => expect(svc.getTaxSummary).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "Invoice Engine" }));
    fireEvent.click(screen.getByRole("tab", { name: "Tax" }));
    await waitFor(() => expect(svc.getTaxSummary).toHaveBeenCalledTimes(2));
  });

  it("shows a failed overdue fetch as an error, not as 'Nothing is overdue'", async () => {
    svc.listBillingOverdueInvoices.mockRejectedValue(new Error("Overdue service down"));
    renderHub();
    expect(await screen.findByText("Overdue service down")).toBeInTheDocument();
    expect(screen.queryByText(/nothing is overdue/i)).not.toBeInTheDocument();
  });

  it("describes Credits, Refunds & Write-offs as read-only oversight", async () => {
    renderHub("/super-admin/financial-operations?section=credits-refunds");
    await waitFor(() => expect(svc.listRefundsAdmin).toHaveBeenCalled());
    expect(screen.getByText(/read-only oversight/i)).toBeInTheDocument();
  });

  it("shows the no-invoices message when the platform has zero invoices", async () => {
    renderHub("/super-admin/financial-operations?section=invoice-engine");
    expect(await screen.findByText(/no invoices exist on the platform yet/i)).toBeInTheDocument();
  });
});

// ZB-SEC-PRIV-001 — platform views render one row per tenant: no customer or
// invoice identifiers, masked small cells, tenant links, support-access note.
describe("per-tenant privacy-preserving tables", () => {
  const MASKED = { count: null, count_label: "fewer than 5" };
  const MASKED_TOTAL = { count: null, count_label: "fewer than 5", amount: null };

  function expectPrivacyChrome(orgName, orgId) {
    expect(screen.getAllByRole("link", { name: orgName })[0]).toHaveAttribute("href", `/super-admin/organizations/${orgId}`);
    expect(screen.getAllByTestId("support-access-note")[0]).toHaveTextContent("Record-level detail requires approved support access");
    expect(screen.getAllByRole("link", { name: /approved support access/i })[0]).toHaveAttribute("href", "/super-admin/support-access");
    expect(screen.queryByRole("columnheader", { name: /^(customer|invoice|invoice #|credit note|refund|write-off)$/i })).not.toBeInTheDocument();
  }

  it("Overview overdue and collections-risk tables are per tenant with masked cells", async () => {
    svc.listBillingOverdueInvoices.mockResolvedValue({
      total: 14,
      invoices: [
        { organization_id: 7, organization_name: "Tiny Tenant", overdue_invoice_count: null, overdue_invoice_count_label: "fewer than 5", overdue_total_by_currency: { USD: MASKED_TOTAL }, oldest_days_overdue_bucket: "31-60" },
        { organization_id: 8, organization_name: "Big Tenant", overdue_invoice_count: 12, overdue_invoice_count_label: null, overdue_total_by_currency: { USD: { count: 8, count_label: null, amount: "1200.50" }, EUR: { count: 4, count_label: null, amount: "10.00" } }, oldest_days_overdue_bucket: "90+" },
      ],
    });
    svc.listBillingCollectionsRisk.mockResolvedValue({
      rows: [{ organization_id: 8, organization_name: "Big Tenant", accounts_at_risk_count: 9, risk_high_count: 5, risk_medium_count: null, risk_medium_count_label: "fewer than 5", total_overdue_by_currency: { USD: { count: 9, count_label: null, amount: "99.00" } } }],
    });
    svc.listBillingRecentActivity.mockResolvedValue({
      items: [{ organization_id: 8, organization_name: "Big Tenant", event_type: "payment_failed", event_count: 20, event_count_label: null, last_event_at: "2026-01-01T00:00:00Z" }],
    });
    renderHub();
    expect(await screen.findByRole("link", { name: "Tiny Tenant" })).toHaveAttribute("href", "/super-admin/organizations/7");
    expect(screen.getAllByTestId("masked-value").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByTestId("masked-value")[0]).toHaveAttribute("title", "Counts under 5 are hidden to protect individual customers' privacy");
    expect(screen.getByText("1,200.50")).toBeInTheDocument();
    expect(screen.getByText("EUR")).toBeInTheDocument(); // totals stay per currency
    expectPrivacyChrome("Big Tenant", 8);
  });

  it("Payments & Recovery renders failure-reason categories and stage counts per tenant", async () => {
    svc.listFailedPayments.mockResolvedValue({
      total: 30,
      items: [{ organization_id: 3, organization_name: "Acme", failed_count: 30, failed_count_label: null, failed_total_by_currency: { USD: { count: 30, count_label: null, amount: "500.00" } }, top_failure_reasons: [{ reason: "card_declined", count: 20, count_label: null }, { reason: "expired_card", count: null, count_label: "fewer than 5" }] }],
    });
    svc.listDunningCases.mockResolvedValue({
      total: 6,
      items: [{ organization_id: 3, organization_name: "Acme", case_count_by_stage: { stage_1: { count: 6, count_label: null }, stage_2: MASKED } }],
    });
    renderHub("/super-admin/financial-operations?section=payments-recovery");
    expect(await screen.findByText("card declined")).toBeInTheDocument();
    expect(screen.getByText("500.00")).toBeInTheDocument();
    expect(screen.getAllByTestId("masked-value").length).toBe(2);
    expectPrivacyChrome("Acme", 3);
  });

  it("Balances & Allocations and Credits tabs render per-tenant aggregates", async () => {
    svc.listAllocationExceptions.mockResolvedValue({ total: 7, items: [{ organization_id: 4, organization_name: "Alloc Co", exception_count_by_type: { over_allocated_invoice: { count: 7, count_label: null } } }] });
    svc.listCreditApplications.mockResolvedValue({ total: 0, items: [{ organization_id: 4, organization_name: "Alloc Co", count_by_status: { applied: MASKED }, total_by_currency: { GBP: MASKED_TOTAL } }] });
    renderHub("/super-admin/financial-operations?section=balances-allocations");
    expect(await screen.findByText("over allocated invoice")).toBeInTheDocument();
    expect(screen.getAllByTestId("masked-value").length).toBe(2);
    expectPrivacyChrome("Alloc Co", 4);
  });

  it("Credits, Refunds & Write-offs renders status counts and per-currency totals per tenant", async () => {
    const row = { organization_id: 5, organization_name: "Refund Co", count_by_status: { completed: { count: 9, count_label: null } }, total_by_currency: { USD: { count: 9, count_label: null, amount: "77.00" } } };
    svc.listCreditNotesAdmin.mockResolvedValue({ total: 9, items: [row], status_distribution: [{ status: "issued", count: 9 }] });
    svc.listRefundsAdmin.mockResolvedValue({ total: 9, items: [row], status_distribution: [] });
    svc.listWriteOffsAdmin.mockResolvedValue({ total: 0, items: [{ ...row, count_by_status: { approved: MASKED }, total_by_currency: { USD: MASKED_TOTAL } }], status_distribution: [] });
    renderHub("/super-admin/financial-operations?section=credits-refunds");
    expect((await screen.findAllByText("77.00")).length).toBe(2);
    expect(screen.getAllByTestId("masked-value").length).toBe(2);
    expectPrivacyChrome("Refund Co", 5);
    expect(screen.getAllByTestId("support-access-note")).toHaveLength(3);
  });
});
