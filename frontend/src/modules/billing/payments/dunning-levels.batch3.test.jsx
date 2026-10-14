import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Batch 3 / N: Dunning Levels. Delete was one unconfirmed click, and a failed
// load showed "No dunning levels configured" (inviting duplicates) with no
// retry. The Batch 1 edit flow is covered by dunning-levels.edit.test.jsx.

const m = vi.hoisted(() => ({ list: vi.fn(), del: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  dunningApi: { listLevels: (...a) => m.list(...a), deleteLevel: (...a) => m.del(...a), createLevel: vi.fn(), updateLevel: vi.fn() },
}));
vi.mock("../../../components/HRPage", () => ({
  default: ({ title, actions, children }) => <div><h1>{title}</h1>{actions}{children}</div>,
}));

import DunningLevelsPage from "./dunning-levels";

const LEVEL = { id: 7, level_number: 2, name: "Firm Reminder", min_days_overdue: 8, max_days_overdue: 15, action_type: "email", fee_amount: "0", fee_percentage: "0" };

beforeEach(() => { vi.clearAllMocks(); m.list.mockResolvedValue([LEVEL]); m.del.mockResolvedValue({}); });
afterEach(() => cleanup());

const renderPage = () => render(<MemoryRouter><DunningLevelsPage /></MemoryRouter>);

describe("N. Dunning levels", () => {
  it("delete asks for confirmation; cancel deletes nothing", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Delete level 2" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete dunning level" });
    expect(dialog).toHaveTextContent('Delete Level 2 "Firm Reminder"?');
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.del).not.toHaveBeenCalled();
  });

  it("confirming deletes and reloads", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Delete level 2" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Delete dunning level" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(m.del).toHaveBeenCalledWith(7));
    await waitFor(() => expect(m.list).toHaveBeenCalledTimes(2));
  });

  it("a failed load shows a retryable error, not the empty state", async () => {
    m.list.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce([LEVEL]);
    renderPage();
    expect(await screen.findByText("Couldn't load dunning levels")).toBeInTheDocument();
    expect(screen.queryByText("No dunning levels configured")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /try again|retry/i }));
    expect(await screen.findByText("Firm Reminder")).toBeInTheDocument();
  });
});
