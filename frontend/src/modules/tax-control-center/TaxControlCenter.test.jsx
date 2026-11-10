import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { axe } from "../../test/a11y";

// ZB-TAX-ARCH-001 Phase 5a: the Tax Control Center sign-off screens.

const { svc, current } = vi.hoisted(() => ({
  current: { user: null },
  svc: Object.fromEntries([
    "listApprovalsInbox", "approveInboxItem", "listSourceRevisions", "registerSourceRevision", "attachSourceEvidence",
    "listStagedRates", "getStagedRateComparison", "stagedRateAction", "stageRate", "amendStagedRate",
    "listMarketAvailability", "draftAvailability", "amendAvailability", "availabilityAction", "listJurisdictions",
    "listRulePacks", "getRulePackCatalogue", "registerRulePack", "amendRulePack", "rulePackAction", "getStagedRate",
    "listAuthorities", "listTaxTypes", "listComponents", "listTaxPeople", "getEvidenceBundle", "getRegression", "runRegression",
    "cancelScheduledActivation", "decideActivationCancellation",
    "listRollbackCandidates", "proposeRollback", "decideRollback",
    "getRetroPreview", "runRetroPreview", "listRetroAnalyses",
  ].map((k) => [k, vi.fn()])),
}));
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal()),
  getStoredUser: () => current.user,
}));
vi.mock("./taxRegistryService", async (importOriginal) => ({
  fetchAllPages: (await importOriginal()).fetchAllPages,
  ...Object.fromEntries(Object.keys(svc).map((k) => [k, (...args) => svc[k](...args)])),
}));


import TaxControlCenterPage from "./TaxControlCenterPage";
import { gateProblems, mandatoryGates } from "./gates";
import { previewUtc } from "./ScheduleControls";
import { resetPeopleCache } from "./shared";

const STEP_UP = Object.assign(new Error("MFA step-up is required"), { code: "TAX_REGISTRY_STEP_UP_REQUIRED", status: 400 });
const page = (items, next_cursor = null) => Promise.resolve({ items, next_cursor });

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/super-admin/tax/:section" element={<TaxControlCenterPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const inboxItem = (over = {}) => ({
  kind: "staged_rate", id: 31, title: "GB-VAT STANDARD/GENERAL 20% from 2011-01-04", submitted_by: 9,
  submitted_at: "2026-11-05T09:20:44Z", can_approve: true, reason_if_not: null, ...over,
});

beforeEach(() => {
  current.user = { id: 7, role: "super_admin", platform_role: "tax_publisher" };
  Object.values(svc).forEach((fn) => fn.mockReset());
  svc.listApprovalsInbox.mockImplementation(() => page([]));
  svc.listSourceRevisions.mockImplementation(() => page([]));
  svc.listStagedRates.mockImplementation(() => page([]));
  svc.listMarketAvailability.mockImplementation(() => page([]));
  svc.listRulePacks.mockImplementation(() => page([]));
  svc.getRulePackCatalogue.mockResolvedValue({ items: [] });
  svc.listJurisdictions.mockImplementation(() => page([{ id: 1, code: "GB", name: "United Kingdom" }]));
  svc.listAuthorities.mockImplementation(() => page([{ id: 1, code: "GB-HMRC", name: "HM Revenue & Customs" }]));
  svc.listTaxTypes.mockImplementation(() => page([{ id: 2, code: "VAT", name: "Value added tax" }]));
  svc.listComponents.mockImplementation(() => page([{ id: 1, code: "GB-VAT", name: "UK VAT", jurisdiction_code: "GB", tax_type: "VAT" }]));
  svc.getRegression.mockResolvedValue({ report: null, current_problem: "no regression report has been run" });
  svc.getRetroPreview.mockResolvedValue({ retroactive: false, preview: null, current_problem: "no retroactive analysis preview has been run" });
  svc.listTaxPeople.mockImplementation(() => page([
    { id: 9, name: "Mara Maker", platform_role: "TAX_REVIEWER", active: true },
    { id: 7, name: "Chen Checker", platform_role: "TAX_PUBLISHER", active: true },
  ]));
  resetPeopleCache();
});
afterEach(cleanup);

// ── the route guard ─────────────────────────────────────────────────────

