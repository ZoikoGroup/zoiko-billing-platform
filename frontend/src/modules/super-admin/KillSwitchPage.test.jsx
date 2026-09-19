import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// This page is the platform-wide billing kill switch — a Super Admin-only,
// high-blast-radius control. DISABLING commercial charging is the risky
// direction (it blocks new revenue-generating subscription activity
// platform-wide), so the component gates it behind a typed confirmation
// phrase ("DISABLE CHARGING") in addition to a required audit reason.
// Re-enabling charging only requires a reason — there is no typed
// confirmation on that path (see DISABLE_CONFIRMATION_PHRASE / the
// `requiresTypedConfirmation = !targetEnabled` check in KillSwitchPage.jsx).

const mockGetBillingKillSwitch = vi.fn();
const mockSetBillingKillSwitch = vi.fn();

vi.mock("../../service/commercialService", () => ({
  getBillingKillSwitch: (...args) => mockGetBillingKillSwitch(...args),
  setBillingKillSwitch: (...args) => mockSetBillingKillSwitch(...args),
}));

// useIsDesktopViewport reads window.matchMedia. jsdom's global polyfill
// (src/test/setup.js) defaults `matches` to false, which would route this
// page down the MobileWriteBlock branch and hide the toggle entirely. Mock
// the hook directly so tests get a stable, explicit viewport per-test.
const mockUseIsDesktopViewport = vi.fn(() => true);
vi.mock("../../hooks/useIsDesktopViewport", () => ({
  default: () => mockUseIsDesktopViewport(),
}));

import KillSwitchPage from "./KillSwitchPage";

const DISABLE_PHRASE = "DISABLE CHARGING";

function enabledState(overrides = {}) {
  return {
    id: 2,
    scope: "commercial_subscription_charging",
    enabled: true,
    reason: null,
    changed_at: null,
    changed_by_email: null,
    ...overrides,
  };
}

function disabledState(overrides = {}) {
  return {
    id: 2,
    scope: "commercial_subscription_charging",
    enabled: false,
    reason: "Prior incident",
    changed_at: "2026-01-01T00:00:00Z",
    changed_by_email: "ops@zoikogroup.com",
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <KillSwitchPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockUseIsDesktopViewport.mockReturnValue(true);
});

describe("Disabling charging (the risky direction) requires the exact typed phrase", () => {
  it("does NOT call setBillingKillSwitch when the confirmation field is left empty", async () => {
    mockGetBillingKillSwitch.mockResolvedValue(enabledState());
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Disable charging" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText(/reason/i), {
      target: { value: "Suspicious billing activity detected" },
    });
    // Confirmation field left empty.

    const submitBtn = within(dialog).getByRole("button", { name: "Disable charging" });
    expect(submitBtn).toBeDisabled();

    fireEvent.click(submitBtn);

    expect(mockSetBillingKillSwitch).not.toHaveBeenCalled();
  });

  it.each([
    ["a lowercase near-miss", "disable charging"],
    ["a misspelled near-miss", "DISABLE CHARGNG"],
    ["a trailing-space near-miss", "DISABLE CHARGING "],
  ])("does NOT call setBillingKillSwitch for %s", async (_label, typedValue) => {
    mockGetBillingKillSwitch.mockResolvedValue(enabledState());
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Disable charging" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText(/reason/i), {
      target: { value: "Suspicious billing activity detected" },
    });
    fireEvent.change(within(dialog).getByPlaceholderText(DISABLE_PHRASE), {
      target: { value: typedValue },
    });

    const submitBtn = within(dialog).getByRole("button", { name: "Disable charging" });
    expect(submitBtn).toBeDisabled();

    fireEvent.click(submitBtn);

    expect(mockSetBillingKillSwitch).not.toHaveBeenCalled();
  });

  it("calls setBillingKillSwitch(false, reason) exactly once after the exact phrase is typed", async () => {
    mockGetBillingKillSwitch.mockResolvedValue(enabledState());
    mockSetBillingKillSwitch.mockResolvedValue(disabledState({ reason: "Suspicious billing activity detected" }));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Disable charging" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText(/reason/i), {
      target: { value: "Suspicious billing activity detected" },
    });
    fireEvent.change(within(dialog).getByPlaceholderText(DISABLE_PHRASE), {
      target: { value: DISABLE_PHRASE },
    });

    const submitBtn = within(dialog).getByRole("button", { name: "Disable charging" });
    expect(submitBtn).not.toBeDisabled();

    fireEvent.click(submitBtn);

    await waitFor(() => expect(mockSetBillingKillSwitch).toHaveBeenCalledTimes(1));
    expect(mockSetBillingKillSwitch).toHaveBeenCalledWith(false, "Suspicious billing activity detected");

    // Modal closes and the page reflects the new (disabled) state + success notice.
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText(/commercial charging disabled/i)).toBeInTheDocument();
  });

  it("still requires a reason even once the phrase is typed correctly", async () => {
    mockGetBillingKillSwitch.mockResolvedValue(enabledState());
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Disable charging" }));
    const dialog = await screen.findByRole("dialog");

    // Reason left blank; only the confirmation phrase is filled in.
    fireEvent.change(within(dialog).getByPlaceholderText(DISABLE_PHRASE), {
      target: { value: DISABLE_PHRASE },
    });

    const submitBtn = within(dialog).getByRole("button", { name: "Disable charging" });
    expect(submitBtn).toBeDisabled();

    fireEvent.click(submitBtn);

    expect(mockSetBillingKillSwitch).not.toHaveBeenCalled();
  });
});

