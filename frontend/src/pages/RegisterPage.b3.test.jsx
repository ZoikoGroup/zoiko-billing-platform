import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import RegisterPage from "./RegisterPage";
import { apiFetch } from "../api/client";

// Below lg the submit button lives in a bar pinned to the bottom of the
// screen (the order summary is under the whole form there). Mocks copied
// from RegisterPage.test.jsx.

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));
vi.mock("../context/AuthContext", () => ({ useAuth: () => ({ login: vi.fn() }) }));
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual("react-router-dom")),
  useNavigate: () => mockNavigate,
}));

const originalMatchMedia = window.matchMedia;
function emulateBelowLg() {
  window.matchMedia = (query) => ({
    matches: query === "(max-width: 1023.98px)", media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  });
}

function fillForm() {
  const set = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
  set(/Organization name/, "Acme Inc.");
  set(/Admin name/, "Jane Doe");
  set(/Admin email/, "jane@acme.test");
  set(/^Password/, "StrongPass123!");
  set(/Phone number/, "+1 555 123 4567");
  set(/^Address/, "1 Main St");
  set(/^Country/, "United States");
  fireEvent.click(screen.getByLabelText(/accept the Terms/));
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockImplementation((path) =>
    path === "/api/auth/country-defaults"
      ? Promise.resolve({ countries: [{ name: "United States", currency: "USD" }] })
      : Promise.resolve({ access_token: "t", start_mode: "trial", payment_token: null }),
  );
});
afterEach(() => { window.matchMedia = originalMatchMedia; });

const renderPage = () => render(<MemoryRouter><RegisterPage /></MemoryRouter>);

describe("RegisterPage pinned submit bar (below lg)", () => {
  it("shows one submit button, in the bar, with the plan and today's price", () => {
    emulateBelowLg();
    renderPage();
    const buttons = screen.getAllByRole("button", { name: /Start my 14-day free trial/ });
    expect(buttons).toHaveLength(1);
    const bar = buttons[0].closest("div.fixed");
    expect(bar).not.toBeNull();
    expect(within(bar).getByText("Essentials")).toBeInTheDocument();
    expect(within(bar).getByText("$0 today")).toBeInTheDocument();
  });

  it("shows the paid plan's price and label when skipping the trial", () => {
    emulateBelowLg();
    renderPage();
    fireEvent.click(screen.getByRole("radio", { name: /Buy a plan now/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Business plan" }));
    const bar = screen.getByRole("button", { name: /Create account & pay \$399/ }).closest("div.fixed");
    expect(within(bar).getByText("$399 due today")).toBeInTheDocument();
  });

  it("submitting from the bar registers exactly as before", async () => {
    emulateBelowLg();
    renderPage();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: /Start my 14-day free trial/ }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/auth/register", expect.anything()));
    const body = apiFetch.mock.calls.find(([p]) => p === "/api/auth/register")[1].body;
    expect(body).toMatchObject({ organization: "Acme Inc.", email: "jane@acme.test", start_mode: "trial", intended_plan: "essentials" });
  });

  it("keeps value and focus while the organization name is typed key by key", async () => {
    emulateBelowLg();
    const user = userEvent.setup();
    renderPage();
    const org = screen.getByLabelText(/Organization name/);
    await user.click(org);
    await user.type(org, "Acme Holdings");
    expect(org).toHaveValue("Acme Holdings");
    expect(org).toHaveFocus();
  });

  it("desktop keeps the button in the order summary (no pinned bar)", () => {
    renderPage();
    const button = screen.getByRole("button", { name: /Start my 14-day free trial/ });
    expect(button.closest("div.fixed")).toBeNull();
    expect(button.closest("aside")).not.toBeNull();
  });
});
