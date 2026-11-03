import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const svc = vi.hoisted(() => ({
  getInvoiceStatusDistribution: vi.fn(),
  getInvoiceDeliveryDiagnostics: vi.fn(),
  listFailedPayments: vi.fn(),
  listDunningCases: vi.fn(),
  listAllocationExceptions: vi.fn(),
  listCreditApplications: vi.fn(),
  listCreditNotesAdmin: vi.fn(),
  listRefundsAdmin: vi.fn(),
  listWriteOffsAdmin: vi.fn(),
  getTaxSummary: vi.fn(),
  listReconciliationRuns: vi.fn(),
  getReconciliationRun: vi.fn(),
  triggerReconciliationRun: vi.fn(),
  acknowledgeReconciliationException: vi.fn(),
  resolveReconciliationException: vi.fn(),
}));
const commercial = vi.hoisted(() => ({ listOrganizations: vi.fn() }));

vi.mock("../../service/commandCenterService", () => svc);
vi.mock("../../service/commercialService", () => commercial);

import useLiveRefresh, { LiveRefreshStatus } from "./useLiveRefresh";
import {
  formatCurrency,
  sumDecimalStrings,
  F1BillingsCard,
  F3IntegrityCard,
  F4LeakageCard,
  TENANT_LIST_LIMIT,
} from "./FinancialSummaryCards";
import InvoiceEnginePage from "./InvoiceEnginePage";
import PaymentsDisputesPage from "./PaymentsDisputesPage";
import TaxEInvoicingPage from "./TaxEInvoicingPage";
import ReconciliationPage, { parseApiUtc } from "./ReconciliationPage";

function setVisibility(state) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.clearAllMocks();
  setVisibility("visible");
  commercial.listOrganizations.mockResolvedValue({ total: 0, organizations: [] });
  svc.listReconciliationRuns.mockResolvedValue({ items: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── useLiveRefresh ───────────────────────────────────────────────────────────

function Probe({ load, opts }) {
  const { lastUpdated, refreshing, refreshError, refresh, hasLoaded } = useLiveRefresh(load, opts);
  return (
    <div>
      <span data-testid="loaded">{String(hasLoaded)}</span>
      <span data-testid="refreshing">{String(refreshing)}</span>
      <span data-testid="error">{refreshError || ""}</span>
      <span data-testid="updated">{lastUpdated ? "yes" : "no"}</span>
      <button type="button" onClick={() => refresh()}>manual</button>
    </div>
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useLiveRefresh", () => {
  it("loads on mount, then refreshes on the interval only while the page is visible", async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.resolve());
    render(<Probe load={load} opts={{ intervalMs: 1000 }} />);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("updated")).toHaveTextContent("yes");

    await act(async () => { vi.advanceTimersByTime(1000); });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    await act(async () => { vi.advanceTimersByTime(5000); });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);

    // Coming back refreshes straight away rather than waiting for the timer.
    await act(async () => { setVisibility("visible"); });
    await flush();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("does not tick while paused, and stops on unmount", async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => Promise.resolve());
    const { rerender, unmount } = render(<Probe load={load} opts={{ intervalMs: 1000, paused: true }} />);
    await flush();
    expect(load).toHaveBeenCalledTimes(1); // the initial load still runs
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(load).toHaveBeenCalledTimes(1);

    rerender(<Probe load={load} opts={{ intervalMs: 1000, paused: false }} />);
    await act(async () => { vi.advanceTimersByTime(1000); });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("aborts the older load when a newer one starts, so an out-of-order response is ignored", async () => {
    const resolvers = [];
    const signals = [];
    const load = vi.fn((signal) => {
      signals.push(signal);
      return new Promise((resolve) => resolvers.push(resolve));
    });
    render(<Probe load={load} opts={{ intervalMs: 60000 }} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "manual" }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    await act(async () => { resolvers[1](); resolvers[0](); });
    expect(screen.getByTestId("refreshing")).toHaveTextContent("false");
  });

  it("keeps the last good state and reports a failed background refresh", async () => {
    let fail = false;
    const load = vi.fn(() => (fail ? Promise.reject(new Error("boom")) : Promise.resolve()));
    render(<Probe load={load} opts={{ intervalMs: 60000 }} />);
    await waitFor(() => expect(screen.getByTestId("updated")).toHaveTextContent("yes"));
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "manual" }));
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("boom"));
    expect(screen.getByTestId("updated")).toHaveTextContent("yes");
  });

  it("LiveRefreshStatus ticks 'Updated Xs ago' and shows the couldn't-refresh note", () => {
    vi.useFakeTimers();
    const now = new Date();
    const onRefresh = vi.fn();
    const { rerender } = render(<LiveRefreshStatus lastUpdated={now} refreshing={false} refreshError={null} onRefresh={onRefresh} />);
    expect(screen.getByTestId("live-refresh-status")).toHaveTextContent("Updated just now");
    act(() => { vi.advanceTimersByTime(12000); });
    expect(screen.getByTestId("live-refresh-status")).toHaveTextContent("Updated 12s ago");
    rerender(<LiveRefreshStatus lastUpdated={now} refreshing={false} refreshError="down" onRefresh={onRefresh} />);
    expect(screen.getByTestId("live-refresh-status")).toHaveTextContent(/Couldn't refresh — showing data from/);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRefresh).toHaveBeenCalled();
  });
});