describe("Re-enabling charging (symmetric flow, no typed confirmation)", () => {
  it("has no confirmation-phrase input at all", async () => {
    mockGetBillingKillSwitch.mockResolvedValue(disabledState());
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Re-enable charging" }));
    const dialog = await screen.findByRole("dialog");

    expect(within(dialog).queryByPlaceholderText(DISABLE_PHRASE)).not.toBeInTheDocument();
  });

  it("calls setBillingKillSwitch(true, reason) exactly once once a reason is given", async () => {
    mockGetBillingKillSwitch.mockResolvedValue(disabledState());
    mockSetBillingKillSwitch.mockResolvedValue(enabledState({ reason: "Incident resolved" }));
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Re-enable charging" }));
    const dialog = await screen.findByRole("dialog");

    fireEvent.change(within(dialog).getByLabelText(/reason/i), {
      target: { value: "Incident resolved" },
    });

    const submitBtn = within(dialog).getByRole("button", { name: "Re-enable charging" });
    expect(submitBtn).not.toBeDisabled();

    fireEvent.click(submitBtn);

    await waitFor(() => expect(mockSetBillingKillSwitch).toHaveBeenCalledTimes(1));
    expect(mockSetBillingKillSwitch).toHaveBeenCalledWith(true, "Incident resolved");
    expect(await screen.findByText(/commercial charging re-enabled/i)).toBeInTheDocument();
  });

  it("does NOT call setBillingKillSwitch without a reason", async () => {
    mockGetBillingKillSwitch.mockResolvedValue(disabledState());
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "Re-enable charging" }));
    const dialog = await screen.findByRole("dialog");

    const submitBtn = within(dialog).getByRole("button", { name: "Re-enable charging" });
    expect(submitBtn).toBeDisabled();

    fireEvent.click(submitBtn);

    expect(mockSetBillingKillSwitch).not.toHaveBeenCalled();
  });
});

describe("Mobile viewport blocks the write action entirely (ZB-SA-CMD-003 §17)", () => {
  it("renders MobileWriteBlock instead of the toggle button below the desktop breakpoint", async () => {
    mockUseIsDesktopViewport.mockReturnValue(false);
    mockGetBillingKillSwitch.mockResolvedValue(enabledState());
    renderPage();

    await screen.findByText(/enabled/i);
    expect(screen.queryByRole("button", { name: "Disable charging" })).not.toBeInTheDocument();
    expect(screen.getByRole("note", { name: /desktop viewport/i })).toBeInTheDocument();
  });
});
