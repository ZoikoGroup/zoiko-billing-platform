import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { axe } from "../../test/a11y";

// ZB-TAX-ARCH-001 Phase 5c PR 2: P9 provider operations and P10 findings
// (platform, aggregate only).

const { svc, current } = vi.hoisted(() => ({
  current: { user: null },
  svc: Object.fromEntries([
    "getProviderHealth", "providerHealthAction", "getPlatformOvercollection", "getPlatformDuplicates",
    "listTaxPeople", "listApprovalsInbox", "getReadiness", "listCoverage", "listTaxCodeSets", "lookupReferenceRates",
    "listJurisdictions", "getEvidenceBundle", "listShadowSelections", "chooseShadowSelection", "endShadowSelection",
    "getShadowAggregate", "listRulePacks", "listAnomalyRuns",
  ].map((k) => [k, vi.fn()])),
}));
vi.mock("../../api/client", async (importOriginal) => ({ ...(await importOriginal()), getStoredUser: () => current.user }));
vi.mock("./taxRegistryService", async (importOriginal) => ({
  fetchAllPages: (await importOriginal()).fetchAllPages,
  ...Object.fromEntries(Object.keys(svc).map((k) => [k, (...args) => svc[k](...args)])),
}));

import TaxControlCenterPage from "./TaxControlCenterPage";
import { resetPeopleCache } from "./shared";

