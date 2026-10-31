import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the Assign / Log Action / Resolve dialogs on
// collections-case-detail.jsx (rebuilt on the shared billing-ui Modal).

const mockGetCase = vi.fn();
const mockAssign = vi.fn();
const mockLogAction = vi.fn();
const mockResolve = vi.fn();

vi.mock("../../../service/billingService", () => ({
  collectionApi: {
    getCase: (...args) => mockGetCase(...args),
    getCaseTimeline: () => Promise.resolve({ entries: [] }),
    assignCase: (...args) => mockAssign(...args),
    logAction: (...args) => mockLogAction(...args),
    resolveCase: (...args) => mockResolve(...args),
    escalateCase: vi.fn(),
    closeCase: vi.fn(),
  },
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useParams: () => ({ id: "5" }) };
});

import CollectionsCaseDetailPage from "./collections-case-detail";

async function loadPage() {
  mockGetCase.mockResolvedValue({
    id: 5,
    case_number: "COL-0005",
    status: "open",
    customer_id: 2,
    customer_name: "Acme",
    invoice_id: 11,
    total_outstanding: 500,
    amount_collected: 0,
    days_overdue: 30,
    priority: "high",
  });
  render(
    <MemoryRouter>
      <CollectionsCaseDetailPage />
    </MemoryRouter>
  );
  await screen.findByRole("heading", { name: "COL-0005" });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CollectionsCaseDetailPage dialogs", () => {
  it("Assign Case requires an employee id, calls assignCase with it as a number, and closes", async () => {
    await loadPage();

    fireEvent.click(screen.getByRole("button", { name: /^Assign$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Assign Case" });
    const confirmBtn = within(dialog).getByRole("button", { name: /^Assign$/ });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText("Employee ID"), { target: { value: "12" } });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(mockAssign).toHaveBeenCalledWith(5, 12));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Log Collection Action calls logAction with description/outcome and closes", async () => {
    await loadPage();

    fireEvent.click(screen.getByRole("button", { name: /Log Action/i }));
    const dialog = await screen.findByRole("dialog", { name: "Log Collection Action" });
    fireEvent.change(within(dialog).getByPlaceholderText("What happened?"), { target: { value: "Called AP" } });
    fireEvent.change(within(dialog).getByPlaceholderText("Outcome"), { target: { value: "Will pay Friday" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save/i }));

    await waitFor(() =>
      expect(mockLogAction).toHaveBeenCalledWith(5, { action_type: "phone_call", description: "Called AP", outcome: "Will pay Friday" })
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Resolve Collections Case requires a resolution, calls resolveCase, and closes", async () => {
    await loadPage();

    fireEvent.click(screen.getByRole("button", { name: /^Resolve$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Resolve Collections Case" });
    const confirmBtn = within(dialog).getByRole("button", { name: /^Resolve$/ });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText(/How was this resolved/i), { target: { value: "Paid in full" } });
    fireEvent.change(within(dialog).getByPlaceholderText("0.00"), { target: { value: "250.50" } });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith(5, "Paid in full", 250.5));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel closes the Assign Case dialog without calling the API", async () => {
    await loadPage();

    fireEvent.click(screen.getByRole("button", { name: /^Assign$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Assign Case" });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Cancel$/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockAssign).not.toHaveBeenCalled();
  });
});
