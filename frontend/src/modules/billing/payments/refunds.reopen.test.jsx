import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, Link, useLocation, useNavigate } from "react-router-dom";

// "Create Refund" (FormModal) opened via /billing/refunds?create=1[&invoice_id=…]
// used to reopen itself on close: the auto-open effect fired again while the
// replace that drops the parameters was still pending (always reproducible with
// &invoice_id). It now opens once per navigation and closing / a successful
// create drop the parameters with replace.

if (typeof global.ResizeObserver === "undefined") global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
if (typeof HTMLElement !== "undefined") HTMLElement.prototype.scrollTo = HTMLElement.prototype.scrollTo || function noop() {};

const m = vi.hoisted(() => ({
  refundList: vi.fn(), create: vi.fn(), sources: vi.fn(), customerList: vi.fn(), customerGet: vi.fn(), invoiceGet: vi.fn(),
}));
vi.mock("../../../service/billingService", () => ({
  refundApi: {
    list: (...a) => m.refundList(...a), create: (...a) => m.create(...a),
    getDashboardStats: () => Promise.resolve({}), listRefundableSources: (...a) => m.sources(...a),
  },
  customerApi: { list: (...a) => m.customerList(...a), get: (...a) => m.customerGet(...a) },
  invoiceApi: { list: () => Promise.resolve({ items: [] }), get: (...a) => m.invoiceGet(...a) },
  creditNoteApi: { list: () => Promise.resolve({ items: [] }) },
}));

import RefundsPage from "./refunds";

const CUSTOMER = { id: 11, display_name: "Globex Corp", currency: "USD", credit_balance: 0 };
const PAYMENT = { id: 501, payment_number: "PAY-501", currency: "USD", amount: 100, reserved_amount: 0, refundable_amount: 100 };
const INVOICE = { id: 77, invoice_number: "INV-77", customer_id: 11, currency: "USD", paid_amount: 40, refundable_amount: 40, reserved_amount: 0 };
const sources = { payments: [PAYMENT], invoices: [INVOICE], credit_notes: [], credit_balance: { currency: "USD", balance: 0, reserved_amount: 0, refundable_amount: 0 } };

function LocationProbe() { const l = useLocation(); return <div data-testid="location">{l.pathname}{l.search}</div>; }
function BackButton() { const navigate = useNavigate(); return <button onClick={() => navigate(-1)}>History back</button>; }

// Arrive the way users do: from another page's "Refund" link.
function ProfileStub({ to }) { return <Link to={to}>Refund link</Link>; }

function renderFromProfile(to) {
  return render(
    <MemoryRouter initialEntries={["/billing/invoices/77"]}>
      <Routes>
        <Route path="/billing/invoices/:id" element={<><ProfileStub to={to} /><LocationProbe /></>} />
        <Route path="/billing/refunds" element={<><RefundsPage /><LocationProbe /><BackButton /></>} />
      </Routes>
    </MemoryRouter>
  );
}

const followLink = () => fireEvent.click(screen.getByRole("link", { name: "Refund link" }));
const dialog = () => screen.queryByRole("dialog", { name: "Create Refund" });
const findDialog = () => screen.findByRole("dialog", { name: "Create Refund" }, { timeout: 4000 });
const loc = () => screen.getByTestId("location").textContent;

async function expectClosedAndStaysClosed() {
  await waitFor(() => expect(dialog()).not.toBeInTheDocument());
  expect(loc()).toBe("/billing/refunds");
  // Give any pending effects a chance to (wrongly) reopen it.
  await new Promise((r) => setTimeout(r, 300));
  expect(dialog()).not.toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  m.refundList.mockResolvedValue({ items: [], total: 0 });
  m.create.mockResolvedValue({ id: 1 });
  m.customerList.mockResolvedValue({ items: [CUSTOMER] });
  m.customerGet.mockResolvedValue(CUSTOMER);
  m.invoiceGet.mockResolvedValue(INVOICE);
  m.sources.mockResolvedValue(sources);
});
afterEach(() => cleanup());

