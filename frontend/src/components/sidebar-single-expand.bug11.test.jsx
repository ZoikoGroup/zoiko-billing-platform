import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";

// BUG-11.1 (/billing): "after completing one navigation menu and opening
// another, the previous menu remains open". Approved decision D1: the billing
// sidebar is single-expand. These render the real SidebarContent (used by both
// the desktop sidebar and the mobile drawer) for org_admin and billing_admin.

vi.mock("../context/AuthContext", () => ({ useAuth: () => ({}) }));
vi.mock("../hooks/useCockpitStatus", () => ({ default: () => ({}) }));

import { SidebarContent } from "./BillingShell";

function History() {
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" onClick={() => navigate(-1)}>test-back</button>
      <button type="button" onClick={() => navigate(1)}>test-forward</button>
      <button type="button" onClick={() => navigate("/billing/pricing/pricing-rules?status=active")}>test-filter</button>
    </div>
  );
}

function renderSidebar(role, path, onNavigate = () => {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarContent role={role} onNavigate={onNavigate} />
      <History />
    </MemoryRouter>
  );
}

const sectionButton = (name) => {
  const matches = screen.getAllByRole("button", { name }).filter((b) => b.hasAttribute("aria-expanded"));
  expect(matches).toHaveLength(1);
  return matches[0];
};
const expandedSections = () =>
  screen.queryAllByRole("button").filter((b) => b.getAttribute("aria-expanded") === "true").map((b) => b.textContent.trim());

afterEach(() => cleanup());

describe.each(["org_admin", "billing_admin"])("BUG-11.1 sidebar single-expand (%s)", (role) => {
  it("opens the active route's section on load, and only that one", () => {
    renderSidebar(role, "/billing/pricing/pricing-rules");
    expect(expandedSections()).toEqual(["Pricing"]);
    expect(screen.getByRole("link", { name: "Pricing Rules" })).toHaveAttribute("aria-current", "page");
  });

  it("opening another section closes the previously open one", () => {
    renderSidebar(role, "/billing/pricing/pricing-rules");
    fireEvent.click(sectionButton(/^Customers$/));
    expect(expandedSections()).toEqual(["Customers"]);
    fireEvent.click(sectionButton(/^Products$/));
    expect(expandedSections()).toEqual(["Products"]);
  });

  it("a section can be collapsed so none are open", () => {
    renderSidebar(role, "/billing/pricing/pricing-rules");
    fireEvent.click(sectionButton(/^Pricing$/));
    expect(expandedSections()).toEqual([]);
  });

  it("navigating from an opened section keeps only the new route's section open, with the active link highlighted", () => {
    renderSidebar(role, "/billing/pricing/pricing-rules");
    fireEvent.click(sectionButton(/^Products$/));
    fireEvent.click(screen.getByRole("link", { name: "Categories" }));
    expect(expandedSections()).toEqual(["Products"]);
    expect(screen.getByRole("link", { name: "Categories" })).toHaveAttribute("aria-current", "page");
  });

  it("browser back/forward follow the route, not a stale manual choice", () => {
    renderSidebar(role, "/billing/pricing/pricing-rules");
    fireEvent.click(sectionButton(/^Products$/));
    fireEvent.click(screen.getByRole("link", { name: "Categories" }));
    // On Categories, the user opens Customers, then goes back.
    fireEvent.click(sectionButton(/^Customers$/));
    fireEvent.click(screen.getByRole("button", { name: "test-back" }));
    expect(expandedSections()).toEqual(["Pricing"]);
    fireEvent.click(screen.getByRole("button", { name: "test-forward" }));
    expect(expandedSections()).toEqual(["Products"]);
  });

  it("aria-controls only references a panel that is rendered", () => {
    renderSidebar(role, "/billing/pricing/pricing-rules");
    for (const btn of screen.getAllByRole("button").filter((b) => b.hasAttribute("aria-expanded"))) {
      const controls = btn.getAttribute("aria-controls");
      if (btn.getAttribute("aria-expanded") === "true") {
        expect(controls).toBeTruthy();
        expect(document.getElementById(controls)).not.toBeNull();
        expect(within(document.getElementById(controls)).getAllByRole("link").length).toBeGreaterThan(0);
      } else {
        expect(controls).toBeNull();
      }
    }
  });

  it("section toggles are real buttons operable from the keyboard", () => {
    renderSidebar(role, "/billing/pricing/pricing-rules");
    const customers = sectionButton(/^Customers$/);
    expect(customers.tagName).toBe("BUTTON");
    expect(customers).toHaveAttribute("type", "button");
    customers.focus();
    expect(document.activeElement).toBe(customers);
  });

  it("a query-string change on the same page (e.g. URL-synced filters) keeps the user's open section", () => {
    renderSidebar(role, "/billing/pricing/pricing-rules");
    fireEvent.click(sectionButton(/^Customers$/));
    fireEvent.click(screen.getByRole("button", { name: "test-filter" }));
    expect(expandedSections()).toEqual(["Customers"]);
  });

  it("choosing a link calls onNavigate (closes the mobile drawer)", () => {
    const onNavigate = vi.fn();
    renderSidebar(role, "/billing/pricing/pricing-rules", onNavigate);
    fireEvent.click(screen.getByRole("link", { name: "Tier Management" }));
    expect(onNavigate).toHaveBeenCalled();
    expect(expandedSections()).toEqual(["Pricing"]);
  });
});
