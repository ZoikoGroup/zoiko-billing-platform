import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NotificationsPage from "./NotificationsPage";
import * as commandCenterService from "../../service/commandCenterService";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

describe("NotificationsPage read-only attention feed", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders an open attention item with its real status", async () => {
    vi.spyOn(commandCenterService, "getTriageSummary").mockResolvedValue({
      incidents: { top_items: [{
        id: 101, title: "Database latency spike", severity: "p1", status: "open",
        opened_at: new Date().toISOString(), acknowledged_at: null, occurrence_count: 1,
      }] },
      critical_events: [],
    });

    render(<MemoryRouter><NotificationsPage /></MemoryRouter>);

    expect(await screen.findByText("Database latency spike")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
  });

  it("navigates to Triage when an item is clicked without acknowledging it", async () => {
    vi.spyOn(commandCenterService, "getTriageSummary").mockResolvedValue({
      incidents: { top_items: [{
        id: 102, title: "Worker node offline", severity: "p0", status: "open",
        opened_at: new Date().toISOString(), acknowledged_at: null, occurrence_count: 1,
      }] },
      critical_events: [],
    });
    const ackSpy = vi.spyOn(commandCenterService, "acknowledgeAttentionItem").mockResolvedValue({});

    render(<MemoryRouter><NotificationsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText("Worker node offline"));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/super-admin/triage"));
    expect(ackSpy).not.toHaveBeenCalled();
  });

  it("renders an acknowledged item with its real status and does not acknowledge on click", async () => {
    vi.spyOn(commandCenterService, "getTriageSummary").mockResolvedValue({
      incidents: { top_items: [{
        id: 103, title: "Memory usage warning", severity: "p2", status: "acknowledged",
        opened_at: new Date().toISOString(), acknowledged_at: new Date().toISOString(), occurrence_count: 1,
      }] },
      critical_events: [],
    });
    const ackSpy = vi.spyOn(commandCenterService, "acknowledgeAttentionItem").mockResolvedValue({});

    render(<MemoryRouter><NotificationsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByText("Memory usage warning"));

    expect(screen.getByText("Acknowledged")).toBeTruthy();
    expect(ackSpy).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/super-admin/triage");
  });
});
