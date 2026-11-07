import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { axe } from "../../test/a11y";

// ZB-TAX-ARCH-001 Phase 5c PR 2: tenant T10 reports, Provider Connections
// and stuck provider transactions.

const { svc, current } = vi.hoisted(() => ({
  current: { user: null },
  svc: Object.fromEntries([
    "listPeople", "listLegalEntities", "getOvercollectionReport", "getDuplicateRowsReport", "listProviders",
    "listProviderConnections", "proposeProviderConnection", "providerConnectionAction", "decideProviderConnection",
    "withdrawProviderConnection", "setProviderCredentials", "revokeProviderCredentials", "listProviderTransactions",
    "providerTransactionAction", "requestModeChange", "decideModeChange", "withdrawModeChange", "lookupReferenceRates",
    "listJurisdictions", "getTenantEvidenceBundle", "getMfaStatus", "startMfa", "verifyMfa", "disableMfa", "listMfaUsers",
    "requestMfaReset", "approveMfaReset", "cancelMfaReset", "listShadowEnrolments", "proposeShadow", "decideShadow",
    "withdrawShadow", "endShadow", "getShadowSummary", "listShadowComparisons", "exportShadowComparisons",
    "getShadowComparison",
  ].map((k) => [k, vi.fn()])),
}));
vi.mock("../../api/client", async (importOriginal) => ({ ...(await importOriginal()), getStoredUser: () => current.user }));
vi.mock("./governanceService", () => Object.fromEntries(Object.keys(svc).map((k) => [k, (...a) => svc[k](...a)])));

import TaxGovernancePage from "./TaxGovernancePage";
import { resetTenantPeopleCache } from "./common";

const page = (items, next_cursor = null) => Promise.resolve({ items, next_cursor });
const ADMIN = { id: 1, role: "org_admin", organization_id: 5 };
const BILLING = { id: 2, role: "billing_admin", organization_id: 5 };
const APPROVER = { id: 3, role: "finance_approver", organization_id: 5 };
const SECRET = "sk_live_THIS_MUST_NEVER_RENDER_4242";

const connection = (over = {}) => ({
  id: 40, seller_entity_id: 10, provider_name: "fake-provider", environment: "SANDBOX", mode: "ESTIMATE_ONLY",
  status: "APPROVED", proposed_by: 2, approved_by: 3, suspended_reason: null, resume_requested_by: null,
  credentials: { present: true, last_rotated_at: "2026-11-06T09:00:00Z", last4: "4242", store: "fernet", rotation_pending_test: false },
  health: { ok: true, checked_at: "2026-11-06T09:05:00Z", detail: null }, ...over,
});
const txn = (over = {}) => ({
  id: 70, operation: "COMMIT", state: "REVIEW_REQUIRED", provider_name: "fake-provider", invoice_id: 9,
  invoice_number: "INV-0009", review_kind: "DRIFT", review_reason: "Provider total differs by 0.01",
  last_error: "drift: total_tax", attempts: 2, age_seconds: 7200, provider_transaction_id: "txn-1",
  void_requested_by: null, owner: "billing_admin", ...over,
});

function renderAt(section) {
  return render(
    <MemoryRouter initialEntries={[`/billing/tax/governance/${section}`]}>
      <Routes><Route path="/billing/tax/governance/:section" element={<TaxGovernancePage />} /></Routes>
    </MemoryRouter>,
  );
}

let click;
beforeEach(() => {
  current.user = BILLING;
  Object.values(svc).forEach((fn) => fn.mockReset());
  svc.listPeople.mockImplementation(() => page([
    { id: 1, name: "Ana Admin", role: "ORG_ADMIN" }, { id: 2, name: "Bo Billing", role: "BILLING_ADMIN" },
    { id: 3, name: "Fay Finance", role: "FINANCE_APPROVER" }, { id: 4, name: "Gil Finance", role: "FINANCE_APPROVER" },
  ]));
  svc.listLegalEntities.mockImplementation(() => page([{ id: 10, entity_code: "MAIN", legal_name: "Acme Ltd" }]));
  svc.listProviders.mockResolvedValue({ items: [{ name: "fake-provider", environments: ["PRODUCTION", "SANDBOX"] }] });
  svc.listProviderConnections.mockImplementation(() => page([connection()]));
  svc.listProviderTransactions.mockImplementation(() => page([txn()]));
  resetTenantPeopleCache();
  click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});
