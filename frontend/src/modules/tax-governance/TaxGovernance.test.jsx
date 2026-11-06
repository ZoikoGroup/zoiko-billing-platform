import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { axe } from "../../test/a11y";

// ZB-TAX-ARCH-001 Phase 5b PR 2: tenant Settings → Taxes (T1–T8).

const { svc, current } = vi.hoisted(() => ({
  current: { user: null },
  svc: Object.fromEntries([
    "listJurisdictions", "listTaxTypes", "listPeople", "listCoverage", "listTaxCodes", "listLegalEntities",
    "createLegalEntity", "updateLegalEntity", "setDefaultLegalEntity", "getRegimeEligibility", "proposeRegimeChange",
    "listRegimeChanges", "decideRegimeChange", "withdrawRegimeChange", "listRegistrations", "createRegistration",
    "listLegalBases", "proposeLegalBasis", "decideLegalBasis", "withdrawLegalBasis", "uploadEvidence",
    "listActivations", "proposeActivation", "decideActivation", "withdrawActivation", "getActivationEffective",
    "listProviderConnections", "listClassifications", "proposeClassification", "previewClassificationImpact",
    "decideClassification", "withdrawClassification", "searchProducts", "searchCustomers", "getCustomerTaxEvidence",
    "recordTaxAddress", "resolveTaxAddress", "proposeManualResolution", "listManualResolutions",
    "decideManualResolution", "withdrawManualResolution", "addTaxId", "retireTaxId", "addCertificate",
    "revokeCertificate", "listReviewItems", "resolveReviewItem", "getTenantEvidenceBundle",
  ].map((k) => [k, vi.fn()])),
}));
vi.mock("../../api/client", async (importOriginal) => ({ ...(await importOriginal()), getStoredUser: () => current.user }));
vi.mock("./governanceService", () => Object.fromEntries(Object.keys(svc).map((k) => [k, (...a) => svc[k](...a)])));

import TaxGovernancePage from "./TaxGovernancePage";
import { evidenceProblem, resetTenantPeopleCache } from "./common";
import { resolutionState } from "./EvidenceScreens";

const page = (items, next_cursor = null) => Promise.resolve({ items, next_cursor });
const STEP_UP = Object.assign(new Error("MFA step-up is required"), { code: "TAX_REGISTRY_STEP_UP_REQUIRED" });
const ADMIN = { id: 1, role: "org_admin", organization_id: 5 };
const BILLING = { id: 2, role: "billing_admin", organization_id: 5 };
const APPROVER = { id: 3, role: "finance_approver", organization_id: 5 };
const legacyEntity = { id: 10, entity_code: "MAIN", legal_name: "Acme Ltd", tax_regime: "LEGACY_MANUAL", is_default: true, version: 1, country_code: "GB" };

function renderAt(section) {
  return render(
    <MemoryRouter initialEntries={[`/billing/tax/governance/${section}`]}>
      <Routes><Route path="/billing/tax/governance/:section" element={<TaxGovernancePage />} /></Routes>
    </MemoryRouter>,
  );
}
const WRITES = ["createLegalEntity", "updateLegalEntity", "setDefaultLegalEntity", "proposeRegimeChange", "createRegistration",
  "proposeLegalBasis", "proposeActivation", "proposeClassification", "uploadEvidence", "recordTaxAddress", "addTaxId",
  "addCertificate", "decideActivation", "decideRegimeChange"];

beforeEach(() => {
  current.user = BILLING;
  Object.values(svc).forEach((fn) => fn.mockReset());
  Object.keys(svc).filter((k) => k.startsWith("list")).forEach((k) => svc[k].mockImplementation(() => page([])));
  svc.listLegalEntities.mockImplementation(() => page([legacyEntity]));
  svc.listJurisdictions.mockImplementation(() => page([{ id: 1, code: "GB", name: "United Kingdom" }, { id: 2, code: "US", name: "United States" }]));
  svc.listTaxTypes.mockImplementation(() => page([{ id: 4, code: "VAT", name: "Value added tax" }]));
  svc.listPeople.mockImplementation(() => page([
    { id: 1, name: "Ana Admin", role: "ORG_ADMIN" }, { id: 2, name: "Bo Billing", role: "BILLING_ADMIN" },
    { id: 3, name: "Fay Finance", role: "FINANCE_APPROVER" },
  ]));
  svc.listTaxCodes.mockResolvedValue({ items: [{ id: 7, code: "SVC", name: "Services", supply_category: "SERVICES" }] });
  svc.getRegimeEligibility.mockResolvedValue({ would_qualify: false, unmet_conditions: ["no approved activation in a calculating mode is in effect"], effective_activations: [], backing_activations: [] });
  resetTenantPeopleCache();
});
afterEach(cleanup);

