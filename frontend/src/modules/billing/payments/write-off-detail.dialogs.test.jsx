import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../../context/AuthContext";

// Smoke tests for the Reverse / Cancel dialogs on write-off-detail.jsx
// (rebuilt on the shared billing-ui Modal).

const mockGet = vi.fn();
const mockReverse = vi.fn();
const mockCancel = vi.fn();

vi.mock("../../../service/billingService", () => ({
  writeOffApi: {
    get: (...args) => mockGet(...args),
    getTimeline: () => Promise.resolve({ entries: [] }),
    getCustomerSummary: () => Promise.resolve(null),
    reverse: (...args) => mockReverse(...args),
    cancel: (...args) => mockCancel(...args),
  },
  settingsApi: {
    getConfig: () => Promise.resolve({ relationship_terminology: "customer" }),
  },
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useParams: () => ({ id: "7" }) };
});

import WriteOffDetailPage from "./write-off-detail";

async function loadPage(status) {
  mockGet.mockResolvedValue({
    id: 7,
    write_off_number: "WO-0007",
    status,
    currency: "USD",
    customer_id: 3,
    customer_name: "Acme",
    amount: 100,
    write_off_type: "bad_debt",
    reason: "Uncollectable",
    created_at: "2026-01-01T00:00:00Z",
  });
  render(
    <AuthProvider>
      <MemoryRouter>
        <WriteOffDetailPage />
      </MemoryRouter>
    </AuthProvider>
  );
  await screen.findByRole("heading", { name: "Write-off WO-0007" });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("WriteOffDetailPage dialogs", () => {
  it("Reverse Write-off requires a reason, calls writeOffApi.reverse, and closes", async () => {
    await loadPage("executed");

    fireEvent.click(screen.getByRole("button", { name: /Reverse Write-off/i }));
    const dialog = await screen.findByRole("dialog", { name: "Reverse Write-off" });
    const confirmBtn = within(dialog).getByRole("button", { name: /Reverse Write-off/i });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText(/Reason for reversal/i), { target: { value: "Customer paid" } });
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(mockReverse).toHaveBeenCalledWith(7, "Customer paid"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel Write-off calls writeOffApi.cancel with the optional reason and closes", async () => {
    await loadPage("draft");

    fireEvent.click(screen.getByRole("button", { name: /Cancel Write-off/i }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel Write-off" });
    fireEvent.change(within(dialog).getByPlaceholderText(/Reason \(optional\)/i), { target: { value: "Raised in error" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Cancel Write-off/i }));

    await waitFor(() => expect(mockCancel).toHaveBeenCalledWith(7, "Raised in error"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Go Back closes the Cancel Write-off dialog without calling the API", async () => {
    await loadPage("approved");

    fireEvent.click(screen.getByRole("button", { name: /Cancel Write-off/i }));
    const dialog = await screen.findByRole("dialog", { name: "Cancel Write-off" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Go Back/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockCancel).not.toHaveBeenCalled();
  });
});
