import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import PlanChangePanel from "./PlanChangePanel";
import { platformSelfServiceApi } from "../../service/platformSelfServiceApi";

vi.mock("../../service/platformSelfServiceApi", () => ({
  platformSelfServiceApi: {
    getAvailablePlans: vi.fn(),
    previewPlanChange: vi.fn(),
    commitPlanChange: vi.fn(),
    cancelPlanChange: vi.fn(),
    convertTrialToPaid: vi.fn(),
  },
  invalidateZoikoSubscriptionCache: vi.fn(),
}));

const PLANS = {
  plans: [
    { id: 1, plan_code: "essentials", plan_name: "Essentials", price_amount: "49.00", currency: "USD", billing_interval: "monthly", max_users: 5, is_current: false },
    { id: 2, plan_code: "professional", plan_name: "Professional", price_amount: "149.00", currency: "USD", billing_interval: "monthly", max_users: 25, is_current: true },
    { id: 3, plan_code: "business", plan_name: "Business", price_amount: "399.00", currency: "USD", billing_interval: "monthly", max_users: 100, is_current: false },
  ],
};
const SUB = { status: "active", plan_code: "professional", price_amount: "149.00", current_period_end: "2026-11-01T00:00:00Z" };

const UPGRADE_PREVIEW = {
  direction: "upgrade",
  blockers: [],
  warnings: [],
  price_impact: { current_price: "149.00", target_price: "399.00", currency: "USD", days_remaining_in_period: 15, estimated_period_delta: "125.00" },
};
const DOWNGRADE_PREVIEW = {
  direction: "downgrade",
  blockers: [],
  warnings: [],
  price_impact: { current_price: "149.00", target_price: "49.00", currency: "USD", days_remaining_in_period: 15, estimated_period_delta: "-50.00" },
};

const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  platformSelfServiceApi.getAvailablePlans.mockResolvedValue(PLANS);
  Object.defineProperty(window, "location", { configurable: true, value: { href: "http://localhost/" } });
});
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
});

const renderPanel = (props = {}) => {
  const navigate = vi.fn();
  const onChanged = vi.fn();
  render(<PlanChangePanel subscription={SUB} pendingChange={null} navigate={navigate} onChanged={onChanged} {...props} />);
  return { navigate, onChanged };
};

