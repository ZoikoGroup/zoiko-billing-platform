import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the Resolve / Promise-to-Pay dialogs on
// dunning-case-detail.jsx (rebuilt on the shared billing-ui Modal).

const mockGetCase = vi.fn();
const mockResolve = vi.fn();
const mockCreatePromise = vi.fn();

vi.mock("../../../service/billingService", () => ({
  dunningApi: {
    getCase: (...args) => mockGetCase(...args),
    getCaseTimeline: () => Promise.resolve({ entries: [] }),
    resolveCase: (...args) => mockResolve(...args),
    escalateCase: vi.fn(),
    closeCase: vi.fn(),
  },
  promiseToPayApi: {
    listByCustomer: () => Promise.resolve([]),
    create: (...args) => mockCreatePromise(...args),
  },
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useParams: () => ({ id: "8" }) };
});

import DunningCaseDetailPage from "./dunning-case-detail";

async function loadPage() {
  mockGetCase.mockResolvedValue({
    id: 8,
    status: "active",
    customer_id: 4,
    customer_name: "Acme",
    invoice_id: 21,
    total_overdue_amount: 300,
    days_overdue: 15,
    current_level: 1,
  });
  render(
    <MemoryRouter>
      <DunningCaseDetailPage />
    </MemoryRouter>
  );
  await screen.findByRole("heading", { name: "Dunning Case #8" });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DunningCaseDetailPage dialogs", () => {
  it("Resolve Dunning Case calls dunningApi.resolveCase with the note and closes", async () => {
    await loadPage();

    fireEvent.click(screen.getByRole("button", { name: /^Resolve$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Resolve Dunning Case" });
    fireEvent.change(within(dialog).getByPlaceholderText(/Resolution note/i), { target: { value: "Paid" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Resolve$/ }));

    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith(8, "Paid"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel closes the Log a Promise to Pay dialog without calling the API", async () => {
    await loadPage();

    fireEvent.click(screen.getByRole("button", { name: /Log Promise to Pay/i }));
    const dialog = await screen.findByRole("dialog", { name: "Log a Promise to Pay" });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Cancel$/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockCreatePromise).not.toHaveBeenCalled();
  });

  // Guards the Save handler: an earlier Modal rebuild dropped its onClick.
  it("Save calls promiseToPayApi.create with the entered promise and closes", async () => {
    await loadPage();

    fireEvent.click(screen.getByRole("button", { name: /Log Promise to Pay/i }));
    const dialog = await screen.findByRole("dialog", { name: "Log a Promise to Pay" });
    fireEvent.change(dialog.querySelector('input[type="number"]'), { target: { value: "150" } });
    fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value: "2026-11-15" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Save/i }));

    await waitFor(() =>
      expect(mockCreatePromise).toHaveBeenCalledWith({
        customer_id: 4,
        invoice_id: 21,
        dunning_case_id: 8,
        promise_amount: 150,
        promise_date: "2026-11-15",
        notes: undefined,
      })
    , { timeout: 500 });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 500 });
  });
});