// ── Money formatting ─────────────────────────────────────────────────────────

describe("money helpers", () => {
  it("renders a missing amount as a dash, not a fabricated 0.00", () => {
    expect(formatCurrency(null)).toBe("—");
    expect(formatCurrency(undefined)).toBe("—");
    expect(formatCurrency("")).toBe("—");
    expect(formatCurrency("abc")).toBe("—");
    expect(formatCurrency("1234.5")).toBe("1,234.50");
  });

  it("uses each currency's own minor units", () => {
    expect(formatCurrency("1000.00", "JPY")).toBe("1,000");
    expect(formatCurrency("1.235", "BHD")).toBe("1.235");
    expect(formatCurrency("10", "UNKNOWN")).toBe("10.00");
  });

  it("sums decimal strings exactly within one currency", () => {
    expect(sumDecimalStrings(["0.1", "0.2"])).toBe("0.3");
    expect(sumDecimalStrings(["10.00", "-2.5", "1"])).toBe("8.50");
    expect(sumDecimalStrings(["1", null])).toBeNull();
  });

  it("does not round a not-fully-collected rate up to 100%", () => {
    render(
      <F1BillingsCard
        billings={{
          currency_state: "single_currency",
          currencies: [{ currency: "USD", invoice_count: 1, invoiced_amount: "1000.00", collected_amount: "996.00", overdue_amount: "4.00", overdue_count: 1 }],
          overdue_count: 1,
          total_invoices: 1,
          invoiced_amount: "1000.00",
          collected_amount: "996.00",
          overdue_amount: "4.00",
        }}
      />
    );
    expect(screen.getByText("99% collected")).toBeInTheDocument();
  });

  it("shows unbilled usage as not measured instead of the backend's hard-coded zero", () => {
    render(<F4LeakageCard leakage={{ over_allocated_count: 0, under_allocated_paid_count: 0, unbilled_usage_anomalies: 0, active_credit_notes_count: 0 }} />);
    expect(screen.getByText("Not measured")).toBeInTheDocument();
  });

  it("no longer claims Stripe reconciliation is not integrated", () => {
    render(<F3IntegrityCard consistency={{ state: "VERIFIED", total_invoices_checked: 3, over_allocated_count: 0 }} />);
    expect(screen.queryByText(/not integrated/i)).not.toBeInTheDocument();
  });
});

// ── Invoice Engine ───────────────────────────────────────────────────────────

