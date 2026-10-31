import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Link, useLocation, useNavigate } from "react-router-dom";

// The "Record Payment" wizard (shared Modal) opened via /billing/payments?create=1
// used to reopen itself on close: the auto-open effect fired again while the
// replace that drops ?create=1 was still pending. It now opens once per
// navigation and closing / a successful save drop the parameters with replace.

if (typeof global.ResizeObserver === "undefined") global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};

const m = vi.hoisted(() => ({
  paymentList: vi.fn(), create: vi.fn(), allocate: vi.fn(), listMethods: vi.fn(),
  invoiceList: vi.fn(), invoiceGet: vi.fn(), customerSearch: vi.fn(), customerGet: vi.fn(),
}));

vi.mock("../../../service/billingService", () => ({
  paymentApi: {
    list: (...a) => m.paymentList(...a), create: (...a) => m.create(...a), allocate: (...a) => m.allocate(...a),
    listMethods: (...a) => m.listMethods(...a), updateStatus: vi.fn(),
    getDashboardStats: () => Promise.resolve({}),
  },
  invoiceApi: { list: (...a) => m.invoiceList(...a), get: (...a) => m.invoiceGet(...a) },
  customerApi: { search: (...a) => m.customerSearch(...a), get: (...a) => m.customerGet(...a) },
  creditNoteApi: { list: () => Promise.resolve({ items: [] }) },
  settingsApi: { getConfig: () => Promise.resolve({ base_currency: "USD" }) },
}));

import PaymentListPage from "./payment-list";

const CUSTOMER = { id: 42, display_name: "Acme Corp", email: "acme@example.com", currency: "USD" };
const INVOICE = { id: 88, customer_id: 42, invoice_number: "INV-88", total_amount: 200, paid_amount: 0, status: "sent", currency: "USD" };

function LocationProbe() { const l = useLocation(); return <div data-testid="location">{l.pathname}{l.search}</div>; }
function BackButton() { const navigate = useNavigate(); return <button onClick={() => navigate(-1)}>History back</button>; }

// Arrive the way users do: from another page's "Record payment" link.
function ProfileStub({ to }) { return <Link to={to}>Record payment link</Link>; }

function renderFromProfile(to = "/billing/payments?create=1") {
  return render(
    <MemoryRouter initialEntries={["/billing/customers/42"]}>
      <Routes>
        <Route path="/billing/customers/:id" element={<><ProfileStub to={to} /><LocationProbe /></>} />
        <Route path="/billing/payments" element={<><PaymentListPage /><LocationProbe /><BackButton /></>} />
        <Route path="/billing/payments/:id" element={<><LocationProbe /><BackButton /></>} />
      </Routes>
    </MemoryRouter>
  );
}

const followLink = () => fireEvent.click(screen.getByRole("link", { name: "Record payment link" }));
const wizard = () => screen.queryByRole("dialog", { name: "Record Payment" });
const findWizard = () => screen.findByRole("dialog", { name: "Record Payment" }, { timeout: 4000 });
const loc = () => screen.getByTestId("location").textContent;

async function expectClosedAndStaysClosed() {
  await waitFor(() => expect(wizard()).not.toBeInTheDocument());
  expect(loc()).toBe("/billing/payments");
  // Give any pending effects a chance to (wrongly) reopen it.
  await new Promise((r) => setTimeout(r, 300));
  expect(wizard()).not.toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  m.paymentList.mockResolvedValue({ items: [], total: 0 });
  m.create.mockResolvedValue({ id: 999 });
  m.allocate.mockResolvedValue({ amount: 200 });
  m.listMethods.mockResolvedValue([]);
  m.invoiceList.mockResolvedValue({ items: [] });
  m.invoiceGet.mockResolvedValue(INVOICE);
  m.customerSearch.mockResolvedValue([CUSTOMER]);
  m.customerGet.mockResolvedValue(CUSTOMER);
});
afterEach(() => cleanup());

const closers = [
  ["Cancel", (dialog) => fireEvent.click(within(dialog).getByRole("button", { name: /^cancel$/i }))],
  ["Esc", () => fireEvent.keyDown(document, { key: "Escape" })],
  ["the × button", (dialog) => fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }))],
];

describe("Record Payment wizard — opened via ?create=1", () => {
  it("opens when arriving from a link", async () => {
    renderFromProfile();
    followLink();
    expect(await findWizard()).toBeInTheDocument();
    expect(loc()).toBe("/billing/payments?create=1");
  });

  it.each(closers)("closes on %s, drops ?create=1 and stays closed", async (_how, close) => {
    renderFromProfile();
    followLink();
    close(await findWizard());
    await expectClosedAndStaysClosed();
  });

  it.each(closers)("with &invoice_id: prefills the invoice, closes on %s, drops both parameters and stays closed", async (_how, close) => {
    renderFromProfile("/billing/payments?create=1&invoice_id=88");
    followLink();
    const dialog = await findWizard();
    await waitFor(() => expect(m.invoiceGet).toHaveBeenCalledWith("88"));
    expect(await within(dialog).findAllByText(/INV-88/)).not.toHaveLength(0);
    close(dialog);
    await expectClosedAndStaysClosed();
  });

  it("Back after closing returns to the previous page without reopening", async () => {
    renderFromProfile();
    followLink();
    fireEvent.click(within(await findWizard()).getByRole("button", { name: /^cancel$/i }));
    await expectClosedAndStaysClosed();
    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    await waitFor(() => expect(loc()).toBe("/billing/customers/42"));
    expect(wizard()).not.toBeInTheDocument();
  });

  it("opens again on a second visit through the link", async () => {
    renderFromProfile();
    followLink();
    fireEvent.click(within(await findWizard()).getByRole("button", { name: /^cancel$/i }));
    await expectClosedAndStaysClosed();
    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    fireEvent.click(await screen.findByRole("link", { name: "Record payment link" }));
    const dialog = await findWizard();
    // A fresh wizard: back at step 1 with Continue gated again.
    expect(within(dialog).getByRole("button", { name: /^continue$/i })).toBeDisabled();
  });

  it("after a successful save navigates to the payment, and Back lands on the list without reopening the wizard", async () => {
    renderFromProfile();
    followLink();
    const dialog = await findWizard();

    fireEvent.change(within(dialog).getByPlaceholderText(/search customers by name, email, or phone/i), { target: { value: "Acme" } });
    fireEvent.click(await within(dialog).findByText("Acme Corp", {}, { timeout: 2000 }));
    await waitFor(() => expect(m.listMethods).toHaveBeenCalledWith(42));

    fireEvent.change(within(dialog).getByLabelText("Amount *"), { target: { value: "500" } });
    const cont = () => fireEvent.click(within(dialog).getByRole("button", { name: /^continue$/i }));
    cont(); await within(dialog).findByText("Payment Allocation");
    cont(); await within(dialog).findByText("Review Payment");
    cont(); await within(dialog).findByText("Confirm Payment");
    fireEvent.click(within(dialog).getByRole("button", { name: "Record Payment" }));

    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    // The page navigates after a 1.2s success delay (real timers).
    await waitFor(() => expect(loc()).toBe("/billing/payments/999"), { timeout: 4000 });

    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    await waitFor(() => expect(loc()).toBe("/billing/payments"));
    await new Promise((r) => setTimeout(r, 300));
    expect(wizard()).not.toBeInTheDocument();
  }, 15000);
});
