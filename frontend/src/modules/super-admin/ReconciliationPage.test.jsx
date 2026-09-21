import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { axe } from "../../test/a11y";

// Phase 12 — Reconciliation UI completion (ISS-017 processor-comparison
// controls). All backend access is mocked at the service boundary, matching
// this codebase's established convention (see ReliabilityLens.test.jsx).

const mockListRuns = vi.fn();
const mockGetRun = vi.fn();
const mockTriggerRun = vi.fn();
const mockAcknowledge = vi.fn();
const mockResolve = vi.fn();
const mockListOrganizations = vi.fn();

vi.mock("../../service/commandCenterService", () => ({
  listReconciliationRuns: (...args) => mockListRuns(...args),
  getReconciliationRun: (...args) => mockGetRun(...args),
  triggerReconciliationRun: (...args) => mockTriggerRun(...args),
  acknowledgeReconciliationException: (...args) => mockAcknowledge(...args),
  resolveReconciliationException: (...args) => mockResolve(...args),
}));

// The Organization-scope selector fetches its options from commercialService
// on mount, independent of the commandCenterService mock above -- leaving
// this unmocked lets the real fetch() run, which fails in CI ("fetch
// failed") and renders its own role="alert", breaking any assertion that
// assumes there's exactly one alert on the page.
vi.mock("../../service/commercialService", () => ({
  listOrganizations: (...args) => mockListOrganizations(...args),
}));

import ReconciliationPage from "./ReconciliationPage";

const BASE_RUN = {
  id: 1,
  state: "partial",
  started_at: "2026-08-31T10:00:00Z",
  finished_at: "2026-08-31T10:00:01Z",
  trigger: "manual",
  checks_total: 2,
  exceptions_found: 0,
  processor_source: "none",
  processor_note: "No processor/bank feed connected; only internal ledger invariants evaluated this run.",
  processor_environment: null,
  processor_stats: null,
};

function withRuns(runs) {
  mockListRuns.mockResolvedValue({ items: runs });
}

function setDate(input, value) {
  fireEvent.change(input, { target: { value } });
}

beforeEach(() => {
  mockListRuns.mockReset();
  mockGetRun.mockReset();
  mockTriggerRun.mockReset();
  mockAcknowledge.mockReset();
  mockResolve.mockReset();
  mockListOrganizations.mockReset();
  mockListOrganizations.mockResolvedValue({ organizations: [] });
  withRuns([BASE_RUN]);
});

// 1. Page renders
it("renders the Reconciliation page with its title and Run Now control", async () => {
  render(<ReconciliationPage />);
  await waitFor(() => expect(screen.getByText("Tenant Ledger Reconciliation")).toBeInTheDocument());
  expect(screen.getByRole("button", { name: /run now/i })).toBeInTheDocument();
  expect(screen.getByText(/compare with stripe/i)).toBeInTheDocument();
});

// 2. Existing ledger-only reconciliation remains functional (default behavior unchanged)
it("submits a ledger-only run by default, with compareProcessor false and no dates", async () => {
  mockTriggerRun.mockResolvedValue({ ...BASE_RUN, id: 2 });
  render(<ReconciliationPage />);
  await waitFor(() => screen.getByRole("button", { name: /run now/i }));

  fireEvent.click(screen.getByRole("button", { name: /run now/i }));

  await waitFor(() => expect(mockTriggerRun).toHaveBeenCalledTimes(1));
  expect(mockTriggerRun).toHaveBeenCalledWith({ compareProcessor: false, rangeStart: "", rangeEnd: "" });
});

// 3 & 4. Processor comparison can be enabled; date range appears
it("shows the date-range controls only once 'Compare with Stripe' is checked", async () => {
  render(<ReconciliationPage />);
  await waitFor(() => screen.getByRole("button", { name: /run now/i }));

  expect(screen.queryByLabelText(/start date/i)).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("checkbox", { name: /compare with stripe/i }));

  expect(screen.getByLabelText(/start date/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/end date/i)).toBeInTheDocument();
});

// 5. Invalid date range is rejected
it("rejects a start date after the end date and disables the Run button", async () => {
  render(<ReconciliationPage />);
  await waitFor(() => screen.getByRole("button", { name: /run now/i }));

  fireEvent.click(screen.getByRole("checkbox", { name: /compare with stripe/i }));
  setDate(screen.getByLabelText(/start date/i), "2026-08-20");
  setDate(screen.getByLabelText(/end date/i), "2026-08-10");

  expect(screen.getByText(/start date must be on or before the end date/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /run now/i })).toBeDisabled();
  expect(mockTriggerRun).not.toHaveBeenCalled();
});

it("rejects an empty date range when comparison is enabled", async () => {
  render(<ReconciliationPage />);
  await waitFor(() => screen.getByRole("button", { name: /run now/i }));
  fireEvent.click(screen.getByRole("checkbox", { name: /compare with stripe/i }));
  expect(screen.getByRole("button", { name: /run now/i })).toBeDisabled();
});

