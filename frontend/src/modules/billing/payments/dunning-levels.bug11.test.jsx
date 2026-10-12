import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// BUG-11.10: Dunning Levels. "New Level" stayed available after the list
// failed to load, sat in the page body instead of the header actions, and
// the create/edit modal used a fixed two-column grid on narrow screens.

const m = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  dunningApi: { listLevels: (...a) => m.list(...a), deleteLevel: vi.fn(), createLevel: vi.fn(), updateLevel: vi.fn() },
}));
vi.mock("../../../components/HRPage", () => ({
  default: ({ title, actions, children }) => <div><h1>{title}</h1><header data-testid="page-actions">{actions}</header><main>{children}</main></div>,
}));

import DunningLevelsPage from "./dunning-levels";

beforeEach(() => { vi.clearAllMocks(); m.list.mockResolvedValue([]); });
afterEach(() => cleanup());

const renderPage = () => render(<MemoryRouter><DunningLevelsPage /></MemoryRouter>);

describe("BUG-11.10 Dunning levels", () => {
  it("New Level lives in the page-header actions next to Back", async () => {
    renderPage();
    const btn = await screen.findByRole("button", { name: /New Level/ });
    const actions = screen.getByTestId("page-actions");
    expect(actions).toContainElement(btn);
    expect(actions).toContainElement(screen.getByRole("button", { name: /Back/ }));
  });

  it("New Level is hidden while the load error is shown, and returns after a successful retry", async () => {
    m.list.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce([]);
    renderPage();
    expect(await screen.findByText("Couldn't load dunning levels")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New Level/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Try Again/ }));
    expect(await screen.findByRole("button", { name: /New Level/ })).toBeInTheDocument();
  });

  it("modal field grids stack on small screens", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /New Level/ }));
    const dialog = screen.getByRole("dialog", { name: "New Dunning Level" });
    const grids = dialog.querySelectorAll(".grid");
    expect(grids.length).toBe(3);
    grids.forEach((g) => {
      expect(g.className).toContain("grid-cols-1");
      expect(g.className).toContain("sm:grid-cols-2");
    });
    // Validation still gates Create.
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });
});
