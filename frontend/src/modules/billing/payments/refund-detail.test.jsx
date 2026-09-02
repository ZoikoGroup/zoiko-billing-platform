import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// refund-detail.jsx money-affecting actions (approve / reject / process /
// complete / fail / cancel) fire straight off a single button click via
// handleAction — there is no window.confirm(), MFA, step-up, or typed
// audit-reason gate anywhere in the component (verified by reading every
// action handler below: reject/fail require a typed reason as *business*
// validation only, and cancel's reason is explicitly optional).

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
    <MemoryRouter>
      <RefundDetailPage />
    </MemoryRouter>
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
});

describe("RefundDetailPage — happy path", () => {
  it("approving a pending-approval refund fires refundApi.approve exactly once with its id (single click, no confirm gate)", async () => {
    await loadPage({ status: "pending_approval" });

    const approveBtn = await screen.findByRole("button", { name: /Approve/i });
    fireEvent.click(approveBtn);

    await waitFor(() => expect(mockApprove).toHaveBeenCalledTimes(1));
    expect(mockApprove).toHaveBeenCalledWith(42);
  });

  it("marking a processing refund completed fires refundApi.complete exactly once with its id", async () => {
    await loadPage({ status: "processing" });

    const completeBtn = await screen.findByRole("button", { name: /Mark Completed/i });
    fireEvent.click(completeBtn);

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
