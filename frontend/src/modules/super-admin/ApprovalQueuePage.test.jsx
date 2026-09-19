import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";

// ApprovalQueuePage is the maker-checker gate for material commercial
// operations (ZB-COM-BILL-001 Phase 5). It has TWO decision flows:
//   1. catalog_version_publish  -> a plain "are you sure?" confirmation
//      dialog (useConfirmationDialog), then approveCommercialPlanVersion /
//      rejectCommercialPlanVersion.
//   2. circuit_breaker_change   -> the "checker" flow, which is the ONE
//      real MFA/step-up gate: BreakerDecisionModal requires a fresh
//      6+ character authenticator code before its Approve/Reject submit
//      button is even enabled, then calls decideApprovalRequest with the
//      code attached. These tests prove that gate actually blocks the
//      mutating API call when the code is missing or too short, and that
//      it fires with the right payload once satisfied.

const mockListApprovalRequests = vi.fn();
const mockApproveCommercialPlanVersion = vi.fn();
const mockRejectCommercialPlanVersion = vi.fn();
const mockDecideApprovalRequest = vi.fn();

vi.mock("../../service/commercialService", () => ({
  listApprovalRequests: (...args) => mockListApprovalRequests(...args),
  approveCommercialPlanVersion: (...args) => mockApproveCommercialPlanVersion(...args),
  rejectCommercialPlanVersion: (...args) => mockRejectCommercialPlanVersion(...args),
}));

vi.mock("../../service/commandCenterService", () => ({
  decideApprovalRequest: (...args) => mockDecideApprovalRequest(...args),
}));

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("../../context/AuthContext", () => ({ useAuth }));

import ApprovalQueuePage from "./ApprovalQueuePage";

const CURRENT_ADMIN = { id: 1, role: "super_admin", name: "Checker Admin" };

const CATALOG_REQUEST = {
  id: 501,
  request_type: "catalog_version_publish",
  requested_by_email: "maker@zoikogroup.com",
  requested_by_user_id: 999, // different from CURRENT_ADMIN.id — not self
  requested_at: "2026-09-01T10:00:00Z",
  status: "pending",
  reason: "Q3 price update",
  scope: { version_id: 42 },
};

const BREAKER_REQUEST = {
  id: 777,
  request_type: "circuit_breaker_change",
  requested_by_email: "maker2@zoikogroup.com",
  requested_by_user_id: 999,
  requested_at: "2026-09-01T09:00:00Z",
  status: "pending",
  reason: "Emergency breaker flip",
  scope: {},
};

function mockRequests(requests) {
  mockListApprovalRequests.mockResolvedValue({ requests, total: requests.length });
}

async function renderPage() {
  const utils = render(<ApprovalQueuePage />);
  // Wait for the initial load() to settle (spinner -> table/empty state).
  await waitFor(() => expect(mockListApprovalRequests).toHaveBeenCalled());
  return utils;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: CURRENT_ADMIN });
});

describe("Catalog version publish — happy path (confirmation dialog, not MFA)", () => {
  it("approve calls approveCommercialPlanVersion exactly once with the version id, only after confirming", async () => {
    mockRequests([CATALOG_REQUEST]);
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));

    // The confirmation dialog is up; the mutating API must not have fired yet.
    const dialog = await screen.findByRole("dialog");
    expect(mockApproveCommercialPlanVersion).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: /^approve$/i }));

    await waitFor(() => expect(mockApproveCommercialPlanVersion).toHaveBeenCalledTimes(1));
    expect(mockApproveCommercialPlanVersion).toHaveBeenCalledWith(42);
  });

  it("cancelling the confirmation dialog does not call the API", async () => {
    mockRequests([CATALOG_REQUEST]);
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockApproveCommercialPlanVersion).not.toHaveBeenCalled();
  });
});

describe("Catalog version reject — reason validation", () => {
  it("blocks submission with no reason (submit disabled, error surfaced, API not called)", async () => {
    mockRequests([CATALOG_REQUEST]);
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /^reject$/i }));
    const dialog = await screen.findByRole("dialog", { name: /reject request/i });

    const submitBtn = within(dialog).getByRole("button", { name: /^reject$/i });
    expect(submitBtn).toBeDisabled();

    fireEvent.click(submitBtn);
    expect(mockRejectCommercialPlanVersion).not.toHaveBeenCalled();
  });

  it("succeeds once a reason is entered — calls rejectCommercialPlanVersion with version id + reason", async () => {
    mockRequests([CATALOG_REQUEST]);
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /^reject$/i }));
    const dialog = await screen.findByRole("dialog", { name: /reject request/i });

    fireEvent.change(screen.getByLabelText(/rejection reason/i), {
      target: { value: "Pricing error found in tier 2" },
    });

    const submitBtn = within(dialog).getByRole("button", { name: /^reject$/i });
    expect(submitBtn).not.toBeDisabled();
    fireEvent.click(submitBtn);

    await waitFor(() => expect(mockRejectCommercialPlanVersion).toHaveBeenCalledTimes(1));
    expect(mockRejectCommercialPlanVersion).toHaveBeenCalledWith(42, "Pricing error found in tier 2");
  });
});

