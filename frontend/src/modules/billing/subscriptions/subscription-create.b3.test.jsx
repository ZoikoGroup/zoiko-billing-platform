import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import userEvent from "@testing-library/user-event";

// Subscription create wizard on the full-page form pattern: phone bar,
// pinned step actions, Cancel + discard prompt (no autosave), and the same
// subscriptionApi.create payload as before.

const mockCreate = vi.fn();
const mockListPlans = vi.fn();
const mockCustomerList = vi.fn();

vi.mock("../../../service/billingService", () => ({
  subscriptionApi: { create: (...a) => mockCreate(...a), listPlans: (...a) => mockListPlans(...a) },
  contractApi: { get: vi.fn(), list: vi.fn().mockResolvedValue([]) },
  customerApi: { get: vi.fn(), list: (...a) => mockCustomerList(...a) },
}));
vi.mock("../../../service/billingConfigCache", async () => ({
  ...(await vi.importActual("../../../service/billingConfigCache")),
  loadGlobalBillingConfig: () => Promise.resolve({ subscription_prefix: "SUB-" }),
}));

import CreateSubscriptionWizardPage from "./subscription-create";

function renderWizard() {
  return render(
    <MemoryRouter initialEntries={["/billing/subscriptions/create"]}>
      <Routes>
        <Route path="/billing/subscriptions/create" element={<CreateSubscriptionWizardPage />} />
        <Route path="/billing/subscriptions" element={<p>Subscriptions list</p>} />
        <Route path="/billing/subscriptions/:id" element={<p>Subscription detail</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const cont = () => fireEvent.click(screen.getByRole("button", { name: "Continue" }));

async function pickCustomer(user) {
  fireEvent.click(screen.getByRole("button", { name: /Direct Creation/ }));
  await user.type(screen.getByPlaceholderText(/search customers by name or email/i), "Helix");
  fireEvent.click(await screen.findByRole("button", { name: /Helix Biotech/ }));
  await screen.findByText(/helix@example.com/);
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockCustomerList.mockResolvedValue([{ id: 7, display_name: "Helix Biotech", email: "helix@example.com", currency: "USD" }]);
  mockListPlans.mockResolvedValue([{ id: 3, plan_name: "Growth", billing_period: "monthly", unit_price: 99, is_active: true, currency: "USD" }]);
  mockCreate.mockResolvedValue({ id: 55 });
});

describe("Subscription create wizard (full-page pattern)", () => {
  it("shows the phone bar, the required note and pinned step actions", () => {
    renderWizard();
    expect(screen.getByRole("button", { name: "Back to subscriptions" })).toBeInTheDocument();
    expect(screen.getAllByText("Step 1 of 4").length).toBeGreaterThan(0);
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    // Back appears from step 2, as before.
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });

  it("Cancel leaves straight away when nothing was entered", async () => {
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Subscriptions list")).toBeInTheDocument();
  });

  it("asks before discarding a picked customer; Keep editing stays, Discard leaves", async () => {
    const user = userEvent.setup();
    renderWizard();
    await pickCustomer(user);
    fireEvent.click(screen.getByRole("button", { name: "Back to subscriptions" }));
    const prompt = await screen.findByRole("dialog", { name: "Discard this subscription?" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Discard this subscription?" })).not.toBeInTheDocument());
    expect(screen.getByText("Helix Biotech")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Discard this subscription?" })).getByRole("button", { name: "Discard" }));
    expect(await screen.findByText("Subscriptions list")).toBeInTheDocument();
  });

  it("keeps value and focus while the customer search is typed key by key", async () => {
    const user = userEvent.setup();
    renderWizard();
    fireEvent.click(screen.getByRole("button", { name: /Direct Creation/ }));
    const search = screen.getByPlaceholderText(/search customers by name or email/i);
    await user.click(search);
    await user.type(search, "Helix Bio");
    expect(search).toHaveValue("Helix Bio");
    expect(search).toHaveFocus();
  });

  it("Create Subscription sends the same payload as before", async () => {
    const user = userEvent.setup();
    renderWizard();
    await pickCustomer(user);
    cont(); cont();
    fireEvent.click(await screen.findByRole("button", { name: /Growth/ }));
    cont();
    await screen.findByText(/Review & Create Subscription/);
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create Subscription" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockCreate.mock.calls[0][0]).toMatchObject({ customer_id: 7, plan_id: 3, quantity: 1, unit_price: 99 });
    expect(await screen.findByText("Subscription detail")).toBeInTheDocument();
  });
});
