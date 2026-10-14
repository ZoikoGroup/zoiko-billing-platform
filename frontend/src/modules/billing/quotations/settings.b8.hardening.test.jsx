import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";

// B8 (/billing/quotations/settings): quotation settings load and persist with
// their backend field names; only the two unsupported controls remain planned.

const m = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("../../../service/billingService", () => ({ settingsApi: { get: (...a) => m.get(...a), update: (...a) => m.update(...a) } }));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children, actions }) => <div><h1>{title}</h1>{actions}{children}</div> }));
vi.mock("../utils/TerminologyContext", () => ({ useTerminology: () => ({ singular: "Customer", plural: "Customers" }) }));

import QuotationSettingsPage from "./settings";

beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockResolvedValue({
    quote_prefix: "QT-", quote_number_format: "PREFIX-{YYYY}-{SEQ}", quote_sequence_reset: "annually",
    default_currency: "INR", quote_terms_and_conditions: "Net 30", logo_url: "https://acme.example/logo.png",
    quotation_extra_settings: {
      require_customer_acceptance: false, discount_approval_threshold: 25, expiry_reminder_days: 7,
    },
  });
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
    expect(screen.getByLabelText("Quote number format")).toHaveValue("PREFIX-{YYYY}-{SEQ}");
    expect(screen.getByLabelText("Quote sequence reset")).toHaveValue("annually");
    expect(screen.getByLabelText("Customer acceptance required")).toHaveValue("false");
    expect(screen.getByLabelText("Discount approval threshold")).toHaveValue(25);
    expect(screen.getByLabelText("Expiry reminder days")).toHaveValue(7);
    fireEvent.change(prefix, { target: { value: "QUO-" } });
    fireEvent.change(screen.getByLabelText("Quotation logo URL"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Quote number format"), { target: { value: "PREFIX-{YYYYMM}-{SEQ}" } });
    fireEvent.change(screen.getByLabelText("Quote sequence reset"), { target: { value: "monthly" } });
    fireEvent.change(screen.getByLabelText("Customer acceptance required"), { target: { value: "true" } });
    fireEvent.change(screen.getByLabelText("Discount approval threshold"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Expiry reminder days"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(m.update).toHaveBeenCalledTimes(1));
    expect(m.update.mock.calls[0][0]).toMatchObject({
      quote_prefix: "QUO-",
      quote_number_format: "PREFIX-{YYYYMM}-{SEQ}",
      quote_sequence_reset: "monthly",
      quote_terms_and_conditions: "Net 30",
      logo_url: null,
      quotation_extra_settings: {
        require_customer_acceptance: true,
        discount_approval_threshold: null,
        expiry_reminder_days: null,
      },
    });
  });

  it("only Auto-Approval Workflow and Version History remain planned", async () => {
    render(<QuotationSettingsPage />);
    const list = await screen.findByRole("list", { name: "Planned quotation controls" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(list).getByText("Auto-Approval Workflow")).toBeInTheDocument();
    expect(within(list).getByText("Version History")).toBeInTheDocument();
    expect(list.querySelectorAll("input, select, textarea, button")).toHaveLength(0);
  });

  it("customer acceptance defaults to required and blank optional settings clear to null", async () => {
    m.get.mockResolvedValueOnce({ quote_prefix: "QT-" });
    render(<QuotationSettingsPage />);
    expect(await screen.findByLabelText("Customer acceptance required")).toHaveValue("true");
    expect(screen.getByLabelText("Discount approval threshold")).toHaveValue(null);
    expect(screen.getByLabelText("Expiry reminder days")).toHaveValue(null);
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