afterEach(() => { cleanup(); click.mockRestore(); delete URL.createObjectURL; delete URL.revokeObjectURL; });

// ── T10 reports ─────────────────────────────────────────────────────────

describe("T10 reports", () => {
  beforeEach(() => {
    svc.getOvercollectionReport.mockImplementation((format) => (format === "csv"
      ? Promise.resolve("invoice_number,issue_date\nINV-7,2026-01-01\n")
      : Promise.resolve({ method: "Estimate = tax x discount share.",
        totals_by_currency: [{ currency: "GBP", invoice_count: 2, tax_amount: "40.00", estimated_overcollected_tax: "3.00" }],
        invoices: [
          { invoice_id: 7, invoice_number: "INV-7", issue_date: "2026-01-01", status: "SENT", currency: "GBP",
            discount_percentage: "10", document_discount: "10.00", tax_amount: "20.00", estimated_overcollected_tax: "2.00" },
          { invoice_id: 8, invoice_number: "INV-8", issue_date: "2026-01-02", status: "PAID", currency: "GBP",
            discount_percentage: "0", document_discount: "5.00", tax_amount: "20.00", estimated_overcollected_tax: "1.00" },
        ] })));
    svc.getDuplicateRowsReport.mockResolvedValue({ duplicate_rows: 1, note: "Reported only.",
      invoices: [{ invoice_id: 7, invoice_number: "INV-7", duplicate_rows: 1 }] });
  });

  it("shows invoice detail including fixed discounts, and exports CSV", async () => {
    current.user = APPROVER;
    URL.createObjectURL = vi.fn(() => "blob:csv");
    URL.revokeObjectURL = vi.fn();
    const { container } = renderAt("reports");
    expect(await screen.findByText("5.00 (fixed)")).toBeInTheDocument();
    expect(screen.getByText("10.00 (10%)")).toBeInTheDocument();
    expect(screen.getByText(/1 duplicate row\(s\)/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Export CSV" })[0]);
    await waitFor(() => expect(svc.getOvercollectionReport).toHaveBeenCalledWith("csv"));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(await axe(container)).toHaveNoViolations();
  });

  it("tells a billing admin the reports are for admins and finance, without calling the API", async () => {
    renderAt("reports");
    expect(await screen.findByText(/available to organization admins and finance approvers/)).toBeInTheDocument();
    expect(svc.getOvercollectionReport).not.toHaveBeenCalled();
  });
});

// ── Provider Connections ────────────────────────────────────────────────

describe("provider connections", () => {
  it("proposes in safe mode by default, from the provider list, with no URL field", async () => {
    svc.proposeProviderConnection.mockResolvedValue(connection({ id: 41, status: "PROPOSED" }));
    renderAt("providers");
    fireEvent.click(await screen.findByRole("button", { name: "Propose connection" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "fake-provider" })).toBeInTheDocument());
    expect(within(dialog).queryByLabelText(/url|endpoint|host/i)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/^Seller entity/), { target: { value: "10" } });
    fireEvent.change(within(dialog).getByLabelText(/^Provider/), { target: { value: "fake-provider" } });
    expect(within(dialog).getByLabelText(/^Mode/)).toHaveValue("ESTIMATE_ONLY");
    fireEvent.click(within(dialog).getByRole("button", { name: "Propose" }));
    await waitFor(() => expect(svc.proposeProviderConnection).toHaveBeenCalledWith(
      { seller_entity_id: 10, provider_name: "fake-provider", environment: "SANDBOX", mode: "ESTIMATE_ONLY" }));
  });

  it("shows status, health, safe mode and a masked credential", async () => {
    renderAt("providers");
    expect(await screen.findByText("Safe mode: estimate only")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText(/set, ending ••••4242/)).toBeInTheDocument();
    expect(await screen.findByText("Bo Billing (Billing admin)")).toBeInTheDocument();     // a name, not an id
    expect(screen.getByText("Fay Finance (Finance approver)")).toBeInTheDocument();
  });

  it("sends a credential once and never renders it", async () => {
    svc.setProviderCredentials.mockResolvedValue(connection({ credentials: { present: true, last4: "4242", rotation_pending_test: true } }));
    svc.listProviderConnections
      .mockImplementationOnce(() => page([connection()]))
      .mockImplementation(() => page([connection({ credentials: { present: true, last4: "4242", rotation_pending_test: true } })]));
    const { container } = renderAt("providers");
    fireEvent.click(await screen.findByRole("button", { name: "Rotate credential" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText(/API credential/);
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save credential" }));
    await waitFor(() => expect(svc.setProviderCredentials).toHaveBeenCalledWith(40, SECRET));
    expect(await screen.findByText(/Rotation pending a test/)).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const el of document.querySelectorAll("input")) expect(el.value).not.toBe(SECRET);
  });

  it("revokes with a reason, which suspends the connection", async () => {
    svc.revokeProviderCredentials.mockResolvedValue(connection({ status: "SUSPENDED", credentials: { present: false } }));
    renderAt("providers");
    fireEvent.click(await screen.findByRole("button", { name: "Revoke credential" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/suspended at once/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Key leaked" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(svc.revokeProviderCredentials).toHaveBeenCalledWith(40, "Key leaked"));
  });

  it("tests the connection", async () => {
    svc.providerConnectionAction.mockResolvedValue(connection());
    renderAt("providers");
    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(svc.providerConnectionAction).toHaveBeenCalledWith(40, "test"));
  });

  it("two people: the proposer can't approve; a different finance approver can", async () => {
    svc.listProviderConnections.mockImplementation(() => page([connection({ status: "PROPOSED", proposed_by: 3, approved_by: null })]));
    svc.decideProviderConnection.mockResolvedValue(connection());
    current.user = APPROVER;                                      // id 3 proposed it
    renderAt("providers");
    expect(await screen.findByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getAllByText(/a different finance approver must decide it/).length).toBe(2);   // approve + reject
    cleanup();
    current.user = { id: 4, role: "finance_approver", organization_id: 5 };
    renderAt("providers");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(svc.decideProviderConnection).toHaveBeenCalledWith(40, true, {}));
  });

  it("resume: the requester can't approve their own resume", async () => {
    svc.listProviderConnections.mockImplementation(() => page([connection({ status: "SUSPENDED", suspended_reason: "Revoked",
      resume_requested_by: 3 })]));
    current.user = APPROVER;
    renderAt("providers");
    expect(await screen.findByText(/Suspended: Revoked/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve resume" })).toBeDisabled();
    expect(screen.getAllByText(/You asked to resume this connection/).length).toBeGreaterThan(0);
  });

  it("an auditor reads with no write controls", async () => {
    current.user = { id: 9, role: "auditor", organization_id: 5 };
    renderAt("providers");
    expect(await screen.findByText("fake-provider · Sandbox")).toBeInTheDocument();
    for (const name of ["Propose connection", "Test connection", "Rotate credential", "Revoke credential"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("has no axe violations", async () => {
    const { container } = renderAt("providers");
    await screen.findByText("Safe mode: estimate only");
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ── stuck provider transactions ─────────────────────────────────────────

describe("provider transactions", () => {
  it("shows state, age, last error and owner; filters on review by default", async () => {
    renderAt("transactions");
    expect(await screen.findByText(/INV-0009 · Commit · fake-provider/)).toBeInTheDocument();
    expect(screen.getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText(/Age 2 h 0 min · 2 attempt\(s\) · owner: Billing admin/)).toBeInTheDocument();
    expect(screen.getByText("Last error: drift: total_tax")).toBeInTheDocument();
    expect(svc.listProviderTransactions.mock.calls[0][0]).toMatchObject({ state: "REVIEW_REQUIRED" });
  });

  it("checks the provider's state without changing anything", async () => {
    svc.providerTransactionAction.mockResolvedValue({ transaction: txn(), provider: { available: true,
      provider: { state: "COMMITTED", transaction_id: "txn-1", total_tax: "20.01", currency: "GBP" } } });
    renderAt("transactions");
    fireEvent.click(await screen.findByRole("button", { name: "Check provider state" }));
    expect(await screen.findByText(/Provider holds:/)).toHaveTextContent("Committed");
    expect(svc.providerTransactionAction).toHaveBeenCalledWith(70, "check-state");
    expect(svc.listProviderTransactions).toHaveBeenCalledTimes(1);               // nothing reloaded or changed
  });

  it("only offers retry for rows that failed on our side", async () => {
    renderAt("transactions");
    expect(await screen.findByRole("button", { name: "Retry local finalize" })).toBeDisabled();
    expect(screen.getByText(/failed on our side, or whose outcome is unresolved/)).toBeInTheDocument();
  });

  it("void needs two people: request, then a different finance approver", async () => {
    svc.providerTransactionAction.mockResolvedValue(txn({ void_requested_by: 2, owner: "finance_approver" }));
    renderAt("transactions");
    fireEvent.click(await screen.findByRole("button", { name: "Void remote" }));
    await waitFor(() => expect(svc.providerTransactionAction).toHaveBeenCalledWith(70, "void-request"));
    cleanup();
    svc.listProviderTransactions.mockImplementation(() => page([txn({ void_requested_by: 3, owner: "finance_approver" })]));
    current.user = APPROVER;                                      // id 3 requested it
    renderAt("transactions");
    expect(await screen.findByRole("button", { name: "Approve void" })).toBeDisabled();
    cleanup();
    current.user = { id: 4, role: "finance_approver", organization_id: 5 };
    renderAt("transactions");
    expect(await screen.findByText(/owner: Finance approver/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve void" }));
    await waitFor(() => expect(svc.providerTransactionAction).toHaveBeenCalledWith(70, "void-approve", {}));
  });

  it("is closed to platform staff (T13)", () => {
    current.user = { id: 1, role: "super_admin", platform_role: "tax_publisher" };
    renderAt("transactions");
    expect(screen.getByRole("alert")).toHaveTextContent("No access to tax governance");
    expect(svc.listProviderTransactions).not.toHaveBeenCalled();
  });

  it("has no axe violations", async () => {
    const { container } = renderAt("transactions");
    await screen.findByText(/INV-0009/);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ── Phase 5c PR 3: mode change (safe mode <-> commit) ───────────────────

const STEP_UP = Object.assign(new Error("MFA step-up is required"), { code: "TAX_REGISTRY_STEP_UP_REQUIRED" });

describe("connection mode change", () => {
  it("a billing admin proposes safe mode with a reason, on the same connection", async () => {
    svc.requestModeChange.mockResolvedValue(connection({ mode_change: { to: "ESTIMATE_ONLY", requested_by: 2, reason: "pause" } }));
    svc.listProviderConnections.mockImplementation(() => page([connection({ mode: "COMMIT" })]));
    renderAt("providers");
    fireEvent.click(await screen.findByRole("button", { name: "Propose safe mode" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Pilot pause" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Propose" }));
    await waitFor(() => expect(svc.requestModeChange).toHaveBeenCalledWith(40, "ESTIMATE_ONLY", "Pilot pause"));
  });

  it("go-live needs a passing test with the current credential", async () => {
    svc.listProviderConnections.mockImplementation(() => page([connection({
      health: { ok: true, checked_at: "2026-11-06T08:00:00Z" },
      credentials: { present: true, last4: "4242", last_rotated_at: "2026-11-06T09:00:00Z", rotation_pending_test: false },
    })]));
    renderAt("providers");
    const golive = await screen.findByRole("button", { name: "Propose go-live (commit)" });
    expect(golive).toBeDisabled();
    expect(screen.getByText(/Run Test connection with the current credential first/)).toBeInTheDocument();
    cleanup();
    svc.listProviderConnections.mockImplementation(() => page([connection()]));       // tested after rotation
    renderAt("providers");
    expect(await screen.findByRole("button", { name: "Propose go-live (commit)" })).toBeEnabled();
  });

  it("the requester can't approve; a different finance approver approves with step-up and one retry", async () => {
    const pending = connection({ mode_change: { to: "COMMIT", requested_by: 3, reason: "go live", requested_at: "2026-11-06T10:00:00Z" } });
    svc.listProviderConnections.mockImplementation(() => page([pending]));
    current.user = APPROVER;                                         // id 3 requested it
    renderAt("providers");
    expect(await screen.findByText(/Change to commit \(issue invoices\) requested by Fay Finance/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve mode change" })).toBeDisabled();
    cleanup();
    current.user = { id: 4, role: "finance_approver", organization_id: 5 };
    svc.decideModeChange.mockRejectedValueOnce(STEP_UP).mockResolvedValueOnce(connection({ mode: "COMMIT" }));
    renderAt("providers");
    fireEvent.click(await screen.findByRole("button", { name: "Approve mode change" }));
    const mfa = await screen.findByRole("dialog", { name: /Confirm with MFA/ }, { timeout: 5000 });
    fireEvent.change(within(mfa).getByLabelText(/Authenticator code/), { target: { value: "123456" } });
    fireEvent.click(within(mfa).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(svc.decideModeChange).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(svc.decideModeChange.mock.calls[0]).toEqual([40, true, {}]);
    expect(svc.decideModeChange.mock.calls[1]).toEqual([40, true, { code: "123456" }]);
  });

  it("an auditor sees the pending change but no mode controls", async () => {
    current.user = { id: 9, role: "auditor", organization_id: 5 };
    svc.listProviderConnections.mockImplementation(() => page([connection({ mode_change: { to: "COMMIT", requested_by: 2 } })]));
    renderAt("providers");
    expect(await screen.findByText(/requested by Bo Billing/)).toBeInTheDocument();
    for (const name of ["Propose safe mode", "Approve mode change", "Reject mode change", "Withdraw mode change"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });
});

// ── T9 reference rates ──────────────────────────────────────────────────

describe("T9 reference rates", () => {
  beforeEach(() => {
    svc.listJurisdictions.mockImplementation(() => page([{ id: 1, code: "GB", name: "United Kingdom" }, { id: 2, code: "FR", name: "France" }]));
  });

  it("shows published rates with their source", async () => {
    svc.lookupReferenceRates.mockResolvedValue({ jurisdiction: { id: 1, code: "GB", name: "United Kingdom" }, as_of: "2026-11-06",
      coverage: "APPROVED_REFERENCE_RATES", disclaimer: "Reference only; not an amount owed.",
      items: [{ id: 5, component_code: "GB-VAT", tax_type: "VAT", tax_code: "standard", product_scope: "GENERAL", rate_percent: "20",
        valid_from: "2011-01-04", valid_to: null, status: "ACTIVE",
        source: { title: "VAT rates", permanent_url: "https://www.gov.uk/vat-rates", citation: "HMRC" } }] });
    const { container } = renderAt("rates");
    await waitFor(() => expect(screen.getByRole("option", { name: "GB — United Kingdom" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/^Jurisdiction/), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    expect(await screen.findByText("20%")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "VAT rates" })).toHaveAttribute("href", "https://www.gov.uk/vat-rates");
    expect(svc.lookupReferenceRates).toHaveBeenCalledWith({ jurisdiction_id: 1, as_of: undefined });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("says a missing rate is not 0%", async () => {
    svc.lookupReferenceRates.mockResolvedValue({ jurisdiction: { id: 2, code: "FR", name: "France" }, as_of: "2026-11-06",
      coverage: "NO_APPROVED_RATE", disclaimer: "Reference only.", items: [] });
    renderAt("rates");
    await waitFor(() => expect(screen.getByRole("option", { name: "FR — France" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/^Jurisdiction/), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Look up" }));
    expect(await screen.findByText(/no approved rate. This is not 0%/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

// ── Phase 5d PR 2: tenant MFA step-up ───────────────────────────────────

const ENROL = Object.assign(new Error("Enrol MFA to approve"), { code: "TAX_MFA_ENROLMENT_REQUIRED" });

describe("tenant MFA", () => {
  it("an approver without MFA sees 'enrol MFA to approve' with a link, not a generic error", async () => {
    svc.listProviderTransactions.mockImplementation(() => page([txn({ void_requested_by: 2, owner: "finance_approver" })]));
    svc.providerTransactionAction.mockRejectedValue(ENROL);
    current.user = APPROVER;
    renderAt("transactions");
    fireEvent.click(await screen.findByRole("button", { name: "Approve void" }));
    expect(await screen.findByText(/Enrol MFA to approve/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up MFA" })).toHaveAttribute("href", "/billing/tax/governance/mfa");
  });

  it("void approval prompts for a code and retries once", async () => {
    svc.listProviderTransactions.mockImplementation(() => page([txn({ void_requested_by: 2, owner: "finance_approver" })]));
    svc.providerTransactionAction.mockRejectedValueOnce(STEP_UP).mockResolvedValueOnce(txn({ state: "VOIDED", owner: null }));
    current.user = APPROVER;
    renderAt("transactions");
    fireEvent.click(await screen.findByRole("button", { name: "Approve void" }));
    const mfa = await screen.findByRole("dialog", { name: /Confirm with MFA/ }, { timeout: 5000 });
    fireEvent.change(within(mfa).getByLabelText(/Authenticator code/), { target: { value: "654321" } });
    fireEvent.click(within(mfa).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(svc.providerTransactionAction).toHaveBeenCalledTimes(2), { timeout: 5000 });
    expect(svc.providerTransactionAction.mock.calls[1]).toEqual([70, "void-approve", { code: "654321" }]);
  });

  it("enrols: key and link, a code, then recovery codes shown once", async () => {
    svc.getMfaStatus.mockResolvedValueOnce({ enrolled: false, tax_tenant_step_up_required: true })
      .mockResolvedValue({ enrolled: true, tax_tenant_step_up_required: true });
    svc.startMfa.mockResolvedValue({ secret: "JBSWY3DPEHPK3PXP", otpauth_url: "otpauth://totp/Zoiko:fay?secret=JBSWY3DPEHPK3PXP" });
    svc.verifyMfa.mockResolvedValue({ recovery_codes: ["aaaa111111", "bbbb222222"] });
    current.user = APPROVER;
    const { container } = renderAt("mfa");
    expect(await screen.findByText("MFA not set up")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set up MFA" }));
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Code from the app/), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on MFA" }));
    await waitFor(() => expect(svc.verifyMfa).toHaveBeenCalledWith("123456"));
    expect(await screen.findByRole("list", { name: "Recovery codes" })).toHaveTextContent("aaaa111111");
    expect(screen.queryByText("JBSWY3DPEHPK3PXP")).not.toBeInTheDocument();          // the key is gone once enrolled
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByRole("button", { name: "I've saved them" }));
    expect(await screen.findByText("MFA on")).toBeInTheDocument();
    expect(screen.queryByText("aaaa111111")).not.toBeInTheDocument();
  });

  it("an org admin sees who is enrolled; a reset needs a second admin and never their own", async () => {
    svc.getMfaStatus.mockResolvedValue({ enrolled: true, tax_tenant_step_up_required: true });
    svc.listMfaUsers.mockResolvedValue({ items: [
      { user_id: 1, name: "Ana Admin", role: "ORG_ADMIN", enrolled: true, reset_requested_by: null },
      { user_id: 3, name: "Fay Finance", role: "FINANCE_APPROVER", enrolled: true, reset_requested_by: 1,
        reset_requested_at: "2026-11-06T10:00:00Z" },
      { user_id: 4, name: "Gil Finance", role: "FINANCE_APPROVER", enrolled: false, reset_requested_by: null },
    ] });
    current.user = ADMIN;                                            // id 1
    const { container } = renderAt("mfa");
    expect(await screen.findByText("Gil Finance (Finance approver)")).toBeInTheDocument();
    expect(screen.getAllByText("MFA not set up").length).toBe(1);
    expect(screen.getByRole("button", { name: "Request MFA reset" })).toBeDisabled();   // own row (Ana)
    expect(screen.getByText(/can't reset your own MFA/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve MFA reset" })).toBeDisabled();   // Ana requested Fay's
    expect(screen.getByText(/You requested this reset/)).toBeInTheDocument();
    expect(svc.listMfaUsers).toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("only org admins see the enrolment list", async () => {
    svc.getMfaStatus.mockResolvedValue({ enrolled: false, tax_tenant_step_up_required: true });
    current.user = BILLING;
    renderAt("mfa");
    expect(await screen.findByRole("button", { name: "Set up MFA" })).toBeInTheDocument();
    expect(svc.listMfaUsers).not.toHaveBeenCalled();
  });
});

// ── Phase 5d-F: MFA hardening ───────────────────────────────────────────

describe("MFA hardening", () => {
  it("turning MFA off needs the password and a current code", async () => {
    svc.getMfaStatus.mockResolvedValue({ enrolled: true, tax_tenant_step_up_required: true, tax_step_up_usable_at: null });
    svc.disableMfa.mockResolvedValue({ message: "ok" });
    current.user = APPROVER;
    renderAt("mfa");
    fireEvent.click(await screen.findByRole("button", { name: "Turn off MFA" }));
    fireEvent.change(screen.getByLabelText(/Your current password/), { target: { value: "pw" } });
    const turnOff = screen.getByRole("button", { name: "Turn off" });
    expect(turnOff).toBeDisabled();                                               // no factor yet
    fireEvent.change(screen.getByLabelText(/Code from your app, or a recovery code/), { target: { value: "123456" } });
    fireEvent.click(turnOff);
    await waitFor(() => expect(svc.disableMfa).toHaveBeenCalledWith("pw", "123456"));
  });

  it("says when a new factor becomes usable for approvals", async () => {
    svc.getMfaStatus.mockResolvedValue({ enrolled: true, tax_tenant_step_up_required: true,
      tax_step_up_usable_at: "2026-11-07T10:00:00Z", tax_step_up_new_factor_delay_hours: 24 });
    current.user = APPROVER;
    renderAt("mfa");
    expect(await screen.findByText(/New MFA can approve tax changes from/)).toHaveTextContent("24 hours after setup");
  });

  it("shows the cooling-off refusal with its time, not a generic error", async () => {
    svc.listProviderTransactions.mockImplementation(() => page([txn({ void_requested_by: 2, owner: "finance_approver" })]));
    svc.providerTransactionAction.mockRejectedValue(Object.assign(
      new Error("Your MFA was set up recently. For safety it can approve tax changes from 2026-11-07 10:00 UTC (24 hours after setup)."),
      { code: "TAX_MFA_FACTOR_COOLING_OFF" }));
    current.user = APPROVER;
    renderAt("transactions");
    fireEvent.click(await screen.findByRole("button", { name: "Approve void" }));
    expect(await screen.findByText(/can approve tax changes from 2026-11-07 10:00 UTC/)).toBeInTheDocument();
  });
});

// ── Phase 7 PR 1: shadow compare ────────────────────────────────────────

describe("shadow compare (tenant)", () => {
  const enrolment = (over = {}) => ({ id: 5, seller_entity_id: 10, state: "ACTIVE", status: "APPROVED", reason: "rehearse",
    proposed_by: 1, approved_by: 3, started_at: "2026-11-01T09:00:00Z",
    exit_signal: { ready: false, advisory: true, message: "1 of 50 invoices, 6 of 30 days, 0 unexplained." }, ...over });
  beforeEach(() => {
    svc.listShadowEnrolments.mockImplementation(() => page([enrolment()]));
    svc.getShadowSummary.mockResolvedValue({ compared: 4, match_rate: 0.75, unexplained: 0,
      by_outcome: { MATCH: 3, DIFFERENT: 1 }, differences_by_cause: { RATE_DIFFERENT: 1 },
      would_have_been_blocked: { REQUIRED_FACTS_MISSING: 2 } });
    svc.listShadowComparisons.mockImplementation(() => page([{ id: 70, invoice_number: "INV-7", issue_date: "2026-11-02",
      outcome: "DIFFERENT", cause: "RATE_DIFFERENT", reason: "A line's legacy rate differs.", legacy_tax: "5.00",
      shadow_tax: "20.00", tax_difference: "15.00", currency: "GBP" }]));
    svc.getShadowComparison.mockResolvedValue({ id: 70, invoice_number: "INV-7", lines: { lines: [{ line_number: 1,
      legacy_rate: "5", shadow_rate: "20", legacy_tax: "5.00", shadow_tax: "20.00", difference: "15.00",
      components: [{ component_code: "GB-VAT", label: "UK VAT", rate_percent: "20", tax: "20.00" }] }] } });
  });

  it("shows the match rate, causes, would-be blocks, the advisory exit signal and drill-down", async () => {
    const { container } = renderAt("shadow");
    expect(await screen.findByText("75%")).toBeInTheDocument();
    expect(screen.getByText("Different rate: 1")).toBeInTheDocument();
    expect(screen.getByText("Required facts missing: 2")).toBeInTheDocument();
    expect(await screen.findByText(/1 of 50 invoices, 6 of 30 days/)).toBeInTheDocument();
    expect(screen.getByText("Exit threshold not met yet")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Show lines" }));
    expect(await screen.findByText(/UK VAT 20%: 20.00/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("exports CSV", async () => {
    URL.createObjectURL = vi.fn(() => "blob:csv");
    URL.revokeObjectURL = vi.fn();
    svc.exportShadowComparisons.mockResolvedValue("invoice_number\nINV-7\n");
    renderAt("shadow");
    fireEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(svc.exportShadowComparisons).toHaveBeenCalled());
    await waitFor(() => expect(click).toHaveBeenCalled());
  });

  it("an org admin proposes for the chosen entity; a different approver approves", async () => {
    svc.listShadowEnrolments.mockImplementation(() => page([]));
    svc.proposeShadow.mockResolvedValue(enrolment({ state: "PROPOSED", status: "PROPOSED" }));
    current.user = ADMIN;
    renderAt("shadow");
    await waitFor(() => expect(screen.getByRole("option", { name: "MAIN — Acme Ltd" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/^Seller entity/), { target: { value: "10" } });
    fireEvent.click(await screen.findByRole("button", { name: "Propose shadowing this entity" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Rehearse UK" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Propose" }));
    await waitFor(() => expect(svc.proposeShadow).toHaveBeenCalledWith({ seller_entity_id: 10, reason: "Rehearse UK" }));
    cleanup();
    svc.listShadowEnrolments.mockImplementation(() => page([enrolment({ state: "PROPOSED", status: "PROPOSED", exit_signal: null })]));
    svc.decideShadow.mockResolvedValue(enrolment());
    current.user = APPROVER;
    renderAt("shadow");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(svc.decideShadow).toHaveBeenCalledWith(5, true, {}));
  });

  it("an auditor reads without propose or end controls", async () => {
    current.user = { id: 9, role: "auditor", organization_id: 5 };
    renderAt("shadow");
    expect(await screen.findByText("75%")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "End shadowing" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Propose shadowing/ })).not.toBeInTheDocument();
  });
});