describe("InvoiceEnginePage", () => {
  it("never shows the per-status amount, which the backend sums across currencies", async () => {
    svc.getInvoiceStatusDistribution.mockResolvedValue({
      total_invoices: 3,
      buckets: [{ status: "paid", count: 3, total_amount: "150.00" }],
    });
    svc.getInvoiceDeliveryDiagnostics.mockResolvedValue({ sent: 0, delivered: 0, failed: 0, bounced: 0, total: 0 });
    render(<MemoryRouter><InvoiceEnginePage embedded /></MemoryRouter>);
    expect(await screen.findByText(/would mix currencies/i)).toBeInTheDocument();
    expect(screen.queryByText(/150\.00/)).not.toBeInTheDocument();
  });

  it("keeps the loaded data on screen when a later refresh fails", async () => {
    svc.getInvoiceStatusDistribution.mockResolvedValueOnce({
      total_invoices: 2,
      buckets: [{ status: "sent", count: 2, total_amount: "1" }],
    });
    svc.getInvoiceDeliveryDiagnostics.mockResolvedValue({ sent: 1, delivered: 0, failed: 0, bounced: 0, total: 1 });
    render(<MemoryRouter><InvoiceEnginePage embedded /></MemoryRouter>);
    await screen.findByText(/2 invoice\(s\) tracked/);

    svc.getInvoiceStatusDistribution.mockRejectedValueOnce(new Error("db timeout"));
    fireEvent.click(within(screen.getByTestId("live-refresh-status")).getByRole("button"));
    expect(await screen.findByText(/Couldn't refresh this section/)).toBeInTheDocument();
    expect(screen.getByText(/2 invoice\(s\) tracked/)).toBeInTheDocument();
    expect(screen.queryByText("Unable to load status distribution")).not.toBeInTheDocument();
  });
});

// ── Per-tenant tables ────────────────────────────────────────────────────────

describe("per-tenant tables", () => {
  const row = (id, name) => ({
    organization_id: id,
    organization_name: name,
    failed_count: 9,
    failed_count_label: null,
    failed_total_by_currency: {},
    top_failure_reasons: [],
  });

  it("requests the backend maximum and says when the tenant cap is reached", async () => {
    const rows = Array.from({ length: TENANT_LIST_LIMIT }, (_, i) => row(i + 1, `Org ${i + 1}`));
    svc.listFailedPayments.mockResolvedValue({ total: 9999, items: rows });
    svc.listDunningCases.mockResolvedValue({ total: 0, items: [] });
    render(<MemoryRouter><PaymentsDisputesPage embedded /></MemoryRouter>);
    expect(await screen.findByText(/Showing the 200 organizations with the most records/)).toBeInTheDocument();
    expect(svc.listFailedPayments).toHaveBeenCalledWith(200);
  });

  it("filters by organization and offers Clear search when nothing matches", async () => {
    const rows = ["Acme", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"].map((n, i) => row(i + 1, n));
    svc.listFailedPayments.mockResolvedValue({ total: 54, items: rows });
    svc.listDunningCases.mockResolvedValue({ total: 0, items: [] });
    render(<MemoryRouter><PaymentsDisputesPage embedded /></MemoryRouter>);
    const search = await screen.findByRole("searchbox", { name: /search organizations/i });
    fireEvent.change(search, { target: { value: "zzz" } });
    expect(await screen.findByText("No organizations match your search")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Clear search" }).at(-1));
    expect(await screen.findByRole("link", { name: "Acme" })).toBeInTheDocument();
  });
});

// ── Tax ──────────────────────────────────────────────────────────────────────

describe("TaxEInvoicingPage", () => {
  it("totals tax per currency and labels the invoice-less bucket honestly", async () => {
    svc.getTaxSummary.mockResolvedValue({
      total_records: 4,
      buckets: [
        { currency: "USD", jurisdiction: "CA", tax_type: "sales_tax", record_count: 2, taxable_amount: "100.00", tax_amount: "0.10" },
        { currency: "USD", jurisdiction: "NY", tax_type: "sales_tax", record_count: 1, taxable_amount: "100.00", tax_amount: "0.20" },
        { currency: "UNKNOWN", jurisdiction: "UNKNOWN", tax_type: "UNKNOWN", record_count: 1, taxable_amount: "5.00", tax_amount: "1.00" },
      ],
    });
    render(<MemoryRouter><TaxEInvoicingPage embedded /></MemoryRouter>);
    const tiles = await screen.findByLabelText("Tax collected per currency");
    expect(within(tiles).getByText("0.30")).toBeInTheDocument();
    expect(within(tiles).getByText("Currency unknown")).toBeInTheDocument();
    expect(screen.getAllByText("Not linked to an invoice").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sales tax").length).toBe(2);
  });

  it("filters by date and distinguishes an empty range from no data", async () => {
    svc.getTaxSummary.mockResolvedValue({ total_records: 0, buckets: [] });
    render(<MemoryRouter><TaxEInvoicingPage embedded /></MemoryRouter>);
    expect(await screen.findByText("No tax records yet")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01" } });
    await waitFor(() => expect(svc.getTaxSummary).toHaveBeenLastCalledWith("2026-01-01", ""));
    expect(await screen.findByText("No tax recorded in this date range")).toBeInTheDocument();
  });
});

// ── Reconciliation ───────────────────────────────────────────────────────────

describe("ReconciliationPage", () => {
  it("reads the backend's naive str(datetime) timestamps as UTC", () => {
    expect(parseApiUtc("2026-08-31 10:00:00.123456").toISOString()).toBe("2026-08-31T10:00:00.123Z");
    expect(parseApiUtc("2026-08-31T10:00:00Z").toISOString()).toBe("2026-08-31T10:00:00.000Z");
    expect(parseApiUtc(null)).toBeNull();
  });

  const RUN = {
    id: 9, state: "failed", started_at: "2026-08-31 10:00:00", finished_at: "2026-08-31 10:00:01",
    trigger: "manual", checks_total: 2, exceptions_found: 1, processor_source: "none",
    processor_note: null, processor_environment: null, processor_stats: null,
    exceptions: [{ id: 201, run_id: 9, kind: "invoice_balance_mismatch", organization_id: 1, organization_name: "Acme", entity_type: "invoice", detail: {}, status: "OPEN" }],
    exception_summary: [],
  };

  it("shows a failed acknowledge inside the open run modal, not behind it", async () => {
    svc.listReconciliationRuns.mockResolvedValue({ items: [RUN] });
    svc.getReconciliationRun.mockResolvedValue(RUN);
    svc.acknowledgeReconciliationException.mockRejectedValue(new Error("Cannot acknowledge a resolved exception"));
    render(<MemoryRouter><ReconciliationPage embedded /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /view/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^acknowledge$/i }));
    const dialogs = await screen.findAllByRole("dialog");
    fireEvent.click(within(dialogs.at(-1)).getByRole("button", { name: /^acknowledge$/i }));
    const modal = (await screen.findByText("Reconciliation run #9")).closest('[role="dialog"]');
    expect(await within(modal).findByText("Cannot acknowledge a resolved exception")).toBeInTheDocument();
  });

  it("caps the resolution note at the backend's 500 characters", async () => {
    svc.listReconciliationRuns.mockResolvedValue({ items: [RUN] });
    svc.getReconciliationRun.mockResolvedValue(RUN);
    render(<MemoryRouter><ReconciliationPage embedded /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /view/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^resolve$/i }));
    expect(await screen.findByRole("textbox")).toHaveAttribute("maxLength", "500");
    expect(screen.getByText("0/500")).toBeInTheDocument();
  });

  it("pages through organizations instead of stopping at the first 200", async () => {
    const page = (start, n) => Array.from({ length: n }, (_, i) => ({ id: start + i, organization_code: `O${start + i}`, organization_name: `Org ${start + i}` }));
    commercial.listOrganizations
      .mockResolvedValueOnce({ total: 250, organizations: page(1, 200) })
      .mockResolvedValueOnce({ total: 250, organizations: page(201, 50) });
    render(<MemoryRouter><ReconciliationPage embedded /></MemoryRouter>);
    await waitFor(() => expect(screen.getByRole("option", { name: "O250 — Org 250" })).toBeInTheDocument());
    expect(commercial.listOrganizations).toHaveBeenLastCalledWith({ limit: 200, skip: 200 });
  });

  it("shows a run that found discrepancies as a warning, not a success", async () => {
    svc.triggerReconciliationRun.mockResolvedValue({ ...RUN, exceptions_found: 2 });
    render(<MemoryRouter><ReconciliationPage embedded /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: /run now/i }));
    const msg = await screen.findByText(/found 2 discrepancies/i);
    expect(msg.closest('[role="status"]')).toHaveClass("bg-amber-50");
    await waitFor(() => expect(svc.listReconciliationRuns).toHaveBeenCalledTimes(2));
  });
});