describe("access", () => {
  it.each(["platform_administrator", "support_operator", null])("shows no access to platform role %s", (role) => {
    current.user = { id: 1, role: "super_admin", platform_role: role };
    renderAt("/super-admin/tax/inbox");
    expect(screen.getByRole("alert")).toHaveTextContent("No access to the Tax Control Center");
    expect(svc.listApprovalsInbox).not.toHaveBeenCalled();
  });

  it("lets tax reviewers in", async () => {
    current.user = { id: 2, role: "super_admin", platform_role: "tax_reviewer" };
    renderAt("/super-admin/tax/inbox");
    expect(await screen.findByRole("heading", { name: "Approvals inbox" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Tax Control Center sections" })).toBeInTheDocument();
  });
});

// ── P8 approvals inbox: maker-checker, step-up, pagination ──────────────

describe("approvals inbox", () => {
  it("disables approve with the backend's reason as text", async () => {
    svc.listApprovalsInbox.mockImplementation(() => page([inboxItem({
      can_approve: false, reason_if_not: "You prepared or submitted this change; a different person must approve it.",
    })]));
    renderAt("/super-admin/tax/inbox");
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    expect(screen.getByText(/a different person must approve it/)).toBeInTheDocument();
    expect(approve).toHaveAttribute("aria-describedby");
  });

  it("prompts for step-up and retries the approval once with the code", async () => {
    svc.listApprovalsInbox.mockImplementation(() => page([inboxItem()]));
    svc.approveInboxItem.mockRejectedValueOnce(STEP_UP).mockResolvedValueOnce({ id: 31, status: "APPROVED" });
    renderAt("/super-admin/tax/inbox");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Authenticator code/), { target: { value: "123456" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(svc.approveInboxItem).toHaveBeenCalledTimes(2));
    expect(svc.approveInboxItem.mock.calls[0]).toEqual(["staged_rate", 31, {}]);
    expect(svc.approveInboxItem.mock.calls[1]).toEqual(["staged_rate", 31, { code: "123456" }]);
    expect(await screen.findByRole("status")).toHaveTextContent("Approved");
    expect(svc.listApprovalsInbox).toHaveBeenCalledTimes(2);                // reloaded
  });

  it("shows a wrong code in the prompt without another automatic retry", async () => {
    svc.listApprovalsInbox.mockImplementation(() => page([inboxItem()]));
    svc.approveInboxItem.mockRejectedValueOnce(STEP_UP).mockRejectedValueOnce(new Error("Invalid MFA code."));
    renderAt("/super-admin/tax/inbox");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Authenticator code/), { target: { value: "000000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByText("Invalid MFA code.")).toBeInTheDocument();
    expect(svc.approveInboxItem).toHaveBeenCalledTimes(2);
  });

  it("cancelling step-up approves nothing", async () => {
    svc.listApprovalsInbox.mockImplementation(() => page([inboxItem()]));
    svc.approveInboxItem.mockRejectedValueOnce(STEP_UP);
    renderAt("/super-admin/tax/inbox");
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(svc.approveInboxItem).toHaveBeenCalledTimes(1);
  });

  it("follows next_cursor with Load more", async () => {
    svc.listApprovalsInbox
      .mockImplementationOnce(() => page([inboxItem({ id: 1, title: "First" })], "c1"))
      .mockImplementationOnce(() => page([inboxItem({ id: 2, title: "Second" })], null));
    renderAt("/super-admin/tax/inbox");
    expect(await screen.findByText("First")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Second")).toBeInTheDocument();
    expect(svc.listApprovalsInbox.mock.calls[1][0]).toMatchObject({ cursor: "c1" });
    expect(screen.getByText("First")).toBeInTheDocument();                  // appended, not replaced
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument());
  });

  it("has no axe violations", async () => {
    svc.listApprovalsInbox.mockImplementation(() => page([inboxItem(), inboxItem({ id: 32, can_approve: false, reason_if_not: "Your role cannot approve tax registry changes (TAX_PUBLISHER only)." })]));
    const { container } = renderAt("/super-admin/tax/inbox");
    await screen.findAllByRole("button", { name: "Approve" });
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ── P2 source register ──────────────────────────────────────────────────

describe("source register", () => {
  const source = { id: 4, authority_id: 1, authority: "HM Revenue & Customs", handoff_ref: "S11", title: "VAT rates",
                   source_tier: "OFFICIAL_GUIDANCE", acquisition_method: "OFFICIAL_PUBLICATION",
                   permanent_url: "https://www.gov.uk/vat-rates", citation: "HMRC", language: "en",
                   evidence_status: "NOT_CAPTURED", redistribution_permission: "UNKNOWN", sha256: null,
                   created_at: "2026-11-05T09:00:00Z" };

  it("registers a source and captures its evidence", async () => {
    current.user = { id: 2, role: "super_admin", platform_role: "tax_reviewer" };
    svc.listSourceRevisions.mockImplementation(() => page([source]));
    svc.registerSourceRevision.mockResolvedValue({ ...source, id: 5 });
    svc.attachSourceEvidence.mockResolvedValue({ ...source, evidence_status: "CAPTURED", sha256: "ab".repeat(32) });
    renderAt("/super-admin/tax/sources");
    expect(await screen.findByText("Evidence not captured")).toBeInTheDocument();     // icon + text badge

    fireEvent.click(screen.getByRole("button", { name: "Register source" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "GB-HMRC — HM Revenue & Customs" })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText(/^Authority/), { target: { value: "1" } });
    fireEvent.change(within(dialog).getByLabelText(/^Title/), { target: { value: "VAT Act 1994" } });
    fireEvent.change(within(dialog).getByLabelText(/^Citation/), { target: { value: "VATA 1994 s.2" } });
    fireEvent.change(within(dialog).getByLabelText(/Permanent URL/), { target: { value: "https://www.legislation.gov.uk/ukpga/1994/23" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Register" }));
    await waitFor(() => expect(svc.registerSourceRevision).toHaveBeenCalled());
    expect(svc.registerSourceRevision.mock.calls[0][0]).toMatchObject({ authority_id: 1, title: "VAT Act 1994" });

    fireEvent.click(await screen.findByRole("button", { name: "Open VAT rates" }));
    const detail = await screen.findByRole("dialog");
    const file = new File(["%PDF-1.7"], "vat.pdf", { type: "application/pdf" });
    fireEvent.change(within(detail).getByLabelText(/Evidence file/), { target: { files: [file] } });
    fireEvent.click(within(detail).getByRole("button", { name: "Capture evidence" }));
    await waitFor(() => expect(svc.attachSourceEvidence).toHaveBeenCalledWith(4, file, "PERMITTED"));
    expect(await within(detail).findByText("ab".repeat(32))).toBeInTheDocument();     // server SHA-256 shown
  });

  it("hides registration from a publisher", async () => {
    renderAt("/super-admin/tax/sources");
    await screen.findByRole("heading", { name: "Source register" });
    expect(screen.queryByRole("button", { name: "Register source" })).not.toBeInTheDocument();
  });
});

// ── P3 rates: side by side, maker-checker on publish ────────────────────

describe("rates and change review", () => {
  const staged = { id: 31, origin: "MANUAL", component_id: 1, tax_code: "standard", product_scope: "GENERAL",
                   rate_kind: "STANDARD", rate_percent: "21", valid_from: "2026-12-01", valid_to: null,
                   observed_at: "2026-11-05T09:00:00Z", status: "IN_APPROVAL", created_by_user_id: 9,
                   created_at: "2026-11-05T09:00:00Z" };
  const current = { id: 3, rate_percent: "20", rate_kind: "STANDARD", valid_from: "2011-01-04", valid_to: null,
                    status: "ACTIVE", source: { authority: "HMRC", citation: "VATA 1994 s.2" } };
  const comparison = (over = {}) => ({
    staged, component: { code: "GB-VAT", tax_type: "VAT", jurisdiction_code: "GB", jurisdiction_name: "United Kingdom" },
    superseded: current, overlapping_active: [], active_for_key: [current], errors: [],
    conflicts: ["Conflicts with staged proposal 32 (22%) for the same key and period."], warnings: [], ...over,
  });

  it("shows the current and proposed rates side by side with conflicts", async () => {
    svc.listStagedRates.mockImplementation(() => page([staged]));
    svc.getStagedRateComparison.mockResolvedValue(comparison());
    svc.listApprovalsInbox.mockImplementation(() => page([inboxItem({ id: 31 })]));
    renderAt("/super-admin/tax/rates");
    fireEvent.click(await screen.findByRole("button", { name: "Open #31" }));
    const dialog = await screen.findByRole("dialog");
    const pair = within(dialog).getByLabelText("Old and new side by side");
    expect(await within(pair).findByText("20%")).toBeInTheDocument();
    expect(within(pair).getByText("21%")).toBeInTheDocument();
    expect(within(dialog).getByText(/Conflicts with staged proposal 32/)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Approve" })).toBeEnabled());
  });

  it("disables approve when the backend says the user can't approve it", async () => {
    svc.listStagedRates.mockImplementation(() => page([staged]));
    svc.getStagedRateComparison.mockResolvedValue(comparison());
    svc.listApprovalsInbox.mockImplementation(() => page([inboxItem({ id: 31, can_approve: false,
      reason_if_not: "You prepared or submitted this change; a different person must approve it." })]));
    renderAt("/super-admin/tax/rates");
    fireEvent.click(await screen.findByRole("button", { name: "Open #31" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(/Approve unavailable/)).toBeInTheDocument());
    expect(within(dialog).getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("disables publish for the maker and publishes with step-up otherwise", async () => {
    const approved = { ...staged, status: "APPROVED", created_by_user_id: 7 };
    svc.listStagedRates.mockImplementation(() => page([approved]));
    svc.getStagedRateComparison.mockResolvedValue(comparison({ staged: approved }));
    renderAt("/super-admin/tax/rates");
    fireEvent.click(await screen.findByRole("button", { name: "Open #31" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("button", { name: "Publish" })).toBeDisabled();
    expect(within(dialog).getByText(/a different person must approve it/)).toBeInTheDocument();
    expect(svc.stagedRateAction).not.toHaveBeenCalled();
  });
});

// ── P6 market availability: gates and the G1 rule ───────────────────────

describe("market availability", () => {
  it("knows the G1 rule: gate 05 is required for provider markets only", () => {
    expect(mandatoryGates("PROVIDER_APPROVED")).toContain("PROVIDER_CONTRACTS_AND_RECOVERY");
    expect(mandatoryGates("NATIVE_RULEPACK_APPROVED")).not.toContain("PROVIDER_CONTRACTS_AND_RECOVERY");
    const naGate05 = { PROVIDER_CONTRACTS_AND_RECOVERY: { status: "NOT_APPLICABLE", notes: "native" } };
    expect(gateProblems("PROVIDER_APPROVED", naGate05).PROVIDER_CONTRACTS_AND_RECOVERY[0]).toMatch(/can't be marked not applicable/);
    expect(gateProblems("NATIVE_RULEPACK_APPROVED", naGate05).PROVIDER_CONTRACTS_AND_RECOVERY).toEqual([]);
    expect(gateProblems("REFERENCE_ONLY", {}).LEGAL_AUTHORITY_AND_USAGE_RIGHTS).toEqual([]);
    expect(gateProblems("NATIVE_RULEPACK_APPROVED", { GOLDEN_TESTS_SIGNED_OFF: { status: "PASSED" } })
      .GOLDEN_TESTS_SIGNED_OFF).toContain("Passed needs an evidence reference.");
  });

  it("drafts a market with gate entries, showing the provider rule as the mode changes", async () => {
    current.user = { id: 2, role: "super_admin", platform_role: "tax_reviewer" };
    svc.draftAvailability.mockResolvedValue({ id: 9, status: "PENDING_REVIEW" });
    renderAt("/super-admin/tax/availability");
    fireEvent.click(await screen.findByRole("button", { name: "Draft availability" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "GB — United Kingdom" })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText(/^Jurisdiction/), { target: { value: "1" } });
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "VAT — Value added tax" })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText(/^Tax type/), { target: { value: "2" } });
    fireEvent.change(within(dialog).getByLabelText(/^Mode/), { target: { value: "PROVIDER_APPROVED" } });
    expect(within(dialog).getByText(/gate 05 can't be waived/)).toBeInTheDocument();
    expect(within(dialog).getByText(/05 · Provider contract, SLA, failure and recovery \(required\)/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(svc.draftAvailability).toHaveBeenCalled());
    const body = svc.draftAvailability.mock.calls[0][0];
    expect(body).toMatchObject({ jurisdiction_id: 1, tax_type_id: 2, mode: "PROVIDER_APPROVED" });
    expect(Object.keys(body.gates)).toHaveLength(7);
  });

  it("shows gates with icon and text in the detail", async () => {
    svc.listMarketAvailability.mockImplementation(() => page([{
      id: 9, jurisdiction_code: "CA", tax_type: "GST", transaction_class: "B2B_SERVICES", mode: "PROVIDER_APPROVED",
      status: "PENDING_REVIEW", gates: { LEGAL_AUTHORITY_AND_USAGE_RIGHTS: { status: "PASSED", evidence_ref: "EV-1" } },
      created_at: "2026-11-05T09:00:00Z",
    }]));
    renderAt("/super-admin/tax/availability");
    fireEvent.click(await screen.findByRole("button", { name: "Open #9" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/gate 05 must be PASSED with evidence \(rule G1\)/)).toBeInTheDocument();
    expect(within(dialog).getAllByText("Passed").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Not started").length).toBe(6);
  });
});

// ── P7 rule packs: catalogue, checklist, approve with step-up ───────────

describe("rule packs", () => {
  const pack = { id: 12, code: "GB-VAT-DOMESTIC-SERVICES", version: "1", status: "IN_APPROVAL",
                 markets: [{ jurisdiction_code: "GB", tax_type: "VAT" }], rounding_rule: "PER_LINE", rounding_mode: "HALF_UP",
                 required_facts: [], source_dependencies: [], golden_test_report: { suite: "packs", commit: "abc1234", passed: 12, failed: 0 },
                 maker_user_id: 9, created_at: "2026-11-05T09:00:00Z", submitted_at: "2026-11-05T10:00:00Z" };

  it("registers a pack from the catalogue", async () => {
    current.user = { id: 2, role: "super_admin", platform_role: "tax_reviewer" };
    svc.getRulePackCatalogue.mockResolvedValue({ items: [{ code: "AU-GST-DOMESTIC-SERVICES", version: "1",
      markets: [{ jurisdiction_code: "AU", tax_type: "GST" }], rounding_rule: "PER_DOCUMENT", rounding_mode: "HALF_UP",
      source_dependencies: [{ handoff_ref: "S16", title: null, approved: false, reason: "not in the source register" }] }] });
    svc.registerRulePack.mockResolvedValue({ ...pack, id: 13, code: "AU-GST-DOMESTIC-SERVICES", status: "PENDING_REVIEW" });
    renderAt("/super-admin/tax/rule-packs");
    expect((await screen.findAllByText(/not in the source register/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Register draft" }));
    await waitFor(() => expect(svc.registerRulePack).toHaveBeenCalledWith({ code: "AU-GST-DOMESTIC-SERVICES" }));
    expect(await screen.findByText(/Source S16 approved/)).toBeInTheDocument();     // checklist beside the pack
  });

  it("shows the sign-off checklist and approves with step-up", async () => {
    svc.listRulePacks.mockImplementation(() => page([pack]));
    svc.listApprovalsInbox.mockImplementation(() => page([inboxItem({ kind: "rule_pack", id: 12 })]));
    svc.rulePackAction.mockRejectedValueOnce(STEP_UP).mockResolvedValueOnce({ ...pack, status: "APPROVED" });
    renderAt("/super-admin/tax/rule-packs");
    fireEvent.click(await screen.findByRole("button", { name: "Open #12" }));
    const dialog = await screen.findByRole("dialog", { name: "Rule pack #12" });
    expect(within(dialog).getByText(/Tax lead sign-off checklist/)).toBeInTheDocument();
    expect(within(dialog).getByText(/T05 \(£100 net → £20 VAT → £120 gross/)).toBeInTheDocument();
    const approve = within(dialog).getByRole("button", { name: "Approve" });
    await waitFor(() => expect(approve).toBeEnabled());
    fireEvent.click(approve);
    const stepUp = await screen.findByRole("dialog", { name: "Confirm with MFA" });
    fireEvent.click(within(stepUp).getByRole("button", { name: "Use a recovery code instead" }));
    fireEvent.change(await within(stepUp).findByLabelText(/Recovery code/, {}, { timeout: 5000 }), { target: { value: "abcd-efgh" } });
    fireEvent.click(within(stepUp).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(svc.rulePackAction).toHaveBeenCalledTimes(2));
    expect(svc.rulePackAction.mock.calls[1]).toEqual([12, "approve", { recovery_code: "abcd-efgh" }]);
    expect(await within(dialog).findByText("Approved")).toBeInTheDocument();
  });

  // Phase 8 PR 1: code hash and integrity
  const active = { ...pack, status: "ACTIVE", code_hash: "a".repeat(64) };

  it("shows a matching code hash without a warning", async () => {
    svc.listRulePacks.mockImplementation(() => page([{ ...active, running_code_hash: "a".repeat(64), integrity: "MATCH" }]));
    const { container } = renderAt("/super-admin/tax/rule-packs");
    expect(await screen.findByText("Code matches approved hash")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open #12" }));
    const dialog = await screen.findByRole("dialog", { name: "Rule pack #12" });
    expect(within(dialog).getAllByText("a".repeat(64))).toHaveLength(2);
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("warns that quotes are refused when the running code differs", async () => {
    svc.listRulePacks.mockImplementation(() => page([{ ...active, running_code_hash: "b".repeat(64), integrity: "MISMATCH" }]));
    renderAt("/super-admin/tax/rule-packs");
    expect(await screen.findByText("Code differs from approved hash")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open #12" }));
    const dialog = await screen.findByRole("dialog", { name: "Rule pack #12" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/RULE_PACK_INTEGRITY_FAILED.*differs from the approved code hash/);
  });

  it("warns when the approved version's code is not running", async () => {
    svc.listRulePacks.mockImplementation(() => page([{ ...active, running_code_hash: null, integrity: "CODE_MISSING" }]));
    renderAt("/super-admin/tax/rule-packs");
    fireEvent.click(await screen.findByRole("button", { name: "Open #12" }));
    const dialog = await screen.findByRole("dialog", { name: "Rule pack #12" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(/approved version's code is not running/);
    expect(within(dialog).getByText("Not running")).toBeInTheDocument();
  });
});


// ── Phase 5b PR 1: names, not ids; pickers, not numeric ids ─────────────

describe("names and pickers (G-5a-1, G-5a-3)", () => {
  it("shows the submitter's name and role in the inbox, not a user id", async () => {
    svc.listApprovalsInbox.mockImplementation(() => page([inboxItem({ submitted_by: 9 })]));
    renderAt("/super-admin/tax/inbox");
    expect(await screen.findByText(/submitted by Mara Maker \(Tax Reviewer\)/)).toBeInTheDocument();
    expect(screen.queryByText(/user #9/)).not.toBeInTheDocument();
  });

  it("falls back to the id for someone who isn't tax staff", async () => {
    svc.listApprovalsInbox.mockImplementation(() => page([inboxItem({ submitted_by: 42 })]));
    renderAt("/super-admin/tax/inbox");
    expect(await screen.findByText(/submitted by user #42/)).toBeInTheDocument();
  });

  it("shows names in a version's history", async () => {
    svc.listMarketAvailability.mockImplementation(() => page([{
      id: 9, jurisdiction_code: "GB", tax_type: "VAT", transaction_class: "B2B_SERVICES", mode: "REFERENCE_ONLY",
      status: "IN_APPROVAL", gates: {}, created_at: "2026-11-05T09:00:00Z", created_by_user_id: 9, maker_user_id: 9,
      submitted_at: "2026-11-05T10:00:00Z",
    }]));
    renderAt("/super-admin/tax/availability");
    fireEvent.click(await screen.findByRole("button", { name: "Open #9" }));
    const history = await screen.findByRole("list", { name: "Version history" });
    await waitFor(() => expect(within(history).getAllByText(/Mara Maker \(Tax Reviewer\)/).length).toBe(2));
  });

  it("stages a rate by picking a component and a legal source", async () => {
    current.user = { id: 2, role: "super_admin", platform_role: "tax_reviewer" };
    svc.listSourceRevisions.mockImplementation(() => page([{ id: 4, handoff_ref: "S11", title: "VAT rates",
      evidence_status: "CAPTURED", source_tier: "OFFICIAL_GUIDANCE", redistribution_permission: "PERMITTED" }]));
    svc.stageRate.mockResolvedValue({ id: 50, status: "PENDING_REVIEW" });
    renderAt("/super-admin/tax/rates");
    fireEvent.click(await screen.findByRole("button", { name: "Stage rate" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "GB-VAT — UK VAT (GB VAT)" })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText(/^Component/), { target: { value: "1" } });
    fireEvent.change(within(dialog).getByLabelText(/^Tax code/), { target: { value: "standard" } });
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "#4 S11 · VAT rates" })).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText(/^Legal source/), { target: { value: "4" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stage rate" }));
    await waitFor(() => expect(svc.stageRate).toHaveBeenCalled());
    expect(svc.stageRate.mock.calls[0][0]).toMatchObject({ component_id: 1, source_revision_id: 4, tax_code: "standard" });
  });
});

// ── Phase 5c: audit-evidence bundles (gate 06) ──────────────────────────

describe("audit-evidence export", () => {
  afterEach(() => { delete URL.createObjectURL; delete URL.revokeObjectURL; });

  it("downloads the sealed JSON bundle and the printable summary from a detail view", async () => {
    URL.createObjectURL = vi.fn(() => "blob:bundle");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    svc.listMarketAvailability.mockImplementation(() => page([{
      id: 9, jurisdiction_code: "GB", tax_type: "VAT", transaction_class: "B2B_SERVICES", mode: "REFERENCE_ONLY",
      status: "PUBLISHED", gates: {}, created_at: "2026-11-05T09:00:00Z",
    }]));
    svc.getEvidenceBundle.mockImplementation((kind, id, format) => Promise.resolve(
      format === "json" ? { kind, record: { id }, bundle_sha256: "cd".repeat(32) } : "<html>summary</html>"));
    renderAt("/super-admin/tax/availability");
    fireEvent.click(await screen.findByRole("button", { name: "Open #9" }));
    const detail = await screen.findByRole("dialog");
    const group = within(detail).getByRole("group", { name: "Audit evidence for this market availability" });
    fireEvent.click(within(group).getByRole("button", { name: "Export evidence (JSON)" }));
    expect(await within(group).findByText("cd".repeat(32))).toBeInTheDocument();
    expect(svc.getEvidenceBundle).toHaveBeenCalledWith("market_availability", 9, "json");
    fireEvent.click(within(group).getByRole("button", { name: "Printable summary" }));
    await waitFor(() => expect(svc.getEvidenceBundle).toHaveBeenCalledWith("market_availability", 9, "html"));
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(2));
    expect(click).toHaveBeenCalledTimes(2);
    click.mockRestore();
  });

  it("shows the backend's refusal as text", async () => {
    svc.listSourceRevisions.mockImplementation(() => page([{ id: 4, handoff_ref: "S11", title: "VAT rates",
      evidence_status: "CAPTURED", source_tier: "OFFICIAL_GUIDANCE", redistribution_permission: "PERMITTED",
      created_at: "2026-11-05T09:00:00Z" }]));
    svc.getEvidenceBundle.mockRejectedValue(Object.assign(new Error("You don't have access to this."), { status: 403 }));
    renderAt("/super-admin/tax/sources");
    fireEvent.click(await screen.findByRole("button", { name: "Open VAT rates" }));
    const detail = await screen.findByRole("dialog");
    fireEvent.click(within(detail).getByRole("button", { name: "Export evidence (JSON)" }));
    expect(await within(detail).findByText("You don't have access to this.")).toBeInTheDocument();
    expect(svc.getEvidenceBundle).toHaveBeenCalledWith("source_revision", 4, "json");
  });
});

// ── Phase 7 PR 2: historical regression on the rate detail ──────────────

describe("historical regression", () => {
  const rate = { id: 31, status: "IN_APPROVAL", component_code: "GB-VAT", tax_code: "standard", rate_percent: "21",
    valid_from: "2026-01-01", created_at: "2026-11-05T09:00:00Z", maker_user_id: 9 };

  it("says approval needs a current report, runs it and lists what changed", async () => {
    current.user = { id: 2, role: "super_admin", platform_role: "tax_reviewer" };
    svc.listStagedRates.mockImplementation(() => page([rate]));
    svc.getStagedRateComparison.mockResolvedValue({ staged: rate, superseded: null, overlapping_active: [], conflicts: [],
      active_for_key: [], component: { code: "GB-VAT" } });
    svc.getRegression
      .mockResolvedValueOnce({ report: null, current_problem: "no regression report has been run" })
      .mockResolvedValue({ current_problem: null, report: { id: 4, cases: 6, fixture_sets: ["uk_au_v1"], unchanged: 4,
        new_cases: [], generated_at: "2026-11-07T09:00:00Z",
        changed: [{ case: "GB-B2B-ONE-LINE", before: { tax: "20.00", lines: [{ rate: "20" }] },
                    after: { tax: "21.00", lines: [{ rate: "21" }] } }] } });
    svc.runRegression.mockResolvedValue({ id: 4 });
    renderAt("/super-admin/tax/rates");
    fireEvent.click(await screen.findByRole("button", { name: /Open/ }));
    const panel = await screen.findByRole("group", { name: "Regression report" });
    expect(await within(panel).findByText("Regression report needed")).toBeInTheDocument();
    expect(within(panel).getByText(/Approval is refused until it is current: no regression report has been run/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Run regression" }));
    await waitFor(() => expect(svc.runRegression).toHaveBeenCalledWith("rate", 31));
    expect(await within(panel).findByText("Regression report current")).toBeInTheDocument();
    expect(within(panel).getByText("GB-B2B-ONE-LINE")).toBeInTheDocument();
    expect(within(panel).getByText(/tax 20.00 → 21.00 \(rate 20% → 21%\)/)).toBeInTheDocument();
  });

  it("a publisher sees the report but can't run it", async () => {
    svc.listStagedRates.mockImplementation(() => page([rate]));
    svc.getStagedRateComparison.mockResolvedValue({ staged: rate, superseded: null, overlapping_active: [], conflicts: [],
      active_for_key: [], component: { code: "GB-VAT" } });
    renderAt("/super-admin/tax/rates");
    fireEvent.click(await screen.findByRole("button", { name: /Open/ }));
    const panel = await screen.findByRole("group", { name: "Regression report" });
    expect(await within(panel).findByText("Regression report needed")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /Run regression/ })).not.toBeInTheDocument();
  });
});


// ── Phase 8 PR 2: scheduled activation ──────────────────────────────────

describe("scheduled activation", () => {
  const base = { id: 21, code: "GB-VAT-DOMESTIC-SERVICES", version: "2", markets: [{ jurisdiction_code: "GB", tax_type: "VAT" }],
                 rounding_rule: "PER_LINE", rounding_mode: "HALF_UP", required_facts: [], source_dependencies: [],
                 golden_test_report: { suite: "packs", commit: "abc1234", passed: 12, failed: 0 }, maker_user_id: 9,
                 valid_from: "2031-01-01", valid_to: null, default_timezone: "Europe/London", pending_cancellation: null,
                 created_at: "2026-11-05T09:00:00Z" };

  it("previews local time as UTC across DST", () => {
    expect(previewUtc("2030-06-01T09:00", "Europe/London")).toBe("2030-06-01 08:00 UTC");
    expect(previewUtc("2030-01-01T00:00", "Australia/Sydney")).toBe("2029-12-31 13:00 UTC");
    expect(previewUtc("", "Europe/London")).toBeNull();
  });

  it("schedules a rule pack at local time in the jurisdiction's zone", async () => {
    svc.listRulePacks.mockImplementation(() => page([{ ...base, status: "APPROVED" }]));
    svc.rulePackAction.mockResolvedValue({ ...base, status: "SCHEDULED", activate_at: "2030-06-01T08:00:00Z",
      activate_at_local: "2030-06-01T09:00", activate_tz: "Europe/London" });
    const { container } = renderAt("/super-admin/tax/rule-packs");
    expect(await screen.findByText("2031-01-01 → open-ended")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open #21" }));
    const detail = await screen.findByRole("dialog", { name: "Rule pack #21" });
    fireEvent.click(within(detail).getByRole("button", { name: "Publish" }));
    const modal = await screen.findByRole("dialog", { name: "Publish this rule pack" });
    fireEvent.click(within(modal).getByLabelText("Schedule at a local date and time"));
    fireEvent.change(within(modal).getByLabelText(/Local date and time/), { target: { value: "2030-06-01T09:00" } });
    expect(within(modal).getByLabelText(/Time zone/)).toHaveValue("Europe/London");
    expect(within(modal).getByText("2030-06-01 08:00 UTC")).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(within(modal).getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(svc.rulePackAction).toHaveBeenCalledWith(21, "publish",
      { activate_at_local: "2030-06-01T09:00", timezone: "Europe/London" }));
    expect(await within(detail).findByText(/Activates 2030-06-01T09:00 \(Europe\/London\)/)).toBeInTheDocument();
  });

  it("publishes now with an empty schedule", async () => {
    svc.listRulePacks.mockImplementation(() => page([{ ...base, status: "APPROVED" }]));
    svc.rulePackAction.mockResolvedValue({ ...base, status: "ACTIVE" });
    renderAt("/super-admin/tax/rule-packs");
    fireEvent.click(await screen.findByRole("button", { name: "Open #21" }));
    const detail = await screen.findByRole("dialog", { name: "Rule pack #21" });
    fireEvent.click(within(detail).getByRole("button", { name: "Publish" }));
    const modal = await screen.findByRole("dialog", { name: "Publish this rule pack" });
    fireEvent.click(within(modal).getByRole("button", { name: "Publish now" }));
    await waitFor(() => expect(svc.rulePackAction).toHaveBeenCalledWith(21, "publish", {}));
  });

  it("shows a failed activation check and lets a publisher propose a cancellation", async () => {
    const scheduled = { ...base, status: "SCHEDULED", activate_at: "2030-06-01T08:00:00Z", activate_at_local: "2030-06-01T09:00",
                        activate_tz: "Europe/London", activation_error: "The pack's code changed since this version was registered" };
    svc.listRulePacks.mockImplementation(() => page([scheduled]));
    svc.cancelScheduledActivation.mockResolvedValue({ id: 4, status: "PROPOSED", proposed_by: 7, reason: "law postponed" });
    renderAt("/super-admin/tax/rule-packs");
    fireEvent.click(await screen.findByRole("button", { name: "Open #21" }));
    const detail = await screen.findByRole("dialog", { name: "Rule pack #21" });
    expect(within(detail).getByRole("alert")).toHaveTextContent(/activation checks failed.*code changed/);
    fireEvent.click(within(detail).getByRole("button", { name: "Cancel scheduled activation" }));
    const ask = await screen.findByRole("dialog", { name: "Propose cancelling this activation" });
    fireEvent.change(within(ask).getByLabelText(/Reason/), { target: { value: "law postponed" } });
    fireEvent.click(within(ask).getByRole("button", { name: "Propose" }));
    await waitFor(() => expect(svc.cancelScheduledActivation).toHaveBeenCalledWith("rule_pack", 21, "law postponed"));
    expect(await within(detail).findByText(/Cancellation proposed/)).toBeInTheDocument();
    expect(within(detail).getByText(/A different TAX_PUBLISHER must decide it/)).toBeInTheDocument();   // not the proposer
  });

  it("a different publisher approves the cancellation with step-up", async () => {
    svc.listRulePacks.mockImplementation(() => page([{ ...base, status: "SCHEDULED", activate_at: "2030-06-01T08:00:00Z",
      activate_at_local: "2030-06-01T09:00", activate_tz: "Europe/London",
      pending_cancellation: { id: 4, status: "PROPOSED", proposed_by: 9, reason: "law postponed" } }]));
    svc.decideActivationCancellation.mockRejectedValueOnce(STEP_UP)
      .mockResolvedValueOnce({ id: 4, status: "APPROVED", decided_by: 7 });
    renderAt("/super-admin/tax/rule-packs");
    fireEvent.click(await screen.findByRole("button", { name: "Open #21" }));
    const detail = await screen.findByRole("dialog", { name: "Rule pack #21" });
    expect(await within(detail).findByText(/by Mara Maker.*: law postponed/)).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "Approve cancellation" }));
    const stepUp = await screen.findByRole("dialog", { name: "Confirm with MFA" });
    fireEvent.click(within(stepUp).getByRole("button", { name: "Use a recovery code instead" }));
    fireEvent.change(await within(stepUp).findByLabelText(/Recovery code/, {}, { timeout: 5000 }), { target: { value: "abcd-efgh" } });
    fireEvent.click(within(stepUp).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(svc.decideActivationCancellation).toHaveBeenLastCalledWith(4, true, { recovery_code: "abcd-efgh" }));
    expect(await within(detail).findByText("Approved")).toBeInTheDocument();
  });

  it("schedules a market availability version", async () => {
    const version = { id: 5, jurisdiction_code: "GB", tax_type: "VAT", transaction_class: "B2C_SERVICES", mode: "SUSPENDED",
                      status: "APPROVED", gates: {}, maker_user_id: 9, default_timezone: "Europe/London",
                      pending_cancellation: null, created_at: "2026-11-05T09:00:00Z" };
    svc.listMarketAvailability.mockImplementation(() => page([version]));
    svc.availabilityAction.mockResolvedValue({ ...version, status: "SCHEDULED" });
    renderAt("/super-admin/tax/availability");
    fireEvent.click(await screen.findByRole("button", { name: "Open #5" }));
    const detail = await screen.findByRole("dialog");
    fireEvent.click(within(detail).getByRole("button", { name: "Publish" }));
    const modal = await screen.findByRole("dialog", { name: "Publish this availability version" });
    fireEvent.click(within(modal).getByLabelText("Schedule at a local date and time"));
    fireEvent.change(within(modal).getByLabelText(/Local date and time/), { target: { value: "2030-10-27T01:30" } });
    fireEvent.change(within(modal).getByLabelText(/UTC offset/), { target: { value: "+00:00" } });
    fireEvent.click(within(modal).getByRole("button", { name: "Schedule" }));
    await waitFor(() => expect(svc.availabilityAction).toHaveBeenCalledWith(5, "publish",
      { activate_at_local: "2030-10-27T01:30", timezone: "Europe/London", utc_offset: "+00:00" }));
  });

  it("lists cancellation requests in the approvals inbox with their reason", async () => {
    svc.listApprovalsInbox.mockImplementation(() => page([inboxItem({ kind: "activation_cancel", id: 4,
      title: "Cancel the scheduled activation of rule pack GB-VAT-DOMESTIC-SERVICES v2 (2030-06-01T09:00 Europe/London)",
      reason: "law postponed" })]));
    svc.approveInboxItem.mockResolvedValue({ id: 4, status: "APPROVED" });
    renderAt("/super-admin/tax/inbox");
    expect(await screen.findByText("Reason: law postponed")).toBeInTheDocument();
    expect(screen.getByText(/Activation cancellations #4/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(svc.approveInboxItem).toHaveBeenCalledWith("activation_cancel", 4, {}));
    expect(await screen.findByText(/The version is back to Approved/)).toBeInTheDocument();
  });
});


// ── Phase 8 PR 3: emergency rollback ────────────────────────────────────

describe("emergency rollback", () => {
  const v = { id: 21, code: "GB-VAT-DOMESTIC-SERVICES", version: "2", status: "ACTIVE", markets: [{ jurisdiction_code: "GB", tax_type: "VAT" }],
              rounding_rule: "PER_LINE", rounding_mode: "HALF_UP", required_facts: [], source_dependencies: [],
              golden_test_report: { suite: "packs", commit: "abc1234", passed: 12, failed: 0 }, maker_user_id: 9,
              valid_from: "2031-01-01", valid_to: null, default_timezone: "Europe/London", pending_cancellation: null,
              rollback: null, integrity: "MATCH", created_at: "2026-11-05T09:00:00Z" };
  const proposed = { id: 4, kind: "rule_pack", version_id: 21, restore_to_id: 20, quarantine_only: false, severity: "SEV1",
                     reason: "charges 25% instead of 20%", status: "PROPOSED", proposed_by: 9, cancel_schedule: false,
                     regression: { cases: 6, changed: [{ case: "gb-1" }], errors: [] } };

  async function openPack(pack) {
    svc.listRulePacks.mockImplementation(() => page([pack]));
    const view = renderAt("/super-admin/tax/rule-packs");
    fireEvent.click(await screen.findByRole("button", { name: "Open #21" }));
    return { ...view, detail: await screen.findByRole("dialog", { name: "Rule pack #21" }) };
  }

  it("a publisher proposes a rollback to an earlier version whose code ships", async () => {
    svc.listRollbackCandidates.mockResolvedValue({ items: [
      { id: 20, version: "1", valid_from: null, valid_to: "2031-01-01", integrity: "MATCH", status: "ACTIVE" },
      { id: 19, version: "0", valid_from: null, valid_to: null, integrity: "CODE_MISSING", status: "SUPERSEDED" },
    ] });
    svc.proposeRollback.mockResolvedValue({ ...proposed, proposed_by: 7 });
    const { container, detail } = await openPack(v);
    fireEvent.click(within(detail).getByRole("button", { name: "Propose rollback" }));
    const modal = await screen.findByRole("dialog", { name: "Propose an emergency rollback" });
    await waitFor(() => expect(within(modal).getByRole("option", { name: /v1 \(#20/ })).toBeInTheDocument());
    expect(within(modal).queryByRole("option", { name: /v0/ })).not.toBeInTheDocument();
    expect(within(modal).getByText(/Can't be restored.*v0 \(CODE_MISSING\)/)).toBeInTheDocument();
    fireEvent.change(within(modal).getByLabelText("Restore to"), { target: { value: "20" } });
    fireEvent.change(within(modal).getByLabelText("Severity"), { target: { value: "SEV1" } });
    fireEvent.change(within(modal).getByLabelText(/^Reason/), { target: { value: "charges 25% instead of 20%" } });
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(within(modal).getByRole("button", { name: "Propose rollback" }));
    await waitFor(() => expect(svc.proposeRollback).toHaveBeenCalledWith({ kind: "rule_pack", version_id: 21,
      restore_to_id: 20, reason: "charges 25% instead of 20%", severity: "SEV1", cancel_schedule: false,
      timezone: "Europe/London" }));
    expect(await within(detail).findByText(/SEV1 rollback proposed/)).toBeInTheDocument();
    expect(within(detail).getByText("A different TAX_PUBLISHER must approve it.")).toBeInTheDocument();
  });

  it("a version a later one follows can only be quarantined", async () => {
    svc.listRollbackCandidates.mockResolvedValue({ items: [] });
    svc.proposeRollback.mockResolvedValue({ ...proposed, restore_to_id: null, quarantine_only: true, proposed_by: 7 });
    const { detail } = await openPack({ ...v, valid_to: "2032-01-01" });
    fireEvent.click(within(detail).getByRole("button", { name: "Propose rollback" }));
    const modal = await screen.findByRole("dialog", { name: "Propose an emergency rollback" });
    expect(within(modal).getByLabelText("Restore to")).toHaveValue("quarantine");
    expect(within(modal).queryByLabelText(/Time zone/)).not.toBeInTheDocument();
    fireEvent.change(within(modal).getByLabelText(/^Reason/), { target: { value: "bad rules in 2031" } });
    fireEvent.click(within(modal).getByRole("button", { name: "Propose rollback" }));
    await waitFor(() => expect(svc.proposeRollback).toHaveBeenCalledWith(expect.objectContaining({ restore_to_id: null })));
  });

  it("a different publisher approves with step-up and the version shows as rolled back", async () => {
    svc.decideRollback.mockRejectedValueOnce(STEP_UP).mockResolvedValueOnce({ ...proposed, status: "APPROVED",
      result: { range_from: "2031-01-01", range_to: "2031-03-01", rollback_version_id: 23, organizations_affected: 2 } });
    const { container, detail } = await openPack({ ...v, rollback: proposed });
    expect(await within(detail).findByText(/by Mara Maker.*: charges 25% instead of 20%/)).toBeInTheDocument();
    expect(within(detail).getByText(/Regression: 6 case\(s\), 1 changed/)).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "Approve rollback" }));
    const stepUp = await screen.findByRole("dialog", { name: "Confirm with MFA" });
    fireEvent.click(within(stepUp).getByRole("button", { name: "Use a recovery code instead" }));
    fireEvent.change(await within(stepUp).findByLabelText(/Recovery code/, {}, { timeout: 5000 }), { target: { value: "abcd-efgh" } });
    fireEvent.click(within(stepUp).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(svc.decideRollback).toHaveBeenLastCalledWith(4, "approve", { recovery_code: "abcd-efgh" }));
    expect(await within(detail).findByText(/Tax dates 2031-01-01 to 2031-03-01 fail/)).toBeInTheDocument();
    expect(within(detail).getByText(/Restored as version #23. 2 organization\(s\) affected/)).toBeInTheDocument();
    expect(within(detail).getAllByText("Rolled back").length).toBeGreaterThan(0);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("a reviewer can't propose; the rollback version says what it restores", async () => {
    current.user = { id: 9, role: "super_admin", platform_role: "tax_reviewer" };
    const { detail } = await openPack({ ...v, version: "1-rb4", restores_id: 20, rollback_of_id: 19 });
    expect(within(detail).queryByRole("button", { name: "Propose rollback" })).not.toBeInTheDocument();
    expect(within(detail).getByText(/proposed and approved by two TAX_PUBLISHERs/)).toBeInTheDocument();
    expect(within(detail).getByText("Restores #20 (emergency rollback of #19).")).toBeInTheDocument();
  });

  it("lists rollbacks in the approvals inbox", async () => {
    svc.listApprovalsInbox.mockImplementation(() => page([inboxItem({ kind: "rollback", id: 4,
      title: "SEV1 rollback of rule pack GB-VAT-DOMESTIC-SERVICES v2 (restore version 20)", reason: "wrong rate" })]));
    svc.approveInboxItem.mockResolvedValue({ id: 4, status: "APPROVED" });
    renderAt("/super-admin/tax/inbox");
    expect(await screen.findByText(/Emergency rollbacks #4/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(svc.approveInboxItem).toHaveBeenCalledWith("rollback", 4, {}));
    expect(await screen.findByText(/Applied: SEV1 rollback/)).toBeInTheDocument();
  });
});


// ── Phase 8 PR 4: retroactive analysis (aggregates only) ────────────────

describe("retroactive analysis", () => {
  const banded = { organizations_affected: 1, documents: 2, by_status: { COMPARED: 1, MANUAL_REVIEW_REQUIRED: 1 },
                   per_currency: { GBP: { net: "< 1k (over)", over: "< 1k", under: "< 1k", documents: 1 } },
                   amounts: "banded (fewer than 3 organizations)" };

  it("lists analyses with progress and banded aggregates, no tenant identifiers", async () => {
    svc.listRetroAnalyses.mockImplementation(() => page([
      { id: 3, trigger_kind: "rollback", trigger_id: 4, severity: "SEV1", status: "DONE",
        basis_label: "Comparison against restored logic, not a determination", range_from: "2031-01-01", range_to: "2031-03-01",
        progress: { organizations_done: 1, organizations_total: 1, documents_total: 2 }, aggregates: banded },
      { id: 4, trigger_kind: "rate", trigger_id: 9, status: "RUNNING", basis_label: "Comparison against the rate now in force for the tax date",
        range_from: "2011-01-04", range_to: "2026-11-10", progress: { organizations_done: 2, organizations_total: 5, documents_total: 40 },
        aggregates: null },
    ]));
    const { container } = renderAt("/super-admin/tax/retro");
    expect(await screen.findByText(/Analysis #3: Rollback #4 \(SEV1\)/)).toBeInTheDocument();
    expect(screen.getByText(/restored logic, not a determination/)).toBeInTheDocument();
    expect(screen.getByText(/net < 1k \(over\), over-collected < 1k/)).toBeInTheDocument();
    expect(screen.getByText(/Amounts banded \(fewer than 3 organizations\)/)).toBeInTheDocument();
    expect(screen.getByText(/Progress: 2 of 5 organization\(s\); 40 document\(s\)/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("a retroactive pack version shows the preview gate and runs a preview", async () => {
    const pack = { id: 12, code: "GB-VAT-DOMESTIC-SERVICES", version: "2", status: "APPROVED", markets: [], rounding_rule: "PER_LINE",
                   rounding_mode: "HALF_UP", required_facts: [], source_dependencies: [], golden_test_report: null, maker_user_id: 9,
                   valid_from: "2026-05-01", created_at: "2026-11-05T09:00:00Z" };
    svc.listRulePacks.mockImplementation(() => page([pack]));
    svc.getRetroPreview.mockResolvedValueOnce({ retroactive: true, preview: null, current_problem: "no retroactive analysis preview has been run" })
      .mockResolvedValue({ retroactive: true, current_problem: null, preview: { basis_label: "Comparison against the pack version now in force for the tax date",
        range_from: "2026-05-01", range_to: "2026-11-10", created_at: "2026-11-10T10:00:00Z", aggregates: banded } });
    svc.runRetroPreview.mockResolvedValue({ id: 7 });
    const { container } = renderAt("/super-admin/tax/rule-packs");
    fireEvent.click(await screen.findByRole("button", { name: "Open #12" }));
    const dialog = await screen.findByRole("dialog", { name: "Rule pack #12" });
    const panel = await within(dialog).findByRole("group", { name: "Retroactive analysis preview" });
    expect(within(panel).getByText("This version changes tax for past dates.")).toBeInTheDocument();
    expect(within(panel).getByText(/refused until it is current: no retroactive analysis preview/)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(within(panel).getByRole("button", { name: "Run preview" }));
    await waitFor(() => expect(svc.runRetroPreview).toHaveBeenCalledWith("rule_pack", 12));
    expect(await within(panel).findByText(/1 organization\(s\), 2 document\(s\)/)).toBeInTheDocument();
  });
});

