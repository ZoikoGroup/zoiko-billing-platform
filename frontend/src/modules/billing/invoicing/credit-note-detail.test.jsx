import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// credit-note-detail.jsx money-affecting actions (approve / issue / void /
// apply-to-invoice) fire straight off a single button click via handleAction —
// there is no window.confirm(), MFA, step-up, or typed audit-reason gate
// anywhere in the component (verified by reading every action handler below).
// These tests assert the real API surface and, where relevant, document that
// single-click-fires-immediately behavior rather than fabricating a
// confirmation step that doesn't exist.

const mockGet = vi.fn();
const mockListApplications = vi.fn();
const mockGetTimeline = vi.fn();
const mockListCommunications = vi.fn();
const mockGetCustomerBalance = vi.fn();
const mockApprove = vi.fn();
const mockIssue = vi.fn();
const mockVoid = vi.fn();
const mockApplyToInvoice = vi.fn();
const mockSendEmail = vi.fn();
const mockGetConfig = vi.fn();

vi.mock("../../../service/billingService", () => ({
  creditNoteApi: {
    get: (...args) => mockGet(...args),
    listApplications: (...args) => mockListApplications(...args),
    getTimeline: (...args) => mockGetTimeline(...args),
    listCommunications: (...args) => mockListCommunications(...args),
    getCustomerBalance: (...args) => mockGetCustomerBalance(...args),
    approve: (...args) => mockApprove(...args),
    issue: (...args) => mockIssue(...args),
    void: (...args) => mockVoid(...args),
    applyToInvoice: (...args) => mockApplyToInvoice(...args),
    sendEmail: (...args) => mockSendEmail(...args),
  },
  settingsApi: {
    getConfig: (...args) => mockGetConfig(...args),
  },
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useParams: () => ({ id: "77" }) };
});

import CreditNoteDetailPage from "./credit-note-detail";
import { AuthProvider } from "../../../context/AuthContext";

function baseCreditNote(overrides = {}) {
  return {
    id: 77,
    credit_note_number: "CN-0077",
    status: "draft",
    currency: "USD",
    customer_id: 5,
    customer_name: "Acme Co",
    customer_email: "acme@example.com",
    subtotal: 100,
    discount_amount: 0,
    tax_amount: 10,
    total_amount: 110,
    remaining_amount: 110,
    reason: "Service issue",
    credit_note_type: "service_credit",
    issue_date: "2026-01-01",
    invoice_id: null,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <CreditNoteDetailPage />
      </AuthProvider>
    </MemoryRouter>
  );
}

async function loadPage(overrides = {}) {
  const cn = baseCreditNote(overrides);
  mockGet.mockResolvedValue(cn);
  mockListApplications.mockResolvedValue([]);
  mockGetTimeline.mockResolvedValue({ entries: [] });
  mockListCommunications.mockResolvedValue([]);
  mockGetCustomerBalance.mockResolvedValue(null);
  mockGetConfig.mockResolvedValue({ relationship_terminology: "customer" });
  renderPage();
  await screen.findByRole("heading", { name: "CN-0077" });
  return cn;
}

// Approve is gated to finance_approver/super_admin (maker-checker); AuthProvider
// only trusts the stored user once an access token is also present.
function signInAs(role) {
  localStorage.setItem("zoiko_billing_access", "test-token");
  localStorage.setItem("zoiko_billing_user", JSON.stringify({ role }));
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("CreditNoteDetailPage — happy path", () => {
  it("approving a draft credit note fires creditNoteApi.approve exactly once with its id (single click, no confirm gate)", async () => {
    signInAs("finance_approver");
    await loadPage({ status: "draft" });

    const approveBtn = await screen.findByRole("button", { name: "Approve" });
    fireEvent.click(approveBtn);

    await waitFor(() => expect(mockApprove).toHaveBeenCalledTimes(1));
    expect(mockApprove).toHaveBeenCalledWith(77);
  });

  it("an org admin sees why they cannot approve instead of an Approve button that 403s", async () => {
    signInAs("org_admin");
    await loadPage({ status: "draft" });

    expect(screen.getByText(/Approval requires a Finance Approver/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it("issuing an approved credit note fires creditNoteApi.issue exactly once with its id", async () => {
    await loadPage({ status: "approved" });

    const issueBtn = await screen.findByRole("button", { name: "Issue" });
    fireEvent.click(issueBtn);

    await waitFor(() => expect(mockIssue).toHaveBeenCalledTimes(1));
    expect(mockIssue).toHaveBeenCalledWith(77);
  });
});

describe("CreditNoteDetailPage — apply-to-invoice validation", () => {
  it("blocks the API call and shows an error when amount is zero", async () => {
    await loadPage({ status: "issued", remaining_amount: 110 });

    fireEvent.click(screen.getByRole("button", { name: "Apply to Invoice" }));
    // The Invoice ID / Amount labels aren't wired via htmlFor, so address the
    // two number inputs (spinbuttons) by their fixed order in the modal.
    const [invoiceInput, amountInput] = await waitFor(() => screen.getAllByRole("spinbutton"));
    fireEvent.change(invoiceInput, { target: { value: "5" } });
    fireEvent.change(amountInput, { target: { value: "0" } });

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await screen.findByText(/Amount must be greater than 0/i);
    expect(mockApplyToInvoice).not.toHaveBeenCalled();
  });

  it("blocks the API call and shows an error when amount exceeds the remaining credit balance", async () => {
    await loadPage({ status: "issued", remaining_amount: 110 });

    fireEvent.click(screen.getByRole("button", { name: "Apply to Invoice" }));
    const [invoiceInput, amountInput] = await waitFor(() => screen.getAllByRole("spinbutton"));
    fireEvent.change(invoiceInput, { target: { value: "5" } });
    fireEvent.change(amountInput, { target: { value: "999" } });

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await screen.findByText(/cannot exceed the remaining credit balance/i);
    expect(mockApplyToInvoice).not.toHaveBeenCalled();
  });

  it("applies with valid amount and calls creditNoteApi.applyToInvoice exactly once with the expected args", async () => {
    await loadPage({ status: "issued", remaining_amount: 110 });

    fireEvent.click(screen.getByRole("button", { name: "Apply to Invoice" }));
    const [invoiceInput, amountInput] = await waitFor(() => screen.getAllByRole("spinbutton"));
    fireEvent.change(invoiceInput, { target: { value: "5" } });
    fireEvent.change(amountInput, { target: { value: "50" } });

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(mockApplyToInvoice).toHaveBeenCalledTimes(1));
    expect(mockApplyToInvoice).toHaveBeenCalledWith(77, { invoice_id: 5, amount: 50 });
  });
});

describe("CreditNoteDetailPage — void has no confirmation gate", () => {
  it("clicking 'Void Credit Note' in the modal fires creditNoteApi.void immediately — no typed confirmation, MFA, or step-up is required", async () => {
    await loadPage({ status: "issued" });

    // Opens a plain Modal; the reason textarea is explicitly optional
    // ("Reason (optional)") and there is no second confirmation step.
    fireEvent.click(screen.getByRole("button", { name: "Void" }));
    await screen.findByText(/Are you sure you want to void/i);

    fireEvent.click(screen.getByRole("button", { name: "Void Credit Note" }));

    await waitFor(() => expect(mockVoid).toHaveBeenCalledTimes(1));
    expect(mockVoid).toHaveBeenCalledWith(77, undefined);
  });
});
