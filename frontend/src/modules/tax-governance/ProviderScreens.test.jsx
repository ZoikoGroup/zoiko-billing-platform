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
    "providerTransactionAction",
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
    await waitFor(() => expect(svc.providerTransactionAction).toHaveBeenCalledWith(70, "void-approve"));
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
