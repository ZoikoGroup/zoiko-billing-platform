import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

if (typeof global.ResizeObserver === "undefined") {
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

const svc = vi.hoisted(() => ({
  listOrganizations: vi.fn(),
  getSaasCommercialReporting: vi.fn(),
  listPlatformAuditLogs: vi.fn(),
  getTriageSummary: vi.fn(),
  getFinancialOperationsSummary: vi.fn(),
}));
vi.mock("../../service/commercialService", () => ({
  listOrganizations: svc.listOrganizations,
  getSaasCommercialReporting: svc.getSaasCommercialReporting,
  listPlatformAuditLogs: svc.listPlatformAuditLogs,
}));
vi.mock("../../service/commandCenterService", () => ({
  getTriageSummary: svc.getTriageSummary,
  getFinancialOperationsSummary: svc.getFinancialOperationsSummary,
}));
vi.mock("../../context/CommandCenterContext", () => ({
  useCommandCenter: () => ({
    requestRefresh: vi.fn(),
    refreshTick: 0,
    periodDateFrom: "2026-01-01",
    attentionCounts: { p0: 0, p1: 0 },
    worstFreshness: "fresh",
  }),
}));
vi.mock("../../hooks/usePolling", () => ({ default: () => {} }));

import PlatformDashboardPage from "./PlatformDashboardPage";

const DAY = 86400000;
const ORGS = [
  { id: 1, organization_name: "Quiet Co", organization_code: "QUIET", account_status: "active", subscription_plan_name: "Business", created_at: "2026-01-01T00:00:00Z", open_incident_count: 0 },
  { id: 2, organization_name: "Fire Drill Ltd", organization_code: "FIRE", account_status: "active", subscription_plan_name: "Business", created_at: "2026-02-01T00:00:00Z", open_incident_count: 2 },
  { id: 3, organization_name: "Trial Soon", organization_code: "TSOON", account_status: "trial", subscription_status: "trialing", subscription_plan_name: "Essentials", trial_ends_at: new Date(Date.now() + 2 * DAY).toISOString(), created_at: "2026-03-01T00:00:00Z" },
];

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="loc">{l.pathname}{l.search}</div>;
}

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/super-admin/dashboard"]}>
      <Routes>
        <Route path="/super-admin/dashboard" element={<PlatformDashboardPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  vi.clearAllMocks();
  svc.listOrganizations.mockResolvedValue({
    organizations: ORGS,
    total: 3,
    status_counts: { trial: 1, active: 2, past_due: 0, suspended: 0, deactivated: 0, no_plan: 0 },
  });
  svc.getSaasCommercialReporting.mockResolvedValue({ mrr: { state: "computed", amount: 1492, currencies: [{ currency: "USD" }] } });
  svc.listPlatformAuditLogs.mockResolvedValue({ logs: [] });
  svc.getTriageSummary.mockResolvedValue({ incidents: { counts: { p0: 0, p1: 0 }, top_items: [] }, pipeline_stages: [], safety_controls: [], scheduler_enabled: true });
  svc.getFinancialOperationsSummary.mockResolvedValue({
    billings: { total_invoices: 44, overdue_count: 7 },
    recovery: { failed_payments_count: 0, dunning_cycle_status: "ACTIVE" },
    consistency: { state: "VERIFIED", total_invoices_checked: 44 },
  });
});

describe("PlatformDashboardPage (redesign)", () => {
  it("leads with an organization overview built from real counts", async () => {
    renderPage();
    const orgsSection = await screen.findByRole("region", { name: "Organizations" });
    // Donut legend: one row per account status, with counts.
    await waitFor(() => expect(within(orgsSection).getByRole("button", { name: /trial\s*1\s*33%/i })).toBeInTheDocument());
    expect(within(orgsSection).getByRole("button", { name: /active\s*2\s*67%/i })).toBeInTheDocument();
    // Hero headline figures.
    expect(screen.getByText("Run rate")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("$1,492")).toBeInTheDocument());
  });

  it("opens the Organizations list filtered by the clicked status", async () => {
    renderPage();
    const orgsSection = await screen.findByRole("region", { name: "Organizations" });
    fireEvent.click(await within(orgsSection).findByRole("button", { name: /trial\s*1/i }));
    expect(await screen.findByTestId("loc")).toHaveTextContent("/super-admin/organizations?status=trial");
  });

  it("shows organizations needing attention first, each opening its detail page", async () => {
    renderPage();
    const orgsSection = await screen.findByRole("region", { name: "Organizations" });
    const cards = (await within(orgsSection).findAllByRole("button", { name: /^Open / })).filter((b) => b.hasAttribute("aria-label"));
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Open Fire Drill Ltd", // open incidents
      "Open Trial Soon", // trial ending within a week
      "Open Quiet Co",
    ]);
    fireEvent.click(cards[0]);
    expect(await screen.findByTestId("loc")).toHaveTextContent("/super-admin/organizations/2");
  });

  it("summarises plan mix, trials ending and newest organizations", async () => {
    renderPage();
    await screen.findByRole("region", { name: "Organizations" });
    expect(await screen.findByText("Plan mix")).toBeInTheDocument();
    const trials = screen.getByText("Trials ending soon").closest("div");
    expect(within(trials).getByText("Trial Soon")).toBeInTheDocument();
    expect(screen.getByText("Newest organizations")).toBeInTheDocument();
  });

  it("shows billing health tiles and no production-gate verdict", async () => {
    renderPage();
    const billing = await screen.findByRole("region", { name: "Billing health" });
    await waitFor(() => expect(within(billing).getByText("Overdue invoices")).toBeInTheDocument());
    expect(within(billing).getByText("Verified")).toBeInTheDocument();
    expect(screen.queryByText(/production gate/i)).not.toBeInTheDocument();
  });

  it("flags unreachable data sources instead of silently showing zeros", async () => {
    svc.getFinancialOperationsSummary.mockRejectedValue(new Error("down"));
    renderPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(/1 data source couldn't be reached/i);
  });
});
