import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { platformSelfServiceApi } = vi.hoisted(() => ({
  platformSelfServiceApi: {
    getWorkspaceUsage: vi.fn(),
  },
}));
vi.mock("../../service/platformSelfServiceApi", () => ({ platformSelfServiceApi }));

import WorkspaceUsagePage from "./WorkspaceUsagePage";

const USAGE = {
  subscription: { id: 7, status: "trialing" },
  plan_code: "STARTER",
  plan_name: "Starter Plan",
  counters: [
    {
      id: 1,
      entitlement_key: "billing.customers.limit",
      window_key: "month",
      count: 230,
      soft_warned_at: null,
      updated_at: "2026-09-06T10:00:00Z",
      limit: 250,
      enforcement_type: "hard",
    },
    {
      id: 2,
      entitlement_key: "billing.users.limit",
      window_key: "month",
      count: 3,
      soft_warned_at: null,
      updated_at: "2026-09-06T09:00:00Z",
      limit: null,
      enforcement_type: null,
    },
  ],
};

beforeEach(() => vi.clearAllMocks());

afterEach(() => platformSelfServiceApi.getWorkspaceUsage.mockReset());

describe("WorkspaceUsagePage", () => {
  it("renders real counter rows with resolved limits", async () => {
    platformSelfServiceApi.getWorkspaceUsage.mockResolvedValue(USAGE);
    render(<WorkspaceUsagePage />);
    await waitFor(() => expect(screen.getByText(/billing.customers.limit/i)).toBeInTheDocument());
    expect(screen.getByText("230")).toBeInTheDocument();
    expect(screen.getByText("250")).toBeInTheDocument();
    expect(screen.getByText("92%")).toBeInTheDocument();
    expect(screen.getByText("Approaching limit")).toBeInTheDocument();
  });

  it("flags over-limit keys red and unknown limits honestly", async () => {
    platformSelfServiceApi.getWorkspaceUsage.mockResolvedValue({
      ...USAGE,
      counters: [
        { id: 1, entitlement_key: "billing.customers.limit", window_key: "month", count: 260, limit: 250, enforcement_type: "hard" },
      ],
    });
    render(<WorkspaceUsagePage />);
    await waitFor(() => expect(screen.getByText("Over limit")).toBeInTheDocument());
    expect(screen.getByText("104%")).toBeInTheDocument();
  });

  it("shows an honest empty state when no counter rows exist", async () => {
    platformSelfServiceApi.getWorkspaceUsage.mockResolvedValue({
      ...USAGE,
      counters: [],
    });
    render(<WorkspaceUsagePage />);
    await waitFor(() => expect(screen.getByText("No tracked usage yet")).toBeInTheDocument());
  });

  it("handles a failed read with an error state", async () => {
    platformSelfServiceApi.getWorkspaceUsage.mockRejectedValue(new Error("Usage service unavailable"));
    render(<WorkspaceUsagePage />);
    await waitFor(() => expect(screen.getByText(/usage service unavailable/i)).toBeInTheDocument());
  });
});