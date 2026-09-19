import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("../context/AuthContext", () => ({ useAuth }));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => mockNavigate }));

const { platformSelfServiceApi } = vi.hoisted(() => ({
  platformSelfServiceApi: {
    getZoikoSubscription: vi.fn(),
    convertTrialToPaid: vi.fn(),
  },
}));
vi.mock("../service/platformSelfServiceApi", () => ({ platformSelfServiceApi }));

import TrialBanner from "./TrialBanner";

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

const TRIALING_SUB = { id: 7, status: "trialing", trial_ends_at: inDays(13) };
const RECOVERY_SUB = { id: 8, status: "trial_recovery", recovery_ends_at: inDays(4) };
const ACTIVE_SUB = { id: 9, status: "active", trial_ends_at: inDays(13) };

function setup({ role = "billing_admin", subscription = TRIALING_SUB } = {}) {
  useAuth.mockReturnValue({ role });
  platformSelfServiceApi.getZoikoSubscription.mockResolvedValue({ subscription });
  return render(<TrialBanner />);
}

const fireConvert = () => fireEvent.click(screen.getByRole("button", { name: /paid plan|restore full access/i }));

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  const realHref = window.location.href;
  Object.defineProperty(window, "location", {
    value: { href: realHref },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  mockNavigate.mockReset();
});

describe("TrialBanner visibility", () => {
  it("renders while TRIALING with the remaining days badge", async () => {
    setup();
    await waitFor(() => expect(screen.getByRole("status", { name: /trial subscription banner/i })).toBeInTheDocument());
    expect(screen.getByText("13 days left")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue with paid plan/i })).toBeInTheDocument();
  });

  it("renders the recovery variant while TRIAL_RECOVERY", async () => {
    setup({ subscription: RECOVERY_SUB });
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(screen.getByText(/recovery window/i)).toBeInTheDocument();
    expect(screen.getByText("Read / Export only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restore full access/i })).toBeInTheDocument();
  });

  it("never renders for a super_admin", async () => {
    setup({ role: "super_admin", subscription: TRIALING_SUB });
    await waitFor(() => expect(platformSelfServiceApi.getZoikoSubscription).not.toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("does not render for an active subscription", async () => {
    setup({ subscription: ACTIVE_SUB });
    await waitFor(() => expect(platformSelfServiceApi.getZoikoSubscription).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stays hidden for this session once dismissed", async () => {
    const { unmount } = setup();
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /dismiss trial banner/i }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    unmount();

    // A fresh mount in the same session honors the dismissal.
    vi.clearAllMocks();
    platformSelfServiceApi.getZoikoSubscription.mockResolvedValue({ subscription: TRIALING_SUB });
    setup();
    await waitFor(() => expect(platformSelfServiceApi.getZoikoSubscription).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });
});

describe("TrialBanner CTA", () => {
  it("redirects to Stripe Checkout on mode=checkout", async () => {
    setup();
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    platformSelfServiceApi.convertTrialToPaid.mockResolvedValue({
      mode: "checkout",
      checkout_url: "https://checkout.stripe.com/c/pay/cs_test_abc",
    });
    fireConvert();
    await waitFor(() => {
      expect(platformSelfServiceApi.convertTrialToPaid).toHaveBeenCalledWith({ payment_method: "card" });
      expect(window.location.href).toBe("https://checkout.stripe.com/c/pay/cs_test_abc");
    });
  });

  it("posts the convert endpoint and forwards to the assisted quote for no self-serve price", async () => {
    setup();
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    platformSelfServiceApi.convertTrialToPaid.mockResolvedValue({
      mode: "assisted_quote",
      quote_url: "https://app.example.com/platform-quote/TOKEN123",
    });
    fireConvert();
    await waitFor(() => expect(window.location.href).toBe("https://app.example.com/platform-quote/TOKEN123"));
  });

  it("navigates to the public invoice when platform Stripe is unavailable (invoice_due)", async () => {
    setup();
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    platformSelfServiceApi.convertTrialToPaid.mockResolvedValue({ mode: "invoice_due", public_token: "INVTOKEN9" });
    fireConvert();
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/platform-invoice/INVTOKEN9"));
  });

  it("surfaces a conversion failure without hiding the trial", async () => {
    setup();
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    platformSelfServiceApi.convertTrialToPaid.mockRejectedValue(new Error("Stripe is not configured"));
    fireConvert();
    await waitFor(() => expect(screen.getByText(/stripe is not configured/i)).toBeInTheDocument());
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});