// ── guard ───────────────────────────────────────────────────────────────

describe("access", () => {
  it.each([{ role: "super_admin" }, { role: "guest" }, null])("shows no access to %o", (user) => {
    current.user = user;
    renderAt("overview");
    expect(screen.getByRole("alert")).toHaveTextContent("No access to tax governance");
    expect(svc.listLegalEntities).not.toHaveBeenCalled();
  });

  it("lets an auditor read without any write controls", async () => {
    current.user = { id: 9, role: "auditor" };
    renderAt("registrations");
    expect(await screen.findByRole("heading", { name: "Registrations and legal bases" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add registration" })).not.toBeInTheDocument();
  });
});

// ── T1 and the legacy tenant ────────────────────────────────────────────

describe("overview (T1) and legacy tenants", () => {
  it("shows the regime, what blocks issuing, and that a legacy tenant is unchanged", async () => {
    renderAt("overview");
    expect(await screen.findByText(/invoices keep using your Tax Rates settings exactly as today/)).toBeInTheDocument();
    expect(screen.getByText("Legacy manual")).toBeInTheDocument();
    expect(await screen.findByText("no approved activation in a calculating mode is in effect")).toBeInTheDocument();
    WRITES.forEach((k) => expect(svc[k]).not.toHaveBeenCalled());            // viewing changes nothing
  });
});

// ── T2 ──────────────────────────────────────────────────────────────────

describe("legal entities (T2)", () => {
  it("lets an org admin add an entity; a billing admin can't", async () => {
    current.user = ADMIN;
    svc.createLegalEntity.mockResolvedValue({ id: 11 });
    renderAt("entities");
    fireEvent.click(await screen.findByRole("button", { name: "Add entity" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^Entity code/), { target: { value: "EU" } });
    fireEvent.change(within(dialog).getByLabelText(/^Legal name/), { target: { value: "Acme EU BV" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add entity" }));
    await waitFor(() => expect(svc.createLegalEntity).toHaveBeenCalledWith({ entity_code: "EU", legal_name: "Acme EU BV" }));
    cleanup();
    current.user = BILLING;
    renderAt("entities");
    await screen.findByText(/MAIN — Acme Ltd/);
    expect(screen.queryByRole("button", { name: "Add entity" })).not.toBeInTheDocument();
  });
});

// ── T3: registrations, legal bases, evidence ────────────────────────────

describe("registrations and legal bases (T3)", () => {
  it("adds a registration with pickers", async () => {
    svc.createRegistration.mockResolvedValue({ id: 30 });
    renderAt("registrations");
    fireEvent.click(await screen.findByRole("button", { name: "Add registration" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "GB — United Kingdom" })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText(/^Seller entity/), { target: { value: "10" } });
    fireEvent.change(within(dialog).getByLabelText(/^Jurisdiction/), { target: { value: "1" } });
    fireEvent.change(within(dialog).getByLabelText(/^Tax type/), { target: { value: "4" } });
    fireEvent.change(within(dialog).getByLabelText(/^Registration number/), { target: { value: "GB123456789" } });
    fireEvent.change(within(dialog).getByLabelText(/^Valid from/), { target: { value: "2025-01-01" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add registration" }));
    await waitFor(() => expect(svc.createRegistration).toHaveBeenCalledWith({
      seller_entity_id: 10, jurisdiction_id: 1, tax_type_id: 4, registration_number: "GB123456789", valid_from: "2025-01-01" }));
  });

  it("validates evidence before uploading it", async () => {
    svc.listRegistrations.mockImplementation(() => page([{ id: 30, jurisdiction_code: "GB", tax_type: "VAT", registration_number: "GB1",
      status: "ACTIVE", verification_status: "UNVERIFIED", valid_from: "2025-01-01", created_by: 2, evidence_attached: false }]));
    svc.uploadEvidence.mockResolvedValue({ id: 30, evidence_attached: true });
    renderAt("registrations");
    const form = await screen.findByRole("form", { name: /upload registration certificate/i });
    const input = within(form).getByLabelText(/Registration certificate/);
    fireEvent.change(input, { target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] } });
    expect(await within(form).findByText("Evidence must be a PDF, PNG or JPEG file.")).toBeInTheDocument();
    const big = new File(["x"], "big.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 6 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await within(form).findByText("The file is larger than 5 MB.")).toBeInTheDocument();
    fireEvent.submit(form);
    expect(svc.uploadEvidence).not.toHaveBeenCalled();
    const pdf = new File(["%PDF-1.7"], "cert.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [pdf] } });
    fireEvent.submit(form);
    await waitFor(() => expect(svc.uploadEvidence).toHaveBeenCalled());
    expect(svc.uploadEvidence.mock.calls[0].slice(0, 3)).toEqual(["registrations", 30, pdf]);
  });

  it("knows the backend's evidence rules", () => {
    expect(evidenceProblem(new File(["x"], "a.png", { type: "image/png" }))).toBeNull();
    expect(evidenceProblem(new File([], "a.pdf", { type: "application/pdf" }))).toBe("The file is empty.");
    expect(evidenceProblem(new File(["x"], "a.gif", { type: "image/gif" }))).toMatch(/PDF, PNG or JPEG/);
  });

  it("disables approve for the proposer, with the reason as text", async () => {
    current.user = { id: 3, role: "finance_approver" };
    svc.listLegalBases.mockImplementation(() => page([{ id: 40, seller_entity_id: 10, jurisdiction_id: 1, tax_type_id: 4,
      legal_basis: "Sch 1A", evidence_ref: "cab", valid_from: "2025-01-01", status: "PROPOSED", recorded_by: 3 }]));
    renderAt("registrations");
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    expect(screen.getAllByText(/You proposed this; a different finance approver must decide it./).length).toBeGreaterThan(0);
  });

  it("shows proposers by name, not user id", async () => {
    current.user = APPROVER;
    svc.listLegalBases.mockImplementation(() => page([{ id: 40, seller_entity_id: 10, jurisdiction_id: 1, tax_type_id: 4,
      legal_basis: "Sch 1A", evidence_ref: "cab", valid_from: "2025-01-01", status: "PROPOSED", recorded_by: 2 }]));
    renderAt("registrations");
    expect(await screen.findByText(/proposed by Bo Billing \(Billing admin\)/)).toBeInTheDocument();
  });
});

// ── T4: activations, approval with step-up retry, pagination ───────────

describe("activations (T4)", () => {
  const proposed = { id: 50, jurisdiction_code: "GB", tax_type: "VAT", transaction_class: "B2B_SERVICES", mode: "NATIVE_RULEPACK_APPROVED",
                     effective_from: "2026-01-01", status: "PROPOSED", proposed_by: 2, registration_id: 30 };

  it("lets a different finance approver approve, retrying once after step-up", async () => {
    current.user = APPROVER;
    svc.listActivations.mockImplementation(() => page([proposed]));
    svc.decideActivation.mockRejectedValueOnce(STEP_UP).mockResolvedValueOnce({ ...proposed, status: "APPROVED" });
    renderAt("activations");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm with MFA" });
    fireEvent.change(within(dialog).getByLabelText(/Authenticator code/), { target: { value: "654321" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(svc.decideActivation).toHaveBeenCalledTimes(2));
    expect(svc.decideActivation.mock.calls[0]).toEqual([50, true, {}]);
    expect(svc.decideActivation.mock.calls[1]).toEqual([50, true, { code: "654321" }]);
  });

  it("offers only the mode the platform published for the market", async () => {
    svc.listCoverage.mockImplementation(() => page([{ jurisdiction_code: "GB", tax_type: "VAT", transaction_class: "B2B_SERVICES",
      mode: "NATIVE_RULEPACK_APPROVED", state: "SUPPORTED" }]));
    svc.listRegistrations.mockImplementation(() => page([{ id: 30, seller_entity_id: 10, jurisdiction_code: "GB", tax_type: "VAT", registration_number: "GB1" }]));
    svc.proposeActivation.mockResolvedValue({ id: 51 });
    renderAt("activations");
    fireEvent.click(await screen.findByRole("button", { name: "Propose activation" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "GB — United Kingdom" })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText(/^Seller entity/), { target: { value: "10" } });
    fireEvent.change(within(dialog).getByLabelText(/^Jurisdiction/), { target: { value: "1" } });
    fireEvent.change(within(dialog).getByLabelText(/^Tax type/), { target: { value: "4" } });
    fireEvent.change(within(dialog).getByLabelText(/^Transaction class/), { target: { value: "B2B_SERVICES" } });
    const mode = within(dialog).getByLabelText(/^Mode/);
    expect(within(mode).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose…", "Native rulepack approved (offered by the platform)"]);
    fireEvent.change(mode, { target: { value: "NATIVE_RULEPACK_APPROVED" } });
    fireEvent.change(within(dialog).getByLabelText(/^Effective from/), { target: { value: "2026-01-01" } });
    fireEvent.change(within(dialog).getByLabelText(/^Registration/), { target: { value: "30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Propose" }));
    await waitFor(() => expect(svc.proposeActivation).toHaveBeenCalledWith(expect.objectContaining({
      seller_entity_id: 10, jurisdiction_id: 1, tax_type_id: 4, mode: "NATIVE_RULEPACK_APPROVED", registration_id: 30 })));
  });

  it("follows next_cursor", async () => {
    svc.listActivations
      .mockImplementationOnce(() => page([{ ...proposed, id: 1, status: "APPROVED", jurisdiction_code: "GB" }], "c1"))
      .mockImplementationOnce(() => page([{ ...proposed, id: 2, status: "APPROVED", jurisdiction_code: "AU" }]));
    renderAt("activations");
    await screen.findByText(/GB · VAT/);
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText(/AU · VAT/)).toBeInTheDocument();
    expect(svc.listActivations.mock.calls[1][0]).toMatchObject({ cursor: "c1" });
  });
});

// ── T5 ──────────────────────────────────────────────────────────────────

describe("regime (T5)", () => {
  it("shows eligibility, warns that drafts go stale and issued invoices never change, and proposes", async () => {
    current.user = ADMIN;
    svc.proposeRegimeChange.mockResolvedValue({ id: 60, status: "PROPOSED" });
    const { container } = renderAt("regime");
    expect(await screen.findByText("no approved activation in a calculating mode is in effect")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Propose switch to governed" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/tax quotes go stale and must be re-quoted/)).toBeInTheDocument();
    expect(within(dialog).getByText(/invoices already issued never change/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Propose switch" }));
    await waitFor(() => expect(svc.proposeRegimeChange).toHaveBeenCalledWith(10, { tax_regime: "GOVERNED" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("lets a different finance approver decide; the proposer can't", async () => {
    current.user = APPROVER;
    svc.listRegimeChanges.mockImplementation(() => page([{ id: 60, from_regime: "LEGACY_MANUAL", to_regime: "GOVERNED",
      status: "PROPOSED", proposed_by: 1, created_at: "2026-11-06T09:00:00Z" }]));
    svc.decideRegimeChange.mockResolvedValue({ id: 60, status: "APPROVED" });
    renderAt("regime");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(svc.decideRegimeChange).toHaveBeenCalledWith(60, true, {}));
    expect(screen.getByText(/Proposed by Ana Admin \(Org admin\)/)).toBeInTheDocument();
  });
});

// ── T6 ──────────────────────────────────────────────────────────────────

describe("product classification (T6)", () => {
  it("previews the impact before approving", async () => {
    current.user = APPROVER;
    svc.listClassifications.mockImplementation(() => page([{ id: 70, product_id: 5, tax_code: "SVC", supply_category: "SERVICES",
      status: "PROPOSED", proposed_by: 2, created_at: "2026-11-06T09:00:00Z" }]));
    svc.previewClassificationImpact.mockResolvedValue({ product_ids: [5], draft_invoices: [{ id: 1, invoice_number: "INV-1" }],
      open_quotes: [{ id: 2, quote_number: "Q-2" }] });
    renderAt("classification");
    fireEvent.click(await screen.findByRole("button", { name: "Preview impact" }));
    expect(await screen.findByText(/1 draft invoice\(s\) and 1 open quote\(s\) must be re-quoted/)).toBeInTheDocument();
    expect(svc.previewClassificationImpact).toHaveBeenCalledWith([5]);
  });
});

// ── T7 ──────────────────────────────────────────────────────────────────

describe("customer tax evidence (T7)", () => {
  const evidence = {
    customer_id: 8,
    addresses: [
      { id: 80, role: "BILLING", country_code: "US", subdivision_code: "CA", postal_code: "90012", line1: "1 Main St",
        resolution: { id: 1, status: "RESOLVED", precision: "ROOFTOP", resolver: "acme", jurisdiction_codes: ["US", "US-CA"], valid_until: "2020-01-01T00:00:00Z" } },
      { id: 81, role: "SHIPPING", country_code: "US", subdivision_code: "CA", postal_code: "90012", line1: "5 Split Rd",
        resolution: { id: 2, status: "AMBIGUOUS", precision: "STREET", resolver: "acme", jurisdiction_codes: [], valid_until: "2099-01-01T00:00:00Z" } },
    ],
    tax_ids: [{ id: 90, value: "123-45", verification_status: "VERIFIED" }],
    exemption_certificates: [{ id: 95, certificate_number: "RESALE-1", scope_description: "Resale", valid_from: "2025-01-01",
      expires_at: "2026-01-01", status: "ACTIVE", evidence_attached: true }],
  };

  it("shows stale and ambiguous resolutions, expired certificates, and requests a manual resolution", async () => {
    svc.searchCustomers.mockResolvedValue({ items: [{ id: 8, display_name: "Globex" }] });
    svc.getCustomerTaxEvidence.mockResolvedValue(evidence);
    svc.proposeManualResolution.mockResolvedValue({ id: 99, status: "PROPOSED" });
    const { container } = renderAt("customers");
    fireEvent.change(await screen.findByRole("textbox", { name: "Customer" }), { target: { value: "glo" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Globex" }));
    expect(await screen.findByText("Stale")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve again" })).toBeInTheDocument();
    expect(screen.getByText("Ambiguous")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
    const form = await screen.findByRole("form", { name: "Request a manual resolution" });
    fireEvent.change(within(form).getByLabelText(/Jurisdiction codes/), { target: { value: "US, US-CA, US-CA-LA" } });
    fireEvent.change(within(form).getByLabelText(/^Reason/), { target: { value: "county lookup" } });
    fireEvent.submit(form);
    await waitFor(() => expect(svc.proposeManualResolution).toHaveBeenCalledWith(8, 81, {
      jurisdiction_codes: ["US", "US-CA", "US-CA-LA"], reason: "county lookup" }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("computes the resolution state", () => {
    const now = new Date("2026-11-06T00:00:00Z");
    expect(resolutionState(null, now)).toBe("NOT_RESOLVED");
    expect(resolutionState({ status: "RESOLVED", valid_until: "2027-01-01T00:00:00Z" }, now)).toBe("RESOLVED");
    expect(resolutionState({ status: "RESOLVED", valid_until: "2026-01-01T00:00:00Z" }, now)).toBe("STALE");
    expect(resolutionState({ status: "NOT_FOUND" }, now)).toBe("NOT_FOUND");
  });
});

// ── T8 ──────────────────────────────────────────────────────────────────

describe("review items (T8)", () => {
  it("lists items with owner and age, and resolves one", async () => {
    svc.listReviewItems.mockImplementation(() => page([{ id: 3, kind: "ADDRESS_RESOLUTION_STALE", subject_type: "TaxAddressResolution",
      subject_id: 1, detail: "Address resolution 1 is stale.", status: "OPEN", owner_role: "BILLING_ADMIN", age_days: 4 }]));
    svc.resolveReviewItem.mockResolvedValue({ id: 3, status: "RESOLVED" });
    renderAt("review");
    expect(await screen.findByText("Address resolution stale")).toBeInTheDocument();
    expect(screen.getByText(/owner: Billing admin · open 4 day\(s\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
    await waitFor(() => expect(svc.resolveReviewItem).toHaveBeenCalledWith(3));
  });
});

// ── Phase 5c PR 1: product names and audit-evidence export ──────────────

describe("product names and evidence export (Phase 5c)", () => {
  let click;
  beforeEach(() => { click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {}); });
  afterEach(() => click.mockRestore());
  const classification = { id: 70, product_id: 5, product_name: "Consulting hours", tax_code: "SVC",
    supply_category: "SERVICES", status: "APPROVED", proposed_by: 2, approved_by: 3, created_at: "2026-11-06T09:00:00Z" };

  it("shows the product name, not the id, and exports the classification's evidence", async () => {
    current.user = APPROVER;
    svc.listClassifications.mockImplementation(() => page([classification]));
    svc.getTenantEvidenceBundle.mockResolvedValue({ kind: "classification", bundle_sha256: "ef".repeat(32) });
    renderAt("classification");
    expect(await screen.findByText(/Consulting hours → SVC/)).toBeInTheDocument();
    expect(screen.queryByText(/Product #5/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export evidence (JSON)" }));
    await waitFor(() => expect(svc.getTenantEvidenceBundle).toHaveBeenCalledWith("classification", 70, "json"));
    expect(await screen.findByText("ef".repeat(32))).toBeInTheDocument();
  });

  it("hides the export from an auditor, whom the backend refuses", async () => {
    current.user = { id: 9, role: "auditor" };
    svc.listClassifications.mockImplementation(() => page([classification]));
    renderAt("classification");
    expect(await screen.findByText(/Consulting hours → SVC/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export evidence (JSON)" })).not.toBeInTheDocument();
  });
});