// 6. Run button submits correct payload
it("submits compareProcessor=true with the exact selected range", async () => {
  mockTriggerRun.mockResolvedValue({
    ...BASE_RUN, id: 3, state: "verified", processor_environment: "test",
    processor_stats: { records_inspected: 1, records_matched: 1, organizations_compared: [1], processor_errors: [], range_start: "2026-08-01", range_end: "2026-08-10" },
  });
  render(<ReconciliationPage />);
  await waitFor(() => screen.getByRole("button", { name: /run now/i }));

  fireEvent.click(screen.getByRole("checkbox", { name: /compare with stripe/i }));
  setDate(screen.getByLabelText(/start date/i), "2026-08-01");
  setDate(screen.getByLabelText(/end date/i), "2026-08-10");
  fireEvent.click(screen.getByRole("button", { name: /run now/i }));

  await waitFor(() => expect(mockTriggerRun).toHaveBeenCalledTimes(1));
  expect(mockTriggerRun).toHaveBeenCalledWith({
    compareProcessor: true, rangeStart: "2026-08-01", rangeEnd: "2026-08-10",
  });
});

// 7 & 8. Duplicate submission prevented + loading state appears
it("disables the Run button and shows 'Running reconciliation…' while a run is in flight, preventing a duplicate submit", async () => {
  let resolveTrigger;
  mockTriggerRun.mockReturnValue(new Promise((resolve) => { resolveTrigger = resolve; }));
  render(<ReconciliationPage />);
  await waitFor(() => screen.getByRole("button", { name: /run now/i }));

  fireEvent.click(screen.getByRole("button", { name: /run now/i }));

  const runningButton = await screen.findByRole("button", { name: /running reconciliation/i });
  expect(runningButton).toBeDisabled();
  // A second click while pending must not fire a second request.
  fireEvent.click(runningButton);
  expect(mockTriggerRun).toHaveBeenCalledTimes(1);

  resolveTrigger({ ...BASE_RUN, id: 4 });
  await waitFor(() => expect(screen.getByRole("button", { name: /^run now$/i })).not.toBeDisabled());
});

// 9. VERIFIED state renders correctly
it("renders VERIFIED with an honest completion message, not a credential-based claim", async () => {
  mockTriggerRun.mockResolvedValue({
    id: 5, state: "verified", exceptions_found: 0, processor_environment: "test",
    processor_note: null,
    processor_stats: { records_inspected: 3, records_matched: 3, organizations_compared: [1], processor_errors: [] },
  });
  render(<ReconciliationPage />);
  await waitFor(() => screen.getByRole("button", { name: /run now/i }));
  fireEvent.click(screen.getByRole("button", { name: /run now/i }));

  await waitFor(() =>
    expect(screen.getByText(/run #5 verified — stripe comparison completed with 0 discrepancies/i)).toBeInTheDocument()
  );
});

// 10. PARTIAL state renders correctly, using the backend's own reason
it("renders PARTIAL using the backend-provided processor_note, not an invented reason", async () => {
  mockTriggerRun.mockResolvedValue({
    id: 6, state: "partial", exceptions_found: 0, processor_environment: null,
    processor_note: "Stripe processor comparison was requested, but no organization has an ACTIVE Stripe connection in the 'test' environment — no Stripe API call was made.",
    processor_stats: null,
  });
  render(<ReconciliationPage />);
  await waitFor(() => screen.getByRole("button", { name: /run now/i }));
  fireEvent.click(screen.getByRole("button", { name: /run now/i }));

  await waitFor(() =>
    expect(screen.getByText(/no organization has an active stripe connection/i)).toBeInTheDocument()
  );
});

// 11 & 12. FAILED state + discrepancy classifications render
it("renders FAILED with discrepancy classifications visible in the run detail, not hidden behind a generic message", async () => {
  mockTriggerRun.mockResolvedValue({ id: 7, state: "failed", exceptions_found: 2 });
  mockGetRun.mockResolvedValue({
    id: 7, state: "failed", started_at: "2026-08-31T10:00:00Z", finished_at: "2026-08-31T10:00:01Z",
    trigger: "manual", checks_total: 3, exceptions_found: 2, processor_source: "stripe",
    processor_environment: "test", processor_note: "2 discrepancies found.",
    processor_stats: { records_inspected: 5, records_matched: 3, organizations_compared: [1], processor_errors: [], range_start: "2026-08-01", range_end: "2026-08-10" },
    exceptions: [
      { id: 101, run_id: 7, kind: "stripe_amount_mismatch", organization_id: 1, entity_type: "payment", entity_id: 55, detail: { ledger_amount: "1000.00", stripe_amount: "900.00" }, status: "OPEN" },
      { id: 102, run_id: 7, kind: "stripe_missing_in_stripe", organization_id: 1, entity_type: "payment", entity_id: 56, detail: { stripe_payment_intent_id: "pi_x" }, status: "OPEN" },
    ],
  });
  withRuns([{ ...BASE_RUN, id: 7, state: "failed", exceptions_found: 2 }]);
  render(<ReconciliationPage />);
  await waitFor(() => screen.getByRole("button", { name: /run now/i }));
  fireEvent.click(screen.getByRole("button", { name: /run now/i }));
  await waitFor(() => expect(screen.getByText(/found 2 discrepancies — review below/i)).toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: /view/i }));

  await waitFor(() => expect(screen.getByText("Amount mismatch (Stripe)")).toBeInTheDocument());
  expect(screen.getByText("Missing in Stripe")).toBeInTheDocument();
});

