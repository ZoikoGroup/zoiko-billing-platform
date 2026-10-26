import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("../api/client", () => ({ apiFetch }));

import UsersPage from "./UsersPage";

const ORG_ADMIN_ROW = {
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

function mockApi() {
  apiFetch.mockImplementation((path) => {
    if (path === "/api/auth/me") return Promise.resolve({ id: 1 });
    if (path === "/api/super-admin/users") return Promise.resolve({ users: [ORG_ADMIN_ROW], total: 1 });
    if (path === "/api/super-admin/organizations/5/purge") {
      return Promise.resolve({
        message: 'Organization "Acme Inc." (ACME01) and all of its data were permanently deleted.',
      });
    }
    return Promise.resolve({});
  });
}

async function openPurgeModal() {
  render(<UsersPage />);
  await waitFor(() => expect(screen.getByText("Acme Inc.")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /Actions for jane@acme.com/i }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Delete organization permanently/i }));
  await screen.findByText("Delete organization permanently");
}

describe("UsersPage organization hard-delete", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    mockApi();
  });

  it("requires the exact organization code before enabling the delete", async () => {
    await openPurgeModal();

    fireEvent.change(screen.getByLabelText(/^Reason/i), { target: { value: "Removing a demo tenant" } });
    fireEvent.change(screen.getByLabelText(/Type ACME01 to confirm/i), { target: { value: "wrong-code" } });
    expect(screen.getByRole("button", { name: /^Delete organization$/i })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type ACME01 to confirm/i), { target: { value: "ACME01" } });
    expect(screen.getByRole("button", { name: /^Delete organization$/i })).toBeEnabled();
  });

  it("posts to the purge endpoint with the reason and confirmation", async () => {
    await openPurgeModal();

    fireEvent.change(screen.getByLabelText(/^Reason/i), { target: { value: "Removing a demo tenant" } });
    fireEvent.change(screen.getByLabelText(/Type ACME01 to confirm/i), { target: { value: "ACME01" } });
    fireEvent.click(screen.getByRole("button", { name: /^Delete organization$/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        "/api/super-admin/organizations/5/purge",
        expect.objectContaining({
          method: "POST",
          body: { reason: "Removing a demo tenant", confirmation: "ACME01" },
        })
      )
    );
    await waitFor(() => expect(screen.getByText(/permanently deleted/i)).toBeInTheDocument());
  });
});
