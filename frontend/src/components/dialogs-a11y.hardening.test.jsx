import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Accessibility hardening for shared dialogs / table rows / settings labels:
// ConfirmDialog had no dialog semantics, Escape or focus handling; the bulk
// product picker discarded its selection on a stray overlay click and had no
// Escape; clickable DataTable rows were mouse-only; and every settings page
// rendered its field label as a bare <h3> so no input had an accessible label.

const m = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("../service/billingService", () => ({
  settingsApi: { get: (...a) => m.get(...a), update: (...a) => m.update(...a) },
}));
vi.mock("./HRPage", () => ({ default: ({ title, children }) => <div><h1>{title}</h1>{children}</div> }));
vi.mock("../modules/billing/utils/TerminologyContext", () => ({
  useTerminology: () => ({ singular: "Customer", plural: "Customers" }),
}));

import ConfirmDialog from "./ConfirmDialog";
import { BulkProductPickerModal } from "./billing-shared";
import { DataTable } from "./billing-ui";
import PaymentSettingsPage from "../modules/billing/payments/settings";
import SubscriptionSettingsPage from "../modules/billing/subscriptions/settings";

beforeEach(() => {
  vi.clearAllMocks();
  m.get.mockResolvedValue({});
  m.update.mockResolvedValue({});
});
afterEach(() => cleanup());

describe("ConfirmDialog", () => {
  function Harness({ onClose = () => {}, busy = false }) {
    return (
      <div>
        <button type="button">Trigger</button>
        <ConfirmDialog title="Deactivate User" message="They will lose access." confirmLabel="Deactivate"
          onConfirm={() => {}} onClose={onClose} busy={busy} />
      </div>
    );
  }

  it("is a labelled, described modal dialog", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Deactivate User" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription("They will lose access.");
  });

  it("Escape cancels, but not while busy", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness onClose={onClose} busy />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Harness onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus to Cancel on open and restores it to the trigger on close", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(
      <ConfirmDialog title="Delete" message="Sure?" onConfirm={() => {}} onClose={() => {}} />
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});

describe("BulkProductPickerModal", () => {
  const renderPicker = (onClose) => render(
    <BulkProductPickerModal open onClose={onClose} onAddSelected={() => {}}
      fetchProducts={() => Promise.resolve({ items: [], total: 0 })}
      fetchCategories={() => Promise.resolve([])} />
  );

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderPicker(onClose);
    expect(screen.getByRole("dialog", { name: "Add Products / Services" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT close on an overlay click, and moves focus into the dialog", () => {
    const onClose = vi.fn();
    renderPicker(onClose);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.click(dialog.parentElement);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("DataTable row keyboard access", () => {
  const columns = [{ key: "name", label: "Name" }];
  const data = [{ id: 1, name: "Acme" }];

  it("clickable rows are focusable and activate on Enter / Space", () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={columns} data={data} rowKey={(r) => r.id} onRowClick={onRowClick} />);
    const row = screen.getByText("Acme").closest("tr");
    expect(row).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(row, { key: "Enter" });
    fireEvent.keyDown(row, { key: " " });
    expect(onRowClick).toHaveBeenCalledTimes(2);
    expect(onRowClick).toHaveBeenCalledWith(data[0]);
  });

  it("rows without onRowClick are unchanged (no tabindex)", () => {
    render(<DataTable columns={columns} data={data} rowKey={(r) => r.id} />);
    expect(screen.getByText("Acme").closest("tr")).not.toHaveAttribute("tabindex");
  });
});

describe("SettingsField labels are associated with their controls", () => {
  it("Payment settings", async () => {
    render(<MemoryRouter><PaymentSettingsPage /></MemoryRouter>);
    const input = await screen.findByLabelText("Payment Numbering Prefix");
    expect(input.tagName).toBe("INPUT");
  });

  it("Subscription settings", async () => {
    render(<MemoryRouter><SubscriptionSettingsPage /></MemoryRouter>);
    const input = await screen.findByLabelText("Subscription Numbering Prefix");
    expect(input.tagName).toBe("INPUT");
    // The visual heading is preserved.
    expect(screen.getByRole("heading", { name: "Subscription Numbering Prefix" })).toBeInTheDocument();
  });
});
