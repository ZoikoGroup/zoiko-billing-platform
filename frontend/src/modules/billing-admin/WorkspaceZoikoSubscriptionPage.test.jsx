import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import WorkspaceZoikoSubscriptionPage from "./WorkspaceZoikoSubscriptionPage";
import { platformSelfServiceApi } from "../../service/platformSelfServiceApi";

vi.mock("../../context/AuthContext", () => ({
  useAuth: () => ({
    user: { id: 1, first_name: "Alex", role: "org_admin", email: "admin@acme.test" },
    role: "org_admin",
  }),
}));

vi.mock("../../service/platformSelfServiceApi", () => {
  const platformSelfServiceApi = {
    getZoikoSubscription: vi.fn(),
    getWorkspaceUsage: vi.fn(),
    getPlanLimits: vi.fn(),
    startTrial: vi.fn(),
    convertTrialToPaid: vi.fn(),
  };
  return {
    platformSelfServiceApi,
    // The page loads through the shared cache; route it to the raw mock so
    // per-test mockResolvedValue setups keep working.
    getZoikoSubscriptionCached: (...a) => platformSelfServiceApi.getZoikoSubscription(...a),
    invalidateZoikoSubscriptionCache: vi.fn(),
  };
});

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe("WorkspaceZoikoSubscriptionPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders active subscription details correctly", async () => {
    platformSelfServiceApi.getZoikoSubscription.mockResolvedValue({
      account: { id: 1, status: "active" },
      subscription: {
        id: 10,
        status: "active",
        plan_code: "enterprise_annual",
        plan_name: "Zoiko Enterprise",
        currency: "USD",
        price_amount: "990.00",
        billing_interval: "annual",
        current_period_start: "2026-01-01T00:00:00Z",
        current_period_end: "2027-01-01T00:00:00Z",
      },
      invoices: [
        {
          id: 100,
          invoice_number: "PINV-0100",
          status: "paid",
          currency: "USD",
          total_amount: "990.00",
          balance_due: "0.00",
          public_token: "tok_100",
        },
      ],
      payments: [
        {
          id: 50,
          payment_number: "PAY-0050",
          status: "cleared",
          amount: "990.00",
          currency: "USD",
          payment_method: "card",
        },
      ],
      quotes: [],
    });
    platformSelfServiceApi.getWorkspaceUsage.mockResolvedValue({
      counters: [
        {
          id: 1,
          entitlement_key: "seats",
          count: 5,
          limit: 20,
          enforcement_type: "hard_stop",
        },
      ],
    });

    render(
      <MemoryRouter>
        <WorkspaceZoikoSubscriptionPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Zoiko Enterprise")).toBeInTheDocument();
    });

    expect(screen.getByText("Active Subscription")).toBeInTheDocument();
    expect(screen.getAllByText("$990.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("PINV-0100")).toBeInTheDocument();
    expect(screen.getByText("PAY-0050")).toBeInTheDocument();
    expect(screen.getByText("Team Members / Seats")).toBeInTheDocument();
  });

  it("renders trial subscription with Activate Paid Plan CTA", async () => {
    platformSelfServiceApi.getZoikoSubscription.mockResolvedValue({
      account: { id: 2, status: "active" },
      subscription: {
        id: 20,
        status: "trialing",
        plan_code: "pro_monthly",
        plan_name: "Zoiko Pro",
        currency: "USD",
        price_amount: "49.00",
        billing_interval: "monthly",
        trial_ends_at: "2026-10-25T00:00:00Z",
      },
      invoices: [],
      payments: [],
      quotes: [],
    });
    platformSelfServiceApi.getWorkspaceUsage.mockResolvedValue({ counters: [] });

    render(
      <MemoryRouter>
        <WorkspaceZoikoSubscriptionPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Zoiko Pro")).toBeInTheDocument();
    });

    expect(screen.getByText("Free Trial")).toBeInTheDocument();
    const ctaButton = screen.getByRole("button", { name: /activate paid plan/i });
    expect(ctaButton).toBeInTheDocument();

    platformSelfServiceApi.convertTrialToPaid.mockResolvedValue({
      mode: "invoice_due",
      public_token: "tok_inv_new",
    });

    fireEvent.click(ctaButton);

    await waitFor(() => {
      expect(platformSelfServiceApi.convertTrialToPaid).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith("/platform-invoice/tok_inv_new");
    });
  });

  it("shows the plan's limits clearly, preferring live resolved limits", async () => {
    platformSelfServiceApi.getZoikoSubscription.mockResolvedValue({
      account: { id: 4, status: "active" },
      subscription: {
        id: 40,
        status: "active",
        plan_code: "professional",
        plan_name: "Professional",
        currency: "USD",
        price_amount: "149.00",
        billing_interval: "monthly",
        max_users: 25,
      },
      invoices: [],
      payments: [],
      quotes: [],
    });
    platformSelfServiceApi.getWorkspaceUsage.mockResolvedValue({
      counters: [{ id: 9, entitlement_key: "billing.invoice.monthly_limit", count: 400, limit: 1000, enforcement_type: "hard" }],
    });
    platformSelfServiceApi.getPlanLimits.mockResolvedValue({
      entitlements: [
        { key: "billing.invoice.monthly_limit", value: 1000, value_type: "integer", enforcement_type: "hard" },
        { key: "api.requests_per_day", value: 50000, value_type: "integer", enforcement_type: "throttle" },
        { key: "security.sso", value: true, value_type: "boolean", enforcement_type: "hard" },
        { key: "billing.pricing_model_set", value: ["flat", "tiered", "volume"], value_type: "set", enforcement_type: "hard" },
      ],
    });

    render(
      <MemoryRouter>
        <WorkspaceZoikoSubscriptionPage />
      </MemoryRouter>
    );

    expect(await screen.findByText("Plan Limits")).toBeInTheDocument();
    expect(screen.getByText("Live limits for your organization")).toBeInTheDocument();
    // used / limit for a metered key, plain limit for an unmetered one
    expect(screen.getByText("400")).toBeInTheDocument();
    expect(screen.getByText("/ 1,000")).toBeInTheDocument();
    expect(screen.getAllByText("50,000").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Single sign-on (SSO)")).toBeInTheDocument();
    expect(screen.getByText("Pricing models you can use")).toBeInTheDocument();
    expect(screen.getByText("Compare Plans")).toBeInTheDocument();
  });

  it("falls back to the standard plan limits when live limits are unavailable", async () => {
    platformSelfServiceApi.getZoikoSubscription.mockResolvedValue({
      account: { id: 5, status: "active" },
      subscription: { id: 50, status: "active", plan_code: "essentials", plan_name: "Essentials", currency: "USD", price_amount: "49.00", billing_interval: "monthly" },
      invoices: [],
      payments: [],
      quotes: [],
    });
    platformSelfServiceApi.getWorkspaceUsage.mockResolvedValue({ counters: [] });
    platformSelfServiceApi.getPlanLimits.mockRejectedValue(new Error("boom"));

    render(
      <MemoryRouter>
        <WorkspaceZoikoSubscriptionPage />
      </MemoryRouter>
    );

    expect(await screen.findByText("Standard limits for your plan")).toBeInTheDocument();
    expect(screen.getAllByText("Invoices per month").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("100").length).toBeGreaterThanOrEqual(1);
  });

  it("renders payable invoice with direct Pay Now button", async () => {
    platformSelfServiceApi.getZoikoSubscription.mockResolvedValue({
      account: { id: 3, status: "active" },
      subscription: {
        id: 30,
        status: "past_due",
        plan_code: "pro_monthly",
        plan_name: "Zoiko Pro",
        currency: "USD",
        price_amount: "49.00",
        billing_interval: "monthly",
      },
      invoices: [
        {
          id: 300,
          invoice_number: "PINV-0300",
          status: "issued",
          currency: "USD",
          total_amount: "49.00",
          balance_due: "49.00",
          public_token: "tok_pinv_300",
          due_date: "2026-10-01T00:00:00Z",
        },
      ],
      payments: [],
      quotes: [],
    });
    platformSelfServiceApi.getWorkspaceUsage.mockResolvedValue({ counters: [] });

    render(
      <MemoryRouter>
        <WorkspaceZoikoSubscriptionPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText(/invoice pinv-0300/i)).toBeInTheDocument();
    });

    const payButton = screen.getAllByRole("button", { name: /pay/i })[0];
    fireEvent.click(payButton);

    expect(mockNavigate).toHaveBeenCalledWith("/platform-invoice/tok_pinv_300/checkout");
  });

  it("lets an org with no subscription start its free trial itself", async () => {
    platformSelfServiceApi.getZoikoSubscription
      .mockResolvedValueOnce({ account: { id: 6, status: "active", intended_plan_code: "essentials" }, subscription: null, invoices: [], payments: [], quotes: [] })
      .mockResolvedValueOnce({
        account: { id: 6, status: "active" },
        subscription: { id: 60, status: "trialing", plan_code: "essentials", plan_name: "Essentials", currency: "USD", price_amount: "49.00", billing_interval: "monthly", trial_ends_at: "2026-10-26T00:00:00Z" },
        invoices: [], payments: [], quotes: [],
      });
    platformSelfServiceApi.getWorkspaceUsage.mockResolvedValue({ counters: [] });
    platformSelfServiceApi.startTrial.mockResolvedValue({ status: "trialing" });

    render(<MemoryRouter><WorkspaceZoikoSubscriptionPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /Start free 14-day trial/ }));

    await waitFor(() => expect(platformSelfServiceApi.startTrial).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Free Trial")).toBeInTheDocument();
  });
});
