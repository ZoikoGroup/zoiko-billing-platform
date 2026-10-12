import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import RegisterPage from "./RegisterPage";
import { apiFetch } from "../api/client";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual("react-router-dom")),
  useNavigate: () => mockNavigate,
}));

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

const submit = () => fireEvent.click(document.querySelector('button[type="submit"]'));

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockImplementation((path) =>
    path === "/api/auth/country-defaults"
      ? Promise.resolve({ countries: [{ name: "United States", currency: "USD" }] })
      : Promise.resolve({ access_token: "t", start_mode: "trial", payment_token: null }),
  );
});

const renderPage = () => render(<MemoryRouter><RegisterPage /></MemoryRouter>);

describe("RegisterPage", () => {
  it("shows every self-serve plan with its limits, and Enterprise as contact-only", () => {
    renderPage();
    for (const name of ["Essentials", "Professional", "Business"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.getAllByText("$49").length).toBeGreaterThan(0);
    // limits per plan: Essentials 5 seats / 5,000 API per day, Business 100 seats / 200,000 API per day
    expect(screen.getAllByText("5,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("200,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
    expect(screen.getByText(/Need Enterprise\?/)).toBeInTheDocument();
  });

  it("is light-themed (no dark page background)", () => {
    const { container } = renderPage();
    const root = container.firstChild;
    expect(root.className).toMatch(/bg-slate-50/);
    expect(root.style.colorScheme).toBe("light");
  });

  it("defaults to the 14-day Essentials trial and registers with start_mode=trial", async () => {
    renderPage();
    expect(screen.getByRole("button", { name: /Start my 14-day free trial/ })).toBeInTheDocument();
    fillForm();
    submit();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    const call = apiFetch.mock.calls.find(([p]) => p === "/api/auth/register");
    expect(call[1].body).toMatchObject({ intended_plan: "essentials", start_mode: "trial" });
    expect(mockNavigate).toHaveBeenCalledWith("/register/success", expect.objectContaining({
      state: expect.objectContaining({ startMode: "trial", planName: "Essentials" }),
    }));
  });

  it("buy-now registers the chosen plan and sends the user to checkout", async () => {
    apiFetch.mockImplementation((path) =>
      path === "/api/auth/country-defaults"
        ? Promise.resolve({ countries: [] })
        : Promise.resolve({ start_mode: "paid", payment_token: "tok_pay" }),
    );
    renderPage();
    fireEvent.click(screen.getByRole("radio", { name: /Buy a plan now/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Business plan" }));
    expect(screen.getByRole("button", { name: /Create account & pay \$399/ })).toBeInTheDocument();
    fillForm();
    submit();

    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/platform-invoice/tok_pay/checkout"));
    const call = apiFetch.mock.calls.find(([p]) => p === "/api/auth/register");
    expect(call[1].body).toMatchObject({ intended_plan: "business", start_mode: "paid" });
  });

  it("shows the server error and stays on the page when registration fails", async () => {
    apiFetch.mockImplementation((path) =>
      path === "/api/auth/country-defaults"
        ? Promise.resolve({ countries: [] })
        : Promise.reject(new Error("Email already registered")),
    );
    renderPage();
    fillForm();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Email already registered");
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
