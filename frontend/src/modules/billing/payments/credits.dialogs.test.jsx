import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the Void Credit Note dialog on credits.jsx (rebuilt on
// the shared billing-ui Modal).

const mockList = vi.fn();
const mockVoid = vi.fn();

vi.mock("../../../service/billingService", () => ({
  creditNoteApi: {
    list: (...args) => mockList(...args),
    void: (...args) => mockVoid(...args),
    approve: vi.fn(),
    issue: vi.fn(),
  },
  settingsApi: {
    getConfig: () => Promise.resolve({ base_currency: "USD" }),
  },
}));

import CreditsPage from "./credits";

async function loadPage() {
  mockList.mockResolvedValue({
    items: [{ id: 31, credit_note_number: "CN-0031", status: "issued", customer_name: "Acme", total_amount: 40, remaining_amount: 40, currency: "USD" }],
    total: 1,
  });
  render(
    <MemoryRouter>
      <CreditsPage />
    </MemoryRouter>
  );
  await screen.findByText("CN-0031");
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CreditsPage — Void Credit Note dialog", () => {
  it("Void calls creditNoteApi.void with the id and reason, then closes", async () => {
    mockVoid.mockResolvedValue({});
    await loadPage();

    fireEvent.click(screen.getByRole("button", { name: /^Void$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Void Credit Note" });
    fireEvent.change(within(dialog).getByPlaceholderText(/reason for voiding/i), { target: { value: "Issued twice" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Void$/ }));

    await waitFor(() => expect(mockVoid).toHaveBeenCalledWith(31, "Issued twice"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel closes the Void Credit Note dialog without calling the API", async () => {
    await loadPage();

    fireEvent.click(screen.getByRole("button", { name: /^Void$/ }));
    const dialog = await screen.findByRole("dialog", { name: "Void Credit Note" });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Cancel$/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockVoid).not.toHaveBeenCalled();
  });
});
