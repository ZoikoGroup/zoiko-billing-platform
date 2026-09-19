import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithRouter } from "../test/renderWithRouter";
import { axe } from "../../../test/a11y";

vi.mock("../../../service/billingService", () => ({
  subscriptionApi: {
    listPlans: vi.fn(),
    createPlan: vi.fn(),
    updatePlan: vi.fn(),
    activatePlan: vi.fn(),
    deactivatePlan: vi.fn(),
    getPlan: vi.fn(),
  },
}));

import SubscriptionPlansPage from "./subscription-plans";
import { subscriptionApi } from "../../../service/billingService";

const BASIC = {
  id: 1,
  organization_id: 1,
  plan_code: "basic-monthly",
  plan_name: "Basic Monthly",
  description: "Basic plan",
  category: "subscription",
  billing_period: "monthly",
  billing_cycles: 0,
  pricing_model: "flat",
  unit_price: "999.00",
  setup_fee: "0",
  trial_days: 14,
  is_public: true,
  sort_order: 0,
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
};

const PRO = {
  ...BASIC,
  id: 2,
  plan_code: "pro-monthly",
  plan_name: "Professional Monthly",
  unit_price: "1999.00",
  trial_days: 14,
};

function fieldByLabel(container, labelPattern) {
  const label = within(container).getByText(labelPattern);
  return label.parentElement.querySelector("input, select, textarea");
}

beforeEach(() => {
  vi.clearAllMocks();
  subscriptionApi.listPlans.mockResolvedValue({ items: [BASIC, PRO], total: 2 });
});

describe("SubscriptionPlansPage", () => {
  it("shows a loading state before data arrives", async () => {
    let resolveList;
    subscriptionApi.listPlans.mockReturnValue(new Promise((res) => { resolveList = res; }));
    renderWithRouter(<SubscriptionPlansPage />);
    expect(screen.getByLabelText(/loading content/i)).toBeInTheDocument();
    resolveList({ items: [], total: 0 });
    await waitFor(() => expect(screen.queryByLabelText(/loading content/i)).not.toBeInTheDocument());
  });

  it("renders the plan list once loaded", async () => {
    renderWithRouter(<SubscriptionPlansPage />);
    await waitFor(() => expect(screen.getByText("Basic Monthly")).toBeInTheDocument());
    expect(screen.getByText("Professional Monthly")).toBeInTheDocument();
    // Real API params include active_only:false so the admin view shows inactive plans too
    expect(subscriptionApi.listPlans).toHaveBeenCalledWith(
      expect.objectContaining({ active_only: false })
    );
  });

  it("shows an empty state with create CTA when there are no plans", async () => {
    subscriptionApi.listPlans.mockResolvedValue({ items: [], total: 0 });
    renderWithRouter(<SubscriptionPlansPage />);
    await waitFor(() => expect(screen.getByText("No subscription plans yet")).toBeInTheDocument());
    expect(screen.getByText("Create your first plan")).toBeInTheDocument();
  });

  it("opens the create modal and validates required fields", async () => {
    renderWithRouter(<SubscriptionPlansPage />);
    await waitFor(() => expect(screen.getByText("Basic Monthly")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Create Plan"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Create Plan", { selector: "h2" })).toBeInTheDocument();
    // Submit empty form -> validation errors
    const submit = within(dialog).getByRole("button", { name: /create plan/i, type: "submit" });
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText("Plan code is required.")).toBeInTheDocument());
    expect(screen.getByText("Plan name is required.")).toBeInTheDocument();
    expect(subscriptionApi.createPlan).not.toHaveBeenCalled();
  });

  it("creates a plan successfully via the create modal", async () => {
    subscriptionApi.createPlan.mockResolvedValue({ ...BASIC });
    renderWithRouter(<SubscriptionPlansPage />);
    await waitFor(() => expect(screen.getByText("Basic Monthly")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Create Plan"));
    const dialog = await screen.findByRole("dialog");

    const container = dialog;
    const codeInput = fieldByLabel(container, "Plan Code");
    const nameInput = fieldByLabel(container, "Plan Name");
    const priceInput = fieldByLabel(container, "Unit Price");
    fireEvent.change(codeInput, { target: { value: "enterprise-monthly" } });
    fireEvent.change(nameInput, { target: { value: "Enterprise Monthly" } });
    fireEvent.change(priceInput, { target: { value: "4999" } });

    fireEvent.click(within(dialog).getByRole("button", { name: /create plan/i, type: "submit" }));
    await waitFor(() => expect(subscriptionApi.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        plan_code: "enterprise-monthly",
        plan_name: "Enterprise Monthly",
        unit_price: 4999,
        billing_period: "monthly",
      })
    ));
    await waitFor(() => expect(screen.getByText(/plan created successfully/i)).toBeInTheDocument());
  });

  it("shows the error state when the list load fails", async () => {
    subscriptionApi.listPlans.mockRejectedValue({ detail: "Boom" });
    renderWithRouter(<SubscriptionPlansPage />);
    await waitFor(() => expect(screen.getByText(/could not load plans/i)).toBeInTheDocument());
  });

  it("deactivates a plan via the row action", async () => {
    subscriptionApi.deactivatePlan.mockResolvedValue({ ...BASIC, is_active: false });
    renderWithRouter(<SubscriptionPlansPage />);
    await waitFor(() => expect(screen.getByText("Basic Monthly")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /deactivate basic monthly/i }));
    // confirm dialog appears; click the confirm (Deactivate) button
    await waitFor(() => expect(screen.getByText("Deactivate plan?")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(subscriptionApi.deactivatePlan).toHaveBeenCalledWith(BASIC.id));
    await waitFor(() => expect(screen.getByText(/plan deactivated/i)).toBeInTheDocument());
  });

  it("has no axe accessibility violations once loaded", async () => {
    const { container } = renderWithRouter(<SubscriptionPlansPage />);
    await waitFor(() => expect(screen.getByText("Basic Monthly")).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });
});
