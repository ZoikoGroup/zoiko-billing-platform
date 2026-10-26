import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  derived_status: "invited",
  is_active: true,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00Z",
};
const COUNTS = { active: 4, invited: 1, suspended: 2 };

const usersCalls = () => apiFetch.mock.calls.filter(([path]) => path === "/api/super-admin/users");

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation((path) => {
    if (path === "/api/auth/me") return Promise.resolve({ id: 1 });
    if (path === "/api/super-admin/users") return Promise.resolve({ users: [ROW], total: 1, status_counts: COUNTS });
    return Promise.resolve({});
  });
});

describe("UsersPage row actions", () => {
  it("shows every action as a visible, labelled icon button — no ⋯ menu", async () => {
    render(<UsersPage />);
    const row = (await screen.findByText("Jane Doe")).closest("tr");
    expect(within(row).queryByRole("button", { name: /^actions for/i })).not.toBeInTheDocument();
    for (const name of [
      /deactivate account/i,
      /resend invitation email/i,
      /move to another organization/i,
      /send password reset link/i,
      /delete organization "acme inc\." permanently/i,
    ]) {
      expect(within(row).getByRole("button", { name })).toBeVisible();
    }
  });

  it("explains each icon in a tooltip on hover", async () => {
    render(<UsersPage />);
    const row = (await screen.findByText("Jane Doe")).closest("tr");
    fireEvent.mouseEnter(within(row).getByRole("button", { name: /send password reset link/i }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Send password reset link");
  });

  it("shows a failed action as a banner without hiding the roster", async () => {
    render(<UsersPage />);
    const row = (await screen.findByText("Jane Doe")).closest("tr");
    apiFetch.mockImplementationOnce(() => Promise.reject(new Error("mail server down")));
    fireEvent.click(within(row).getByRole("button", { name: /send password reset link/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/mail server down/i);
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
  });
});

describe("UsersPage status tiles and filters", () => {
  it("counts admins by status and filters by the tile clicked", async () => {
    render(<UsersPage />);
    const group = await screen.findByRole("group", { name: /filter by account status/i });
    await waitFor(() => expect(within(group).getByRole("button", { name: /all admins\s*7/i })).toBeInTheDocument());
    expect(within(group).getByRole("button", { name: /invited\s*1/i })).toBeInTheDocument();

    fireEvent.click(within(group).getByRole("button", { name: /deactivated/i }));
    await waitFor(() => expect(usersCalls().at(-1)[1].params.derived_status).toBe("suspended"));
    expect(within(group).getByRole("button", { name: /deactivated/i })).toHaveAttribute("aria-pressed", "true");
  });

  it("clears search and status in one click", async () => {
    render(<UsersPage />);
    const clear = await screen.findByRole("button", { name: /^Clear filters$/i });
    expect(clear).toBeDisabled();

    fireEvent.click(within(screen.getByRole("group", { name: /filter by account status/i })).getByRole("button", { name: /invited/i }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "jane" } });
    await waitFor(() => expect(usersCalls().at(-1)[1].params.search).toBe("jane"));
    expect(screen.getAllByRole("button", { name: /^Clear filters$/i })[0]).toBeEnabled();

    fireEvent.click(screen.getAllByRole("button", { name: /^Clear filters$/i })[0]);
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveValue(""));
    await waitFor(() => {
      const params = usersCalls().at(-1)[1].params;
      expect(params.search).toBe("");
      expect(params.derived_status).toBeUndefined();
    });
    expect(screen.getAllByRole("button", { name: /^Clear filters$/i })[0]).toBeDisabled();
  });

  it("scrolls with the page, not inside a nested table scroll box", async () => {
    render(<UsersPage />);
    await screen.findByText("Jane Doe");
    expect(screen.queryByRole("region", { name: /data table, scrollable/i })).not.toBeInTheDocument();
  });
});
