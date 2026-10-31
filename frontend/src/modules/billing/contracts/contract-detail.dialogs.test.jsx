import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const mockGet = vi.fn();
const mockRenew = vi.fn();
const mockTerminate = vi.fn();
const mockCreateAmendment = vi.fn();

vi.mock("../../../service/billingService", () => {
  const empty = () => Promise.resolve([]);
  return {
    contractApi: {
      get: (...a) => mockGet(...a),
      getItems: empty,
      getAmendments: empty,
      renew: (...a) => mockRenew(...a),
      terminate: (...a) => mockTerminate(...a),
      createAmendment: (...a) => mockCreateAmendment(...a),
      activate: vi.fn(), cancel: vi.fn(), generateInvoice: vi.fn(),
    },
    customerApi: { get: () => Promise.resolve(null) },
    invoiceApi: { list: empty },
    subscriptionApi: { list: empty },
    auditApi: { list: empty },
  };
});

vi.mock("../utils/TerminologyContext", () => ({
  useTerminology: () => ({ singular: "Customer", plural: "Customers" }),
}));

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useParams: () => ({ id: "5" }), useNavigate: () => vi.fn() };
});

import ContractDetailPage from "./contract-detail";

const CONTRACT = { id: 5, contract_number: "CON-0005", status: "active", start_date: "2026-01-01", end_date: "2030-12-31", currency: "USD" };

async function renderPage() {
  render(<MemoryRouter><ContractDetailPage /></MemoryRouter>);
  await screen.findByText("Contract CON-0005");
}

async function open(triggerName, title) {
  fireEvent.click(screen.getByRole("button", { name: triggerName }));
  return screen.findByRole("dialog", { name: title });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockGet.mockResolvedValue(CONTRACT);
  mockRenew.mockResolvedValue({});
  mockTerminate.mockResolvedValue({});
  mockCreateAmendment.mockResolvedValue({});
});

describe("Contract detail dialogs", () => {
  it("Renew Contract: gated on a later end date, calls contractApi.renew, closes", async () => {
    await renderPage();
    const dialog = await open(/renew contract/i, "Renew Contract");
    const renew = within(dialog).getByRole("button", { name: /^renew$/i });
    const dateInput = dialog.querySelector('input[type="date"]');

    fireEvent.change(dateInput, { target: { value: "2030-06-30" } });
    expect(renew).toBeDisabled();
    fireEvent.change(dateInput, { target: { value: "2031-12-31" } });
    expect(renew).toBeEnabled();

    fireEvent.click(renew);
    await waitFor(() => expect(mockRenew).toHaveBeenCalledWith("5", "2031-12-31"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Terminate Contract: gated on a reason, calls contractApi.terminate, closes", async () => {
    await renderPage();
    const dialog = await open(/terminate contract/i, "Terminate Contract");
    const terminate = within(dialog).getByRole("button", { name: /^terminate$/i });
    expect(terminate).toBeDisabled();

    fireEvent.change(within(dialog).getByPlaceholderText(/reason for termination/i), { target: { value: "  Client exit  " } });
    fireEvent.click(terminate);
    await waitFor(() => expect(mockTerminate).toHaveBeenCalledWith("5", { reason: "Client exit" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Create Amendment (Amendments tab): calls contractApi.createAmendment, closes", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: /amendments/i }));
    const dialog = await open(/create amendment/i, "Create Amendment");

    fireEvent.change(dialog.querySelector('input[type="date"]'), { target: { value: "2027-02-01" } });
    fireEvent.change(within(dialog).getByPlaceholderText(/reason for amendment/i), { target: { value: "Scope change" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /create amendment/i }));

    await waitFor(() => expect(mockCreateAmendment).toHaveBeenCalledWith("5", expect.objectContaining({
      effective_date: "2027-02-01", reason: "Scope change",
    })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("Cancel closes the Terminate dialog without calling the API", async () => {
    await renderPage();
    const dialog = await open(/terminate contract/i, "Terminate Contract");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mockTerminate).not.toHaveBeenCalled();
  });
});
