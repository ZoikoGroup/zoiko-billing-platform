import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import NotificationsPage from "./NotificationsPage";
import * as commandCenterService from "../../service/commandCenterService";
import * as CommandCenterContext from "../../context/CommandCenterContext";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe("NotificationsPage — Bug 1 Read/Unread Status & Acknowledge", () => {
  const mockRefresh = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(CommandCenterContext, "useCommandCenter").mockReturnValue({
      refresh: mockRefresh,
      attentionCounts: { unread: 1, total_open: 2 },
    });
  });

  it("renders open unread attention item with 'Unread' badge", async () => {
    vi.spyOn(commandCenterService, "getTriageSummary").mockResolvedValue({
      incidents: {
        top_items: [
          {
            id: 101,
            title: "Database latency spike",
            severity: "p1",
            status: "open",
            opened_at: new Date().toISOString(),
            acknowledged_at: null,
            occurrence_count: 1,
          },
        ],
      },
      critical_events: [],
    });

    render(
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText("Database latency spike")).toBeTruthy();
    });

    expect(screen.getByText("Unread")).toBeTruthy();
  });

  it("marks unread notification as acknowledged on click, calls acknowledge API and refreshes context", async () => {
    vi.spyOn(commandCenterService, "getTriageSummary").mockResolvedValue({
      incidents: {
        top_items: [
          {
            id: 102,
            title: "Worker node offline",
            severity: "p0",
            status: "open",
            opened_at: new Date().toISOString(),
            acknowledged_at: null,
            occurrence_count: 1,
          },
        ],
      },
      critical_events: [],
    });
    const ackSpy = vi.spyOn(commandCenterService, "acknowledgeAttentionItem").mockResolvedValue({});

    render(
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>
    );

    const itemTitle = await screen.findByText("Worker node offline");
    fireEvent.click(itemTitle);

    await waitFor(() => {
      expect(ackSpy).toHaveBeenCalledWith(102);
      expect(mockRefresh).toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith("/super-admin/triage");
    });
  });

  it("does not call acknowledge API when clicking an already-read notification", async () => {
    vi.spyOn(commandCenterService, "getTriageSummary").mockResolvedValue({
      incidents: {
        top_items: [
          {
            id: 103,
            title: "Memory usage warning",
            severity: "p2",
            status: "acknowledged",
            opened_at: new Date().toISOString(),
            acknowledged_at: new Date().toISOString(),
            occurrence_count: 1,
          },
        ],
      },
      critical_events: [],
    });
    const ackSpy = vi.spyOn(commandCenterService, "acknowledgeAttentionItem").mockResolvedValue({});

    render(
      <MemoryRouter>
        <NotificationsPage />
      </MemoryRouter>
    );

    const itemTitle = await screen.findByText("Memory usage warning");
    expect(screen.getByText("Read")).toBeTruthy();

    fireEvent.click(itemTitle);

    expect(ackSpy).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/super-admin/triage");
  });
});
