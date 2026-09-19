import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// This suite focuses on the plan-change action of the subscription detail
// page: a real, money-affecting write path. It proves the actual
// subscriptionApi.changePlan(id, newPlanId) call only fires when the user
// has (a) opened the "Change Plan" panel, (b) selected a different plan, and
// (c) pressed the panel's own "Confirm Change" button -- never earlier.

const SUB_ID = "42";

const mockSubGet = vi.fn();
const mockSubListEvents = vi.fn();
const mockSubListPlans = vi.fn();
const mockSubChangePlan = vi.fn();
const mockSubPause = vi.fn();
const mockSubResume = vi.fn();
const mockSubCancel = vi.fn();
const mockSubActivate = vi.fn();
const mockSubRenew = vi.fn();
const mockSubGenerateInvoice = vi.fn();

const mockCustomerGet = vi.fn();
const mockContractGet = vi.fn();
const mockInvoiceList = vi.fn();
const mockPaymentList = vi.fn();
const mockAuditList = vi.fn();
const mockSettingsGetConfig = vi.fn();

vi.mock("../../../service/billingService", () => ({
  subscriptionApi: {
    get: (...args) => mockSubGet(...args),
    listEvents: (...args) => mockSubListEvents(...args),
    listPlans: (...args) => mockSubListPlans(...args),
    changePlan: (...args) => mockSubChangePlan(...args),
    pause: (...args) => mockSubPause(...args),
    resume: (...args) => mockSubResume(...args),
    cancel: (...args) => mockSubCancel(...args),
    activate: (...args) => mockSubActivate(...args),
    renew: (...args) => mockSubRenew(...args),
    generateInvoice: (...args) => mockSubGenerateInvoice(...args),
  },
  contractApi: { get: (...args) => mockContractGet(...args) },
  customerApi: { get: (...args) => mockCustomerGet(...args) },
  invoiceApi: { list: (...args) => mockInvoiceList(...args) },
  paymentApi: { list: (...args) => mockPaymentList(...args) },
  auditApi: { list: (...args) => mockAuditList(...args) },
  settingsApi: { getConfig: (...args) => mockSettingsGetConfig(...args) },
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useParams: () => ({ id: SUB_ID }),
  };
});

import SubscriptionDetailPage from "./subscription-detail";

const CURRENT_PLAN = { id: 1, plan_name: "Basic Plan", is_active: true, billing_period: "monthly", pricing_model: "flat", unit_price: 100 };
const NEW_PLAN = { id: 2, plan_name: "Pro Plan", is_active: true, billing_period: "monthly", pricing_model: "flat", unit_price: 200 };

function makeSubscription(overrides = {}) {
  return {
    id: 42,
    subscription_number: "SUB-0042",
    status: "active",
    plan_id: CURRENT_PLAN.id,
    plan_name: CURRENT_PLAN.plan_name,
    customer_id: null,
    contract_id: null,
    amount: 100,
    unit_price: 100,
    quantity: 1,
    currency: "USD",
    ...overrides,
  };
}

function renderDetailPage(subscriptionOverrides = {}) {
  mockSubGet.mockResolvedValue(makeSubscription(subscriptionOverrides));
  mockSubListEvents.mockResolvedValue([]);
  mockSubListPlans.mockResolvedValue([CURRENT_PLAN, NEW_PLAN]);
  mockInvoiceList.mockResolvedValue([]);
  mockPaymentList.mockResolvedValue([]);
  mockAuditList.mockResolvedValue([]);
  mockSettingsGetConfig.mockResolvedValue({});

  return render(
    <MemoryRouter>
      <SubscriptionDetailPage />
    </MemoryRouter>
  );
}

async function loadDetailPage(subscriptionOverrides = {}) {
  renderDetailPage(subscriptionOverrides);
  const trigger = await screen.findByRole("button", { name: /change plan/i });
  // Let the fire-and-forget invoice/payment/audit fetches settle so later
  // assertions aren't racing stray state updates.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return trigger;
}

async function openChangePlanModal() {
  const trigger = await loadDetailPage();
  fireEvent.click(trigger);
  const planButton = await screen.findByRole("button", { name: /pro plan/i });
  return planButton;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SubscriptionDetailPage — mount", () => {
  it("fetches the subscription and its events by id on mount", async () => {
    await loadDetailPage();

    expect(mockSubGet).toHaveBeenCalledTimes(1);
    expect(mockSubGet).toHaveBeenCalledWith(SUB_ID);
    expect(mockSubListEvents).toHaveBeenCalledTimes(1);
    expect(mockSubListEvents.mock.calls[0][0]).toBe(SUB_ID);
  });
});

describe("Plan change — happy path", () => {
  it("selecting a new plan and confirming calls changePlan exactly once with the subscription id and new plan id", async () => {
    const planButton = await openChangePlanModal();

    fireEvent.click(planButton);
    const confirmButton = await screen.findByRole("button", { name: /confirm change/i });
    expect(confirmButton).not.toBeDisabled();

    fireEvent.click(confirmButton);

    await waitFor(() => expect(mockSubChangePlan).toHaveBeenCalledTimes(1));
    expect(mockSubChangePlan).toHaveBeenCalledWith(42, NEW_PLAN.id);
  });

  it("closes the change-plan panel and refetches the subscription after a successful change", async () => {
    const planButton = await openChangePlanModal();
    fireEvent.click(planButton);
    fireEvent.click(await screen.findByRole("button", { name: /confirm change/i }));

    await waitFor(() => expect(mockSubChangePlan).toHaveBeenCalledTimes(1));

    // The panel closes on success -- "Confirm Change" should no longer be present.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /confirm change/i })).toBeNull();
    });
    // Silent refetch of the subscription after a successful plan change.
    await waitFor(() => expect(mockSubGet).toHaveBeenCalledTimes(2));
  });
});

describe("Plan change — validation", () => {
  it("disables Confirm Change until a new plan is selected, and does not call the API", async () => {
    await openChangePlanModal();

    const confirmButton = await screen.findByRole("button", { name: /confirm change/i });
    expect(confirmButton).toBeDisabled();

    fireEvent.click(confirmButton);

    expect(mockSubChangePlan).not.toHaveBeenCalled();
  });
});

describe("Plan change — confirm gate", () => {
  it("does not call changePlan merely by opening the panel or selecting a plan; only the Confirm Change click does", async () => {
    const trigger = await loadDetailPage();

    fireEvent.click(trigger);
    // Opening the panel loads the available plans, not a plan change.
    await waitFor(() => expect(mockSubListPlans).toHaveBeenCalledTimes(1));
    expect(mockSubChangePlan).not.toHaveBeenCalled();

    const planButton = await screen.findByRole("button", { name: /pro plan/i });
    fireEvent.click(planButton);
    // Selecting a plan is still just local UI state -- no API call yet.
    expect(mockSubChangePlan).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /confirm change/i }));

    await waitFor(() => expect(mockSubChangePlan).toHaveBeenCalledTimes(1));
  });
});

describe("Plan change — failure", () => {
  it("shows 'Failed to change plan' and keeps the panel open when the API call rejects", async () => {
    mockSubChangePlan.mockRejectedValue({});

    const planButton = await openChangePlanModal();
    fireEvent.click(planButton);
    fireEvent.click(await screen.findByRole("button", { name: /confirm change/i }));

    await screen.findByText(/failed to change plan/i);

    // The panel is not dismissed on failure, and no silent refetch happened.
    expect(screen.getByRole("button", { name: /confirm change/i })).toBeInTheDocument();
    expect(mockSubGet).toHaveBeenCalledTimes(1);
  });
});