describe("PlanChangePanel", () => {
  it("offers upgrade and downgrade relative to the current plan", async () => {
    renderPanel();
    expect(await screen.findByRole("button", { name: "Upgrade to Business" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Downgrade to Essentials" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Downgrade to Professional/ })).toBeDisabled(); // current plan
  });

  it("upgrade shows the prorated charge and sends the user to Stripe Checkout", async () => {
    platformSelfServiceApi.previewPlanChange.mockResolvedValue(UPGRADE_PREVIEW);
    platformSelfServiceApi.commitPlanChange.mockResolvedValue({
      status: "payment_required", mode: "checkout", checkout_url: "https://checkout.stripe.test/c/1", public_token: "tok",
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to Business" }));
    expect(await screen.findByText(/Pay \$125\.00 today/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Pay & upgrade/ }));

    await waitFor(() => expect(window.location.href).toBe("https://checkout.stripe.test/c/1"));
    expect(platformSelfServiceApi.commitPlanChange).toHaveBeenCalledWith({ targetPlanId: 3, confirmImmediate: false });
  });

  describe("change-plan dialog", () => {
    const NO_CHARGE_UPGRADE = { ...UPGRADE_PREVIEW, price_impact: { ...UPGRADE_PREVIEW.price_impact, estimated_period_delta: "0.00" } };

    it("opens as 'Change to <plan>', previews, and Upgrade now commits then closes", async () => {
      platformSelfServiceApi.previewPlanChange.mockResolvedValue(NO_CHARGE_UPGRADE);
      platformSelfServiceApi.commitPlanChange.mockResolvedValue({ status: "applied" });
      const { onChanged } = renderPanel();

      fireEvent.click(await screen.findByRole("button", { name: "Upgrade to Business" }));
      const dialog = await screen.findByRole("dialog", { name: "Change to Business" });
      expect(platformSelfServiceApi.previewPlanChange).toHaveBeenCalledWith(3);

      fireEvent.click(await within(dialog).findByRole("button", { name: /Upgrade now/ }));
      await waitFor(() =>
        expect(platformSelfServiceApi.commitPlanChange).toHaveBeenCalledWith({ targetPlanId: 3, confirmImmediate: false })
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(onChanged).toHaveBeenCalled();
    });

    it("Not now closes without committing", async () => {
      platformSelfServiceApi.previewPlanChange.mockResolvedValue(DOWNGRADE_PREVIEW);
      renderPanel();

      fireEvent.click(await screen.findByRole("button", { name: "Downgrade to Essentials" }));
      const dialog = await screen.findByRole("dialog", { name: "Change to Essentials" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Not now" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(platformSelfServiceApi.commitPlanChange).not.toHaveBeenCalled();
    });

    it("Esc and the close button do not dismiss it while the change is submitting", async () => {
      let resolveCommit;
      platformSelfServiceApi.previewPlanChange.mockResolvedValue(NO_CHARGE_UPGRADE);
      platformSelfServiceApi.commitPlanChange.mockReturnValue(new Promise((r) => { resolveCommit = r; }));
      renderPanel();

      fireEvent.click(await screen.findByRole("button", { name: "Upgrade to Business" }));
      const dialog = await screen.findByRole("dialog", { name: "Change to Business" });
      fireEvent.click(await within(dialog).findByRole("button", { name: /Upgrade now/ }));
      await waitFor(() => expect(platformSelfServiceApi.commitPlanChange).toHaveBeenCalled());

      fireEvent.keyDown(document, { key: "Escape" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
      expect(screen.getByRole("dialog", { name: "Change to Business" })).toBeInTheDocument();

      resolveCommit({ status: "applied" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    });
  });

  it("upgrade falls back to the invoice page when Stripe checkout is unavailable", async () => {
    platformSelfServiceApi.previewPlanChange.mockResolvedValue(UPGRADE_PREVIEW);
    platformSelfServiceApi.commitPlanChange.mockResolvedValue({ status: "payment_required", mode: "invoice_due", public_token: "tok_inv" });
    const { navigate } = renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Upgrade to Business" }));
    fireEvent.click(await screen.findByRole("button", { name: /Pay & upgrade/ }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/platform-invoice/tok_inv"));
  });

  it("downgrade defaults to the next renewal and shows the confirmation", async () => {
    platformSelfServiceApi.previewPlanChange.mockResolvedValue(DOWNGRADE_PREVIEW);
    platformSelfServiceApi.commitPlanChange.mockResolvedValue({ status: "scheduled", effective_at: "2026-11-01T00:00:00Z" });
    const { onChanged } = renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Downgrade to Essentials" }));
    fireEvent.click(await screen.findByRole("button", { name: /Schedule downgrade/ }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(platformSelfServiceApi.commitPlanChange).toHaveBeenCalledWith({ targetPlanId: 1, confirmImmediate: false });
    expect(await screen.findByText(/Your plan will change to Essentials/)).toBeInTheDocument();
  });

  it("blocks an immediate downgrade when the compatibility checklist has blockers", async () => {
    platformSelfServiceApi.previewPlanChange.mockResolvedValue({
      ...DOWNGRADE_PREVIEW,
      blockers: [{ check_id: "internal_users_vs_max_users", label: "Internal users", detail: "12 users exceed the 5 allowed." }],
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Downgrade to Essentials" }));
    expect(await screen.findByText(/12 users exceed the 5 allowed/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Right now/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /next renewal/ })).toBeChecked();
  });

  it("shows a scheduled downgrade and lets the org cancel it", async () => {
    platformSelfServiceApi.cancelPlanChange.mockResolvedValue({ status: "cancelled" });
    const { onChanged } = renderPanel({
      subscription: { ...SUB, status: "scheduled_change" },
      pendingChange: { id: 7, direction: "downgrade", status: "scheduled", to_plan_name: "Essentials", effective_at: "2026-11-01T00:00:00Z" },
    });

    expect(await screen.findByText("Downgrade scheduled")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep my current plan" }));
    await waitFor(() => expect(platformSelfServiceApi.cancelPlanChange).toHaveBeenCalledWith(7));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("keeps other plans selectable while a downgrade is scheduled, and marks the scheduled one", async () => {
    // The user's case: on Business, Essentials scheduled — Professional and
    // Essentials used to be disabled until the schedule was cancelled.
    const business = {
      plans: PLANS.plans.map((p) => ({ ...p, is_current: p.plan_code === "business" })),
    };
    platformSelfServiceApi.getAvailablePlans.mockResolvedValue(business);
    platformSelfServiceApi.previewPlanChange.mockResolvedValue({ ...DOWNGRADE_PREVIEW, renewal_at: "2026-11-05T00:00:00Z" });
    platformSelfServiceApi.commitPlanChange.mockResolvedValue({ status: "scheduled", effective_at: "2026-11-05T00:00:00Z" });
    renderPanel({
      subscription: { ...SUB, status: "scheduled_change", plan_code: "business", price_amount: "399.00", current_period_end: null },
      pendingChange: { id: 7, direction: "downgrade", status: "scheduled", to_plan_id: 1, to_plan_name: "Essentials", effective_at: "2026-11-05T00:00:00Z" },
    });

    const scheduled = await screen.findByRole("button", { name: /essentials is already scheduled/i });
    expect(scheduled).toBeDisabled();
    expect(screen.queryByText(/cancel the scheduled downgrade first/i)).not.toBeInTheDocument();

    const professional = screen.getByRole("button", { name: /downgrade to professional/i });
    expect(professional).toBeEnabled();
    fireEvent.click(professional);
    expect(await screen.findByText(/replaces your scheduled move to/i)).toBeInTheDocument();
    // The renewal date comes from the server when current_period_end is empty.
    const until = screen.getByText(/keep everything you have until/i);
    expect(until.textContent).toMatch(/2026/);
    expect(until.textContent).not.toMatch(/until —/);

    fireEvent.click(screen.getByRole("button", { name: /schedule downgrade/i }));
    await waitFor(() =>
      expect(platformSelfServiceApi.commitPlanChange).toHaveBeenCalledWith({ targetPlanId: 2, confirmImmediate: false })
    );
  });

  it("shows an upgrade awaiting payment with a pay action", async () => {
    const { navigate } = renderPanel({
      pendingChange: { id: 8, direction: "upgrade", status: "pending", to_plan_name: "Business", invoice_public_token: "tok_pay", amount_due: "125.00", currency: "USD" },
    });

    expect(await screen.findByText(/Upgrade to Business awaiting payment/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Complete payment" }));
    expect(navigate).toHaveBeenCalledWith("/platform-invoice/tok_pay/checkout");
  });

  it("renders nothing when plans can't be loaded and nothing is pending", async () => {
    platformSelfServiceApi.getAvailablePlans.mockRejectedValue(new Error("nope"));
    renderPanel();
    await waitFor(() => expect(platformSelfServiceApi.getAvailablePlans).toHaveBeenCalled());
    expect(screen.queryByText("Change Plan")).toBeNull();
  });

  describe("during a free trial", () => {
    const TRIAL_SUB = { status: "trialing", plan_code: "essentials", price_amount: "49.00" };

    it("offers every plan, including Professional and Business, to pay for", async () => {
      renderPanel({ subscription: TRIAL_SUB, trial: true });
      expect(await screen.findByText("Choose a Plan & Pay")).toBeInTheDocument();
      for (const name of ["Essentials", "Professional", "Business"]) {
        expect(screen.getByRole("button", { name: `Pay for ${name}` })).toBeEnabled();
      }
    });

    it("pays for the chosen plan through Stripe Checkout without a preview call", async () => {
      platformSelfServiceApi.convertTrialToPaid.mockResolvedValue({
        status: "payment_required", mode: "checkout", checkout_url: "https://checkout.stripe.test/c/9",
      });
      renderPanel({ subscription: TRIAL_SUB, trial: true });

      fireEvent.click(await screen.findByRole("button", { name: "Pay for Business" }));
      expect(await screen.findByText(/Pay \$399\.00 today/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /Pay & activate/ }));

      await waitFor(() => expect(window.location.href).toBe("https://checkout.stripe.test/c/9"));
      expect(platformSelfServiceApi.convertTrialToPaid).toHaveBeenCalledWith({ payment_method: "card", plan_id: 3 });
      expect(platformSelfServiceApi.previewPlanChange).not.toHaveBeenCalled();
    });

    it("falls back to the invoice page when checkout isn't available", async () => {
      platformSelfServiceApi.convertTrialToPaid.mockResolvedValue({ status: "payment_required", mode: "invoice_due", public_token: "tok_t" });
      const { navigate } = renderPanel({ subscription: TRIAL_SUB, trial: true });
      fireEvent.click(await screen.findByRole("button", { name: "Pay for Professional" }));
      fireEvent.click(await screen.findByRole("button", { name: /Pay & activate/ }));
      await waitFor(() => expect(navigate).toHaveBeenCalledWith("/platform-invoice/tok_t"));
    });
  });
});