const STEP_UP = Object.assign(new Error("MFA step-up is required"), { code: "TAX_REGISTRY_STEP_UP_REQUIRED" });
const PUBLISHER = { id: 7, role: "super_admin", platform_role: "tax_publisher" };
const REVIEWER = { id: 9, role: "super_admin", platform_role: "tax_reviewer" };
const health = (circuit = "CLOSED") => ({
  providers: [{ provider: "fake-provider", circuit, oldest_active_age_seconds: 3725,
                counts: { REVIEW_REQUIRED: 2, DONE: 40 } }],
  reconciliation: { last_finished_age_seconds: 120, last_ok: true },
});

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/super-admin/tax/:section" element={<TaxControlCenterPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  current.user = PUBLISHER;
  Object.values(svc).forEach((fn) => fn.mockReset());
  svc.listTaxPeople.mockResolvedValue({ items: [], next_cursor: null });
  svc.getProviderHealth.mockResolvedValue(health());
  svc.getPlatformOvercollection.mockResolvedValue({
    method: "Estimate = tax x discount share.", organizations_affected: 3, invoice_count: 12,
    totals_by_currency: [{ currency: "GBP", invoice_count: 12, tax_amount: "240.00", estimated_overcollected_tax: "24.00" }],
  });
  svc.listAnomalyRuns.mockResolvedValue({ items: [] });
  svc.getPlatformDuplicates.mockResolvedValue({ organizations_affected: 2, invoices_affected: 5, duplicate_rows: 7,
    note: "Aggregate only." });
  resetPeopleCache();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("P9 provider operations", () => {
  it("shows the aggregate health: circuit, counts, oldest age and the worker heartbeat", async () => {
    renderAt("/super-admin/tax/providers");
    expect(await screen.findByText("fake-provider")).toBeInTheDocument();
    expect(screen.getByText("Circuit closed (normal)")).toBeInTheDocument();          // icon + text
    expect(screen.getByText(/Oldest active item: 1 h 2 min · Review required: 2 · Done: 40/)).toBeInTheDocument();
    expect(screen.getByText(/last finished 2 min ago/)).toBeInTheDocument();
  });

  it("suspends with a reason, then MFA step-up and one retry", async () => {
    svc.providerHealthAction.mockRejectedValueOnce(STEP_UP).mockResolvedValueOnce(health("SUSPENDED"));
    renderAt("/super-admin/tax/providers");
    fireEvent.click(await screen.findByRole("button", { name: "Suspend provider" }));
    const reasonDialog = await screen.findByRole("dialog");
    fireEvent.change(within(reasonDialog).getByLabelText(/Reason/), { target: { value: "Contract ended" } });
    fireEvent.click(within(reasonDialog).getByRole("button", { name: "Suspend" }));
    const mfa = await screen.findByRole("dialog", { name: /Confirm with MFA/ }, { timeout: 5000 });
    fireEvent.change(within(mfa).getByLabelText(/Authenticator code/), { target: { value: "123456" } });
    fireEvent.click(within(mfa).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(svc.providerHealthAction).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(svc.providerHealthAction.mock.calls[0]).toEqual(["fake-provider", "suspend", { reason: "Contract ended" }]);
    expect(svc.providerHealthAction.mock.calls[1]).toEqual(["fake-provider", "suspend", { reason: "Contract ended", code: "123456" }]);
    expect(await screen.findByRole("button", { name: "Resume provider" })).toBeInTheDocument();
  });

  it("disables suspend for a tax reviewer, with the reason as text", async () => {
    current.user = REVIEWER;
    renderAt("/super-admin/tax/providers");
    const suspend = await screen.findByRole("button", { name: "Suspend provider" });
    expect(suspend).toBeDisabled();
    expect(screen.getByText(/TAX_PUBLISHER only/)).toBeInTheDocument();
  });

  it("is closed to non-tax platform roles (T13)", () => {
    current.user = { id: 1, role: "super_admin", platform_role: "platform_administrator" };
    renderAt("/super-admin/tax/providers");
    expect(screen.getByRole("alert")).toHaveTextContent("No access to the Tax Control Center");
    expect(svc.getProviderHealth).not.toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    const { container } = renderAt("/super-admin/tax/providers");
    await screen.findByText("fake-provider");
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("P10 findings", () => {
  it("shows counts and totals only, with no tenant identifiers", async () => {
    const { container } = renderAt("/super-admin/tax/findings");
    expect(await screen.findByText("3 organization(s) · 12 invoice(s)")).toBeInTheDocument();
    expect(screen.getByText(/GBP: 12 invoice\(s\), tax charged 240.00, estimated over-collected 24.00/)).toBeInTheDocument();
    expect(screen.getByText(/7 duplicate row\(s\) on 5 invoice\(s\) in 2 organization\(s\)/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/INV-|organization_id|Invoice #/);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ── Phase 5c PR 3: P1 overview, P4 explorer, P5 catalogue (read-only) ───

describe("P1 overview", () => {
  it("summarises readiness, the inbox, coverage and providers, read-only", async () => {
    svc.getReadiness.mockResolvedValue({ ready: false, step_up_required: true, active_reviewers: 1, active_publishers: 1,
      publishers_with_mfa: 0, reviewers_with_mfa: 1 });
    svc.listApprovalsInbox.mockResolvedValue({ items: [{ kind: "staged_rate", id: 1 }, { kind: "rule_pack", id: 2 }], next_cursor: null });
    svc.listCoverage.mockResolvedValue({ items: [{ state: "SUPPORTED" }, { state: "UNSUPPORTED" }, { state: "UNSUPPORTED" }], next_cursor: null });
    svc.getProviderHealth.mockResolvedValue(health("SUSPENDED"));
    const { container } = renderAt("/super-admin/tax/overview");
    expect(await screen.findByText(/1 reviewer\(s\), 1 publisher\(s\), 0 publisher\(s\) with MFA/)).toBeInTheDocument();
    expect(screen.getByText("Not ready")).toBeInTheDocument();
    expect(screen.getByText(/Staged rate: 1 · Rule pack: 1/)).toBeInTheDocument();
    expect(screen.getByText(/Supported: 1 · Limited: 0 · Unsupported: 2/)).toBeInTheDocument();
    expect(screen.getByText(/1 not normal: fake-provider \(Suspended\)/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve|publish/i })).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("P4 jurisdictions and rates", () => {
  it("lists jurisdictions and looks up published rates; no implied 0%", async () => {
    svc.listJurisdictions.mockImplementation(() => Promise.resolve({ items: [{ id: 1, code: "GB", name: "United Kingdom",
      level: "COUNTRY", reference_status: "REFERENCE_ONLY", published_rate_versions: 3, last_published_at: null }], next_cursor: null }));
    svc.lookupReferenceRates.mockResolvedValue({ jurisdiction: { id: 1, code: "GB", name: "United Kingdom" }, as_of: "2026-11-06",
      coverage: "NO_APPROVED_RATE", disclaimer: "Reference only.", items: [] });
    const { container } = renderAt("/super-admin/tax/explorer");
    expect(await screen.findByRole("cell", { name: "United Kingdom" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("option", { name: "GB — United Kingdom" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox", { name: /Jurisdiction/ }), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(/On date/), { target: { value: "2026-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    expect(await screen.findByText(/This is not 0%/)).toBeInTheDocument();
    expect(svc.lookupReferenceRates).toHaveBeenCalledWith({ jurisdiction_id: 1, as_of: "2026-01-01" });
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("P5 tax-code catalogue", () => {
  it("shows sets and codes read-only, with the evidence export; approvals stay in the inbox", async () => {
    svc.listTaxCodeSets.mockResolvedValue({ items: [{ id: 3, code: "PLATFORM", version: "2", status: "PUBLISHED",
      published_at: "2026-11-01T00:00:00Z", codes: [{ id: 1, code: "SVC", name: "Services", supply_category: "SERVICES",
        registry_product_scope: "GENERAL", parent_code: null }] }], next_cursor: null });
    svc.getEvidenceBundle.mockResolvedValue({ bundle_sha256: "ab".repeat(32) });
    const { container } = renderAt("/super-admin/tax/tax-codes");
    expect(await screen.findByText("PLATFORM v2")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "SVC" })).toBeInTheDocument();
    expect(screen.getAllByRole("cell", { name: "Services" })).toHaveLength(2);           // name + supply category
    expect(screen.getByRole("link", { name: "approvals inbox" })).toHaveAttribute("href", "/super-admin/tax/inbox");
    expect(screen.queryByRole("button", { name: /approve|publish/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export evidence (JSON)" }));
    await waitFor(() => expect(svc.getEvidenceBundle).toHaveBeenCalledWith("tax_code_set", 3, "json"));
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ── Phase 7 PR 1: shadow compare (platform) ─────────────────────────────

describe("shadow compare (platform)", () => {
  beforeEach(() => {
    svc.listShadowSelections.mockResolvedValue({ items: [{ id: 1, pack_code: "GB-VAT-DOMESTIC-SERVICES", pack_version: "1",
      pack_status: "PENDING_REVIEW", active: true, exit_min_invoices: 50, exit_min_days: 30, reason: "UK",
      chosen_at: "2026-11-01T09:00:00Z" }] });
    svc.getShadowAggregate.mockResolvedValue({ enrolments_by_state: { ACTIVE: 2 }, compared: 40, match_rate: 0.9,
      unexplained: 1, by_outcome: {}, differences_by_cause: {}, would_have_been_blocked: {} });
    svc.listRulePacks.mockResolvedValue({ items: [{ id: 3, code: "GB-VAT-DOMESTIC-SERVICES", version: "1", status: "PENDING_REVIEW" }],
      next_cursor: null });
  });

  it("shows the chosen pack, the advisory threshold and counts only", async () => {
    const { container } = renderAt("/super-admin/tax/shadow");
    expect(await screen.findByText("GB-VAT-DOMESTIC-SERVICES v1")).toBeInTheDocument();
    expect(screen.getByText(/50 invoices over 30 days with zero unexplained/)).toBeInTheDocument();
    expect(screen.getByText(/40 invoice\(s\) compared · match rate 90%/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/INV-|organization/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("the tax lead chooses a pack with MFA step-up and one retry; a reviewer can't", async () => {
    svc.chooseShadowSelection.mockRejectedValueOnce(STEP_UP).mockResolvedValueOnce({ id: 2 });
    renderAt("/super-admin/tax/shadow");
    fireEvent.click(await screen.findByRole("button", { name: "Choose pack" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("option", { name: /GB-VAT-DOMESTIC-SERVICES v1/ })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText(/Rule pack version/), { target: { value: "3" } });
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: "UK rehearsal" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose" }));
    const mfa = await screen.findByRole("dialog", { name: /Confirm with MFA/ }, { timeout: 5000 });
    fireEvent.change(within(mfa).getByLabelText(/Authenticator code/), { target: { value: "123456" } });
    fireEvent.click(within(mfa).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(svc.chooseShadowSelection).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(svc.chooseShadowSelection.mock.calls[1][0]).toMatchObject({ rule_pack_version_id: 3, exit_min_invoices: 50,
      exit_min_days: 30, reason: "UK rehearsal", code: "123456" });
    cleanup();
    current.user = REVIEWER;
    renderAt("/super-admin/tax/shadow");
    expect(await screen.findByRole("button", { name: "Choose pack" })).toBeDisabled();
  });
});

// ── Phase 7 PR 3: daily anomaly checks ──────────────────────────────────

describe("anomaly checks on Findings", () => {
  it("shows the last run's counts and flagged markets, without identifiers", async () => {
    svc.listAnomalyRuns.mockResolvedValue({ items: [{ id: 1, started_at: "2026-11-10T03:00:00Z",
      counts: { snapshot: { checked: 40, found: 1 }, provider_drift: { checked: 5, found: 0 }, credits: { checked: 3, found: 0 } },
      markets: { GB: { invoices: 40, zero_tax_share: 0.5, baseline_zero_tax_share: 0.0, zero_tax_alert: true, rate_mix_alert: false } } }] });
    const { container } = renderAt("/super-admin/tax/findings");
    expect(await screen.findByText("Invoices that differ from their tax snapshot: 1 of 40 checked")).toBeInTheDocument();
    expect(screen.getByText(/GB: 40 invoice\(s\), zero tax 50% \(baseline 0%\)/)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Markets" })).getByText("Needs review")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/INV-/);                          // counts only, no invoice numbers
    expect(await axe(container)).toHaveNoViolations();
  });
});
