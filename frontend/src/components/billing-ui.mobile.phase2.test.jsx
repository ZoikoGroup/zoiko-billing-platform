// Phase 2 mobile behaviour of the shared primitives. The global matchMedia
// polyfill never matches, so these tests swap in one that treats the
// max-width (phone) queries as matching to exercise the phone layouts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  Button,
  DataTable,
  Field,
  FormModal,
  OverflowMenu,
  PageHeader,
  Stepper,
  useUnsavedChangesGuard,
} from "./billing-ui";

const originalMatchMedia = window.matchMedia;

function setViewport(phone) {
  window.matchMedia = (query) => ({
    matches: phone && /max-width/.test(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

const WIDE_COLUMNS = [
  { key: "number", label: "Invoice" },
  { key: "customer", label: "Customer" },
  { key: "status", label: "Status" },
  { key: "total", label: "Total", numeric: true },
  { key: "due", label: "Due date" },
  { key: "actions", label: "", render: (row) => <button type="button">Open {row.number}</button> },
];
const ROWS = [
  { id: 1, number: "INV-1", customer: "Helix Biotech", status: "Sent", total: "$3,580.00", due: "Nov 26" },
  { id: 2, number: "INV-2", customer: "Brightwater", status: "Paid", total: "$12,475.00", due: "Oct 20" },
];

describe("DataTable card mode", () => {
  it("renders stacked cards on phones when more than 4 columns are meaningful", () => {
    setViewport(true);
    render(<DataTable columns={WIDE_COLUMNS} data={ROWS} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const cards = screen.getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText("INV-1")).toBeInTheDocument();
    expect(within(cards[0]).getByText("Customer")).toBeInTheDocument(); // meta label
    expect(within(cards[0]).getByText("Helix Biotech")).toBeInTheDocument();
  });

  it("keeps the table on desktop and for narrow tables on phones", () => {
    setViewport(false);
    const { unmount } = render(<DataTable columns={WIDE_COLUMNS} data={ROWS} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    unmount();
    setViewport(true);
    render(<DataTable columns={WIDE_COLUMNS.slice(0, 3)} data={ROWS} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("honours mobile=\"scroll\" and opens rows without firing on row actions", () => {
    setViewport(true);
    const { unmount } = render(<DataTable columns={WIDE_COLUMNS} data={ROWS} mobile="scroll" />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    unmount();
    const onRowClick = vi.fn();
    render(<DataTable columns={WIDE_COLUMNS} data={ROWS} onRowClick={onRowClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Open INV-1" }));
    expect(onRowClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Helix Biotech"));
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });
});

describe("OverflowMenu and PageHeader actions", () => {
  it("opens, runs an item and closes on Escape", () => {
    const onExport = vi.fn();
    render(<OverflowMenu items={[{ label: "Export CSV", onClick: onExport }, { label: "Refresh", onClick: () => {} }]} />);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Export CSV" }));
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows secondary actions inline on desktop and in a menu on phones", () => {
    const header = (
      <PageHeader
        title="Payments"
        primaryAction={<Button variant="primary">Record payment</Button>}
        moreActions={[{ label: "Export", onClick: () => {} }]}
      />
    );
    setViewport(false);
    const { unmount } = render(header);
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    unmount();
    setViewport(true);
    render(header);
    expect(screen.getByRole("button", { name: "Record payment" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions" })).toBeInTheDocument();
  });
});

describe("FormModal footer actions", () => {
  it("submits the form from the footer button and blocks while busy", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <FormModal open onClose={() => {}} onSubmit={onSubmit} title="New refund" submitLabel="Create refund">
        <input aria-label="Amount" defaultValue="10" />
      </FormModal>
    );
    fireEvent.click(screen.getByRole("button", { name: /Create refund/ }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    rerender(
      <FormModal open busy onClose={() => {}} onSubmit={onSubmit} title="New refund" submitLabel="Create refund">
        <input aria-label="Amount" defaultValue="10" />
      </FormModal>
    );
    expect(screen.getByRole("button", { name: /Create refund/ })).toBeDisabled();
  });
});

describe("Stepper and Field", () => {
  const steps = [{ label: "Customer" }, { label: "Line items" }, { label: "Review" }];

  it("renders a compact Step X of Y on phones", () => {
    setViewport(true);
    render(<Stepper steps={steps} current={1} />);
    expect(screen.getByText("Step 2 of 3")).toBeInTheDocument();
    expect(screen.getByText("Line items")).toBeInTheDocument();
  });

  it("keeps the full stepper on desktop", () => {
    setViewport(false);
    render(<Stepper steps={steps} current={1} />);
    expect(screen.getByRole("list", { name: "Wizard progress" })).toBeInTheDocument();
  });

  it("shows a Coming soon tag next to the label", () => {
    render(
      <Field label="Default tax" htmlFor="tax" comingSoon>
        <select id="tax" disabled />
      </Field>
    );
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
    expect(screen.getByLabelText(/Default tax/)).toBeDisabled();
  });
});

describe("useUnsavedChangesGuard", () => {
  function Guarded({ dirty }) {
    useUnsavedChangesGuard(dirty);
    // The router would handle the navigation; stop jsdom from attempting it.
    // (The guard listens in the capture phase, so it still runs first.)
    return <a href="/billing/customers" onClick={(e) => e.preventDefault()}>Customers</a>;
  }
  let confirmSpy;
  beforeEach(() => {
    confirmSpy = vi.spyOn(window, "confirm");
  });
  afterEach(() => confirmSpy.mockRestore());

  it("asks before following an in-app link while dirty and cancels on No", () => {
    confirmSpy.mockReturnValue(false);
    render(<Guarded dirty />);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    screen.getByText("Customers").dispatchEvent(event);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does nothing while the form is clean", () => {
    render(<Guarded dirty={false} />);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    screen.getByText("Customers").dispatchEvent(event);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