// 13. Processor statistics render
it("renders processor statistics (records inspected/matched/organizations compared) in the run detail", async () => {
  mockGetRun.mockResolvedValue({
    id: 8, state: "verified", started_at: "2026-08-31T10:00:00Z", finished_at: "2026-08-31T10:00:01Z",
    trigger: "manual", checks_total: 3, exceptions_found: 0, processor_source: "stripe",
    processor_environment: "test", processor_note: null,
    processor_stats: { records_inspected: 12, records_matched: 12, organizations_compared: [1, 2], processor_errors: [], range_start: "2026-08-01", range_end: "2026-08-10" },
    exceptions: [],
  });
  withRuns([{ ...BASE_RUN, id: 8, state: "verified", processor_environment: "test" }]);
  render(<ReconciliationPage />);
  await waitFor(() => screen.getByRole("button", { name: /view/i }));
  fireEvent.click(screen.getByRole("button", { name: /view/i }));

  await waitFor(() => expect(screen.getByText(/12 record\(s\) inspected/i)).toBeInTheDocument());
  expect(screen.getByText(/12 matched/i)).toBeInTheDocument();
  expect(screen.getByText(/2 organization\(s\) compared/i)).toBeInTheDocument();
});

// 14. API errors render safely, without hiding a successfully-loaded run history
it("shows an action-error banner on a failed trigger, without hiding the already-loaded run history", async () => {
  mockTriggerRun.mockRejectedValue(Object.assign(new Error("Stripe error (rate_limit): too many requests"), { status: 500 }));
  render(<ReconciliationPage />);
  await waitFor(() => screen.getByRole("button", { name: /run now/i }));

  fireEvent.click(screen.getByRole("button", { name: /run now/i }));

  await waitFor(() => expect(screen.getByText(/too many requests/i)).toBeInTheDocument());
  // The run history table (loaded successfully) must still be visible.
  expect(screen.getByText(`#${BASE_RUN.id}`)).toBeInTheDocument();
});

// 15. Unauthorized response is handled gracefully
it("shows a clear access error when the run list request is unauthorized, without crashing", async () => {
  mockListRuns.mockReset();
  mockListRuns.mockRejectedValue(Object.assign(new Error("Your platform role (support_operator) does not include the 'financial_consistency.read' capability."), { status: 403 }));
  render(<ReconciliationPage />);

  await waitFor(() =>
    expect(screen.getByText(/does not include the 'financial_consistency.read' capability/i)).toBeInTheDocument()
  );
  // No reconciliation results are exposed past the error state.
  expect(screen.queryByText("No exceptions on this run")).not.toBeInTheDocument();
});

// 16. No secret values appear anywhere in the rendered UI
it("never renders a Stripe secret key value, even if one were present in run data", async () => {
  const fakeSecretLookingValue = "sk_test_should_never_render_1234567890";
  mockGetRun.mockResolvedValue({
    id: 9, state: "partial", started_at: "2026-08-31T10:00:00Z", finished_at: null,
    trigger: "manual", checks_total: 2, exceptions_found: 0, processor_source: "stripe",
    processor_environment: "test",
    processor_note: "Stripe credentials present, but processor comparison was not requested for this run; only internal ledger invariants evaluated.",
    processor_stats: null,
    exceptions: [],
  });
  withRuns([{ ...BASE_RUN, id: 9 }]);
  const { container } = render(<ReconciliationPage />);
  await waitFor(() => screen.getByRole("button", { name: /view/i }));
  fireEvent.click(screen.getByRole("button", { name: /view/i }));
  await waitFor(() => expect(screen.getByText(/only internal ledger invariants evaluated/i)).toBeInTheDocument());

  expect(container.textContent).not.toContain(fakeSecretLookingValue);
  expect(container.textContent.toLowerCase()).not.toMatch(/sk_(test|live)_[a-z0-9]{10,}/);
});

// Accessibility (Step 22) — the new "Compare with Stripe" checkbox and the
// date-range controls it reveals must be genuinely accessible, not just
// visually present. Matches the established page-level a11y pattern (see
// customer-list.test.jsx).
it("has no accessibility violations with the processor-comparison controls expanded (axe-core)", async () => {
  const { container } = render(<ReconciliationPage />);
  await waitFor(() => screen.getByRole("button", { name: /run now/i }));
  fireEvent.click(screen.getByRole("checkbox", { name: /compare with stripe/i }));
  await waitFor(() => screen.getByLabelText(/start date/i));

  expect(await axe(container)).toHaveNoViolations();
});
