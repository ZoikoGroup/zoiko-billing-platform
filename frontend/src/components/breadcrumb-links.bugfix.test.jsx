import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { PageHeader } from "./billing-ui";

// Breadcrumb links used to call preventDefault and go nowhere; they now
// navigate inside the router.

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

afterEach(() => cleanup());

const CRUMBS = [{ label: "Billing", href: "/billing" }, { label: "Contracts", href: "/billing/contracts" }, { label: "Create Contract" }];

describe("PageHeader breadcrumbs", () => {
  it("navigates to a crumb's href inside the router", () => {
    render(
      <MemoryRouter initialEntries={["/billing/contracts/create"]}>
        <Routes>
          <Route path="*" element={<><PageHeader crumbs={CRUMBS} title="Create Contract" /><Where /></>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("where")).toHaveTextContent("/billing/contracts/create");
    fireEvent.click(screen.getByRole("link", { name: "Contracts" }));
    expect(screen.getByTestId("where")).toHaveTextContent("/billing/contracts");
    expect(screen.queryByRole("link", { name: "Create Contract" })).toBeNull();
  });

  it("renders plain links outside a router", () => {
    render(<PageHeader crumbs={CRUMBS} title="Create Contract" />);
    expect(screen.getByRole("link", { name: "Billing" })).toHaveAttribute("href", "/billing");
  });
});