const closers = [
  ["Cancel", (d) => fireEvent.click(within(d).getByRole("button", { name: /^cancel$/i }))],
  ["Esc", () => fireEvent.keyDown(document, { key: "Escape" })],
  ["the × button", (d) => fireEvent.click(within(d).getByRole("button", { name: "Close dialog" }))],
];

const WITH_INVOICE = "/billing/refunds?create=1&invoice_id=77";
const PLAIN = "/billing/refunds?create=1";

// Waits until the invoice prefill has landed (it also drops the parameters).
async function waitForInvoicePrefill(d) {
  await waitFor(() => expect(m.invoiceGet).toHaveBeenCalledWith("77"));
  await waitFor(() => expect(within(d).getByLabelText(/^Amount/)).toHaveValue(40));
}

describe.each([
  ["?create=1&invoice_id=", WITH_INVOICE],
  ["?create=1", PLAIN],
])("Create Refund — opened via %s", (_label, to) => {
  const withInvoice = to === WITH_INVOICE;

  it("opens when arriving from a link", async () => {
    renderFromProfile(to);
    followLink();
    const d = await findDialog();
    if (withInvoice) await waitForInvoicePrefill(d);
  });

  it.each(closers)("closes on %s, drops the parameters and stays closed", async (_how, close) => {
    renderFromProfile(to);
    followLink();
    const d = await findDialog();
    if (withInvoice) await waitFor(() => expect(m.invoiceGet).toHaveBeenCalled());
    close(d);
    await expectClosedAndStaysClosed();
  });

  it("Back after closing returns to the previous page without reopening", async () => {
    renderFromProfile(to);
    followLink();
    fireEvent.click(within(await findDialog()).getByRole("button", { name: /^cancel$/i }));
    await expectClosedAndStaysClosed();
    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    await waitFor(() => expect(loc()).toBe("/billing/invoices/77"));
    expect(dialog()).not.toBeInTheDocument();
  });

  it("opens again on a second visit through the link", async () => {
    renderFromProfile(to);
    followLink();
    fireEvent.click(within(await findDialog()).getByRole("button", { name: /^cancel$/i }));
    await expectClosedAndStaysClosed();
    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    fireEvent.click(await screen.findByRole("link", { name: "Refund link" }));
    const d = await findDialog();
    if (withInvoice) await waitForInvoicePrefill(d);
  });

  it("a successful create closes it, leaves no parameters and it does not reopen", async () => {
    renderFromProfile(to);
    followLink();
    const d = await findDialog();
    if (withInvoice) {
      await waitForInvoicePrefill(d);
    } else {
      await waitFor(() => expect(within(d).getByRole("option", { name: "Globex Corp" })).toBeInTheDocument());
      fireEvent.change(within(d).getByLabelText(/^Customer/), { target: { value: "11" } });
      await within(d).findByRole("option", { name: /PAY-501/ });
      fireEvent.change(within(d).getByLabelText(/^Payment/), { target: { value: "501" } });
      fireEvent.change(within(d).getByLabelText(/^Amount/), { target: { value: "25" } });
    }
    fireEvent.click(within(d).getByRole("button", { name: /^Create$/ }));

    await waitFor(() => expect(m.create).toHaveBeenCalledTimes(1));
    expect(m.create.mock.calls[0][0]).toMatchObject(
      withInvoice ? { refund_source: "invoice", invoice_id: 77, amount: 40 } : { refund_source: "payment", payment_id: 501, amount: 25 }
    );
    await expectClosedAndStaysClosed();
    fireEvent.click(screen.getByRole("button", { name: "History back" }));
    await waitFor(() => expect(loc()).toBe("/billing/invoices/77"));
    expect(dialog()).not.toBeInTheDocument();
  });
});
