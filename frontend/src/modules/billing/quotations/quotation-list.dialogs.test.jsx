import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Link, useLocation, useNavigate } from "react-router-dom";

// Smoke tests for the "New Quotation" wizard, which is rendered on the shared
// Modal and opened via /billing/quotations?create=1.

if (typeof global.ResizeObserver === "undefined") global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const m = vi.hoisted(() => ({
  search: vi.fn(), create: vi.fn(), addItems: vi.fn(), recalculate: vi.fn(),
  productList: vi.fn(), resolvePrice: vi.fn(),
}));

vi.mock("../../../service/billingService", () => {
  const empty = () => Promise.resolve({ items: [], total: 0 });
  return {
    quoteApi: {
      list: empty, summary: () => Promise.resolve({}),
      create: (...a) => m.create(...a), addItems: (...a) => m.addItems(...a),
      recalculate: (...a) => m.recalculate(...a), send: vi.fn(), cancel: vi.fn(),
    },
    customerApi: { search: (...a) => m.search(...a), get: () => Promise.resolve({}), list: empty },
    productApi: { list: (...a) => m.productList(...a) },
    pricingApi: { listByProduct: () => Promise.resolve([]), resolvePrice: (...a) => m.resolvePrice(...a) },
    settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }) },
  };
});

import QuotationListPage from "./quotation-list";

function LocationProbe() { const l = useLocation(); return <div data-testid="location">{l.pathname}{l.search}</div>; }

function renderWizard() {
  return render(
    <MemoryRouter initialEntries={["/billing/quotations?create=1"]}>
      <Routes>
        <Route path="/billing/quotations" element={<><QuotationListPage /><LocationProbe /></>} />
        <Route path="/billing/quotations/:id" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

// Arrive the way users do: from the customer profile's "New quotation" link.
function ProfileStub() {
  return <Link to="/billing/quotations?create=1">New quotation</Link>;
}
function BackButton() { const navigate = useNavigate(); return <button onClick={() => navigate(-1)}>History back</button>; }

function renderFromProfile() {
  return render(
    <MemoryRouter initialEntries={["/billing/customers/7"]}>
      <Routes>
        <Route path="/billing/customers/:id" element={<><ProfileStub /><LocationProbe /></>} />
        <Route path="/billing/quotations" element={<><QuotationListPage /><LocationProbe /><BackButton /></>} />
        <Route path="/billing/quotations/:id" element={<><LocationProbe /><BackButton /></>} />
      </Routes>
    </MemoryRouter>
  );
}

const wizard = () => screen.queryByRole("dialog", { name: "New Quotation" });
const findWizard = () => screen.findByRole("dialog", { name: "New Quotation" }, { timeout: 4000 });

async function expectClosedAndStaysClosed() {
  await waitFor(() => expect(wizard()).not.toBeInTheDocument());
  expect(screen.getByTestId("location").textContent).toBe("/billing/quotations");
  // Give any pending effects a chance to (wrongly) reopen it.
  await new Promise((r) => setTimeout(r, 300));
  expect(wizard()).not.toBeInTheDocument();
}

async function selectCustomer(dialog) {
  fireEvent.change(within(dialog).getByRole("textbox", { name: /search .* by name, email, or phone/i }), { target: { value: "Acme" } });
  fireEvent.click(await within(dialog).findByRole("button", { name: /acme corp/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.search.mockResolvedValue([{ id: 7, display_name: "Acme Corp", email: "a@acme.test" }]);
  m.productList.mockResolvedValue({ items: [{ id: 3, name: "Widget", default_price: 100 }] });
  m.resolvePrice.mockResolvedValue({ unit_price: 100, resolved_price: 100, base_price: 100 });
  m.create.mockResolvedValue({ id: 55 });
  m.addItems.mockResolvedValue({});
  m.recalculate.mockResolvedValue({});
});
afterEach(() => cleanup());

describe("New Quotation wizard — opened via ?create=1", () => {
  it("opens when arriving from the customer profile link", async () => {
    renderFromProfile();
    fireEvent.click(screen.getByRole("link", { name: "New quotation" }));
    expect(await findWizard()).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toBe("/billing/quotations?create=1");
  });

  it.each([
    ["Cancel", (dialog) => fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }))],
    ["Esc", () => fireEvent.keyDown(document, { key: "Escape" })],
    ["the × button", (dialog) => fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }))],
  ])("closes on %s, drops ?create=1 and stays closed", async (_how, close) => {
    renderWizard();
    close(await findWizard());
    await expectClosedAndStaysClosed();
  });

  it("Back after closing does not reopen it (?create=1 was replaced, not pushed)", async () => {
    renderFromProfile();
    fireEvent.click(screen.getByRole("link", { name: "New quotation" }));
    const dialog = await findWizard();
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await expectClosedAndStaysClosed();
    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/billing/customers/7"));
    expect(wizard()).not.toBeInTheDocument();
  });

  it("opens again on a second visit through the link", async () => {
    renderFromProfile();
    fireEvent.click(screen.getByRole("link", { name: "New quotation" }));
    let dialog = await findWizard();
    fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }));
    await expectClosedAndStaysClosed();
    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    fireEvent.click(await screen.findByRole("link", { name: "New quotation" }));
    dialog = await findWizard();
    expect(dialog).toBeInTheDocument();
    // A fresh wizard: back at step 1 with Continue gated again.
    expect(within(dialog).getByRole("button", { name: /^continue$/i })).toBeDisabled();
  });
});

describe("New Quotation wizard", () => {
  it("opens from ?create=1 and gates Continue on a customer", async () => {
    renderWizard();
    const dialog = await screen.findByRole("dialog", { name: "New Quotation" }, { timeout: 4000 });
    const continueBtn = within(dialog).getByRole("button", { name: /^continue$/i });
    expect(continueBtn).toBeDisabled();

    await selectCustomer(dialog);
    expect(continueBtn).not.toBeDisabled();
  });

  it("drives all four steps and Create Quotation calls quoteApi.create once", async () => {
    renderWizard();
    const dialog = await screen.findByRole("dialog", { name: "New Quotation" }, { timeout: 4000 });
    await driveToCreate(dialog);

    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 7 }));
    await waitFor(() => expect(m.addItems).toHaveBeenCalledWith(55, [expect.objectContaining({ product_id: 3, unit_price: 100 })]));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/billing/quotations/55"));
  });

  it("Back from the new quotation lands on the list without ?create=1 and the wizard stays closed", async () => {
    renderFromProfile();
    fireEvent.click(screen.getByRole("link", { name: "New quotation" }));
    await driveToCreate(await findWizard());
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/billing/quotations/55"));

    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    await expectClosedAndStaysClosed();
  });
});

async function driveToCreate(dialog) {
  await selectCustomer(dialog);
  fireEvent.click(within(dialog).getByRole("button", { name: /^continue$/i }));

  // Step 2: add a product line.
  const select = await within(dialog).findByRole("combobox");
  await within(dialog).findByRole("option", { name: /widget/i });
  fireEvent.change(select, { target: { value: "3" } });
  await waitFor(() => expect(within(dialog).queryByText(/no line items yet/i)).not.toBeInTheDocument());
  fireEvent.click(within(dialog).getByRole("button", { name: /^continue$/i }));

  // Step 3 -> 4.
  fireEvent.click(await within(dialog).findByRole("button", { name: /^continue$/i }));
  fireEvent.click(await within(dialog).findByRole("button", { name: /create quotation/i }));
}
