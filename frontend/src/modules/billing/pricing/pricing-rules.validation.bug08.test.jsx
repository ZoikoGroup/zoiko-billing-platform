import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// BUG-08.1 follow-up (/billing/pricing/pricing-rules). Conditional requirements
// are unchanged (see pricing-rules.batch3.test.jsx); these pin the gaps the
// Phase 3 audit found: Effective To vs Effective From, the schema minimums for
// Priority (>= 0) and Usage Limit (>= 1), and that clearing a field on edit
// sends an explicit null (the backend now honours it, see
// test_pricing_rule_update_clear_and_product_scope.py).

const m = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  pricingRuleApi: {
    list: (...a) => m.list(...a), create: (...a) => m.create(...a), update: (...a) => m.update(...a),
    deactivate: vi.fn(), activate: vi.fn(),
  },
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));

import PricingRulesPage, { validateRuleContract } from "./pricing-rules";

const RULE = {
  id: 1, name: "Spring", code: "SPR", rule_type: "percentage_discount", scope: "global", priority: 3,
  status: "active", is_active: true, effective_from: "2026-01-01", effective_to: "2026-06-30", value: 10,
  description: "Spring promo", usage_limit: 50, region: "EMEA",
};

beforeEach(() => {
  vi.clearAllMocks();
  m.list.mockResolvedValue({ items: [RULE], total: 1, page: 1, per_page: 20, pages: 1 });
  m.create.mockResolvedValue({ id: 2 });
  m.update.mockResolvedValue({ ...RULE });
});
afterEach(() => cleanup());

const renderPage = () => render(<MemoryRouter><PricingRulesPage /></MemoryRouter>);

describe("validateRuleContract — date range and minimums", () => {
  const base = { rule_type: "percentage_discount", scope: "global", value: "10", product_id: "", region: "", effective_from: "2026-03-01" };

  it.each([
    [{ effective_to: "2026-02-28" }, /effective to must be on or after effective from/i],
    [{ priority: "-1" }, /priority must be a whole number of 0 or more/i],
    [{ priority: "1.5" }, /priority must be a whole number/i],
    [{ usage_limit: "0" }, /usage limit must be a whole number of 1 or more/i],
    [{ usage_limit: "-3" }, /usage limit/i],
    [{ usage_limit: "2.5" }, /usage limit/i],
  ])("rejects %o", (patch, msg) => {
    expect(validateRuleContract({ ...base, ...patch })).toMatch(msg);
  });

  it.each([
    [{ effective_to: "2026-03-01" }],   // same day
    [{ effective_to: "2026-12-31" }],
    [{ effective_to: "" }],             // open-ended
    [{ priority: "0" }],
    [{ priority: "" }],                 // optional -> sent as 0
    [{ usage_limit: "1" }],
    [{ usage_limit: "" }],              // unlimited
  ])("accepts %o", (patch) => {
    expect(validateRuleContract({ ...base, ...patch })).toBeNull();
  });
});

describe("Create form — invalid input never reaches the API", () => {
  it("blocks Effective To before Effective From with an announced message", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /create rule/i }));
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: "Rule X" } });
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: "RX" } });
    fireEvent.change(screen.getByLabelText(/^Value \*/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/^Effective From/), { target: { value: "2026-05-10" } });
    fireEvent.change(screen.getByLabelText(/^Effective To/), { target: { value: "2026-05-01" } });
    fireEvent.click(screen.getAllByRole("button", { name: /create rule/i }).at(-1));
    expect(await screen.findByRole("alert")).toHaveTextContent(/effective to must be on or after effective from/i);
    expect(m.create).not.toHaveBeenCalled();
  });

  it("exposes the minimums on the numeric inputs", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /create rule/i }));
    expect(await screen.findByLabelText("Priority")).toHaveAttribute("min", "0");
    expect(screen.getByLabelText("Usage Limit")).toHaveAttribute("min", "1");
  });

  it("trims a whitespace-only description to null", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /create rule/i }));
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: "Rule X" } });
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: "RX" } });
    fireEvent.change(screen.getByLabelText(/^Value \*/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "   " } });
    fireEvent.click(screen.getAllByRole("button", { name: /create rule/i }).at(-1));
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0][0].description).toBeNull();
  });
});

describe("Edit form — clearing optional fields sends explicit nulls", () => {
  it("sends null for a cleared description, effective-to, usage limit and region", async () => {
    renderPage();
    await screen.findByText("Spring");
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    fireEvent.change(await screen.findByLabelText("Description"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/^Effective To/), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Usage Limit"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/^Region/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /update rule/i }));
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    const [id, payload] = m.update.mock.calls[0];
    expect(id).toBe(1);
    expect(payload).toMatchObject({ description: null, effective_to: null, usage_limit: null, region: null });
    // Untouched fields keep their stored values.
    expect(payload).toMatchObject({ priority: 3, value: 10, effective_from: "2026-01-01" });
  });
});

describe("Pricing Rule dialogs (smoke, rebuilt on Modal)", () => {
  it("Create Rule opens the dialog, saves and closes it", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /create rule/i }));
    const dialog = await screen.findByRole("dialog", { name: "Create Pricing Rule" });
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: "Rule X" } });
    fireEvent.change(within(dialog).getByLabelText(/^Code/), { target: { value: "RX" } });
    fireEvent.change(within(dialog).getByLabelText(/^Value \*/), { target: { value: "10" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Rule" }));
    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0][0]).toMatchObject({ name: "Rule X", value: 10 });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Edit closes the dialog after Update Rule", async () => {
    renderPage();
    await screen.findByText("Spring");
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Pricing Rule" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Update Rule" }));
    await waitFor(() => expect(m.update).toHaveBeenCalledWith(1, expect.objectContaining({ name: "Spring" })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("View opens Pricing Rule Details and Close closes it", async () => {
    renderPage();
    await screen.findByText("Spring");
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog", { name: "Pricing Rule Details" });
    expect(within(dialog).getByText("Spring")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
