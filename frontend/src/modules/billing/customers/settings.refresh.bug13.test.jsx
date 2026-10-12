import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// BUG-13 (/billing/customers/settings): unsaved changes are handled like the
// other settings pages (pricing/quotation settings, BUG-11.2/11.7) -- Refresh
// with unsaved edits asks before discarding them, and the header row wraps on
// narrow screens. The five customer settings themselves are covered by
// settings.bug13.test.jsx.

const m = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("../../../service/billingService", () => ({ settingsApi: { get: (...a) => m.get(...a), update: (...a) => m.update(...a), getConfig: () => Promise.resolve({}) }, invalidateConfigCache: () => {} }));
vi.mock("../../../components/HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));

import CustomerSettingsPage from "./settings";

beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockResolvedValue({ default_payment_terms: "net_15" });
  m.update.mockResolvedValue({});
});
afterEach(() => cleanup());

const refreshButton = () => screen.getByRole("button", { name: /refresh/i });

describe("BUG-13 Customer Settings — Refresh with unsaved edits", () => {
  it("with no edits, Refresh reloads straight away", async () => {
    render(<CustomerSettingsPage />);
    await screen.findByLabelText("Default payment terms");
    expect(m.get).toHaveBeenCalledTimes(1);
    fireEvent.click(refreshButton());
    await waitFor(() => expect(m.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument();
  });

  it("with edits, Refresh asks first; Cancel keeps the edit and does not reload", async () => {
    render(<CustomerSettingsPage />);
    const terms = await screen.findByLabelText("Default payment terms");
    fireEvent.change(terms, { target: { value: "net_60" } });
    fireEvent.click(refreshButton());
    expect(await screen.findByText("Discard unsaved changes?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByText("Discard unsaved changes?")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Default payment terms")).toHaveValue("net_60");
    expect(m.get).toHaveBeenCalledTimes(1);
    expect(m.update).not.toHaveBeenCalled();
  });

  it("confirming reloads the saved values and discards the edit", async () => {
    render(<CustomerSettingsPage />);
    const terms = await screen.findByLabelText("Default payment terms");
    fireEvent.change(terms, { target: { value: "net_60" } });
    fireEvent.click(refreshButton());
    fireEvent.click(await screen.findByRole("button", { name: /discard & refresh/i }));
    await waitFor(() => expect(m.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("Default payment terms")).toHaveValue("net_15");
    expect(m.update).not.toHaveBeenCalled();
  });

  it("the action row wraps instead of relying on an empty spacer", async () => {
    render(<CustomerSettingsPage />);
    await screen.findByLabelText("Default payment terms");
    const row = refreshButton().parentElement;
    expect(row.className).toContain("flex-wrap");
    expect(row.className).toContain("justify-end");
  });
});
