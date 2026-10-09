import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";

// B8 (/billing/quotations/settings): the four implemented settings must load
// and persist; the six "advanced" controls have no (or no quotation-side)
// backend behaviour and must never look or act like working controls.

const m = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("../../../service/billingService", () => ({ settingsApi: { get: (...a) => m.get(...a), update: (...a) => m.update(...a) } }));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children, actions }) => <div><h1>{title}</h1>{actions}{children}</div> }));
vi.mock("../utils/TerminologyContext", () => ({ useTerminology: () => ({ singular: "Customer", plural: "Customers" }) }));

import QuotationSettingsPage from "./settings";

beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockResolvedValue({ quote_prefix: "QT-", default_currency: "INR", quote_terms_and_conditions: "Net 30", logo_url: "https://acme.example/logo.png" });
  m.update.mockResolvedValue({});
});
afterEach(() => cleanup());

describe("B8 Quotation Settings", () => {
  it("implemented settings load their saved values and persist with the backend field names", async () => {
    render(<QuotationSettingsPage />);
    const prefix = await screen.findByLabelText("Quote number prefix");
    expect(prefix).toHaveValue("QT-");
    expect(screen.getByLabelText("Default terms and conditions")).toHaveValue("Net 30");
    expect(screen.getByLabelText("Quotation logo URL")).toHaveValue("https://acme.example/logo.png");
    fireEvent.change(prefix, { target: { value: "QUO-" } });
    fireEvent.change(screen.getByLabelText("Quotation logo URL"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    expect(m.update.mock.calls[0][0]).toMatchObject({ quote_prefix: "QUO-", quote_terms_and_conditions: "Net 30", logo_url: null });
  });

  it("planned controls are a read-only list, each marked Not available, with no inputs", async () => {
    render(<QuotationSettingsPage />);
    const list = await screen.findByRole("list", { name: "Planned quotation controls" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(6);
    for (const li of items) expect(within(li).getByText("Not available")).toBeInTheDocument();
    expect(list.querySelectorAll("input, select, textarea, button")).toHaveLength(0);
  });

  it("a failed load shows Retry, not editable defaults", async () => {
    m.get.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({ quote_prefix: "QT-" });
    render(<QuotationSettingsPage />);
    const retry = await screen.findByRole("button", { name: /try again|retry/i });
    expect(screen.queryByLabelText("Quote number prefix")).toBeNull();
    fireEvent.click(retry);
    expect(await screen.findByLabelText("Quote number prefix")).toHaveValue("QT-");
  });
});
