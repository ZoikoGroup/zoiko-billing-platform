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
  ].map((k) => [k, vi.fn()])),
}));
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal()),
  getStoredUser: () => current.user,
}));
vi.mock("./taxRegistryService", () => Object.fromEntries(
  Object.keys(svc).map((k) => [k, (...args) => svc[k](...args)]),
));


import TaxControlCenterPage from "./TaxControlCenterPage";
import { gateProblems, mandatoryGates } from "./gates";

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
    fireEvent.change(within(dialog).getByLabelText(/Authority ID/), { target: { value: "1" } });
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
    fireEvent.change(within(dialog).getByLabelText(/Tax type ID/), { target: { value: "2" } });
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
    fireEvent.change(within(stepUp).getByLabelText(/Recovery code/), { target: { value: "abcd-efgh" } });
    fireEvent.click(within(stepUp).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(svc.rulePackAction).toHaveBeenCalledTimes(2));
    expect(svc.rulePackAction.mock.calls[1]).toEqual([12, "approve", { recovery_code: "abcd-efgh" }]);
    expect(await within(dialog).findByText("Approved")).toBeInTheDocument();
  });
});
