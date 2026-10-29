import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke test for the New Dunning Level create dialog (rebuilt on the shared
// billing-ui Modal). Delete-confirm is covered in dunning-levels.batch3.test.jsx
// and the Create disabled gate in dunning-levels.bug11.test.jsx.

const m = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  dunningApi: { listLevels: (...a) => m.list(...a), createLevel: (...a) => m.create(...a), deleteLevel: vi.fn(), updateLevel: vi.fn() },
}));

import DunningLevelsPage from "./dunning-levels";

beforeEach(() => { vi.clearAllMocks(); m.list.mockResolvedValue([]); m.create.mockResolvedValue({ id: 1 }); });
afterEach(() => cleanup());

describe("DunningLevelsPage — New Dunning Level dialog", () => {
  it("New Level → fill → Create calls dunningApi.createLevel and closes", async () => {
    render(<MemoryRouter><DunningLevelsPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole("button", { name: /New Level/ }));
    const dialog = await screen.findByRole("dialog", { name: "New Dunning Level" });
    fireEvent.change(within(dialog).getByLabelText(/Level Number/), { target: { value: "1" } });
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: "Friendly Reminder" } });
    fireEvent.change(within(dialog).getByLabelText(/Min Days Overdue/), { target: { value: "5" } });
    fireEvent.change(within(dialog).getByLabelText(/Max Days Overdue/), { target: { value: "15" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(m.create).toHaveBeenCalledWith({
        level_number: 1,
        name: "Friendly Reminder",
        min_days_overdue: 5,
        max_days_overdue: 15,
        action_type: "email_reminder",
        action_template: undefined,
        fee_amount: 0,
        fee_percentage: 0,
      })
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
