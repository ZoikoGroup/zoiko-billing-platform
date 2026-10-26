import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("../api/client", () => ({ apiFetch }));

import UsersPage from "./UsersPage";

const ROW = {
  id: 11,
  first_name: "Jane",
  last_name: "Doe",
  email: "jane@acme.com",
  role: "org_admin",
  organization_id: 5,
  organization_name: "Acme Inc.",
  organization_code: "ACME01",
  derived_status: "active",
  is_active: true,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path) => {
    if (path === "/api/auth/me") return Promise.resolve({ id: 1 });
    if (path === "/api/super-admin/users") return Promise.resolve({ users: [ROW], total: 1 });
    return Promise.resolve({});
  });
});

describe("UsersPage row actions", () => {
  it("lists every action with a readable label instead of bare icons", async () => {
    render(<UsersPage />);
    await waitFor(() => expect(screen.getByText("Acme Inc.")).toBeInTheDocument());
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Actions for jane@acme.com/i }));
    const labels = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(labels).toEqual([
      "Deactivate account",
      "Move to another organization",
      "Send password reset link",
      "Delete organization permanently",
    ]);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("UsersPage filters", () => {
  it("clears search and status in one click", async () => {
    render(<UsersPage />);
    const clear = await screen.findByRole("button", { name: /^Clear filters$/i });
    expect(clear).toBeDisabled();

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "jane" } });
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/api/super-admin/users",
        expect.objectContaining({ params: expect.objectContaining({ search: "jane" }) })
      )
    );
    expect(screen.getAllByRole("button", { name: /^Clear filters$/i })[0]).toBeEnabled();

    fireEvent.click(screen.getAllByRole("button", { name: /^Clear filters$/i })[0]);
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveValue(""));
    expect(screen.getAllByRole("button", { name: /^Clear filters$/i })[0]).toBeDisabled();
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/api/super-admin/users",
      expect.objectContaining({ params: expect.objectContaining({ search: "" }) })
    );
  });
});
