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
    "listTaxPeople", "listApprovalsInbox",
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
  svc.getPlatformDuplicates.mockResolvedValue({ organizations_affected: 2, invoices_affected: 5, duplicate_rows: 7,
    note: "Aggregate only." });
  resetPeopleCache();
});
afterEach(cleanup);

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
    const mfa = await screen.findByRole("dialog");
    fireEvent.change(within(mfa).getByLabelText(/Authenticator code/), { target: { value: "123456" } });
    fireEvent.click(within(mfa).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(svc.providerHealthAction).toHaveBeenCalledTimes(2));
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