describe("Circuit breaker checker decision — the real MFA/step-up gate", () => {
  it("submit is disabled with no code at all, and clicking it never calls decideApprovalRequest", async () => {
    mockRequests([BREAKER_REQUEST]);
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
    const dialog = await screen.findByRole("dialog", { name: /approve circuit breaker change/i });

    // The step-up banner and a dedicated MFA code field must be present.
    expect(within(dialog).getByText(/checker step-up required/i)).toBeInTheDocument();
    const codeInput = screen.getByPlaceholderText("123456");
    expect(codeInput).toHaveValue("");

    const submitBtn = within(dialog).getByRole("button", { name: /^approve$/i });
    expect(submitBtn).toBeDisabled();

    fireEvent.click(submitBtn);
    expect(mockDecideApprovalRequest).not.toHaveBeenCalled();
  });

  it("submit stays disabled with a too-short code, and clicking it never calls decideApprovalRequest", async () => {
    mockRequests([BREAKER_REQUEST]);
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
    const dialog = await screen.findByRole("dialog", { name: /approve circuit breaker change/i });

    const codeInput = screen.getByPlaceholderText("123456");
    fireEvent.change(codeInput, { target: { value: "123" } }); // 3 digits — below the 6-char gate

    const submitBtn = within(dialog).getByRole("button", { name: /^approve$/i });
    expect(submitBtn).toBeDisabled();

    fireEvent.click(submitBtn);
    expect(mockDecideApprovalRequest).not.toHaveBeenCalled();
  });

  it("approve succeeds only once a fresh 6+ digit MFA code is entered — calls decideApprovalRequest exactly once with the code attached", async () => {
    mockRequests([BREAKER_REQUEST]);
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
    const dialog = await screen.findByRole("dialog", { name: /approve circuit breaker change/i });

    const codeInput = screen.getByPlaceholderText("123456");
    fireEvent.change(codeInput, { target: { value: "654321" } });

    const submitBtn = within(dialog).getByRole("button", { name: /^approve$/i });
    expect(submitBtn).not.toBeDisabled();
    fireEvent.click(submitBtn);

    await waitFor(() => expect(mockDecideApprovalRequest).toHaveBeenCalledTimes(1));
    expect(mockDecideApprovalRequest).toHaveBeenCalledWith(777, {
      decision: "approve",
      reason: "",
      code: "654321",
    });
  });

  it("reject requires BOTH a reason and the MFA code — neither alone unblocks submit, and the API is never called until both are present", async () => {
    mockRequests([BREAKER_REQUEST]);
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /^reject$/i }));
    const dialog = await screen.findByRole("dialog", { name: /reject circuit breaker change/i });

    const submitBtn = within(dialog).getByRole("button", { name: /^reject$/i });
    const reasonField = dialog.querySelector("textarea");
    const codeInput = screen.getByPlaceholderText("123456");

    // Code only, no reason.
    fireEvent.change(codeInput, { target: { value: "111111" } });
    expect(submitBtn).toBeDisabled();
    fireEvent.click(submitBtn);
    expect(mockDecideApprovalRequest).not.toHaveBeenCalled();

    // Reason only (clear the code back out) — still blocked.
    fireEvent.change(codeInput, { target: { value: "" } });
    fireEvent.change(reasonField, { target: { value: "Breaker must stay open, incident ongoing" } });
    expect(submitBtn).toBeDisabled();
    fireEvent.click(submitBtn);
    expect(mockDecideApprovalRequest).not.toHaveBeenCalled();

    // Both present — now it's allowed through, exactly once, with both values.
    fireEvent.change(codeInput, { target: { value: "111111" } });
    expect(submitBtn).not.toBeDisabled();
    fireEvent.click(submitBtn);

    await waitFor(() => expect(mockDecideApprovalRequest).toHaveBeenCalledTimes(1));
    expect(mockDecideApprovalRequest).toHaveBeenCalledWith(777, {
      decision: "reject",
      reason: "Breaker must stay open, incident ongoing",
      code: "111111",
    });
  });

  it("closing the modal without submitting never calls decideApprovalRequest", async () => {
    mockRequests([BREAKER_REQUEST]);
    await renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /^approve$/i }));
    const dialog = await screen.findByRole("dialog", { name: /approve circuit breaker change/i });
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockDecideApprovalRequest).not.toHaveBeenCalled();
  });
});
