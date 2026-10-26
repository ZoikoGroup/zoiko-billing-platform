import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("../api/client", () => ({ apiFetch }));

import UsersPage from "./UsersPage";

// Regression: OrgSelect hands its onChange the selected VALUE, but the invite
// form wired it to an event handler that read e.target.type — so choosing any
// organization threw "Cannot read properties of undefined (reading 'type')"
// and replaced the whole page with a render error.

function mockApi() {
  apiFetch.mockImplementation((path) => {
    if (path === "/api/auth/me") return Promise.resolve({ id: 1 });
    if (path === "/api/super-admin/users") return Promise.resolve({ users: [], total: 0 });
    if (path === "/api/super-admin/organizations") {
      return Promise.resolve({
        organizations: [
          { id: 7, organization_name: "Rugvedh", organization_code: "RU" },
          { id: 8, organization_name: "TCS", organization_code: "TC" },
        ],
      });
    }
    if (path === "/api/super-admin/users/invite") return Promise.resolve({ invite_email_sent: true });
    return Promise.resolve({});
  });
}

describe("UsersPage invite tenant administrator", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    mockApi();
  });

  it("selects an organization without crashing and invites into it", async () => {
    render(<UsersPage />);
    // The header button (the empty roster also offers one).
    fireEvent.click((await screen.findAllByRole("button", { name: /Invite Organization Admin/i }))[0]);
    const dialog = await screen.findByRole("dialog");

    const org = within(dialog).getByLabelText(/^Organization/i, { selector: "select" });
    await waitFor(() => expect(within(dialog).getByRole("option", { name: "TCS (TC)" })).toBeInTheDocument());
    fireEvent.change(org, { target: { value: "8" } });
    expect(org).toHaveValue("8");

    fireEvent.change(within(dialog).getByLabelText(/^Email/i), { target: { value: "admin@tcs.example" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create invitation/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/api/super-admin/users/invite",
        expect.objectContaining({
          method: "POST",
          body: expect.objectContaining({ organization_id: 8, email: "admin@tcs.example" }),
        })
      )
    );
  });
});
