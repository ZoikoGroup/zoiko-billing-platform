import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the Invite User dialog on /organization-admin/users.

const m = vi.hoisted(() => ({ inviteUser: vi.fn() }));
vi.mock("../../service/userManagementService", () => ({
  listUsers: vi.fn(() => Promise.resolve({ users: [], total: 0 })),
  getUserSummary: vi.fn(() => Promise.resolve({ total: 0, active: 0, pending: 0, suspended: 0, invited: 0 })),
  inviteUser: (...a) => m.inviteUser(...a),
  updateUser: vi.fn(), deactivateUser: vi.fn(), resendInvite: vi.fn(),
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: () => ({ user: { id: 1, role: "org_admin" } }) }));

import UserManagementPage from "./UserManagementPage";

beforeEach(() => {
  vi.clearAllMocks();
  m.inviteUser.mockResolvedValue({ id: 5, invite_email_sent: true });
});
afterEach(() => cleanup());

const openInvite = async () => {
  render(<MemoryRouter><UserManagementPage /></MemoryRouter>);
  const [trigger] = await screen.findAllByRole("button", { name: /Invite User/ });
  fireEvent.click(trigger);
  return screen.findByRole("dialog", { name: "Invite User" });
};

describe("Invite User dialog", () => {
  it("Send Invite calls inviteUser with the form and closes", async () => {
    const dialog = await openInvite();
    // Labels aren't tied to inputs: first name, last name, email, phone.
    const [first, last, email] = within(dialog).getAllByRole("textbox");
    fireEvent.change(first, { target: { value: "Ada" } });
    fireEvent.change(last, { target: { value: "Lovelace" } });
    fireEvent.change(email, { target: { value: "ada@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send Invite" }));

    await waitFor(() => expect(m.inviteUser).toHaveBeenCalledWith(
      expect.objectContaining({ first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", send_invite: true })
    ));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invite User" })).toBeNull());
  });

  it("Cancel closes without inviting", async () => {
    const dialog = await openInvite();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invite User" })).toBeNull());
    expect(m.inviteUser).not.toHaveBeenCalled();
  });
});
