import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// B13 (/billing/workspace/zoiko-subscription): "no button to pay the
// subscription amount" + UI. A Pay action exists only when Zoiko has issued a
// payable invoice (payment itself is the platform-Stripe flow, ON HOLD). With
// no invoice there is nothing to pay, so no misleading Pay button is shown.

const m = vi.hoisted(() => ({ sub: vi.fn(), usage: vi.fn(), role: "billing_admin" }));
vi.mock("../../context/AuthContext", () => ({ useAuth: () => ({ user: { id: 1, role: m.role }, role: m.role }) }));
vi.mock("../../service/platformSelfServiceApi", () => ({
  platformSelfServiceApi: { getZoikoSubscription: (...a) => m.sub(...a), getWorkspaceUsage: (...a) => m.usage(...a), convertTrialToPaid: vi.fn() },
  getZoikoSubscriptionCached: (...a) => m.sub(...a),
  invalidateZoikoSubscriptionCache: vi.fn(),
}));

import WorkspaceZoikoSubscriptionPage from "./WorkspaceZoikoSubscriptionPage";

const ACTIVE = {
  account: { id: 1, status: "active" },
  subscription: { status: "active", plan_name: "Growth", currency: "INR", amount: "4999.00", billing_interval: "monthly" },
  invoices: [], payments: [], quotes: [],
};
const renderPage = () => render(<MemoryRouter><WorkspaceZoikoSubscriptionPage /></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); m.usage.mockResolvedValue({ metrics: [] }); });
afterEach(() => cleanup());

describe("B13 Zoiko Subscription", () => {
  it("loading state is announced to assistive technology", () => {
    m.sub.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByRole("status")).toHaveTextContent("Loading your Zoiko subscription");
  });

  for (const role of ["billing_admin", "org_admin"]) {
    it(`${role}: active subscription with no invoice shows honest empty states and no Pay button`, async () => {
      m.role = role;
      m.sub.mockResolvedValue(ACTIVE);
      renderPage();
      expect(await screen.findByText("No invoices yet")).toBeInTheDocument();
      expect(screen.getByText("No payments yet")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^pay\b/i })).toBeNull();
    });

    it(`${role}: a payable invoice gets a Pay action even while the subscription is active`, async () => {
      m.role = role;
      m.sub.mockResolvedValue({ ...ACTIVE, invoices: [{ id: 7, invoice_number: "PINV-000007", status: "issued", balance_due: "4999.00", currency: "INR", public_token: "tok" }] });
      renderPage();
      expect(await screen.findByRole("button", { name: /^pay .* now$/i })).toBeEnabled();
    });
  }
});
