import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import fs from "node:fs";
import SupportAccessPage from "./SupportAccessPage";

const { useAuth } = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock("../../context/AuthContext", () => ({ useAuth }));

const { useCommandCenter } = vi.hoisted(() => ({ useCommandCenter: vi.fn() }));
vi.mock("../../context/CommandCenterContext", () => ({ useCommandCenter }));

vi.mock("../../service/privilegedAccessService", () => ({
  getActivePrivilegedAccess: vi.fn(),
  listMyPrivilegedAccess: vi.fn(),
  getPrivilegedAccessTenantSummary: vi.fn(),
  searchOrganizations: vi.fn(),
  requestPrivilegedAccess: vi.fn(),
  activatePrivilegedAccess: vi.fn(),
  exitPrivilegedAccess: vi.fn(),
  listPendingApprovals: vi.fn(),
  approvePrivilegedAccess: vi.fn(),
  denyPrivilegedAccess: vi.fn(),
  revokePrivilegedAccess: vi.fn(),
  openBreakGlass: vi.fn(),
  reviewBreakGlass: vi.fn(),
  listPendingReviews: vi.fn(),
}));

import * as service from "../../service/privilegedAccessService";

const OUT = "C:/Users/DELL/AppData/Local/Temp/opencode/probe-out.json";
const results = [];

function setDesktop(matches) {
  window.matchMedia = (query) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

function dump(label) {
  const buttons = screen.queryAllByRole("button").map((b) => b.textContent.trim());
  const notes = screen.queryAllByRole("note").map((n) => n.getAttribute("aria-label"));
  const headings = screen.queryAllByRole("heading").map((h) => h.textContent.trim());
  results.push({ label, buttons, notes, headings });
  return buttons;
}

describe("PROBE SupportAccessPage real viewport hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCommandCenter.mockReturnValue({ activeGrant: null, refresh: vi.fn(), clearActiveGrant: vi.fn() });
    service.getActivePrivilegedAccess.mockResolvedValue(null);
    service.listMyPrivilegedAccess.mockResolvedValue({ grants: [] });
    service.listPendingApprovals.mockResolvedValue({ grants: [] });
    service.listPendingReviews.mockResolvedValue({ grants: [] });
  });

  it("A: security_operator desktop", async () => {
    setDesktop(true);
    useAuth.mockReturnValue({ user: { id: 1, platform_role: "security_operator" }, role: "super_admin", isAuthenticated: true });
    render(<MemoryRouter><SupportAccessPage /></MemoryRouter>);
    await waitFor(() => expect(service.listMyPrivilegedAccess).toHaveBeenCalled());
    await waitFor(() => expect(dump("A")).not.toHaveLength(0));
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  });

  it("B: NO platform_role desktop", async () => {
    setDesktop(true);
    useAuth.mockReturnValue({ user: { id: 1, email: "x@y.com" }, role: "super_admin", isAuthenticated: true });
    render(<MemoryRouter><SupportAccessPage /></MemoryRouter>);
    await waitFor(() => expect(service.listMyPrivilegedAccess).toHaveBeenCalled());
    await waitFor(() => expect(dump("B")).not.toHaveLength(0)).catch(() => {});
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  });

  it("C: security_operator mobile", async () => {
    setDesktop(false);
    useAuth.mockReturnValue({ user: { id: 1, platform_role: "security_operator" }, role: "super_admin", isAuthenticated: true });
    render(<MemoryRouter><SupportAccessPage /></MemoryRouter>);
    await waitFor(() => expect(service.listMyPrivilegedAccess).toHaveBeenCalled());
    await waitFor(() => expect(dump("C")).not.toHaveLength(0)).catch(() => {});
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  });
});
