import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../../context/AuthContext";

// refund-detail.jsx money-affecting actions (approve / reject / process /
// complete / fail / cancel) fire via handleAction. Approve and Complete are
// the two irreversible one-click actions that previously had no gate at all
// (2026-09-19 audit UX-fix: production-readiness audit flagged this as a
// missing-confirmation P1 — see docs/CURRENT_PRODUCTION_READINESS_AUDIT.md);
// they now require a window.confirm() before calling the API, matching the
// window.confirm pattern already used elsewhere in this codebase (e.g.
// invoice-detail.jsx's delete-draft-invoice action). Reject/fail still gate
// on a typed reason as *business* validation, and cancel's reason is still
// explicitly optional — those are unchanged.

const mockGet = vi.fn();
const mockGetTimeline = vi.fn();
const mockGetCustomerSummary = vi.fn();
const mockSubmit = vi.fn();
const mockApprove = vi.fn();
const mockReject = vi.fn();
const mockCancel = vi.fn();
const mockProcess = vi.fn();
const mockComplete = vi.fn();
const mockFail = vi.fn();
const mockSendEmail = vi.fn();
const mockGetConfig = vi.fn();

vi.mock("../../../service/billingService", () => ({
  refundApi: {
    get: (...args) => mockGet(...args),
    getTimeline: (...args) => mockGetTimeline(...args),
    getCustomerSummary: (...args) => mockGetCustomerSummary(...args),
    submit: (...args) => mockSubmit(...args),
    approve: (...args) => mockApprove(...args),
    reject: (...args) => mockReject(...args),
    cancel: (...args) => mockCancel(...args),
    process: (...args) => mockProcess(...args),
    complete: (...args) => mockComplete(...args),
    fail: (...args) => mockFail(...args),
    sendEmail: (...args) => mockSendEmail(...args),
  },
  settingsApi: {
    getConfig: (...args) => mockGetConfig(...args),
  },
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useParams: () => ({ id: "42" }) };
});

import RefundDetailPage from "./refund-detail";

function baseRefund(overrides = {}) {
  return {
    id: 42,
    refund_number: "RF-0042",
    status: "pending_approval",
    currency: "USD",
    customer_id: 9,
    customer_name: "Jane Doe",
    customer_email: "jane@example.com",
    amount: 250,
    refund_type: "full",
    refund_source: "payment",
    refund_method: "original_payment",
    reference_number: null,
    reason: "Customer requested cancellation",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function renderPage() {
  return render(
    <AuthProvider>
      <MemoryRouter>
        <RefundDetailPage />
      </MemoryRouter>
    </AuthProvider>
  );
}

async function loadPage(overrides = {}) {
  const refund = baseRefund(overrides);
  mockGet.mockResolvedValue(refund);
  mockGetTimeline.mockResolvedValue({ entries: [] });
  mockGetCustomerSummary.mockResolvedValue(null);
  mockGetConfig.mockResolvedValue({ relationship_terminology: "customer" });
  renderPage();
  await screen.findByRole("heading", { name: `Refund ${refund.refund_number}` });
  return refund;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("RefundDetailPage — happy path", () => {
  it("approving a pending-approval refund asks for confirmation, then fires refundApi.approve exactly once with its id", async () => {
    // Approve is gated to finance_approver/super_admin (maker-checker
    // separation of duties) -- without a stored user in this role, the
    // component renders an explanatory panel instead of the button.
    // AuthProvider only trusts the stored user once an access token is also
    // present (see AuthContext.jsx's mount effect), so both must be set.
    localStorage.setItem("zoiko_billing_access", "test-token");
    localStorage.setItem("zoiko_billing_user", JSON.stringify({ role: "finance_approver" }));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await loadPage({ status: "pending_approval" });

    const approveBtn = await screen.findByRole("button", { name: /Approve/i });
    fireEvent.click(approveBtn);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockApprove).toHaveBeenCalledTimes(1));
    expect(mockApprove).toHaveBeenCalledWith(42);
  });

  it("declining the approve confirmation does not call refundApi.approve", async () => {
    localStorage.setItem("zoiko_billing_access", "test-token");
    localStorage.setItem("zoiko_billing_user", JSON.stringify({ role: "finance_approver" }));
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await loadPage({ status: "pending_approval" });

    const approveBtn = await screen.findByRole("button", { name: /Approve/i });
    fireEvent.click(approveBtn);

    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("marking a processing refund completed asks for confirmation, then fires refundApi.complete exactly once with its id", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await loadPage({ status: "processing" });

    const completeBtn = await screen.findByRole("button", { name: /Mark Completed/i });
    fireEvent.click(completeBtn);

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockComplete).toHaveBeenCalledTimes(1));
    expect(mockComplete).toHaveBeenCalledWith(42);
  });
});

describe("RefundDetailPage — reject requires a typed reason (business validation)", () => {
  it("disables the Reject Refund confirm button until a reason is typed, and does not call the API without one", async () => {
    await loadPage({ status: "pending_approval" });

    fireEvent.click(screen.getByRole("button", { name: /^Reject$/i }));
    const rejectConfirmBtn = await screen.findByRole("button", { name: "Reject Refund" });
    expect(rejectConfirmBtn).toBeDisabled();

    // A disabled button is inert — clicking it must not invoke the handler.
    fireEvent.click(rejectConfirmBtn);
    expect(mockReject).not.toHaveBeenCalled();
  });

  it("submits the typed reason and calls refundApi.reject exactly once", async () => {
    await loadPage({ status: "pending_approval" });

    fireEvent.click(screen.getByRole("button", { name: /^Reject$/i }));
    const textarea = await screen.findByPlaceholderText(/Reason for rejection/i);
    fireEvent.change(textarea, { target: { value: "Duplicate charge dispute" } });

    const rejectConfirmBtn = screen.getByRole("button", { name: "Reject Refund" });
    expect(rejectConfirmBtn).not.toBeDisabled();
    fireEvent.click(rejectConfirmBtn);

    await waitFor(() => expect(mockReject).toHaveBeenCalledTimes(1));
    expect(mockReject).toHaveBeenCalledWith(42, "Duplicate charge dispute");
  });
});

describe("RefundDetailPage — cancel has no confirmation gate", () => {
  it("clicking 'Cancel Refund' in the modal fires refundApi.cancel immediately — no typed confirmation, MFA, or step-up is required", async () => {
    await loadPage({ status: "approved" });

    // Opens a plain modal; the reason textarea has no placeholder marking it
    // required and there is no second confirmation step beyond this click.
    fireEvent.click(screen.getByRole("button", { name: /^Cancel Refund$/i }));
    await screen.findByText(/Are you sure you want to cancel/i);

    const confirmButtons = screen.getAllByRole("button", { name: /Cancel Refund/i });
    // The modal's confirm button is the one still present that isn't the
    // "Go Back" button; click the danger-styled confirm action directly.
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() => expect(mockCancel).toHaveBeenCalledTimes(1));
    expect(mockCancel).toHaveBeenCalledWith(42, undefined);
  });
});
