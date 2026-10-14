import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Batch 3 / B (/billing/pricing/pricing-rules)
//  B1 only type/scope-dependent fields are required (see test_pricing_rule_contract.py)
//  B2 "Show inactive" sent active_only=false = INCLUDE deactivated rules (correct
//     per the API); the label said otherwise. Now "Include deactivated".
//  B3 no way to clear filters.

const m = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock("../../../service/billingService", () => ({
  pricingRuleApi: { list: (...a) => m.list(...a), create: (...a) => m.create(...a), update: vi.fn(), deactivate: vi.fn(), activate: vi.fn() },
}));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));

import PricingRulesPage, { validateRuleContract } from "./pricing-rules";

const RULE = { id: 1, name: "Spring", code: "SPR", rule_type: "percentage_discount", scope: "global", priority: 0, status: "active", is_active: true, effective_from: "2026-01-01", value: 10 };
const lastParams = () => m.list.mock.calls.at(-1)[0];

beforeEach(() => {
  vi.clearAllMocks();
  m.list.mockResolvedValue({ items: [RULE], total: 1, page: 1, per_page: 20, pages: 1 });
  m.create.mockResolvedValue({ id: 2 });
});
afterEach(() => cleanup());

const renderPage = () => render(<MemoryRouter><PricingRulesPage /></MemoryRouter>);

describe("B2 — Include deactivated", () => {
  it("is off by default (active rules only) and includes deactivated rules when checked", async () => {
    renderPage();
    await waitFor(() => expect(m.list).toHaveBeenCalled());
    expect(lastParams().active_only).toBe(true);
    fireEvent.click(screen.getByLabelText("Include deactivated"));
    await waitFor(() => expect(lastParams().active_only).toBe(false));
    expect(screen.queryByText(/show inactive/i)).not.toBeInTheDocument();
  });
});

describe("B3 — Clear filters", () => {
  it("is hidden with no filters and resets every filter when used", async () => {
    renderPage();
    await screen.findByText("Spring");
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search rules"), { target: { value: "spr" } });
    fireEvent.change(screen.getByLabelText("Rule type"), { target: { value: "fixed_discount" } });
    fireEvent.change(screen.getByLabelText("Rule status"), { target: { value: "draft" } });
    fireEvent.click(screen.getByLabelText("Include deactivated"));
    await waitFor(() => expect(lastParams()).toMatchObject({ search_term: "spr", rule_type: "fixed_discount", status: "draft", active_only: false }));
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    await waitFor(() => {
      const p = lastParams();
      expect(p.search_term).toBeUndefined();
      expect(p.rule_type).toBeUndefined();
      expect(p.status).toBeUndefined();
      expect(p.active_only).toBe(true);
    });
    expect(screen.getByLabelText("Search rules")).toHaveValue("");
  });

  it("distinguishes 'no match' from 'no rules yet'", async () => {
    m.list.mockResolvedValue({ items: [], total: 0 });
    renderPage();
    expect(await screen.findByText("No pricing rules yet")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Rule status"), { target: { value: "expired" } });
    expect(await screen.findByText("No pricing rules match your filters")).toBeInTheDocument();
  });
});

describe("B1 — required fields follow the rule type and scope", () => {
  const base = { rule_type: "percentage_discount", scope: "global", value: "10", product_id: "", region: "" };
  it.each([
    [{ value: "" }, /value is required/i],
    [{ rule_type: "fixed_discount", value: "" }, /value is required/i],
    [{ value: "101" }, /cannot exceed 100/i],
    [{ scope: "product" }, /product id is required/i],
    [{ scope: "region", region: "  " }, /region is required/i],
  ])("rejects %o", (patch, msg) => {
    expect(validateRuleContract({ ...base, ...patch })).toMatch(msg);
  });
  it.each([
    [{}],
    [{ rule_type: "tier_pricing", value: "" }],
    [{ rule_type: "fixed_discount", value: "250" }],
    [{ scope: "region", region: "EMEA" }],
  ])("accepts %o (optional fields may be empty)", (patch) => {
    expect(validateRuleContract({ ...base, ...patch })).toBeNull();
  });

  it("a server rejection is shown inside the form, not behind it", async () => {
    m.create.mockRejectedValue(Object.assign(new Error("Choose the product this product-scoped rule applies to."), { status: 400 }));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /create rule/i }));
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: "Rule X" } });
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: "RX" } });
    fireEvent.change(screen.getByLabelText(/^Value \*/), { target: { value: "10" } });
    fireEvent.click(screen.getAllByRole("button", { name: /create rule/i }).at(-1));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose the product this product-scoped rule applies to.");
  });
});
