import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Smoke tests for the incident detail dialog on /super-admin/triage.

const m = vi.hoisted(() => ({ getTriageSummary: vi.fn(), acknowledgeAttentionItem: vi.fn() }));
vi.mock("../../service/commandCenterService", () => ({
  getTriageSummary: (...a) => m.getTriageSummary(...a),
  acknowledgeAttentionItem: (...a) => m.acknowledgeAttentionItem(...a),
  assignAttentionItem: vi.fn(),
  transitionAttentionItem: vi.fn(),
  suppressAttentionItem: vi.fn(),
  listAttentionItems: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../../service/privilegedAccessService", () => ({
  getJobTelemetry: vi.fn(() => Promise.resolve({ jobs: [] })),
  retryJob: vi.fn(),
}));

import TriagePage from "./TriagePage";

const INCIDENT = {
  id: 11, title: "Stripe webhook backlog", severity: "p1", status: "open", description: "Queue depth rising",
  source: "webhooks", source_key: "stripe", occurrence_count: 4, opened_at: "2026-10-30T08:00:00Z", correlation_id: "corr-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.getTriageSummary.mockResolvedValue({
    incidents: { counts: { p0: 0, p1: 1, total_open: 1, sla_breaches: 0 }, top_items: [INCIDENT] },
    safety_controls: [],
  });
  m.acknowledgeAttentionItem.mockResolvedValue({});
});
afterEach(() => cleanup());

const openIncident = async () => {
  render(<MemoryRouter initialEntries={["/super-admin/triage"]}><TriagePage /></MemoryRouter>);
  fireEvent.click(await screen.findByText(INCIDENT.title));
  return screen.findByRole("dialog", { name: INCIDENT.title });
};

describe("Triage incident dialog", () => {
  it("Acknowledge calls the API and closes", async () => {
    const dialog = await openIncident();
    fireEvent.click(within(dialog).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(m.acknowledgeAttentionItem).toHaveBeenCalledWith(11));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("footer Close closes", async () => {
    const dialog = await openIncident();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(m.acknowledgeAttentionItem).not.toHaveBeenCalled();
  });

  it("Esc closes", async () => {
    await openIncident();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
