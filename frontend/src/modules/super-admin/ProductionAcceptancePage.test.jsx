import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getProductionAcceptanceReport } = vi.hoisted(() => ({ getProductionAcceptanceReport: vi.fn() }));
vi.mock("../../service/commercialService", () => ({ getProductionAcceptanceReport }));

import ProductionAcceptancePage, { AUTO_REFRESH_MS } from "./ProductionAcceptancePage";

const report = (generatedAt = new Date().toISOString()) => ({
  generated_at: generatedAt,
  overall_status: "CONDITIONAL",
  summary: "Conditionally ready. No criteria are failing, but 1 need attention before an unconditional go-live: FIN-02.",
  items: [
    { id: "FIN-02", criterion: "Issued invoices cannot be destructively edited.", status: "WARNING", evidence: "e1" },
    { id: "PAY-01", criterion: "Webhooks verify signatures.", status: "PASS", evidence: "e2" },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  getProductionAcceptanceReport.mockImplementation(() => Promise.resolve(report()));
});
afterEach(() => vi.useRealTimers());

describe("ProductionAcceptancePage", () => {
  it("keeps the Blocking filter clickable at zero and says nothing is blocking", async () => {
    render(<ProductionAcceptancePage embedded />);
    const blocking = await screen.findByRole("button", { name: /blocking/i });
    expect(blocking).toBeEnabled();
    fireEvent.click(blocking);
    expect(screen.getByText(/nothing is blocking go-live/i)).toBeInTheDocument();
    expect(screen.queryByText("FIN-02", { selector: "p" })).not.toBeInTheDocument();
  });

  it("re-runs the assessment on demand without blanking the checklist", async () => {
    render(<ProductionAcceptancePage embedded />);
    await screen.findByRole("button", { name: /re-run now/i });
    expect(screen.getByText(/re-checks automatically every 5 min/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /re-run now/i }));
    expect(screen.getByText("Webhooks verify signatures.")).toBeInTheDocument();
    await waitFor(() => expect(getProductionAcceptanceReport).toHaveBeenCalledTimes(2));
  });

  it("re-runs automatically while the page is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ProductionAcceptancePage embedded />);
    await screen.findByRole("button", { name: /re-run now/i });
    expect(getProductionAcceptanceReport).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(AUTO_REFRESH_MS + 10);
    });
    await waitFor(() => expect(getProductionAcceptanceReport).toHaveBeenCalledTimes(2));
  });

  it("does not show an overall verdict banner", async () => {
    render(<ProductionAcceptancePage embedded />);
    await screen.findByRole("button", { name: /re-run now/i });
    expect(screen.queryByText(/overall verdict/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/conditionally ready/i)).not.toBeInTheDocument();
    // The checklist itself still shows each item's status.
    expect(screen.getByText("Issued invoices cannot be destructively edited.")).toBeInTheDocument();
  });

  it("keeps showing the previous assessment if a re-run fails", async () => {
    render(<ProductionAcceptancePage embedded />);
    await screen.findByRole("button", { name: /re-run now/i });
    getProductionAcceptanceReport.mockRejectedValueOnce(new Error("server busy"));
    fireEvent.click(screen.getByRole("button", { name: /re-run now/i }));
    expect(await screen.findByText(/re-run failed: server busy/i)).toBeInTheDocument();
    expect(screen.getByText("Webhooks verify signatures.")).toBeInTheDocument();
  });
});
